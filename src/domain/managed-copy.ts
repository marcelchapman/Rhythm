import { constants, type Stats } from "node:fs";
import {
  open,
  lstat,
  mkdir,
  link,
  unlink,
  realpath,
  readdir,
  rmdir,
} from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  inside,
  mediaDestination,
  type OrganizationMetadata,
} from "./media-plan.js";

export interface MediaRoot {
  id: string;
  path: string;
  device: string;
  inode: string;
}
interface Job {
  id: string;
  source: string;
  digest: string;
  rootId: string;
  relative: string;
  stage: string;
  stageDevice: string | null;
  stageInode: string | null;
  status: string;
  trackId: string;
}
export interface ManagedLocation {
  path: string;
  rootId: string;
  relative: string;
  trackId: string;
  jobId: string;
}
/** Reads only. Refuses changes during hashing rather than indexing inconsistent bytes. */
export async function fileDigest(filename: string): Promise<string> {
  const f = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await f.stat();
    if (!before.isFile()) throw new Error("Not a regular audio file.");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await f.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await f.stat();
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      position !== before.size
    )
      throw new Error("File changed while reading; try importing again.");
    return hash.digest("hex");
  } finally {
    await f.close();
  }
}
export async function validateMediaRoot(root: MediaRoot) {
  const info = await lstat(root.path);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    String(info.dev) !== root.device ||
    String(info.ino) !== root.inode
  )
    throw new Error(
      "Rio Media folder changed or is unavailable. Choose it again in Library settings.",
    );
}
async function syncDirectory(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
/** Walk each component. Never traverse symlink parents or recreate an unavailable media root. */
async function directories(root: MediaRoot, relative: string, create: boolean) {
  await validateMediaRoot(root);
  const destination = path.resolve(root.path, relative);
  if (
    !inside(root.path, destination) ||
    relative.includes("\\") ||
    relative.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Unsafe managed destination.");
  let parent = root.path;
  for (const segment of relative.split("/").slice(0, -1)) {
    parent = path.join(parent, segment);
    let created = false;
    if (create) {
      try {
        await mkdir(parent);
        created = true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
    }
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Rio Media contains a symbolic link or unsafe folder.");
    if (created) await syncDirectory(path.dirname(parent));
  }
  return destination;
}
/** Revalidate an explicitly located existing managed file without adopting external content. */
export async function validateManagedLocation(
  root: MediaRoot,
  relative: string,
) {
  const target = await directories(root, relative, false);
  const canonical = await realpath(target);
  if (!inside(root.path, canonical) || canonical !== target)
    throw new Error(
      "Managed file location changed. Choose its recovery source again.",
    );
  await fileDigest(canonical);
  return canonical;
}
/** Destructive authority requires a published copy receipt, not merely an indexed path. */
export async function validateManagedTrash(
  db: DatabaseSync,
  root: MediaRoot,
  trackId: string,
  filename: string,
  relative: string,
) {
  const target = await validateManagedLocation(root, relative);
  const info = await lstat(target);
  const receipt = db
    .prepare(
      "SELECT digest,stageDevice,stageInode FROM managed_imports WHERE trackId=? AND rootId=? AND relative=? AND status='done'",
    )
    .all(trackId, root.id, relative)
    .find(
      (r) =>
        r.stageDevice === String(info.dev) && r.stageInode === String(info.ino),
    );
  if (
    filename !== target ||
    !info.isFile() ||
    info.isSymbolicLink() ||
    !receipt ||
    receipt.digest !== (await fileDigest(target))
  )
    throw new Error(
      "This file no longer matches Rio's managed copy receipt. It has not been moved to Trash.",
    );
  // Recheck the root, parents and leaf after hashing, immediately before handoff.
  await directories(root, relative, false);
  const latest = await lstat(target);
  if (
    (await realpath(target)) !== target ||
    latest.dev !== info.dev ||
    latest.ino !== info.ino ||
    latest.size !== info.size ||
    latest.mtimeMs !== info.mtimeMs ||
    latest.ctimeMs !== info.ctimeMs ||
    latest.isSymbolicLink()
  )
    throw new Error(
      "The managed file location changed. It has not been moved to Trash.",
    );
  return target;
}
export interface ManagedAlbumDirectory {
  root: MediaRoot;
  relative: string;
  parents: { relative: string; device: string; inode: string }[];
}
// Every actual managed ancestor may be cleaned, but the root is never a candidate.
function managedDirectory(relative: string) {
  const parts = relative.split("/");
  return (
    !path.isAbsolute(relative) &&
    parts.every(
      (part) => part && part !== "." && part !== ".." && !part.includes("\\"),
    )
  );
}
/** Snapshot real managed parents before Trash; never authority over unknown content. */
export async function planManagedAlbumCleanup(
  root: MediaRoot,
  filename: string,
  relative: string,
): Promise<ManagedAlbumDirectory[]> {
  if ((await directories(root, relative, false)) !== filename)
    throw new Error("Unsafe managed album folder location.");
  const parent = relative.split("/").slice(0, -1).join("/");
  if (!managedDirectory(parent)) return [];
  const parents: ManagedAlbumDirectory["parents"] = [];
  const parts = parent.split("/");
  for (let n = 1; n <= parts.length; n++) {
    const relative = parts.slice(0, n).join("/");
    const directory = path.resolve(root.path, relative);
    const info = await lstat(directory);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (await realpath(directory)) !== directory
    )
      throw new Error(
        "The managed album folder changed. It will be left in place.",
      );
    parents.push({
      relative,
      device: String(info.dev),
      inode: String(info.ino),
    });
  }
  return [...parents].reverse().map(({ relative }) => ({
    root: { ...root },
    relative,
    parents: parents.slice(0, relative.split("/").length),
  }));
}
function sameCleanupFile(a: Stats, b: Stats) {
  return (
    b.isFile() &&
    !b.isSymbolicLink() &&
    b.nlink === 1 &&
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeMs === b.mtimeMs &&
    a.ctimeMs === b.ctimeMs
  );
}
/** Recognize Finder's version-1 Bud1 allocation header, not a filename alone. */
async function finderMetadata(filename: string) {
  const entry = await lstat(filename);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) return;
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = await handle.stat();
    if (
      !sameCleanupFile(entry, info) ||
      (await realpath(filename)) !== filename
    )
      throw new Error("Finder metadata changed. The folder was left in place.");
    const header = Buffer.alloc(36);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    const offset = header.readUInt32BE(8),
      size = header.readUInt32BE(12);
    if (
      bytesRead !== header.length ||
      header.readUInt32BE(0) !== 1 ||
      header.readUInt32BE(4) !== 0x42756431 ||
      offset < header.length - 4 ||
      header.readUInt32BE(16) !== offset ||
      size < 32 ||
      offset + 4 + size > info.size
    )
      return;
    if (!sameCleanupFile(info, await handle.stat()))
      throw new Error("Finder metadata changed. The folder was left in place.");
    return info;
  } finally {
    await handle.close();
  }
}
/** Only recognized sole Finder metadata may reach Trash; rmdir stays non-recursive. */
export async function removeEmptyManagedAlbumDirectory(
  plan: ManagedAlbumDirectory,
  trashFinderMetadata?: (filename: string) => Promise<void>,
) {
  if (
    !managedDirectory(plan.relative) ||
    plan.parents.length !== plan.relative.split("/").length
  )
    throw new Error("Unsafe managed album cleanup boundary.");
  const target = path.resolve(plan.root.path, plan.relative);
  const recheck = async () => {
    await directories(plan.root, `${plan.relative}/.rio-cleanup-check`, false);
    const parts = plan.relative.split("/");
    for (let i = 0; i < plan.parents.length; i++) {
      const expected = plan.parents[i];
      if (expected.relative !== parts.slice(0, i + 1).join("/"))
        throw new Error("Unsafe managed album cleanup boundary.");
      const directory = path.resolve(plan.root.path, expected.relative);
      const info = await lstat(directory);
      if (
        !info.isDirectory() ||
        info.isSymbolicLink() ||
        String(info.dev) !== expected.device ||
        String(info.ino) !== expected.inode ||
        (await realpath(directory)) !== directory
      )
        throw new Error(
          "The managed album folder changed. It was left in place.",
        );
    }
  };
  try {
    await recheck();
    const entries = await readdir(target);
    if (entries.length) {
      if (
        !trashFinderMetadata ||
        entries.length !== 1 ||
        entries[0] !== ".DS_Store"
      )
        return;
      const filename = path.join(target, ".DS_Store");
      const identity = await finderMetadata(filename);
      if (!identity) return;
      await recheck();
      const latestEntries = await readdir(target);
      if (latestEntries.length !== 1 || latestEntries[0] !== ".DS_Store")
        return;
      if (
        !sameCleanupFile(identity, await lstat(filename)) ||
        (await realpath(filename)) !== filename
      )
        throw new Error(
          "Finder metadata changed. The folder was left in place.",
        );
      // Same native Trash adapter as managed audio, only after committed deletion.
      // No permanent-unlink fallback, no other dotfiles or unknown content adopted.
      await trashFinderMetadata(filename);
      await recheck();
      if ((await readdir(target)).length) return;
    }
    await recheck();
    await rmdir(target);
  } catch (error) {
    // Already absent or concurrently made non-empty is a safe no-op, never recursion.
    if (
      !["ENOENT", "ENOTEMPTY", "EEXIST"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )
    )
      throw error;
  }
}
const getJob = (db: DatabaseSync, id: string) =>
  db
    .prepare("SELECT * FROM managed_imports WHERE id=?")
    .get(id) as unknown as Job;
