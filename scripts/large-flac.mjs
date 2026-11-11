// Opt-in large-file qualification. Inputs must be disposable, never a user library.
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  stat,
  lstat,
  rm,
  open,
  readdir,
  statfs,
  copyFile,
  writeFile,
} from "node:fs/promises";
import { createReadStream, constants } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Library } from "../dist/domain/library.js";
import {
  editManagedFlac,
  recoverMetadataEdits,
  MetadataEditInterruption,
} from "../dist/domain/metadata-edit.js";
import { PlaybackUse } from "../dist/main/playback-use.js";
import { StableSourceManager } from "../dist/main/stable-source-manager.js";
import { MAX_FLAC_FILE_BYTES } from "../src/shared/flac-limits.ts";
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i < 0 ? undefined : process.argv[i + 1];
};
const source = await realpath(arg("--fixture"));
assert(
  source.startsWith("/private/tmp/rio-"),
  "Only known disposable fixtures are accepted",
);
const input = await stat(source),
  parent = await realpath(arg("--external-parent") || "/private/tmp");
const root = await mkdtemp(path.join(parent, ".rio-large-flac-")),
  identity = await lstat(root);
const flag = !process.argv.includes("--disabled");
// Coarse whole-volume counters: other activity and filesystem bookkeeping can contribute.
const free = async () => {
  const s = await statfs(root);
  return s.bavail * s.bsize;
};
const space = {};
const digest = async (filename, start = 0) => {
  const hash = createHash("sha256");
  for await (const part of createReadStream(filename, { start }))
    hash.update(part);
  return hash.digest("hex");
};
const audioDigest = async (filename) => {
  const f = await open(filename, "r");
  let at = 4;
  try {
    for (;;) {
      const h = Buffer.alloc(4);
      assert.equal((await f.read(h, 0, 4, at)).bytesRead, 4);
      at += 4 + h.readUIntBE(1, 3);
      if (h[0] & 128) break;
    }
  } finally {
    await f.close();
  }
  return digest(filename, at);
};
const original = await digest(source),
  rows = [],
  manager = new StableSourceManager({ enabled: flag }),
  use = new PlaybackUse(manager, flag);
