import { MAX_FLAC_FILE_BYTES } from "../src/shared/flac-limits.ts";
// Real Songs/transport -> preload -> main -> protocol -> immutable source.
// Disposable media only. No coordinator writes and no direct acquisition calls.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { _electron as electron } from "playwright";
import { expect } from "playwright/test";
import {
  mkdtemp,
  realpath,
  mkdir,
  readFile,
  writeFile,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { localMetadataVolume } from "./lib/local-metadata-volume.mjs";
import { unsupportedMetadataVolume } from "./lib/unsupported-metadata-volume.mjs";
import { createHash } from "node:crypto";
import {
  playbackFlacFixture,
  inspectFlac,
  block,
  commentBlock,
} from "../tests/metadata-fixtures.ts";
import { wavFixture } from "../tests/fixtures.ts";
import { resolvePublicationPackage } from "./lib/publication-package.mjs";
const packaged =
  !!process.env.RIO_EXECUTABLE || process.argv.includes("--packaged");
const bundle =
  packaged && !process.env.RIO_EXECUTABLE
    ? await resolvePublicationPackage()
    : null;
const executable = process.env.RIO_EXECUTABLE || bundle?.executable;
if (process.argv.includes("--metadata") && process.platform !== "darwin") {
  console.log(
    "Stable-source metadata integration requires qualified macOS APFS; default playback checks remain enabled.",
  );
  process.exit(0);
}
const flag = !process.argv.includes("--disabled");
if (process.argv.includes("--natural-save-only"))
  assert(process.argv.includes("--metadata-fixture-only"));
const root = await realpath(
  await mkdtemp(
    path.join(
      process.platform === "darwin" ? "/private/tmp" : tmpdir(),
      "rio-player-stable-",
    ),
  ),
);
const extIndex = process.argv.indexOf("--external-parent");
const external =
  extIndex < 0
    ? null
    : await mkdtemp(
        path.join(
          await realpath(process.argv[extIndex + 1]),
          ".rio-player-stable-",
        ),
      );
const volumeIndex = process.argv.indexOf("--volume");
const volumeKind = volumeIndex < 0 ? null : process.argv[volumeIndex + 1];
let volume;
const cloning =
  flag && process.platform === "darwin" && volumeKind !== "unsupported";
const libraryPath = path.join(external || root, "Library"),
  sourceDir = path.join(root, "Inputs");
const rows = [],
  hash = (b) => createHash("sha256").update(b).digest("hex");
let app, page, modules;
const emit = (r) => {
  rows.push(r);
  console.log("RIO_PLAYER_STABLE", JSON.stringify(r));
};
const main = async (fn, args) => app.evaluate(fn, { modules, ...args });
async function state() {
  return main((_, { modules }) => {
    const req = process
        .getBuiltinModule("module")
        .createRequire(modules.playback),
      use = req(modules.playback).playbackUse,
      manager = req(modules.manager).stableSources;
    return {
      active: manager.activeSources,
      held: !!globalThis.playerLabHold,
      sources: [...use.sources.values()].map((s) => ({
        id: s.id,
        isolated: !!s.isolated,
        pending: !!s.preparing && !s.isolated,
        retired: s.retired,
        metrics: s.isolated?.metrics,
      })),
      preparation: globalThis.playerLabTimes || [],
    };
  });
}
async function hold(failure) {
  await main(
    (_, { modules, failure }) => {
      const req = process
          .getBuiltinModule("module")
          .createRequire(modules.manager),
        manager = req(modules.manager).stableSources;
      const original = manager.factory;
      manager.factory = (config) => {
        manager.factory = original;
        const backend = original(config);
        return {
          capture: async () => {
            await new Promise(
              (resolve) => (globalThis.playerLabHold = resolve),
            );
            if (failure)
              throw Object.assign(Error("Disposable acquisition failure"), {
                code: failure,
              });
            return backend.capture();
          },
          check: () => backend.check(),
          assertAvailable: () => backend.assertAvailable?.(),
          read: (at, n) => backend.read(at, n),
          close: () => backend.close(),
        };
      };
    },
    { failure },
  );
}
async function releaseHold() {
  await app.evaluate(() => {
    globalThis.playerLabHold?.();
    delete globalThis.playerLabHold;
    globalThis.stableMetaAutoRelease = true;
    globalThis.stableMetaFailRecovery = false;
    globalThis.stableMetaRelease?.();
  });
}
async function failCloseOnce(afterClosure) {
  await main(
    (_, { modules, afterClosure }) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(modules.manager);
      const { stableSources, PlaybackCleanupError } = require(modules.manager);
      if (stableSources.entries.size !== 1)
        throw Error("Expected one disposable playback source");
      const [{ backend }] = stableSources.entries;
      const close = backend.close;
      backend.close = async () => {
        backend.close = close;
        const error = Error("Disposable playback close fault");
        if (afterClosure) {
          await close.call(backend);
          throw new PlaybackCleanupError(error);
        }
        throw error;
      };
    },
    { afterClosure },
  );
}
const row = (id) => page.locator(`.song-row[data-track-id="${id}"]`);
async function play(id) {
  await row(id)
    .getByRole("button", { name: /^Play / })
    .click();
  try {
    await expect
      .poll(
        () =>
          page.evaluate((id) => {
            const a = document.querySelector("audio");
            return (
              !!a.currentSrc &&
              new URL(a.currentSrc).pathname.slice(1) === id &&
              !a.paused &&
              a.readyState >= 3 &&
              a.currentTime > 0.1
            );
          }, id),
        { timeout: 30000 },
      )
      .toBe(true);
  } catch (error) {
    console.log(
      "PLAYER_DIAGNOSTIC",
      JSON.stringify({
        audio: await page.evaluate(() => {
          const a = document.querySelector("audio");
          return {
            src: a.currentSrc,
            paused: a.paused,
            position: a.currentTime,
            ready: a.readyState,
            network: a.networkState,
            error: a.error?.message,
            events: window.playerLab?.events,
          };
        }),
        notices: await page.getByRole("alert").allTextContents(),
        ownership: await state(),
      }),
    );
    throw error;
  }
}
async function qualifyMetadata(ids) {
  const { qualifyStableMetadata } = await import("./lib/stable-metadata.mjs");
  await qualifyStableMetadata({
    getApp: () => app,
    getPage: () => page,
    modules,
    ids,
    naturalOnly: process.argv.includes("--natural-save-only"),
    emit,
    restart: async (alreadyClosed = false) => {
      if (!alreadyClosed) await app.close();
      app = await electron.launch({
        ...(executable
          ? { executablePath: executable, args: [] }
          : { args: ["."] }),
        env: {
          ...process.env,
          RIO_DATA_DIR: path.join(root, "Profile"),
          RIO_STABLE_PLAYBACK_SOURCES: "1",
          RIO_METADATA_TIMING: "1",
        },
        timeout: 30000,
      });
      page = await app.firstWindow();
      await row(ids.A).waitFor();
      await play(ids.A);
    },
  });
}
async function seek(p) {
  await page.getByRole("slider", { name: "Seek", exact: true }).fill(String(p));
}
async function idle(id) {
  return main(
    (_, { modules, id }) => {
      const req = process
          .getBuiltinModule("module")
          .createRequire(modules.playback),
        use = req(modules.playback).playbackUse;
      try {
        const l = use.usageFor(use.currentLibrary).acquireIdle(id);
        l.release();
        return true;
      } catch {
        return false;
      }
    },
    { id },
  );
}
try {
  if (volumeKind) {
    assert(["noowners", "unsupported"].includes(volumeKind));
    volume = await (volumeKind === "noowners"
      ? localMetadataVolume(
          root,
          process.argv.includes("--large-fixture") ? "512m" : undefined,
        )
      : unsupportedMetadataVolume(root));
  }
  await mkdir(sourceDir);
  const files = {
    a: path.join(sourceDir, "A.flac"),
    b: path.join(sourceDir, "B.flac"),
    short: path.join(sourceDir, "Short.flac"),
    wav: path.join(sourceDir, "Other.wav"),
    ref: path.join(sourceDir, "Reference.flac"),
    bad: path.join(sourceDir, "Broken.flac"),
  };
  await writeFile(
    files.a,
    playbackFlacFixture(
      [
        ["TITLE", "A"],
        ["ALBUM", "A"],
      ],
      30,
      1234,
    ),
  );
  await writeFile(
    files.b,
    playbackFlacFixture(
      [
        ["TITLE", "B"],
        ["ALBUM", "B"],
      ],
      30,
      2345,
    ),
  );
  await writeFile(
    files.short,
    playbackFlacFixture(
      [
        ["TITLE", "Short"],
        ["ALBUM", "C"],
      ],
      1,
      1234,
    ),
  );
  await writeFile(files.wav, wavFixture());
  await writeFile(
    files.ref,
    playbackFlacFixture([["TITLE", "Reference"]], 30, 1234),
  );
  const broken = playbackFlacFixture([["TITLE", "Broken"]], 30, 1234);
  let audioStart = 4;
  for (;;) {
    const last = !!(broken[audioStart] & 128),
      length = broken.readUIntBE(audioStart + 1, 3);
    audioStart += 4 + length;
    if (last) break;
  }
  broken.fill(0, audioStart); // Intact catalog tags, invalid encoded frames: actual decoder failure.
  await writeFile(files.bad, broken);
  const largeIndex = process.argv.indexOf("--large-fixture");
  if (largeIndex >= 0) {
    const input = await realpath(process.argv[largeIndex + 1]);
    if (!input.startsWith("/private/tmp/rio-"))
      throw Error("Require known disposable large fixture");
    const bytes = await readFile(input);
    assert(
      bytes.length <= MAX_FLAC_FILE_BYTES &&
        bytes.subarray(0, 4).toString() === "fLaC",
    );
    if (
      process.argv.includes("--metadata") &&
      !process.argv.includes("--preserve-fixture-tags")
    ) {
      // Same canonical synthetic-tag preparation as the Phase 2D.3 benchmark.
      // Do not repair production files or relax preservation of lowercase ENCODER.
      const parts = inspectFlac(bytes);
      const canonical = Buffer.concat([
        Buffer.from("fLaC"),
        ...parts.blocks.map((b, i) =>
          block(
            b.type,
            b.type === 4
              ? commentBlock([
                  ["TITLE", "A"],
                  ["ALBUM", "A"],
                  ["GENRE", "Fixture"],
                  ["ENCODER", "Synthetic encoder"],
                ])
              : b.body,
            i === parts.blocks.length - 1,
          ),
        ),
        parts.audio,
      ]);
      assert.equal(hash(inspectFlac(canonical).audio), hash(parts.audio));
      await writeFile(files.a, canonical);
    } else await writeFile(files.a, bytes);
  }
  const originals = Object.fromEntries(
    await Promise.all(
      Object.values(files).map(async (f) => [
        f,
        { sha: hash(await readFile(f)), mtime: (await stat(f)).mtimeMs },
      ]),
    ),
  );
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: {
      ...process.env,
      RIO_DATA_DIR: path.join(root, "Profile"),
      RIO_STABLE_PLAYBACK_SOURCES: flag ? "1" : "0",
      RIO_METADATA_TIMING: process.argv.includes("--metadata")
        ? "1"
        : process.env.RIO_METADATA_TIMING || "0",
    },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(10000);
  page.on("console", (m) => {
    if (m.type() === "error") console.log("PLAYER_CONSOLE", m.text());
  });
  page.on("requestfailed", (r) =>
    console.log("PLAYER_REQUEST_FAILED", r.url(), r.failure()),
  );
  await page.waitForSelector("h1");
  modules = await app.evaluate(({ app }, packaged) => {
    if (app.isPackaged !== packaged) throw Error("Wrong application mode");
    const p = process.getBuiltinModule("path"),
      base = app.getAppPath();
    return {
      base,
      playback: p.join(base, "dist/main/playback-use.js"),
      manager: p.join(base, "dist/main/stable-source-manager.js"),
      library: p.join(base, "dist/domain/library.js"),
      worker: p.join(base, "dist/main/stable-source-worker.js"),
    };
  }, packaged);
  const provenance = await main((_, { modules }) => {
    const fs = process.getBuiltinModule("fs"),
      p = process.getBuiltinModule("path"),
      crypto = process.getBuiltinModule("crypto");
    const files = [
      "dist/main/main.js",
      "dist/main/preload.cjs",
      "dist/main/playback-use.js",
      "dist/main/stable-source-manager.js",
      "dist/main/stable-source-worker.js",
      "dist/domain/metadata-edit.js",
      "dist/renderer/index.html",
      ...(process.platform === "darwin"
        ? ["dist/native/playback-source.node"]
        : []),
    ];
    return files.map((relative) => {
      const filename = p.join(modules.base, relative);
      return {
        relative,
        filename,
        sha256: crypto
          .createHash("sha256")
          .update(fs.readFileSync(filename))
          .digest("hex"),
      };
    });
  });
  if (packaged)
    assert(
      modules.base.includes(".asar"),
      "Production code must be inside application resources",
    );
  emit({ event: "provenance", packaged, flag, modules, files: provenance });
  const ids = await main(
    async ({ dialog, Menu }, { modules, libraryPath, files, mediaRoot }) => {
      const req = process
          .getBuiltinModule("module")
          .createRequire(modules.library),
        { Library } = req(modules.library),
        l = await Library.open(libraryPath, { setupMediaRoot: true });
      let ids;
      try {
        if (mediaRoot) {
          await process.getBuiltinModule("fs/promises").mkdir(mediaRoot);
          await l.chooseMediaRoot(mediaRoot);
        }
        l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
        const added = await l.add([
          files.a,
          files.b,
          files.short,
          files.wav,
          files.bad,
        ]);
        if (added.errors.length) throw Error(JSON.stringify(added.errors));
        l.saveMediaSettings({ copyOnAdd: false });
        await l.add([files.ref]);
        ids = Object.fromEntries(l.tracks().map((t) => [t.title, t.id]));
        ids.A = l
          .tracks()
          .find(
            (t) =>
              process.getBuiltinModule("path").basename(t.path) === "A.flac",
          ).id;
        ids.wav = l.tracks().find((t) => t.format === "wav").id;
        l.favorite(ids.A);
        l.createPlaylist("Stable source references", [ids.A]);
        l.saveState({
          ...l.state(),
          view: "Songs",
          queue: [ids.A, ids.B, ids.Short],
          currentId: null,
          volume: 0.7,
        });
      } finally {
        l.close();
      }
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [libraryPath],
      });
      Menu.getApplicationMenu()
        .items.find((x) => x.label === "File")
        .submenu.items.find((x) => x.label === "Choose Library…")
        .click();
      return ids;
    },
    {
      libraryPath,
      files,
      mediaRoot: volume && path.join(volume.directory, "Rio Media"),
    },
  );
  await row(ids.A).waitFor();
  await main((_, { modules }) => {
    const req = process
        .getBuiltinModule("module")
        .createRequire(modules.manager),
      manager = req(modules.manager).stableSources,
      original = manager.factory;
    globalThis.playerLabTimes = [];
    manager.factory = (config) => {
      const constructionAt = performance.now();
      const backend = original(config);
      const constructorMs = performance.now() - constructionAt;
      return {
        capture: async () => {
          const t = performance.now(),
            cpu = process.cpuUsage();
          let previous = t,
            maxGapMs = 0;
          const timer = setInterval(() => {
            const now = performance.now();
            maxGapMs = Math.max(maxGapMs, now - previous);
            previous = now;
          }, 5);
          try {
            return await backend.capture();
          } finally {
            clearInterval(timer);
            globalThis.playerLabTimes.push({
              ms: performance.now() - t,
              constructorMs,
              processCpuMs:
                (process.cpuUsage(cpu).user + process.cpuUsage(cpu).system) /
                1000,
              peakMainAndWorkerRssBytes: process.resourceUsage().maxRSS * 1024,
              maxGapMs,
            });
          }
        },
        check: () => backend.check(),
        assertAvailable: () => backend.assertAvailable?.(),
        read: (at, n) => backend.read(at, n),
        close: () => backend.close(),
      };
    };
  });
  // Observe the production HTMLMediaElement without changing protocol/CORS policy.
  // loadeddata means Chromium decoded the first frame; this is not acoustic proof.
  await page.evaluate(() => {
    const a = document.querySelector("audio");
    const lab = (window.playerLab = {
      events: [],
      clickAt: 0,
      firstDecoded: null,
    });
    for (const event of [
      "loadeddata",
      "waiting",
      "stalled",
      "error",
      "playing",
      "pause",
      "seeking",
      "seeked",
    ])
      a.addEventListener(event, () => {
        if (event === "loadeddata" && lab.firstDecoded === null)
          lab.firstDecoded = performance.now();
        lab.events.push({
          event,
          t: performance.now(),
          sinceCommandMs: performance.now() - lab.clickAt,
        });
      });
    document.addEventListener(
      "click",
      (e) => {
        if (
          e.target.closest(
            '.song-play,.play-button,button[aria-label="Next track"],button[aria-label="Previous track"]',
          )
        )
          lab.clickAt = performance.now();
      },
      true,
    );
  });
  await app.evaluate(() => {
    const loop = (globalThis.playerLabLoop = {
      previous: performance.now(),
      maxGapMs: 0,
    });
    globalThis.playerLabLoopTimer = setInterval(() => {
      const now = performance.now();
      loop.maxGapMs = Math.max(loop.maxGapMs, now - loop.previous);
      loop.previous = now;
    }, 5);
  });
  await play(ids.A);
  const mainLoopMaxGapMs = await app.evaluate(() => {
    clearInterval(globalThis.playerLabLoopTimer);
    return globalThis.playerLabLoop.maxGapMs;
  });
  const first = await page.evaluate(() => {
    const l = window.playerLab;
    return {
      playToFirstDecodedDataMs:
        l.firstDecoded === null ? null : l.firstDecoded - l.clickAt,
    };
  });
  assert.equal(
    (await state()).sources.find((s) => s.id === ids.A).isolated,
    cloning,
  );
  assert.equal(await idle(ids.A), cloning);
  const validUrl = await page.evaluate(
    () => document.querySelector("audio").currentSrc,
  );
  assert.equal(
    await app.evaluate(
      async ({ net }, url) =>
        (await net.fetch(url.replace(/use=[^&]+/, "use=not-authorized")))
          .status,
      validUrl,
    ),
    403,
  );
  assert.equal(
    (await state()).sources.some((s) => s.id === ids.A),
    true,
  );
  assert.equal(
    first.playToFirstDecodedDataMs === null,
    false,
    "Must observe Chromium first decoded data",
  );
  emit({
    event: "first-play",
    mainLoopMaxGapMs,
    bytes: (await stat(files.a)).size,
    storage: volumeKind || (external ? "external APFS noowners" : "local APFS"),
    ...first,
    ...(await state()),
  });
  if (process.argv.includes("--metadata-fixture-only")) {
    assert(process.argv.includes("--metadata") && largeIndex >= 0 && flag);
    await qualifyMetadata(ids);
    await app.close();
    app = undefined;
  } else {
    for (let n = 0; n < 3; n++) {
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      assert.equal(await idle(ids.A), cloning);
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => !document.querySelector("audio").paused),
        )
        .toBe(true);
    }
    const seekEvents = await page.evaluate(
      () => window.playerLab.events.filter((e) => e.event === "seeked").length,
    );
    const seekAt = performance.now();
    await seek(8);
    await expect
      .poll(() =>
        page.evaluate(() => document.querySelector("audio").currentTime),
      )
      .toBeGreaterThan(7.9);
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            window.playerLab.events.filter((e) => e.event === "seeked").length,
        ),
      )
      .toBeGreaterThan(seekEvents);
    emit({ event: "seek", seekedMs: performance.now() - seekAt });
    await page.getByRole("button", { name: "Next track", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            new URL(document.querySelector("audio").currentSrc).pathname.slice(
              1,
            ) === id,
          ids.B,
        ),
      )
      .toBe(true);
    await expect.poll(() => idle(ids.A)).toBe(true);
    await page
      .getByRole("button", { name: "Previous track", exact: true })
      .click();
    await expect
      .poll(() =>
        page.evaluate(
          (id) =>
            new URL(document.querySelector("audio").currentSrc).pathname.slice(
              1,
            ) === id,
          ids.A,
        ),
      )
      .toBe(true);
    emit({
      event: "transport",
      decodedTransitions: await page.evaluate(() =>
        window.playerLab.events.filter((e) => e.event === "loadeddata"),
      ),
      note: "Chromium decoded-data readiness; no PCM/acoustic continuity assertion",
    });
    await play(ids.Short);
    await expect
      .poll(() => page.evaluate(() => document.querySelector("audio").ended), {
        timeout: 10000,
      })
      .toBe(true);
    assert.equal(await idle(ids.Short), cloning); // isolated source owns only its verified revision
    await play(ids.Reference);
    assert.equal((await state()).active, 0);
    await play(ids.wav);
    assert.equal((await state()).active, 0);
    if (cloning) {
      const duration = await page.evaluate(async (id) => {
        const { tracks } = await window.rio.snapshot();
        return tracks.find((track) => track.id === id)?.duration;
      }, ids.A);
      assert(duration >= 11, "Track A must have an 11-second seek position.");
      const seekRange = () =>
        page
          .getByRole("slider", { name: "Seek", exact: true })
          .evaluate((el) => {
            const audio = document.querySelector("audio");
            return {
              currentId: document.querySelector(".song-row.is-playing")?.dataset
                .trackId,
              min: Number(el.min),
              max: Number(el.max),
              enabled: !el.disabled,
              sourceAttached: audio.hasAttribute("src"),
              decoderDuration: Number.isFinite(audio.duration)
                ? audio.duration
                : null,
            };
          });
      await hold();
      await row(ids.A)
        .getByRole("button", { name: /^Play / })
        .click();
      await expect.poll(async () => (await state()).held).toBe(true);
      const started = performance.now();
      const initial = await seekRange();
      // Main reaching the capture hold does not mean React has rendered the
      // selected track's duration. Observe the catalog range before attaching.
      await expect
        .poll(seekRange, {
          message: "Track A must expose its seek range while capture is held",
        })
        .toMatchObject({
          currentId: ids.A,
          min: 0,
          max: duration,
          enabled: true,
          sourceAttached: false,
        });
      assert.equal((await state()).held, true);
      emit({
        event: "pending-seek-range",
        catalogDuration: duration,
        initial,
        ready: await seekRange(),
        elapsedMs: performance.now() - started,
      });
      await seek(11);
      await page.getByRole("button", { name: "Pause", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Play", exact: true }),
      ).toBeVisible();
      assert.equal((await state()).held, true);
      await releaseHold();
      await expect
        .poll(() =>
          page.evaluate(() => document.querySelector("audio").readyState >= 3),
        )
        .toBe(true);
      assert.equal(
        await page.evaluate(() => document.querySelector("audio").paused),
        true,
      );
      assert(
        (await page.evaluate(
          () => document.querySelector("audio").currentTime,
        )) >= 10.9,
      );
      await page.getByRole("button", { name: "Play", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => !document.querySelector("audio").paused),
        )
        .toBe(true);
      emit({ event: "pending-seek-pause-resume", passed: true });
      await play(ids.wav);
      await hold();
      await row(ids.A)
        .getByRole("button", { name: /^Play / })
        .click();
      await expect.poll(async () => (await state()).held).toBe(true);
      await page
        .getByRole("button", { name: "Next track", exact: true })
        .click();
      await releaseHold();
      await expect
        .poll(
          () =>
            page.evaluate((id) => {
              const a = document.querySelector("audio");
              return (
                !!a.currentSrc &&
                new URL(a.currentSrc).pathname.slice(1) === id &&
                !a.paused
              );
            }, ids.B),
          { timeout: 30000 },
        )
        .toBe(true);
      await expect.poll(() => idle(ids.A)).toBe(true);
      emit({ event: "next-during-acquisition", passed: true });
      for (const code of ["ENOSPC", "EIO"]) {
        await play(ids.wav);
        await hold(code);
        await row(ids.A)
          .getByRole("button", { name: /^Play / })
          .click();
        await expect.poll(async () => (await state()).held).toBe(true);
        await releaseHold();
        await expect(
          page
            .getByRole("alert")
            .filter({ hasText: "Rio could not prepare this track" }),
        ).toBeVisible();
        assert.equal((await state()).active, 0);
        assert.equal(await idle(ids.A), true);
        emit({ event: "failed-acquisition", code, noFallback: true });
      }
    }
    await row(ids.Broken)
      .getByRole("button", { name: /^Play / })
      .click();
    await expect(
      page
        .getByRole("alert")
        .filter({ hasText: /cannot decode|couldn.t play|could not|Audio/i }),
    ).toBeVisible();
    await expect.poll(() => idle(ids.Broken)).toBe(true);
    await expect.poll(async () => (await state()).active).toBe(0);
    emit({ event: "real-decoder-error", drained: true });
    await play(ids.A);
    // Removal uses the actual context-menu -> renderer -> production IPC flow.
    await play(ids.B);
    await app.evaluate(
      ({ Menu, dialog, shell }, libraryPath) => {
        Menu.prototype.popup = function () {
          globalThis.playerLabMenu = this;
        };
        dialog.showMessageBox = async () => ({ response: 1 });
        shell.trashItem = async (filename) => {
          const p = process.getBuiltinModule("path");
          if (!filename.startsWith(libraryPath + p.sep))
            throw Error("Non-disposable removal refused");
          await process.getBuiltinModule("fs/promises").unlink(filename);
        };
      },
      volume ? volume.directory : libraryPath,
    );
    await row(ids.B).click({ button: "right" });
    await app.evaluate(() => {
      const item = globalThis.playerLabMenu.getMenuItemById("track-delete");
      if (!item?.enabled) throw Error("Removal unavailable");
      item.click();
    });
    await expect(row(ids.B)).toHaveCount(0);
    await expect.poll(async () => (await state()).active).toBe(0);
    emit({ event: "current-source-removal", drained: true });
    await play(ids.A);
    await page.evaluate(async (id) => {
      const s = await window.rio.snapshot();
      await window.rio.saveState({ ...s.state, currentId: id, position: 0 });
    }, ids.A);
    // A real library switch revokes the old library, including its attached decoder.
    const otherLibrary = path.join(root, "Other Library");
    await main(
      async ({ dialog }, { modules, otherLibrary, files }) => {
        const req = process
          .getBuiltinModule("module")
          .createRequire(modules.library);
        const l = await req(modules.library).Library.open(otherLibrary, {
          setupMediaRoot: true,
        });
        try {
          await l.add([files.ref]);
        } finally {
          l.close();
        }
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [otherLibrary],
        });
      },
      { otherLibrary, files },
    );
    if (cloning) {
      const pointer = path.join(root, "Profile", "library.json");
      const before = await readFile(pointer);
      await failCloseOnce(false);
      await assert.rejects(
        page.evaluate(() => window.rio.chooseLibrary()),
        /confirm playback source closure/,
      );
      assert.deepEqual(await readFile(pointer), before);
      assert.equal(
        await page.evaluate(
          async () => (await window.rio.snapshot()).libraryPath,
        ),
        libraryPath,
      );
      assert.equal(await idle(ids.A), false);
      await failCloseOnce(true);
      emit({
        event: "library-switch-refused-with-unconfirmed-close",
        pointerUnchanged: true,
      });
    }
    await app.evaluate(({ Menu }) =>
      Menu.getApplicationMenu()
        .items.find((x) => x.label === "File")
        .submenu.items.find((x) => x.label === "Choose Library…")
        .click(),
    );
    await expect(row(ids.A)).toHaveCount(0);
    await expect.poll(async () => (await state()).active).toBe(0);
    emit({ event: "library-switch", drained: true });
    // Reopen the first fixture, exercising persisted current-track preload without Play.
    await app.evaluate(({ Menu, dialog }, libraryPath) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [libraryPath],
      });
      Menu.getApplicationMenu()
        .items.find((x) => x.label === "File")
        .submenu.items.find((x) => x.label === "Choose Library…")
        .click();
    }, libraryPath);
    await row(ids.A).waitFor();
    await expect
      .poll(async () =>
        (await state()).sources.some((s) => s.id === ids.A && !s.pending),
      )
      .toBe(true);
    assert.equal(await idle(ids.A), cloning);
    const beforePreloadedPlay = (await state()).preparation.length;
    await page.getByRole("button", { name: "Play", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => !document.querySelector("audio").paused))
      .toBe(true);
    assert.equal((await state()).preparation.length, beforePreloadedPlay);
    emit({ event: "restored-preload-reused", passed: true });
    if (process.platform === "darwin") {
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].close(),
      );
      await expect.poll(async () => (await state()).sources.length).toBe(0);
      assert.equal((await state()).active, 0);
      const nextWindow = app.waitForEvent("window");
      await app.evaluate(({ app }) => app.emit("activate"));
      page = await nextWindow;
      await row(ids.A).waitFor();
      await play(ids.A);
      emit({ event: "window-destruction-and-reopen", drained: true });
    }
    if (process.argv.includes("--disconnect")) {
      assert(
        volume && volumeKind === "noowners",
        "Disconnect only a disposable APFS image",
      );
      const unavailableEdit = process.argv.includes("--metadata")
        ? await (
            await import("./lib/stable-metadata.mjs")
          ).prepareUnavailableMetadata({
            getApp: () => app,
            getPage: () => page,
            modules,
            id: ids.A,
            emit,
          })
        : null;
      await promisify(execFile)("/usr/bin/hdiutil", [
        "detach",
        "-force",
        volume.directory,
      ]);
      volume = null;
      await unavailableEdit?.();
      await play(ids.Reference); // drain the old, possibly buffered clone
      await row(ids.A)
        .getByRole("button", { name: /^Play / })
        .click();
      await expect.poll(async () => (await state()).active).toBe(0);
      await expect
        .poll(() =>
          page.evaluate(
            async (id) =>
              (await window.rio.snapshot()).tracks.find((t) => t.id === id)
                ?.missing,
            ids.A,
          ),
        )
        .toBe(true);
      assert.equal(await idle(ids.A), true);
      await play(ids.Reference);
      emit({
        event: "disposable-volume-removal",
        newUseRejected: true,
        drained: true,
      });
    }
    const quitProof = path.join(root, "quit.json");
    await main(
      ({ app }, { modules, quitProof }) => {
        const req = process
          .getBuiltinModule("module")
          .createRequire(modules.manager);
        app.on("will-quit", () => {
          process.getBuiltinModule("fs").writeFileSync(
            quitProof,
            JSON.stringify({
              active: req(modules.manager).stableSources.activeSources,
              sources: req(modules.playback).playbackUse.sources.size,
            }),
          );
        });
      },
      { quitProof },
    );
    if (cloning && !process.argv.includes("--disconnect")) {
      await failCloseOnce(false);
      await app.evaluate(({ app, dialog }) => {
        const showErrorBox = dialog.showErrorBox;
        dialog.showErrorBox = (title) => {
          globalThis.playerLabQuitError = title;
          dialog.showErrorBox = showErrorBox;
        };
        app.quit();
      });
      await expect
        .poll(() => app.evaluate(() => globalThis.playerLabQuitError))
        .toBe("Rio could not finish quitting");
      expect((await state()).sources.length).toBe(1);
      assert.equal(await idle(ids.A), false);
      emit({ event: "quit-reports-unconfirmed-close", retryable: true });
    }
    await app.close();
    app = undefined;
    assert.deepEqual(JSON.parse(await readFile(quitProof, "utf8")), {
      active: 0,
      sources: 0,
    });
    emit({ event: "application-quit", drained: true });
    if (!process.argv.includes("--disconnect")) {
      // Playwright crash targets cannot be reused. Start a fresh production session,
      // qualify restored acquisition again, then crash that renderer as the last test.
      app = await electron.launch({
        ...(executable
          ? { executablePath: executable, args: [] }
          : { args: ["."] }),
        env: {
          ...process.env,
          RIO_DATA_DIR: path.join(root, "Profile"),
          RIO_STABLE_PLAYBACK_SOURCES: flag ? "1" : "0",
          RIO_METADATA_TIMING: process.argv.includes("--metadata")
            ? "1"
            : process.env.RIO_METADATA_TIMING || "0",
        },
        timeout: 30000,
      });
      page = await app.firstWindow();
      await row(ids.A).waitFor();
      await play(process.argv.includes("--disconnect") ? ids.Reference : ids.A);
      if (process.argv.includes("--metadata")) {
        assert(
          cloning,
          "Metadata concurrency qualification requires APFS isolation",
        );
        await qualifyMetadata(ids);
      }
      await main(({ BrowserWindow }, { modules }) => {
        const req = process
            .getBuiltinModule("module")
            .createRequire(modules.playback),
          use = req(modules.playback).playbackUse;
        globalThis.playerLabOld = use.currentLibrary.directory;
        BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
      });
      await expect
        .poll(async () => (await state()).active, { timeout: 15000 })
        .toBe(0);
      await expect.poll(async () => (await state()).sources.length).toBe(0);
      assert.equal(await idle(ids.A), true);
      emit({ event: "renderer-crash", drained: true });

      await app.close();
      app = undefined;
    }
  }
  for (const [file, before] of Object.entries(originals)) {
    assert.equal(hash(await readFile(file)), before.sha);
    assert.equal((await stat(file)).mtimeMs, before.mtime);
  }
  const output = process.argv.indexOf("--output");
  if (output >= 0)
    await writeFile(
      process.argv[output + 1],
      JSON.stringify({ packaged, flag, rows }, null, 2) + "\n",
    );
  console.log("Real player stable-source qualification passed.");
} finally {
  if (app) {
    await releaseHold().catch(() => {});
    await app.close();
  }
  if (volume) await volume.close();
  if (external) await rm(external, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
