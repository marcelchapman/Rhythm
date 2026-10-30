import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { wavFixture } from "../tests/fixtures.ts";
const root = await mkdtemp(path.join(tmpdir(), "rio-column-playlist-test-"));
const library = path.join(root, "Library"),
  music = path.join(root, "Audio files"),
  review = path.resolve(".impeccable/review");
await mkdir(library);
await mkdir(music);
await mkdir(review, { recursive: true });
const sources = new Map();
async function source(file, title, artist) {
  const bytes = wavFixture({ title, artist, seconds: 30 });
  await writeFile(file, bytes);
  sources.set(file, createHash("sha256").update(bytes).digest("hex"));
}
const first = path.join(music, "音楽 Café.wav"),
  second = path.join(music, "Second song.wav"),
  third = path.join(root, "Unindexed recording.wav");
await source(first, "First song", "Zed ensemble");
await source(second, "Second song", "A ensemble");
await source(third, "New recording", "B ensemble");
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
    env: { ...process.env, RIO_DATA_DIR: path.join(root, "AppData") },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  return page;
}
const snapshot = (page) => page.evaluate(() => window.rio.snapshot());
async function waitSnapshot(page, predicate) {
  for (let i = 0; i < 100; i++) {
    const s = await snapshot(page);
    if (predicate(s)) return s;
    await page.waitForTimeout(100);
  }
  throw Error("Snapshot did not converge");
}
async function choose(file) {
  await app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
}
async function command(label) {
  await app.evaluate(({ Menu }, label) => {
    const file = Menu.getApplicationMenu().items.find(
      (item) => item.label === "File",
    );
    const item = file.submenu.items.find((item) => item.label === label);
    if (!item) throw Error(`Missing File > ${label}`);
    item.click();
  }, label);
}
try {
  let page = await launch();
  await choose(library);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your library starts here." })
    .waitFor();
  await choose(music);
  await page
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  await waitSnapshot(page, (s) => s.tracks.length === 2);
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  const headers = () => page.locator(".songs-header [data-column-id]");
  const order = async () =>
    headers().evaluateAll((els) => els.map((el) => el.dataset.columnId));
  assert.deepEqual((await order()).slice(0, 3), [
    "title",
    "duration",
    "artist",
  ]);
  // Exercise an actual pointer drag, not an API replacement of preferences.
  const artistHeader = page.locator('[data-column-id="artist"]');
  const titleHeader = page.locator('[data-column-id="title"]');
  const from = await artistHeader.boundingBox();
  const to = await titleHeader.boundingBox();
  assert(from && to);
  await artistHeader.getByRole("button").hover();
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + 12, {
    steps: 3,
  });
  // Wait for React's drag state before entering/dropping on the target.
  await page.locator('[data-column-id="artist"].column-dragging').waitFor();
  await page.mouse.move(to.x + 5, to.y + 12, { steps: 10 });
  await page.mouse.move(to.x + 6, to.y + 12);
  await page.locator('[data-column-id="title"].column-drop-before').waitFor();
  await page.mouse.up();
  const moved = await waitSnapshot(
    page,
    (s) => s.preferences.trackList.columns.order[0] === "artist",
  );
  assert.deepEqual((await order()).slice(0, 3), [
    "artist",
    "title",
    "duration",
  ]);
  assert.equal(
    await page
      .getByRole("columnheader", { name: "Title", exact: true })
      .getAttribute("aria-sort"),
    "ascending",
    "Dragging must not toggle sort",
  );
  // Capture drag feedback with the real component handlers and a shared HTML5 transfer.
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator('[data-column-id="duration"]')
    .getByRole("button")
    .dispatchEvent("dragstart", { dataTransfer: transfer });
  const target = page.locator('[data-column-id="album"]');
  const bounds = await target.boundingBox();
  await target.dispatchEvent("dragover", {
    dataTransfer: transfer,
    clientX: bounds.x + 2,
    clientY: bounds.y + 12,
  });
  assert((await target.getAttribute("class")).includes("column-drop-before"));
  await page.screenshot({ path: path.join(review, "columns-dragging.png") });
  await page
    .locator('[data-column-id="duration"]')
    .getByRole("button")
    .dispatchEvent("dragend", { dataTransfer: transfer });
  await app.close();
  app = undefined;
  page = await launch();
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  assert.deepEqual(await order(), moved.preferences.trackList.columns.order);
  await page
    .getByRole("columnheader", { name: "Artist", exact: true })
    .getByRole("button")
    .click();
  assert.equal(
    await page
      .getByRole("columnheader", { name: "Artist", exact: true })
      .getAttribute("aria-sort"),
    "ascending",
  );
  const rows = page.locator(".song-row");
  assert((await rows.first().innerText()).includes("Second song"));
  await page.locator(".songs-viewport").focus();
  await page.keyboard.press("Home");
  await page.keyboard.press("ArrowDown");
  assert.equal(
    await page.locator('.song-row[aria-selected="true"]').count(),
    1,
  );
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return !a.paused && a.currentTime > 0;
  });
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // Native context infrastructure still accepts the reordered rows.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.__rioTestMenu = this;
    };
  });
  await rows.first().click({ button: "right" });
  assert(
    await app.evaluate(
      () => !!globalThis.__rioTestMenu.getMenuItemById("track-playlist"),
    ),
  );
  for (const label of ["Dismiss import report", "Dismiss message"])
    if (await page.getByRole("button", { name: label, exact: true }).count())
      await page.getByRole("button", { name: label, exact: true }).click();
  await page.screenshot({ path: path.join(review, "columns-reordered.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 720),
  );
  await page.waitForFunction(() => innerWidth === 1050);
  await page.screenshot({ path: path.join(review, "columns-1050.png") });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1464, 940),
  );
  await page.waitForFunction(() => innerWidth === 1464);
  const input = path.join(root, "Daily mix.m3u");
  await writeFile(
    input,
    `\uFEFF#EXTM3U\r\n#EXTINF:30,Second song\r\n./Audio files/Second song.wav\r\n${third}\r\n./Audio files/音楽 Café.wav\r\nmissing.wav\r\n#IGNORED:value\r\n`,
  );
  await choose(input);
  await command("Import Playlist…");
  let state = await waitSnapshot(page, (s) =>
    s.playlists.some((p) => p.name === "Daily mix"),
  );
  await page.getByRole("heading", { name: "Daily mix", exact: true }).waitFor();
  const imported = state.playlists.find((p) => p.name === "Daily mix");
  assert.deepEqual(
    imported.trackIds.map((id) => state.tracks.find((t) => t.id === id).title),
    ["Second song", "New recording", "First song"],
  );
  await page.getByText("View playlist issues", { exact: true }).click();
  await page.getByText(/missing.wav/).waitFor();
  await page.screenshot({
    path: path.join(review, "playlist-import-report.png"),
  });
  const output = path.join(root, "Exported 音楽.m3u8");
  await app.evaluate(({ dialog }, filename) => {
    dialog.showSaveDialog = async () => ({
      canceled: false,
      filePath: filename,
    });
  }, output);
  await command("Export Playlist…");
  await page.getByText("Exported 3 songs as M3U8.", { exact: true }).waitFor();
  const exported = await readFile(output, "utf8");
  assert(exported.startsWith("#EXTM3U\n"));
  assert(exported.includes("./Audio files/音楽 Café.wav"));
  await choose(output);
  await command("Import Playlist…");
  state = await waitSnapshot(page, (s) =>
    s.playlists.some((p) => p.name === "Exported 音楽"),
  );
  assert.deepEqual(
    state.playlists.find((p) => p.name === "Exported 音楽").trackIds,
    imported.trackIds,
  );
  // Export outside a playlist gets the small explicit selection dialog.
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await command("Export Playlist…");
  await page
    .getByRole("heading", { name: "Export playlist", exact: true })
    .waitFor();
  await page
    .getByLabel("Playlist to export", { exact: true })
    .selectOption(imported.id);
  await page.screenshot({
    path: path.join(review, "playlist-export-picker.png"),
  });
  await app.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true });
  });
  await page.getByRole("button", { name: "Export…", exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector(".sidebar-bottom button").disabled,
  );
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  const count = (await snapshot(page)).playlists.length;
  await app.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  await command("Import Playlist…");
  await page.waitForFunction(
    () => !document.querySelector(".sidebar-bottom button").disabled,
  );
  assert.equal((await snapshot(page)).playlists.length, count);
  await app.close();
  app = undefined;
  page = await launch();
  state = await snapshot(page);
  assert.deepEqual(
    state.playlists.find((p) => p.id === imported.id).trackIds,
    imported.trackIds,
  );
  assert.deepEqual(
    state.preferences.trackList.columns.order,
    moved.preferences.trackList.columns.order,
  );
  for (const [file, hash] of sources)
    assert.equal(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
      hash,
    );
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "pointer header drag",
          "drag feedback",
          "column order restart",
          "sorting and keyboard playback",
          "context menu",
          "File playlist import/export",
          "relative/absolute Unicode paths",
          "unknown audio indexing",
          "missing entry report",
          "round trip order",
          "export chooser",
          "dialog cancellation",
          "playlist restart",
          "source hashes",
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
        page.screenshot({ path: path.join(review, "interchange-failure.png") }),
      )
      .catch(() => {});
  throw e;
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
