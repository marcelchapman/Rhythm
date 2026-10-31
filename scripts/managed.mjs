import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  realpath,
  rename,
  access,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { wavFixture } from "../tests/fixtures.ts";
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-managed-desktop-")),
);
const library = path.join(root, "Library"),
  media = path.join(library, "Rio Media"),
  sources = path.join(root, "Original music"),
  review = path.resolve(".impeccable/review");
for (const directory of [library, sources, review])
  await mkdir(directory, { recursive: true });
const hashes = new Map();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
async function fixture(name, options) {
  const filename = path.join(sources, name),
    bytes = wavFixture({ seconds: 30, ...options });
  await writeFile(filename, bytes);
  hashes.set(filename, sha(bytes));
  return filename;
}
const a = await fixture("first.wav", {
  title: "Angel",
  albumArtist: "Massive Attack",
  album: "Mezzanine",
  track: 1,
});
const b = await fixture("second.wav", {
  title: "Next song",
  artist: "Other artist",
});
const c = await fixture("playlist-only.wav", { title: "Playlist reference" });
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
const select = (folder) =>
  app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: !folder,
      filePaths: folder ? [folder] : [],
    });
  }, folder);
const snapshot = (page) => page.evaluate(() => window.rio.snapshot());
async function settled(page, predicate) {
  for (let i = 0; i < 100; i++) {
    const state = await snapshot(page);
    if (predicate(state)) return state;
    await page.waitForTimeout(100);
  }
  throw Error("Managed desktop state did not converge");
}
async function settings(page) {
  await page
    .getByRole("button", { name: "Library settings", exact: true })
    .first()
    .click();
  await page
    .getByRole("dialog", { name: "Library settings", exact: true })
    .waitFor();
}
const copy = (page) =>
  page.getByRole("checkbox", {
    name: "Copy files to Rio Media folder when adding to library",
    exact: true,
  });
const organized = (page) =>
  page.getByRole("checkbox", {
    name: "Keep Rio Media folder organized",
    exact: true,
  });
