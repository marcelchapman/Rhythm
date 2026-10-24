import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { execFileSync } from "node:child_process";
import { wavFixture } from "../tests/fixtures.ts";

const fixture = await mkdtemp(path.join(tmpdir(), "rhythm-desktop-test-"));
const music = path.join(fixture, "Music with spaces ü");
const library = path.join(fixture, "Library");
const userData = path.join(fixture, "UserData");
const review = path.resolve(".impeccable/review");
const executable =
  process.env.RHYTHM_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rhythm.app/Contents/MacOS/Rhythm"
          : "release/linux-unpacked/rhythm-desktop",
      )
    : undefined);
await mkdir(music);
await mkdir(library);
await mkdir(review, { recursive: true });
const sourceHashes = new Map();
const crc = (bytes) => {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
  }
  return (n ^ 0xffffffff) >>> 0;
};
function artwork(index) {
  const width = 256,
    raw = Buffer.alloc((width * 3 + 1) * width);
  for (let y = 0; y < width; y++)
    for (let x = 0; x < width; x++) {
      const offset = y * (width * 3 + 1) + 1 + x * 3;
      const v = Math.sin((x + (index * y) / 5) / 27) * 32;
      raw[offset] = (index * 31 + y * 0.3 + v + 50) % 256;
      raw[offset + 1] = (index * 13 + x * 0.5 + 70) % 256;
      raw[offset + 2] = (index * 19 + x * 0.15 + y * 0.5 + 100) % 256;
    }
  const chunk = (type, data) => {
    const size = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(width, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
let withArt = false;
try {
  execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
  withArt = true;
} catch {
  /* WAV smoke coverage remains available without FFmpeg. */
}
const names = [
  "Evening light",
  "Blue hour",
  "After the rain",
  "Low tide",
  "Field notes",
  "Quiet city",
  "Open water",
  "Slow return",
  "Soft focus",
  "Northbound",
  "Still morning",
  "Night garden",
];
for (let index = 0; index < names.length; index++) {
  const dir = path.join(music, `Album ${index + 1}`);
  await mkdir(dir);
  const wav = path.join(dir, "01.wav");
  await writeFile(
    wav,
    wavFixture({
      title: names[index],
      artist: `Test artist ${(index % 4) + 1}`,
      album: `Test album ${String(index + 1).padStart(2, "0")}`,
      seconds: 30,
    }),
  );
  let file = wav;
  if (withArt) {
    const cover = path.join(fixture, `cover-${index}.png`);
    await writeFile(cover, artwork(index));
    file = path.join(dir, "01.flac");
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      wav,
      "-i",
      cover,
      "-map",
      "0:a",
      "-map",
      "1:0",
      "-c:a",
      "flac",
      "-c:v",
      "copy",
      "-disposition:v",
      "attached_pic",
      file,
    ]);
    await rm(wav);
  }
  sourceHashes.set(
    file,
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  );
}
for (let n = 2; n <= 9; n++) {
  const file = path.join(music, "Album 1", `${String(n).padStart(2, "0")}.wav`);
  await writeFile(
    file,
    wavFixture({
      title: `Study ${n}`,
      artist: "Test artist 1",
      album: "Test album 01",
      seconds: 30,
    }),
  );
  sourceHashes.set(
    file,
    createHash("sha256")
      .update(await readFile(file))
      .digest("hex"),
  );
}
let application;
const errors = [];
const launch = async () => {
  application = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: { ...process.env, RHYTHM_DATA_DIR: userData },
    timeout: 30000,
  });
  application.process().stderr.on("data", (data) => process.stderr.write(data));
  application.process().stdout.on("data", (data) => process.stdout.write(data));
  const page = await application.firstWindow();
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.waitForSelector("h1");
  return page;
};
const snapshot = (page) => page.evaluate(() => window.rhythm.snapshot());
const dialogFolder = (folder) =>
  application.evaluate(({ dialog }, selected) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [selected],
    });
  }, folder);
