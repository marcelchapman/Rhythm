// Phase 2C.3 research model only. No Rio Library/coordinator integration.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const [mode, configPath] = process.argv.slice(2);
assert(configPath?.startsWith("/private/tmp/rio-apfs-design-"));
const c = JSON.parse(fs.readFileSync(configPath, "utf8"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stat = (fd) => {
  const s = fs.fstatSync(fd, { bigint: true });
  return {
    device: String(s.dev),
    inode: String(s.ino),
    size: String(s.size),
    links: String(s.nlink),
    mtime: String(s.mtimeNs),
    ctime: String(s.ctimeNs),
    file: s.isFile(),
    directory: s.isDirectory(),
  };
};
const object = (a, b) => a.device === b.device && a.inode === b.inode;
const native = createRequire(import.meta.url)(c.binding);
const handles = [];
const directory = native.directory(c.media);
handles.push(directory);
const controlDirectory = native.directory(c.control);
handles.push(controlDirectory);
const db = new DatabaseSync(path.join(c.control, "journal.sqlite"));
db.exec(
  "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA fullfsync=ON",
);
db.exec(
  "CREATE TABLE IF NOT EXISTS state (id INTEGER PRIMARY KEY CHECK(id=1), ref TEXT NOT NULL); CREATE TABLE IF NOT EXISTS edits (token TEXT PRIMARY KEY, phase TEXT NOT NULL, evidence TEXT NOT NULL)",
);
const durable = () => {
  const f = fs.openSync(
    path.join(c.control, "journal.sqlite"),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    native.flush(f);
  } finally {
    fs.closeSync(f);
  }
  native.flush(controlDirectory);
};
const current = () =>
  JSON.parse(db.prepare("SELECT ref FROM state WHERE id=1").get().ref);
let evidence;
const ledger = [];
const put = (phase) => {
  db.prepare("UPDATE edits SET phase=?,evidence=? WHERE token=?").run(
    phase,
    JSON.stringify(evidence),
    evidence.token,
  );
  durable();
};
function open(name) {
  const fd = native.read(directory, name);
  handles.push(fd);
  return fd;
}
function read(fd) {
  const before = stat(fd);
  assert(
    before.file &&
      before.links === "1" &&
      Number(before.size) <= 64 * 1024 * 1024,
  );
  const b = Buffer.alloc(Number(before.size));
  let at = 0;
  while (at < b.length) {
    const n = fs.readSync(fd, b, at, b.length - at, at);
    assert(n > 0);
    at += n;
  }
  assert.deepEqual(stat(fd), before);
  return b;
}
function checkRoot() {
  const fd = native.directory(c.media);
  try {
    assert(object(stat(fd), c.rootIdentity));
  } finally {
    native.close(fd);
  }
  assert(object(stat(directory), c.rootIdentity));
}
function checkRef(ref) {
  checkRoot();
  const f = open(ref.name);
  const s = stat(f);
  assert(object(s, ref.identity) && s.links === "1" && s.file);
  assert.deepEqual(s, ref.identity);
  assert.equal(sha(read(f)), ref.sha256);
  return f;
}
function phase(name) {
  ledger.push({ phase: name });
  if (c.changeAt === name) {
    const eventName =
      c.changeTarget === "candidate" ? evidence.candidateName : "Track.flac";
    const r = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./apfs-ordinary-change.mjs", import.meta.url)),
        configPath,
        eventName,
      ],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 0, r.stderr);
    ledger.push({ ordinaryProcess: JSON.parse(r.stdout) });
  }
  if (c.crashAt === name) process.kill(process.pid, "SIGKILL");
}
let result;
try {
  if (mode === "recover") {
    const row = db.prepare("SELECT * FROM edits LIMIT 1").get();
    if (!row) {
      checkRef(current());
      result = { status: "original", ref: current() };
    } else {
      evidence = JSON.parse(row.evidence);
      const active = current();
      checkRef(active);
      if (active.token === evidence.token) {
        // A pending cutover additionally rechecks the old source. Terminal refs do
        // not require superseded files to remain available forever.
        if (!["RECONCILED_RETAINED"].includes(row.phase))
          checkRef(evidence.source);
        put("RECONCILED_RETAINED");
        result = { status: "new-generation", ref: active };
      } else {
        assert.equal(active.token, evidence.source.token);
        put("ABORTED_RETAINED");
        ledger.push({ operation: "recovery-retain-only" });
        result = { status: "original", ref: active };
      }
    }
  } else {
    assert.equal(mode, "publish");
    if (!db.prepare("SELECT ref FROM state WHERE id=1").get()) {
      db.prepare("INSERT INTO state VALUES(1,?)").run(
        JSON.stringify(c.originalRef),
      );
      durable();
    }
    // This demonstrator deliberately qualifies one attempt per control DB only.
    assert.equal(
      Number(db.prepare("SELECT count(*) AS n FROM edits").get().n),
      0,
      "single-attempt retention budget exhausted",
    );
    const source = current();
    const sf = checkRef(source),
      original = read(sf);
    const { prepareFlacMetadataEdit, verifyFlacMetadataCandidate } =
      await import(
        pathToFileURL(path.resolve("dist/domain/metadata-writer.js"))
      );
    const patch = {
      title: { action: "set", value: "Versioned publication research" },
      year: { action: "set", value: 2001 },
      comments: { action: "clear" },
    };
    const prepared = await prepareFlacMetadataEdit(original, patch);
    assert(
      prepared.candidate.byteLength <= 64 * 1024 * 1024,
      "candidate exceeds reserved byte bound",
    );
    const token = randomUUID();
    evidence = {
      token,
      source,
      candidateName: `.rio-version-${token}.flac`,
      candidateSha256: sha(prepared.candidate),
      audioSha256: prepared.verification.audioSha256,
    };
    // Intent is durable first. Name collision is refusal, never overwrite/reuse.
    db.prepare("INSERT INTO edits VALUES(?,?,?)").run(
      token,
      "INTENT",
      JSON.stringify(evidence),
    );
    durable();
    phase("after-intent");
    const cf = native.create(directory, evidence.candidateName);
    handles.push(cf);
    ledger.push({
      operation: "create-exclusive",
      name: evidence.candidateName,
    });
    evidence.candidateIdentity = stat(cf);
    put("CREATED");
    phase("after-create");
    const bytes = Buffer.from(prepared.candidate),
      half = Math.floor(bytes.length / 2);
    // These are writes only through the descriptor returned by exclusive create.
    fs.writeSync(cf, bytes, 0, half, 0);
    ledger.push({ operation: "write-created-fd", bytes: half });
    phase("during-write");
    fs.writeSync(cf, bytes, half, bytes.length - half, half);
    ledger.push({ operation: "write-created-fd", bytes: bytes.length - half });
    native.flush(cf);
    native.flush(directory);
    const proof = await verifyFlacMetadataCandidate(original, read(cf), patch);
    assert.equal(proof.candidateSha256, evidence.candidateSha256);
    assert.equal(proof.audioSha256, evidence.audioSha256);
    evidence.candidateIdentity = stat(cf);
    put("VERIFIED");
    phase("after-verify");
    const ref = {
      token,
      trackId: source.trackId,
      name: evidence.candidateName,
      identity: stat(cf),
      sha256: evidence.candidateSha256,
    };
    checkRef(source);
    checkRef(ref);
    phase("after-revalidate");
    // Publication is a DB reference transaction. No media namespace mutation.
    db.exec("BEGIN IMMEDIATE");
    try {
      assert.deepEqual(current(), source);
      db.prepare("UPDATE state SET ref=? WHERE id=1").run(JSON.stringify(ref));
      db.prepare(
        "UPDATE edits SET phase='COMMITTED',evidence=? WHERE token=?",
      ).run(JSON.stringify(evidence), token);
      phase("during-pointer-transaction");
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    durable();
    ledger.push({ operation: "publish-db-reference" });
    phase("after-commit");
    phase("before-reconcile");
    checkRef(source);
    checkRef(ref);
    put("RECONCILED_RETAINED");
    phase("after-reconcile");
    // Cleanup deliberately has no media unlink/rename/replace operation.
    ledger.push({ operation: "retain-superseded-and-orphan-evidence" });
    phase("retention-recorded");
    result = {
      status: "new-generation",
      ref,
      verification: prepared.verification,
    };
  }
} catch (e) {
  if (evidence) {
    try {
      put("UNRESOLVED_RETAINED");
    } catch {}
  }
  result = { status: "fail-closed", reason: String(e) };
} finally {
  db.close();
  for (const fd of handles.reverse()) native.close(fd);
}
console.log(JSON.stringify({ mode, result, ledger }));
