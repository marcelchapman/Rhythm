import { beforeEach, afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Library } from "../src/domain/library";
import { defaultState } from "../src/shared/types";
import { wavFixture } from "./fixtures";
import { sortTracks, dragTrackIds } from "../src/renderer/track-columns";
let root: string;
let l: Library | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rio-features-"));
});
afterEach(async () => {
  l?.close();
  l = undefined;
  await rm(root, { recursive: true, force: true });
});
test("reads real BPM, comments, bitrate and codec tags without changing source", async () => {
  l = await Library.open(path.join(root, "Library"));
  const file = path.join(root, "tagged.wav");
  const bytes = wavFixture({ bpm: 123, comments: "Original recording notes" });
  await writeFile(file, bytes);
  const before = await stat(file);
  expect((await l.scan([file])).added).toBe(1);
  const t = l.tracks()[0];
  expect(t.bpm).toBe(123);
  expect(t.comments).toContain("Original recording notes");
  expect(t.bitRate).toBeGreaterThan(0);
  expect(t.codec).toBeTruthy();
  expect(await readFile(file)).toEqual(bytes);
  expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
});
test("migrates a version-one library without losing playlists, state, favourites or identity", async () => {
  const folder = path.join(root, "Library");
  l = await Library.open(folder);
  const file = path.join(root, "old.wav");
  const bytes = wavFixture({ bpm: 110, comments: "Existing track" });
  await writeFile(file, bytes);
  await l.scan([file]);
  const track = l.tracks()[0];
  l.favorite(track.id);
  const playlist = l.createPlaylist("Existing mix");
  l.addToPlaylist(playlist.id, [track.id]);
  l.saveState({
    ...defaultState(),
    currentId: track.id,
    queue: [track.id],
    position: 1,
  });
  // Reconstruct the exact prior schema, not a new empty library pretending to be old.
  l.db.exec(
    "DROP TABLE managed_imports; DROP TABLE track_locations; DROP TABLE media_root_locations; DROP TABLE media_roots;",
  );
  for (const column of [
    "bpm",
    "comments",
    "bitRate",
    "codec",
    "metadataVersion",
  ])
    l.db.exec(`ALTER TABLE tracks DROP COLUMN ${column}`);
  l.db.exec("PRAGMA user_version=1");
  l.close();
  l = await Library.open(folder);
  expect(l.db.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
  expect(l.tracks()[0]).toMatchObject({
    id: track.id,
    addedAt: track.addedAt,
    favorite: true,
    bpm: null,
    comments: "",
  });
  expect(l.playlists()[0].trackIds).toEqual([track.id]);
  expect(l.state().position).toBe(1);
  // Metadata version invalidation backfills even unchanged audio files.
  expect((await l.scan(l.roots())).updated).toBe(1);
  expect(l.tracks()[0].bpm).toBe(110);
  expect(l.tracks()[0].favorite).toBe(true);
  expect((await l.scan(l.roots())).unchanged).toBe(1);
  expect(await readFile(file)).toEqual(bytes);
  l.close();
  l = await Library.open(folder);
  expect(l.tracks()[0].bpm).toBe(110);
});
test("atomic playlist additions retain order, reject stale/invalid IDs, deduplicate and persist", async () => {
  l = await Library.open(path.join(root, "Library"));
  for (const name of ["a", "b", "c"])
    await writeFile(
      path.join(root, `${name}.wav`),
      wavFixture({ title: name }),
    );
  await l.scan([root]);
  const [a, b, c] = l.tracks().map((t) => t.id);
  const p = l.createPlaylist("Mix");
  l.addToPlaylist(p.id, [a]);
  expect(() => l!.addToPlaylist(p.id, [b, "invalid"])).toThrow();
  expect(l.playlists()[0].trackIds).toEqual([a]);
  l.addToPlaylist(p.id, [a, b, a]);
  l.addToPlaylist(p.id, [b, c]);
  expect(l.playlists()[0].trackIds).toEqual([a, b, c]);
  expect(() => l!.addToPlaylist(p.id, [a, "invalid"])).toThrow();
  expect(l.playlists()[0].trackIds).toEqual([a, b, c]);
  expect(() => l!.addToPlaylist("deleted", [a])).toThrow("no longer exists");
  l.close();
  l = await Library.open(path.join(root, "Library"));
  expect(l.playlists()[0].trackIds).toEqual([a, b, c]);
});
test("mixed file and folder drop imports are recursive, deduplicated and read only", async () => {
  l = await Library.open(path.join(root, "Library"));
  const folder = path.join(root, "Drop folder");
  await mkdir(folder);
  await mkdir(path.join(folder, "Nested"));
  const file = path.join(folder, "Nested", "song.wav");
  const bytes = wavFixture();
  await writeFile(file, bytes);
  await writeFile(path.join(folder, "notes.txt"), "not music");
  expect((await l.scan([file, folder])).added).toBe(1);
  expect(l.tracks()).toHaveLength(1);
  expect(l.roots()).toContain(await realpath(folder));
  expect((await l.scan(l.roots())).unchanged).toBe(1);
  expect(await readFile(file)).toEqual(bytes);
  const invalid = await l.scan([path.join(root, "missing")]);
  expect(invalid.errors).toHaveLength(1);
  expect(l.tracks()).toHaveLength(1);
});
test("column sorting is numeric, stable, and puts absent metadata last in either direction", async () => {
  l = await Library.open(path.join(root, "Library"));
  for (const [name, bpm] of [
    ["Song 10", 130],
    ["Song 2", 90],
    ["Unknown", undefined],
  ] as const) {
    const f = path.join(root, `${name}.wav`);
    await writeFile(f, wavFixture({ title: name, bpm }));
    await l.scan([f]);
  }
  const tracks = l.tracks();
  expect(sortTracks(tracks, "bpm", 1).map((t) => t.bpm)).toEqual([
    90,
    130,
    null,
  ]);
  expect(sortTracks(tracks, "bpm", -1).map((t) => t.bpm)).toEqual([
    130,
    90,
    null,
  ]);
  expect(sortTracks(tracks, "title", 1)[0].title).toBe("Song 2");
  expect(tracks.map((t) => t.title)).toEqual(["Song 10", "Song 2", "Unknown"]);
  const large = Array.from({ length: 20000 }, (_, i) => ({
    ...tracks[0],
    id: String(i),
    title: `Song ${20000 - i}`,
  }));
  expect(sortTracks(large, "title", 1)[0].title).toBe("Song 1");
});
test("internal drag IDs reject malformed and non-library payloads", () => {
  const id = "a".repeat(64);
  expect(dragTrackIds(JSON.stringify([id, id]))).toEqual([id]);
  expect(dragTrackIds("not JSON")).toEqual([]);
  expect(dragTrackIds('["/tmp/music.wav"]')).toEqual([]);
});
