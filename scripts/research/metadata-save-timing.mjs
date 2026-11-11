// Profiles normal Songs edits against isolated libraries on the requested volumes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  lstat,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import {
  block,
  commentBlock,
  inspectFlac,
} from "../../tests/metadata-fixtures.ts";

const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const executable = process.env.RIO_EXECUTABLE;
const roots = [];
let desktop;
async function ownedRoot(parent) {
  const directory = await mkdtemp(
    path.join(await realpath(parent), ".rio-save-timing-"),
  );
  const { dev, ino } = await lstat(directory, { bigint: true });
  roots.push({ directory, dev, ino });
  return directory;
}
const hash = async (filename) =>
  createHash("sha256")
    .update(await readFile(filename))
    .digest("hex");
function ffmpeg(args) {
  execFileSync(
    "ffmpeg",
    ["-nostdin", "-hide_banner", "-v", "error", "-xerror", ...args],
    {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120000,
    },
  );
}
const emit = (data) => process.stdout.write(JSON.stringify(data) + "\n");

try {
  const scratch = await ownedRoot("/private/tmp");
  const files = [];
  for (const [fixture, seconds] of [
    ["small", 3],
    ["large", 180],
  ]) {
    const filename = path.join(scratch, fixture + ".flac");
    ffmpeg([
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:amplitude=0.35:r=48000:seed=17",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=pink:amplitude=0.35:r=48000:seed=23",
      "-filter_complex",
      "amerge=inputs=2",
      "-t",
      String(seconds),
      "-c:a",
      "flac",
      "-sample_fmt",
      "s32",
      "-bits_per_raw_sample",
      "24",
      "-metadata",
      "title=" + fixture,
      "-metadata",
      "genre=Fixture",
      filename,
    ]);
    // Keep the encoder's compressed audio but give it canonical, synthetic tags.
    const { blocks, audio } = inspectFlac(await readFile(filename));
    assert.equal(blocks.filter((b) => b.type === 4).length, 1);
    await writeFile(
      filename,
      Buffer.concat([
        Buffer.from("fLaC"),
        ...blocks.map((b, i) =>
          block(
            b.type,
            b.type === 4
              ? commentBlock([
                  ["TITLE", fixture],
                  ["GENRE", "Fixture"],
                ])
              : b.body,
            i === blocks.length - 1,
          ),
        ),
        audio,
      ]),
    );
    ffmpeg(["-i", filename, "-f", "null", "-"]);
    const { size } = await lstat(filename);
    assert(size < 64 * 1024 * 1024);
    if (fixture === "large") assert(size > 25 * 1024 * 1024);
    files.push({ filename, fixture, size, digest: await hash(filename) });
    emit({ event: "fixture", fixture, bytes: size, seconds, decoded: true });
  }

  const external = await ownedRoot(
    process.env.RIO_TIMING_EXTERNAL_PARENT || repo,
  );
  const internal = await ownedRoot("/private/tmp");
  assert.notEqual((await lstat(external)).dev, (await lstat(internal)).dev);
  for (const [storage, target] of [
    ["external", external],
    ["internal", internal],
  ]) {
    desktop = await electron.launch({
      ...(executable
        ? { executablePath: executable, args: [] }
        : { args: [repo] }),
      cwd: executable ? scratch : repo,
      env: {
        ...process.env,
        RIO_DATA_DIR: path.join(scratch, storage),
        RIO_METADATA_TIMING: "1",
      },
      timeout: 30000,
    });
    const samples = [];
    const lines = createInterface({ input: desktop.process().stdout });
    lines.on("line", (line) => {
      const matched = /^RIO_METADATA_(MAIN|NATIVE|RENDERER) (\{.*\})$/.exec(
        line,
      );
      if (matched)
        samples.push({ layer: matched[1], ...JSON.parse(matched[2]) });
    });
    const page = await desktop.firstWindow();
    await page.waitForSelector("h1");
    assert(await page.evaluate(() => window.rio.metadataTimingEnabled));
    const tracks = await desktop.evaluate(
      async ({ app, dialog, Menu }, config) => {
        const path = process.getBuiltinModule("path");
        const assert = process.getBuiltinModule("assert/strict");
        assert.equal(app.isPackaged, config.packaged);
        const module = path.join(app.getAppPath(), "dist/domain/library.js");
        const require = process
          .getBuiltinModule("module")
          .createRequire(module);
        const { Library } = require(module);
        const directory = path.join(config.target, "Library");
        const library = await Library.open(directory, { setupMediaRoot: true });
        let tracks;
        try {
          library.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
          const added = await library.add(config.files);
          assert.deepEqual(added.errors, []);
          tracks = library.tracks();
          assert.equal(tracks.length, config.files.length);
          assert(
            tracks.every(
              (track) =>
                track.locationKind === "managed" &&
                track.path.startsWith(directory + path.sep),
            ),
          );
          library.saveState({ ...library.state(), view: "Songs" });
        } finally {
          library.close();
        }
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
        });
        Menu.getApplicationMenu()
          .items.find((i) => i.label === "File")
          .submenu.items.find((i) => i.label === "Choose Library…")
          .click();
        return tracks.map(({ id, title, size }) => ({ id, title, size }));
      },
      {
        target,
        files: files.map((f) => f.filename),
        packaged: Boolean(executable),
      },
    );

    for (const { fixture, size } of files) {
      const track = tracks.find((t) => t.title === fixture);
      assert(track);
      const row = page.locator(`.song-row[data-track-id="${track.id}"]`);
      const cell = row.locator('[data-cell-column="genre"]');
      const input = page.locator(".inline-metadata-input");
      for (let run = 1; run <= 4; run++) {
        const from = samples.length;
        await cell.dblclick();
        await input.waitFor({ timeout: 90000 });
        await page.waitForFunction(
          () => {
            const field = document.querySelector(".inline-metadata-input");
            return field && !field.readOnly;
          },
          undefined,
          { timeout: 90000 },
        );
        const value = "Timing " + run;
        await input.fill(value);
        await input.press("Enter");
        await page.waitForFunction(
          () => {
            const field = document.querySelector(".inline-metadata-input");
            return !field || field.getAttribute("aria-invalid") === "true";
          },
          undefined,
          { timeout: 120000 },
        );
        if (await input.count()) {
          emit({
            event: "failed",
            storage,
            fixture,
            run,
            trace: samples.slice(from),
          });
          throw new Error("Disposable metadata save failed");
        }
        // Enter now closes the editor before publication. Await the measured
        // response before inspecting committed data or starting another edit.
        const deadline = performance.now() + 120000;
        while (
          !samples.slice(from).some((sample) => sample.layer === "RENDERER")
        ) {
          assert(performance.now() < deadline, "Missing renderer timing");
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const trace = samples.slice(from);
        assert.equal(
          trace.filter((t) => t.operation === "edit" && t.ok).length,
          1,
        );
        assert.equal(
          trace.filter((t) => t.layer === "RENDERER" && t.ok).length,
          1,
        );
        assert.equal((await cell.innerText()).trim(), value);
        emit({ event: "save", storage, fixture, bytes: size, run, trace });
      }
    }
    await desktop.close();
    desktop = undefined;
    lines.close();
  }
  for (const file of files)
    assert.equal(await hash(file.filename), file.digest);
  emit({ event: "complete", sourceBytesUnchanged: true });
} finally {
  try {
    await desktop?.close();
  } finally {
    for (const { directory, dev, ino } of roots.reverse()) {
      const info = await lstat(directory, { bigint: true });
      assert(info.isDirectory() && info.dev === dev && info.ino === ino);
      assert.equal(await realpath(directory), directory);
      await rm(directory, { recursive: true });
    }
  }
}
