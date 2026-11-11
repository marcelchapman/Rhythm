// Phase 2E.1 lab only. No production module is rewritten and no editing IPC is added.
// A temporary coordinator copy defers the ORIGINAL idle gate until before publish.
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright";
import { expect } from "playwright/test";
import { execFileSync } from "node:child_process";
import { parseFile } from "music-metadata";
import {
  playbackFlacFixture,
  inspectFlac,
  block,
  commentBlock,
} from "../../tests/metadata-fixtures.ts";

const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const scratch = await mkdtemp("/private/tmp/rio-2e1-");
const external = await mkdtemp(path.join(repo, ".rio-2e1-"));
let desktop;
try {
  const coordinator = path.join(repo, "dist/domain/metadata-edit.js");
  const copy = path.join(scratch, "research-coordinator.mjs");
  const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const sourceHash = digest(await readFile(coordinator));
  const proof = async (filename) => ({
    sha: digest(await readFile(filename)),
    mtime: (await stat(filename)).mtimeMs,
  });
  const emit = (value) => console.log("RIO_FEASIBILITY", JSON.stringify(value));
  function replaceExactly(text, from, to, expected = 1) {
    assert.equal(
      text.split(from).length - 1,
      expected,
      `Unexpected coordinator shape: ${from}`,
    );
    return text.split(from).join(to);
  }
  let study = await readFile(coordinator, "utf8");
  study = replaceExactly(
    study,
    '    timing?.("playback-gate-start");\n    const use = options.usage?.acquireIdle(trackId);\n    timing?.("playback-gate-acquired");\n    if (!use)\n        throw new Error("A reliable idle playback-use lease is required; editing an in-use or unknown target is not permitted.");',
    '    if (!options.usage) throw new Error("Research requires the production usage capability");\n    let use;',
  );
  study = replaceExactly(
    study,
    'await options.hooks?.at?.("before-publish", id);',
    'await options.hooks?.at?.("before-publish", id);\n        timing?.("playback-gate-start");\n        use = options.usage.acquireIdle(trackId);\n        use.assertIdle();\n        timing?.("playback-gate-acquired");',
    2,
  );
  study = replaceExactly(
    study,
    "        use.release();",
    "        use?.release();",
  );
  study = study.replace(
    /from "(\.\/[^\"]+)"/g,
    (_, relative) =>
      `from ${JSON.stringify(new URL(relative, pathToFileURL(coordinator)).href)}`,
  );
  study = study.replaceAll(
    "import.meta.url",
    JSON.stringify(pathToFileURL(coordinator).href),
  );
  await writeFile(copy, study);
  const decoderSource = await readFile(
    path.join(repo, "src/renderer/media-source.ts"),
    "utf8",
  );
  await writeFile(
    path.join(scratch, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2023",
        module: "ESNext",
        lib: ["ES2023", "DOM"],
        types: [],
        skipLibCheck: true,
        rootDir: path.join(repo, "src/renderer"),
        outDir: path.join(scratch, "renderer"),
      },
      files: [path.join(repo, "src/renderer/media-source.ts")],
    }),
  );
  execFileSync(path.join(repo, "node_modules/.bin/tsc"), [
    "-p",
    path.join(scratch, "tsconfig.json"),
  ]);
  const decoder = (
    await readFile(path.join(scratch, "renderer/media-source.js"), "utf8")
  ).replace("export class MediaSource", "class MediaSource");
  const results = [];

  async function installMain({ app, BrowserWindow, ipcMain }, { repo, copy }) {
    const require = process
      .getBuiltinModule("module")
      .createRequire(repo + "/dist/main/main.js");
    const { playbackUse: use } = require(repo + "/dist/main/playback-use.js");
    const { Library } = require(repo + "/dist/domain/library.js");
    const originalCoordinator = require(repo + "/dist/domain/metadata-edit.js");
    const researchCoordinator = require(copy);
    const assert = process.getBuiltinModule("assert/strict");
    assert.equal(app.isPackaged, false);
    const owner = BrowserWindow.getAllWindows()[0].webContents;
    const lab = (globalThis.playbackFeasibility = {
      use,
      Library,
      originalCoordinator,
      researchCoordinator,
      owner,
      experiment: null,
      samples: [],
      acquireHold: null,
    });
    const realMedia = Library.prototype.media;
    Library.prototype.media = function (id) {
      const result = realMedia.call(this, id);
      if (result) return result;
      const e = lab.experiment;
      if (!e || e.library !== this || e.id !== id || e.exclusive || e.cancelled)
        return;
      const pending = this.db
        .prepare(
          "SELECT id,phase,journal FROM metadata_edits WHERE trackId=? AND phase NOT IN ('done','aborted')",
        )
        .get(id);
      if (
        !pending ||
        pending.id !== e.editId ||
        !["preparing", "staged"].includes(pending.phase)
      )
        return;
      const journal = JSON.parse(pending.journal);
      if (journal.writeStarted) return;
      const track = this.tracks(id)[0];
      if (
        track.path !== e.path ||
        journal.filename !== e.path ||
        journal.originalSha256 !== e.originalDigest
      )
        return;
      // Narrow lab exception: exact live, read-only preparation; never recovery rows.
      return { path: track.path, format: track.format };
    };
    const acquire = use.acquire.bind(use);
    use.acquire = (owner, id, directory) => {
      const e = lab.experiment;
      if (e?.exclusive && id === e.id && directory === e.library.directory)
        throw Error("Research publication admission reserved");
      return acquire(owner, id, directory);
    };
    const originalHandler = ipcMain._invokeHandlers.get("playback:acquire");
    ipcMain.removeHandler("playback:acquire");
    ipcMain.handle("playback:acquire", async (...args) => {
      const result = await originalHandler(...args);
      if (lab.acquireHold?.id === args[1]) {
        lab.acquireHeld = true;
        await new Promise((resolve) => {
          lab.acquireRelease = resolve;
        });
      }
      return result;
    });
    const shutdown = use.shutdown.bind(use);
    use.shutdown = async () => {
      if (lab.experiment) {
        lab.experiment.cancelled = true;
        lab.experiment.proceed?.();
        lab.experiment.continuePreparation?.();
        await lab.running;
      }
      return shutdown();
    };
    owner.on("render-process-gone", () => {
      if (lab.experiment) {
        lab.experiment.cancelled = true;
        lab.experiment.proceed?.();
        lab.experiment.continuePreparation?.();
      }
    });
    owner.on("destroyed", () => {
      if (lab.experiment) {
        lab.experiment.cancelled = true;
        lab.experiment.proceed?.();
        lab.experiment.continuePreparation?.();
      }
    });
  }

  async function installTransport(page) {
    await page.evaluate(
      decoder + "\nwindow.FeasibilityMediaSource = MediaSource;",
    );
    await page.evaluate(() => {
      const audio = document.createElement("audio");
      audio.id = "feasibility-decoder";
      audio.muted = true;
      document.body.append(audio);
      const lab = (window.playbackFeasibility = {
        audio,
        revision: 0,
        intent: null,
        releases: [],
        events: [],
      });
      lab.loader = new window.FeasibilityMediaSource(audio, async (url) => {
        const { id, directory } = JSON.parse(url);
        const lease = await window.rio.acquirePlayback(id, directory);
        lab.lease = lease;
        return {
          url: lease.url,
          release: () => {
            const promise = window.rio.releasePlayback(lease.token);
            lab.releases.push(promise);
            return promise;
          },
        };
      });
      lab.apply = async (intent) => {
        const stamps = {};
        const started = performance.now();
        const events = [
          "loadstart",
          "loadedmetadata",
          "seeked",
          "canplay",
          "playing",
        ];
        const stamp = (event) => {
          stamps[event.type] ??= performance.now() - started;
        };
        for (const name of events) audio.addEventListener(name, stamp);
        try {
          const readyStart = performance.now();
          await lab.loader.ensure(
            `${intent.directory}\0${intent.id}`,
            JSON.stringify(intent),
            intent.position,
            true,
          );
          const readyMs = performance.now() - readyStart;
          if (lab.revision !== intent.revision) return { stale: true };
          const restoredPosition = audio.currentTime;
          let resumeMs = 0;
          if (intent.playing) {
            const start = performance.now();
            await audio.play();
            resumeMs = performance.now() - start;
          }
          return {
            readyMs,
            resumeMs,
            sourceReopenMs: stamps.loadedmetadata,
            seekFromMetadataMs:
              (stamps.seeked ?? readyMs) - (stamps.loadedmetadata ?? 0),
            playingEventMs: stamps.playing,
            restoredPosition,
            paused: audio.paused,
          };
        } catch (error) {
          return { error: String(error) };
        } finally {
          for (const name of events) audio.removeEventListener(name, stamp);
        }
      };
      lab.command = (id, directory, position = 0, playing = true) => {
        const intent = (lab.intent = {
          id,
          directory,
          position,
          playing,
          revision: ++lab.revision,
        });
        return lab.apply(intent);
      };
      lab.pauseIntent = () => {
        lab.revision++;
        lab.intent = { ...lab.intent, revision: lab.revision, playing: false };
        audio.pause();
      };
      lab.seekIntent = (position) => {
        lab.revision++;
        lab.intent = { ...lab.intent, revision: lab.revision, position };
      };
      lab.capture = () => ({
        ...lab.intent,
        position: audio.currentTime,
        playing: !audio.paused,
        token: lab.lease?.token,
      });
      lab.quiesce = async () => {
        const ticket = lab.capture();
        lab.ticket = ticket;
        lab.intent = {
          ...lab.intent,
          position: ticket.position,
          playing: ticket.playing,
        };
        lab.interruptionStart = performance.now();
        lab.loader.clear();
        // retire() invokes release in a microtask; await the real IPC acknowledgments.
        await Promise.resolve();
        await Promise.all(lab.releases);
        return {
          ticket,
          releaseMs: performance.now() - lab.interruptionStart,
          detached: !audio.getAttribute("src"),
        };
      };
      lab.restore = async () => {
        if (lab.ticket.revision !== lab.revision) return { stale: true };
        const result = await lab.apply({ ...lab.ticket });
        return {
          ...result,
          interruptionMs: performance.now() - lab.interruptionStart,
        };
      };
    });
  }

  async function launch(profile) {
    desktop = await electron.launch({
      args: [repo],
      env: { ...process.env, RIO_DATA_DIR: profile },
      timeout: 30000,
    });
    desktop.process().stderr.on("data", (data) => {
      if (process.env.RIO_FEASIBILITY_DEBUG) process.stderr.write(data);
    });
    const page = await desktop.firstWindow();
    await page.waitForSelector("h1");
    await desktop.evaluate(installMain, { repo, copy });
    await installTransport(page);
    return page;
  }

  async function startEdit(track, value, mode) {
    await desktop.evaluate(
      (_, { track, value, mode }) => {
        const lab = globalThis.playbackFeasibility;
        const library = lab.use.currentLibrary;
        const receipt = library.db
          .prepare("SELECT digest FROM managed_file_receipts WHERE trackId=?")
          .get(track.id);
        const e = (lab.experiment = {
          library,
          id: track.id,
          path: track.path,
          originalDigest: receipt.digest,
          mode,
          exclusive: false,
          cancelled: false,
          times: {},
          started: performance.now(),
          status: "preparing",
        });
        lab.running = lab.researchCoordinator
          .editManagedFlac(
            library,
            track.id,
            { genre: { action: "set", value } },
            {
              usage: lab.use.usageFor(library),
              timing: (stage, detail) => {
                if (detail) {
                  if (stage === "publication") e.strategy = detail.strategy;
                  (e.details ??= []).push({ category: stage, ...detail });
                } else e.times[stage] = performance.now() - e.started;
              },
              hooks: {
                at: async (phase, id) => {
                  e.editId = id;
                  if (e.cancelled)
                    throw Error("Research transport/session cancelled");
                  if (phase === "journal") {
                    e.status = "read-preparation";
                    const heldAt = performance.now();
                    await new Promise((resolve) => {
                      e.continuePreparation = resolve;
                    });
                    e.preparationHoldMs = performance.now() - heldAt;
                    if (e.cancelled)
                      throw Error("Research preparation cancelled");
                    e.status = "preparing";
                  }
                  if (phase === "before-publish") {
                    if (mode === "fail-before")
                      throw Error("Disposable prepublication failure");
                    // Close admission synchronously BEFORE any release/drain await.
                    e.exclusive = true;
                    e.boundaryReadyMs = performance.now() - e.started;
                    e.status = "boundary";
                    await new Promise((resolve) => {
                      e.proceed = resolve;
                    });
                    if (
                      e.cancelled ||
                      lab.use.currentLibrary !== library ||
                      lab.owner.isDestroyed()
                    )
                      throw Error("Research handoff invalidated");
                  }
                  if (phase === "published" && mode === "interrupt-after")
                    throw new lab.researchCoordinator.MetadataEditInterruption(
                      "Disposable postpublication interruption",
                    );
                },
              },
            },
          )
          .then(
            (result) => {
              e.result = {
                status: result.status,
                id: result.track.id,
                path: result.track.path,
              };
            },
            (error) => {
              e.error = String(error);
            },
          )
          .finally(() => {
            e.exclusive = false;
            e.status = "finished";
            e.elapsedMs = performance.now() - e.started;
          });
      },
      { track, value, mode },
    );
  }
  const state = () =>
    desktop.evaluate(() => {
      const e = globalThis.playbackFeasibility.experiment;
      if (!e) return null;
      const { library, proceed, ...rest } = e;
      return rest;
    });
  async function waitStatus(status) {
    await expect
      .poll(async () => (await state())?.status, { timeout: 30000 })
      .toBe(status);
  }
  async function waitAdvance(page) {
    const before = await page.evaluate(
      () => window.playbackFeasibility.audio.currentTime,
    );
    await page.waitForFunction((before) => {
      const a = window.playbackFeasibility.audio;
      return !a.paused && a.readyState >= 3 && a.currentTime > before + 0.1;
    }, before);
  }
  async function idle(id) {
    return desktop.evaluate((_, id) => {
      const l = globalThis.playbackFeasibility;
      try {
        const lease = l.use.usageFor(l.use.currentLibrary).acquireIdle(id);
        lease.assertIdle();
        lease.release();
        return true;
      } catch {
        return false;
      }
    }, id);
  }

  async function runCase(page, track, directory, name, strategy, size, other) {
    const value = `Lab ${name} ${results.length}`;
    await page.evaluate(
      ({ id, directory, paused }) =>
        window.playbackFeasibility.command(id, directory, 5, !paused),
      { id: track.id, directory, paused: name === "paused" },
    );
    if (name !== "paused") await waitAdvance(page);
    assert.equal(await idle(track.id), false);
    const before = await proof(track.path);
    await startEdit(track, value, name);
    await waitStatus("read-preparation");
    const token = await page.evaluate(
      () => window.playbackFeasibility.lease.token,
    );
    const read = await desktop.evaluate(
      async ({ net }, { token, id }) => {
        const response = await net.fetch(
          `rio-media://track/${id}?use=${token}`,
          { headers: { Range: "bytes=0-63" } },
        );
        return {
          status: response.status,
          bytes: (await response.arrayBuffer()).byteLength,
        };
      },
      { token, id: track.id },
    );
    assert.deepEqual(read, { status: 206, bytes: 64 });
    const switching = await page.evaluate(async () => {
      try {
        await window.rio.chooseLibrary();
        return false;
      } catch {
        return true;
      }
    });
    assert(
      switching,
      "The existing library operation must block switching during preparation",
    );
    // Exercise a newly requested decoder grant while the journal already exists.
    if (name === "request-during-prepare") {
      const allowed = await page.evaluate(
        ({ id, directory }) =>
          window.playbackFeasibility.command(id, directory, 7, true),
        { id: track.id, directory },
      );
      assert.equal(allowed.error, undefined);
      await waitAdvance(page);
    }
    if (name === "drain-reader") {
      await desktop.evaluate(async () => {
        const l = globalThis.playbackFeasibility,
          e = l.experiment;
        const grant = l.use.acquire(l.owner.id, e.id, e.library.directory);
        const response = await l.use.respond(
          grant.token,
          e.id,
          new Request(grant.url),
        );
        l.heldReader = response.body.getReader();
        l.heldReader.closed.catch(() => {});
        e.heldToken = grant.token;
      });
    }
    const observed = await page.evaluate(() => ({
      at: performance.now(),
      position: window.playbackFeasibility.audio.currentTime,
    }));
    await desktop.evaluate(() =>
      globalThis.playbackFeasibility.experiment.continuePreparation(),
    );
    if (name === "fail-before") {
      await waitStatus("finished");
      assert(
        (await state()).error.includes("Disposable prepublication failure"),
      );
      assert.deepEqual(await proof(track.path), before);
      await waitAdvance(page);
      results.push({
        name,
        strategy,
        bytes: size,
        prepublicationFailureRetainedOriginal: true,
      });
      emit(results.at(-1));
      await desktop.evaluate(() => {
        globalThis.playbackFeasibility.experiment = null;
      });
      return;
    }
    // Both real decoder time and new authenticated range reads continue during preparation.
    if (name !== "paused") await waitAdvance(page);
    await waitStatus("boundary");
    const progression = await page.evaluate(
      (before) => ({
        wallMs: performance.now() - before.at,
        advancedSeconds:
          window.playbackFeasibility.audio.currentTime - before.position,
      }),
      observed,
    );
    if (name !== "paused") assert(progression.advancedSeconds > 0.05);
    const prepared = await state();
    assert.equal(prepared.strategy, strategy);
    assert.deepEqual(await proof(track.path), before);
    // Reservation must reject a real playback IPC grant before the idle lease exists.
    const blocked = await page.evaluate(
      async ({ id, directory }) => {
        try {
          await window.rio.acquirePlayback(id, directory);
          return false;
        } catch {
          return true;
        }
      },
      { id: track.id, directory },
    );
    assert(blocked);
    const released = await page.evaluate(() =>
      window.playbackFeasibility.quiesce(),
    );
    assert(released.detached);
    const drained = await desktop.evaluate(async () => {
      const l = globalThis.playbackFeasibility,
        e = l.experiment;
      const sources = [...l.use.sources.values()].filter(
        (s) => s.id === e.id && s.library === e.library,
      );
      const readers = sources.reduce((n, s) => n + s.readers.size, 0);
      const started = performance.now();
      await Promise.all(sources.map((s) => l.use.release(s.owner, s.token)));
      const lease = l.use.usageFor(e.library).acquireIdle(e.id);
      lease.assertIdle();
      lease.release();
      return {
        remainingSources: [...l.use.sources.values()].filter(
          (s) => s.id === e.id,
        ).length,
        readers,
        drainMs: performance.now() - started,
      };
    });
    assert.equal(drained.remainingSources, 0);
    if (name === "drain-reader")
      assert(
        drained.readers > 0,
        "Must close a genuinely outstanding ReadStream",
      );
    // User commands during publication invalidate the old automatic resume ticket.
    if (name === "pause-during")
      await page.evaluate(() => window.playbackFeasibility.pauseIntent());
    if (name === "seek-during")
      await page.evaluate(() => window.playbackFeasibility.seekIntent(11));
    if (name === "switch-during") {
      const switched = await page.evaluate(
        ({ id, directory }) =>
          window.playbackFeasibility.command(id, directory, 3, true),
        { id: other.id, directory },
      );
      assert.equal(switched.error, undefined);
      await waitAdvance(page);
    }
    if (name === "request-during-publication") {
      const refused = await page.evaluate(
        ({ id, directory }) =>
          window.playbackFeasibility.command(id, directory, 9, true),
        { id: track.id, directory },
      );
      assert(refused.error.includes("Research publication admission reserved"));
    }
    await desktop.evaluate(() =>
      globalThis.playbackFeasibility.experiment.proceed(),
    );
    await waitStatus("finished");
    const finished = await state();
    if (name === "interrupt-after") {
      assert(
        finished.error?.includes("Disposable postpublication interruption"),
      );
      const pending = await desktop.evaluate(
        () =>
          globalThis.playbackFeasibility.use.currentLibrary.db
            .prepare(
              "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
            )
            .get().n,
      );
      assert.equal(pending, 1);
      results.push({ name, strategy, bytes: size, pendingRecovery: true });
      emit(results.at(-1));
      return;
    }
    assert.equal(finished.error, undefined);
    assert.equal(finished.result.status, "committed");
    assert.equal(finished.result.id, track.id);
    assert.equal(finished.result.path, track.path);
    let restored;
    if (name === "stale-reacquire") {
      await desktop.evaluate((_, id) => {
        const l = globalThis.playbackFeasibility;
        l.acquireHold = { id };
        l.acquireHeld = false;
      }, track.id);
      await page.evaluate(() => {
        window.playbackFeasibility.oldResume =
          window.playbackFeasibility.restore();
      });
      await expect
        .poll(() =>
          desktop.evaluate(() => globalThis.playbackFeasibility.acquireHeld),
        )
        .toBe(true);
      const switched = await page.evaluate(
        ({ id, directory }) =>
          window.playbackFeasibility.command(id, directory, 3, true),
        { id: other.id, directory },
      );
      assert.equal(switched.error, undefined);
      await desktop.evaluate(() => {
        const l = globalThis.playbackFeasibility;
        l.acquireHold = null;
        l.acquireRelease();
      });
      restored = await page.evaluate(
        () => window.playbackFeasibility.oldResume,
      );
      await expect.poll(() => idle(track.id)).toBe(true);
      await waitAdvance(page);
      assert.equal(
        await page.evaluate(() => window.playbackFeasibility.intent.id),
        other.id,
      );
      restored = { stale: true, lateGrantRetired: true };
    } else
      restored = await page.evaluate(() =>
        window.playbackFeasibility.restore(),
      );
    if (
      ["pause-during", "seek-during", "request-during-publication"].includes(
        name,
      )
    ) {
      assert(restored.stale);
      const latest = await page.evaluate(() =>
        window.playbackFeasibility.apply(window.playbackFeasibility.intent),
      );
      assert.equal(latest.error, undefined);
      if (name === "pause-during") assert.equal(latest.paused, true);
      else {
        assert(
          Math.abs(
            latest.restoredPosition - (name === "seek-during" ? 11 : 9),
          ) < 0.1,
        );
        await waitAdvance(page);
      }
    } else if (["switch-during", "stale-reacquire"].includes(name)) {
      assert(restored.stale);
      assert.equal(
        await page.evaluate(() => window.playbackFeasibility.intent.id),
        other.id,
      );
      await waitAdvance(page);
    } else {
      assert.equal(restored.error, undefined);
      assert(
        Math.abs(restored.restoredPosition - released.ticket.position) < 0.1,
      );
      assert.equal(restored.paused, name === "paused");
      if (name !== "paused") await waitAdvance(page);
    }
    const after = await parseFile(track.path);
    assert.equal(after.common.genre[0], value);
    const journal = await desktop.evaluate(
      () =>
        globalThis.playbackFeasibility.use.currentLibrary.db
          .prepare(
            "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
          )
          .get().n,
    );
    assert.equal(journal, 0);
    const staleStatus = await desktop.evaluate(
      async ({ net }, { id, token }) =>
        (await net.fetch(`rio-media://track/${id}?use=${token}`)).status,
      { id: track.id, token: released.ticket.token },
    );
    assert.equal(staleStatus, 403);
    const times = finished.times;
    results.push({
      name,
      strategy,
      bytes: size,
      preparationMs: finished.boundaryReadyMs - finished.preparationHoldMs,
      controllerPreparationHoldMs: finished.preparationHoldMs,
      candidateStageVerifyMs: finished.boundaryReadyMs - times.prepare,
      workerRoundtripPrepareMs: times.prepare - times.preflight,
      playbackDuringPreparation: progression,
      workerPrepareMs: finished.details
        .filter((d) => d.category === "worker" && d.mode === "prepare")
        .reduce((sum, d) => sum + d.wallMs, 0),
      releaseMs: released.releaseMs,
      extraDrainMs: drained.drainMs,
      outstandingReadersDrained: drained.readers,
      exclusiveMs: times["release-done"] - times["playback-gate-acquired"],
      revalidationMs: times.revalidate - times["revalidate-start"],
      publishMs: times.publish - times.revalidate,
      postVerifyMs: times["verify-published"] - times.publish,
      reconcileCleanupMs: times["release-done"] - times["verify-published"],
      restored,
    });
    emit(results.at(-1));
    await desktop.evaluate(() => {
      globalThis.playbackFeasibility.experiment = null;
    });
  }

  const largeIndex = process.argv.indexOf("--large");
  const measureOnly = process.argv.includes("--measure-only");
  const large =
    largeIndex >= 0 ? await readFile(process.argv[largeIndex + 1]) : null;
  const originalLarge = large && digest(large);
  for (const strategy of ["staged", "in-place"]) {
    const base = path.join(
      strategy === "staged" ? scratch : external,
      strategy,
    );
    await mkdir(base);
    const profile = path.join(base, "Profile"),
      directory = path.join(base, "Library");
    await mkdir(profile);
    const sources = [];
    for (const kind of large
      ? ["small", "other", "large"]
      : ["small", "other"]) {
      const entries = [
        ["TITLE", `Feasibility ${kind}`],
        ["ARTIST", "Disposable"],
        ["ALBUM", "Laboratory"],
      ];
      let bytes = playbackFlacFixture(entries, 30);
      if (kind === "large") {
        const input = inspectFlac(large);
        bytes = Buffer.concat([
          Buffer.from("fLaC"),
          ...input.blocks.map((b, i) =>
            block(
              b.type,
              b.type === 4 ? commentBlock(entries) : b.body,
              i === input.blocks.length - 1,
            ),
          ),
          input.audio,
        ]);
      }
      const source = path.join(base, kind + ".flac");
      await writeFile(source, bytes);
      assert((await stat(source)).size < 64 * 1024 * 1024);
      assert.equal((await parseFile(source)).format.container, "FLAC");
      sources.push({
        source,
        kind,
        proof: await proof(source),
        audio: digest(inspectFlac(bytes).audio),
      });
    }
    let page = await launch(profile);
    const tracks = await desktop.evaluate(
      async ({ dialog, Menu }, { repo, directory, sources }) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(repo + "/dist/domain/library.js");
        const { Library } = require(repo + "/dist/domain/library.js");
        const l = await Library.open(directory, { setupMediaRoot: true });
        let tracks;
        try {
          l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
          const added = await l.add(sources);
          if (added.errors.length) throw Error(JSON.stringify(added.errors));
          tracks = l.tracks();
          l.favorite(tracks[0].id);
          l.createPlaylist(
            "Protected",
            tracks.map((t) => t.id),
          );
          l.saveState({
            ...l.state(),
            view: "Songs",
            queue: tracks.map((t) => t.id),
          });
        } finally {
          l.close();
        }
        dialog.showOpenDialog = async () => ({
          canceled: false,
          filePaths: [directory],
        });
        Menu.getApplicationMenu()
          .items.find((i) => i.label === "File")
          .submenu.items.find((i) => i.label === "Choose Library…")
          .click();
        return tracks;
      },
      { repo, directory, sources: sources.map((s) => s.source) },
    );
    await page.waitForSelector(".song-row");
    const small = tracks.find((t) => t.title === "Feasibility small");
    const other = tracks.find((t) => t.title === "Feasibility other");
    for (const name of measureOnly
      ? ["first", "warm"]
      : [
          "first",
          "warm",
          "paused",
          "pause-during",
          "seek-during",
          "switch-during",
          "request-during-prepare",
          "request-during-publication",
          "stale-reacquire",
          "drain-reader",
          "fail-before",
        ])
      await runCase(
        page,
        small,
        directory,
        name,
        strategy,
        (await stat(small.path)).size,
        other,
      );
    if (large) {
      const target = tracks.find((t) => t.title === "Feasibility large");
      for (const name of ["large-first", "large-warm"])
        await runCase(
          page,
          target,
          directory,
          name,
          strategy,
          (await stat(target.path)).size,
        );
    }
    for (const source of sources) {
      assert.deepEqual(await proof(source.source), source.proof);
      const track = tracks.find(
        (t) => t.title === `Feasibility ${source.kind}`,
      );
      assert.equal(
        digest(inspectFlac(await readFile(track.path)).audio),
        source.audio,
      );
    }
    if (measureOnly) {
      await desktop.close();
      desktop = undefined;
      continue;
    }
    // Crash-equivalent durable boundary: production startup recovery, not the lab copy.
    await runCase(
      page,
      small,
      directory,
      "interrupt-after",
      strategy,
      (await stat(small.path)).size,
    );
    await desktop.close();
    desktop = undefined;
    page = await launch(profile);
    await page.waitForSelector(".song-row");
    const recovery = await desktop.evaluate(() => {
      const l = globalThis.playbackFeasibility.use.currentLibrary;
      return {
        pending: l.db
          .prepare(
            "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
          )
          .get().n,
        tracks: l.tracks(),
        playlists: l.playlists(),
        state: l.state(),
      };
    });
    assert.equal(recovery.pending, 0);
    assert(
      recovery.tracks
        .find((t) => t.id === small.id)
        .genre.startsWith("Lab interrupt-after"),
    );
    assert.equal(
      recovery.tracks.find((t) => t.id === small.id).path,
      small.path,
    );
    assert(recovery.tracks.find((t) => t.favorite));
    assert.deepEqual(
      recovery.playlists[0].trackIds,
      tracks.map((t) => t.id),
    );
    assert.deepEqual(
      recovery.state.queue,
      tracks.map((t) => t.id),
    );
    const ready = await page.evaluate(
      ({ id, directory }) =>
        window.playbackFeasibility.command(id, directory, 5, true),
      { id: small.id, directory },
    );
    assert.equal(ready.error, undefined);
    await waitAdvance(page);
    emit({
      strategy,
      startupRecovery: true,
      pending: recovery.pending,
      restoredPlayback: true,
    });
    // Real renderer destruction must cancel read-only preparation and drain use.
    const crashBefore = await proof(small.path);
    await startEdit(
      small,
      "Never publish after renderer loss",
      "renderer-crash",
    );
    await waitStatus("read-preparation");
    await desktop.evaluate(() =>
      globalThis.playbackFeasibility.owner.forcefullyCrashRenderer(),
    );
    await waitStatus("finished");
    assert((await state()).error.includes("cancelled"));
    await expect.poll(() => idle(small.id)).toBe(true);
    assert.deepEqual(await proof(small.path), crashBefore);
    emit({
      strategy,
      rendererCrashBeforePublication: true,
      originalUnchanged: true,
    });
    await desktop.close();
    desktop = undefined;
    page = await launch(profile);
    await page.waitForSelector(".song-row");
    await page.evaluate(
      ({ id, directory }) =>
        window.playbackFeasibility.command(id, directory, 5, true),
      { id: small.id, directory },
    );
    const quitBefore = await proof(small.path);
    await startEdit(small, "Never publish after quit", "app-quit");
    await waitStatus("read-preparation");
    await desktop.close();
    desktop = undefined;
    assert.deepEqual(await proof(small.path), quitBefore);
    page = await launch(profile);
    await page.waitForSelector(".song-row");
    assert.equal(
      await desktop.evaluate(
        () =>
          globalThis.playbackFeasibility.use.currentLibrary.db
            .prepare(
              "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
            )
            .get().n,
      ),
      0,
    );
    emit({
      strategy,
      quitDuringPreparation: true,
      originalUnchanged: true,
      startupJournalClean: true,
    });
    await desktop.close();
    desktop = undefined;
    for (const source of sources)
      assert.deepEqual(await proof(source.source), source.proof);
  }
  if (large)
    assert.equal(
      digest(await readFile(process.argv[largeIndex + 1])),
      originalLarge,
    );
  assert.equal(digest(await readFile(coordinator)), sourceHash);
  emit({
    passed: true,
    productionCoordinatorUnchanged: true,
    decoderSourceSha256: digest(decoderSource),
    cases: results.length,
    results,
  });
} finally {
  await desktop?.close();
  await rm(external, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