async function ownedStage(root: MediaRoot, job: Job) {
  if (!/^\.rio-imports\/[a-f0-9-]+\.partial$/.test(job.stage))
    throw new Error("Unsafe staging receipt.");
  const stage = await directories(root, job.stage, false);
  const info = await lstat(stage);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    String(info.dev) !== job.stageDevice ||
    String(info.ino) !== job.stageInode
  )
    throw new Error("Staging file no longer matches its import receipt.");
  return stage;
}
async function publishedLocation(
  db: DatabaseSync,
  root: MediaRoot,
  job: Job,
  target: string,
): Promise<ManagedLocation> {
  const canonical = await realpath(target),
    info = await lstat(canonical);
  if (
    !inside(root.path, canonical) ||
    !info.isFile() ||
    String(info.dev) !== job.stageDevice ||
    String(info.ino) !== job.stageInode ||
    (await fileDigest(canonical)) !== job.digest
  )
    throw new Error("Published copy no longer matches its import receipt.");
  const relative = path
    .relative(root.path, canonical)
    .split(path.sep)
    .join("/");
  db.prepare("UPDATE managed_imports SET relative=? WHERE id=?").run(
    relative,
    job.id,
  );
  return {
    path: canonical,
    rootId: root.id,
    relative,
    trackId: job.trackId,
    jobId: job.id,
  };
}
export async function prepareManagedCopy(
  db: DatabaseSync,
  root: MediaRoot,
  source: string,
  metadata: OrganizationMetadata,
  organized: boolean,
  existingId?: string,
  expectedDigest?: string,
  recovery = false,
): Promise<ManagedLocation> {
  await validateMediaRoot(root);
  const digest = await fileDigest(source);
  if (expectedDigest && expectedDigest !== digest)
    throw new Error(
      "Source changed while reading metadata; try importing again.",
    );
  let job = db
    .prepare(
      "SELECT * FROM managed_imports WHERE source=? AND digest=? AND rootId=?",
    )
    .get(source, digest, root.id) as unknown as Job | undefined;
  if (job && existingId && job.trackId !== existingId)
    throw new Error(
      "This source belongs to another managed track. Choose a different recovery file.",
    );
  if (job?.status === "done") {
    try {
      const target = await directories(root, job.relative, false);
      if ((await fileDigest(target)) !== digest)
        throw new Error(
          "The previously imported managed copy changed. It has not been overwritten.",
        );
      return await publishedLocation(db, root, job, target);
    } catch (error) {
      if (!recovery || !existingId) throw error;
      // Explicit recovery may recopy a completed receipt's missing/changed output.
      // Publication remains exclusive, so changed or unrelated destinations survive.
      db.prepare(
        "UPDATE managed_imports SET status='copying',stageDevice=NULL,stageInode=NULL WHERE id=?",
      ).run(job.id);
      job = getJob(db, job.id);
    }
  }
  if (!job) {
    const id = randomUUID();
    const planned = mediaDestination(
      root.path,
      metadata,
      path.extname(source),
      organized,
      path.basename(source, path.extname(source)),
    );
    db.prepare(
      "INSERT INTO managed_imports(id,source,digest,rootId,relative,stage,status,trackId) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      id,
      source,
      digest,
      root.id,
      planned.relative,
      `.rio-imports/${randomUUID()}.partial`,
      "copying",
      existingId ?? createHash("sha256").update(randomUUID()).digest("hex"),
    );
    job = getJob(db, id);
  }
  if (job.status === "copying") {
    // Retry may discard only this receipt's verified private partial, never an audio destination.
    if (job.stageInode) {
      try {
        const stage = await ownedStage(root, job);
        await unlink(stage);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
    const stageRelative = `.rio-imports/${randomUUID()}.partial`;
    const stage = await directories(root, stageRelative, true);
    const output = await open(stage, "wx", 0o600);
    try {
      const info = await output.stat();
      db.prepare(
        "UPDATE managed_imports SET stage=?,stageDevice=?,stageInode=? WHERE id=?",
      ).run(stageRelative, String(info.dev), String(info.ino), job.id);
      const input = await open(
        source,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const before = await input.stat(),
          buffer = Buffer.alloc(1024 * 1024);
        let position = 0;
        while (true) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            buffer.length,
            position,
          );
          if (!bytesRead) break;
          let written = 0;
          while (written < bytesRead)
            written += (
              await output.write(
                buffer,
                written,
                bytesRead - written,
                position + written,
              )
            ).bytesWritten;
          position += bytesRead;
        }
        const after = await input.stat();
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs ||
          position !== before.size
        )
          throw new Error("Source changed during copying; try again.");
      } finally {
        await input.close();
      }
      await output.sync();
    } finally {
      await output.close();
    }
    await syncDirectory(path.dirname(stage));
    if (
      (await fileDigest(stage)) !== digest ||
      (await fileDigest(source)) !== digest
    )
      throw new Error("Copy verification failed; original left unchanged.");
    db.prepare("UPDATE managed_imports SET status='ready' WHERE id=?").run(
      job.id,
    );
    job = getJob(db, job.id);
  }
  let stage: string;
  try {
    stage = await ownedStage(root, job);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    // A crash or external cleanup can remove the staging link. Reuse only a
    // published file proven by the receipt; otherwise recopy without overwriting it.
    try {
      return await publishedLocation(
        db,
        root,
        job,
        await directories(root, job.relative, false),
      );
    } catch {
      /* The original source remains available and verified above. */
    }
    db.prepare(
      "UPDATE managed_imports SET status='copying',stageDevice=NULL,stageInode=NULL WHERE id=?",
    ).run(job.id);
    return prepareManagedCopy(
      db,
      root,
      source,
      metadata,
      organized,
      existingId,
      digest,
      recovery,
    );
  }
  if ((await fileDigest(stage)) !== digest)
    throw new Error(
      "Staged copy is incomplete or changed; import retained for inspection.",
    );
  for (let collision = 1; collision <= 10000; collision++) {
    // Resume the recorded candidate first: a crash may occur after publication but before indexing.
    const relative =
      collision === 1
        ? job.relative
        : mediaDestination(
            root.path,
            metadata,
            path.extname(source),
            organized,
            path.basename(source, path.extname(source)),
            collision,
          ).relative;
    const target = await directories(root, relative, true);
    db.prepare("UPDATE managed_imports SET relative=? WHERE id=?").run(
      relative,
      job.id,
    );
    try {
      await link(stage, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const a = await lstat(stage),
        b = await lstat(target);
      if (
        !b.isFile() ||
        b.isSymbolicLink() ||
        a.dev !== b.dev ||
        a.ino !== b.ino
      )
        continue;
    }
    await validateMediaRoot(root);
    await syncDirectory(path.dirname(target));
    return publishedLocation(db, root, getJob(db, job.id), target);
  }
  throw new Error("Too many filename collisions; no audio was overwritten.");
}
/** Only private staging links are removed after a durable database commit. */
export async function finishManagedCopy(
  db: DatabaseSync,
  root: MediaRoot,
  location: ManagedLocation,
) {
  const job = getJob(db, location.jobId);
  if (!job.stageInode) return;
  try {
    const stage = await ownedStage(root, job),
      a = await lstat(stage),
      b = await lstat(location.path);
    if (a.dev === b.dev && a.ino === b.ino && !b.isSymbolicLink())
      await unlink(stage);
  } catch {
    /* A committed track is valid; a leftover private link is harmless and never scanned. */
  }
}
