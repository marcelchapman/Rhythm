import { afterEach, beforeEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  symlink,
  link,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Library } from "../src/domain/library";
import { parseM3U, serializeM3U } from "../src/domain/m3u";
import {
  importPlaylistFile,
  exportPlaylistFile,
} from "../src/domain/playlist-files";
import {
  TRACK_COLUMN_IDS,
  normalizeColumnOrder,
  normalizeViewPreferences,
  moveTrackColumn,
} from "../src/shared/preferences";
import { ViewPreferenceStore } from "../src/domain/view-preferences";
import { defaultState } from "../src/shared/types";
import { wavFixture } from "./fixtures";
let root: string, library: Library;
const bytes = (text: string) => Buffer.from(text, "utf8");
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rio-interchange-"));
  library = await Library.open(path.join(root, "Library"));
});
afterEach(async () => {
  library.close();
  await rm(root, { recursive: true, force: true });
});

test("M3U accepts BOM, CRLF, comments, relative and absolute paths, Unicode/spaces and local file URLs", () => {
  const file = path.join(root, "mix.m3u8");
  const absolute = path.join(root, "音楽 Café.wav");
  const result = parseM3U(
    bytes(
      `\uFEFF#EXTM3U\r\n#EXTINF:10,Title\r\n./Audio/Hello world.wav\r\n${absolute}\r\n#UNKNOWN:anything\r\n${pathToFileURL(absolute)}\r\n\r\n`,
    ),
    file,
  );
  expect(result.issueCount).toBe(0);
  expect(result.entries.map((e) => e.path)).toEqual([
    path.join(root, "Audio", "Hello world.wav"),
    absolute,
    absolute,
  ]);
});
test("M3U rejects malformed UTF-8 and bounds untrusted input", () => {
  expect(() => parseM3U(new Uint8Array([0xff, 0xfe]), "/mix.m3u")).toThrow(
    "UTF-8",
  );
  expect(() =>
    parseM3U(new Uint8Array(10 * 1024 * 1024 + 1), "/mix.m3u8"),
  ).toThrow("10 MB");
  expect(() =>
    parseM3U(bytes("song.wav\n".repeat(50001)), "/mix.m3u8"),
  ).toThrow("50,000");
});
test("URLs and NUL paths are reported without becoming file or network requests", () => {
  const result = parseM3U(
    bytes(
      "https://example.invalid/song.mp3\nfile://remotehost/song.wav\ninvalid\0.wav\n./valid.wav\n",
    ),
    path.join(root, "mix.m3u"),
  );
  expect(result.issueCount).toBe(3);
  expect(result.entries).toHaveLength(1);
});
test("serialization keeps Unicode/spaces, escapes leading comment characters with ./, uses local relative paths and external absolute paths", () => {
  const file = path.join(root, "Portable", "mix.m3u8");
  const tracks = [
    {
      path: path.join(root, "Portable", "# 音楽 café.wav"),
      artist: "Å\nrtist",
      title: "Title\rname",
      duration: 3.8,
    },
    {
      path: path.join(root, "Other", "file.wav"),
      artist: "B",
      title: "Two",
      duration: 2,
    },
  ];
  const text = serializeM3U(tracks, file);
  expect(text).toContain(
    "#EXTM3U\n#EXTINF:3,Å rtist - Title name\n./# 音楽 café.wav\n",
  );
  expect(text).toContain(tracks[1].path);
  expect(parseM3U(bytes(text), file).entries.map((e) => e.path)).toEqual(
    tracks.map((t) => t.path),
  );
  expect(() =>
    serializeM3U(
      [{ ...tracks[0], path: path.join(root, "bad\nname.wav") }],
      file,
    ),
  ).toThrow("safely");
});
test("imports existing and new audio in playlist order, reports missing/invalid entries and avoids duplicate membership", async () => {
  const audio = path.join(root, "Audio files");
  await mkdir(audio);
  const a = path.join(audio, "音楽 Café.wav"),
    b = path.join(audio, "Second song.wav");
  const aBytes = wavFixture({ title: "First", seconds: 3 }),
    bBytes = wavFixture({ title: "Second", seconds: 3 });
  await writeFile(a, aBytes);
  await writeFile(b, bBytes);
  await library.scan([a]);
  const before = await stat(a);
  const list = path.join(root, "Daily mix.m3u");
  const listBytes = bytes(
    `#EXTM3U\n${b}\n#EXTINF:3,First\n./Audio files/音楽 Café.wav\n${b}\n./missing.wav\nhttps://example.invalid/music.mp3\n`,
  );
  await writeFile(list, listBytes);
  const result = await importPlaylistFile(library, list);
  expect(result.count).toBe(2);
  expect(result.added).toBe(1);
  expect(result.issueCount).toBe(2);
  expect(result.playlist.name).toBe("Daily mix");
  expect(
    result.playlist.trackIds.map(
      (id) => library.tracks().find((t) => t.id === id)!.title,
    ),
  ).toEqual(["Second", "First"]);
  const again = await importPlaylistFile(library, list);
  expect(again.playlist.name).toBe("Daily mix (2)");
  expect(again.added).toBe(0);
  expect(await readFile(a)).toEqual(aBytes);
  expect(await readFile(b)).toEqual(bBytes);
  expect((await stat(a)).mtimeMs).toBe(before.mtimeMs);
  expect(await readFile(list)).toEqual(listBytes);
  library.close();
  library = await Library.open(path.join(root, "Library"));
  expect(
    library.playlists().find((p) => p.id === result.playlist.id)!.trackIds,
  ).toEqual(result.playlist.trackIds);
});
test("export/import round trip preserves order/membership and can overwrite an existing playlist atomically", async () => {
  const a = path.join(root, "01.wav"),
    b = path.join(root, "02.wav");
  await writeFile(a, wavFixture({ title: "A" }));
  await writeFile(b, wavFixture({ title: "B" }));
  await library.scan([a, b]);
  const ids = library
    .tracks()
    .map((t) => t.id)
    .reverse();
  const playlist = library.createPlaylist("Round trip", ids);
  const output = path.join(root, "Round trip.m3u8");
  await writeFile(output, "old playlist");
  expect((await exportPlaylistFile(library, playlist.id, output)).count).toBe(
    2,
  );
  expect((await importPlaylistFile(library, output)).playlist.trackIds).toEqual(
    ids,
  );
  expect((await readFile(output, "utf8")).startsWith("#EXTM3U\n")).toBe(true);
});
test("invalid UTF-8 leaves library and playlists untouched; empty/fully missing playlists are valid with reports", async () => {
  const file = path.join(root, "Empty.m3u8");
  await writeFile(file, new Uint8Array([0xff]));
  await expect(importPlaylistFile(library, file)).rejects.toThrow("UTF-8");
  expect(library.playlists()).toHaveLength(0);
  expect(library.tracks()).toHaveLength(0);
  await writeFile(file, "#EXTM3U\nmissing.wav\n");
  const result = await importPlaylistFile(library, file);
  expect(result.count).toBe(0);
  expect(result.issueCount).toBe(1);
  expect(
    (
      await exportPlaylistFile(
        library,
        result.playlist.id,
        path.join(root, "empty-export.m3u8"),
      )
    ).count,
  ).toBe(0);
});
test("export refuses audio destinations and symbolic/hard links to source audio", async () => {
  const file = path.join(root, "source.wav"),
    original = wavFixture();
  await writeFile(file, original);
  await library.scan([file]);
  const playlist = library.createPlaylist(
    "Safe",
    library.tracks().map((t) => t.id),
  );
  await expect(exportPlaylistFile(library, playlist.id, file)).rejects.toThrow(
    ".m3u8",
  );
  const symbolic = path.join(root, "alias.m3u8");
  await symlink(file, symbolic);
  await expect(
    exportPlaylistFile(library, playlist.id, symbolic),
  ).rejects.toThrow("symbolic");
  const hard = path.join(root, "hard.m3u8");
  await link(file, hard);
  await expect(exportPlaylistFile(library, playlist.id, hard)).rejects.toThrow(
    "source audio",
  );
  expect(await readFile(file)).toEqual(original);
});
test("Songs preference defaults, normalizes stale/duplicate keys and moves all columns without changing sorting data", () => {
  expect(normalizeViewPreferences().trackList.columns.order).toEqual(
    TRACK_COLUMN_IDS,
  );
  expect(
    normalizeColumnOrder(["bpm", "bpm", "unknown", "title"]).slice(0, 3),
  ).toEqual(["bpm", "title", "duration"]);
  const moved = moveTrackColumn([...TRACK_COLUMN_IDS], "comments", "artist");
  expect(moved.slice(0, 4)).toEqual([
    "title",
    "duration",
    "comments",
    "artist",
  ]);
  expect(moveTrackColumn(moved, "title", "album", true).indexOf("title")).toBe(
    moved.indexOf("album"),
  );
  expect(new Set(moved).size).toBe(TRACK_COLUMN_IDS.length);
});
test("Songs preferences persist independently of playback and tolerate missing/corrupt stored settings", async () => {
  const initial = library.state();
  const order = moveTrackColumn([...TRACK_COLUMN_IDS], "bpm", "title");
  library.db
    .prepare("INSERT INTO settings VALUES('views',?)")
    .run(JSON.stringify({ version: 1, songs: { columns: { order } } }));
  const store = await ViewPreferenceStore.open(path.join(root, "AppData"));
  await store.migrateLegacy(library.legacyViewPreferences());
  library.saveState({ ...defaultState(), volume: 0.3 });
  library.close();
  library = await Library.open(path.join(root, "Library"));
  const restored = await ViewPreferenceStore.open(path.join(root, "AppData"));
  expect(restored.get().trackList.columns.order).toEqual(order);
  expect(library.state().volume).toBe(0.3);
  expect(initial.volume).toBe(0.7);
  library.db
    .prepare("UPDATE settings SET value=? WHERE key='views'")
    .run("not json");
  expect(library.legacyViewPreferences()).toBeUndefined();
  expect(restored.get().trackList.columns.order).toEqual(order);
  expect(() => library.createPlaylist("Invalid", ["unknown"])).toThrow();
  expect(library.playlists()).toHaveLength(0);
});
