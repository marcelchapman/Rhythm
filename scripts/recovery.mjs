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
  cp,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { wavFixture } from "../tests/fixtures.ts";
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-recovery-app-")),
);
const incoming = path.join(root, "Incoming"),
  media = path.join(root, "Media"),
  library = path.join(root, "Library"),
  review = path.resolve(".impeccable/review");
for (const d of [incoming, media, library, review])
  await mkdir(d, { recursive: true });
const hashes = new Map();
const sha = (b) => createHash("sha256").update(b).digest("hex");
const protect = async (f) => hashes.set(f, sha(await readFile(f)));
for (const [name, album] of [
  ["A", "First album"],
  ["B", "First album"],
  ["C", "Album C"],
  ["D", "Album D"],
  ["E", "Album E"],
]) {
  const f = path.join(incoming, `${name}.wav`);
  await writeFile(
    f,
    wavFixture({ title: `Recovery ${name}`, album, track: 1, seconds: 30 }),
  );
  await protect(f);
}
const invalid = path.join(root, "invalid.wav");
await writeFile(invalid, "not audio");
await protect(invalid);
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
    env: { ...process.env, RIO_DATA_DIR: path.join(root, "Profile") },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  await app.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.rioRecoveryMenu = this;
    };
  });
  return page;
}
const select = (f) =>
  app.evaluate(({ dialog }, f) => {
    dialog.showOpenDialog = async () => ({
      canceled: !f,
      filePaths: f ? [f] : [],
    });
  }, f);
const snapshot = (page) => page.evaluate(() => window.rio.snapshot());
async function settled(page, predicate) {
  for (let i = 0; i < 150; i++) {
    const s = await snapshot(page);
    if (predicate(s)) return s;
    await page.waitForTimeout(100);
  }
  throw Error("Recovery state did not converge");
}
const shot = (page, name) =>
  page.screenshot({ path: path.join(review, `recovery-${name}.png`) });
