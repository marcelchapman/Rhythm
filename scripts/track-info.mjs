import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  realpath,
  readdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { wavFixture } from "../tests/fixtures.ts";
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rhythm-locate-info-")),
);
const library = path.join(root, "Library"),
  media = path.join(root, "Media"),
  incoming = path.join(root, "Incoming"),
  review = path.resolve(".impeccable/review");
for (const d of [library, media, incoming, review])
  await mkdir(d, { recursive: true });
const hashes = new Map();
const sha = (b) => createHash("sha256").update(b).digest("hex");
async function protect(f) {
  hashes.set(f, {
    hash: sha(await readFile(f)),
    mtime: (await stat(f)).mtimeMs,
  });
}
async function move(from, to) {
  const before = hashes.get(from);
  await rename(from, to);
  hashes.delete(from);
  hashes.set(to, before);
}
const first = path.join(incoming, "first.wav");
await writeFile(
  first,
  wavFixture({
    title: "Locate acceptance",
    artist: "Case Artist",
    albumArtist: "Case Album Artist",
    album: "Case Album",
    track: 7,
    disc: "2/3",
    bpm: 97,
    comments: "First line\n" + "A-long-comment-".repeat(24),
    seconds: 30,
  }),
);
await protect(first);
let app;
const executable =
  process.env.RHYTHM_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rhythm.app/Contents/MacOS/Rhythm"
          : "release/linux-unpacked/rhythm-desktop",
      )
    : undefined);
async function launch() {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: { ...process.env, RHYTHM_DATA_DIR: path.join(root, "Profile") },
  });
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.rhythmInfoMenu = this;
    };
  });
  return page;
}
const select = (f) =>
  app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
  }, f);
const snapshot = (p) => p.evaluate(() => window.rhythm.snapshot());
async function settled(p, check) {
  for (let n = 0; n < 150; n++) {
    const s = await snapshot(p);
    if (check(s)) return s;
    await p.waitForTimeout(100);
  }
  throw Error("Locate/Info state did not converge");
}
const row = (p, id) => p.locator(`.song-row[data-track-id="${id}"]`);
async function nativeMenu(p, target) {
  await app.evaluate(() => {
    globalThis.rhythmInfoMenu = null;
  });
  await target.click({ button: "right" });
  for (let n = 0; n < 50; n++) {
    if (await app.evaluate(() => !!globalThis.rhythmInfoMenu)) return;
    await p.waitForTimeout(50);
  }
  throw Error("Native menu did not open");
}
async function menuClick(id) {
  await app.evaluate((_, id) => {
    const item = globalThis.rhythmInfoMenu.getMenuItemById(id);
    if (!item?.enabled) throw Error(`Missing/disabled native action ${id}`);
    item.click(undefined, undefined, {});
  }, id);
}
const info = (p) => p.getByRole("dialog", { name: "Track Info", exact: true });
const field = (p, label) =>
  info(p)
    .locator(".track-info-fields > div")
    .filter({ has: p.locator("dt").getByText(label, { exact: true }) })
    .locator("dd");
