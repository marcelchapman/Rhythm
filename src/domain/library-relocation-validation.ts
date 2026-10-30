/** Read-only relocation preflight. This does not relax managed deletion/recovery rules. */
import path from "node:path";
import { lstat, realpath } from "node:fs/promises";
import { Library } from "./library.js";
import { inside } from "./media-plan.js";
import { fileDigest, type MediaRoot } from "./managed-copy.js";

/** Permit filesystem spelling aliases only after checking every component for links. */
async function checkedCanonical(filename: string) {
  if (!path.isAbsolute(filename) || path.resolve(filename) !== filename)
    throw new Error("Managed path is not normalized and absolute.");
  const absolute = path.resolve(filename),
    root = path.parse(absolute).root;
  let current = root;
  const parts = path.relative(root, absolute).split(path.sep);
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (i < parts.length - 1 && !info.isDirectory()))
      throw new Error(
        "Managed path contains a symbolic link or unsafe parent.",
      );
  }
  return realpath(absolute);
}

export async function validateRelocationMedia(source: Library) {
  const savedRoots = source.db
    .prepare("SELECT rootId AS id,path,device,inode FROM media_root_locations")
    .all() as unknown as MediaRoot[];
  const internalRoots: MediaRoot[] = [];
  const canonicalPaths = new Map<string, string>();
  for (const root of savedRoots) {
    const canonical = await realpath(root.path).catch(() => undefined);
    if (!canonical) {
      if (inside(source.directory, root.path))
        throw new Error("An internal media root is unavailable.");
      continue; // External roots remain untouched, including unavailable volumes.
    }
    if (!inside(source.directory, canonical)) {
      if (inside(source.directory, root.path))
        throw new Error("Internal media root resolves outside the library.");
      continue;
    }
    await checkedCanonical(root.path);
    const info = await lstat(canonical);
    if (
      !info.isDirectory() ||
      String(info.dev) !== root.device ||
      String(info.ino) !== root.inode
    )
      throw new Error(
        "Internal media-root identity does not match its saved configuration.",
      );
    canonicalPaths.set(root.path, canonical);
    internalRoots.push({ ...root, path: canonical });
  }
  const receipts = source.db
    .prepare("SELECT * FROM managed_imports WHERE status='done'")
    .all();
  const receiptPaths = new Map<string, string>();
  for (const receipt of receipts) {
    const root = internalRoots.find((r) => r.id === receipt.rootId);
    if (!root) continue;
    const relative = String(receipt.relative);
    if (
      path.isAbsolute(relative) ||
      relative.includes("\\") ||
      relative.split("/").some((p) => !p || p === "." || p === "..")
    )
      throw new Error("Managed receipt contains an unsafe relative path.");
    const recorded = path.resolve(root.path, relative);
    if (!inside(root.path, recorded))
      throw new Error("Managed receipt escapes its configured media root.");
    const canonical = await checkedCanonical(recorded),
      info = await lstat(canonical);
    if (
      !inside(root.path, canonical) ||
      !info.isFile() ||
      String(info.dev) !== receipt.stageDevice ||
      String(info.ino) !== receipt.stageInode ||
      (await fileDigest(canonical)) !== receipt.digest
    )
      throw new Error(
        "Managed-copy receipt verification failed: path, file identity or digest does not match.",
      );
    canonicalPaths.set(recorded, canonical);
    receiptPaths.set(
      String(receipt.id),
      path.relative(root.path, canonical).split(path.sep).join("/"),
    );
  }
  // Rebase existing internal aliases to their verified canonical spelling in the copy only.
  const paths = [
    ...source.tracks().map((t) => t.path),
    ...receipts.map((r) => String(r.source)),
    ...source.roots(),
  ];
  for (const filename of paths) {
    const canonical = await realpath(filename).catch(() => undefined);
    if (canonical && inside(source.directory, canonical)) {
      await checkedCanonical(filename);
      canonicalPaths.set(filename, canonical);
    }
  }
  return { internalRoots, receipts, receiptPaths, canonicalPaths };
}
