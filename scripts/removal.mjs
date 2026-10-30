import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  rm,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { wavFixture } from "../tests/fixtures.ts";

// Only generated, disposable media can reach the real OS Trash in this suite.
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-removal-app-")),
);
const library = path.join(root, "Library"),
  media = path.join(root, "Media"),
  incoming = path.join(root, "Referenced"),
  managedInputs = path.join(root, "Managed originals");
for (const directory of [library, media, incoming, managedInputs])
  await mkdir(directory);
const originals = new Map();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const suffix = randomUUID();
for (const [directory, titles] of [
  [incoming, ["A", "B", "C", "D"]],
  [managedInputs, ["Managed one", "Managed two"]],
]) {
  for (const title of titles) {
    const file = path.join(directory, `${title}.wav`);
    await writeFile(
      file,
      wavFixture({
        title: `${title} ${suffix}`,
        artist: "Removal artist",
        album: "Removal album",
        seconds: 30,
      }),
    );
    originals.set(file, {
      hash: sha(await readFile(file)),
      mtime: (await stat(file)).mtimeMs,
    });
  }
}
let app;
const executable =
  process.env.RIO_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rio.app/Contents/MacOS/Rio"
          : "release/linux-unpacked/rio-desktop",
      )
    : undefined);
async function launch() {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: {
      ...process.env,
      RIO_DATA_DIR: path.join(root, "Profile"),
      ...(process.platform === "linux"
        ? { XDG_DATA_HOME: path.join(root, "xdg-data") }
        : {}),
    },
    timeout: 30000,
  });
  const p = await app.firstWindow();
  p.setDefaultTimeout(30000);
  await p.waitForSelector("h1");
  await app.evaluate(({ Menu, dialog, shell }, media) => {
    Menu.prototype.popup = function () {
      globalThis.removalMenu = this;
    };
    globalThis.confirmations = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.confirmations.push(options);
      return new Promise((resolve) => {
        globalThis.answerRemoval = (response) =>
          resolve({ response, checkboxChecked: false });
      });
    };
    const realTrash = shell.trashItem.bind(shell);
    globalThis.trashCalls = [];
    globalThis.trashSuccesses = [];
    shell.trashItem = async (file) => {
      // Fail closed if any regression tries to trash a source or real user path.
      if (!file.startsWith(`${media}/`))
        throw Error("TEST SAFETY: refusing non-sacrificial path");
      globalThis.trashCalls.push(file);
      if (globalThis.failTrash)
        throw Error("Injected Trash unavailable; track retained");
      await realTrash(file);
      globalThis.trashSuccesses.push(file);
    };
  }, media);
  return p;
}
const snapshot = (p) => p.evaluate(() => window.rio.snapshot());
const select = (file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
const row = (p, id, detail = false) =>
  p.locator(
    detail
      ? `.detail-panel .track-row[data-detail-track-id="${id}"]`
      : `.song-row[data-track-id="${id}"]`,
  );
const nav = (p, name) =>
  p.locator(".sidebar").getByRole("button", { name, exact: true }).click();
async function settled(p, predicate) {
  for (let n = 0; n < 150; n++) {
    const s = await snapshot(p);
    if (predicate(s)) return s;
    await p.waitForTimeout(100);
  }
  throw Error("Removal state did not converge");
}
async function menu(p, id, playlist = false, detail = false) {
  await app.evaluate(() => {
    globalThis.removalMenu = null;
  });
  await row(p, id, detail).click({ button: "right" });
  for (let n = 0; n < 100; n++) {
    if (await app.evaluate(() => !!globalThis.removalMenu)) break;
    await p.waitForTimeout(50);
  }
  const items = await app.evaluate(() =>
    globalThis.removalMenu.items.map((i) => ({ id: i.id, enabled: i.enabled })),
  );
  assert(items.some((i) => i.id === "track-delete" && i.enabled));
  assert.equal(
    items.some((i) => i.id === "track-remove-playlist"),
    playlist,
  );
}
const clickMenu = (id) =>
  app.evaluate((_, id) => {
    const item = globalThis.removalMenu.getMenuItemById(id);
    if (!item?.enabled) throw Error(`Missing/disabled ${id}`);
    item.click(undefined, undefined, {});
  }, id);
async function confirm(
  p,
  id,
  managed,
  response = 1,
  playlist = false,
  detail = false,
) {
  await menu(p, id, playlist, detail);
  const before = await snapshot(p),
    selectedIds = await p
      .locator(
        detail
          ? '.detail-panel .track-row[aria-selected="true"]'
          : '.song-row[aria-selected="true"]',
      )
      .evaluateAll(
        (rows, detail) =>
          rows.map((row) =>
            detail ? row.dataset.detailTrackId : row.dataset.trackId,
          ),
        detail,
      ),
    selected = before.tracks.filter((track) => selectedIds.includes(track.id)),
    managedCount = selected.filter(
      (track) => track.locationKind === "managed",
    ).length,
    referenceCount = selected.length - managedCount,
    count = await app.evaluate(() => globalThis.confirmations.length),
    trashCount = await app.evaluate(() => globalThis.trashCalls.length);
  await clickMenu("track-delete");
  for (let n = 0; n < 100; n++) {
    if (
      await app.evaluate(
        (_, count) => globalThis.confirmations.length > count,
        count,
      )
    )
      break;
    await p.waitForTimeout(50);
  }
  const options = await app.evaluate(() => globalThis.confirmations.at(-1));
  assert.equal(
    await app.evaluate(() => globalThis.confirmations.length),
    count + 1,
  );
  assert.equal(options.title, "Delete from Library");
  assert.deepEqual(options.buttons, [
    "Cancel",
    managedCount
      ? referenceCount
        ? "Delete from Library"
        : "Move to Trash"
      : "Remove from Library",
  ]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.equal(!!managedCount, managed);
  if (selected.length === 1) {
    assert.match(
      options.detail,
      managed
        ? /managed audio file moved to the Trash/
        : /remains at its original location/,
    );
  } else {
    assert.equal(
      options.message,
      `${managedCount ? "Delete" : "Remove"} ${selected.length} tracks from your library?`,
    );
    if (managedCount)
      assert(
        options.detail.includes(
          `${managedCount} managed track${managedCount === 1 ? "" : "s"} will be removed from Rio and moved to the Trash.`,
        ),
      );
    if (referenceCount)
      assert(
        options.detail.includes(
          `${referenceCount} referenced track${referenceCount === 1 ? "" : "s"} will be removed from Rio but remain at their original locations.`,
        ),
      );
  }
  const pending = await snapshot(p);
  assert.equal(
    await app.evaluate(() => globalThis.trashCalls.length),
    trashCount,
  );
  assert.deepEqual(pending.tracks, before.tracks);
  assert.deepEqual(pending.playlists, before.playlists);
  assert.deepEqual(pending.state.queue, before.state.queue);
  assert.equal(pending.state.currentId, before.state.currentId);
  await app.evaluate((_, response) => {
    globalThis.answerRemoval(response);
  }, response);
  if (response === 0) {
    // Invoke completes after the dialog answer; another operation must become available.
    await p.waitForFunction(
      () => !document.querySelector(".sidebar-bottom button").disabled,
    );
    assert.deepEqual((await snapshot(p)).tracks, before.tracks);
    assert.deepEqual((await snapshot(p)).playlists, before.playlists);
    assert.equal(
      await app.evaluate(() => globalThis.trashCalls.length),
      trashCount,
    );
  }
}
async function play(p, track) {
  await row(p, track.id)
    .getByRole("button", { name: `Play ${track.title}`, exact: true })
    .click();
  await p.waitForFunction((id) => {
    const a = document.querySelector("audio");
    return (
      a.currentSrc.endsWith(id) && !a.paused && !a.error && a.currentTime > 0.2
    );
  }, track.id);
  await settled(p, (s) => s.state.currentId === track.id);
}
async function cleared(p, id) {
  await settled(
    p,
    (s) =>
      !s.tracks.some((t) => t.id === id) &&
      !s.playlists.some((list) => list.trackIds.includes(id)) &&
      !s.state.queue.includes(id) &&
      s.state.currentId !== id,
  );
  await row(p, id).waitFor({ state: "detached" });
}
async function stopped(p) {
  await p.waitForFunction(() => {
    const a = document.querySelector("audio");
    return (
      a.paused &&
      !a.getAttribute("src") &&
      navigator.mediaSession.metadata === null
    );
  });
  const s = await snapshot(p);
  assert.equal(s.state.currentId, null);
  assert.equal(s.state.position, 0);
}
function sql(statement, ...args) {
  const db = new DatabaseSync(path.join(library, "rio.sqlite"));
  try {
    return args.length
      ? db.prepare(statement).run(...args)
      : db.exec(statement);
  } finally {
    db.close();
  }
}
function noRelationships(id) {
  const db = new DatabaseSync(path.join(library, "rio.sqlite"), {
    readOnly: true,
  });
  try {
    for (const [table, key] of [
      ["tracks", "id"],
      ["track_locations", "trackId"],
      ["playlist_tracks", "trackId"],
      ["managed_imports", "trackId"],
    ])
      assert.deepEqual(
        db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).all(id),
        [],
      );
  } finally {
    db.close();
  }
}
const primary = process.platform === "darwin" ? "Meta" : "Control";
async function selection(p, ids, detail = false) {
  await (
    detail ? row(p, ids[0], true).locator(".track-title") : row(p, ids[0])
  ).click();
  for (const id of ids.slice(1))
    await (
      detail ? row(p, id, true).locator(".track-title") : row(p, id)
    ).click({ modifiers: [primary] });
  assert.deepEqual(
    new Set(
      await p
        .locator(
          detail
            ? '.detail-panel .track-row[aria-selected="true"]'
            : '.song-row[aria-selected="true"]',
        )
        .evaluateAll(
          (rows, detail) =>
            rows.map((row) =>
              detail ? row.dataset.detailTrackId : row.dataset.trackId,
            ),
          detail,
        ),
    ),
    new Set(ids),
  );
}
async function bulkAcceptance(p, { c, d }) {
  async function importBatch(name, titles, managed) {
    const directory = path.join(root, name);
    await mkdir(directory);
    for (const title of titles) {
      const file = path.join(directory, `${title}.wav`);
      await writeFile(
        file,
        wavFixture({
          title,
          artist: "Bulk artist",
          album: "Bulk album",
          seconds: 30,
        }),
      );
      originals.set(file, {
        hash: sha(await readFile(file)),
        mtime: (await stat(file)).mtimeMs,
      });
    }
    await p.evaluate(
      (managed) => window.rio.saveMediaSettings({ copyOnAdd: managed }),
      managed,
    );
    await select(directory);
    await p
      .getByRole("button", { name: "Add music", exact: true })
      .first()
      .click();
    const s = await settled(p, (s) =>
      titles.every((title) => s.tracks.some((t) => t.title === title)),
    );
    return titles.map((title) => s.tracks.find((t) => t.title === title));
  }
  await nav(p, "Songs");
  const [r1, r2, r3, r4] = await importBatch(
    "Bulk references",
    ["Bulk R1", "Bulk R2", "Bulk R3", "Bulk R4"],
    false,
  );
  const [g1, g2, g3, bad, dbbad] = await importBatch(
    "Bulk originals",
    ["Bulk M1", "Bulk M2", "Bulk M3", "Bulk M4 bad", "Bulk M5 database"],
    true,
  );
  // Normal/toggle/range selection, moving keyboard endpoint, and right-click anchoring.
  await selection(p, [r1.id, r3.id]);
  await row(p, r3.id).click({ modifiers: [primary] });
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 1);
  await row(p, r1.id).click();
  await row(p, r3.id).click({ modifiers: ["Shift"] });
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 3);
  await p.locator(".songs-viewport").press("Shift+ArrowDown");
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 4);
  await p.locator(".songs-viewport").press("Shift+ArrowUp");
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 3);
  await menu(p, r2.id);
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 3);
  await mkdir(path.resolve(".impeccable/review"), { recursive: true });
  await p.screenshot({
    path: path.resolve(".impeccable/review/multi-selection.png"),
  });
  await menu(p, r4.id);
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 1);
  await row(p, r2.id).click({ modifiers: ["Shift"] });
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 3);
  // Real double click must still start the clicked track, with advancing audio.
  await row(p, r2.id).dblclick();
  await p.waitForFunction((id) => {
    const a = document.querySelector("audio");
    return a.currentSrc.endsWith(id) && !a.paused && a.currentTime > 0.2;
  }, r2.id);
  const bulkList = await p.evaluate(
    async (ids) => {
      const list = await window.rio.createPlaylist("Bulk selection");
      await window.rio.playlistTracks(list.id, ids);
      for (const id of ids) await window.rio.favorite(id);
      return list;
    },
    [r1.id, r2.id, r3.id, r4.id, g1.id, g2.id, g3.id, bad.id, dbbad.id],
  );
  // Cross-view selection (the same reusable Track List), single-only Info/Finder remain covered in track-info.mjs.
  await p.reload();
  for (const view of [
    bulkList.name,
    "Songs",
    "Artists",
    "Genres",
    "Favourites",
  ]) {
    await nav(p, view);
    if (view === "Artists")
      await p
        .locator(".group-list button")
        .filter({ hasText: "Bulk artist" })
        .click();
    if (view === "Genres")
      await p
        .locator(".group-list button")
        .filter({ hasText: "Ambient" })
        .click();
    await selection(p, [r1.id, r2.id]);
    await menu(p, r2.id, view === bulkList.name);
    assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 2);
  }
  await nav(p, "Albums");
  await p.getByRole("button", { name: "Track list", exact: true }).click();
  await selection(p, [r1.id, r2.id]);
  await menu(p, r1.id);
  await p.getByRole("searchbox", { name: "Search library" }).fill("Bulk R");
  await selection(p, [r1.id, r2.id]);
  await menu(p, r2.id);
  await p.getByRole("searchbox", { name: "Search library" }).fill("");
  await nav(p, "Songs");
  await play(p, c);
  await selection(p, [r1.id, r2.id]);
  await confirm(p, r2.id, false, 0);
  const time = await p.locator("audio").evaluate((a) => a.currentTime);
  await confirm(p, r2.id, false);
  await cleared(p, r1.id);
  await cleared(p, r2.id);
  await p.waitForFunction((time) => {
    const a = document.querySelector("audio");
    return !a.paused && a.currentTime > time;
  }, time);
  assert.equal((await snapshot(p)).state.currentId, c.id);
  noRelationships(r1.id);
  noRelationships(r2.id);
  // Open the managed album's detail list explicitly; current playback need not own the browsed album.
  await row(p, g1.id).click();
  // All-managed selection includes current and queued media; one confirmation and two real Trash calls.
  await play(p, g1);
  await selection(p, [g1.id, g2.id], true);
  await confirm(p, g2.id, true, 0, false, true);
  assert.equal((await stat(g1.path)).isFile(), true);
  await confirm(p, g2.id, true, 1, false, true);
  await cleared(p, g1.id);
  await cleared(p, g2.id);
  await stopped(p);
  for (const t of [g1, g2]) {
    await assert.rejects(stat(t.path), { code: "ENOENT" });
    noRelationships(t.id);
  }
  // Invalid authority is item-specific. The rest of the mixed selection completes truthfully.
  sql("UPDATE managed_imports SET status='ready' WHERE trackId=?", bad.id);
  await play(p, c);
  await p.getByRole("button", { name: "Show queue", exact: true }).click();
  await selection(p, [r3.id, g3.id, bad.id], true);
  const calls = await app.evaluate(() => globalThis.trashCalls.length);
  await confirm(p, bad.id, true, 0, false, true);
  assert.equal(await app.evaluate(() => globalThis.trashCalls.length), calls);
  await confirm(p, bad.id, true, 1, false, true);
  await cleared(p, r3.id);
  await cleared(p, g3.id);
  await p
    .getByRole("alert")
    .filter({ hasText: "2 of 3 tracks removed" })
    .waitFor();
  await p.screenshot({
    path: path.resolve(".impeccable/review/multi-selection-partial.png"),
  });
  const partial = await snapshot(p);
  assert(partial.tracks.find((t) => t.id === bad.id).favorite);
  assert(
    partial.playlists
      .find((list) => list.id === bulkList.id)
      .trackIds.includes(bad.id),
  );
  assert.equal(
    await row(p, bad.id, true).getAttribute("aria-selected"),
    "true",
  );
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  assert.equal((await stat(bad.path)).isFile(), true);
  assert.deepEqual(
    await app.evaluate((_, calls) => globalThis.trashCalls.slice(calls), calls),
    [g3.path],
  );
  sql("UPDATE managed_imports SET status='done' WHERE trackId=?", bad.id);
  await play(p, r4);
  await selection(p, [r4.id, bad.id]);
  await confirm(p, r4.id, true);
  await cleared(p, r4.id);
  await cleared(p, bad.id);
  await stopped(p);
  // Partial success after Trash/SQLite failure preserves the failed identity and reports recovery.
  await play(p, dbbad);
  sql(
    `CREATE TRIGGER reject_bulk BEFORE DELETE ON tracks WHEN OLD.id='${dbbad.id}' BEGIN SELECT RAISE(ABORT,'injected bulk removal database failure'); END;`,
  );
  await p.getByRole("button", { name: "Show queue", exact: true }).click();
  await selection(p, [c.id, dbbad.id], true);
  await confirm(p, dbbad.id, true, 1, false, true);
  await cleared(p, c.id);
  await p
    .getByRole("alert")
    .filter({ hasText: "1 of 2 tracks removed" })
    .waitFor();
  await p
    .getByRole("alert")
    .filter({ hasText: "Restore it from Trash" })
    .waitFor();
  await p.waitForFunction(() => document.querySelector("audio").paused);
  const recoverable = await settled(
    p,
    (s) => s.tracks.find((t) => t.id === dbbad.id)?.missing,
  );
  assert(recoverable.tracks.find((t) => t.id === dbbad.id).favorite);
  assert(
    recoverable.playlists
      .find((list) => list.id === bulkList.id)
      .trackIds.includes(dbbad.id),
  );
  sql("DROP TRIGGER reject_bulk");
  await app.close();
  p = await launch();
  await nav(p, "Songs");
  await menu(p, dbbad.id);
  await select(path.join(root, "Bulk originals", "Bulk M5 database.wav"));
  await clickMenu("track-locate");
  await settled(p, (s) => !s.tracks.find((t) => t.id === dbbad.id).missing);
  await play(p, dbbad);
  await confirm(p, dbbad.id, true);
  await cleared(p, dbbad.id);
  await stopped(p);
  assert.deepEqual(
    (await snapshot(p)).tracks.map((t) => t.id),
    [d.id],
  );
  console.log(
    "MULTI_SELECTION: pointer/keyboard/range/context/shared views; reference/managed/mixed counts/cancel; partial outcomes/recovery; real playback and OS Trash passed",
  );
}
try {
  let p = await launch();
  await select(library);
  await p
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await p.getByRole("heading", { name: "Your library starts here." }).waitFor();
  await select(incoming);
  await p
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  const s = await settled(p, (s) => s.tracks.length === 4);
  const [a, b, c, d] = ["A", "B", "C", "D"].map((prefix) =>
    s.tracks.find((t) => t.title === `${prefix} ${suffix}`),
  );
  const lists = await p.evaluate(
    async ({ a, b, c }) => {
      const first = await window.rio.createPlaylist("Removal first"),
        second = await window.rio.createPlaylist("Removal second");
      await window.rio.playlistTracks(first.id, [a, b, c]);
      await window.rio.playlistTracks(second.id, [c, a, b]);
      await window.rio.favorite(a);
      return [first, second];
    },
    { a: a.id, b: b.id, c: c.id },
  );
  await p.reload();
  await nav(p, "Songs");
  await play(p, a);
  await nav(p, lists[0].name);
  await menu(p, a.id, true);
  await clickMenu("track-remove-playlist");
  await settled(
    p,
    (s) =>
      !s.playlists
        .find((list) => list.id === lists[0].id)
        .trackIds.includes(a.id),
  );
  await row(p, a.id).waitFor({ state: "detached" });
  const removed = await snapshot(p);
  assert(removed.tracks.find((t) => t.id === a.id).favorite);
  assert.deepEqual(
    removed.playlists.find((l) => l.id === lists[1].id).trackIds,
    [c.id, a.id, b.id],
  );
  assert.equal(removed.state.currentId, a.id);
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  assert.equal(await app.evaluate(() => globalThis.confirmations.length), 0);
  await row(p, c.id).click();
  await row(p, b.id).click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 2);
  await confirm(p, b.id, false, 0, true);
  assert.equal(await app.evaluate(() => globalThis.trashCalls.length), 0);
  // The collection action removes both selected memberships, preserving the other playlist and playback.
  await clickMenu("track-remove-playlist");
  await settled(
    p,
    (s) =>
      s.playlists.find((list) => list.id === lists[0].id).trackIds.length === 0,
  );
  const multiRemoved = await snapshot(p);
  assert.equal(multiRemoved.tracks.length, 4);
  assert.deepEqual(
    multiRemoved.playlists.find((list) => list.id === lists[1].id).trackIds,
    [c.id, a.id, b.id],
  );
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  await nav(p, "Songs");
  await selection(p, [b.id, c.id]);
  await menu(p, c.id);
  await clickMenu(`playlist-${lists[0].id}`);
  await settled(
    p,
    (s) =>
      s.playlists.find((list) => list.id === lists[0].id).trackIds.length === 2,
  );
  await nav(p, lists[0].name);
  await row(p, b.id).click();
  await confirm(p, b.id, false, 1, true);
  await cleared(p, b.id);
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 0);
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  noRelationships(b.id);
  // The playlist relationship is never inferred from the overall navigation view.
  await nav(p, lists[1].name);
  await p.getByRole("searchbox", { name: "Search library" }).fill(a.title);
  await menu(p, a.id);
  await p.getByRole("searchbox", { name: "Search library" }).fill("");
  for (const view of ["Songs", "Albums", "Artists", "Genres", "Favourites"]) {
    await nav(p, view);
    if (view === "Albums")
      await p.getByRole("button", { name: "Track list", exact: true }).click();
    if (view === "Artists")
      await p
        .locator(".group-list button")
        .filter({ hasText: "Removal artist" })
        .click();
    if (view === "Genres")
      await p
        .locator(".group-list button")
        .filter({ hasText: "Ambient" })
        .click();
    await menu(p, a.id);
  }
  await confirm(p, a.id, false);
  await cleared(p, a.id);
  await stopped(p);
  noRelationships(a.id);
  await app.close();
  p = await launch();
  const afterRestart = await settled(p, (s) => s.tracks.length === 2);
  assert.deepEqual(
    new Set(afterRestart.tracks.map((t) => t.id)),
    new Set([c.id, d.id]),
  );
  assert(
    afterRestart.playlists.every(
      (list) => JSON.stringify(list.trackIds) === JSON.stringify([c.id]),
    ),
  );
  await stopped(p);
  // Configure through the real main/preload APIs; no test-only production bypass.
  await select(media);
  await p.evaluate(async () => {
    await window.rio.chooseMediaRoot();
    await window.rio.saveMediaSettings({ copyOnAdd: true });
  });
  await nav(p, "Songs");
  await select(managedInputs);
  await p
    .getByRole("button", { name: "Add music", exact: true })
    .first()
    .click();
  const managed = await settled(p, (s) => s.tracks.length === 4);
  const m1 = managed.tracks.find((t) => t.title.startsWith("Managed one")),
    m2 = managed.tracks.find((t) => t.title.startsWith("Managed two"));
  assert.equal(m1.locationKind, "managed");
  assert.equal(m2.locationKind, "managed");
  await p.evaluate(
    async ({ ids, lists }) => {
      for (const id of ids) {
        await window.rio.favorite(id);
        for (const list of lists) await window.rio.addToPlaylist(list, [id]);
      }
    },
    { ids: [m1.id, m2.id], lists: lists.map((l) => l.id) },
  );
  await p.reload();
  await nav(p, "Songs");
  await play(p, m1);
  const managedHash = sha(await readFile(m1.path));
  await confirm(p, m1.id, true, 0);
  assert.equal(sha(await readFile(m1.path)), managedHash);
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  await app.evaluate(() => {
    globalThis.failTrash = true;
  });
  await confirm(p, m1.id, true);
  await p
    .getByRole("alert")
    .filter({ hasText: "Injected Trash unavailable" })
    .waitFor();
  assert.equal(sha(await readFile(m1.path)), managedHash);
  const failed = await snapshot(p);
  assert(failed.tracks.find((t) => t.id === m1.id).favorite);
  assert(failed.playlists.every((l) => l.trackIds.includes(m1.id)));
  assert.equal(failed.state.currentId, m1.id);
  assert.equal(await app.evaluate(() => globalThis.trashSuccesses.length), 0);
  await app.evaluate(() => {
    globalThis.failTrash = false;
  });
  // A forged DB pathname must not reach even the guarded Trash adapter.
  const calls = await app.evaluate(() => globalThis.trashCalls.length);
  sql(
    "UPDATE tracks SET path=? WHERE id=?",
    path.join(managedInputs, "Managed one.wav"),
    m1.id,
  );
  await confirm(p, m1.id, true);
  await p
    .getByRole("alert")
    .filter({ hasText: "managed copy receipt" })
    .waitFor();
  assert.equal(await app.evaluate(() => globalThis.trashCalls.length), calls);
  sql("UPDATE tracks SET path=? WHERE id=?", m1.path, m1.id);
  await p.reload();
  await nav(p, "Songs");
  await play(p, m1);
  await confirm(p, m1.id, true);
  await cleared(p, m1.id);
  await stopped(p);
  await assert.rejects(stat(m1.path), { code: "ENOENT" });
  assert.deepEqual(await app.evaluate(() => globalThis.trashSuccesses), [
    m1.path,
  ]);
  noRelationships(m1.id);
  // Prove truthful recovery when Trash succeeded but SQLite cleanup failed.
  await play(p, m2);
  sql(
    "CREATE TRIGGER reject_removal BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT,'injected removal database failure'); END;",
  );
  await confirm(p, m2.id, true);
  await p
    .getByRole("alert")
    .filter({
      hasText:
        "file was moved to the Trash, but its library entry could not be removed",
    })
    .waitFor();
  const partial = await settled(
    p,
    (s) => s.tracks.find((t) => t.id === m2.id)?.missing,
  );
  assert(partial.tracks.find((t) => t.id === m2.id).favorite);
  assert(partial.playlists.every((l) => l.trackIds.includes(m2.id)));
  await p.waitForFunction(() => document.querySelector("audio").paused);
  await assert.rejects(stat(m2.path), { code: "ENOENT" });
  sql("DROP TRIGGER reject_removal");
  await app.close();
  p = await launch();
  await nav(p, "Songs");
  await menu(p, m2.id);
  await select(path.join(managedInputs, "Managed two.wav"));
  await clickMenu("track-locate");
  await settled(p, (s) => !s.tracks.find((t) => t.id === m2.id).missing);
  await play(p, m2);
  await confirm(p, m2.id, true);
  await cleared(p, m2.id);
  await stopped(p);
  noRelationships(m2.id);
  await app.close();
  p = await launch();
  const final = await settled(p, (s) => s.tracks.length === 2);
  assert.deepEqual(
    new Set(final.tracks.map((t) => t.id)),
    new Set([c.id, d.id]),
  );
  assert(
    final.playlists.every(
      (l) => JSON.stringify(l.trackIds) === JSON.stringify([c.id]),
    ),
  );
  await stopped(p);
  // Multi-selection uses the same real menu/IPC/Trash route and isolated library.
  await bulkAcceptance(p, { c, d });
  for (const [file, before] of originals) {
    assert.equal(sha(await readFile(file)), before.hash, file);
    assert.equal((await stat(file)).mtimeMs, before.mtime, file);
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "playlist-only removal preserves library, other playlist, favourite and real playback",
          "playlist deletion and non-playlist menu exposure including global search from a playlist",
          "referenced and managed native confirmation options, pending and cancellation zero mutation",
          "complete identity, playlist, favourite, queue, current decoder and media-session cleanup",
          "queued deletion preserves unrelated real playback",
          "managed Trash failure and forged external path retain identity and sources",
          "real Electron OS Trash for sacrificial receipt-validated managed copies",
          "post-Trash database failure retains recoverable identity, restart and Locate/retry",
          "immediate UI refresh, restart persistence, source SHA-256 and mtimes unchanged",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    "REMOVAL_FAILURE",
    await app
      ?.firstWindow()
      .then((p) => p.locator("body").innerText())
      .catch(() => "unavailable"),
  );
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
