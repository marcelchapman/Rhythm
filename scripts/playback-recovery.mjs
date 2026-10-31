import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  rm,
  realpath,
  stat,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { wavFixture } from "../tests/fixtures.ts";

// Generated sacrificial files only. No real library, preferences or music is opened.
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-playback-recovery-")),
);
const library = path.join(root, "Library"),
  media = path.join(root, "Media"),
  incoming = path.join(root, "Incoming");
const review = path.resolve(".impeccable/review");
let app;
const protectedFiles = new Map(),
  warnings = [];
const fingerprint = async (file) => ({
  hash: createHash("sha256")
    .update(await readFile(file))
    .digest("hex"),
  mtime: (await stat(file)).mtimeMs,
});
const protect = async (file) =>
  protectedFiles.set(file, await fingerprint(file));
const snapshot = (page) => page.evaluate(() => window.rio.snapshot());
const row = (page, id) => page.locator(`.song-row[data-track-id="${id}"]`);
const select = (file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: !file,
      filePaths: file ? [file] : [],
    });
  }, file);
const shot = (page, name) =>
  page.screenshot({ path: path.join(review, `playback-recovery-${name}.png`) });
async function launch() {
  const executable =
    process.env.RIO_EXECUTABLE ||
    (process.argv.includes("--packaged")
      ? path.resolve(
          process.platform === "darwin"
            ? "release/mac/Rio.app/Contents/MacOS/Rio"
            : "release/linux-unpacked/rio-desktop",
        )
      : undefined);
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: { ...process.env, RIO_DATA_DIR: path.join(root, "Profile") },
  });
  const page = await app.firstWindow();
  page.on("console", (m) => {
    if (m.type() === "warning") warnings.push(m.text());
  });
  await page.waitForSelector("h1");
  await page.evaluate(() => {
    globalThis.playbackNotices = [];
    new MutationObserver(() => {
      const notice = document.querySelector(".notice.error")?.textContent;
      if (notice) playbackNotices.push(notice);
    }).observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  return page;
}
async function playing(page, id) {
  await page.waitForFunction(
    (id) => {
      const a = document.querySelector("audio");
      return (
        a.currentSrc &&
        new URL(a.currentSrc).pathname.slice(1) === id &&
        !a.paused &&
        !a.error &&
        a.readyState >= 3 &&
        a.currentTime > 0.2
      );
    },
    id,
    { timeout: 15000 },
  );
  const start = await page.locator("audio").evaluate((a) => a.currentTime);
  await page.waitForFunction(
    (start) => document.querySelector("audio").currentTime > start + 0.2,
    start,
  );
}
async function play(page, track) {
  await row(page, track.id)
    .getByRole("button", { name: `Play ${track.title}`, exact: true })
    .click();
  await playing(page, track.id);
}
const pause = (page) =>
  page.getByRole("button", { name: "Pause", exact: true }).click();
async function loseOnFirstPlay(page, track, survivor, name) {
  const expected =
    protectedFiles.get(track.path) ?? (await fingerprint(track.path));
  await play(page, track);
  await pause(page);
  assert.deepEqual(await fingerprint(track.path), expected, track.path);
  await rename(track.path, survivor);
  protectedFiles.delete(track.path);
  assert.deepEqual(await fingerprint(survivor), expected, survivor);
  await protect(survivor);
  // No rescan, audio.load(), source mutation, switch or restart: exactly one real Play.
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Track unavailable" })
    .waitFor({ timeout: 3000 });
  await page
    .getByRole("button", { name: "Locate File…", exact: true })
    .waitFor({ timeout: 3000 });
  assert((await snapshot(page)).tracks.find((t) => t.id === track.id).missing);
  assert(await page.locator("audio").evaluate((a) => a.paused));
  await shot(page, name);
}
async function recoverAndPlayImmediately(page, track, survivor, name) {
  // Click on the first success DOM commit; assert the real decoder was ready
  // at that exact instant. Pending/slow load readiness is also covered in units.
  await page.evaluate(() => {
    globalThis.recoverySuccess = null;
    const observer = new MutationObserver(() => {
      if (
        document.body.textContent.includes(
          "File located. The track is ready to play",
        )
      ) {
        observer.disconnect();
        const a = document.querySelector("audio");
        globalThis.recoverySuccess = {
          ready: a.readyState,
          error: a.error?.code,
          seeking: a.seeking,
        };
        // Click during the same DOM commit: no wait, no intervening track.
        document.querySelector('button[aria-label="Play"]')?.click();
      }
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  });
  await select(survivor);
  await page.getByRole("button", { name: "Locate File…", exact: true }).click();
  await page.waitForFunction(() => !!globalThis.recoverySuccess);
  const success = await page.evaluate(() => globalThis.recoverySuccess);
  assert(
    success.ready >= 3 && !success.error && !success.seeking,
    JSON.stringify(success),
  );
  await playing(page, track.id);
  assert.equal(await page.locator(".notice.error").count(), 0);
  await shot(page, `${name}-playing`);
  await pause(page);
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
async function noRawErrors(page) {
  assert(
    !(await page.evaluate(() => playbackNotices)).some((s) =>
      /goo\.gl|play\(\) request|new load request|AbortError/.test(s),
    ),
  );
}
try {
  for (const d of [library, media, incoming, review])
    await mkdir(d, { recursive: true });
  const master = path.join(root, "master.wav");
  await writeFile(
    master,
    wavFixture({ title: "Referenced recovery", seconds: 30 }),
  );
  let reference = path.join(incoming, "referenced.ogg"),
    format = "ogg";
  try {
    const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
      encoding: "utf8",
    });
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      master,
      "-c:a",
      encoders.includes(" libvorbis ") ? "libvorbis" : "vorbis",
      "-ac",
      "2",
      "-ar",
      "48000",
      "-strict",
      "experimental",
      "-metadata",
      "title=Referenced recovery",
      reference,
    ]);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    format = "wav";
    reference = path.join(incoming, "referenced.wav");
    await writeFile(reference, await readFile(master));
    console.log(
      "FFmpeg unavailable: lifecycle assertions use WAV; run test:codecs separately for Ogg coverage.",
    );
  }
  const managedSource = path.join(root, "managed.wav");
  await writeFile(
    managedSource,
    wavFixture({ title: "Managed recovery", seconds: 30 }),
  );
  await protect(reference);
  await protect(managedSource);
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
  await page.waitForFunction(
    async () => (await window.rio.snapshot()).tracks.length === 1,
  );
  await page.getByRole("status").filter({ hasText: "1 added" }).waitFor();
  await select(media);
  await page.evaluate(() => window.rio.chooseMediaRoot());
  await page.evaluate(() => window.rio.saveMediaSettings({ copyOnAdd: true }));
  await select(managedSource);
  await page.getByRole("button", { name: "Add music", exact: true }).click();
  await page.waitForFunction(
    async () => (await window.rio.snapshot()).tracks.length === 2,
  );
  await page
    .getByRole("status")
    .filter({ hasText: "1 copied to Rio Media" })
    .waitFor();
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  const initial = await snapshot(page),
    ref = initial.tracks.find((t) => t.locationKind === "referenced"),
    managed = initial.tracks.find((t) => t.locationKind === "managed");
  assert(ref && managed);
  const playlist = await page.evaluate(
    async (ids) => {
      const p = await window.rio.createPlaylist("Recovery stable state");
      await window.rio.playlistTracks(p.id, ids);
      for (const id of ids) await window.rio.favorite(id);
      return p;
    },
    [ref.id, managed.id],
  );
  const movedReference = path.join(root, `relocated.${format}`);
  await loseOnFirstPlay(page, ref, movedReference, "referenced-unavailable");
  console.log("First-Play referenced detection passed");
  // Cancel dismisses recovery safely; the next single Play offers it again.
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await page.locator(".notice.error").count(), 0);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page
    .getByRole("button", { name: "Locate File…", exact: true })
    .waitFor({ timeout: 3000 });
  await recoverAndPlayImmediately(page, ref, movedReference, "referenced");
  console.log("Immediate referenced recovery playback passed");
  let s = await snapshot(page);
  assert.equal(s.tracks.length, 2);
  assert.equal(s.tracks.find((t) => t.id === ref.id).path, movedReference);
  assert.equal(
    s.tracks.find((t) => t.id === ref.id).locationKind,
    "referenced",
  );
  assert.equal((await outputs()).length, 1);
  const survivor = path.join(root, "managed-external-survivor.wav");
  await loseOnFirstPlay(page, managed, survivor, "managed-unavailable");
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 740),
  );
  await page.getByRole("button", { name: "Locate File…", exact: true }).focus();
  await page.keyboard.press("Shift+Tab");
  await page.keyboard.press("Tab");
  assert(
    await page
      .getByRole("button", { name: "Locate File…", exact: true })
      .evaluate((el) => el.matches(":focus-visible")),
  );
  await shot(page, "compact-focus");
  await recoverAndPlayImmediately(page, managed, survivor, "managed");
  console.log("Immediate managed recovery playback passed");
  s = await snapshot(page);
  const recovered = s.tracks.find((t) => t.id === managed.id);
  assert.equal(s.tracks.length, 2);
  assert.equal(recovered.locationKind, "managed");
  assert(recovered.path.startsWith(media + path.sep));
  assert.deepEqual(await fingerprint(survivor), protectedFiles.get(survivor));
  assert.equal(
    (await fingerprint(recovered.path)).hash,
    protectedFiles.get(survivor).hash,
  );
  assert.equal((await outputs()).length, 1);
  // Genuine current play failures stay actionable and logged, including an
  // unexpected AbortError; neither native exception text nor its URL reaches UI.
  for (const name of ["NotSupportedError", "AbortError"]) {
    await page.evaluate((name) => {
      const original = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function () {
        HTMLMediaElement.prototype.play = original;
        return Promise.reject(
          new DOMException(
            "The play() request was interrupted by a new load request. https://goo.gl/LdLk22",
            name,
          ),
        );
      };
    }, name);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await page
      .getByRole("alert")
      .filter({
        hasText:
          name === "AbortError"
            ? "Playback was interrupted. Press Play to try again."
            : "This track could not be played.",
      })
      .waitFor();
    await noRawErrors(page);
  }
  assert(warnings.some((w) => w.includes("Rio playback failed")));
  // A rejected Play from an older request must not overwrite a newer success.
  await page.evaluate(() => {
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      HTMLMediaElement.prototype.play = original;
      return new Promise((_, reject) => {
        globalThis.rejectOldPlay = reject;
      });
    };
  });
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(() => !!globalThis.rejectOldPlay);
  await play(page, ref);
  await page.evaluate(() =>
    rejectOldPlay(
      new DOMException(
        "The play() request was interrupted by a new load request. https://goo.gl/LdLk22",
        "AbortError",
      ),
    ),
  );
  // Round-trip IPC and real time advancement give rejection handling a turn.
  await snapshot(page);
  await playing(page, ref.id);
  assert.equal(await page.locator(".notice.error").count(), 0);
  await noRawErrors(page);
  await pause(page);
  await app.close();
  page = await launch();
  const final = await snapshot(page);
  assert.deepEqual(
    final.tracks.map((t) => t.id).sort(),
    initial.tracks.map((t) => t.id).sort(),
  );
  assert(final.tracks.every((t) => t.favorite && !t.missing));
  assert.deepEqual(final.playlists.find((p) => p.id === playlist.id).trackIds, [
    ref.id,
    managed.id,
  ]);
  assert.equal(final.state.currentId, ref.id);
  assert.deepEqual(final.state.queue, [managed.id, ref.id]);
  assert.equal(final.tracks.find((t) => t.id === ref.id).path, movedReference);
  assert.equal(
    final.tracks.find((t) => t.id === managed.id).path,
    recovered.path,
  );
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await play(page, ref);
  await pause(page);
  await play(page, managed);
  await pause(page);
  for (const [file, expected] of protectedFiles)
    assert.deepEqual(await fingerprint(file), expected, file);
  await noRawErrors(page);
  console.log(
    JSON.stringify(
      {
        passed: true,
        referenceFormat: format,
        checks: [
          "first Play finds missing buffered referenced and managed files",
          "Locate/Cancel offered without rescan or decoder workaround",
          "success observes real canplay/seek readiness",
          "same-commit immediate recovered playback, no unrelated track",
          "reference relink and managed copy retain ID/state without duplicates",
          "current failures owned/logged and superseded Abort ignored",
          "restart queue/favourites/playlist/locations and real playback",
          "external source SHA-256 and mtimes unchanged",
        ],
      },
      null,
      2,
    ),
  );
} catch (e) {
  console.error(
    "PLAYBACK_RECOVERY_FAILURE",
    await app
      ?.firstWindow()
      .then((p) =>
        p.evaluate(() => ({
          body: document.body.innerText,
          src: document.querySelector("audio")?.src,
          ready: document.querySelector("audio")?.readyState,
          error: document.querySelector("audio")?.error?.code,
        })),
      )
      .catch(() => null),
  );
  throw e;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
