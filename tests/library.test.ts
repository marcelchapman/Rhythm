import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  rename,
  symlink,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Library, normalizeState } from "../src/domain/library";
import { defaultState } from "../src/shared/types";
import { wavFixture } from "./fixtures";
import { mediaResponse } from "../src/main/media";
import { DatabaseSync } from "node:sqlite";

let root: string;
let music: string;
let library: Library | undefined;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "rhythm-unit-"));
  music = path.join(root, "Music with spaces ü");
  await mkdir(music);
});
afterEach(async () => {
  library?.close();
  library = undefined;
  await rm(root, { recursive: true, force: true });
});
const open = async () => {
  library = await Library.open(path.join(root, "Library"));
  return library;
};
describe("library ownership and persistence", () => {
  test("new libraries are empty and reopen without fixtures", async () => {
    const l = await open();
    expect(l.tracks()).toEqual([]);
    expect(l.roots()).toEqual([]);
    expect(l.state()).toEqual(defaultState());
    l.close();
    library = await Library.open(path.join(root, "Library"));
    expect(library.tracks()).toEqual([]);
  });
  test("rejects unrelated databases without modifying them", async () => {
    const folder = path.join(root, "Other");
    await mkdir(folder);
    const file = path.join(folder, "rhythm.sqlite");
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE unrelated (value TEXT)");
    db.close();
    const before = await readFile(file);
    await expect(Library.open(folder)).rejects.toThrow("not a Rhythm");
    expect(await readFile(file)).toEqual(before);
  });
  test("reads metadata, indexes once, preserves source bytes and timestamps", async () => {
    const l = await open();
    const file = path.join(music, "01 music ü.wav");
    const source = wavFixture();
    await writeFile(file, source);
    const before = await stat(file);
    expect((await l.scan([music])).added).toBe(1);
    const t = l.tracks()[0];
    expect(t.title).toBe("Evening light");
    expect(t.artist).toBe("Test artist");
    expect(t.genre).toBe("Ambient");
    expect(t.duration).toBe(2);
    expect((await l.scan([music, music])).unchanged).toBe(1);
    expect(l.tracks()).toHaveLength(1);
    expect(await readFile(file)).toEqual(source);
    expect((await stat(file)).mtimeMs).toBe(before.mtimeMs);
    l.favorite(t.id);
    const p = l.createPlaylist("Night listening");
    l.playlistTracks(p.id, [t.id, t.id]);
    l.saveState({
      ...defaultState(),
      currentId: t.id,
      queue: [t.id],
      position: 1.2,
      volume: 0.3,
    });
    const added = t.addedAt;
    await writeFile(file, wavFixture({ title: "Changed title", seconds: 3 }));
    expect((await l.scan([music])).updated).toBe(1);
    expect(l.tracks()[0].addedAt).toBe(added);
    expect(l.tracks()[0].favorite).toBe(true);
    l.close();
    library = await Library.open(path.join(root, "Library"));
    expect(library.tracks()[0].title).toBe("Changed title");
    expect(library.playlists()[0].trackIds).toEqual([t.id]);
    expect(library.state().position).toBe(1.2);
    expect(library.roots()).toEqual([
      await import("node:fs/promises").then((fs) => fs.realpath(music)),
    ]);
  });
  test("reports malformed files, skips symlink loops and unsupported files", async () => {
    const l = await open();
    await writeFile(path.join(music, "bad.mp3"), "not audio");
    await writeFile(path.join(music, "notes.txt"), "skip");
    await writeFile(path.join(music, "valid.WAV"), wavFixture());
    await symlink(music, path.join(music, "loop"));
    const result = await l.scan([music]);
    expect(result.added).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(l.tracks()).toHaveLength(1);
  });
  test("marks missing files on complete rescans; unavailable roots preserve records", async () => {
    const l = await open();
    const filename = path.join(music, "track.wav");
    await writeFile(filename, wavFixture());
    await l.scan([music]);
    await rename(music, `${music}-offline`);
    expect((await l.scan([music])).errors).toHaveLength(1);
    expect(l.tracks()[0].missing).toBe(false);
    await rename(`${music}-offline`, music);
    await rm(filename);
    await l.scan([music]);
    expect(l.tracks()[0].missing).toBe(true);
    await writeFile(filename, wavFixture());
    await l.scan([music]);
    expect(l.tracks()[0].missing).toBe(false);
  });
  test("same metadata in different folders stays distinct; compilation and disc folders group", async () => {
    const l = await open();
    for (const folder of [
      "edition one",
      "edition two",
      "multidisc/CD1",
      "multidisc/CD2",
    ]) {
      const dir = path.join(music, folder);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "track.wav"), wavFixture());
    }
    await l.scan([music]);
    expect(l.tracks()).toHaveLength(4);
    expect(new Set(l.tracks().map((t) => t.albumId)).size).toBe(3);
  });
  test("playlist mutations are atomic, validate names, and never remove tracks", async () => {
    const l = await open();
    await writeFile(path.join(music, "track.wav"), wavFixture());
    await l.scan([music]);
    const id = l.tracks()[0].id;
    expect(() => l.createPlaylist("  ")).toThrow();
    const p = l.createPlaylist("Mix");
    l.playlistTracks(p.id, [id]);
    expect(() => l.playlistTracks(p.id, ["invalid"])).toThrow();
    expect(l.playlists()[0].trackIds).toEqual([id]);
    l.renamePlaylist(p.id, "Renamed");
    expect(l.playlists()[0].name).toBe("Renamed");
    l.deletePlaylist(p.id);
    expect(l.playlists()).toEqual([]);
    expect(l.tracks()).toHaveLength(1);
  });
  test("normalizes invalid playback state and unknown ids", () => {
    const s = normalizeState(
      {
        volume: 99,
        position: -2,
        queue: ["valid", "missing"],
        currentId: "missing",
      },
      new Set(["valid"]),
    );
    expect(s.volume).toBe(1);
    expect(s.position).toBe(0);
    expect(s.queue).toEqual(["valid"]);
    expect(s.currentId).toBeNull();
  });
});
describe("local audio transport", () => {
  test("supports full, byte-range, suffix, and HEAD requests without changing audio", async () => {
    const file = path.join(music, "test.wav");
    const bytes = wavFixture();
    await writeFile(file, bytes);
    const response = await mediaResponse(
      file,
      "wav",
      new Request("http://local"),
    );
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
    const range = await mediaResponse(
      file,
      "wav",
      new Request("http://local", { headers: { Range: "bytes=10-19" } }),
    );
    expect(range.status).toBe(206);
    expect(range.headers.get("content-range")).toBe(
      `bytes 10-19/${bytes.length}`,
    );
    expect(Buffer.from(await range.arrayBuffer())).toEqual(
      bytes.subarray(10, 20),
    );
    const suffix = await mediaResponse(
      file,
      "wav",
      new Request("http://local", { headers: { Range: "bytes=-4" } }),
    );
    expect(Buffer.from(await suffix.arrayBuffer())).toEqual(bytes.subarray(-4));
    const head = await mediaResponse(
      file,
      "wav",
      new Request("http://local", { method: "HEAD" }),
    );
    expect((await head.arrayBuffer()).byteLength).toBe(0);
    expect(head.headers.get("content-length")).toBe(String(bytes.length));
    const invalid = await mediaResponse(
      file,
      "wav",
      new Request("http://local", { headers: { Range: "bytes=999999999-" } }),
    );
    expect(invalid.status).toBe(416);
    expect(
      (
        await mediaResponse(
          `${file}-missing`,
          "wav",
          new Request("http://local"),
        )
      ).status,
    ).toBe(404);
    expect(await readFile(file)).toEqual(bytes);
  });
});
