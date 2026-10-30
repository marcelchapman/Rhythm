/** Copy/verify/commit relocation. No permanent recursive deletion of either environment. */
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  lstat,
  realpath,
  readdir,
  mkdir,
  open,
  rename,
  unlink,
  rmdir,
} from "node:fs/promises";
import { validateRelocationMedia } from "./library-relocation-validation.js";
import { Library } from "./library.js";
import { inside } from "./media-plan.js";
import {
  fileDigest,
  validateMediaRoot,
  validateManagedTrash,
  type MediaRoot,
} from "./managed-copy.js";

import {
  assertRelocationOpen,
  RELOCATION_MARKER,
  RETIRED_MARKER,
} from "./library-relocation-marker.js";
type Entry = {
  relative: string;
  device: string;
  inode: string;
  directory: boolean;
  digest?: string;
  size: number;
  mtime: number;
};
const identity = (s: Awaited<ReturnType<typeof lstat>>) => ({
  device: String(s.dev),
  inode: String(s.ino),
});
async function directorySync(directory: string) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
async function inventory(root: string, relocating = false): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function walk(relative: string) {
    const filename = path.join(root, relative);
    const info = await lstat(filename);
    if (
      (await realpath(filename)) !== filename ||
      info.isSymbolicLink() ||
      (!info.isFile() && !info.isDirectory()) ||
      (info.isFile() && info.nlink !== 1)
    )
      throw new Error(
        "Library relocation refuses symlinks, hard-linked files and special files.",
      );
    entries.push({
      relative,
      ...identity(info),
      directory: info.isDirectory(),
      size: info.size,
      mtime: info.mtimeMs,
      ...(!info.isDirectory() ? { digest: await fileDigest(filename) } : {}),
    });
    if (info.isDirectory())
      for (const name of (await readdir(filename)).sort()) {
        if (!relative && ["rio.sqlite-wal", "rio.sqlite-shm"].includes(name))
          continue;
        if (relocating && !relative && name === RELOCATION_MARKER) continue;
        if (name === RELOCATION_MARKER || name.startsWith(".rio-publication-"))
          throw new Error(
            "Finish library recovery/publication before moving this library.",
          );
        await walk(path.join(relative, name));
      }
  }
  await walk("");
  return entries;
}
function sameTree(a: Entry[], b: Entry[]) {
  return (
    JSON.stringify(a.map(({ size, mtime, ...e }) => e)) ===
    JSON.stringify(b.map(({ size, mtime, ...e }) => e))
  );
}
async function atIdentity(filename: string, entry: Entry) {
  const s = await lstat(filename);
  if (
    (await realpath(filename)) !== filename ||
    String(s.dev) !== entry.device ||
    String(s.ino) !== entry.inode ||
    s.isDirectory() !== entry.directory
  )
    throw new Error(
      "Relocation directory/file identity changed; original retained.",
    );
}

