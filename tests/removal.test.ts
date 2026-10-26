import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  rename,
  symlink,
  link,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import { defaultState, type Track } from "../src/shared/types";
import { wavFixture } from "./fixtures";

let root: string, media: string, folder: string, library: Library;
const originals = new Map<string, { bytes: Buffer; mtime: number }>();
beforeEach(async () => {
  originals.clear();
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rhythm-removal-")));
  media = path.join(root, "Media");
  folder = path.join(root, "Library");
  await mkdir(media);
  library = await Library.open(folder);
});
afterEach(async () => {
  try {
    for (const [file, before] of originals) {
      expect(await readFile(file)).toEqual(before.bytes);
      expect((await stat(file)).mtimeMs).toBe(before.mtime);
    }
  } finally {
    library.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function add(title = "Sacrificial", managed = false) {
  const file = path.join(root, `${title}.wav`);
  await writeFile(file, wavFixture({ title }));
  originals.set(file, {
    bytes: await readFile(file),
    mtime: (await stat(file)).mtimeMs,
  });
  if (managed) {
    await library.chooseMediaRoot(media);
    library.saveMediaSettings({ copyOnAdd: true });
  }
  expect((await library.add([file])).errors).toEqual([]);
  return library.tracks().find((t) => t.title === title)!;
}
function relationships(track: Track, other?: Track) {
  library.favorite(track.id);
  const ids = [track.id, ...(other ? [other.id] : [])];
  const a = library.createPlaylist("A", ids);
  const b = library.createPlaylist("B", [...ids].reverse());
  library.saveState({
    ...defaultState(),
    queue: [...ids, track.id],
    currentId: track.id,
    position: 3.5,
  });
  return { a, b };
}
function absent(id: string) {
  expect(library.tracks(id)).toEqual([]);
  for (const table of ["playlist_tracks", "track_locations", "managed_imports"])
    expect(
      library.db.prepare(`SELECT * FROM ${table} WHERE trackId=?`).all(id),
    ).toEqual([]);
  expect(library.state().queue).not.toContain(id);
  expect(library.state().currentId).not.toBe(id);
}
function restart() {
  library.close();
  return Library.open(folder).then((opened) => {
    library = opened;
  });
}
test.each(["", "invalid", "A".repeat(64)])(
  "invalid deletion identity %j cannot select the first track or reach Trash",
  async (id) => {
    const track = await add("Valid", true);
    const trash = vi.fn(async () => {});
    await expect(library.deleteTrack(id, trash)).rejects.toThrow("valid track");
    expect(trash).not.toHaveBeenCalled();
    expect(library.tracks(track.id)).toHaveLength(1);
  },
);
test("playlist removal changes only the named membership, retaining order, favourite, playback and files across restart", async () => {
  const a = await add("A"),
    b = await add("B"),
    c = await add("C");
  const { a: first, b: second } = relationships(a, b);
  library.addToPlaylist(first.id, [c.id]);
  const state = library.state();
  library.removeFromPlaylist(first.id, a.id);
  expect(library.playlists().find((p) => p.id === first.id)!.trackIds).toEqual([
    b.id,
    c.id,
  ]);
  expect(library.playlists().find((p) => p.id === second.id)!.trackIds).toEqual(
    [b.id, a.id],
  );
  expect(library.tracks(a.id)[0].favorite).toBe(true);
  expect(library.state()).toEqual(state);
  expect(library.tracks()).toHaveLength(3);
  await restart();
  expect(library.playlists().find((p) => p.id === first.id)!.trackIds).toEqual([
    b.id,
    c.id,
  ]);
  expect(library.state()).toEqual(state);
  expect(() => library.removeFromPlaylist("absent", a.id)).toThrow(
    "no longer exists",
  );
});
test("referenced deletion removes complete identity, both memberships, favourite, duplicate queue entries and current position; stale saves cannot revive it", async () => {
  const a = await add("A"),
    b = await add("B");
  const { a: first, b: second } = relationships(a, b);
  const stale = library.state();
  const trash = vi.fn(async () => {
    throw Error("External files must never reach Trash");
  });
  await library.deleteTrack(a.id, trash);
  expect(trash).not.toHaveBeenCalled();
  absent(a.id);
  expect(library.state()).toMatchObject({
    currentId: null,
    position: 0,
    queue: [b.id],
  });
  expect(library.playlists().find((p) => p.id === first.id)!.trackIds).toEqual([
    b.id,
  ]);
  expect(library.playlists().find((p) => p.id === second.id)!.trackIds).toEqual(
    [b.id],
  );
  expect(library.roots()).not.toContain(a.path);
  library.saveState(stale);
  expect(library.state()).toMatchObject({
    currentId: null,
    position: 0,
    queue: [b.id],
  });
  await restart();
  absent(a.id);
  expect(library.state().position).toBe(0);
});
test("deleting a queued non-current track preserves other playback and its position", async () => {
  const a = await add("A"),
    b = await add("B");
  relationships(a, b);
  await library.deleteTrack(b.id, async () => {
    throw Error("Must not trash references");
  });
  absent(b.id);
  expect(library.state()).toMatchObject({
    currentId: a.id,
    position: 3.5,
    queue: [a.id, a.id],
  });
});
test("managed deletion hands only the receipt-validated copy to Trash, cleans receipts/relationships and permits a fresh import", async () => {
  const t = await add("Managed", true);
  relationships(t);
  const trashFolder = path.join(root, "Sacrificial Trash");
  await mkdir(trashFolder);
  const trashed = path.join(trashFolder, path.basename(t.path));
  const bytes = await readFile(t.path);
  const trash = vi.fn(async (file: string) => {
    expect(file).toBe(t.path);
    expect(file.startsWith(`${media}${path.sep}`)).toBe(true);
    await rename(file, trashed);
  });
  await library.deleteTrack(t.id, trash);
  expect(trash).toHaveBeenCalledTimes(1);
  await expect(stat(t.path)).rejects.toThrow();
  expect(await readFile(trashed)).toEqual(bytes);
  absent(t.id);
  await restart();
  absent(t.id);
  expect((await library.add([path.join(root, "Managed.wav")])).errors).toEqual(
    [],
  );
  expect(library.tracks()).toHaveLength(1);
  expect(library.tracks()[0].id).not.toBe(t.id);
});
test("Trash rejection retains all relationships and identity across restart", async () => {
  const t = await add("Failure", true);
  relationships(t);
  const before = {
    tracks: library.tracks(),
    playlists: library.playlists(),
    state: library.state(),
    receipts: library.db.prepare("SELECT * FROM managed_imports").all(),
  };
  await expect(
    library.deleteTrack(t.id, async () => {
      throw Error("Trash unavailable");
    }),
  ).rejects.toThrow("Trash unavailable");
  expect(library.scanning).toBe(false);
  expect({
    tracks: library.tracks(),
    playlists: library.playlists(),
    state: library.state(),
    receipts: library.db.prepare("SELECT * FROM managed_imports").all(),
  }).toEqual(before);
  expect((await stat(t.path)).isFile()).toBe(true);
  await restart();
  expect(library.tracks()).toEqual(before.tracks);
  expect(library.state()).toEqual(before.state);
});
test("database failure after Trash rolls back relationships and retains a truthful recoverable missing entry", async () => {
  const t = await add("Database failure", true);
  relationships(t);
  const state = library.state(),
    playlists = library.playlists();
  library.db.exec(
    "CREATE TRIGGER reject_delete BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT,'test database failure'); END;",
  );
  const trashed = path.join(root, "Sacrificial trashed.wav");
  await expect(
    library.deleteTrack(t.id, (file) => rename(file, trashed)),
  ).rejects.toThrow(
    "file was moved to the Trash, but its library entry could not be removed",
  );
  expect(library.tracks(t.id)[0]).toMatchObject({
    favorite: true,
    missing: true,
  });
  expect(library.state()).toEqual(state);
  expect(library.playlists()).toEqual(playlists);
  expect((await stat(trashed)).isFile()).toBe(true);
  await restart();
  expect(library.tracks(t.id)[0].missing).toBe(true);
});
test.each([
  "external path",
  "traversal",
  "absolute",
  "no receipt",
  "wrong receipt",
  "pending receipt",
  "changed copy",
  "leaf symlink",
  "external hard link",
  "parent symlink",
  "replaced root",
  "missing file",
])(
  "managed authority refuses %s without calling Trash or removing identity",
  async (scenario) => {
    const t = await add("Safety", true);
    relationships(t);
    const original = path.join(root, "Safety.wav");
    switch (scenario) {
      case "external path":
        library.db
          .prepare("UPDATE tracks SET path=? WHERE id=?")
          .run(original, t.id);
        break;
      case "traversal":
        library.db
          .prepare(
            "UPDATE track_locations SET relativePath='../Safety.wav' WHERE trackId=?",
          )
          .run(t.id);
        break;
      case "absolute":
        library.db
          .prepare("UPDATE track_locations SET relativePath=? WHERE trackId=?")
          .run(original, t.id);
        break;
      case "no receipt":
        library.db
          .prepare("DELETE FROM managed_imports WHERE trackId=?")
          .run(t.id);
        break;
      case "wrong receipt":
        library.db
          .prepare("UPDATE managed_imports SET stageInode='0' WHERE trackId=?")
          .run(t.id);
        break;
      case "pending receipt":
        library.db
          .prepare("UPDATE managed_imports SET status='ready' WHERE trackId=?")
          .run(t.id);
        break;
      case "changed copy":
        await writeFile(t.path, wavFixture({ title: "Replaced bytes" }));
        break;
      case "leaf symlink":
        await rename(t.path, path.join(root, "saved-copy.wav"));
        await symlink(original, t.path);
        break;
      case "external hard link":
        await rename(t.path, path.join(root, "saved-copy.wav"));
        await link(original, t.path);
        break;
      case "parent symlink":
        await rename(path.dirname(t.path), path.join(root, "saved-parent"));
        await symlink(root, path.dirname(t.path));
        break;
      case "replaced root":
        await rename(media, `${media}-old`);
        await mkdir(media);
        break;
      case "missing file":
        await rename(t.path, path.join(root, "moved.wav"));
        break;
    }
    const trash = vi.fn(async () => {});
    await expect(library.deleteTrack(t.id, trash)).rejects.toThrow();
    expect(trash).not.toHaveBeenCalled();
    expect(library.tracks(t.id)).toHaveLength(1);
    expect(library.tracks(t.id)[0].favorite).toBe(true);
    expect(library.playlists().every((p) => p.trackIds.includes(t.id))).toBe(
      true,
    );
    expect(library.state().currentId).toBe(t.id);
  },
);
test("an unknown file inside the media folder stays referenced and cannot gain Trash authority", async () => {
  await library.chooseMediaRoot(media);
  const file = path.join(media, "User placed.wav");
  await writeFile(file, wavFixture());
  originals.set(file, {
    bytes: await readFile(file),
    mtime: (await stat(file)).mtimeMs,
  });
  await library.add([file]);
  const t = library.tracks()[0];
  expect(t.locationKind).toBe("referenced");
  const trash = vi.fn(async () => {});
  await library.deleteTrack(t.id, trash);
  expect(trash).not.toHaveBeenCalled();
  absent(t.id);
});
test("registered historical media roots retain their authority when a new default root is chosen", async () => {
  const t = await add("Historical", true);
  const next = path.join(root, "New Media");
  await mkdir(next);
  await library.chooseMediaRoot(next);
  await library.deleteTrack(t.id, (file) =>
    rename(file, path.join(root, "Sacrificial trashed.wav")),
  );
  absent(t.id);
});
test("receipt cleanup preserves a rescan source now used by another referenced identity", async () => {
  const managed = await add("Managed source", true);
  library.saveMediaSettings({ copyOnAdd: false });
  const referenced = await add("Independent reference");
  // A receipt source is an alias, not exclusive ownership of a global scan root.
  library.db
    .prepare("UPDATE managed_imports SET source=? WHERE trackId=?")
    .run(referenced.path, managed.id);
  await library.deleteTrack(managed.id, (file) =>
    rename(file, path.join(root, "Sacrificial trashed.wav")),
  );
  absent(managed.id);
  expect(library.tracks(referenced.id)).toHaveLength(1);
  expect(library.roots()).toContain(referenced.path);
});
test("concurrent media operations are rejected during Trash, while independent player saves are retained", async () => {
  const t = await add("Pending", true),
    other = await add("Other", true);
  relationships(t, other);
  let finish!: () => void;
  const held = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const deletion = library.deleteTrack(t.id, async (file) => {
    started();
    await held;
    await rename(file, path.join(root, "Sacrificial trashed.wav"));
  });
  await ready;
  await expect(library.deleteTrack(other.id, async () => {})).rejects.toThrow(
    "Wait",
  );
  await expect(library.add([other.path])).rejects.toThrow("already running");
  library.saveState({
    ...defaultState(),
    currentId: other.id,
    queue: [t.id, other.id],
    position: 8,
  });
  finish();
  await deletion;
  expect(library.state()).toMatchObject({
    currentId: other.id,
    queue: [other.id],
    position: 8,
  });
});

test("bulk playlist removal changes only named memberships and persists their remaining order", async () => {
  const a = await add("A"),
    b = await add("B"),
    c = await add("C"),
    d = await add("D");
  const { a: first, b: second } = relationships(a, b);
  library.addToPlaylist(first.id, [c.id, d.id]);
  const state = library.state();
  library.removeFromPlaylist(first.id, [a.id, c.id, a.id]);
  expect(library.playlists().find((p) => p.id === first.id)!.trackIds).toEqual([
    b.id,
    d.id,
  ]);
  expect(library.playlists().find((p) => p.id === second.id)!.trackIds).toEqual(
    [b.id, a.id],
  );
  expect(library.tracks(a.id)[0].favorite).toBe(true);
  expect(library.state()).toEqual(state);
  await restart();
  expect(library.playlists().find((p) => p.id === first.id)!.trackIds).toEqual([
    b.id,
    d.id,
  ]);
  expect(library.tracks()).toHaveLength(4);
});
test.each(["referenced", "managed", "mixed"])(
  "bulk %s cleanup preserves originals and unrelated current playback",
  async (kind) => {
    const keep = await add("Keep");
    const a = await add("A", kind !== "referenced");
    // add() follows the current copy policy, so explicitly switch it for the reference in mixed selections.
    library.saveMediaSettings({ copyOnAdd: kind === "managed" });
    const b = await add("B", kind === "managed");
    const first = library.createPlaylist("First", [a.id, keep.id, b.id]);
    library.createPlaylist("Other", [b.id, a.id]);
    library.favorite(a.id);
    library.saveState({
      ...defaultState(),
      queue: [a.id, keep.id, b.id, a.id],
      currentId: keep.id,
      position: 7,
    });
    const trash = vi.fn(async (file: string) => {
      await rename(file, path.join(root, `trashed-${path.basename(file)}`));
    });
    const selection = library.removalTracks([a.id, b.id, a.id]);
    expect(selection.map((t) => t.locationKind)).toEqual(
      kind === "mixed" ? ["managed", "referenced"] : [kind, kind],
    );
    const result = await library.deleteTracks(selection, trash);
    expect(result).toEqual({ removedIds: [a.id, b.id], failures: [] });
    expect(trash).toHaveBeenCalledTimes(
      kind === "mixed" ? 1 : kind === "managed" ? 2 : 0,
    );
    absent(a.id);
    absent(b.id);
    expect(library.state()).toMatchObject({
      currentId: keep.id,
      position: 7,
      queue: [keep.id],
    });
    expect(
      library.playlists().find((p) => p.id === first.id)!.trackIds,
    ).toEqual([keep.id]);
    await restart();
    expect(library.tracks().map((t) => t.id)).toEqual([keep.id]);
  },
);
test("bulk deleting current and queued tracks clears current and duplicate queue references", async () => {
  const a = await add("A"),
    b = await add("B"),
    keep = await add("Keep");
  relationships(a, b);
  library.saveState({ ...library.state(), queue: [a.id, b.id, keep.id, a.id] });
  const trash = vi.fn(async () => {});
  expect(
    (await library.deleteTracks(library.removalTracks([a.id, b.id]), trash))
      .failures,
  ).toEqual([]);
  expect(library.state()).toMatchObject({
    currentId: null,
    position: 0,
    queue: [keep.id],
  });
  expect(trash).not.toHaveBeenCalled();
});
test.each(["receipt", "path"])(
  "invalid managed %s within a selection is retained while valid managed/reference removals succeed",
  async (invalid) => {
    const bad = await add("Bad", true),
      good = await add("Good", true);
    library.saveMediaSettings({ copyOnAdd: false });
    const ref = await add("Reference");
    relationships(bad, good);
    if (invalid === "receipt")
      library.db
        .prepare("UPDATE managed_imports SET status='ready' WHERE trackId=?")
        .run(bad.id);
    else
      library.db
        .prepare("UPDATE tracks SET path=? WHERE id=?")
        .run(ref.path + ".forged", bad.id);
    const trash = vi.fn(async (file: string) => {
      await rename(file, path.join(root, "trashed-good.wav"));
    });
    const result = await library.deleteTracks(
      library.removalTracks([bad.id, good.id, ref.id]),
      trash,
    );
    expect(result.removedIds).toEqual([good.id, ref.id]);
    expect(result.failures).toEqual([
      expect.objectContaining({ id: bad.id, fileTrashed: false }),
    ]);
    expect(trash).toHaveBeenCalledExactlyOnceWith(good.path);
    expect(library.tracks(bad.id)[0].favorite).toBe(true);
    expect((await stat(bad.path)).isFile()).toBe(true);
    expect(library.state()).toMatchObject({
      currentId: bad.id,
      queue: [bad.id, bad.id],
    });
    await restart();
    expect(library.tracks()).toHaveLength(1);
  },
);
test("bulk Trash rejection continues, retaining failed identity and relationships; retry succeeds", async () => {
  const a = await add("A", true),
    b = await add("B", true);
  relationships(a, b);
  const result = await library.deleteTracks(
    library.removalTracks([a.id, b.id]),
    async (file) => {
      if (file === a.path) throw Error("Trash unavailable");
      await rename(file, path.join(root, "trashed-b.wav"));
    },
  );
  expect(result.removedIds).toEqual([b.id]);
  expect(result.failures).toEqual([
    {
      id: a.id,
      title: a.title,
      message: "Trash unavailable",
      fileTrashed: false,
    },
  ]);
  expect(library.tracks(a.id)[0].missing).toBe(false);
  expect(library.playlists().every((p) => p.trackIds.includes(a.id))).toBe(
    true,
  );
  await restart();
  expect(
    (
      await library.deleteTracks(library.removalTracks([a.id]), (file) =>
        rename(file, path.join(root, "trashed-a.wav")),
      )
    ).failures,
  ).toEqual([]);
});
test("bulk post-Trash DB failure reports physical outcome, retains recoverable track and continues unrelated deletion", async () => {
  const a = await add("A", true);
  library.saveMediaSettings({ copyOnAdd: false });
  const b = await add("B");
  relationships(a, b);
  library.db.exec(
    `CREATE TRIGGER reject_one BEFORE DELETE ON tracks WHEN OLD.id='${a.id}' BEGIN SELECT RAISE(ABORT,'injected bulk database failure'); END;`,
  );
  const result = await library.deleteTracks(
    library.removalTracks([a.id, b.id]),
    (file) => rename(file, path.join(root, "trashed-a.wav")),
  );
  expect(result.removedIds).toEqual([b.id]);
  expect(result.failures).toEqual([
    expect.objectContaining({
      id: a.id,
      fileTrashed: true,
      message: expect.stringContaining("Restore it from Trash"),
    }),
  ]);
  expect(library.tracks(a.id)[0]).toMatchObject({
    missing: true,
    favorite: true,
  });
  expect(library.playlists().every((p) => p.trackIds.includes(a.id))).toBe(
    true,
  );
  await restart();
  expect(library.tracks(a.id)[0].missing).toBe(true);
});
test("complete identity/location preflight rejects before any mutation if selection changed after confirmation", async () => {
  const a = await add("A", true),
    b = await add("B", true);
  const confirmed = library.removalTracks([a.id, b.id]);
  library.db
    .prepare(
      "UPDATE track_locations SET kind='referenced',mediaRootId=NULL,relativePath=NULL WHERE trackId=?",
    )
    .run(b.id);
  const trash = vi.fn(async () => {});
  await expect(library.deleteTracks(confirmed, trash)).rejects.toThrow(
    "location changed",
  );
  expect(trash).not.toHaveBeenCalled();
  expect(library.tracks()).toHaveLength(2);
  expect(() => library.removalTracks([a.id, "f".repeat(64)])).toThrow(
    "no longer exists",
  );
  expect(() =>
    library.removeFromPlaylist("anything", [a.id, "invalid"]),
  ).toThrow("valid track");
});