try {
  let page = await launch();
  await page.getByRole("heading", { name: "A home for your music." }).waitFor();
  assert.equal((await snapshot(page)).tracks.length, 0);
  await page.screenshot({ path: path.join(review, "first-run.png") });
  await dialogFolder(library);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your library starts here." })
    .waitFor();
  await page.screenshot({ path: path.join(review, "empty-library.png") });
  await dialogFolder(music);
  await page
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  await page.waitForFunction(
    async () => (await window.rhythm.snapshot()).tracks.length === 20,
  );
  await page
    .getByRole("heading", { name: "Recently Added", exact: true })
    .waitFor();
  const initial = await snapshot(page);
  assert.equal(initial.tracks.length, 20);
  assert.equal(initial.roots.length, 1);
  assert.equal(initial.tracks[0].artist, "Test artist 1");
  if (withArt) assert(initial.tracks.filter((t) => t.hasArtwork).length === 12);
  await page.getByRole("slider", { name: "Volume", exact: true }).press("Home");
  await page
    .getByRole("button", {
      name: "Open Test album 01 by Test artist 1",
      exact: true,
    })
    .last()
    .click();
  await page
    .getByRole("button", { name: "Play album Test album 01", exact: true })
    .last()
    .click();
  await page.waitForFunction(() => {
    const a = document.querySelector("audio");
    return a && !a.paused && a.currentTime > 0;
  });
  assert((await page.locator("audio").evaluate((a) => a.duration)) >= 29);
  const playbackSource = await page
    .locator("audio")
    .evaluate((a) => a.currentSrc);
  const playbackTrack = initial.tracks.find((t) => t.title === "Evening light");
  assert.equal(playbackSource, `rhythm-media://track/${playbackTrack.id}`);
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("audio").paused);
  const seek = page.getByRole("slider", { name: "Seek", exact: true });
  const waitForSeek = (target) =>
    page.waitForFunction(
      ({ source, target }) => {
        const a = document.querySelector("audio");
        const slider = document.querySelector('input[aria-label="Seek"]');
        // Paused playback cannot satisfy this check just by letting time pass.
        // Wait for decoding to settle, not only the requested currentTime value.
        return (
          a.currentSrc === source &&
          a.paused &&
          !a.ended &&
          !a.seeking &&
          a.error === null &&
          a.readyState >= 2 &&
          Math.abs(a.currentTime - target) <= 0.05 &&
          Math.abs(Number(slider.value) - target) <= 0.05
        );
      },
      { source: playbackSource, target },
      { timeout: 10000 },
    );
  // End is not a harmless range reset: it fires ended and advances the queue.
  // Test the real keyboard control on one paused track, one settled seek at a time.
  await seek.press("Home");
  await waitForSeek(0);
  for (let n = 1; n <= 20; n++) {
    await seek.press("ArrowRight");
    await waitForSeek(n / 10);
  }
  assert((await page.locator("audio").evaluate((a) => a.currentTime)) >= 1.9);
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await page.waitForFunction(
    (source) => {
      const a = document.querySelector("audio");
      return (
        a.currentSrc === source &&
        !a.paused &&
        !a.seeking &&
        a.error === null &&
        a.currentTime > 2.1
      );
    },
    playbackSource,
    { timeout: 10000 },
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("audio").paused);
  await page.getByRole("button", { name: "Dismiss import report" }).click();
  await page.screenshot({ path: path.join(review, "desktop.png") });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1050, 720),
  );
  await page.waitForFunction(() => window.innerWidth === 1050);
  await page.screenshot({ path: path.join(review, "desktop-1050.png") });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  );
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(1464, 940),
  );
  const search = page.getByRole("searchbox", { name: "Search library" });
  await search.fill("Evening light");
  await page.getByRole("heading", { name: "Search results" }).waitFor();
  assert.equal(await page.locator(".workspace .song-row").count(), 1);
  await search.fill("no-such-track");
  await page.getByRole("heading", { name: "No matching music" }).waitFor();
  await page.screenshot({ path: path.join(review, "search-empty.png") });
  await search.fill("");
  await page
    .getByRole("button", { name: "Create playlist", exact: true })
    .first()
    .click();
  await page.getByRole("textbox", { name: "Playlist name" }).fill("Smoke mix");
  await page
    .getByRole("button", { name: "Create playlist", exact: true })
    .last()
    .click();
  await page.getByRole("heading", { name: "Smoke mix", exact: true }).waitFor();
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await page
    .getByRole("button", { name: "Favourite Evening light", exact: true })
    .click();
  // Exercise the native context commands without automating the OS menu surface.
  await application.evaluate(({ Menu }) => {
    Menu.prototype.popup = function () {
      globalThis.__rhythmSmokeMenu = this;
    };
  });
  const contextCommand = (id) =>
    application.evaluate((_electron, id) => {
      const item = globalThis.__rhythmSmokeMenu?.getMenuItemById(id);
      if (!item) throw Error(`Context command ${id} missing`);
      item.click();
    }, id);
  const smokePlaylist = (await snapshot(page)).playlists.find(
    (p) => p.name === "Smoke mix",
  );
  await page
    .locator(`[data-track-id="${playbackTrack.id}"]`)
    .click({ button: "right" });
  await contextCommand(`playlist-${smokePlaylist.id}`);
  await page.waitForFunction(
    async () =>
      (await window.rhythm.snapshot()).playlists[0]?.trackIds.length === 1,
  );
  const blueHour = initial.tracks.find((t) => t.title === "Blue hour");
  await page
    .locator(`[data-track-id="${blueHour.id}"]`)
    .click({ button: "right" });
  await contextCommand("track-queue");
  assert(
    await page.getByRole("heading", { name: "Queue", exact: true }).isVisible(),
  );
  await page.getByRole("button", { name: "Next track", exact: true }).click();
  await page.waitForFunction(
    async () => (await window.rhythm.snapshot()).state.currentId !== null,
  );
  await page.getByRole("button", { name: "Smoke mix", exact: true }).click();
  await page.getByRole("heading", { name: "Smoke mix", exact: true }).waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector(".playlist-nav .selected")?.textContent ===
      "Smoke mix",
  );
  await page.screenshot({ path: path.join(review, "playlist-queue.png") });
  await search.fill("Blue hour");
  await page.getByRole("heading", { name: "Search results" }).waitFor();
  assert.equal(await page.locator(".workspace .song-row").count(), 1);
  await search.fill("");
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  assert((await page.locator(".group-list button").count()) === 4);
  await page.getByRole("button", { name: "Genres", exact: true }).click();
  assert((await page.locator(".group-list button").count()) === 1);
  await page
    .getByRole("button", { name: "Library settings", exact: true })
    .first()
    .click();
  await page.screenshot({ path: path.join(review, "settings.png") });
  await page
    .getByRole("button", { name: "Rescan folders", exact: true })
    .click();
  await page
    .getByText("0 added · 0 updated · 20 unchanged", { exact: true })
    .waitFor();
  await page.waitForTimeout(4500); // Persistence is deliberately debounced and checkpointed.
  const before = await snapshot(page);
  await application.close();
  application = undefined;
  page = await launch();
  await page.waitForFunction(
    async () => (await window.rhythm.snapshot()).tracks.length === 20,
  );
  const after = await snapshot(page);
  assert.equal(after.tracks.length, 20);
  assert.equal(after.playlists[0].name, "Smoke mix");
  assert.equal(after.playlists[0].trackIds.length, 1);
  assert.equal(after.tracks.filter((t) => t.favorite).length, 1);
  assert.equal(after.state.currentId, before.state.currentId);
  assert.equal(after.state.volume, 0);
  assert.equal(after.state.view, before.state.view);
  assert.equal(await page.locator("audio").evaluate((a) => a.paused), true);
  for (const [file, digest] of sourceHashes)
    assert.equal(
      createHash("sha256")
        .update(await readFile(file))
        .digest("hex"),
      digest,
    );
  assert.deepEqual(errors, []);
  console.log(
    JSON.stringify(
      {
        passed: true,
        tracks: after.tracks.length,
        artwork: withArt,
        checks: [
          "fresh setup",
          "native folder dialogs",
          "indexing",
          "metadata",
          "artwork",
          "playback",
          "seeking",
          "volume",
          "search",
          "playlists",
          "favourites",
          "queue",
          "artists",
          "genres",
          "rescan",
          "restart persistence",
          "source safety",
          "responsive width",
        ],
        screenshots: review,
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Preserve the original failure, with enough media state to diagnose CI races.
  try {
    const page = application?.windows()[0];
    if (page) {
      const transport = await page.locator("audio").evaluate((a) => ({
        src: a.currentSrc,
        time: a.currentTime,
        duration: a.duration,
        paused: a.paused,
        ended: a.ended,
        seeking: a.seeking,
        readyState: a.readyState,
        networkState: a.networkState,
        error: a.error && { code: a.error.code, message: a.error.message },
        seekable: Array.from({ length: a.seekable.length }, (_, i) => [
          a.seekable.start(i),
          a.seekable.end(i),
        ]),
        slider: document.querySelector('input[aria-label="Seek"]')?.value,
      }));
      await writeFile(
        path.join(review, "failure.json"),
        JSON.stringify({ error: String(error), transport }, null, 2),
      );
      console.error("SMOKE_FAILURE", JSON.stringify(transport));
      await page.screenshot({ path: path.join(review, "failure.png") });
    }
  } catch (diagnosticError) {
    console.error("Could not capture smoke diagnostics:", diagnosticError);
  }
  throw error;
} finally {
  await application?.close();
  await rm(fixture, { recursive: true, force: true });
}