/** Internal fault/barrier seam. Never exposed over IPC. Both volume types use verified copying. */
export type RelocationHooks = {
  at?: (
    phase:
      | "copy-entry"
      | "copied"
      | "verified"
      | "rebound"
      | "before-commit"
      | "committed",
    destination: string,
  ) => Promise<void>;
};
export class RelocationFailure extends Error {
  readonly code = "RIO_LIBRARY_MOVE_FAILED";
  constructor(
    readonly phase: string,
    readonly original: string,
    readonly destination: string,
    readonly incompleteDestination: boolean,
    reason: string,
  ) {
    super(
      `MOVE FAILED (${phase}). The original library remains unchanged and authoritative at ${original}. No library location was switched. ${incompleteDestination ? `Incomplete destination artifacts remain at ${destination}; keep the original and inspect those artifacts before retrying.` : `No incomplete relocation files remain at ${destination}.`} Reason: ${reason}`,
    );
  }
}
export async function relocateLibrary(
  source: Library,
  destination: string,
  pointerFile: string,
  hooks: RelocationHooks = {},
) {
  try {
    return await relocate(source, destination, pointerFile, hooks);
  } catch (error) {
    if (error instanceof RelocationFailure) throw error;
    throw new RelocationFailure(
      "preflight",
      source.directory,
      destination,
      false,
      error instanceof Error ? error.message : String(error),
    );
  }
}
async function relocate(
  source: Library,
  selectedDestination: string,
  pointerFile: string,
  hooks: RelocationHooks,
) {
  if (source.scanning || source.mediaSettings().pendingImports)
    throw new Error("Finish pending operations before moving the library.");
  if (!path.isAbsolute(selectedDestination))
    throw new Error("Choose an absolute destination folder.");
  const requested = path.resolve(selectedDestination);
  const parent = await realpath(path.dirname(requested));
  if (parent !== path.dirname(requested))
    throw new Error("Choose a destination without symbolic-link parents.");
  let createdDestination = false;
  let destination = requested;
  let existingDestination: Entry | undefined;
  try {
    const info = await lstat(requested);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(
        "Choose an empty destination directory without symbolic links.",
      );
    destination = await realpath(requested);
    if (destination !== requested)
      throw new Error("Choose the destination's canonical directory spelling.");
    existingDestination = {
      relative: "",
      ...identity(info),
      directory: true,
      size: info.size,
      mtime: info.mtimeMs,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (
    destination === source.directory ||
    inside(source.directory, destination) ||
    inside(destination, source.directory)
  )
    throw new Error("Choose a destination outside this library.");
  if (existingDestination && (await readdir(destination)).length)
    throw new Error(
      "The selected destination is not empty; existing files and libraries will not be overwritten.",
    );
  const parentInfo = await lstat(parent);
  if (!parentInfo.isDirectory())
    throw new Error("Choose a destination folder.");
  const parentEntry: Entry = {
    relative: "",
    ...identity(parentInfo),
    directory: true,
    size: 0,
    mtime: 0,
  };
  let phase = "preflight";
  source.scanning = true;
  const token = randomUUID();
  const owned: Entry[] = [];
  let next: Library | undefined;
  let committed = false;
  let retainedSource = source.directory;
  let pointerTemp: string | undefined;
  let pointerIdentity: Entry | undefined;
  const marker = path.join(destination, RELOCATION_MARKER);
  async function record(filename: string, relative: string) {
    const s = await lstat(filename);
    owned.push({
      relative,
      ...identity(s),
      directory: s.isDirectory(),
      size: s.size,
      mtime: s.mtimeMs,
    });
  }
  async function boundary(filename?: string) {
    await atIdentity(parent, parentEntry);
    if (owned.length) await atIdentity(destination, owned[0]);
    if (filename)
      for (const entry of owned) {
        const ancestor = path.join(destination, entry.relative);
        if (entry.directory && inside(ancestor, filename))
          await atIdentity(ancestor, entry);
      }
  }
  async function createFile(
    filename: string,
    relative: string,
    bytes?: string,
  ) {
    await boundary(filename);
    const handle = await open(
      filename,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    await record(filename, relative);
    try {
      if (bytes !== undefined) await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  try {
    await inventory(source.directory);
    // Hold an exclusive SQLite connection lock across checkpoint, copy and publication.
    // Another profile/process cannot append a WAL between the checkpoint and commit.
    source.db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
    if (source.mediaSettings().pendingImports)
      throw new Error("Finish pending imports before moving the library.");
    const { internalRoots, receipts, receiptPaths, canonicalPaths } =
      await validateRelocationMedia(source);
    const resolved = (filename: string) =>
      canonicalPaths.get(filename) ?? filename;
    const inMedia = (filename: string) =>
      internalRoots.some(
        (r) =>
          resolved(filename) === r.path || inside(r.path, resolved(filename)),
      );
    const excluded = new Set(
      source
        .tracks()
        .filter(
          (t) =>
            t.locationKind === "referenced" &&
            inside(source.directory, resolved(t.path)) &&
            !inMedia(t.path),
        )
        .map((t) => path.relative(source.directory, resolved(t.path))),
    );
    // Claim contents with an exclusive marker; never remove a user-selected directory.
    if (existingDestination) {
      await atIdentity(destination, existingDestination);
      if ((await readdir(destination)).length)
        throw new Error(
          "Destination changed before copying; it will not be used.",
        );
    } else {
      await mkdir(destination, { mode: 0o700 });
      createdDestination = true;
    }
    await record(destination, "");
    await createFile(
      marker,
      RELOCATION_MARKER,
      JSON.stringify({ token, source: source.directory, phase: "copying" }),
    );
    if ((await readdir(destination)).some((name) => name !== RELOCATION_MARKER))
      throw new Error("Destination changed while being reserved.");
    phase = "copy";
    await directorySync(destination);
    await directorySync(parent);
    const checkpoint = source.db
      .prepare("PRAGMA wal_checkpoint(TRUNCATE)")
      .get();
    if (checkpoint?.busy)
      throw new Error(
        "Close other connections to this library before moving it.",
      );
    const original = await inventory(source.directory);
    const payload = original.filter((e) => !excluded.has(e.relative));
    for (const entry of payload.slice(1)) {
      await hooks.at?.("copy-entry", destination);
      await boundary();
      const from = path.join(source.directory, entry.relative),
        to = path.join(destination, entry.relative);
      await atIdentity(from, entry);
      if (entry.directory) {
        await mkdir(to, { mode: 0o700 });
        await record(to, entry.relative);
      } else {
        await createFile(to, entry.relative);
        // O_NOFOLLOW on both handles; bounded memory, exclusive owned destination.
        const input = await open(
          from,
          constants.O_RDONLY | constants.O_NOFOLLOW,
        );
        const output = await open(
          to,
          constants.O_WRONLY | constants.O_NOFOLLOW,
        );
        try {
          await boundary(to);
          await atIdentity(to, owned[owned.length - 1]);
          const opened = identity(await output.stat());
          const expected = owned[owned.length - 1];
          if (
            opened.device !== expected.device ||
            opened.inode !== expected.inode
          )
            throw new Error("Copy target identity changed.");
          const inputIdentity = identity(await input.stat());
          if (
            inputIdentity.device !== entry.device ||
            inputIdentity.inode !== entry.inode
          )
            throw new Error("Copy source identity changed.");
          const buffer = Buffer.alloc(1024 * 1024);
          let offset = 0;
          for (;;) {
            const { bytesRead } = await input.read(
              buffer,
              0,
              buffer.length,
              offset,
            );
            if (!bytesRead) break;
            let written = 0;
            while (written < bytesRead)
              written += (
                await output.write(
                  buffer,
                  written,
                  bytesRead - written,
                  offset + written,
                )
              ).bytesWritten;
            offset += bytesRead;
          }
          const sourceInfo = await input.stat();
          await output.chmod(sourceInfo.mode & 0o777);
          await output.utimes(sourceInfo.atime, sourceInfo.mtime);
          await output.sync();
        } finally {
          await input.close();
          await output.close();
        }
      }
    }
    phase = "verification";
    await hooks.at?.("copied", destination);
    for (const entry of payload)
      if (
        !entry.directory &&
        (await fileDigest(path.join(destination, entry.relative))) !==
          entry.digest
      )
        throw new Error(
          "Relocation copy verification failed; original retained.",
        );
    if (!sameTree(original, await inventory(source.directory)))
      throw new Error(
        "Original library changed during copying; it has not been retired.",
      );
    await hooks.at?.("verified", destination);
    next = await Library.open(destination, {
      relocationToken: token,
      relocationPreparing: true,
    });
    const remap = (value: string) => {
      const canonical = resolved(value);
      return (canonical === source.directory ||
        inside(source.directory, canonical)) &&
        !excluded.has(path.relative(source.directory, canonical))
        ? path.join(destination, path.relative(source.directory, canonical))
        : value;
    };
    next.db.exec("BEGIN IMMEDIATE");
    try {
      for (const root of internalRoots) {
        const moved = remap(root.path),
          s = await lstat(moved);
        next.db
          .prepare(
            "UPDATE media_root_locations SET path=?,device=?,inode=? WHERE rootId=?",
          )
          .run(moved, String(s.dev), String(s.ino), root.id);
      }
      for (const t of next.tracks()) {
        const root = internalRoots.find((r) => r.id === t.mediaRootId);
        if (root && t.locationKind === "managed")
          next.db
            .prepare(
              "UPDATE track_locations SET relativePath=? WHERE trackId=?",
            )
            .run(
              path
                .relative(remap(root.path), remap(t.path))
                .split(path.sep)
                .join("/"),
              t.id,
            );
        if (remap(t.path) !== t.path)
          next.db
            .prepare("UPDATE tracks SET path=? WHERE id=?")
            .run(remap(t.path), t.id);
      }
      const scanRoots = next.roots();
      next.db.exec("DELETE FROM roots");
      for (const root of scanRoots)
        next.db
          .prepare("INSERT OR IGNORE INTO roots VALUES(?)")
          .run(inMedia(root) ? remap(root) : root);
      for (const receipt of receipts) {
        const root = internalRoots.find((r) => r.id === receipt.rootId);
        if (root) {
          const s = await lstat(
            path.join(remap(root.path), receiptPaths.get(String(receipt.id))!),
          );
          next.db
            .prepare(
              "UPDATE managed_imports SET relative=?,stageDevice=?,stageInode=? WHERE id=?",
            )
            .run(
              receiptPaths.get(String(receipt.id))!,
              String(s.dev),
              String(s.ino),
              receipt.id,
            );
        }
        const movedSource = remap(String(receipt.source));
        if (movedSource !== receipt.source)
          next.db
            .prepare("UPDATE managed_imports SET source=? WHERE id=?")
            .run(movedSource, receipt.id);
      }
      next.db.exec("COMMIT");
    } catch (error) {
      next.db.exec("ROLLBACK");
      throw error;
    }
    if (
      next.db.prepare("PRAGMA integrity_check").get()?.integrity_check !==
        "ok" ||
      next.db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Relocated database failed validation.");
    for (const root of internalRoots) {
      const moved = next.db
        .prepare(
          "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
        )
        .get(root.id) as unknown as MediaRoot;
      await validateMediaRoot(moved);
      for (const receipt of next.db
        .prepare(
          "SELECT trackId,relative FROM managed_imports WHERE rootId=? AND status='done'",
        )
        .all(root.id))
        await validateManagedTrash(
          next.db,
          moved,
          String(receipt.trackId),
          path.join(moved.path, String(receipt.relative)),
          String(receipt.relative),
        );
    }
    next.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    next.close();
    next = undefined;
    await hooks.at?.("rebound", destination);
    const readyPayload = await inventory(destination, true);
    if (readyPayload.length !== owned.length - 1)
      throw new Error("Unexpected destination content; original retained.");
    for (const entry of owned.filter((e) => e.relative !== RELOCATION_MARKER))
      await atIdentity(path.join(destination, entry.relative), entry);
    // Ready means copied, verified, rebound, integrity checked and closed cleanly.
    const ready = await open(marker, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      await ready.truncate(0);
      await ready.writeFile(
        JSON.stringify({ token, source: source.directory, phase: "ready" }),
      );
      await ready.sync();
    } finally {
      await ready.close();
    }
    for (const entry of [...owned].reverse())
      if (entry.directory)
        await directorySync(path.join(destination, entry.relative));
    next = await Library.open(destination, {
      setupMediaRoot: true,
      relocationToken: token,
    });
    await boundary();
    if (!sameTree(original, await inventory(source.directory)))
      throw new Error(
        "Original changed before publication; original retained.",
      );
    phase = "commit";
    await hooks.at?.("before-commit", destination);
    await boundary();
    await assertRelocationOpen(destination, token);
    if (!sameTree(readyPayload, await inventory(destination, true)))
      throw new Error("Destination changed before commit; original retained.");
    await mkdir(path.dirname(pointerFile), { recursive: true });
    await directorySync(path.dirname(pointerFile));
    pointerTemp = `${pointerFile}.${token}.tmp`;
    const pointer = await open(pointerTemp, "wx", 0o600);
    pointerIdentity = {
      relative: "",
      ...identity(await pointer.stat()),
      directory: false,
      size: 0,
      mtime: 0,
    };
    try {
      await pointer.writeFile(
        JSON.stringify({ libraryPath: destination, relocationToken: token }),
      );
      await pointer.sync();
    } finally {
      await pointer.close();
    }
    await atIdentity(pointerTemp, pointerIdentity);
    await rename(pointerTemp, pointerFile);
    pointerTemp = undefined;
    committed = true;
    await directorySync(path.dirname(pointerFile));
    await hooks.at?.("committed", destination);
    // Retire in place: referenced files outside managed media retain their paths.
    // No original payload is removed, even if retirement/cleanup is interrupted.
    await atIdentity(source.directory, original[0]);
    source.close();
    const retirement = await open(
      path.join(source.directory, RETIRED_MARKER),
      "wx",
      0o600,
    );
    try {
      await retirement.writeFile(JSON.stringify({ token, destination }));
      await retirement.sync();
    } finally {
      await retirement.close();
    }
    await directorySync(source.directory);
    retainedSource = source.directory;
    await boundary();
    await unlink(marker);
    await directorySync(destination);
    return {
      status: "moved" as const,
      library: next,
      retainedSource,
      warning: undefined as string | undefined,
    };
  } catch (error) {
    if (committed && next)
      return {
        status: "recovery-required" as const,
        library: next,
        retainedSource,
        warning: `RELOCATION RECOVERY REQUIRED. The validated destination ${destination} is active in this session, but final durability/cleanup did not finish. The original copy is retained at ${retainedSource}. Keep both copies and restart Rio before retrying.`,
      };
    next?.close();
    // Only entries created by this attempt, with unchanged identities, are removable.
    // No recursive rm: unexpected additions or replacement ancestors stop cleanup.
    for (const entry of [...owned]
      .reverse()
      .filter((e) => e.relative && e.relative !== RELOCATION_MARKER)) {
      try {
        const filename = path.join(destination, entry.relative);
        await boundary(filename);
        await atIdentity(filename, entry);
        if (entry.directory) await rmdir(filename);
        else await unlink(filename);
      } catch {
        /* Retain anything whose identity/ownership can no longer be proven. */
      }
    }
    try {
      if (owned.length) {
        await boundary();
        const remaining = await readdir(destination);
        // Retain the recovery marker whenever anything unexpected is left behind.
        if (remaining.length === 1 && remaining[0] === RELOCATION_MARKER) {
          const markerEntry = owned.find(
            (e) => e.relative === RELOCATION_MARKER,
          );
          if (markerEntry) {
            await atIdentity(marker, markerEntry);
            await unlink(marker);
            if (createdDestination) await rmdir(destination);
            else await directorySync(destination);
          }
        }
      }
    } catch {
      /* Incomplete destination remains marked for manual recovery. */
    }
    if (pointerTemp && pointerIdentity) {
      try {
        await atIdentity(pointerTemp, pointerIdentity);
        await unlink(pointerTemp);
      } catch {
        /* Never remove a replaced pointer temporary. */
      }
    }
    const incomplete =
      owned.length > 0 &&
      (await readdir(destination)
        .then((names) => names.length > 0)
        .catch((error) => (error as NodeJS.ErrnoException).code !== "ENOENT"));
    const detail = error instanceof Error ? error.message : String(error);
    const reason =
      /Managed file location changed|Rio Media folder changed|recovery source|moved to Trash/.test(
        detail,
      )
        ? "Managed-copy path, identity or digest verification failed."
        : detail;
    throw new RelocationFailure(
      phase,
      source.directory,
      destination,
      incomplete,
      reason,
    );
  } finally {
    if (source.db.isOpen) {
      try {
        source.db.exec("ROLLBACK");
      } catch {
        /* No open transaction is normal. */
      }
      try {
        source.db.exec(
          "PRAGMA locking_mode=NORMAL; SELECT count(*) FROM sqlite_master;",
        );
      } catch {
        /* Closing the original later also releases its lock. */
      }
    }
    source.scanning = false;
  }
}
