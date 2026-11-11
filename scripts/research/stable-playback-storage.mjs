// Disposable APFS-container accounting and lifecycle tests. Never mounts or
// changes options on an existing volume. No Rio production code is imported.
import { buildCloneHelper } from "./stable-source-clone.mjs";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  open,
  stat,
  statfs,
  unlink,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { inspectFlac } from "../../tests/metadata-fixtures.ts";
const source = process.argv[2];
if (!source) throw Error("Pass the path to a disposable FLAC fixture.");
const original = await readFile(source),
  digest = (b) => createHash("sha256").update(b).digest("hex");
const scratch = await mkdtemp("/private/tmp/rio-2e3-storage-");
const mount = path.join(scratch, "mount"),
  image = path.join(scratch, "disk.sparseimage");
const beforeSource = digest(original),
  rows = [];
let attached = false;
const emit = (r) => {
  rows.push(r);
  console.log("RIO_STABLE_STORAGE", JSON.stringify(r));
};
const sync = async (file) => {
  const f = await open(file, "r+");
  try {
    await f.sync();
  } finally {
    await f.close();
  }
};
async function space() {
  // APFS free-block accounting is delayed: retain the observed range.
  const samples = [];
  for (let i = 0; i < 12; i++) {
    const s = await statfs(mount);
    samples.push(s.bfree * s.bsize);
    if (i >= 4 && samples.slice(-4).every((v) => v === samples.at(-1))) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    freeBytes: samples.at(-1),
    min: Math.min(...samples),
    max: Math.max(...samples),
  };
}
try {
  const native = await buildCloneHelper(scratch);
  const clone = async (src, dst) =>
    JSON.parse(
      execFileSync(native, [src, path.dirname(dst), path.basename(dst)], {
        encoding: "utf8",
      }),
    );
  await mkdir(mount);
  execFileSync(
    "hdiutil",
    [
      "create",
      "-size",
      "768m",
      "-fs",
      "APFS",
      "-volname",
      "RioStableStudy",
      "-type",
      "SPARSE",
      "-o",
      image,
    ],
    { stdio: "pipe" },
  );
  for (const owners of ["on", "off"]) {
    execFileSync(
      "hdiutil",
      ["attach", image, "-owners", owners, "-mountpoint", mount, "-nobrowse"],
      { stdio: "pipe" },
    );
    attached = true;
    const mountInfo = JSON.parse(
      execFileSync(native, ["space", mount], { encoding: "utf8" }),
    );
    assert.equal(mountInfo.noowners, owners === "off");
    const root = path.join(mount, "Disposable"),
      cache = path.join(root, "Cache");
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const file = path.join(root, "original.flac");
    await writeFile(file, original);
    await sync(file);
    const initial = await space();
    let crossVolumeRejected = false;
    try {
      await clone(file, path.join(scratch, "cross-volume.flac"));
    } catch (e) {
      crossVolumeRejected = /Cross-device link/.test(String(e.stderr));
    }
    assert(crossVolumeRejected);
    emit({ event: "cross-volume", owners, rejected: true });
    const clones = [];
    for (let i = 0; i < 4; i++) {
      const filename = path.join(cache, `clone-${i}.flac`),
        t = performance.now();
      await clone(file, filename);
      const s = await stat(filename);
      assert.notEqual(s.ino, (await stat(file)).ino);
      clones.push({
        filename,
        inode: s.ino,
        dev: s.dev,
        ms: performance.now() - t,
        blocks512: s.blocks,
      });
    }
    const afterClone = await space();
    assert(
      afterClone.freeBytes > initial.freeBytes - original.length,
      "Clone batch unexpectedly consumed a full image per clone",
    );
    // Exactly the full-file rewrite pattern of the current pragmatic publisher,
    // using valid, same-sized FLAC comment bytes; no publication claim is made here.
    const candidate = Buffer.from(original),
      parsed = inspectFlac(original);
    let p = 4;
    for (const b of parsed.blocks) {
      if (b.type === 4) {
        const vendorLength = candidate.readUInt32LE(p + 4);
        assert(vendorLength > 0);
        candidate[p + 8] = candidate[p + 8] === 65 ? 66 : 65;
        break;
      }
      p += 4 + b.body.length;
    }
    assert.notEqual(digest(candidate), beforeSource);
    for (let repeat = 0; repeat < 3; repeat++) {
      const f = await open(file, "r+");
      try {
        await f.writeFile(repeat % 2 ? original : candidate);
        await f.sync();
      } finally {
        await f.close();
      }
      const s = await space();
      for (const c of clones)
        assert.equal(digest(await readFile(c.filename)), beforeSource);
      emit({
        event: "full-rewrite",
        owners,
        repeat,
        bytes: original.length,
        free: s,
        additionalBytes: initial.freeBytes - s.freeBytes,
      });
    }
    const final = await space();
    emit({
      event: "allocation",
      owners,
      bytes: original.length,
      clones: clones.map(({ filename, ...rest }) => rest),
      initial,
      afterClone,
      afterRewrite: final,
      cloneBatchAdditionalBytes: initial.freeBytes - afterClone.freeBytes,
      fullRewriteAdditionalBytes: afterClone.freeBytes - final.freeBytes,
      logicalCloneBytes: 4 * original.length,
      note: "st_blocks includes shared extents; unique allocation is container free-block delta, including filesystem metadata",
    });
    // Retained object survives a benign cache-path replacement. Never authorize
    // the replacement; clean up only leaf identities created in this test.
    const retained = await open(clones[0].filename, "r");
    await unlink(clones[0].filename);
    await writeFile(clones[0].filename, Buffer.from("Replacement"));
    assert.equal(digest(await retained.readFile()), beforeSource);
    await retained.close();
    // Process death leaves a bounded orphan, reclaimed using a main-owned manifest.
    const orphan = path.join(cache, "orphan.flac"),
      manifest = path.join(root, "manifest.json");
    await clone(file, orphan);
    const identity = await stat(orphan);
    await writeFile(
      manifest,
      JSON.stringify({
        name: "orphan.flac",
        dev: identity.dev,
        ino: identity.ino,
      }),
    );
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('fs');fs.openSync(process.argv[1],'r');process.stdout.write('READY\\n');setInterval(()=>{},1000)",
        orphan,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolve, reject) => {
      child.stdout.once("data", resolve);
      child.once("error", reject);
    });
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    const record = JSON.parse(await readFile(manifest, "utf8")),
      current = await stat(path.join(cache, record.name));
    assert.equal(current.dev, record.dev);
    assert.equal(current.ino, record.ino);
    const t = performance.now();
    await unlink(orphan);
    emit({
      event: "crash-scavenge",
      owners,
      orphanRetainedAfterKill: true,
      ownedManifestValidated: true,
      cleanupMs: performance.now() - t,
    });
    // An anonymous clone has no pathname to scavenge. Actual process death
    // closes its only descriptor and lets APFS reclaim its old revision.
    const anonymous = path.join(cache, "anonymous.flac");
    await clone(file, anonymous);
    const holder = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('fs');const fd=fs.openSync(process.argv[1],'r');fs.unlinkSync(process.argv[1]);process.stdout.write(String(fs.fstatSync(fd).nlink)+'\\n');setInterval(()=>{},1000)",
        anonymous,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise((resolve, reject) => {
      holder.stdout.once("data", (b) => {
        if (b.toString().trim() === "0") resolve();
        else reject(Error("Clone not anonymous"));
      });
      holder.once("error", reject);
    });
    const changed = await open(file, "r+");
    try {
      await changed.writeFile(original);
      await changed.sync();
    } finally {
      await changed.close();
    }
    const retainedSpace = await space(),
      killedAt = performance.now();
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("exit", r));
    const exitMs = performance.now() - killedAt;
    const releasedSpace = await space();
    assert(!(await readdir(cache)).includes("anonymous.flac"));
    emit({
      event: "anonymous-process-death",
      owners,
      exitMs,
      retainedSpace,
      releasedSpace,
      reclaimedBytes: releasedSpace.freeBytes - retainedSpace.freeBytes,
      noPathToScavenge: true,
    });
    // Real ENOSPC in a bounded disposable container. This probes the physical
    // full-write primitive, NOT Rio coordinator error handling or power failure.
    const safetyClone = path.join(cache, "space-snapshot.flac");
    await clone(file, safetyClone);
    const safetyDigest = digest(await readFile(safetyClone));
    const filler = path.join(root, "filler.bin"),
      available = await space(),
      fill = await open(filler, "wx"),
      chunk = Buffer.alloc(1024 * 1024, 0x5a);
    try {
      let n = Math.max(
        0,
        Math.floor((available.freeBytes - 8 * 1024 * 1024) / chunk.length),
      );
      while (n-- > 0) await fill.write(chunk);
      await fill.sync();
    } catch (e) {
      if (e.code !== "ENOSPC") throw e;
    } finally {
      await fill.close();
    }
    const limited = await open(file, "r+");
    let fullWriteError;
    try {
      await limited.writeFile(candidate);
      await limited.sync();
    } catch (e) {
      fullWriteError = e.code;
    } finally {
      await limited.close();
    }
    assert.equal(fullWriteError, "ENOSPC");
    assert.equal(digest(await readFile(safetyClone)), safetyDigest);
    emit({
      event: "space-exhaustion",
      owners,
      fullWriteError,
      cloneUnchanged: true,
      scope: "physical full-file write; not coordinator fault injection",
    });
    await unlink(filler);
    await unlink(safetyClone);
    await writeFile(file, original);
    await sync(file);
    // Force-detach ONLY this disposable image, with a retained descriptor.
    // This does not model an electrical cable pull; record actual API behavior.
    const fd = await open(file, "r");
    execFileSync("hdiutil", ["detach", "-force", mount], { stdio: "pipe" });
    attached = false;
    let readResult;
    try {
      const b = Buffer.alloc(4096);
      const result = await fd.read(
        b,
        0,
        b.length,
        Math.min(original.length - 4096, 16 * 1024 * 1024),
      );
      readResult = { bytesRead: result.bytesRead };
    } catch (e) {
      readResult = { error: e.code };
    }
    await fd.close();
    emit({ event: "disposable-detach", owners, readResult });
    execFileSync(
      "hdiutil",
      ["attach", image, "-owners", owners, "-mountpoint", mount, "-nobrowse"],
      { stdio: "pipe" },
    );
    attached = true;
    const cleanedAt = performance.now();
    await rm(root, { recursive: true });
    emit({
      event: "owned-tree-cleanup",
      owners,
      cleanupMs: performance.now() - cleanedAt,
      remaining: await readdir(mount),
    });
    execFileSync("hdiutil", ["detach", mount], { stdio: "pipe" });
    attached = false;
  }
  assert.equal(digest(await readFile(source)), beforeSource);
  await writeFile(
    "/private/tmp/rio-2e3-storage-results.json",
    JSON.stringify({ date: new Date().toISOString(), rows }, null, 2) + "\n",
  );
} finally {
  if (attached)
    execFileSync("hdiutil", ["detach", "-force", mount], { stdio: "pipe" });
  await rm(scratch, { recursive: true, force: true });
}
