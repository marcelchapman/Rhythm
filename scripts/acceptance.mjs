import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Library } from "../dist/domain/library.js";
import { wavFixture } from "../tests/fixtures.ts";
const root = await mkdtemp(path.join(tmpdir(), "rio-acceptance-"));
const library = path.join(root, "Library"),
  music = path.join(root, "Audio"),
  appData = path.join(root, "AppData"),
  review = path.resolve(".impeccable/review");
await mkdir(music);
await mkdir(appData);
await mkdir(review, { recursive: true });
const sources = new Map();
async function source(
  filename,
  title,
  artist = "Ensemble A",
  genre = "Ambient",
) {
  const bytes = wavFixture({ title, artist, genre, seconds: 30 });
  await writeFile(filename, bytes);
  sources.set(filename, createHash("sha256").update(bytes).digest("hex"));
}
async function playlist(filename, text) {
  await writeFile(filename, text, "utf8");
  sources.set(filename, createHash("sha256").update(text).digest("hex"));
}
const a = path.join(music, "Alpha 音楽.wav"),
  b = path.join(music, "Beta song.wav"),
  c = path.join(music, "Gamma.wav");
await source(a, "Alpha");
await source(b, "Beta", "Ensemble B");
await source(c, "Gamma", "Ensemble A", "Jazz");
const cold = path.join(root, "Cold start.m3u8");
await playlist(cold, `#EXTM3U\n${c}\n${a}\n${b}\n`);
// Seed the same valid media configuration as desktop new-library creation.
// A bare programmatic open intentionally leaves existing libraries needing recovery.
const l = await Library.open(library, { setupMediaRoot: true });
// Compare values across IPC, which normalizes SQLite row prototypes.
const mediaSettings = structuredClone(l.mediaSettings());
assert.equal(mediaSettings.setupError, undefined);
assert.equal(mediaSettings.root?.path, path.join(l.directory, "Rio Media"));
assert.equal(mediaSettings.copyOnAdd, false);
await l.scan([music]);
l.db.prepare("INSERT INTO settings VALUES('views',?)").run(
  JSON.stringify({
    version: 1,
    songs: { columns: { order: ["artist", "title", "duration"] } },
  }),
);
const ids = Object.fromEntries(l.tracks().map((t) => [t.title, t.id]));
const canonical = l.directory;
l.close();
await writeFile(
  path.join(appData, "library.json"),
  JSON.stringify({ libraryPath: canonical }),
);
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
async function launch(files = [], data = appData) {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: files }
      : { args: [".", ...files] }),
    env: { ...process.env, RIO_DATA_DIR: data },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  return page;
}
const snapshot = (page) => page.evaluate(() => window.rio.snapshot());
async function waitSnapshot(page, predicate) {
  for (let i = 0; i < 100; i++) {
    const state = await snapshot(page);
    if (predicate(state)) return state;
    await page.waitForTimeout(100);
  }
  throw Error("Snapshot did not converge");
}
const headerOrder = (page) =>
  page
    .locator(".songs-header [data-column-id]")
    .evaluateAll((els) => els.map((e) => e.dataset.columnId));
const rowIds = (page) =>
  page
    .locator(".song-row")
    .evaluateAll((els) => els.map((e) => e.dataset.trackId));
