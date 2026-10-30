import { beforeEach, afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  readdir,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import { wavFixture } from "./fixtures";
import { defaultState } from "../src/shared/types";

let root: string, l: Library;
const files = new Map<string, { bytes: Buffer; mtime: number }>();
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-playlist-actions-")),
  );
  l = await Library.open(path.join(root, "Library"));
  const media = path.join(root, "Media");
  await mkdir(media);
  await l.chooseMediaRoot(media);
  for (const managed of [false, true]) {
    const file = path.join(
      root,
      `${managed ? "managed-original" : "reference"}.wav`,
    );
    const bytes = wavFixture({ title: path.basename(file) });
    await writeFile(file, bytes);
    l.saveMediaSettings({ copyOnAdd: managed });
    await l.add([file]);
    files.set(file, { bytes, mtime: (await stat(file)).mtimeMs });
  }
  for (const track of l.tracks())
    files.set(track.path, {
      bytes: await readFile(track.path),
      mtime: (await stat(track.path)).mtimeMs,
    });
});
afterEach(async () => {
  try {
    for (const [file, before] of files) {
      expect(await readFile(file)).toEqual(before.bytes);
      expect((await stat(file)).mtimeMs).toBe(before.mtime);
    }
  } finally {
    files.clear();
    l.close();
    await rm(root, { recursive: true, force: true });
  }
});
const reopen = async () => {
  l.close();
  l = await Library.open(path.join(root, "Library"));
};
async function entries(directory: string): Promise<string[]> {
  const items = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      items.map(async (item) =>
        item.isDirectory()
          ? entries(path.join(directory, item.name))
          : [path.join(directory, item.name)],
      ),
    )
  ).flat();
}
test("duplicate has independent identity and ordered membership without copying records or audio, including restart", async () => {
  const tracks = l.tracks(),
    ids = [tracks[1].id, tracks[0].id];
  const source = l.createPlaylist("Evening", ids);
  const beforeFiles = await entries(path.join(root, "Media"));
  const receipts = l.db.prepare("SELECT * FROM managed_imports").all();
  const duplicate = l.duplicatePlaylist(source.id);
  expect(duplicate).toEqual({
    id: expect.any(String),
    name: "Evening copy",
    trackIds: ids,
  });
  expect(duplicate.id).not.toBe(source.id);
  expect(l.tracks()).toEqual(tracks);
  expect(l.db.prepare("SELECT * FROM managed_imports").all()).toEqual(receipts);
  expect(await entries(path.join(root, "Media"))).toEqual(beforeFiles);
  l.playlistTracks(duplicate.id, [ids[0]]);
  expect(l.playlists().find((p) => p.id === source.id)?.trackIds).toEqual(ids);
  l.playlistTracks(source.id, [ids[1]]);
  expect(l.playlists().find((p) => p.id === duplicate.id)?.trackIds).toEqual([
    ids[0],
  ]);
  await reopen();
  expect(l.playlists().find((p) => p.id === source.id)?.trackIds).toEqual([
    ids[1],
  ]);
  expect(l.playlists().find((p) => p.id === duplicate.id)?.trackIds).toEqual([
    ids[0],
  ]);
});
test("duplicate collision sequence is deterministic and case-insensitive like playlist import", () => {
  const source = l.createPlaylist("Mix");
  expect(l.duplicatePlaylist(source.id).name).toBe("Mix copy");
  expect(l.duplicatePlaylist(source.id).name).toBe("Mix copy 2");
  l.createPlaylist("MIX COPY 3");
  expect(l.duplicatePlaylist(source.id).name).toBe("Mix copy 4");
  expect(l.duplicatePlaylist(source.id).trackIds).toEqual([]);
});
test.each(["a".repeat(120), "🎶".repeat(60), "Library 音楽 Café"])(
  "duplicate follows existing name limit without splitting Unicode: %s",
  (name) => {
    const source = l.createPlaylist(name);
    for (let i = 1; i <= 3; i++) {
      const duplicate = l.duplicatePlaylist(source.id);
      expect(duplicate.name.length).toBeLessThanOrEqual(120);
      expect(duplicate.name.endsWith(i === 1 ? " copy" : ` copy ${i}`)).toBe(
        true,
      );
      expect(duplicate.name.isWellFormed()).toBe(true);
    }
  },
);
test("unknown targets and failed membership insertion leave no partial duplicate", () => {
  expect(() => l.duplicatePlaylist("not-a-playlist")).toThrow(
    "no longer exists",
  );
  const source = l.createPlaylist(
    "Atomic",
    l.tracks().map((t) => t.id),
  );
  const before = l.playlists();
  l.db.exec(
    "CREATE TRIGGER fail_duplicate BEFORE INSERT ON playlist_tracks BEGIN SELECT RAISE(ABORT,'injected membership failure'); END;",
  );
  expect(() => l.duplicatePlaylist(source.id)).toThrow(
    "injected membership failure",
  );
  expect(l.playlists()).toEqual(before);
});
test("deleting an original or duplicate removes only its identity and memberships, persists, and leaves player/library/audio intact", async () => {
  const tracks = l.tracks(),
    ids = tracks.map((t) => t.id);
  const source = l.createPlaylist("Delete target", ids),
    duplicate = l.duplicatePlaylist(source.id),
    other = l.createPlaylist("Keep", [ids[1]]);
  const state = {
    ...defaultState(),
    queue: ids,
    currentId: ids[0],
    position: 1,
    view: `playlist:${other.id}`,
  };
  l.saveState(state);
  const locations = l.db.prepare("SELECT * FROM track_locations").all();
  l.deletePlaylist(source.id);
  expect(
    l.db
      .prepare("SELECT * FROM playlist_tracks WHERE playlistId=?")
      .all(source.id),
  ).toEqual([]);
  expect(l.playlists().find((p) => p.id === duplicate.id)?.trackIds).toEqual(
    ids,
  );
  expect(l.tracks()).toEqual(tracks);
  expect(l.db.prepare("SELECT * FROM track_locations").all()).toEqual(
    locations,
  );
  expect(l.state()).toEqual(state);
  await reopen();
  expect(l.playlists().some((p) => p.id === source.id)).toBe(false);
  l.deletePlaylist(duplicate.id);
  expect(l.playlists()).toEqual([other]);
  expect(l.tracks()).toEqual(tracks);
});