const row = (page, id) => page.locator(`.song-row[data-track-id="${id}"]`);
async function menuFor(locator) {
  await app.evaluate(() => {
    globalThis.rioRecoveryMenu = null;
  });
  await locator.click({ button: "right" });
  for (let n = 0; n < 50; n++) {
    if (await app.evaluate(() => !!globalThis.rioRecoveryMenu)) break;
    await locator.page().waitForTimeout(50);
  }
  return app.evaluate(() =>
    globalThis.rioRecoveryMenu.items.map((i) => ({
      id: i.id,
      label: i.label,
      enabled: i.enabled,
    })),
  );
}
async function menuClick(id) {
  await app.evaluate((_, id) => {
    const menu = globalThis.rioRecoveryMenu,
      item = menu.getMenuItemById(id);
    if (!item?.enabled) throw Error(`Missing/disabled native command ${id}`);
    item.click(undefined, undefined, {});
  }, id);
}
async function fileCommand() {
  await app.evaluate(({ Menu }) => {
    const item = Menu.getApplicationMenu()
      .items.find((i) => i.label === "File")
      .submenu.items.find((i) => i.label === "Consolidate Library…");
    item.click(undefined, undefined, {});
  });
}
async function play(page, t) {
  await row(page, t.id)
    .getByRole("button", { name: `Play ${t.title}`, exact: true })
    .click();
  await page.waitForFunction(
    (id) => {
      const a = document.querySelector("audio");
      return (
        a.currentSrc &&
        new URL(a.currentSrc).pathname.slice(1) === id &&
        !a.paused &&
        !a.error &&
        a.currentTime > 0.15
      );
    },
    t.id,
    { timeout: 15000 },
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
}
async function loseCurrentFile(page, t, outside) {
  await rename(t.path, outside);
  await page.locator("audio").evaluate((a) => {
    const request = new URL(a.src);
    request.searchParams.set("access-check", String(Date.now()));
    a.src = request.href;
    a.load();
  });
  await page
    .getByRole("button", { name: "Locate File…", exact: true })
    .waitFor();
  assert((await snapshot(page)).tracks.find((x) => x.id === t.id).missing);
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
async function outputs(directory = media) {
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
try {
  let page = await launch();
  await select(library);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your library starts here." })
    .waitFor();
  await select(incoming);
  await page
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  const initial = await settled(page, (s) => s.tracks.length === 5);
  const named = (n) => initial.tracks.find((t) => t.title === `Recovery ${n}`);
  const a = named("A"),
    b = named("B"),
    c = named("C"),
    d = named("D");
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  const playlist = await page.evaluate(async (id) => {
    const p = await window.rio.createPlaylist("Recovery identities");
    await window.rio.playlistTracks(p.id, [id]);
    await window.rio.favorite(id);
    return p;
  }, a.id);
  await play(page, a);
  const moved = path.join(incoming, "A relocated.wav");
  hashes.delete(a.path);
  await loseCurrentFile(page, a, moved);
  await protect(moved);
  await shot(page, "missing-reference");
  await select(null);
  await page.getByRole("button", { name: "Locate File…", exact: true }).click();
  assert((await snapshot(page)).tracks.find((t) => t.id === a.id).missing);
  await select(invalid);
  await page.getByRole("button", { name: "Locate File…", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "invalid.wav" }).waitFor();
  await shot(page, "invalid-selection");
  assert((await snapshot(page)).tracks.find((t) => t.id === a.id).missing);
  await select(moved);
  await page.getByRole("button", { name: "Locate File…", exact: true }).click();
  await settled(
    page,
    (s) => s.tracks.find((t) => t.id === a.id)?.path === moved,
  );
  await row(page, a.id).locator(".missing-mark").waitFor({ state: "detached" });
  assert.equal(
    (await snapshot(page)).tracks.find((t) => t.id === a.id).locationKind,
    "referenced",
  );
  assert.equal((await outputs()).length, 0);
  await play(page, a);
  await app.close();
  page = await launch();
  await settled(
    page,
    (s) => s.tracks.find((t) => t.id === a.id)?.path === moved,
  );
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await play(page, a);
  await settings(page);
  await select(media);
  await page
    .getByRole("button", { name: "Change Rio Media folder…", exact: true })
    .click();
  await page.getByText(media, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Close dialog", exact: true }).click();
  let menu = await menuFor(row(page, a.id));
  assert(menu.some((i) => i.id === "track-consolidate" && i.enabled));
  assert(menu.some((i) => i.id === "track-playlist"));
  await menuClick("track-consolidate");
  await settled(
    page,
    (s) => s.tracks.find((t) => t.id === a.id).locationKind === "managed",
  );
  let managed = (await snapshot(page)).tracks.find((t) => t.id === a.id);
  assert.equal((await outputs()).length, 1);
  assert(managed.favorite);
  assert(
    (await snapshot(page)).playlists
      .find((p) => p.id === playlist.id)
      .trackIds.includes(a.id),
  );
  await play(page, a);
  const survivor = path.join(incoming, "External survivor.wav");
  await loseCurrentFile(page, managed, survivor);
  await protect(survivor);
  menu = await menuFor(row(page, a.id));
  assert(menu.some((i) => i.id === "track-locate"));
  await select(survivor);
  await menuClick("track-locate");
  await settled(page, (s) => !s.tracks.find((t) => t.id === a.id).missing);
  managed = (await snapshot(page)).tracks.find((t) => t.id === a.id);
  assert(managed.path.startsWith(media + path.sep));
  assert.equal(sha(await readFile(managed.path)), hashes.get(survivor));
  assert.equal((await outputs()).length, 1);
  await play(page, a);
  await shot(page, "managed-restored");
  // The original acceptance defect: restore the same path, rescan, and prove real playback.
  const parked = path.join(root, "temporarily-parked.wav");
  await loseCurrentFile(page, managed, parked);
  await rename(parked, managed.path);
  await settings(page);
  await page
    .getByRole("button", { name: "Rescan folders", exact: true })
    .click();
  await settled(page, (s) => !s.tracks.find((t) => t.id === a.id).missing);
  await row(page, a.id).locator(".missing-mark").waitFor({ state: "detached" });
  await play(page, a);
  // Explicitly selecting a manually restored expected path must not create another output.
  await loseCurrentFile(page, managed, parked);
  await rename(parked, managed.path);
  await select(managed.path);
  await page.getByRole("button", { name: "Locate File…", exact: true }).click();
  await settled(page, (s) => !s.tracks.find((t) => t.id === a.id).missing);
  await play(page, a);
  assert.equal((await outputs()).length, 1);
  menu = await menuFor(row(page, a.id));
  assert(!menu.some((i) => i.id === "track-consolidate"));
  await row(page, a.id).click();
  await row(page, b.id).click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  menu = await menuFor(row(page, b.id));
  assert.equal(
    await page.locator('.song-row[aria-selected="true"]').count(),
    2,
  );
  await menuClick("track-consolidate");
  await settled(
    page,
    (s) => s.tracks.find((t) => t.id === b.id).locationKind === "managed",
  );
  await page
    .getByRole("status")
    .filter({ hasText: "1 tracks consolidated · 1 already managed" })
    .waitFor();
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  const album = page.locator(".album-card").filter({
    has: page.getByRole("button", {
      name: "Open Album C by Test artist",
      exact: true,
    }),
  });
  menu = await menuFor(album);
  assert(menu.some((i) => i.label === "Consolidate Album to Rio Media"));
  await menuClick("track-consolidate");
  await settled(
    page,
    (s) => s.tracks.find((t) => t.id === c.id).locationKind === "managed",
  );
  menu = await menuFor(album);
  assert(!menu.some((i) => i.id === "track-consolidate"));
  hashes.delete(d.path);
  await rename(d.path, d.path + ".parked");
  await protect(d.path + ".parked");
  const before = await outputs();
  await fileCommand();
  const dialog = page.getByRole("dialog", {
    name: "Consolidate Library?",
    exact: true,
  });
  await dialog.waitFor();
  await shot(page, "consolidation-confirm");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(await outputs(), before);
  await fileCommand();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 740),
  );
  await dialog.waitFor();
  await page.keyboard.press("Tab");
  await shot(page, "consolidation-compact-focus");
  assert(await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth));
  await dialog
    .getByRole("button", { name: "Consolidate library", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({
      hasText:
        "1 tracks consolidated · 3 already managed · 1 could not be consolidated",
    })
    .waitFor();
  await page.getByText("View consolidation issues", { exact: true }).click();
  await shot(page, "consolidation-partial-failure");
  assert.equal(
    (await snapshot(page)).tracks.find((t) => t.id === d.id).locationKind,
    "referenced",
  );
  hashes.delete(d.path + ".parked");
  await rename(d.path + ".parked", d.path);
  await protect(d.path);
  await fileCommand();
  await dialog
    .getByRole("button", { name: "Consolidate library", exact: true })
    .click();
  await settled(page, (s) =>
    s.tracks.every((t) => t.locationKind === "managed"),
  );
  const finalFiles = await outputs();
  assert.equal(finalFiles.length, 5);
  await fileCommand();
  await dialog.waitFor();
  assert(
    await dialog
      .getByRole("button", { name: "Consolidate library", exact: true })
      .isDisabled(),
  );
  await page.keyboard.press("Escape");
  assert.deepEqual(await outputs(), finalFiles);
  await app.close();
  page = await launch();
  const final = await settled(page, (s) => s.tracks.length === 5);
  assert(final.tracks.every((t) => t.locationKind === "managed"));
  assert.deepEqual(
    final.tracks.map((t) => t.id).sort(),
    initial.tracks.map((t) => t.id).sort(),
  );
  assert(final.tracks.find((t) => t.id === a.id).favorite);
  assert.deepEqual(final.playlists.find((p) => p.id === playlist.id).trackIds, [
    a.id,
  ]);
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await play(page, a);
  // A copied sacrificial library intentionally shares track IDs but has its own
  // saved position. Switching must not reuse the preceding decoder's position.
  await app.close();
  const alternate = path.join(root, "Alternate library");
  await cp(library, alternate, { recursive: true });
  const db = new DatabaseSync(path.join(alternate, "rio.sqlite"));
  const player = JSON.parse(
    db.prepare("SELECT value FROM settings WHERE key='player'").get().value,
  );
  player.currentId = a.id;
  player.position = 7;
  db.prepare("UPDATE settings SET value=? WHERE key='player'").run(
    JSON.stringify(player),
  );
  db.close();
  page = await launch();
  await settled(
    page,
    (s) => s.libraryPath === library && s.tracks.length === 5,
  );
  await page.waitForFunction(
    () => document.querySelector("audio").readyState >= 1,
  );
  await settings(page);
  await select(alternate);
  await page
    .getByRole("button", { name: "Choose or switch library…", exact: true })
    .click();
  await settled(page, (s) => s.libraryPath === alternate);
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return (
      a.readyState >= 1 &&
      a.currentTime >= 6.9 &&
      a.currentTime < 7.5 &&
      a.paused
    );
  });
  for (const [f, hash] of hashes) assert.equal(sha(await readFile(f)), hash, f);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "referenced missing/Locate/cancel/invalid/restart",
          "stable identity and playlist/favourite state",
          "managed external restore-copy and playback",
          "same-path manual restore/rescan/playback regression",
          "same-path Locate without duplication",
          "native context actions and mixed selection",
          "album contextual consolidation",
          "whole-library confirmation/cancel",
          "partial failure and retry",
          "all-managed idempotency",
          "source hashes and restart",
          "library-specific position with shared track IDs",
        ],
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(
    "RECOVERY_MEDIA",
    await app
      ?.firstWindow()
      .then((p) =>
        p.locator("audio").evaluate((a) => ({
          src: a.src,
          error: a.error?.code,
          paused: a.paused,
          time: a.currentTime,
        })),
      )
      .catch(() => null),
  );
  console.error(
    "RECOVERY_FAILURE",
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
