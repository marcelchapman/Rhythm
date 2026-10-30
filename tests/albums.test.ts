import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import { defaultState } from "../src/shared/types";
import { wavFixture } from "./fixtures";

let root: string, l: Library;
const originals = new Map<string, { bytes: Buffer; mtime: number }>();
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rio-albums-")));
  l = await Library.open(path.join(root, "Library"));
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
async function add(
  folder: string,
  name: string,
  tags: Parameters<typeof wavFixture>[0] = {},
  managed = false,
) {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.wav`);
  await writeFile(file, wavFixture({ title: name, ...tags }));
  originals.set(file, {
    bytes: await readFile(file),
    mtime: (await stat(file)).mtimeMs,
  });
  l.saveMediaSettings({ copyOnAdd: managed });
  expect((await l.add([file])).errors).toEqual([]);
  return l
    .tracks()
    .find(
      (track) => track.path === file || track.title === (tags.title ?? name),
    )!;
}
test("exact identity separates same titles by album artist and source edition, including duplicate track titles", async () => {
  const a = await add("Edition A", "a", {
    album: "Shared",
    albumArtist: "One",
    title: "Duplicate",
  });
  await add("Edition A", "b", {
    album: "Shared",
    albumArtist: "One",
    title: "Duplicate",
  });
  await add("Edition A", "c", { album: "Shared", albumArtist: "Two" });
  await add("Edition B", "d", { album: "Shared", albumArtist: "One" });
  expect(new Set(l.tracks().map((t) => t.albumId)).size).toBe(3);
  expect(l.albumTracks(a.albumId)).toHaveLength(2);
  const trash = vi.fn(async () => {});
  expect(
    (await l.deleteTracks(l.albumTracks(a.albumId), trash)).removedIds,
  ).toHaveLength(2);
  expect(l.tracks()).toHaveLength(2);
  expect(trash).not.toHaveBeenCalled();
});
test("multi-disc compilation with different performers keeps one identity and reports both physical directories", async () => {
  const a = await add("Set/CD1", "a", {
    album: "Set",
    artist: "One",
    compilation: true,
    disc: "1/2",
  });
  const b = await add("Set/Disc 2", "b", {
    album: "Set",
    artist: "Two",
    compilation: true,
    disc: "2/2",
  });
  expect(a.albumArtist).toBe("Various Artists");
  expect(b.albumId).toBe(a.albumId);
  expect(l.albumTracks(a.albumId).map((t) => t.disc)).toEqual([1, 2]);
  const locations = await l.albumLocations(a.albumId);
  expect(locations.folders).toEqual([
    { path: path.join(root, "Set/CD1"), count: 1 },
    { path: path.join(root, "Set/Disc 2"), count: 1 },
  ]);
});
test("Album Artist groups varying performers; missing metadata uses existing artist and directory fallbacks", async () => {
  const a = await add("Same", "a", { albumArtist: "Owner", artist: "Guest A" });
  const b = await add("Same", "b", { albumArtist: "Owner", artist: "Guest B" });
  expect(a.albumId).toBe(b.albumId);
  const unknown = await add("Untagged", "u", {
    artist: "",
    album: "",
    title: "",
  });
  const other = await add("Elsewhere", "v", {
    artist: "",
    album: "",
    title: "",
  });
  expect(unknown.albumArtist).toBe("Unknown artist");
  expect(unknown.album).toBe("Untagged");
  expect(other.albumId).not.toBe(unknown.albumId);
});
test("referenced locations reflect real files, not cached missing flags; missing paths never become available folders", async () => {
  const a = await add("References", "a");
  const b = await add("References", "b");
  l.db.prepare("UPDATE tracks SET missing=1 WHERE id=?").run(a.id);
  expect((await l.albumLocations(a.albumId)).folders).toEqual([
    { path: path.dirname(a.path), count: 2 },
  ]);
  l.db
    .prepare("UPDATE tracks SET path=? WHERE id=?")
    .run(path.join(root, "Missing/b.wav"), b.id);
  const partial = await l.albumLocations(a.albumId);
  expect(partial.folders).toEqual([{ path: path.dirname(a.path), count: 1 }]);
  expect(partial.missing).toEqual([b.id]);
  l.db
    .prepare("UPDATE tracks SET path=? WHERE id=?")
    .run(path.join(root, "Missing/a.wav"), a.id);
  expect((await l.albumLocations(a.albumId)).folders).toEqual([]);
  expect((await l.albumLocations(a.albumId)).missing).toHaveLength(2);
});
test("managed and mixed ownership use playback locations and the same guarded deletion worker", async () => {
  const media = path.join(root, "Media");
  await mkdir(media);
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ keepOrganized: false });
  const a = await add("Originals", "a", {}, true);
  const b = await add("Originals", "b", {}, true);
  expect(a.path.startsWith(`${media}/`)).toBe(true);
  expect((await l.albumLocations(a.albumId)).folders).toEqual([
    { path: media, count: 2 },
  ]);
  const ref = await add("Media", "reference");
  expect(ref.albumId).toBe(a.albumId);
  const playlist = l.createPlaylist("All", [a.id, ref.id, b.id]);
  l.favorite(a.id);
  l.saveState({
    ...defaultState(),
    queue: [a.id, ref.id, b.id],
    currentId: b.id,
    position: 1,
  });
  const trash = vi.fn(async (file: string) => {
    expect([a.path, b.path]).toContain(file);
    await rename(file, `${file}.trashed`);
  });
  const result = await l.deleteTracks(l.albumTracks(a.albumId), trash);
  expect(new Set(result.removedIds)).toEqual(new Set([a.id, b.id, ref.id]));
  expect(result.failures).toEqual([]);
  expect(trash).toHaveBeenCalledTimes(2);
  expect(l.playlists().find((p) => p.id === playlist.id)!.trackIds).toEqual([]);
  expect(l.state().queue).toEqual([]);
  expect(l.state().currentId).toBeNull();
  l.close();
  l = await Library.open(path.join(root, "Library"));
  expect(l.tracks()).toEqual([]);
  for (const table of ["track_locations", "managed_imports", "playlist_tracks"])
    expect(l.db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
});
test("an album cannot confer managed authority; invalid receipts retain their identities while valid members finish", async () => {
  await mkdir(path.join(root, "Media"));
  await l.chooseMediaRoot(path.join(root, "Media"));
  const a = await add("Originals", "a", {}, true);
  const b = await add("Originals", "b", {}, true);
  l.db
    .prepare("UPDATE managed_imports SET status='ready' WHERE trackId=?")
    .run(a.id);
  const trash = vi.fn(async (file: string) => {
    await rename(file, `${file}.trashed`);
  });
  const result = await l.deleteTracks(l.albumTracks(a.albumId), trash);
  expect(result.removedIds).toEqual([b.id]);
  expect(result.failures.map((f) => [f.id, f.fileTrashed])).toEqual([
    [a.id, false],
  ]);
  expect(trash).toHaveBeenCalledExactlyOnceWith(b.path);
  expect((await stat(a.path)).isFile()).toBe(true);
  expect(l.albumTracks(a.albumId).map((t) => t.id)).toEqual([a.id]);
});
test.each(["", "invalid", "f".repeat(64)])(
  "invalid or absent album identity %j cannot broaden to all tracks",
  async (id) => {
    await add("References", "a");
    expect(() => l.albumTracks(id)).toThrow();
    await expect(l.albumLocations(id)).rejects.toThrow();
    expect(l.tracks()).toHaveLength(1);
  },
);