let library, grant, timer;
try {
  library = await Library.open(path.join(root, "Library"), {
    setupMediaRoot: true,
  });
  library.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
  const added = await library.add([source]);
  assert.equal(added.errors.length, 0, JSON.stringify(added.errors));
  const track = library.tracks()[0],
    beforeAudio = await audioDigest(track.path);
  assert.equal(await digest(track.path), original);
  use.bindLibrary(library);
  use.allowOwner(1);
  space.beforeAcquire = await free();
  const started = performance.now();
  grant = await use.acquireForPlayback(1, track.id, library.directory);
  const acquisitionMs = performance.now() - started;
  space.afterAcquire = await free();
  const stable = use.canServeIsolated(grant.token, track.id);
  console.log(
    JSON.stringify({
      event: "acquired",
      bytes: input.size,
      acquisitionMs,
      stable,
    }),
  );
  if (input.size > MAX_FLAC_FILE_BYTES) {
    assert.equal(stable, false);
    const { metadataEligibility } =
      await import("../dist/main/metadata-editor.js");
    await use.release(1, grant.token);
    grant = undefined;
    await assert.rejects(
      metadataEligibility(library, track.id, use.usageFor(library)),
      /128 MiB/,
    );
    rows.push({ oversizeRejected: true, bytes: input.size });
  } else {
    assert.equal(stable, flag);
    if (!flag) {
      await assert.rejects(
        editManagedFlac(
          library,
          track.id,
          { genre: { action: "set", value: "Blocked" } },
          { usage: use.usageFor(library) },
        ),
        /in use/,
      );
      await use.release(1, grant.token);
      grant = undefined;
    }
    const beforeClone = grant
      ? Buffer.from(
          await (
            await use.respond(
              grant.token,
              track.id,
              new Request(grant.url, { headers: { Range: "bytes=0-4095" } }),
            )
          ).arrayBuffer(),
        )
      : null;
    for (
      let run = 0;
      run < (process.argv.includes("--repeat") ? 2 : 1);
      run++
    ) {
      const stages = {},
        details = {};
      let last = performance.now(),
        maxGapMs = 0,
        peakRss = process.memoryUsage().rss;
      timer = setInterval(() => {
        const now = performance.now();
        maxGapMs = Math.max(maxGapMs, now - last);
        last = now;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }, 10);
      const beforeIdentity = await lstat(track.path);
      const startCpu = process.cpuUsage();
      const start = performance.now();
      const result = await editManagedFlac(
        library,
        track.id,
        { genre: { action: "set", value: `Large qualification ${run}` } },
        {
          usage: use.usageFor(library),
          timing: (stage, detail) => {
            if (detail) (details[stage] ??= []).push(detail);
            else stages[stage] = performance.now() - start;
          },
        },
      );
      const saveMs = performance.now() - start;
      const cpu = process.cpuUsage(startCpu);
      const processCpuMs = (cpu.user + cpu.system) / 1000;
      console.log(JSON.stringify({ event: "saved", run, saveMs }));
      maxGapMs = Math.max(maxGapMs, performance.now() - last);
      clearInterval(timer);
      timer = undefined;
      peakRss = Math.max(
        peakRss,
        process.memoryUsage().rss,
        process.resourceUsage().maxRSS * 1024,
      );
      assert(result);
      assert.equal(
        library.tracks(track.id)[0].genre,
        `Large qualification ${run}`,
      );
      assert.equal(await audioDigest(track.path), beforeAudio);
      const afterIdentity = await lstat(track.path);
      const receipt = library.db
        .prepare(
          "SELECT device,inode,digest FROM managed_file_receipts WHERE trackId=?",
        )
        .get(track.id);
      assert.equal(receipt.device, String(afterIdentity.dev));
      assert.equal(receipt.inode, String(afterIdentity.ino));
      assert.equal(receipt.digest, await digest(track.path));
      assert.equal(library.tracks(track.id)[0].path, track.path);
      const inodeChanged = beforeIdentity.ino !== afterIdentity.ino;
      assert.equal(inodeChanged, details.publication[0].strategy === "staged");
      assert.equal(
        library.db
          .prepare(
            "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
          )
          .get().n,
        0,
      );
      if (grant) {
        const head = Buffer.from(
          await (
            await use.respond(
              grant.token,
              track.id,
              new Request(grant.url, { headers: { Range: "bytes=0-4095" } }),
            )
          ).arrayBuffer(),
        );
        assert.deepEqual(head, beforeClone);
      }
      rows.push({
        run,
        saveMs,
        processCpuMs,
        inodeChanged,
        receiptVerified: true,
        targetAllocatedBytes: afterIdentity.blocks * 512,
        volumeAvailableBytes: await free(),
        maxGapMs,
        peakRss,
        stages,
        details,
        identityPreserved: library.tracks(track.id)[0].id === track.id,
        audioPreserved: true,
      });
    }
    if (process.argv.includes("--recover")) {
      const patch = { genre: { action: "set", value: "Recovered large edit" } };
      await assert.rejects(
        editManagedFlac(library, track.id, patch, {
          usage: use.usageFor(library),
          hooks: {
            at: async (phase) => {
              if (phase === "published")
                throw new MetadataEditInterruption(
                  "Disposable interruption after publication",
                );
            },
          },
        }),
        MetadataEditInterruption,
      );
      if (grant) {
        await use.release(1, grant.token);
        grant = undefined;
      }
      await recoverMetadataEdits(library);
      assert.equal(library.tracks(track.id)[0].genre, "Recovered large edit");
      assert.equal(await audioDigest(track.path), beforeAudio);
      assert.equal(
        library.db
          .prepare(
            "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
          )
          .get().n,
        0,
      );
      rows.push({ forwardRecovery: true, audioPreserved: true });
    }
    if (grant) {
      await use.release(1, grant.token);
      grant = undefined;
    }
    assert.equal(manager.activeSources, 0);
    space.afterRelease = await free();
    const nextAt = performance.now(),
      next = await use.acquireForPlayback(1, track.id, library.directory);
    const reacquisitionMs = performance.now() - nextAt;
    const releaseAt = performance.now();
    await use.release(1, next.token);
    rows.push({ reacquisitionMs, releaseMs: performance.now() - releaseAt });
    assert.equal(manager.activeSources, 0);
    assert(
      !(await readdir(library.mediaSettings().root.path)).some((n) =>
        n.startsWith(".rio-playback-"),
      ),
    );
    if (arg("--verify-output")) {
      const output = path.resolve(arg("--verify-output"));
      assert(
        (await realpath(path.dirname(output))).startsWith("/private/tmp/rio-"),
      );
      await copyFile(track.path, output, constants.COPYFILE_EXCL);
    }
  }
  assert.equal(await digest(source), original);
  const output = {
    bytes: input.size,
    flag,
    storage: arg("--external-parent")
      ? "external APFS noowners"
      : "ownership-enabled local APFS",
    acquisitionMs,
    stable,
    volumeAvailableBytes: space,
    peakRss: process.resourceUsage().maxRSS * 1024,
    rows,
    sourceUnchanged: true,
  };
  console.log(JSON.stringify(output));
  if (arg("--output"))
    await writeFile(arg("--output"), JSON.stringify(output, null, 2) + "\n", {
      flag: "wx",
    });
} finally {
  clearInterval(timer);
  await use.shutdown();
  await manager.shutdown();
  if (library?.db.isOpen) library.close();
  const now = await lstat(root);
  assert.equal(now.dev, identity.dev);
  assert.equal(now.ino, identity.ino);
  await rm(root, { recursive: true });
}
