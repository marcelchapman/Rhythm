// Only disposable images/libraries. Uses the production manager and coordinator.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  statfs,
  open,
  unlink,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { Library } from "../dist/domain/library.js";
import { PlaybackUse } from "../dist/main/playback-use.js";
import { StableSourceManager } from "../dist/main/stable-source-manager.js";
import { editManagedFlac } from "../dist/domain/metadata-edit.js";
import { playbackFlacFixture } from "../tests/metadata-fixtures.ts";
assert.equal(process.platform, "darwin");
const root = await mkdtemp("/private/tmp/rio-stable-volume-"),
  mount = path.join(root, "mount"),
  image = path.join(root, "apfs.sparseimage"),
  source = path.join(root, "source.flac");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const bytes = playbackFlacFixture(),
  rows = [];
let attached = false,
  library,
  manager,
  use;
const emit = (r) => {
  rows.push(r);
  console.log("RIO_STABLE_VOLUME", JSON.stringify(r));
};
const attach = (filename, owners, readonly = false) => {
  execFileSync(
    "hdiutil",
    [
      "attach",
      filename,
      "-owners",
      owners,
      "-mountpoint",
      mount,
      "-nobrowse",
      ...(readonly ? ["-readonly"] : []),
    ],
    { stdio: "pipe" },
  );
  attached = true;
};
const detach = (force) => {
  execFileSync("hdiutil", ["detach", ...(force ? ["-force"] : []), mount], {
    stdio: "pipe",
  });
  attached = false;
};
try {
  await mkdir(mount);
  await writeFile(source, bytes);
  execFileSync(
    "hdiutil",
    [
      "create",
      "-size",
      "256m",
      "-fs",
      "APFS",
      "-volname",
      "RioSourceQualification",
      "-type",
      "SPARSE",
      "-o",
      image,
    ],
    { stdio: "pipe" },
  );
  for (const owners of ["on", "off"]) {
    attach(image, owners);
    library = await Library.open(path.join(root, "Library-" + owners), {
      setupMediaRoot: true,
    });
    await library
      .chooseMediaRoot(path.join(mount, "Rio Media"))
      .catch(async (error) => {
        if (error.code !== "ENOENT") throw error;
        await mkdir(path.join(mount, "Rio Media"));
        await library.chooseMediaRoot(path.join(mount, "Rio Media"));
      });
    library.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    const added = await library.add([source]);
    assert.equal(added.errors.length, 0);
    const track = library.tracks()[0];
    manager = new StableSourceManager({ enabled: true });
    use = new PlaybackUse(manager);
    use.bindLibrary(library);
    use.allowOwner(1);
    // A retained infrastructure snapshot is not a decoder grant. The original-use
    // service has no playback acquisition; real token-backed clones still block edits.
    const snapshot = await manager.acquire(library, track.id, () => {
      if (!library.db.isOpen) throw Error("Library closed");
    });
    let strategy;
    const saved = await editManagedFlac(
      library,
      track.id,
      { genre: { action: "set", value: "Disposable changed" } },
      {
        usage: use.usageFor(library),
        timing: (name, detail) => {
          if (name === "publication") strategy = detail.strategy;
        },
      },
    );
    const chunks = [];
    for await (const b of snapshot.stream(0, snapshot.metrics.size - 1))
      chunks.push(Buffer.from(b));
    assert.equal(hash(Buffer.concat(chunks)), hash(bytes));
    assert.equal(saved.status, "committed");
    assert.equal(strategy, owners === "on" ? "staged" : "in-place");
    await snapshot.release();
    emit({
      event: "publication-independence",
      owners,
      strategy,
      cloneUnchanged: true,
    });
    const grant = await use.acquireIsolated(1, track.id, library.directory);
    const lossProbe = await manager.acquire(library, track.id, () => {});
    detach(true);
    let lossCode;
    try {
      await lossProbe.size();
    } catch (e) {
      lossCode = e.code;
    }
    assert(["EIO", "ESTALE", "ENOENT"].includes(lossCode));
    await lossProbe.release();
    const unavailable = await use.respond(
      grant.token,
      track.id,
      new Request(grant.url),
    );
    assert.notEqual(unavailable.status, 200);
    await use.release(1, grant.token);
    assert.equal(manager.activeSources, 0);
    emit({
      event: "disconnected",
      owners,
      status: unavailable.status,
      code: lossCode,
      resourcesDrained: true,
    });
    attach(image, owners, true);
    let roError;
    try {
      await use.acquireIsolated(1, track.id, library.directory);
    } catch (e) {
      roError = { code: e.code, message: e.message };
    }
    assert(roError);
    assert.equal(manager.activeSources, 0);
    emit({ event: "readonly", owners, ...roError });
    detach(false);
    attach(image, owners);
    const available = await statfs(mount),
      filler = path.join(mount, "filler"),
      f = await open(filler, "wx"),
      chunk = Buffer.alloc(1024 * 1024, 0x5a);
    try {
      let remaining = Math.floor(
        (available.bavail * available.bsize - 4 * 1024 * 1024) / chunk.length,
      );
      while (remaining-- > 0) await f.write(chunk);
      await f.sync();
    } catch (e) {
      assert.equal(e.code, "ENOSPC");
    } finally {
      await f.close();
    }
    let fullError;
    try {
      await use.acquireIsolated(1, track.id, library.directory);
    } catch (e) {
      fullError = e.code;
    }
    assert.equal(fullError, "ENOSPC");
    assert.equal(manager.activeSources, 0);
    await unlink(filler);
    emit({
      event: "insufficient-space",
      owners,
      code: fullError,
      noScratch: (await readdir(library.mediaSettings().root.path)).every(
        (n) => !n.startsWith(".rio-playback-"),
      ),
    });
    // Direct native boundary test: a relative parent crosses into this image.
    const native = createRequire(import.meta.url)(
        path.resolve("dist/native/playback-source.node"),
      ),
      s = await stat(root);
    let cross;
    try {
      native.capture({
        root,
        rootDevice: String(s.dev),
        rootInode: String(s.ino),
        relative: "mount/Rio Media/source.flac",
        device: String((await stat(track.path)).dev),
        inode: String((await stat(track.path)).ino),
        workspace: ".rio-playback-00000000-0000-0000-0000-000000000000",
      });
    } catch (e) {
      cross = e.code;
    }
    assert.equal(cross, "EXDEV");
    emit({ event: "cross-volume-boundary", owners, code: cross });
    await use.shutdown();
    await manager.shutdown();
    library.close();
    library = undefined;
    use = undefined;
    manager = undefined;
    await rm(path.join(mount, "Rio Media"), { recursive: true });
    detach(false);
  }
  const hfs = path.join(root, "unsupported.sparseimage");
  execFileSync(
    "hdiutil",
    [
      "create",
      "-size",
      "64m",
      "-fs",
      "HFS+",
      "-volname",
      "RioUnsupported",
      "-type",
      "SPARSE",
      "-o",
      hfs,
    ],
    { stdio: "pipe" },
  );
  attach(hfs, "on");
  library = await Library.open(path.join(root, "Library-unsupported"), {
    setupMediaRoot: true,
  });
  await mkdir(path.join(mount, "Rio Media"));
  await library.chooseMediaRoot(path.join(mount, "Rio Media"));
  library.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
  await library.add([source]);
  manager = new StableSourceManager({ enabled: true });
  let unsupported;
  try {
    await manager.acquire(library, library.tracks()[0].id, () => {});
  } catch (e) {
    unsupported = e.code;
  }
  assert.equal(unsupported, "ENOTSUP");
  emit({ event: "unsupported-HFS", code: unsupported });
  await manager.shutdown();
  manager = undefined;
  library.close();
  library = undefined;
  detach(false);
  assert.equal(hash(await readFile(source)), hash(bytes));
  const output = process.argv.indexOf("--output");
  if (output >= 0)
    await writeFile(
      process.argv[output + 1],
      JSON.stringify({ rows }, null, 2) + "\n",
    );
  console.log("Stable source volume qualification passed.");
} finally {
  await use?.shutdown();
  await manager?.shutdown();
  if (library?.db.isOpen) library.close();
  if (attached) detach(true);
  await rm(root, { recursive: true, force: true });
}