async function inspect(p, id, title) {
  await nativeMenu(p, row(p, id));
  await menuClick("track-info");
  await info(p).waitFor();
  assert.equal(await field(p, "Title").innerText(), title);
  assert.equal(
    await info(p)
      .locator("input,textarea,select,[contenteditable=true]")
      .count(),
    0,
  );
}
async function done(p) {
  await info(p).getByRole("button", { name: "Done", exact: true }).click();
  await info(p).waitFor({ state: "detached" });
}
async function play(p, t) {
  await row(p, t.id)
    .getByRole("button", { name: `Play ${t.title}`, exact: true })
    .click();
  await p.waitForFunction(
    (id) => {
      const a = document.querySelector("audio");
      return (
        a.currentSrc.endsWith(id) &&
        !a.paused &&
        !a.error &&
        a.currentTime > 0.2
      );
    },
    t.id,
    { timeout: 15000 },
  );
  await p.getByRole("button", { name: "Pause", exact: true }).click();
}
async function missing(p, id) {
  await p.locator("audio").evaluate((a) => {
    const u = new URL(a.src);
    u.searchParams.set("fresh-access", String(Date.now()));
    a.src = u.href;
    a.load();
  });
  await p.getByRole("button", { name: "Locate File…", exact: true }).waitFor();
  await settled(p, (s) => s.tracks.find((t) => t.id === id).missing);
}
async function settings(p) {
  await p
    .getByRole("button", { name: "Library settings", exact: true })
    .first()
    .click();
  await p
    .getByRole("dialog", { name: "Library settings", exact: true })
    .waitFor();
}
async function oneIdentity(p, id, file, playlist) {
  const s = await snapshot(p);
  assert.equal(s.tracks.length, 1);
  assert.deepEqual(
    s.tracks.map((t) => t.id),
    [id],
  );
  assert.equal(s.tracks[0].path, file);
  assert.equal(s.tracks[0].locationKind, "referenced");
  assert.equal(s.tracks[0].missing, false);
  assert(s.tracks[0].favorite);
  assert.deepEqual(s.playlists.find((p) => p.id === playlist).trackIds, [id]);
  assert.equal(s.state.currentId, id);
  assert.deepEqual(s.state.queue, [id]);
  assert.deepEqual(
    (await readdir(media)).filter((x) => !x.startsWith(".")),
    [],
  );
}
try {
  let p = await launch();
  await select(library);
  await p
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await p.getByRole("heading", { name: "Your library starts here." }).waitFor();
  await select(first);
  await p
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  const initial = await settled(p, (s) => s.tracks.length === 1),
    a = initial.tracks[0];
  const playlist = await p.evaluate(async (id) => {
    await window.rhythm.favorite(id);
    const list = await window.rhythm.createPlaylist("Info identity");
    await window.rhythm.playlistTracks(list.id, [id]);
    return list;
  }, a.id);
  await settings(p);
  await select(media);
  await p
    .getByRole("button", { name: "Choose Rhythm Media folder…", exact: true })
    .click();
  await p.getByText(media, { exact: true }).waitFor();
  await p
    .getByRole("checkbox", {
      name: "Copy files to Rhythm Media folder when adding to library",
      exact: true,
    })
    .check();
  await settled(p, (s) => s.mediaSettings.copyOnAdd);
  await p.getByRole("button", { name: "Close dialog", exact: true }).click();
  await p.getByRole("button", { name: "Songs", exact: true }).click();
  await play(p, a);
  const relocated = path.join(incoming, "relocated.wav");
  await move(first, relocated);
  await missing(p, a.id);
  await select(relocated);
  await p.getByRole("button", { name: "Locate File…", exact: true }).click();
  await settled(
    p,
    (s) => s.tracks[0].path === relocated && !s.tracks[0].missing,
  );
  await oneIdentity(p, a.id, relocated, playlist.id);
  await play(p, a);
  await inspect(p, a.id, a.title);
  for (const [label, value] of [
    ["Artist", "Case Artist"],
    ["Album", "Case Album"],
    ["Album Artist", "Case Album Artist"],
    ["BPM", "97"],
    ["Track number", "7"],
    ["Disc number", "2"],
    ["Year", "2026"],
    ["File location", relocated],
    ["Ownership", "Referenced file"],
  ])
    assert.equal(await field(p, label).innerText(), value);
  assert((await field(p, "Comments").innerText()).includes("First line\n"));
  for (const omitted of ["Composer", "Play count", "Track total", "Disc total"])
    assert.equal(
      await info(p).locator("dt").getByText(omitted, { exact: true }).count(),
      0,
    );
  await p.screenshot({ path: path.join(review, "track-info-reference.png") });
  await info(p)
    .getByRole("button", { name: "Done", exact: true })
    .scrollIntoViewIfNeeded();
  await p.screenshot({ path: path.join(review, "track-info-file.png") });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 740),
  );
  await info(p)
    .getByRole("button", { name: "Close dialog", exact: true })
    .focus();
  await p.keyboard.press("Tab");
  await p.keyboard.press("Shift+Tab");
  await p.screenshot({
    path: path.join(review, "track-info-compact-focus.png"),
  });
  assert(await info(p).evaluate((el) => el.scrollWidth <= el.clientWidth));
  await p.keyboard.press("Escape");
  await info(p).waitFor({ state: "detached" });
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1464, 940),
  );
  const twice = path.join(incoming, "relocated-again.wav");
  await move(relocated, twice);
  await missing(p, a.id);
  await inspect(p, a.id, a.title);
  assert(
    (await field(p, "Availability").innerText()).startsWith("Unavailable"),
  );
  await p.screenshot({ path: path.join(review, "track-info-missing.png") });
  await done(p);
  await nativeMenu(p, row(p, a.id));
  await select(twice);
  await menuClick("track-locate");
  await settled(p, (s) => s.tracks[0].path === twice && !s.tracks[0].missing);
  await oneIdentity(p, a.id, twice, playlist.id);
  await play(p, a);
  await app.close();
  p = await launch();
  await settled(p, (s) => s.tracks.length === 1);
  await oneIdentity(p, a.id, twice, playlist.id);
  await p.getByRole("button", { name: "Songs", exact: true }).click();
  await play(p, a);
  // Create a genuinely independent, pre-existing reference before attempting a collision.
  await settings(p);
  await p
    .getByRole("checkbox", {
      name: "Copy files to Rhythm Media folder when adding to library",
      exact: true,
    })
    .uncheck();
  await settled(p, (s) => !s.mediaSettings.copyOnAdd);
  await p.getByRole("button", { name: "Close dialog", exact: true }).click();
  const other = path.join(incoming, "genuine-other.wav");
  await writeFile(
    other,
    wavFixture({
      title: "Second existing track",
      artist: "Case Artist",
      album: "Case Album",
      albumArtist: "Case Album Artist",
      seconds: 30,
    }),
  );
  await protect(other);
  await select(other);
  await p
    .getByRole("button", { name: "Add music", exact: true })
    .first()
    .click();
  const two = await settled(p, (s) => s.tracks.length === 2),
    b = two.tracks.find((t) => t.id !== a.id);
  const finalPath = path.join(incoming, "final-source.wav");
  await move(twice, finalPath);
  await missing(p, a.id);
  const before = (await snapshot(p)).tracks;
  await select(other);
  await p.getByRole("button", { name: "Locate File…", exact: true }).click();
  await p
    .getByRole("alert")
    .filter({ hasText: "already linked to another track" })
    .waitFor();
  assert.deepEqual((await snapshot(p)).tracks, before);
  await select(finalPath);
  await p.getByRole("button", { name: "Locate File…", exact: true }).click();
  await settled(
    p,
    (s) =>
      s.tracks.find((t) => t.id === a.id).path === finalPath &&
      !s.tracks.find((t) => t.id === a.id).missing,
  );
  await row(p, a.id).click();
  await row(p, b.id).click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 2);
  await inspect(p, b.id, b.title);
  await p.screenshot({ path: path.join(review, "track-info-basic.png") });
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 2);
  await done(p);
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 2);
  await p.locator(".songs-viewport").press("Shift+F10");
  await menuClick("track-info");
  await info(p).waitFor();
  assert.equal(await field(p, "Title").innerText(), a.title);
  await done(p);
  // The same native command is available across every reusable Track List view.
  await p
    .locator(".sidebar")
    .getByRole("button", { name: playlist.name, exact: true })
    .click();
  await inspect(p, a.id, a.title);
  await done(p);
  await p.getByRole("button", { name: "Artists", exact: true }).click();
  await p
    .locator(".group-list button")
    .filter({ hasText: "Case Artist" })
    .click();
  await inspect(p, a.id, a.title);
  await done(p);
  await p.getByRole("button", { name: "Genres", exact: true }).click();
  await p.locator(".group-list button").filter({ hasText: "Ambient" }).click();
  await inspect(p, a.id, a.title);
  await done(p);
  await p.getByRole("button", { name: "Favourites", exact: true }).click();
  await inspect(p, a.id, a.title);
  await done(p);
  const search = p.getByRole("searchbox", { name: "Search library" });
  await search.fill(a.title);
  await p.getByRole("table", { name: "Search results", exact: true }).waitFor();
  await inspect(p, a.id, a.title);
  await done(p);
  await search.fill("");
  await p.getByRole("button", { name: "Albums", exact: true }).click();
  await p.getByRole("button", { name: "Track list", exact: true }).click();
  await inspect(p, a.id, a.title);
  await done(p);
  await p.getByRole("button", { name: "Songs", exact: true }).click();
  await nativeMenu(p, row(p, a.id));
  await menuClick("track-consolidate");
  await settled(
    p,
    (s) => s.tracks.find((t) => t.id === a.id).locationKind === "managed",
  );
  await inspect(p, a.id, a.title);
  assert.equal(
    await field(p, "Ownership").innerText(),
    "Managed copy in Rhythm Media",
  );
  assert(
    (await field(p, "File location").innerText()).startsWith(media + path.sep),
  );
  await p.screenshot({ path: path.join(review, "track-info-managed.png") });
  await done(p);
  for (const [f, beforeHash] of hashes) {
    assert.equal(sha(await readFile(f)), beforeHash.hash, f);
    assert.equal((await stat(f)).mtimeMs, beforeHash.mtime, f);
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "single referenced Locate exact count/identity/state with copying enabled",
          "banner and native Locate paths",
          "single-track restart and real playback",
          "genuine pre-existing collision unchanged",
          "read-only Track Info current metadata and omitted unavailable fields",
          "clicked-row multi-selection and keyboard target",
          "Songs/playlist/Artist/Genre/Favourites/search/list view integration",
          "compact focus/Escape/long comments/path",
          "referenced/missing/managed ownership information",
          "no external source bytes or mtimes changed",
        ],
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(
    "TRACK_INFO_FAILURE",
    await app
      ?.firstWindow()
      .then((p) => p.locator("body").innerText())
      .catch(() => "unavailable"),
  );
  throw e;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