async function metadataOnly(page) {
  const shape = await page.locator(".songs-table").evaluate((table) => {
    const headers = [...table.querySelectorAll('[role="columnheader"]')];
    const rows = [...table.querySelectorAll(".song-row")];
    return {
      columns: headers.length,
      announced: Number(table.getAttribute("aria-colcount")),
      metadataHeaders: headers.every((el) => !!el.dataset.columnId),
      rowCells: rows.map((row) => row.querySelectorAll('[role="cell"]').length),
      options: table.querySelectorAll('[aria-label^="Options for "]').length,
      width: table.getBoundingClientRect().width,
      metadataWidth: headers.reduce(
        (sum, el) => sum + el.getBoundingClientRect().width,
        0,
      ),
      gridColumns: getComputedStyle(
        table.querySelector(".songs-header"),
      ).gridTemplateColumns.split(" ").length,
      rightEdge: rows.map(
        (row) =>
          row.lastElementChild.getBoundingClientRect().right -
          row.getBoundingClientRect().right,
      ),
    };
  });
  assert(
    shape.metadataHeaders,
    "Every header must represent a metadata column",
  );
  assert.equal(shape.announced, shape.columns);
  assert.equal(
    shape.gridColumns,
    shape.columns,
    "No reserved action grid track",
  );
  assert(
    shape.rowCells.every((count) => count === shape.columns),
    "No extra action cells",
  );
  assert.equal(
    shape.options,
    0,
    "No Track List ellipsis controls, including on hover",
  );
  assert.equal(
    shape.width,
    shape.metadataWidth,
    "Table width is metadata widths only",
  );
  assert(
    shape.rightEdge.every((gap) => Math.abs(gap) < 1),
    "Rows end at their final visible metadata cell",
  );
}
async function noModal(page) {
  await page.locator(".modal-backdrop").waitFor({ state: "hidden" });
  assert.equal(
    await page.getByRole("dialog").count(),
    0,
    "No dialog may block table interaction",
  );
  assert.equal(
    await page.locator(".modal-backdrop").count(),
    0,
    "Modal backdrop must be removed",
  );
}
async function closeSettings(page) {
  const modal = page.getByRole("dialog", {
    name: "Library settings",
    exact: true,
  });
  await modal
    .getByRole("button", { name: "Close dialog", exact: true })
    .click();
  await noModal(page);
}
async function settings(page) {
  await page
    .getByRole("button", { name: "Library settings", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: "Library settings", exact: true })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 1);
}
async function openFile(filename) {
  const canonical = await realpath(filename);
  await app.evaluate(
    ({ app }, files) => {
      for (const file of files)
        app.emit("open-file", { preventDefault() {} }, file);
    },
    [filename, canonical],
  );
}
try {
  let page = await launch([cold]);
  let state = await waitSnapshot(page, (s) =>
    s.playlists.some((p) => p.name === "Cold start"),
  );
  const coldList = state.playlists.find((p) => p.name === "Cold start");
  assert.deepEqual(
    state.mediaSettings,
    mediaSettings,
    "Cold-start library reuses its persisted valid media root",
  );
  await page.getByRole("table", { name: "Cold start", exact: true }).waitFor();
  await noModal(page);
  await page
    .locator(".song-row")
    .first()
    .hover({ position: { x: 10, y: 15 } });
  await metadataOnly(page);
  assert.deepEqual(await rowIds(page), [ids.Gamma, ids.Alpha, ids.Beta]);
  assert.deepEqual((await headerOrder(page)).slice(0, 3), [
    "artist",
    "title",
    "duration",
  ]);
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await page
    .getByRole("combobox", { name: "Sort library", exact: true })
    .selectOption("recent");
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await page
    .getByRole("columnheader", { name: "Artist", exact: true })
    .getByRole("button")
    .click();
  await page
    .getByRole("navigation", { name: "Playlists", exact: true })
    .getByRole("button", { name: "Cold start", exact: true })
    .click();
  assert.deepEqual(
    await rowIds(page),
    [ids.Gamma, ids.Alpha, ids.Beta],
    "Songs sort must not change playlist order",
  );
  await page
    .locator('[data-column-id="album"]')
    .dragTo(page.locator('[data-column-id="artist"]'), {
      targetPosition: { x: 5, y: 12 },
    });
  await waitSnapshot(
    page,
    (s) => s.preferences.trackList.columns.order[0] === "album",
  );
  const sortBefore = await page
    .getByRole("columnheader", { name: "Album", exact: true })
    .getAttribute("aria-sort");
  const handle = page.getByRole("separator", {
    name: "Resize Album",
    exact: true,
  });
  const bounds = await handle.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 15);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width / 2 + 72, bounds.y + 15, {
    steps: 6,
  });
  await page.screenshot({ path: path.join(review, "tracklist-resizing.png") });
  await page.mouse.up();
  state = await waitSnapshot(
    page,
    (s) => (s.preferences.trackList.columns.widths.album ?? 0) > 230,
  );
  const width = state.preferences.trackList.columns.widths.album;
  assert.equal(
    width,
    242,
    "Final width must match the pointer release position",
  );
  assert.equal(
    await page
      .getByRole("columnheader", { name: "Album", exact: true })
      .getAttribute("aria-sort"),
    sortBefore,
    "Resize must not sort",
  );
  await settings(page);
  assert.equal(
    await page
      .getByRole("checkbox", { name: /actions|options|ellipsis/i })
      .count(),
    0,
  );
  assert(
    await page
      .getByRole("checkbox", { name: "Title", exact: true })
      .isDisabled(),
  );
  await page.getByRole("checkbox", { name: "Album", exact: true }).uncheck();
  await page.getByRole("checkbox", { name: "Comments", exact: true }).uncheck();
  await waitSnapshot(
    page,
    (s) =>
      s.preferences.trackList.columns.hidden.includes("album") &&
      s.preferences.trackList.columns.hidden.includes("comments"),
  );
  await page.screenshot({ path: path.join(review, "tracklist-settings.png") });
  await closeSettings(page);
  assert.equal(await page.locator('[data-column-id="album"]').count(), 0);
  const sharedOrder = await headerOrder(page);
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await metadataOnly(page);
  assert.deepEqual(await headerOrder(page), sharedOrder);
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await page
    .locator(".group-list button")
    .filter({ hasText: "Ensemble A" })
    .click();
  await page.getByRole("table", { name: "Ensemble A", exact: true }).waitFor();
  await metadataOnly(page);
  assert.deepEqual(await headerOrder(page), sharedOrder);
  assert.deepEqual(await rowIds(page), [ids.Alpha, ids.Gamma]);
  await page.screenshot({ path: path.join(review, "tracklist-artist.png") });
  await page.getByRole("button", { name: "Genres", exact: true }).click();
  await page.locator(".group-list button").filter({ hasText: "Jazz" }).click();
  await page.getByRole("table", { name: "Jazz", exact: true }).waitFor();
  await metadataOnly(page);
  assert.deepEqual(await headerOrder(page), sharedOrder);
  assert.deepEqual(await rowIds(page), [ids.Gamma]);
  await page.screenshot({ path: path.join(review, "tracklist-genre.png") });
  await settings(page);
  await page.getByRole("checkbox", { name: "Album", exact: true }).check();
  await waitSnapshot(
    page,
    (s) => !s.preferences.trackList.columns.hidden.includes("album"),
  );
  await closeSettings(page);
  assert.equal((await headerOrder(page))[0], "album");
  assert.equal(
    Math.round(
      (await page.locator('[data-column-id="album"]').boundingBox()).width,
    ),
    width,
  );
  await page
    .getByRole("navigation", { name: "Playlists", exact: true })
    .getByRole("button", { name: "Cold start", exact: true })
    .click();
  assert.deepEqual(await rowIds(page), [ids.Gamma, ids.Alpha, ids.Beta]);
  await page
    .getByRole("columnheader", { name: "Title", exact: true })
    .getByRole("button")
    .click();
  assert.deepEqual(await rowIds(page), [ids.Alpha, ids.Beta, ids.Gamma]);
  await page
    .getByRole("button", { name: "Playlist order", exact: true })
    .click();
  assert.deepEqual(await rowIds(page), [ids.Gamma, ids.Alpha, ids.Beta]);
  await page.screenshot({ path: path.join(review, "tracklist-playlist.png") });
  await page
    .locator(".songs-viewport")
    .evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await metadataOnly(page);
  await page.screenshot({
    path: path.join(review, "tracklist-right-edge.png"),
  });
  await page.locator(".songs-viewport").evaluate((el) => (el.scrollLeft = 0));
  const dropped1 = path.join(root, "Dropped mix.m3u8"),
    dropped2 = path.join(root, "Second mix.m3u"),
    d = path.join(root, "Delta new.wav"),
    loose = path.join(root, "Loose song.wav"),
    folder = path.join(root, "Dropped folder");
  await source(d, "Delta", "Ensemble C");
  await source(loose, "Echo");
  await mkdir(folder);
  await mkdir(path.join(folder, "Nested"));
  await source(path.join(folder, "Nested", "F.wav"), "Foxtrot");
  await playlist(dropped1, `#EXTM3U\n${c}\n${a}\n`);
  await playlist(dropped2, `#EXTM3U\n./Delta new.wav\n${b}\nmissing.wav\n`);
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    input.id = "acceptance-files";
    document.body.append(input);
  });
  const cdp = await page.context().newCDPSession(page);
  const { root: doc } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: doc.nodeId,
    selector: "#acceptance-files",
  });
  await cdp.send("DOM.setFileInputFiles", {
    nodeId,
    files: [dropped1, dropped2, loose, folder],
  });
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    for (const file of document.querySelector("#acceptance-files").files)
      transfer.items.add(file);
    document.querySelector(".app-shell").dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  state = await waitSnapshot(
    page,
    (s) =>
      s.tracks.length === 6 && s.playlists.some((p) => p.name === "Second mix"),
  );
  assert(!state.tracks.some((t) => ["m3u", "m3u8"].includes(t.format)));
  assert.deepEqual(
    state.playlists.find((p) => p.name === "Dropped mix").trackIds,
    [ids.Gamma, ids.Alpha],
  );
  assert.deepEqual(
    state.playlists
      .find((p) => p.name === "Second mix")
      .trackIds.map((id) => state.tracks.find((t) => t.id === id).title),
    ["Delta", "Beta"],
  );
  await page.getByText("View playlist issues", { exact: true }).click();
  await page.getByText(/File unavailable.*missing.wav/).waitFor();
  await page.screenshot({
    path: path.join(review, "playlist-drop-report.png"),
  });
  await cdp.detach();
  const running = path.join(root, "Running open.m3u8");
  await playlist(running, `#EXTM3U\n${b}\n${c}\n`);
  await openFile(running);
  state = await waitSnapshot(page, (s) =>
    s.playlists.some((p) => p.name === "Running open"),
  );
  assert.equal(
    state.playlists.filter((p) => p.name.startsWith("Running open")).length,
    1,
  );
  await page
    .getByRole("table", { name: "Running open", exact: true })
    .waitFor();
  assert.deepEqual(await rowIds(page), [ids.Beta, ids.Gamma]);
  const presentation = state.preferences;
  await settings(page);
  await page.getByRole("checkbox", { name: "Year", exact: true }).uncheck();
  presentation.trackList.columns.hidden = [
    ...presentation.trackList.columns.hidden,
    "year",
  ];
  // Quit immediately after a preference edit; normal shutdown must flush pending writes.
  await app.close();
  app = undefined;
  page = await launch();
  state = await snapshot(page);
  assert.deepEqual(state.mediaSettings, mediaSettings);
  await noModal(page);
  assert.deepEqual(state.preferences, presentation);
  assert.deepEqual(state.playlists.find((p) => p.id === coldList.id).trackIds, [
    ids.Gamma,
    ids.Alpha,
    ids.Beta,
  ]);
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await metadataOnly(page);
  assert.equal((await headerOrder(page))[0], "album");
  assert.equal(await page.locator('[data-column-id="comments"]').count(), 0);
  assert.equal(
    Math.round(
      (await page.locator('[data-column-id="album"]').boundingBox()).width,
    ),
    width,
  );
  await page.screenshot({ path: path.join(review, "tracklist-songs.png") });
  await page
    .getByRole("table", { name: "Songs", exact: true })
    .getByRole("button", { name: "Favourite Alpha", exact: true })
    .click();
  await page.getByRole("button", { name: "Favourites", exact: true }).click();
  await page.getByRole("table", { name: "Favourites", exact: true }).waitFor();
  await metadataOnly(page);
  const search = page.getByRole("searchbox", { name: "Search library" });
  await search.fill("Alpha");
  await page
    .getByRole("table", { name: "Search results", exact: true })
    .waitFor();
  await metadataOnly(page);
  await search.fill("");
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 720),
  );
  await page.waitForFunction(() => innerWidth === 1050);
  await page.screenshot({ path: path.join(review, "tracklist-1050.png") });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1464, 940),
  );
  await page.waitForFunction(() => innerWidth === 1464);
  if (process.platform === "darwin") {
    const reopen = path.join(root, "Window reopened.m3u");
    await playlist(reopen, `${a}\n`);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    const newWindow = app.waitForEvent("window");
    await openFile(reopen);
    page = await newWindow;
    await page.waitForSelector("h1");
    await waitSnapshot(page, (s) =>
      s.playlists.some((p) => p.name === "Window reopened"),
    );
  }
  await app.close();
  app = undefined;
  // Cold start without a remembered library must retain the request through first-run setup.
  const freshData = path.join(root, "FreshData");
  await mkdir(freshData);
  page = await launch([cold], freshData);
  await page.getByText(/playlist is waiting/).waitFor();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, library);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  state = await waitSnapshot(page, (s) =>
    s.playlists.some((p) => p.name === "Cold start (2)"),
  );
  assert.deepEqual(
    state.playlists.find((p) => p.name === "Cold start (2)").trackIds,
    [ids.Gamma, ids.Alpha, ids.Beta],
  );
  assert.deepEqual(state.mediaSettings, mediaSettings);
  await page
    .getByRole("table", { name: "Cold start (2)", exact: true })
    .waitFor();
  await noModal(page);
  for (const [filename, hash] of sources)
    assert.equal(
      createHash("sha256")
        .update(await readFile(filename))
        .digest("hex"),
      hash,
    );
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "valid persisted media root at cold start, restart and first-run selection",
          "Settings open/close removes dialog and backdrop before table interaction",
          "legacy global preference migration",
          "pointer resize without sort",
          "global order/width/visibility",
          "hidden column restoration",
          "metadata-only headers/cells/widths and clean right edge",
          "Songs/playlist/Artist/Genre/Favourites/search Track Lists",
          "playlist semantic order and local sort reset",
          "mixed playlist/audio/folder drop",
          "playlist references never become audio",
          "cold-start file queue",
          "running open-file delivery and duplicate protection",
          "window reopen on macOS",
          "first-run deferred import",
          "restart persistence",
          "unchanged audio and input playlist hashes",
        ],
      },
      null,
      2,
    ),
  );
} catch (e) {
  if (app)
    await app
      .firstWindow()
      .then((page) =>
        page.screenshot({ path: path.join(review, "acceptance-failure.png") }),
      )
      .catch(() => {});
  throw e;
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
