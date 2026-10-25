import { beforeEach, afterEach, expect, test } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rename,
  stat,
  rm,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Library } from "../src/domain/library";
import { defaultState } from "../src/shared/types";
import { wavFixture } from "./fixtures";
let root: string, incoming: string, media: string, database: string, l: Library;
const originals = new Map<string, { hash: string; mtime: number }>();
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "rhythm-recovery-")));
  incoming = path.join(root, "Incoming");
  media = path.join(root, "Media");
  database = path.join(root, "Library");
  await mkdir(incoming);
  await mkdir(media);
  l = await Library.open(database);
  originals.clear();
});
afterEach(async () => {
  try {
    for (const [file, before] of originals) {
      expect(sha(await readFile(file))).toBe(before.hash);
      expect((await stat(file)).mtimeMs).toBe(before.mtime);
    }
  } finally {
    l.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function source(name: string, title = name) {
  const file = path.join(incoming, name);
  await writeFile(
    file,
    wavFixture({ title, album: "Recovery album", track: 1 }),
  );
  await protect(file);
  return file;
}
async function protect(file: string) {
  originals.set(file, {
    hash: sha(await readFile(file)),
    mtime: (await stat(file)).mtimeMs,
  });
}
function preserve(id: string) {
  l.favorite(id);
  const p = l.createPlaylist("Keep me", [id]);
  const state = {
    ...defaultState(),
    currentId: id,
    queue: [id],
    position: 7.5,
    repeat: "all" as const,
  };
  l.saveState(state);
  return { p, state, addedAt: l.tracks(id)[0].addedAt };
}
function assertState(id: string, before: ReturnType<typeof preserve>) {
  expect(l.tracks(id)[0]).toMatchObject({
    id,
    favorite: true,
    addedAt: before.addedAt,
    missing: false,
  });
  expect(l.playlists().find((p) => p.id === before.p.id)?.trackIds).toEqual([
    id,
  ]);
  expect(l.state()).toEqual(before.state);
}
async function reopen() {
  l.close();
  l = await Library.open(database);
}
async function outputs(directory = media): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries
        .filter((e) => !e.name.startsWith("."))
        .map((e) =>
          e.isDirectory()
            ? outputs(path.join(directory, e.name))
            : [path.join(directory, e.name)],
        ),
    )
  ).flat();
}

test.each([false, true])(
  "referenced Locate preserves exactly one identity/state without copying (copy-on-add=%s), and persists",
  async (copyOnAdd) => {
    const old = await source("old.wav");
    await l.add([old]);
    expect(l.tracks()).toHaveLength(1);
    const t = l.tracks()[0],
      saved = preserve(t.id);
    originals.delete(old);
    const moved = path.join(incoming, "relocated.wav");
    await rename(old, moved);
    await protect(moved);
    expect(await l.checkTrack(t.id)).toEqual({ missing: true });
    await l.chooseMediaRoot(media);
    l.saveMediaSettings({ copyOnAdd });
    await l.locateTrack(t.id, moved);
    expect(l.tracks().map((t) => t.id)).toEqual([t.id]);
    expect(l.tracks(t.id)[0]).toMatchObject({
      path: moved,
      locationKind: "referenced",
      mediaRootId: null,
    });
    assertState(t.id, saved);
    expect(await outputs()).toEqual([]);
    await reopen();
    expect(l.tracks().map((t) => t.id)).toEqual([t.id]);
    assertState(t.id, saved);
    expect(l.tracks(t.id)[0]).toMatchObject({
      path: moved,
      locationKind: "referenced",
      missing: false,
    });
    expect(l.media(t.id)?.path).toBe(moved);
  },
);

test.each(["original", "external-survivor"])(
  "managed Locate restores a verified independent COPY from %s without changing source or identity",
  async (kind) => {
    const original = await source("original.wav", "Managed");
    await l.chooseMediaRoot(media);
    l.saveMediaSettings({ copyOnAdd: true });
    await l.add([original]);
    const t = l.tracks()[0],
      saved = preserve(t.id);
    const parked = path.join(incoming, "survivor.wav");
    await rename(t.path, parked);
    await protect(parked);
    expect((await l.checkTrack(t.id)).missing).toBe(true);
    // Recovery is explicit and does not depend on the Add Music copy toggle.
    l.saveMediaSettings({ copyOnAdd: false });
    await l.locateTrack(t.id, kind === "original" ? original : parked);
    const restored = l.tracks(t.id)[0];
    expect(restored.locationKind).toBe("managed");
    expect(restored.path.startsWith(media + path.sep)).toBe(true);
    expect(await readFile(restored.path)).toEqual(await readFile(original));
    expect((await stat(restored.path)).ino).not.toBe((await stat(parked)).ino);
    assertState(t.id, saved);
    expect(l.tracks()).toHaveLength(1);
    await reopen();
    assertState(t.id, saved);
    expect(l.media(t.id)?.path).toBe(restored.path);
  },
);

