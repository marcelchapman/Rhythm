import { _electron as electron } from "playwright";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { wavFixture } from "../tests/fixtures.ts";

// Optional FFmpeg-backed codec check. Fixtures stay outside the repository/app.
const root = await mkdtemp(path.join(tmpdir(), "rhythm-codecs-"));
const music = path.join(root, "Music");
const library = path.join(root, "Library");
const results = [];
let app;
try {
  await mkdir(music);
  await mkdir(library);
  const master = path.join(root, "master.wav");
  await writeFile(master, wavFixture({ seconds: 20 }));
  const encoders = execFileSync("ffmpeg", ["-hide_banner", "-encoders"], {
    encoding: "utf8",
  });
  const cases = [
    ["mp3", "libmp3lame"],
    ["m4a", "aac"],
    ["aac", "aac"],
    ["ogg", encoders.includes(" libvorbis ") ? "libvorbis" : "vorbis"],
    ["opus", "libopus"],
  ];
  for (const [extension, codec] of cases) {
    execFileSync("ffmpeg", [
      "-loglevel",
      "error",
      "-y",
      "-i",
      master,
      "-c:a",
      codec,
      "-ac",
      "2",
      "-ar",
      "48000",
      "-strict",
      "experimental",
      "-metadata",
      `title=Codec ${extension.toUpperCase()}`,
      path.join(music, `codec.${extension}`),
    ]);
  }
  const executablePath =
    process.env.RHYTHM_EXECUTABLE ||
    path.resolve(
      process.platform === "darwin"
        ? "release/mac/Rhythm.app/Contents/MacOS/Rhythm"
        : "release/linux-unpacked/rhythm-desktop",
    );
  app = await electron.launch({
    executablePath,
    args: [],
    env: { ...process.env, RHYTHM_DATA_DIR: path.join(root, "UserData") },
  });
  const page = await app.firstWindow();
  const select = (folder) =>
    app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [selected],
      });
    }, folder);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .waitFor();
  await select(library);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Your library starts here." })
    .waitFor();
  await select(music);
  await page
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  await page.waitForFunction(
    async () => (await window.rhythm.snapshot()).tracks.length === 5,
  );
  await page
    .getByRole("heading", { name: "Recently Added", exact: true })
    .waitFor();
  await page.getByRole("slider", { name: "Volume", exact: true }).press("Home");
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  const tracks = (await page.evaluate(() => window.rhythm.snapshot())).tracks;
  assert.equal(tracks.length, 5);
  for (const [extension] of cases) {
    const track = tracks.find((t) => t.format === extension);
    assert(track, `Indexed ${extension}`);
    await page
      .locator(".workspace")
      .getByRole("button", { name: `Play ${track.title}`, exact: true })
      .click();
    await page.waitForFunction(
      (id) => {
        const a = document.querySelector("audio");
        return (
          a && a.currentSrc.endsWith(id) && !a.paused && a.currentTime > 0.05
        );
      },
      track.id,
      { timeout: 15000 },
    );
    for (let n = 0; n < 10; n++)
      await page
        .getByRole("slider", { name: "Seek", exact: true })
        .press("ArrowRight");
    const position = await page.locator("audio").evaluate((a) => a.currentTime);
    assert(position >= 1, `Seek ${extension}`);
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    results.push({
      format: extension,
      indexed: true,
      decoded: true,
      seek: true,
    });
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        results,
        audibleOutput: "Not assessed; generated silence",
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