async function drop(page, files) {
  await page.evaluate(() => {
    const el = document.createElement("input");
    el.type = "file";
    el.multiple = true;
    el.id = "managed-drop";
    document.body.append(el);
  });
  await page.locator("#managed-drop").setInputFiles(files);
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    for (const file of document.querySelector("#managed-drop").files)
      transfer.items.add(file);
    document.querySelector(".app-shell").dispatchEvent(
      new DragEvent("drop", {
        bubbles: true,
        cancelable: true,
        dataTransfer: transfer,
      }),
    );
    document.querySelector("#managed-drop").remove();
  });
}
try {
  let page = await launch();
  await select(library);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your library starts here." })
    .waitFor();
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal((await snapshot(page)).mediaSettings.root.path, media);
  await access(media);
  await settings(page);
  assert(!(await copy(page).isDisabled()));
  assert(!(await copy(page).isChecked()));
  await page.screenshot({
    path: path.join(review, "managed-settings-empty.png"),
  });
  // Native chooser cancellation leaves settings intact.
  await select(null);
  await page
    .getByRole("button", { name: "Change Rio Media folder…", exact: true })
    .click();
  assert.equal((await snapshot(page)).mediaSettings.root.path, media);
  await select(library);
  await page
    .getByRole("button", { name: "Change Rio Media folder…", exact: true })
    .click();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  assert(
    !(await page.getByRole("dialog").getByRole("alert").innerText()).includes(
      "Error invoking remote method",
    ),
  );
  assert.equal((await snapshot(page)).mediaSettings.root.path, media);
  await page.screenshot({
    path: path.join(review, "managed-settings-error.png"),
  });
  await select(media);
  await page
    .getByRole("button", { name: "Change Rio Media folder…", exact: true })
    .click();
  await settled(page, (s) => s.mediaSettings.root?.path === media);
  await copy(page).check();
  await settled(page, (s) => s.mediaSettings.copyOnAdd);
  await page.screenshot({
    path: path.join(review, "managed-settings-enabled.png"),
  });
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  // Existing Add Music entry point, now copying only under explicit opt-in.
  await select(a);
  await page
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  let state = await settled(page, (s) => s.tracks.length === 1);
  const managed = state.tracks[0];
  assert.equal(managed.locationKind, "managed");
  assert.equal(
    managed.mediaRelativePath,
    "Massive Attack/Mezzanine/01 Angel.wav",
  );
  assert.equal(sha(await readFile(managed.path)), hashes.get(a));
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await page
    .getByRole("table", { name: "Songs", exact: true })
    .getByRole("button", { name: "Play Angel", exact: true })
    .click();
  await page.waitForFunction((id) => {
    const audio = document.querySelector("audio");
    return (
      audio.currentSrc &&
      new URL(audio.currentSrc).pathname.slice(1) === id &&
      !audio.paused &&
      audio.currentTime > 0
    );
  }, managed.id);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  // Repeat the external source and the copied file through the real drop/preload path.
  await drop(page, [a, managed.path]);
  await settled(
    page,
    (s) => s.tracks.length === 1 && s.mediaSettings.pendingImports === 0,
  );
  await settings(page);
  await organized(page).uncheck();
  await settled(page, (s) => !s.mediaSettings.keepOrganized);
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await drop(page, [b]);
  state = await settled(page, (s) => s.tracks.length === 2);
  const second = state.tracks.find((t) => t.title === "Next song");
  assert.equal(second.mediaRelativePath, "second.wav");
  const list = path.join(root, "Reference mix.m3u8");
  await writeFile(list, `${c}\n${a}\n`);
  hashes.set(list, sha(await readFile(list)));
  await drop(page, [list]);
  state = await settled(
    page,
    (s) => s.playlists.length === 1 && s.tracks.length === 3,
  );
  const referenced = state.tracks.find((t) => t.title === "Playlist reference");
  assert.equal(referenced.locationKind, "referenced");
  assert.equal(referenced.path, c);
  assert.deepEqual(state.playlists[0].trackIds, [referenced.id, managed.id]);
  await settings(page);
  await copy(page).uncheck();
  await settled(page, (s) => !s.mediaSettings.copyOnAdd);
  await page.screenshot({
    path: path.join(review, "managed-settings-referenced.png"),
  });
  await app.close();
  app = undefined;
  page = await launch();
  state = await snapshot(page);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.deepEqual(state.mediaSettings, {
    root: { id: managed.mediaRootId, path: media },
    copyOnAdd: false,
    keepOrganized: false,
    pendingImports: 0,
  });
  assert.equal(
    state.tracks.filter((t) => t.locationKind === "managed").length,
    2,
  );
  assert.equal(
    state.tracks.find((t) => t.id === managed.id).path,
    managed.path,
  );
  await settings(page);
  assert(!(await copy(page).isChecked()));
  assert(!(await organized(page).isChecked()));
  // Keyboard focus, Escape and compact desktop layout retain the existing modal model.
  await copy(page).focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Shift+Tab");
  assert(await copy(page).evaluate((el) => el === document.activeElement));
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 720),
  );
  await page.waitForFunction(() => innerWidth === 1050);
  await page
    .getByRole("heading", { name: "Rio Media folder", exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: path.join(review, "managed-settings-1050.png"),
  });
  assert(
    await page
      .getByRole("dialog")
      .evaluate((el) => el.scrollWidth <= el.clientWidth),
  );
  await page.keyboard.press("Escape");
  assert.equal(await page.getByRole("dialog").count(), 0);
  const d = await fixture("referenced-add.wav", { title: "Added in place" });
  await drop(page, [d]);
  state = await settled(page, (s) => s.tracks.length === 4);
  assert.equal(state.tracks.find((t) => t.title === "Added in place").path, d);
  assert.equal(
    state.tracks.find((t) => t.title === "Added in place").locationKind,
    "referenced",
  );
  // Missing stored media opens recovery, never recreates or substitutes its root.
  const savedRoot = (await snapshot(page)).mediaSettings.root;
  await app.close();
  app = undefined;
  const disconnected = path.join(root, "Reconnected media");
  await rename(media, disconnected);
  page = await launch();
  await page
    .getByRole("dialog", { name: "Library settings", exact: true })
    .waitFor();
  await page.getByRole("dialog").getByRole("alert").waitFor();
  state = await snapshot(page);
  assert.deepEqual(state.mediaSettings.root, savedRoot);
  assert(state.mediaSettings.setupError);
  await assert.rejects(access(media));
  await select(disconnected);
  await page
    .getByRole("button", { name: "Change Rio Media folder…", exact: true })
    .click();
  state = await settled(
    page,
    (s) => s.mediaSettings.root?.path === disconnected,
  );
  assert.equal(state.mediaSettings.setupError, undefined);
  assert.equal(await page.getByRole("dialog").getByRole("alert").count(), 0);
  await page.screenshot({
    path: path.join(review, "managed-settings-recovered.png"),
  });
  // Exercise real library switching in one profile/renderer, including a custom root.
  async function switchLibrary(directory) {
    if (!(await page.getByRole("dialog").count())) await settings(page);
    await mkdir(directory, { recursive: true });
    await select(directory);
    await page
      .getByRole("button", { name: "Choose or switch library…", exact: true })
      .click();
    const next = await settled(page, (s) => s.libraryPath === directory);
    await page.waitForFunction(
      (directory) =>
        document.body.innerText.includes("Your library starts here."),
      directory,
    );
    assert.equal(next.mediaSettings.setupError, undefined);
    assert.equal(await page.getByRole("dialog").count(), 0);
    return next;
  }
  const aDirectory = path.join(root, "A");
  const bDirectory = path.join(root, "Rhythm 2");
  const cDirectory = path.join(root, "C");
  const aSettings = (await switchLibrary(aDirectory)).mediaSettings;
  assert.equal(aSettings.root.path, path.join(aDirectory, "Rio Media"));
  const bSettings = (await switchLibrary(bDirectory)).mediaSettings;
  assert.equal(bSettings.root.path, path.join(bDirectory, "Rio Media"));
  assert.notEqual(bSettings.root.id, aSettings.root.id);
  assert.deepEqual((await switchLibrary(aDirectory)).mediaSettings, aSettings);
  await settings(page);
  const custom = path.join(root, "A custom media");
  await mkdir(custom);
  await select(custom);
  await page
    .getByRole("button", { name: "Change Rio Media folder…", exact: true })
    .click();
  await settled(page, (s) => s.mediaSettings.root?.path === custom);
  await page.getByText(custom, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  await switchLibrary(bDirectory);
  assert.equal(
    (await switchLibrary(aDirectory)).mediaSettings.root.path,
    custom,
  );
  assert.equal(
    (await switchLibrary(cDirectory)).mediaSettings.root.path,
    path.join(cDirectory, "Rio Media"),
  );
  // The renderer displays this library's configuration too, not cached A settings.
  await settings(page);
  await page
    .getByText(path.join(cDirectory, "Rio Media"), { exact: true })
    .waitFor();
  await page.screenshot({
    path: path.join(review, "managed-independent-library.png"),
  });
  for (const [file, hash] of hashes)
    assert.equal(sha(await readFile(file)), hash);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "automatic internal Rio Media creation, copying remains opt-in",
          "A/B/C isolation in one profile and renderer, including custom A root",
          "existing library reuses saved root without setup prompt",
          "missing root retains configuration and opens Settings recovery",
          "Settings can explicitly change the media root",
          "native media folder choose/cancel",
          "opt-in settings and restart",
          "Add Music managed copy",
          "managed playback",
          "file drops and repeated sources",
          "organized/flat subsequent imports",
          "playlist reference-only semantics",
          "copy-off referenced addition",
          "compact settings keyboard/focus",
          "source and playlist hashes",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  if (app)
    await app
      .firstWindow()
      .then((page) =>
        page.screenshot({ path: path.join(review, "managed-failure.png") }),
      )
      .catch(() => {});
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