test("manually restored expected managed path revalidates in place, without new output", async () => {
  const original = await source("one.wav");
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true });
  await l.add([original]);
  const t = l.tracks()[0];
  await rename(t.path, t.path + ".parked");
  await l.checkTrack(t.id);
  await rename(t.path + ".parked", t.path);
  await l.locateTrack(t.id, t.path);
  expect(l.tracks(t.id)[0]).toMatchObject({
    path: t.path,
    missing: false,
    locationKind: "managed",
  });
  expect(await outputs()).toEqual([t.path]);
});

test("Rescan clears a restored missing file without performing consolidation", async () => {
  const original = await source("one.wav");
  await l.add([original]);
  const t = l.tracks()[0];
  originals.delete(original);
  await rename(original, original + ".parked");
  await l.checkTrack(t.id);
  await rename(original + ".parked", original);
  await protect(original);
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true });
  await l.scan(l.roots());
  expect(l.tracks(t.id)[0]).toMatchObject({
    missing: false,
    locationKind: "referenced",
  });
  expect(await outputs()).toEqual([]);
});

test("invalid/unsupported selection and another track's file do not relink or claim recovery", async () => {
  const old = await source("old.wav"),
    other = await source("other.wav");
  await l.add([old, other]);
  const t = l.tracks().find((t) => t.path === old)!;
  originals.delete(old);
  await rename(old, old + ".parked");
  await protect(old + ".parked");
  await l.checkTrack(t.id);
  const invalid = path.join(incoming, "invalid.wav"),
    unsupported = path.join(incoming, "unsupported.txt");
  await writeFile(invalid, "no audio");
  await writeFile(unsupported, "not supported");
  for (const file of [invalid, unsupported, other])
    await expect(l.locateTrack(t.id, file)).rejects.toThrow();
  expect(l.tracks(t.id)[0]).toMatchObject({
    path: old,
    missing: true,
    locationKind: "referenced",
  });
});

test("failed managed restore leaves a missing identity and read-only recovery source, then retries after restart", async () => {
  const original = await source("one.wav");
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true });
  await l.add([original]);
  const t = l.tracks()[0],
    saved = preserve(t.id);
  await rename(t.path, path.join(root, "parked.wav"));
  await l.checkTrack(t.id);
  l.db.exec(
    "CREATE TRIGGER hold_recovery BEFORE UPDATE ON track_locations WHEN NEW.kind='managed' BEGIN SELECT RAISE(ABORT,'injected recovery failure'); END;",
  );
  await expect(l.locateTrack(t.id, original)).rejects.toThrow(
    "injected recovery failure",
  );
  expect(l.tracks(t.id)[0]).toMatchObject({ path: t.path, missing: true });
  expect(l.mediaSettings().pendingImports).toBe(1);
  // A pending publication must not be indexed as another track by a rescan.
  await l.scan([media]);
  expect(l.tracks()).toHaveLength(1);
  l.db.exec("DROP TRIGGER hold_recovery");
  await reopen();
  await l.locateTrack(t.id, original);
  assertState(t.id, saved);
  expect(await outputs()).toHaveLength(1);
  expect(l.mediaSettings().pendingImports).toBe(0);
});

test("managed recovery never overwrites an unrelated restored destination", async () => {
  const original = await source("one.wav");
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true });
  await l.add([original]);
  const t = l.tracks()[0];
  await rename(t.path, path.join(root, "parked.wav"));
  await l.checkTrack(t.id);
  await writeFile(t.path, wavFixture({ title: "Unrelated file" }));
  const before = await readFile(t.path);
  await l.locateTrack(t.id, original);
  expect(l.tracks(t.id)[0].path).not.toBe(t.path);
  expect(await readFile(t.path)).toEqual(before);
  expect(await outputs()).toHaveLength(2);
});

test("consolidates a mixed selection with stable IDs/state, skips managed, is idempotent and persists", async () => {
  const a = await source("a.wav"),
    b = await source("b.wav");
  await l.add([a, b]);
  const before = l.tracks(),
    saved = preserve(before[0].id);
  await l.chooseMediaRoot(media);
  expect(await l.consolidate([before[0].id])).toMatchObject({
    consolidated: 1,
    alreadyManaged: 0,
    failed: 0,
  });
  expect(await l.consolidate(before.map((t) => t.id))).toMatchObject({
    consolidated: 1,
    alreadyManaged: 1,
    failed: 0,
  });
  assertState(before[0].id, saved);
  const files = await outputs();
  expect(files).toHaveLength(2);
  expect(await l.consolidate()).toEqual({
    consolidated: 0,
    alreadyManaged: 2,
    failed: 0,
    errors: [],
  });
  expect(await outputs()).toEqual(files);
  expect(
    l
      .tracks()
      .map((t) => t.id)
      .sort(),
  ).toEqual(before.map((t) => t.id).sort());
  await reopen();
  assertState(before[0].id, saved);
});

