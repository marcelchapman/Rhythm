import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
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
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../dist/domain/library.js";
import { parseM3U } from "../dist/domain/m3u.js";
import { wavFixture } from "../tests/fixtures.ts";

const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rhythm-playlist-menu-")),
);
const folder = path.join(root, "Library"),
  media = path.join(root, "Media"),
  review = path.resolve(".impeccable/review");
const originals = new Map();
const executable =
  process.env.RHYTHM_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rhythm.app/Contents/MacOS/Rhythm"
          : "release/linux-unpacked/rhythm-desktop",
      )
    : undefined);
let app, page, l;
const snapshot = () => page.evaluate(() => window.rhythm.snapshot());
const sidebar = (name) =>
  page.locator(".playlist-nav").getByRole("button", { name, exact: true });
const row = (id) => page.locator(`.song-row[data-track-id="${id}"]`);
const nav = (name) =>
  page.locator(".sidebar").getByRole("button", { name, exact: true }).click();
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await page.waitForTimeout(50);
  }
  throw Error("Playlist menu state did not converge");
}
async function idle() {
  await page.waitForFunction(
    () => !document.querySelector(".sidebar-bottom button").disabled,
  );
}
async function launch() {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: { ...process.env, RHYTHM_DATA_DIR: path.join(root, "Profile") },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForSelector("h1");
  // Native macOS window constraints can start below the 1050px breakpoint,
  // which intentionally hides history controls. Exercise history at a known size.
  const initialWidth = await page.evaluate(() => innerWidth);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1464, 940),
  );
  await page.waitForFunction(() => innerWidth === 1464);
  await page.getByRole("button", { name: "Go back", exact: true }).waitFor();
  console.log("PLAYLIST_MENU_VIEWPORT", { initialWidth, width: 1464 });
  await app.evaluate(({ Menu, dialog, shell }) => {
    globalThis.playlistMenu = null;
    globalThis.playlistDialogs = [];
    globalThis.playlistSaves = [];
    globalThis.playlistTrash = [];
    Menu.prototype.popup = function (options) {
      globalThis.playlistMenu = this;
      globalThis.playlistMenuWindow = options.window.id;
    };
    dialog.showMessageBox = async (_win, options) => {
      globalThis.playlistDialogs.push(options);
      return new Promise(
        (resolve) =>
          (globalThis.resolvePlaylistDialog = (response) =>
            resolve({ response, checkboxChecked: false })),
      );
    };
    dialog.showSaveDialog = async (_win, options) => {
      globalThis.playlistSaves.push(options);
      return new Promise(
        (resolve) =>
          (globalThis.resolvePlaylistSave = (result) => resolve(result)),
      );
    };
    shell.trashItem = async (filename) => {
      globalThis.playlistTrash.push(filename);
      throw Error("TEST SAFETY: playlist actions must never Trash media");
    };
  });
}
async function menu(name, keyboard = false) {
  await app.evaluate(() => {
    globalThis.playlistMenu = null;
  });
  if (keyboard) {
    await sidebar(name).focus();
    await sidebar(name).press("Shift+F10");
  } else await sidebar(name).click({ button: "right" });
  await until(() => app.evaluate(() => !!globalThis.playlistMenu));
  const items = await app.evaluate(({ BrowserWindow }) => ({
    window: globalThis.playlistMenuWindow,
    current: BrowserWindow.getAllWindows()[0].id,
    items: globalThis.playlistMenu.items.map((item) => ({
      id: item.id,
      label: item.label,
      enabled: item.enabled,
    })),
  }));
  assert.equal(items.window, items.current);
  assert.deepEqual(items.items, [
    { id: "playlist-export", label: "Export Playlist…", enabled: true },
    { id: "playlist-duplicate", label: "Duplicate Playlist", enabled: true },
    { id: "playlist-delete", label: "Delete Playlist…", enabled: true },
  ]);
}
async function click(id) {
  await app.evaluate((_, id) => {
    const item = globalThis.playlistMenu.getMenuItemById(id);
    if (!item?.enabled) throw Error(`Unavailable menu ${id}`);
    item.click(undefined, undefined, {});
  }, id);
}
async function contextIs(name) {
  await page.getByRole("heading", { name, exact: true }).waitFor();
}
async function exported(source, destination, invoke, cancel = false, failure) {
  const before = await snapshot(),
    entries = await readdir(root);
  const noticesBefore = await page
    .locator('.workspace > .notice[role="status"]')
    .allTextContents();
  const calls = await app.evaluate(() => globalThis.playlistSaves.length);
  await invoke();
  await until(() =>
    app.evaluate(
      (_, calls) => globalThis.playlistSaves.length === calls + 1,
      calls,
    ),
  );
  const options = await app.evaluate(() => globalThis.playlistSaves.at(-1));
  // The native Save dialog is pending: export must not add a preparatory banner.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  assert.deepEqual(
    await page.locator('.workspace > .notice[role="status"]').allTextContents(),
    noticesBefore,
  );
  assert.equal(options.defaultPath, `${source.name}.m3u8`);
  assert.deepEqual(options.filters, [
    { name: "UTF-8 M3U playlist", extensions: ["m3u8"] },
  ]);
  await app.evaluate((_, result) => globalThis.resolvePlaylistSave(result), {
    canceled: cancel,
    filePath: destination,
  });
  await idle();
  assert.deepEqual((await snapshot()).playlists, before.playlists);
  assert.deepEqual((await snapshot()).tracks, before.tracks);
  if (cancel) {
    await assert.rejects(stat(destination), { code: "ENOENT" });
    assert.deepEqual(await readdir(root), entries);
  } else if (failure) {
    await page.getByRole("alert").filter({ hasText: failure }).waitFor();
    assert.deepEqual(await readdir(root), entries);
  } else {
    const bytes = await readFile(destination);
    assert(bytes.toString().startsWith("#EXTM3U\n"));
    const tracks = new Map(before.tracks.map((t) => [t.id, t]));
    assert.deepEqual(
      parseM3U(bytes, destination).entries.map((e) => e.path),
      source.trackIds.map((id) => tracks.get(id).path),
    );
  }
}
async function deleted(source, accept = true, toolbar = false) {
  const before = await snapshot(),
    calls = await app.evaluate(() => globalThis.playlistDialogs.length);
  const noticesBefore = await page
    .locator('.workspace > .notice[role="status"]')
    .allTextContents();
  if (toolbar)
    await page
      .getByRole("button", { name: "Delete playlist", exact: true })
      .click();
  else {
    await menu(source.name);
    await click("playlist-delete");
  }
  await until(() =>
    app.evaluate(
      (_, calls) => globalThis.playlistDialogs.length === calls + 1,
      calls,
    ),
  );
  const options = await app.evaluate(() => globalThis.playlistDialogs.at(-1));
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
  assert.deepEqual(
    await page.locator('.workspace > .notice[role="status"]').allTextContents(),
    noticesBefore,
  );
  assert.equal(options.title, "Delete Playlist");
  assert.equal(options.message, `Delete “${source.name}”?`);
  assert(options.detail.includes("songs remain in your library"));
  assert(options.detail.includes("audio files stay unchanged"));
  assert.deepEqual(options.buttons, ["Cancel", "Delete Playlist"]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.deepEqual((await snapshot()).playlists, before.playlists);
  assert.deepEqual((await snapshot()).tracks, before.tracks);
  // The existing operation lock also protects the native confirmation's library.
  await assert.rejects(
    page.evaluate(() => window.rhythm.chooseLibrary()),
    /Wait for/,
  );
  await app.evaluate(
    (_, response) => globalThis.resolvePlaylistDialog(response),
    accept ? 1 : 0,
  );
  await idle();
  if (accept) {
    await sidebar(source.name).waitFor({ state: "detached" });
    assert.deepEqual(
      (await snapshot()).playlists,
      before.playlists.filter((p) => p.id !== source.id),
    );
    const db = new DatabaseSync(path.join(folder, "rhythm.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM playlist_tracks WHERE playlistId=?",
          )
          .get(source.id).n,
        0,
      );
    } finally {
      db.close();
    }
  } else assert.deepEqual((await snapshot()).playlists, before.playlists);
  assert.deepEqual((await snapshot()).tracks, before.tracks);
  assert.deepEqual((await snapshot()).state.queue, before.state.queue);
  assert.equal((await snapshot()).state.currentId, before.state.currentId);
  assert.deepEqual(await app.evaluate(() => globalThis.playlistTrash), []);
}
async function playing(id) {
  await row(id).dblclick();
  await page.waitForFunction((id) => {
    const audio = document.querySelector("audio");
    return (
      audio.currentSrc.endsWith(id) && !audio.paused && audio.currentTime > 0.2
    );
  }, id);
  await until(async () => (await snapshot()).state.currentId === id);
}
async function unchangedPlayback(id) {
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), false);
  assert.equal((await snapshot()).state.currentId, id);
}
try {
  await mkdir(media);
  await mkdir(review, { recursive: true });
  l = await Library.open(folder);
  await l.chooseMediaRoot(media);
  for (const [title, managed] of [
    ["Alpha", false],
    ["Beta", false],
    ["Gamma", true],
  ]) {
    const file = path.join(root, `${title}${managed ? " 音楽" : ""}.wav`),
      bytes = wavFixture({ title, seconds: 120 });
    await writeFile(file, bytes);
    originals.set(file, { bytes, mtime: (await stat(file)).mtimeMs });
    l.saveMediaSettings({ copyOnAdd: managed });
    assert.deepEqual((await l.add([file])).errors, []);
  }
  const tracks = l.tracks(),
    a = tracks.find((t) => t.title === "Alpha"),
    b = tracks.find((t) => t.title === "Beta"),
    c = tracks.find((t) => t.title === "Gamma");
  for (const t of tracks)
    originals.set(t.path, {
      bytes: await readFile(t.path),
      mtime: (await stat(t.path)).mtimeMs,
    });
  const open = l.createPlaylist("Open list", [a.id, b.id]),
    target = l.createPlaylist("Target 音楽", [c.id, a.id]),
    empty = l.createPlaylist("Empty");
  l.close();
  l = null;
  await launch();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, folder);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await nav(open.name);
  await contextIs(open.name);
  await playing(a.id);
  await row(a.id).click();
  await row(b.id).click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  const selected = await page
    .locator('.song-row[aria-selected="true"]')
    .evaluateAll((rows) => rows.map((r) => r.dataset.trackId));
  assert.equal(selected.length, 2);
  await menu(target.name);
  await contextIs(open.name);
  assert.deepEqual(
    await page
      .locator('.song-row[aria-selected="true"]')
      .evaluateAll((rows) => rows.map((r) => r.dataset.trackId)),
    selected,
  );
  await exported(
    target,
    path.join(root, "cancelled.m3u8"),
    () => click("playlist-export"),
    true,
  );
  await contextIs(open.name);
  await menu(target.name);
  await exported(target, path.join(root, "target.m3u8"), () =>
    click("playlist-export"),
  );
  await contextIs(open.name);
  await unchangedPlayback(a.id);
  await exported(open, path.join(root, "open.m3u8"), () =>
    app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        .items.find((i) => i.label === "File")
        .submenu.items.find((i) => i.label === "Export Playlist…")
        .click(),
    ),
  );
  // A failed write must still show the existing actionable error, without a new status system.
  const invalidOutput = path.join(root, "not-a-file.m3u8");
  await mkdir(invalidOutput);
  await menu(target.name);
  await exported(
    target,
    invalidOutput,
    () => click("playlist-export"),
    false,
    "regular playlist file",
  );
  const copies = [];
  for (const suffix of [" copy", " copy 2", " copy 3"]) {
    await menu(target.name, suffix === " copy 2");
    await click("playlist-duplicate");
    await sidebar(target.name + suffix).waitFor();
    await idle();
    const copy = (await snapshot()).playlists.find(
      (p) => p.name === target.name + suffix,
    );
    assert(copy);
    assert.notEqual(copy.id, target.id);
    assert.deepEqual(copy.trackIds, target.trackIds);
    copies.push(copy);
    await contextIs(open.name);
    assert.deepEqual((await snapshot()).tracks, tracks);
    await unchangedPlayback(a.id);
  }
  // Real track-menu infrastructure stays separate from sidebar playlist actions.
  await app.evaluate(() => {
    globalThis.playlistMenu = null;
  });
  await row(a.id).click({ button: "right" });
  await until(() => app.evaluate(() => !!globalThis.playlistMenu));
  assert(
    await app.evaluate(
      () => !!globalThis.playlistMenu.getMenuItemById("track-playlist"),
    ),
  );
  assert.equal(
    await app.evaluate(
      () => !!globalThis.playlistMenu.getMenuItemById("playlist-duplicate"),
    ),
    false,
  );
  // Exercise the existing shared drag payload and sidebar drop handlers.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row(b.id).dispatchEvent("dragstart", { dataTransfer: transfer });
  await sidebar(copies[0].name).dispatchEvent("dragover", {
    dataTransfer: transfer,
  });
  await sidebar(copies[0].name).dispatchEvent("drop", {
    dataTransfer: transfer,
  });
  await row(b.id).dispatchEvent("dragend", { dataTransfer: transfer });
  await until(async () => {
    const p = (await snapshot()).playlists.find((p) => p.id === copies[0].id);
    return p.trackIds.includes(b.id);
  });
  assert.deepEqual(
    (await snapshot()).playlists.find((p) => p.id === copies[0].id).trackIds,
    [c.id, a.id, b.id],
  );
  assert.deepEqual(
    (await snapshot()).playlists.find((p) => p.id === target.id).trackIds,
    target.trackIds,
  );
  assert.deepEqual(
    (await snapshot()).playlists.find((p) => p.id === open.id).trackIds,
    open.trackIds,
  );
  await app.close();
  app = null;
  await launch();
  // Restart restores the current view, not its navigation history. Establish a
  // distinct previous route before checking deletion's history reconciliation.
  await sidebar(open.name).waitFor();
  await nav("Songs");
  await contextIs("Songs");
  await nav(open.name);
  await contextIs(open.name);
  const back = page.getByRole("button", { name: "Go back", exact: true }),
    forward = page.getByRole("button", { name: "Go forward", exact: true });
  assert.equal(await back.isEnabled(), true);
  assert.equal(await forward.isEnabled(), false);
  for (const copy of copies) await sidebar(copy.name).waitFor();
  assert.deepEqual(
    (await snapshot()).playlists.find((p) => p.id === copies[0].id).trackIds,
    [c.id, a.id, b.id],
  );
  await playing(a.id);
  await deleted(target, false);
  await contextIs(open.name);
  await unchangedPlayback(a.id);
  await deleted(target, true);
  await contextIs(open.name);
  await unchangedPlayback(a.id);
  await deleted(open, false, true);
  await contextIs(open.name);
  await deleted(open, true);
  await contextIs("Playlists");
  await unchangedPlayback(a.id);
  await back.click();
  // The heading stays Playlists for the sanitized deleted route. An enabled
  // Forward button proves that Back has actually moved the history index.
  await forward.and(page.locator(":enabled")).waitFor();
  await contextIs("Playlists");
  await back.click();
  await contextIs("Songs");
  await forward.click();
  await contextIs("Playlists");
  await forward.click();
  await forward.and(page.locator(":disabled")).waitFor();
  await contextIs("Playlists");
  await until(async () => (await snapshot()).state.view === "Playlists");
  await nav("Songs");
  await deleted(empty, true);
  await contextIs("Songs");
  await unchangedPlayback(a.id);
  for (const name of [
    "Songs",
    "Albums",
    "Artists",
    "Genres",
    "Favourites",
    "Recently Added",
  ]) {
    await app.evaluate(() => {
      globalThis.playlistMenu = null;
    });
    await page
      .locator(".sidebar")
      .getByRole("button", { name, exact: true })
      .click({ button: "right" });
    await snapshot();
    assert.equal(await app.evaluate(() => globalThis.playlistMenu), null);
  }
  await assert.rejects(
    page.evaluate(() => window.rhythm.duplicatePlaylist("stale-playlist")),
    /no longer exists/,
  );
  await assert.rejects(
    page.evaluate(() => window.rhythm.showPlaylistMenu("stale-playlist")),
    /no longer exists/,
  );
  await nav(copies[0].name);
  await deleted(copies[0], true, true);
  await contextIs("Playlists");
  await until(async () => (await snapshot()).state.view === "Playlists");
  await app.close();
  app = null;
  await launch();
  await contextIs("Playlists");
  const persisted = await snapshot();
  assert.equal(persisted.playlists.length, 2);
  assert(
    !persisted.playlists.some((p) =>
      [open.id, target.id, empty.id, copies[0].id].includes(p.id),
    ),
  );
  for (const copy of copies.slice(1))
    assert.deepEqual(
      persisted.playlists.find((p) => p.id === copy.id).trackIds,
      target.trackIds,
    );
  assert.deepEqual(persisted.tracks, tracks);
  assert.deepEqual(await app.evaluate(() => globalThis.playlistTrash), []);
  for (const [file, before] of originals) {
    assert.deepEqual(await readFile(file), before.bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtime);
  }
  await page.screenshot({
    path: path.join(review, "playlist-menu-result.png"),
  });
  console.log(
    "PLAYLIST_MENUS: exact native/sidebar/keyboard targets, shared ordered M3U8 export/cancel, independent copies/naming/restart, native delete/cancel/current/background routes, playback, built-in exclusion, track menus/drag-drop and unchanged referenced/managed audio passed",
  );
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      "PLAYLIST_MENU_FAILURE",
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    await page
      .screenshot({ path: path.join(review, "playlist-menu-failure.png") })
      .catch(() => {});
  }
  throw error;
} finally {
  l?.close();
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
