import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  lstat,
  symlink,
  link,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import {
  planManagedAlbumCleanup,
  removeEmptyManagedAlbumDirectory,
  type MediaRoot,
} from "../src/domain/managed-copy";
import type { Track } from "../src/shared/types";
import { finderStoreFixture, wavFixture } from "./fixtures";

let root: string, media: string, l: Library;
const originals = new Map<string, { bytes: Buffer; mtime: number }>();
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-album-cleanup-")),
  );
  media = path.join(root, "Media");
  await mkdir(media);
  await mkdir(path.join(root, "Trash"));
  await mkdir(path.join(root, "Originals"));
  l = await Library.open(path.join(root, "Library"));
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true });
});
afterEach(async () => {
  try {
    for (const [file, before] of originals) {
      expect(await readFile(file)).toEqual(before.bytes);
      expect((await stat(file)).mtimeMs).toBe(before.mtime);
    }
  } finally {
    originals.clear();
    l.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function add(title: string, managed = true, album = "Album") {
  const file = path.join(root, "Originals", `${title}.wav`);
  await writeFile(file, wavFixture({ title, artist: "Artist", album }));
  originals.set(file, {
    bytes: await readFile(file),
    mtime: (await stat(file)).mtimeMs,
  });
  l.saveMediaSettings({ copyOnAdd: managed });
  expect((await l.add([file])).errors).toEqual([]);
  return l.tracks().find((track) => track.title === title)!;
}
const trash = async (file: string) => {
  expect(file.startsWith(`${media}/`)).toBe(true);
  expect(originals.has(file)).toBe(false);
  await rename(file, path.join(root, "Trash", path.basename(file)));
};
const remove = (tracks: Track[], adapter = trash) =>
  l.deleteTracks(tracks, adapter, { cleanupEmptyAlbumDirectories: true });
const missing = (file: string) =>
  expect(lstat(file)).rejects.toMatchObject({ code: "ENOENT" });
async function relocate(track: Track, relative: string) {
  // Model an existing registered managed disc layout, using only genuine generated
  // copies: rename retains the receipt's device/inode/digest; update its exact path.
  const destination = path.join(media, relative);
  await mkdir(path.dirname(destination), { recursive: true });
  await rename(track.path, destination);
  l.db
    .prepare("UPDATE tracks SET path=? WHERE id=?")
    .run(destination, track.id);
  l.db
    .prepare("UPDATE track_locations SET relativePath=? WHERE trackId=?")
    .run(relative, track.id);
  l.db
    .prepare("UPDATE managed_imports SET relative=? WHERE trackId=?")
    .run(relative, track.id);
  return l.tracks(track.id)[0];
}
test("final album removal prunes the empty album and artist, preserving root and deletion persistence", async () => {
  const a = await add("a"),
    b = await add("b");
  const album = path.dirname(a.path),
    artist = path.dirname(album);
  const result = await remove(l.albumTracks(a.albumId));
  expect(new Set(result.removedIds)).toEqual(new Set([a.id, b.id]));
  expect(result.failures).toEqual([]);
  expect(result.cleanupWarnings).toBeUndefined();
  await missing(album);
  await missing(artist);
  expect((await stat(media)).isDirectory()).toBe(true);
  l.close();
  l = await Library.open(path.join(root, "Library"));
  expect(l.tracks()).toEqual([]);
  await missing(album);
});
test("ordinary track removal retains its prior directory behavior", async () => {
  const a = await add("a");
  await writeFile(
    path.join(path.dirname(a.path), ".DS_Store"),
    finderStoreFixture(),
  );
  await l.deleteTracks([a], trash);
  expect(await readdir(path.dirname(a.path))).toEqual([".DS_Store"]);
});
test("registered Media root Finder metadata is never touched", async () => {
  const a = await add("a");
  const finder = path.join(media, ".DS_Store");
  await writeFile(finder, finderStoreFixture());
  const adapter = vi.fn(trash);
  await remove([a], adapter);
  await missing(path.dirname(path.dirname(a.path)));
  expect(await readFile(finder)).toEqual(finderStoreFixture());
  expect(adapter.mock.calls.map(([file]) => file)).toEqual([a.path]);
});
test("Finder metadata left at the artist level after album rmdir is trashed before pruning the artist", async () => {
  const a = await add("Finder album");
  const album = path.dirname(a.path),
    artist = path.dirname(album);
  const finder = path.join(artist, ".DS_Store");
  await writeFile(finder, finderStoreFixture());
  const calls: string[] = [];
  const result = await remove([a], async (file) => {
    calls.push(file);
    if (file === finder) {
      // The former real-app failure occurs after the album is already gone.
      await missing(album);
      expect(await readdir(artist)).toEqual([".DS_Store"]);
    }
    await trash(file);
  });
  expect(result.removedIds).toEqual([a.id]);
  expect(result.cleanupWarnings).toBeUndefined();
  expect(calls).toEqual([a.path, finder]);
  expect(await readFile(path.join(root, "Trash", ".DS_Store"))).toEqual(
    finderStoreFixture(),
  );
  await missing(artist);
  expect((await stat(media)).isDirectory()).toBe(true);
});
test("Finder-only disc, album and artist directories are pruned children first", async () => {
  const a = await relocate(await add("a"), "Artist/Album/CD1/a.wav");
  const directories = [
    path.dirname(a.path),
    path.join(media, "Artist/Album"),
    path.join(media, "Artist"),
  ];
  for (const directory of directories)
    await writeFile(path.join(directory, ".DS_Store"), finderStoreFixture());
  const adapter = vi.fn(trash);
  const result = await remove([a], adapter);
  expect(result.failures).toEqual([]);
  expect(result.cleanupWarnings).toBeUndefined();
  expect(adapter.mock.calls.map(([file]) => file)).toEqual([
    a.path,
    ...directories.map((d) => path.join(d, ".DS_Store")),
  ]);
  await missing(directories.at(-1)!);
  expect((await stat(media)).isDirectory()).toBe(true);
});
test("another album preserves artist Finder metadata until its final album is deleted", async () => {
  const a = await add("a"),
    b = await add("b", true, "Sibling");
  const artist = path.dirname(path.dirname(a.path));
  const finder = path.join(artist, ".DS_Store");
  await writeFile(finder, finderStoreFixture());
  const adapter = vi.fn(trash);
  await remove([a], adapter);
  await missing(path.dirname(a.path));
  expect(await readFile(finder)).toEqual(finderStoreFixture());
  expect((await stat(b.path)).isFile()).toBe(true);
  expect(adapter.mock.calls.map(([f]) => f)).toEqual([a.path]);
  await remove([b], adapter);
  await missing(artist);
  expect((await stat(media)).isDirectory()).toBe(true);
});
test.each(["album", "artist"])(
  "Finder metadata beside unknown content at %s level is untouched",
  async (level) => {
    for (const entry of ["unknown.txt", "unknown subdirectory"]) {
      const a = await add(`a ${entry}`);
      const album = path.dirname(a.path),
        directory = level === "album" ? album : path.dirname(album);
      const finder = path.join(directory, ".DS_Store");
      await writeFile(finder, finderStoreFixture());
      const before = await stat(finder);
      const unknown = path.join(directory, entry);
      if (entry.endsWith("subdirectory")) await mkdir(unknown);
      else await writeFile(unknown, "user content");
      const adapter = vi.fn(trash);
      await remove([a], adapter);
      expect((await readdir(directory)).sort()).toEqual([".DS_Store", entry]);
      expect(await readFile(finder)).toEqual(finderStoreFixture());
      expect((await stat(finder)).mtimeMs).toBe(before.mtimeMs);
      expect(adapter.mock.calls.map(([f]) => f)).toEqual([a.path]);
      // Independent disposable case without touching any source audio.
      await rm(path.join(media, "Artist"), { recursive: true });
    }
  },
);
test.each([
  "symlink",
  "hard link",
  "directory",
  "truncated",
  "wrong version",
  "wrong magic",
  "invalid bounds",
])("a .DS_Store %s is not adopted as Finder metadata", async (kind) => {
  const a = await add("a");
  const artist = path.dirname(path.dirname(a.path)),
    finder = path.join(artist, ".DS_Store");
  const external = path.join(root, "external metadata");
  await writeFile(external, finderStoreFixture());
  if (kind === "symlink") await symlink(external, finder);
  else if (kind === "hard link") await link(external, finder);
  else if (kind === "directory") await mkdir(finder);
  else {
    const bytes = finderStoreFixture();
    if (kind === "wrong version") bytes.writeUInt32BE(2, 0);
    if (kind === "wrong magic") bytes[4] |= 0x80;
    if (kind === "invalid bounds") bytes.writeUInt32BE(0xffffffff, 12);
    await writeFile(
      finder,
      kind === "truncated" ? bytes.subarray(0, 24) : bytes,
    );
  }
  const adapter = vi.fn(trash);
  const result = await remove([a], adapter);
  expect(result.cleanupWarnings).toBeUndefined();
  expect(await readdir(artist)).toEqual([".DS_Store"]);
  expect(adapter.mock.calls.map(([f]) => f)).toEqual([a.path]);
  expect(await readFile(external)).toEqual(finderStoreFixture());
});
test("partial audio deletion retains Finder metadata beside the failed track", async () => {
  const a = await add("a"),
    b = await add("b");
  const album = path.dirname(a.path),
    finder = path.join(album, ".DS_Store");
  await writeFile(finder, finderStoreFixture());
  l.db
    .prepare("UPDATE managed_imports SET status='ready' WHERE trackId=?")
    .run(b.id);
  const adapter = vi.fn(trash);
  const result = await remove([a, b], adapter);
  expect(result.removedIds).toEqual([a.id]);
  expect(result.failures.map((f) => f.id)).toEqual([b.id]);
  expect(await readFile(finder)).toEqual(finderStoreFixture());
  expect(adapter.mock.calls.map(([f]) => f)).toEqual([a.path]);
});
test("Finder Trash failure is a separate cleanup warning after truthful track deletion", async () => {
  const a = await add("a");
  const artist = path.dirname(path.dirname(a.path)),
    finder = path.join(artist, ".DS_Store");
  await writeFile(finder, finderStoreFixture());
  const result = await remove([a], async (file) => {
    if (file === finder) throw new Error("Finder metadata Trash unavailable");
    await trash(file);
  });
  expect(result.removedIds).toEqual([a.id]);
  expect(result.failures).toEqual([]);
  expect(result.cleanupWarnings).toEqual([
    { path: artist, message: "Finder metadata Trash unavailable" },
  ]);
  expect(await readFile(finder)).toEqual(finderStoreFixture());
  expect(l.tracks()).toEqual([]);
});
test("new content after Finder Trash prevents rmdir without a false track failure", async () => {
  const a = await add("a");
  const artist = path.dirname(path.dirname(a.path)),
    finder = path.join(artist, ".DS_Store");
  await writeFile(finder, finderStoreFixture());
  const result = await remove([a], async (file) => {
    await trash(file);
    if (file === finder)
      await writeFile(path.join(artist, "arrived.txt"), "retain");
  });
  expect(result.removedIds).toEqual([a.id]);
  expect(result.cleanupWarnings).toBeUndefined();
  expect(await readdir(artist)).toEqual(["arrived.txt"]);
});
test.each(["symlink", "replacement"])(
  "artist %s after Finder Trash cannot be removed",
  async (kind) => {
    const a = await add("a");
    const artist = path.dirname(path.dirname(a.path)),
      finder = path.join(artist, ".DS_Store");
    const external = path.join(root, "external directory");
    await mkdir(external);
    await writeFile(finder, finderStoreFixture());
    const result = await remove([a], async (file) => {
      await trash(file);
      if (file === finder) {
        await rename(artist, `${artist}-parked`);
        if (kind === "symlink") await symlink(external, artist);
        else await mkdir(artist);
      }
    });
    expect(result.removedIds).toEqual([a.id]);
    expect(result.failures).toEqual([]);
    expect(result.cleanupWarnings).toHaveLength(1);
    expect((await lstat(artist)).isSymbolicLink()).toBe(kind === "symlink");
    expect(await readdir(external)).toEqual([]);
    expect((await stat(media)).isDirectory()).toBe(true);
  },
);
test.each(["album", "artist"])(
  "a registered root at the %s level stops cleanup, including after it becomes historical",
  async (boundary) => {
    const a = await add("a");
    const album = path.dirname(a.path);
    const registered = boundary === "album" ? album : path.dirname(album);
    await l.chooseMediaRoot(registered);
    // Retain protection after changing the active root back: historical roots
    // remain registered managed environments just like the existing Trash authority.
    await l.chooseMediaRoot(media);
    const finder = path.join(registered, ".DS_Store");
    await writeFile(finder, finderStoreFixture());
    const result = await remove([a]);
    expect(result.removedIds).toEqual([a.id]);
    expect(result.failures).toEqual([]);
    if (boundary === "artist") await missing(album);
    expect(await readdir(registered)).toEqual([".DS_Store"]);
    expect(await readFile(finder)).toEqual(finderStoreFixture());
  },
);
test("one of several albums removes only its empty folder, then the final album removes their empty artist", async () => {
  const a = await add("a"),
    b = await add("b", true, "Other album");
  const artist = path.dirname(path.dirname(a.path));
  await remove([a]);
  await missing(path.dirname(a.path));
  expect(await readdir(artist)).toEqual(["Other album"]);
  expect((await stat(b.path)).isFile()).toBe(true);
  await remove([b]);
  await missing(artist);
  expect((await stat(media)).isDirectory()).toBe(true);
});
test.each(["unknown.txt", "unknown subdirectory"])(
  "artist content %s stops upward cleanup after its album is removed",
  async (entry) => {
    const a = await add("a");
    const album = path.dirname(a.path),
      artist = path.dirname(album);
    const unknown = path.join(artist, entry);
    if (entry === "unknown subdirectory") await mkdir(unknown);
    else await writeFile(unknown, "user content");
    const result = await remove([a]);
    expect(result.removedIds).toEqual([a.id]);
    await missing(album);
    expect(await readdir(artist)).toEqual([entry]);
    expect((await stat(media)).isDirectory()).toBe(true);
  },
);
test("cleanup never climbs above a registered nested root even if it disappears during Trash", async () => {
  const a = await add("a");
  const album = path.dirname(a.path),
    artist = path.dirname(album);
  await l.chooseMediaRoot(album);
  await l.chooseMediaRoot(media);
  const result = await remove([a], async (file) => {
    await trash(file);
    await rename(album, path.join(root, "Parked nested root"));
  });
  expect(result.removedIds).toEqual([a.id]);
  expect(result.failures).toEqual([]);
  expect(await readdir(artist)).toEqual([]);
});
test.each(["external", "inside Media"])(
  "reference-only deletion never cleans an empty %s directory",
  async (location) => {
    const ref = await add("reference", false);
    const directory = path.join(
      location === "external" ? root : media,
      "Reference artist",
      "Reference album",
    );
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, ".DS_Store"), finderStoreFixture());
    // Simulate an already missing reference without moving or modifying its source.
    l.db
      .prepare("UPDATE tracks SET path=? WHERE id=?")
      .run(path.join(directory, "missing.wav"), ref.id);
    const adapter = vi.fn(trash);
    const result = await remove(l.albumTracks(ref.albumId), adapter);
    expect(result.removedIds).toEqual([ref.id]);
    expect(adapter).not.toHaveBeenCalled();
    expect(await readdir(directory)).toEqual([".DS_Store"]);
  },
);
test.each(["unknown.txt", ".DS_Store", "unknown subdirectory"])(
  "real filesystem content %s prevents album directory removal",
  async (entry) => {
    const a = await add("a");
    const album = path.dirname(a.path),
      unknown = path.join(album, entry);
    if (entry === "unknown subdirectory") await mkdir(unknown);
    else await writeFile(unknown, "user content");
    const result = await remove([a]);
    expect(result.removedIds).toEqual([a.id]);
    expect(result.cleanupWarnings).toBeUndefined();
    expect(await readdir(album)).toEqual([entry]);
  },
);
test("a file arriving during Trash keeps a newly non-empty album directory", async () => {
  const a = await add("a");
  const album = path.dirname(a.path);
  const result = await remove([a], async (file) => {
    await trash(file);
    await writeFile(path.join(album, "arrived.txt"), "do not remove");
  });
  expect(result.failures).toEqual([]);
  expect(await readdir(album)).toEqual(["arrived.txt"]);
});
test("partial receipt failure preserves the non-empty album and unremoved copy", async () => {
  const a = await add("a"),
    b = await add("b");
  l.db
    .prepare("UPDATE managed_imports SET status='ready' WHERE trackId=?")
    .run(b.id);
  const result = await remove(l.albumTracks(a.albumId));
  expect(result.removedIds).toEqual([a.id]);
  expect(result.failures.map((f) => f.id)).toEqual([b.id]);
  expect(await readdir(path.dirname(a.path))).toEqual([path.basename(b.path)]);
});
test.each([false, true])(
  "disc cleanup is bounded, including partial success=%s",
  async (partial) => {
    const a = await relocate(await add("a"), "Artist/Album/CD1/a.wav");
    const b = await relocate(await add("b"), "Artist/Album/Disc 2/b.wav");
    if (partial)
      l.db
        .prepare("UPDATE managed_imports SET status='ready' WHERE trackId=?")
        .run(b.id);
    const result = await remove(l.albumTracks(a.albumId));
    expect(result.removedIds).toContain(a.id);
    await missing(path.dirname(a.path));
    if (partial) {
      expect((await stat(b.path)).isFile()).toBe(true);
      expect(await readdir(path.join(media, "Artist/Album"))).toEqual([
        "Disc 2",
      ]);
    } else {
      await missing(path.dirname(b.path));
      await missing(path.join(media, "Artist/Album"));
      await missing(path.join(media, "Artist"));
    }
    if (partial)
      expect((await stat(path.join(media, "Artist"))).isDirectory()).toBe(true);
    expect((await stat(media)).isDirectory()).toBe(true);
  },
);
test("an unknown empty disc subdirectory is never adopted or recursively removed", async () => {
  const a = await relocate(await add("a"), "Artist/Album/CD1/a.wav");
  const unknown = path.join(media, "Artist/Album/CD9");
  await mkdir(unknown);
  await remove([a]);
  await missing(path.dirname(a.path));
  expect(await readdir(path.join(media, "Artist/Album"))).toEqual(["CD9"]);
});
test.each(["flat", "artist", "unrecognized nesting"])(
  "%s managed locations clean only their actual empty chain, keeping the root",
  async (layout) => {
    if (layout === "flat") l.saveMediaSettings({ keepOrganized: false });
    let a = await add("a");
    if (layout === "flat") {
      const staging = path.join(media, ".rio-imports");
      expect(await readdir(staging)).toEqual([]);
      await rmdir(staging); // Test setup: make the root genuinely empty after Trash.
    }
    if (layout === "artist") a = await relocate(a, "CD1/a.wav");
    if (layout === "unrecognized nesting")
      a = await relocate(a, "Artist/Album/Extras/a.wav");
    await remove([a]);
    if (layout === "flat") expect(await readdir(media)).toEqual([]);
    else await missing(path.dirname(a.path));
    expect((await stat(media)).isDirectory()).toBe(true);
  },
);
test("a post-Trash database failure supplies no cleanup authority and retains its recoverable identity", async () => {
  const a = await add("a");
  l.db.exec(
    "CREATE TRIGGER fail_cleanup BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT,'injected database failure'); END;",
  );
  const result = await remove([a]);
  expect(result.removedIds).toEqual([]);
  expect(result.failures[0]).toMatchObject({ id: a.id, fileTrashed: true });
  expect(l.tracks(a.id)[0].missing).toBe(true);
  expect(await readdir(path.dirname(a.path))).toEqual([]);
});
test("a cleanup-boundary lookup failure cannot turn committed track deletion into a failure", async () => {
  const a = await add("a");
  const result = await remove([a], async (file) => {
    await trash(file);
    l.db.exec("DROP TABLE media_root_locations"); // Fault only in this disposable database.
  });
  expect(result.removedIds).toEqual([a.id]);
  expect(result.failures).toEqual([]);
  expect(result.cleanupWarnings?.[0].message).toContain(
    "boundaries could not be checked",
  );
  expect(l.tracks(a.id)).toEqual([]);
  expect(await readdir(path.dirname(a.path))).toEqual([]);
});
test.each([
  "album symlink",
  "artist symlink",
  "root symlink",
  "replacement directory",
])(
  "%s after Trash refuses cleanup without falsifying successful deletion",
  async (attack) => {
    const a = await add("a");
    const album = path.dirname(a.path);
    const outside = path.join(root, "External");
    await mkdir(outside);
    const result = await remove([a], async (file) => {
      await trash(file);
      const swapped =
        attack === "root symlink"
          ? media
          : attack === "artist symlink"
            ? path.dirname(album)
            : album;
      await rename(swapped, `${swapped}-parked`);
      if (attack === "replacement directory") await mkdir(swapped);
      else {
        if (attack === "artist symlink")
          await mkdir(path.join(outside, path.basename(album)));
        if (attack === "root symlink")
          await mkdir(path.join(outside, "Artist/Album"), { recursive: true });
        await symlink(outside, swapped, "dir");
      }
    });
    expect(result.removedIds).toEqual([a.id]);
    expect(result.failures).toEqual([]);
    expect(result.cleanupWarnings).toHaveLength(
      attack === "artist symlink" || attack === "root symlink" ? 2 : 1,
    );
    expect(
      result.cleanupWarnings!.some((warning) => warning.path === album),
    ).toBe(true);
    expect((await stat(album)).isDirectory()).toBe(true);
    expect((await stat(outside)).isDirectory()).toBe(true);
    expect(l.tracks(a.id)).toEqual([]);
  },
);
test("cleanup planning and execution reject traversal, sibling prefixes, root and malformed lineage", async () => {
  const a = await add("a");
  const authority = l.db
    .prepare(
      "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
    )
    .get(a.mediaRootId!) as unknown as MediaRoot;
  const [plan] = await planManagedAlbumCleanup(
    authority,
    a.path,
    a.mediaRelativePath!,
  );
  for (const relative of [
    "",
    ".",
    "Artist//Album",
    "..",
    "../Media-other/Album",
    "/external/Album",
    "Artist/../Album",
    "Artist\\Album/Folder",
  ])
    await expect(
      removeEmptyManagedAlbumDirectory({ ...plan, relative }),
    ).rejects.toThrow("boundary");
  await expect(
    planManagedAlbumCleanup(
      authority,
      path.join(root, "Media-other/Album/a.wav"),
      "../Media-other/Album/a.wav",
    ),
  ).rejects.toThrow("Unsafe");
  expect((await stat(a.path)).isFile()).toBe(true);
});