test("whole-library partial failure commits successes, leaves failures referenced, and retries only failures", async () => {
  const a = await source("a.wav"),
    b = await source("b.wav"),
    c = await source("c.wav");
  await l.add([a, b, c]);
  await l.chooseMediaRoot(media);
  const missing = l.tracks().find((t) => t.path === b)!;
  originals.delete(b);
  await rename(b, b + ".parked");
  await protect(b + ".parked");
  const first = await l.consolidate();
  expect(first).toMatchObject({
    consolidated: 2,
    alreadyManaged: 0,
    failed: 1,
  });
  expect(first.errors).toHaveLength(1);
  expect(l.tracks(missing.id)[0].locationKind).toBe("referenced");
  expect(await outputs()).toHaveLength(2);
  await reopen();
  originals.delete(b + ".parked");
  await rename(b + ".parked", b);
  await protect(b);
  expect(await l.consolidate()).toMatchObject({
    consolidated: 1,
    alreadyManaged: 2,
    failed: 0,
  });
  expect(await outputs()).toHaveLength(3);
  expect((await l.consolidate()).consolidated).toBe(0);
});

test("consolidation recovers publication/database disagreement without duplicate output", async () => {
  const original = await source("one.wav");
  await l.add([original]);
  const t = l.tracks()[0],
    saved = preserve(t.id);
  await l.chooseMediaRoot(media);
  l.db.exec(
    "CREATE TRIGGER fail_consolidation BEFORE UPDATE ON track_locations WHEN NEW.kind='managed' BEGIN SELECT RAISE(ABORT,'hold consolidation'); END;",
  );
  expect(await l.consolidate()).toMatchObject({ consolidated: 0, failed: 1 });
  expect(l.tracks(t.id)[0]).toMatchObject({
    path: original,
    locationKind: "referenced",
  });
  expect(await outputs()).toHaveLength(1);
  await l.scan([media]);
  expect(l.tracks()).toHaveLength(1);
  l.db.exec("DROP TRIGGER fail_consolidation");
  await reopen();
  expect(await l.consolidate()).toMatchObject({ consolidated: 1, failed: 0 });
  expect(await outputs()).toHaveLength(1);
  assertState(t.id, saved);
});

test("consolidation needs a root, blocks overlapping operations, and copies referenced files already inside Media", async () => {
  const a = await source("a.wav");
  await l.add([a]);
  await expect(l.consolidate()).rejects.toThrow("Choose");
  await l.chooseMediaRoot(media);
  const inside = path.join(media, "user-owned.wav");
  await writeFile(inside, wavFixture({ title: "Inside" }));
  await protect(inside);
  await l.add([inside]);
  const id = l.tracks().find((t) => t.path === inside)!.id;
  const pending = l.consolidate();
  expect(() => l.saveMediaSettings({ copyOnAdd: true })).toThrow("Wait");
  await expect(l.consolidate()).rejects.toThrow("Wait");
  await expect(l.locateTrack(id, inside)).rejects.toThrow("Wait");
  expect((await pending).consolidated).toBe(2);
  expect(l.tracks(id)[0].path).not.toBe(inside);
  expect(await outputs()).toHaveLength(3);
});

test("genuine Locate collision rejects an independently pre-existing identity without merging or changing either record", async () => {
  const a = await source("original.wav"),
    b = await source("genuine-other.wav");
  await l.add([a, b]);
  const first = l.tracks().find((t) => t.path === a)!,
    other = l.tracks().find((t) => t.path === b)!;
  const saved = preserve(first.id);
  const otherPlaylist = l.createPlaylist("Independent identity", [other.id]);
  originals.delete(a);
  await rename(a, a + ".parked");
  await protect(a + ".parked");
  await l.checkTrack(first.id);
  const before = l.tracks();
  await expect(l.locateTrack(first.id, b)).rejects.toThrow(
    "already linked to another track",
  );
  expect(l.tracks()).toEqual(before);
  expect(l.tracks()).toHaveLength(2);
  expect(l.state()).toEqual(saved.state);
  expect(l.playlists().find((p) => p.id === saved.p.id)?.trackIds).toEqual([
    first.id,
  ]);
  expect(
    l.playlists().find((p) => p.id === otherPlaylist.id)?.trackIds,
  ).toEqual([other.id]);
  await reopen();
  expect(l.tracks()).toEqual(before);
  expect(l.state()).toEqual(saved.state);
});
