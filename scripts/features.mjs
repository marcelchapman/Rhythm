import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Library } from "../dist/domain/library.js";
import { wavFixture } from "../tests/fixtures.ts";
import {
  collectionTotals,
  collectionSummaryText,
} from "../src/shared/collection-summary.ts";
const root = await mkdtemp(path.join(tmpdir(), "rio-feature-test-"));
const library = path.join(root, "Library");
const music = path.join(root, "Music");
const review = path.resolve(".impeccable/review");
await mkdir(library);
await mkdir(music);
await mkdir(review, { recursive: true });
const sources = new Map();
async function source(file, options) {
  const bytes = wavFixture({ seconds: 30, ...options });
  await writeFile(file, bytes);
  sources.set(file, createHash("sha256").update(bytes).digest("hex"));
}
for (let i = 1; i <= 12; i++)
  await source(path.join(music, `${i}.wav`), {
    title: `Recording ${String(i).padStart(2, "0")}`,
    artist: i % 2 ? "Studio ensemble" : "Field ensemble",
    album: "Sessions",
    bpm: i % 3 ? 90 + i : undefined,
    comments:
      i === 1
        ? "Original session notes. These long values should truncate cleanly without changing row height."
        : "",
  });
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
  throw new Error("Library state did not converge");
}
const selectFolder = (folder) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, folder);
async function createPlaylist(page, name) {
  await page
    .getByRole("textbox", { name: "Playlist name" })
    .pressSequentially(name);
  await page
    .getByRole("button", { name: "Create playlist", exact: true })
    .last()
    .click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
}
async function menuClick(id) {
  await app.evaluate((_electron, id) => {
    const item = globalThis.__rioTestMenu?.getMenuItemById(id);
    if (!item) throw Error(`Menu action ${id} missing`);
    item.click();
  }, id);
}
async function compactSelectionAcceptance(page) {
  const primary = process.platform === "darwin" ? "Meta" : "Control";
  const panel = page.locator(".detail-panel");
  const list = () => panel.getByRole("listbox");
  const row = (id) => panel.locator(`[data-detail-track-id="${id}"]`);
  const selected = () =>
    panel
      .locator('.track-row[aria-selected="true"]')
      .evaluateAll((rows) => rows.map((row) => row.dataset.detailTrackId));
  async function context(id) {
    await app.evaluate(() => {
      globalThis.__rioTestMenu = null;
    });
    await row(id).click({ button: "right" });
    for (let i = 0; i < 100; i++) {
      if (await app.evaluate(() => !!globalThis.__rioTestMenu)) return;
      await page.waitForTimeout(50);
    }
    throw Error("Compact context menu did not appear");
  }
  await app.evaluate(({ BrowserWindow, shell }) => {
    const contents = BrowserWindow.getAllWindows()[0].webContents;
    const send = contents.send.bind(contents);
    globalThis.compactActions = [];
    contents.send = (channel, ...args) => {
      if (channel === "track:action") globalThis.compactActions.push(args[0]);
      return send(channel, ...args);
    };
    globalThis.compactReveals = [];
    shell.showItemInFolder = (filename) =>
      globalThis.compactReveals.push(filename);
  });
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Albums", exact: true })
    .click();
  await page.locator(".album-cover").first().click();
  const order = await panel
    .locator(".track-row")
    .evaluateAll((rows) => rows.map((row) => row.dataset.detailTrackId));
  assert(order.length >= 3);
  const [a, b, c] = order;
  await row(b).hover();
  assert.equal(
    await panel.getByRole("button", { name: /^Options for / }).count(),
    0,
  );
  const layout = await panel.locator(".track-row").evaluateAll((rows) =>
    rows.map((row) => {
      const duration = row.querySelector(".track-duration");
      return {
        children: [...row.children].map((child) => child.className),
        trailingSpace:
          row.getBoundingClientRect().right -
          duration.getBoundingClientRect().right,
        padding: parseFloat(getComputedStyle(row).paddingRight),
      };
    }),
  );
  for (const row of layout) {
    assert.deepEqual(row.children, [
      "track-play",
      "track-title",
      "track-duration",
    ]);
    assert(
      Math.abs(row.trailingSpace - row.padding) < 1,
      "duration must end at row padding without an action strip",
    );
  }
  const before = await page
    .locator("audio")
    .evaluate((audio) => ({ src: audio.src, paused: audio.paused }));
  await row(a).locator(".track-title").click();
  assert.deepEqual(await selected(), [a]);
  await row(b)
    .locator(".track-title")
    .click({ modifiers: [primary] });
  assert.deepEqual(await selected(), [a, b]);
  await row(a)
    .locator(".track-title")
    .click({ modifiers: [primary] });
  assert.deepEqual(await selected(), [b]);
  await row(a).locator(".track-title").click();
  await row(c)
    .locator(".track-title")
    .click({ modifiers: ["Shift"] });
  assert.deepEqual(await selected(), order.slice(0, 3));
  assert.deepEqual(
    await page
      .locator("audio")
      .evaluate((audio) => ({ src: audio.src, paused: audio.paused })),
    before,
  );
  await context(b);
  assert.deepEqual(await selected(), order.slice(0, 3));
  await page.screenshot({
    path: path.join(review, "album-detail-selection.png"),
  });
  const mix = await page.evaluate(() =>
    window.rio.createPlaylist("Detail selection mix"),
  );
  await context(b);
  await menuClick(`playlist-${mix.id}`);
  await waitSnapshot(
    page,
    (s) => s.playlists.find((p) => p.id === mix.id)?.trackIds.length === 3,
  );
  assert.deepEqual(
    (await snapshot(page)).playlists.find((p) => p.id === mix.id).trackIds,
    order.slice(0, 3),
  );
  // Repeating native playlist addition preserves selection and does not duplicate membership.
  const bTrack = (await snapshot(page)).tracks.find((t) => t.id === b);
  await context(b);
  await menuClick(`playlist-${mix.id}`);
  assert.deepEqual(
    (await snapshot(page)).playlists.find((p) => p.id === mix.id).trackIds,
    order.slice(0, 3),
  );
  // Single-track commands retain the clicked row even inside a group.
  await context(b);
  await menuClick("track-info");
  await page.getByRole("dialog", { name: "Track Info", exact: true }).waitFor();
  assert.deepEqual(
    await app.evaluate(() => globalThis.compactActions.at(-1).trackIds),
    [b],
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  assert.deepEqual(await selected(), order.slice(0, 3));
  if (process.platform === "darwin") {
    await context(b);
    await menuClick("track-reveal");
    await page.waitForFunction(
      () => !document.querySelector('[role="dialog"]'),
    );
    assert.deepEqual(
      await app.evaluate(() => globalThis.compactActions.at(-1).trackIds),
      [b],
    );
    for (let i = 0; i < 100; i++) {
      if (await app.evaluate(() => globalThis.compactReveals.length)) break;
      await page.waitForTimeout(50);
    }
    assert.deepEqual(await app.evaluate(() => globalThis.compactReveals), [
      bTrack.path,
    ]);
  }
  await context(order[3]);
  assert.deepEqual(await selected(), [order[3]]);
  await row(b)
    .locator(".track-title")
    .click({ modifiers: ["Shift"] });
  assert.deepEqual(await selected(), order.slice(1, 4));
  await list().press("Home");
  await list().press("Shift+ArrowDown");
  await list().press("Shift+ArrowDown");
  assert.deepEqual(await selected(), order.slice(0, 3));
  await list().press("Shift+ArrowUp");
  assert.deepEqual(await selected(), order.slice(0, 2));
  const transfer = await page.evaluateHandle(() => new DataTransfer());
  await row(b).dispatchEvent("dragstart", { dataTransfer: transfer });
  assert.deepEqual(
    await transfer.evaluate((transfer) =>
      JSON.parse(transfer.getData("application/x-rio-track-ids")),
    ),
    [a, b],
  );
  await transfer.dispose();
  await list().press("Shift+F10");
  await menuClick("track-info");
  await page.getByRole("dialog", { name: "Track Info", exact: true }).waitFor();
  assert.deepEqual(
    await app.evaluate(() => globalThis.compactActions.at(-1).trackIds),
    [b],
  );
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await row(a).locator(".track-title").dblclick();
  await page.waitForFunction((id) => {
    const audio = document.querySelector("audio");
    return (
      audio.currentSrc.endsWith(id) && !audio.paused && audio.currentTime > 0.2
    );
  }, a);
  const album = (await snapshot(page)).tracks.find((t) => t.id === a).albumId;
  const otherAlbum = (await snapshot(page)).tracks.find(
    (t) => t.albumId !== album,
  );
  await page
    .getByRole("button", {
      name: `Open ${otherAlbum.album} by ${otherAlbum.albumArtist}`,
      exact: true,
    })
    .click();
  assert.deepEqual(await selected(), []);
  await page.getByRole("button", { name: "Show queue", exact: true }).click();
  assert.deepEqual(await selected(), []);
  await row(b).hover();
  assert.equal(
    await panel.getByRole("button", { name: /^Options for / }).count(),
    0,
  );
  assert.equal(
    await panel.locator("[data-queue-remove]").count(),
    order.length,
  );
  assert.equal(await row(b).locator(":scope > *").count(), 4);
  assert.deepEqual(
    await panel
      .locator(".track-row")
      .evaluateAll((rows) => rows.map((row) => row.dataset.detailTrackId)),
    order,
  );
  await row(a).locator(".track-title").click();
  await row(b)
    .locator(".track-title")
    .click({ modifiers: [primary] });
  await context(b);
  assert.deepEqual(await selected(), [a, b]);
  await menuClick(`playlist-${mix.id}`);
  assert.deepEqual(
    await app.evaluate(() => globalThis.compactActions.at(-1).trackIds),
    [a, b],
  );
  const queueBefore = (await snapshot(page)).state.queue;
  await row(b)
    .getByRole("button", {
      name: `Remove ${bTrack.title} from queue`,
      exact: true,
    })
    .click();
  await waitSnapshot(page, (s) => !s.state.queue.includes(b));
  assert.deepEqual(
    (await snapshot(page)).state.queue,
    queueBefore.filter((id) => id !== b),
  );
  assert.deepEqual(await selected(), [a]);
  assert.equal(
    await page.locator("audio").evaluate((audio) => audio.paused),
    false,
  );
  await page.getByRole("button", { name: "Close queue", exact: true }).click();
  assert.deepEqual(await selected(), []);
  await page
    .locator(".sidebar")
    .getByRole("button", { name: "Songs", exact: true })
    .click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  console.log(
    "COMPACT_SELECTION: album/details and queue selection/context/drag/keyboard, collection actions, single Info/Finder and real playback passed",
  );
}
try {
  let page = await launch();
  if (process.platform === "darwin") {
    const items = await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu().items[0].submenu.items.map((item) => ({
        id: item.id,
        role: item.role?.toLowerCase(),
        type: item.type,
        label: item.label,
        accelerator: item.accelerator,
      })),
    );
    assert.deepEqual(
      items.map((i) => (i.type === "separator" ? i.type : i.role || i.id)),
      [
        "about",
        "app-settings",
        "separator",
        "hide",
        "hideothers",
        "unhide",
        "separator",
        "quit",
      ],
    );
    const settingsItem = items.find((i) => i.id === "app-settings");
    assert.equal(settingsItem.label, "Settings…");
    assert.equal(settingsItem.accelerator, "Cmd+,");
    const openSettings = () =>
      app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu().getMenuItemById("app-settings").click(),
      );
    const settingsDialog = () =>
      page.getByRole("dialog", { name: "Library settings", exact: true });
    await openSettings();
    await settingsDialog().waitFor();
    assert.equal(await settingsDialog().count(), 1);
    await settingsDialog()
      .getByText("No library configured", { exact: true })
      .waitFor();
    await openSettings();
    assert.equal(await settingsDialog().count(), 1);
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
    // The macOS application menu remains usable after closing the main window.
    const closed = page.waitForEvent("close");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await closed;
    const reopened = app.waitForEvent("window");
    await openSettings();
    page = await reopened;
    await settingsDialog().waitFor();
    await page
      .getByRole("button", { name: "Close dialog", exact: true })
      .click();
  } else {
    assert.equal(
      await app.evaluate(
        ({ Menu }) =>
          !!Menu.getApplicationMenu().getMenuItemById("app-settings"),
      ),
      false,
    );
  }
  await selectFolder(library);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your library starts here." })
    .waitFor();
  await selectFolder(music);
  await page
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  const initial = await waitSnapshot(page, (s) => s.tracks.length === 12);
  await page
    .getByRole("heading", { name: "Recently Added", exact: true })
    .waitFor();
  await page.getByRole("slider", { name: "Volume", exact: true }).press("Home");
  // Invoke the actual File-menu callback; native menu rendering is owned by Electron.
  await app.evaluate(({ Menu }) =>
    Menu.getApplicationMenu()
      .items.find((i) => i.label === "File")
      .submenu.items.find((i) => i.label === "New Playlist…")
      .click(),
  );
  await createPlaylist(page, "First mix");
  await page
    .getByText("Right-click a song to add it to this playlist.", {
      exact: true,
    })
    .waitFor();
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  const table = page.getByRole("table", { name: "Songs", exact: true });
  await table.waitFor();
  for (const label of [
    "Title",
    "Time",
    "BPM",
    "Comments",
    "Artist",
    "Album",
    "Genre",
    "Bit Rate",
    "Kind / Format",
    "Disc",
    "Track",
  ])
    assert(
      (await table
        .getByRole("columnheader", { name: label, exact: true })
        .count()) === 1,
      label,
    );
  const first = initial.tracks.find((t) => t.title === "Recording 01");
  const second = initial.tracks.find((t) => t.title === "Recording 02");
  assert.equal(first.bpm, 91);
  assert(first.comments.includes("Original session"));
  const row = () => page.locator(`[data-track-id="${first.id}"]`);
  await table
    .getByRole("columnheader", { name: "BPM", exact: true })
    .getByRole("button")
    .click();
  assert.equal(
    await table
      .getByRole("columnheader", { name: "BPM", exact: true })
      .getAttribute("aria-sort"),
    "ascending",
  );
  assert.equal(
    await page.locator(".song-row").first().getAttribute("data-track-id"),
    first.id,
  );
  await row().click();
  assert.equal(await row().getAttribute("aria-selected"), "true");
  await row().dblclick();
  await page.waitForFunction((id) => {
    const a = document.querySelector("audio");
    return a.currentSrc.endsWith(id) && !a.paused && a.currentTime > 0;
  }, first.id);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const firstMix = (await snapshot(page)).playlists.find(
    (p) => p.name === "First mix",
  );
  // Capture real native menus and dispatch their callbacks without OS popup automation.
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.__rioTestMenu = this;
    };
  });
  await page
    .locator(`.detail-panel [data-detail-track-id="${first.id}"]`)
    .click({ button: "right" });
  await menuClick(`playlist-${firstMix.id}`);
  await waitSnapshot(
    page,
    (s) => s.playlists.find((p) => p.id === firstMix.id)?.trackIds.length === 1,
  );
  await compactSelectionAcceptance(page);
  await row().click({ button: "right" });
  const labels = await app.evaluate(() =>
    globalThis.__rioTestMenu.items.map((i) => i.label),
  );
  for (const label of [
    "Play",
    "Play Next",
    "Add to Queue",
    "Add to Playlist",
    "Favourite",
  ])
    assert(labels.includes(label), label);
  await menuClick("track-play");
  await page.waitForFunction((id) => {
    const a = document.querySelector("audio");
    return a.currentSrc.endsWith(id) && !a.paused && a.currentTime > 0;
  }, first.id);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await row().click({ button: "right" });
  await menuClick(`playlist-${firstMix.id}`);
  assert.equal(
    (await snapshot(page)).playlists.find((p) => p.id === firstMix.id).trackIds
      .length,
    1,
    "Repeated additions must not duplicate songs",
  );
  await row().click({ button: "right" });
  await menuClick("track-favorite");
  await waitSnapshot(
    page,
    (s) => s.tracks.find((t) => t.id === first.id)?.favorite,
  );
  await row().click({ button: "right" });
  await menuClick("track-next");
  await page
    .locator(`[data-track-id="${second.id}"]`)
    .click({ button: "right" });
  await menuClick("track-queue");
  await waitSnapshot(page, (s) => s.state.queue.at(-1) === second.id);
  await page
    .locator(`[data-track-id="${second.id}"]`)
    .click({ button: "right" });
  await menuClick("track-next");
  await waitSnapshot(
    page,
    (s) =>
      s.state.queue[s.state.queue.indexOf(s.state.currentId) + 1] === second.id,
  );
  await row().click({ button: "right" });
  await menuClick("track-new-playlist");
  await createPlaylist(page, "Context mix");
  await waitSnapshot(page, (s) =>
    s.playlists
      .find((p) => p.name === "Context mix")
      ?.trackIds.includes(first.id),
  );
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await row().click();
  await page
    .locator(`[data-track-id="${second.id}"]`)
    .click({ modifiers: ["Shift"] });
  assert.equal(
    await page.locator('.song-row[aria-selected="true"]').count(),
    2,
  );
  // Right-clicking within the selection targets the whole group, not just that row.
  await page
    .locator(`[data-track-id="${second.id}"]`)
    .click({ button: "right" });
  assert.equal(
    await page.locator('.song-row[aria-selected="true"]').count(),
    2,
  );
  await menuClick(`playlist-${firstMix.id}`);
  await waitSnapshot(page, (s) => {
    const ids = s.playlists.find((p) => p.id === firstMix.id)?.trackIds;
    return (
      ids?.length === 2 && ids.includes(first.id) && ids.includes(second.id)
    );
  });
  // A right-click outside that group replaces selection and acts on the clicked track.
  const third = initial.tracks.find((t) => t.title === "Recording 03");
  await page
    .locator(`[data-track-id="${third.id}"]`)
    .click({ button: "right" });
  assert.deepEqual(
    await page
      .locator('.song-row[aria-selected="true"]')
      .evaluateAll((els) => els.map((el) => el.dataset.trackId)),
    [third.id],
  );
  await menuClick("track-favorite");
  await waitSnapshot(
    page,
    (s) => s.tracks.find((t) => t.id === third.id)?.favorite,
  );
  await row().click();
  await page
    .locator(`[data-track-id="${second.id}"]`)
    .click({ modifiers: ["Shift"] });
  // The existing keyboard context-menu shortcut remains usable without an action cell.
  await page.locator(".songs-viewport").press("Shift+F10");
  await menuClick(`playlist-${firstMix.id}`);
  assert.equal(
    await page.locator('.song-row[aria-selected="true"]').count(),
    2,
  );
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await page
    .locator(`[data-track-id="${second.id}"]`)
    .dispatchEvent("dragstart", { dataTransfer });
  const target = page
    .getByRole("navigation", { name: "Playlists", exact: true })
    .getByRole("button", { name: "First mix", exact: true });
  await target.dispatchEvent("dragover", { dataTransfer });
  // Dragover schedules a React render; event delivery does not await its commit.
  await target.and(page.locator(".drop-target")).waitFor({ timeout: 5000 });
  assert((await target.getAttribute("class")).includes("drop-target"));
  await target.dispatchEvent("drop", { dataTransfer });
  await waitSnapshot(
    page,
    (s) => s.playlists.find((p) => p.id === firstMix.id)?.trackIds.length === 2,
  );
  await target.dispatchEvent("drop", { dataTransfer });
  assert.equal(
    (await snapshot(page)).playlists.find((p) => p.id === firstMix.id).trackIds
      .length,
    2,
  );
  // Browser-backed File objects traverse the actual sandboxed preload's webUtils path extraction.
  const dropped = path.join(root, "Dropped recording.wav");
  await source(dropped, {
    title: "Dropped recording",
    bpm: 145,
    comments: "Imported by drop",
  });
  await page.evaluate(() => {
    const input = document.createElement("input");
    input.type = "file";
    input.id = "test-drop-file";
    document.body.append(input);
  });
  await page.locator("#test-drop-file").setInputFiles(dropped);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector("#test-drop-file").files[0]);
    document.querySelector(".app-shell").dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await waitSnapshot(page, (s) =>
    s.tracks.some((t) => t.title === "Dropped recording"),
  );
  const folder = path.join(root, "Dropped folder");
  await mkdir(folder);
  await mkdir(path.join(folder, "Nested"));
  await source(path.join(folder, "Nested", "song.wav"), {
    title: "Nested dropped song",
  });
  const cdp = await page.context().newCDPSession(page);
  const { root: documentRoot } = await cdp.send("DOM.getDocument");
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: documentRoot.nodeId,
    selector: "#test-drop-file",
  });
  await cdp.send("DOM.setFileInputFiles", { nodeId, files: [folder] });
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.items.add(document.querySelector("#test-drop-file").files[0]);
    document.querySelector(".app-shell").dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
  });
  await waitSnapshot(page, (s) =>
    s.tracks.some((t) => t.title === "Nested dropped song"),
  );
  await cdp.detach();
  await page.locator("#test-drop-file").evaluate((el) => el.remove());
  for (const label of ["Dismiss import report", "Dismiss message"])
    if (await page.getByRole("button", { name: label, exact: true }).count())
      await page.getByRole("button", { name: label, exact: true }).click();
  await page.locator(".songs-viewport").evaluate((el) => (el.scrollLeft = 0));
  await page.screenshot({ path: path.join(review, "songs-desktop.png") });
  await page
    .locator(".songs-viewport")
    .evaluate((el) => (el.scrollLeft = el.scrollWidth));
  await page.screenshot({ path: path.join(review, "songs-metadata.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 720),
  );
  await page.waitForFunction(() => window.innerWidth === 1050);
  await page.locator(".songs-viewport").evaluate((el) => (el.scrollLeft = 0));
  await page.screenshot({ path: path.join(review, "songs-1050.png") });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await app.close();
  app = undefined;
  // Persisted metadata, playlists, and favourites must survive a genuine restart.
  page = await launch();
  const restored = await waitSnapshot(page, (s) => s.tracks.length === 14);
  assert.deepEqual(
    restored.playlists.find((p) => p.id === firstMix.id).trackIds,
    [first.id, second.id],
  );
  assert(restored.tracks.find((t) => t.id === first.id).favorite);
  assert(restored.playlists.some((p) => p.name === "Context mix"));
  await app.close();
  app = undefined;
  const db = await Library.open(library);
  const template = db.tracks()[0];
  db.db.exec("BEGIN");
  const insert = db.db.prepare(
    "INSERT INTO tracks (id,path,title,artist,albumArtist,album,albumId,genre,year,disc,track,duration,addedAt,format,size,mtime,missing) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  );
  for (let i = 0; i < 10000; i++) {
    const file = path.join(root, "Synthetic benchmark", `${i}.wav`);
    insert.run(
      createHash("sha256").update(file).digest("hex"),
      file,
      `Benchmark ${String(i).padStart(5, "0")}`,
      template.artist,
      template.albumArtist,
      i < 230 ? "Large detail album" : `Benchmark album ${Math.floor(i / 10)}`,
      createHash("sha256")
        .update(
          i < 230
            ? "large-detail-album"
            : `benchmark-album-${Math.floor(i / 10)}`,
        )
        .digest("hex"),
      template.genre,
      2026,
      1,
      i,
      30,
      Date.now(),
      "wav",
      1,
      0,
      1,
    );
  }
  db.db.exec("COMMIT");
  db.close();
  const start = Date.now();
  page = await launch();
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await page.getByRole("table", { name: "Songs", exact: true }).waitFor();
  assert.equal(
    await page
      .getByRole("table", { name: "Songs", exact: true })
      .getAttribute("aria-rowcount"),
    "10015",
  );
  const benchmarkTracks = (await snapshot(page)).tracks;
  const benchmarkSummary = collectionSummaryText(
    collectionTotals(benchmarkTracks),
  );
  const summary = page.locator(".workspace > .collection-summary");
  assert.equal(await summary.innerText(), benchmarkSummary);
  assert(benchmarkSummary.startsWith("10,014 songs · "));
  await page
    .locator('[data-column-id="artist"]')
    .dragTo(page.locator('[data-column-id="title"]'), {
      targetPosition: { x: 5, y: 12 },
    });
  await page.waitForFunction(
    () =>
      document
        .querySelector(".songs-header [data-column-id]")
        ?.getAttribute("data-column-id") === "artist",
  );
  assert((await page.locator(".song-row").count()) < 80);
  await page
    .locator(".songs-viewport")
    .evaluate((el) => (el.scrollTop = el.scrollHeight));
  await page.waitForFunction(
    () => !!document.querySelector('[aria-rowindex="10015"]'),
  );
  await page
    .locator('.song-row[aria-rowindex="10015"]')
    .scrollIntoViewIfNeeded();
  const finalRow = await page
    .locator('.song-row[aria-rowindex="10015"]')
    .boundingBox();
  const footer = await summary.boundingBox();
  assert(
    finalRow && footer && finalRow.y + finalRow.height <= footer.y,
    "Final virtualized row must remain accessible above the summary",
  );
  console.log(
    "VIRTUAL_TABLE",
    JSON.stringify({
      tracks: 10014,
      renderedRows: await page.locator(".song-row").count(),
      launchAndScrollMs: Date.now() - start,
      summary: await summary.innerText(),
    }),
  );
  // Compact rendering retains its 200-row paging and displayed album order.
  await page.locator(".songs-viewport").evaluate((el) => {
    el.scrollTop = 0;
    el.scrollLeft = 0;
  });
  await page.waitForFunction(() =>
    document
      .querySelector(".song-row")
      ?.textContent.includes("Benchmark 00000"),
  );
  await page.locator(".song-row").first().click();
  const detail = page.locator(".detail-panel");
  await page.waitForFunction(
    () => document.querySelectorAll(".detail-panel .track-row").length === 200,
  );
  const expectedAlbumSummary = collectionSummaryText(
    collectionTotals(
      benchmarkTracks.filter((t) => t.album === "Large detail album"),
    ),
  );
  assert.equal(
    await page.locator(".detail-pane > .collection-summary").innerText(),
    expectedAlbumSummary,
  );
  const detailFirst = await detail
    .locator(".track-row")
    .first()
    .getAttribute("data-detail-track-id");
  await detail.locator(".track-row").first().locator(".track-title").click();
  await detail
    .getByRole("button", { name: "Show more tracks (200 of 230)", exact: true })
    .click();
  assert.equal(await detail.locator(".track-row").count(), 230);
  await detail
    .locator(".track-row")
    .nth(205)
    .locator(".track-title")
    .click({ modifiers: ["Shift"] });
  assert.equal(
    await detail.locator('.track-row[aria-selected="true"]').count(),
    206,
  );
  assert.equal(
    await detail
      .locator(".track-row")
      .first()
      .getAttribute("data-detail-track-id"),
    detailFirst,
  );
  assert((await detail.evaluate((el) => el.scrollTop)) > 0);
  assert.equal(await summary.innerText(), benchmarkSummary);
  assert.equal(
    await page.locator(".detail-pane > .collection-summary").innerText(),
    expectedAlbumSummary,
  );
  await detail.getByRole("listbox").press("Home");
  assert.equal(
    await detail.locator('.track-row[aria-selected="true"]').count(),
    1,
  );
  assert.equal(
    await detail.locator(".track-row").first().getAttribute("aria-selected"),
    "true",
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
          ...(process.platform === "darwin"
            ? ["native Settings menu, existing modal and closed-window reopen"]
            : ["macOS Settings menu absent on this platform"]),
          "compact lists have no ellipsis/reserved action strip; queue remove control preserved",
          "atomic duplicate-safe append",
          "native context commands",
          "right-click selection and keyboard context menu",
          "album/details and queue share selection, contextual action scopes and drag payloads",
          "File > New Playlist",
          "row selection and activation",
          "sortable metadata",
          "track-to-playlist drop",
          "file and recursive folder drops through preload",
          "restart persistence",
          "10000-row virtualization",
          "unchanged source bytes",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (app) {
    const page = app.windows()[0];
    if (page) {
      console.error(await page.locator(".notice").allTextContents());
      await page.screenshot({
        path: path.join(review, "features-failure.png"),
      });
    }
  }
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
