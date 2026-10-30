import { beforeEach, afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  readdir,
  symlink,
  rename,
  lstat,
} from "node:fs/promises";
import { rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { Library } from "../src/domain/library";
import { mediaDestination, mediaName, inside } from "../src/domain/media-plan";
import { fileDigest } from "../src/domain/managed-copy";
import {
  importPlaylistFile,
  exportPlaylistFile,
} from "../src/domain/playlist-files";
import { wavFixture } from "./fixtures";
import { defaultState } from "../src/shared/types";
let root: string, music: string, media: string, dbFolder: string, l: Library;
const originals = new Map<string, { hash: string; mtime: number }>();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {
  originals.clear();
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rio-managed-")));
  music = path.join(root, "Originals");
  media = path.join(root, "Rio Media");
  dbFolder = path.join(root, "Library");
  await mkdir(music);
  await mkdir(media);
  l = await Library.open(dbFolder);
});
afterEach(async () => {
  try {
    for (const [file, before] of originals) {
      expect(sha(await readFile(file))).toBe(before.hash);
      expect((await stat(file)).mtimeMs).toBe(before.mtime);
    }
  } finally {
    l?.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function source(
  name = "original.wav",
  options: Parameters<typeof wavFixture>[0] = {},
) {
  const file = path.join(music, name),
    bytes = wavFixture(options);
  await writeFile(file, bytes);
  originals.set(file, { hash: sha(bytes), mtime: (await stat(file)).mtimeMs });
  return file;
}
async function enable() {
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true });
}
test.each([
  [
    {
      albumArtist: "Massive Attack",
      artist: "Guest",
      album: "Mezzanine",
      title: "Angel",
      track: 1,
    },
    "Massive Attack/Mezzanine/01 Angel.flac",
  ],
  [
    {
      albumArtist: "Guest",
      compilation: true,
      album: "80's Disco Tracks",
      title: "I'll Be A Freak For You",
      track: 2,
    },
    "Various Artists/80's Disco Tracks/02 I'll Be A Freak For You.flac",
  ],
  [
    { artist: "Singer", title: "Song", disc: 1, discTotal: 2, track: 1 },
    "Singer/Unknown Album/1-01 Song.flac",
  ],
  [{ disc: 2, track: 9 }, "Unknown Artist/Unknown Album/2-09 Untitled.flac"],
  [{}, "Unknown Artist/Unknown Album/00 Untitled.flac"],
] as const)("pure planner: %j", (metadata, expected) => {
  const result = mediaDestination(media, metadata, ".FLAC", true);
  expect(result.relative).toBe(expected);
  expect(inside(media, result.path)).toBe(true);
  expect(mediaDestination(media, metadata, ".FLAC", true)).toEqual(result);
});
test("planner bounds unicode bytes, reserves device names, removes traversal/invalid characters, and supports flat collision names", () => {
  for (const name of [
    "../..",
    "..\\..\\evil",
    "CON",
    "LPT1.txt",
    'a:b?*|\0\n<>"',
    "\u202e/escaped",
    "音楽".repeat(100),
  ]) {
    const planned = mediaDestination(
      media,
      { albumArtist: name, album: name, title: name },
      ".wav",
      true,
    );
    expect(inside(media, planned.path)).toBe(true);
    for (const segment of planned.relative.split("/")) {
      expect(segment).not.toMatch(/[<>:"\\|?*\x00-\x1f\p{Cf}]/u);
      expect(Buffer.byteLength(segment)).toBeLessThan(130);
      expect(segment).not.toBe("..");
    }
  }
  expect(mediaName("CON", "unknown")).toBe("_CON");
  expect(
    mediaDestination(media, {}, ".wav", false, "original", 2).relative,
  ).toBe("original (2).wav");
  expect(() => mediaDestination(media, {}, "/../../bad", true)).toThrow();
  expect(() => mediaDestination(media, {}, ".wav", true, "x", 0)).toThrow();
});
test("default reference-only import and persistent settings require an explicitly selected safe folder", async () => {
  const file = await source();
  expect(l.mediaSettings()).toMatchObject({
    root: null,
    copyOnAdd: false,
    keepOrganized: true,
  });
  expect(() => l.saveMediaSettings({ copyOnAdd: true })).toThrow("Choose");
  await expect(l.chooseMediaRoot(root)).rejects.toThrow("separate");
  await expect(l.chooseMediaRoot(dbFolder)).rejects.toThrow("separate");
  expect((await l.add([file])).added).toBe(1);
  expect(l.tracks()[0]).toMatchObject({
    path: await realpath(file),
    locationKind: "referenced",
    mediaRootId: null,
    mediaRelativePath: null,
  });
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
  const settings = l.mediaSettings();
  l.close();
  l = await Library.open(dbFolder);
  expect(l.mediaSettings()).toEqual(settings);
  expect(await readdir(media)).toEqual([]);
});
test("copies and verifies managed imports, preserves original integrity and track/playlist identity on explicit conversion", async () => {
  const file = await source("source.wav", {
    albumArtist: "Massive Attack",
    album: "Mezzanine",
    title: "Angel",
    track: 1,
  });
  await l.add([file]);
  const before = l.tracks()[0];
  l.favorite(before.id);
  const playlist = l.createPlaylist("Existing", [before.id]);
  l.saveState({ ...defaultState(), currentId: before.id, queue: [before.id] });
  await enable();
  const result = await l.add([file]);
  expect(result.errors).toEqual([]);
  expect(result.copied).toBe(1);
  const t = l.tracks()[0];
  expect(l.tracks()).toHaveLength(1);
  expect(t.id).toBe(before.id);
  expect(t.favorite).toBe(true);
  expect(t).toMatchObject({
    locationKind: "managed",
    mediaRelativePath: "Massive Attack/Mezzanine/01 Angel.wav",
    albumArtist: "Massive Attack",
  });
  expect(t.path).toBe(path.join(await realpath(media), t.mediaRelativePath!));
  expect(await readFile(t.path)).toEqual(await readFile(file));
  expect(l.playlists().find((p) => p.id === playlist.id)!.trackIds).toEqual([
    before.id,
  ]);
  expect(l.state().currentId).toBe(before.id);
  expect(l.mediaSettings().pendingImports).toBe(0);
  expect(await readdir(path.join(media, ".rio-imports"))).toEqual([]);
  l.close();
  l = await Library.open(dbFolder);
  expect(l.tracks()[0]).toEqual(t);
  expect((await l.add([file, file])).unchanged).toBe(1);
  expect(l.tracks()).toHaveLength(1);
  expect((await l.scan(l.roots())).errors).toEqual([]);
  expect(l.tracks()).toHaveLength(1);
});
test("compilations and multidisc real tags use Various Artists; flat mode affects only subsequent additions", async () => {
  await enable();
  const a = await source("disc.wav", {
    albumArtist: "Guest",
    compilation: true,
    disc: "2/2",
    track: 3,
    title: "Song",
  });
  expect((await l.add([a])).errors).toEqual([]);
  const first = l.tracks()[0];
  expect(first.mediaRelativePath).toBe(
    "Various Artists/Test album/2-03 Song.wav",
  );
  expect(first.albumArtist).toBe("Various Artists");
  l.saveMediaSettings({ keepOrganized: false });
  const b = await source("plain source.wav", { title: "Other" });
  await l.add([b]);
  expect(l.tracks().find((t) => t.id === first.id)!.path).toBe(first.path);
  expect(l.tracks().find((t) => t.title === "Other")!.mediaRelativePath).toBe(
    "plain source.wav",
  );
});
test("existing destinations, identical metadata, and different source paths never overwrite audio", async () => {
  await enable();
  const a = await source("a.wav"),
    b = await source("b.wav", { comments: "Different bytes" });
  const destination = mediaDestination(
    media,
    { artist: "Test artist", album: "Test album", title: "Evening light" },
    ".wav",
    true,
  ).path;
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, "unrelated existing bytes");
  expect((await l.add([a, b])).errors).toEqual([]);
  expect(
    l
      .tracks()
      .map((t) => t.mediaRelativePath)
      .sort(),
  ).toEqual([
    "Test artist/Test album/00 Evening light (2).wav",
    "Test artist/Test album/00 Evening light (3).wav",
  ]);
  expect(await readFile(destination, "utf8")).toBe("unrelated existing bytes");
  expect((await l.add([a, b])).unchanged).toBe(2);
  expect(l.tracks()).toHaveLength(2);
});
test("already-managed inputs never copy themselves; unknown media-root files stay referenced", async () => {
  await enable();
  const a = await source();
  await l.add([a]);
  const t = l.tracks()[0];
  expect((await l.add([t.path, media])).errors).toEqual([]);
  expect(l.tracks()).toHaveLength(1);
  const unknown = path.join(media, "user-placed.wav");
  await writeFile(unknown, wavFixture({ title: "User placed" }));
  expect((await l.add([unknown])).added).toBe(1);
  expect(l.tracks().find((t) => t.title === "User placed")!.locationKind).toBe(
    "referenced",
  );
});
test("playlist interchange never copies unknown references and resolves previously copied originals to the managed ID", async () => {
  await enable();
  const a = await source("a.wav"),
    b = await source("b.wav", { title: "Referenced by playlist" });
  await l.add([a]);
  const id = l.tracks()[0].id,
    list = path.join(root, "Mix.m3u8");
  await writeFile(list, `${b}\n${a}\n`);
  const imported = await importPlaylistFile(l, list);
  expect(imported.issueCount).toBe(0);
  expect(imported.count).toBe(2);
  expect(
    l.tracks().find((t) => t.title === "Referenced by playlist")!.locationKind,
  ).toBe("referenced");
  expect(imported.playlist.trackIds[1]).toBe(id);
  const out = path.join(root, "Export.m3u8");
  await exportPlaylistFile(l, imported.playlist.id, out);
  expect((await importPlaylistFile(l, out)).playlist.trackIds).toEqual(
    imported.playlist.trackIds,
  );
});
test("publication followed by database failure stays recoverable across restart, without false ownership or duplicate output", async () => {
  await enable();
  const file = await source();
  l.db.exec(
    "CREATE TRIGGER fail_location BEFORE INSERT ON track_locations WHEN NEW.kind='managed' BEGIN SELECT RAISE(ABORT,'injected index failure'); END;",
  );
  const result = await l.add([file]);
  expect(result.added).toBe(0);
  expect(result.errors.join()).toContain("injected index failure");
  expect(l.tracks()).toEqual([]);
  expect(l.mediaSettings().pendingImports).toBe(1);
  const job = l.db.prepare("SELECT * FROM managed_imports").get()!;
  const published = path.join(media, String(job.relative));
  expect(await readFile(published)).toEqual(await readFile(file));
  expect((await l.scan([media])).added).toBe(0);
  expect(l.tracks()).toEqual([]);
  l.db.exec("DROP TRIGGER fail_location");
  l.close();
  l = await Library.open(dbFolder);
  expect((await l.add([file])).errors).toEqual([]);
  expect(l.tracks()).toHaveLength(1);
  expect(l.tracks()[0].path).toBe(published);
  expect(l.mediaSettings().pendingImports).toBe(0);
});
test("interrupted partial copies are never indexed and retry replaces only the verified private partial", async () => {
  await enable();
  const file = await source();
  const rootId = l.mediaSettings().root!.id;
  await mkdir(path.join(media, ".rio-imports"));
  const stage = `.rio-imports/${randomUUID()}.partial`;
  await writeFile(path.join(media, stage), "partial");
  const info = await lstat(path.join(media, stage));
  l.db
    .prepare("INSERT INTO managed_imports VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(
      randomUUID(),
      await realpath(file),
      await fileDigest(file),
      rootId,
      "Test artist/Test album/00 Evening light.wav",
      stage,
      String(info.dev),
      String(info.ino),
      "copying",
      "a".repeat(64),
    );
  expect((await l.scan([media])).added).toBe(0);
  expect(l.tracks()).toEqual([]);
  expect((await l.add([file])).errors).toEqual([]);
  expect(l.tracks()[0].locationKind).toBe("managed");
  expect(await readdir(path.join(media, ".rio-imports"))).toEqual([]);
});
test("symlink destinations and unusable staging paths fail safely; retry and root unavailability do not claim success", async () => {
  await enable();
  const file = await source(),
    outside = path.join(root, "Outside");
  await mkdir(outside);
  await symlink(outside, path.join(media, "Test artist"));
  expect((await l.add([file])).errors.join()).toContain("symbolic link");
  expect(l.tracks()).toEqual([]);
  expect(await readdir(outside)).toEqual([]);
  // Relocate the sacrificial symlink rather than modifying any source music.
  await rename(path.join(media, "Test artist"), path.join(root, "old-link"));
  expect((await l.add([file])).errors).toEqual([]);
  const second = await source("other.wav", { title: "Other" });
  await rename(media, `${media}-offline`);
  expect((await l.add([second])).errors).not.toHaveLength(0);
  expect(l.tracks()).toHaveLength(1);
  await rename(`${media}-offline`, media);
});
test("schema-2 migration preserves identity, favourites, player, playlists and legacy settings; new locations default to referenced", async () => {
  const file = await source();
  await l.scan([file]);
  const t = l.tracks()[0];
  l.favorite(t.id);
  l.createPlaylist("Existing", [t.id]);
  l.db
    .prepare("INSERT INTO settings VALUES('views',?)")
    .run(
      JSON.stringify({ songs: { columns: { order: ["artist", "title"] } } }),
    );
  l.saveState({ ...defaultState(), currentId: t.id, queue: [t.id] });
  l.db.exec(
    "DROP TABLE managed_imports; DROP TABLE track_locations; DROP TABLE media_root_locations; DROP TABLE media_roots; PRAGMA user_version=2;",
  );
  l.close();
  l = await Library.open(dbFolder);
  expect(l.db.prepare("PRAGMA user_version").get()!.user_version).toBe(3);
  expect(l.tracks()[0]).toMatchObject({
    id: t.id,
    favorite: true,
    locationKind: "referenced",
    mediaRootId: null,
  });
  expect(l.playlists()[0].trackIds).toEqual([t.id]);
  expect(l.state().currentId).toBe(t.id);
  expect(l.legacyViewPreferences()).toEqual({
    songs: { columns: { order: ["artist", "title"] } },
  });
  expect(l.mediaSettings().copyOnAdd).toBe(false);
  l.close();
  l = await Library.open(dbFolder);
  expect(l.tracks()).toHaveLength(1);
});
test("schema migration rolls back all new ownership tables when a later DDL step fails", async () => {
  const file = await source();
  await l.scan([file]);
  const id = l.tracks()[0].id;
  l.db.exec(
    "DROP TABLE managed_imports; DROP TABLE track_locations; DROP TABLE media_root_locations; DROP TABLE media_roots; CREATE TABLE managed_imports(note TEXT); PRAGMA user_version=2;",
  );
  await expect(Library.open(dbFolder)).rejects.toThrow("already exists");
  expect(l.db.prepare("PRAGMA user_version").get()!.user_version).toBe(2);
  expect(l.db.prepare("SELECT id FROM tracks").get()!.id).toBe(id);
  expect(
    l.db
      .prepare(
        "SELECT name FROM sqlite_master WHERE name IN ('media_roots','track_locations')",
      )
      .all(),
  ).toEqual([]);
});
test("unusable staging storage reports a copy failure without indexing and can retry", async () => {
  await enable();
  const file = await source(),
    marker = path.join(media, ".rio-imports");
  await writeFile(marker, "not a folder");
  expect((await l.add([file])).errors).not.toHaveLength(0);
  expect(l.tracks()).toEqual([]);
  await rename(marker, path.join(root, "staging-marker"));
  expect((await l.add([file])).errors).toEqual([]);
  expect(l.tracks()).toHaveLength(1);
});
test("changed managed copies are never overwritten by reimporting their original", async () => {
  await enable();
  const file = await source();
  await l.add([file]);
  const track = l.tracks()[0];
  const changed = wavFixture({ title: "Externally changed" });
  await writeFile(track.path, changed);
  const result = await l.add([file]);
  expect(result.errors.join()).toContain("changed");
  expect(await readFile(track.path)).toEqual(changed);
  expect(l.tracks()).toHaveLength(1);
});
test("media roots inside an imported tree do not recursively duplicate copies; concurrent operations are guarded", async () => {
  const nested = path.join(music, "Rio Media");
  await mkdir(nested);
  await l.chooseMediaRoot(nested);
  l.saveMediaSettings({ copyOnAdd: true });
  await source();
  const pending = l.add([music]);
  expect(() => l.saveMediaSettings({ copyOnAdd: false })).toThrow("Wait");
  await expect(l.add([music])).rejects.toThrow("already running");
  expect((await pending).errors).toEqual([]);
  expect((await l.add([music])).errors).toEqual([]);
  expect(l.tracks()).toHaveLength(1);
  expect(await readdir(path.dirname(l.tracks()[0].path))).toHaveLength(1);
});
test("case-insensitive folder aliases keep one canonical track and cannot index pending publications", async () => {
  await enable();
  await mkdir(path.join(media, "test artist", "test album"), {
    recursive: true,
  });
  const file = await source();
  l.db.exec(
    "CREATE TRIGGER hold_copy BEFORE INSERT ON track_locations WHEN NEW.kind='managed' BEGIN SELECT RAISE(ABORT,'hold publication'); END;",
  );
  await l.add([file]);
  expect(l.tracks()).toEqual([]);
  expect((await l.scan([media])).added).toBe(0);
  l.db.exec("DROP TRIGGER hold_copy");
  await l.add([file]);
  const track = l.tracks()[0];
  expect(track.path).toBe(await realpath(track.path));
  await l.scan([media]);
  expect(l.tracks()).toHaveLength(1);
  expect(l.tracks()[0].locationKind).toBe("managed");
});
test.each([true, false])(
  "missing staging link after interruption recovers safely (published=%s)",
  async (published) => {
    await enable();
    const file = await source();
    l.db.exec(
      "CREATE TRIGGER hold_copy BEFORE INSERT ON track_locations WHEN NEW.kind='managed' BEGIN SELECT RAISE(ABORT,'hold publication'); END;",
    );
    await l.add([file]);
    const job = l.db.prepare("SELECT * FROM managed_imports").get()!;
    await rm(path.join(media, String(job.stage)));
    if (!published)
      await rename(
        path.join(media, String(job.relative)),
        path.join(root, "parked-copy.wav"),
      );
    l.db.exec("DROP TRIGGER hold_copy");
    l.close();
    l = await Library.open(dbFolder);
    expect((await l.add([file])).errors).toEqual([]);
    expect(l.tracks()).toHaveLength(1);
    expect(await readFile(l.tracks()[0].path)).toEqual(await readFile(file));
    expect(l.mediaSettings().pendingImports).toBe(0);
  },
);
