import { beforeEach, afterEach, test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import { wavFixture } from "./fixtures";
import { collectionTotals } from "../src/shared/collection-summary";

let root: string, folder: string, media: string, l: Library;
const sources = new Map<string, { bytes: Buffer; mtime: number }>();
beforeEach(async () => {
  root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-summary-metadata-")),
  );
  folder = path.join(root, "Library");
  media = path.join(root, "Media");
  await mkdir(media);
  l = await Library.open(folder);
});
afterEach(async () => {
  try {
    for (const [file, before] of sources) {
      expect(await readFile(file)).toEqual(before.bytes);
      expect((await stat(file)).mtimeMs).toBe(before.mtime);
    }
  } finally {
    sources.clear();
    l.close();
    await rm(root, { recursive: true, force: true });
  }
});
async function source(name: string, seconds = 2, disc?: string) {
  const dir = path.join(root, "Originals", ...(disc ? [disc] : []));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${name}.wav`),
    bytes = wavFixture({
      title: name,
      seconds,
      album: "Same title",
      artist: "Artist",
      disc: disc?.match(/\d+/)?.[0],
    });
  await writeFile(file, bytes);
  sources.set(file, { bytes, mtime: (await stat(file)).mtimeMs });
  return file;
}
async function reopen() {
  l.close();
  l = await Library.open(folder);
}
test("existing byte sizes surface for referenced and managed tracks and survive restart without a migration", async () => {
  const reference = await source("reference", 2),
    original = await source("managed", 3);
  await l.add([reference]);
  await l.chooseMediaRoot(media);
  l.saveMediaSettings({ copyOnAdd: true });
  await l.add([original]);
  const tracks = l.tracks();
  expect(tracks.map((t) => t.locationKind).sort()).toEqual([
    "managed",
    "referenced",
  ]);
  for (const t of tracks) expect(t.fileSize).toBe((await stat(t.path)).size);
  const totals = collectionTotals(tracks);
  await reopen();
  expect(collectionTotals(l.tracks())).toEqual(totals);
  expect(l.db.prepare("PRAGMA user_version").get()?.user_version).toBe(4);
  // Unavailable paths retain their last indexed bytes without needing filesystem I/O.
  l.db.prepare("UPDATE tracks SET path=path||'.unavailable',missing=1").run();
  expect(collectionTotals(l.tracks())).toEqual(totals);
});
test("rescan refreshes a stale indexed size; unavailable/invalid stored sizes remain unknown", async () => {
  const file = await source("rescan");
  await l.add([file]);
  const t = l.tracks()[0];
  l.db.prepare("UPDATE tracks SET size=-1 WHERE id=?").run(t.id);
  expect(l.tracks()[0].fileSize).toBeNull();
  await reopen();
  expect(l.tracks()[0].fileSize).toBeNull();
  expect((await l.scan(l.roots())).updated).toBe(1);
  expect(l.tracks()[0].fileSize).toBe((await stat(file)).size);
});
test.each([false, true])(
  "Locate refreshes actual replacement size and duration while retaining identity, managed=%s",
  async (managed) => {
    const first = await source("first", 2),
      replacement = await source("replacement", 5);
    await l.chooseMediaRoot(media);
    l.saveMediaSettings({ copyOnAdd: managed });
    await l.add([first]);
    const before = l.tracks()[0];
    await l.locateTrack(before.id, replacement);
    const after = l.tracks()[0];
    expect(after.id).toBe(before.id);
    expect(after.duration).toBe(5);
    expect(after.fileSize).toBe((await stat(after.path)).size);
    expect(after.fileSize).toBe((await stat(replacement)).size);
    expect(after.locationKind).toBe(managed ? "managed" : "referenced");
    expect(after.fileSize).not.toBe(before.fileSize);
    await reopen();
    expect(l.tracks()[0].fileSize).toBe(after.fileSize);
  },
);
test("consolidation keeps byte totals coherent through copy and restart", async () => {
  const file = await source("consolidate", 4);
  await l.add([file]);
  const before = l.tracks()[0];
  await l.chooseMediaRoot(media);
  expect((await l.consolidate()).consolidated).toBe(1);
  const after = l.tracks()[0];
  expect(after.id).toBe(before.id);
  expect(after.locationKind).toBe("managed");
  expect(after.fileSize).toBe(before.fileSize);
  expect(after.fileSize).toBe((await stat(after.path)).size);
  await reopen();
  expect(collectionTotals(l.tracks())).toEqual(collectionTotals([before]));
});
test("real indexing preserves established multi-disc album grouping for summary counts", async () => {
  const a = await source("disc one", 2, "CD1"),
    b = await source("disc two", 3, "Disc 2");
  await l.add([a, b]);
  expect(new Set(l.tracks().map((t) => t.albumId)).size).toBe(1);
  expect(collectionTotals(l.tracks()).albums).toBe(1);
});
