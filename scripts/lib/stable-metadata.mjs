// Internal qualification only: real UI/IPC, packaged resources, disposable fixtures.
import assert from "node:assert/strict";
import { expect } from "playwright/test";
import { readFile, stat, open } from "node:fs/promises";
import { createHash } from "node:crypto";
import { inspectFlac } from "../../tests/metadata-fixtures.ts";
const sha = (b) => createHash("sha256").update(b).digest("hex");
export async function qualifyStableMetadata(ctx) {
  // A measured 250 MiB staged save took 36.7 s. Only physical-save completion
  // waits differ for large fixtures; editor/transport/readiness checks do not.
  const large = process.argv.includes("--large-fixture");
  const saveTimeout = large ? 90000 : 30000;
  const app = () => ctx.getApp(),
    page = () => ctx.getPage();
  const main = (fn, extra = {}) =>
    app().evaluate(fn, { modules: ctx.modules, id: ctx.ids.A, ...extra });
  const row = (id) => page().locator(`.song-row[data-track-id="${id}"]`);
  const input = () => page().locator(".inline-metadata-input");
  const snapshot = () => page().evaluate(() => window.rio.snapshot());
  const emit = (r) => ctx.emit({ event: "metadata-concurrency", ...r });
  const audio = () =>
    page().evaluate(() => {
      const a = document.querySelector("audio");
      return {
        url: a.currentSrc,
        position: a.currentTime,
        paused: a.paused,
        ready: a.readyState,
        error: a.error?.code || null,
      };
    });
  const initialSnapshot = await snapshot();
  const track = initialSnapshot.tracks.find((t) => t.id === ctx.ids.A);
  const references = initialSnapshot.playlists.map((p) => ({
    id: p.id,
    trackIds: p.trackIds,
  }));
  const beforeAudio = sha(inspectFlac(await readFile(track.path)).audio);
  const heads = new Map();
  async function rememberHead(url) {
    const h = await open(track.path, "r");
    try {
      const b = Buffer.alloc(4096);
      const { bytesRead } = await h.read(b, 0, b.length, 0);
      heads.set(url, sha(b.subarray(0, bytesRead)));
    } finally {
      await h.close();
    }
  }
  let rendererTimings = [],
    rendererCount = 0;
  async function install() {
    rendererTimings = [];
    page().on("console", (m) => {
      const text = m.text();
      if (text.startsWith("RIO_METADATA_RENDERER ")) {
        try {
          rendererTimings.push(
            JSON.parse(text.slice("RIO_METADATA_RENDERER ".length)),
          );
        } catch {}
      }
    });
    await main(({ ipcMain, Menu }, { modules }) => {
      const req = process
        .getBuiltinModule("module")
        .createRequire(modules.playback);
      const use = req(modules.playback).playbackUse;
      globalThis.stableMetaSamples = [];
      globalThis.stableMetaAutoRelease = false;
      const edit = ipcMain._invokeHandlers.get("metadata:edit");
      ipcMain.removeHandler("metadata:edit");
      ipcMain.handle("metadata:edit", async (...args) => {
        const start = performance.now();
        globalThis.stableMetaStart = performance.timeOrigin + start;
        let last = start,
          maxGapMs = 0;
        const timer = setInterval(() => {
          const now = performance.now();
          maxGapMs = Math.max(maxGapMs, now - last);
          last = now;
        }, 5);
        try {
          const result = await edit(...args);
          maxGapMs = Math.max(maxGapMs, performance.now() - last);
          let diagnostic;
          if (!result.ok) {
            const fs = process.getBuiltinModule("fs"),
              p = process.getBuiltinModule("path");
            const { app } = process
              .getBuiltinModule("module")
              .createRequire(modules.playback)("electron");
            try {
              diagnostic = JSON.parse(
                fs
                  .readFileSync(
                    p.join(app.getPath("userData"), "metadata-edit-errors.log"),
                    "utf8",
                  )
                  .trim()
                  .split("\n")
                  .at(-1),
              ).error;
            } catch {}
          }
          globalThis.stableMetaSamples.push({
            wallMs: performance.now() - start,
            peakMainAndWorkerRssBytes: process.resourceUsage().maxRSS * 1024,
            maxGapMs,
            ok: result.ok,
            diagnostic,
          });
          return result;
        } finally {
          clearInterval(timer);
        }
      });
      const info = console.info;
      globalThis.stableMetaTimings = [];
      console.info = (...args) => {
        if (args[0] === "RIO_METADATA_MAIN")
          globalThis.stableMetaTimings.push({
            ...JSON.parse(args[1]),
            startedAt: globalThis.stableMetaStart,
          });
        info(...args);
      };
      const workers = process.getBuiltinModule("worker_threads"),
        once = workers.Worker.prototype.once;
      const held = new WeakMap();
      workers.Worker.prototype.once = function (name, listener) {
        const state = held.get(this);
        if (name === "exit" && state)
          return once.call(this, name, (...args) => {
            if (state.released) listener.apply(this, args);
            else state.exit = () => listener.apply(this, args);
          });
        if (name !== "message") return once.call(this, name, listener);
        if (globalThis.stableMetaFailRecovery)
          return once.call(this, name, () =>
            listener.call(this, {
              ok: false,
              error: "Disposable recovery verification failure",
            }),
          );
        if (!globalThis.stableMetaHold || --globalThis.stableMetaHold !== 0)
          return once.call(this, name, listener);
        const next = { released: false };
        held.set(this, next);
        return once.call(this, name, (...args) => {
          globalThis.stableMetaRelease = (fail = false, recovery = false) => {
            next.released = true;
            globalThis.stableMetaFailRecovery = recovery;
            listener.apply(
              this,
              fail
                ? [
                    {
                      ok: false,
                      error: "Disposable metadata verification failure",
                    },
                  ]
                : args,
            );
            next.exit?.();
            delete globalThis.stableMetaRelease;
          };
          if (globalThis.stableMetaAutoRelease) globalThis.stableMetaRelease();
        });
      };
      Menu.prototype.popup = function () {
        globalThis.stableMetaMenu = this;
      };
      if (!use.currentLibrary) throw Error("Missing active library");
    });
    await page().evaluate(() => {
      const a = document.querySelector("audio");
      const m = (window.stableMetaObserve = {
        keyAt: 0,
        exitMs: null,
        events: [],
        samples: [],
      });
      document.addEventListener(
        "keydown",
        (e) => {
          if (
            e.target.matches(".inline-metadata-input") &&
            ["Enter", "Tab"].includes(e.key)
          ) {
            m.keyAt = performance.now();
            m.keyInput = e.target;
            m.exitMs = null;
          }
        },
        true,
      );
      new MutationObserver(() => {
        if (m.keyAt && !m.keyInput?.isConnected && m.exitMs === null)
          m.exitMs = performance.now() - m.keyAt;
      }).observe(document.body, { childList: true, subtree: true });
      for (const event of [
        "emptied",
        "waiting",
        "stalled",
        "error",
        "loadeddata",
        "playing",
        "pause",
        "seeked",
      ])
        a.addEventListener(event, () =>
          m.events.push({
            event,
            t: performance.timeOrigin + performance.now(),
            position: a.currentTime,
          }),
        );
      window.stableMetaTimer = setInterval(
        () =>
          m.samples.push({
            t: performance.timeOrigin + performance.now(),
            position: a.currentTime,
            paused: a.paused,
            ready: a.readyState,
            error: a.error?.code || 0,
          }),
        25,
      );
    });
  }
  const arm = (n) =>
    main(
      (_, { n }) => {
        globalThis.stableMetaHold = n;
        delete globalThis.stableMetaRelease;
      },
      { n },
    );
  const held = async () =>
    expect
      .poll(() => app().evaluate(() => !!globalThis.stableMetaRelease), {
        timeout: 20000,
      })
      .toBe(true);
  const release = (fail = false, recovery = false) =>
    main(
      (_, { fail, recovery }) => globalThis.stableMetaRelease(fail, recovery),
      { fail, recovery },
    );
  const phase = () =>
    main((_, { modules, id }) => {
      const use = process
        .getBuiltinModule("module")
        .createRequire(modules.playback)(modules.playback).playbackUse;
      const l = use.currentLibrary;
      return {
        pending: l.db
          .prepare(
            "SELECT count(*) n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
          )
          .get().n,
        phase: l.db
          .prepare(
            "SELECT phase FROM metadata_edits WHERE trackId=? ORDER BY rowid DESC LIMIT 1",
          )
          .get(id)?.phase,
        revision: l.db
          .prepare("SELECT digest FROM managed_file_receipts WHERE trackId=?")
          .get(id).digest,
        isolated: [...use.sources.values()]
          .filter((s) => s.id === id && s.isolated)
          .map((s) => ({
            digest: s.isolated.revision.digest,
            originalUse: s.originalUse,
            acquisitionMs: s.isolated.metrics.acquisitionMs,
          })),
      };
    });
  const waitSave = () =>
    expect
      .poll(() => main(() => globalThis.stableMetaSamples.length), {
        timeout: saveTimeout,
      })
      .toBeGreaterThan(saveCount);
  let saveCount = 0;
  const startSave = async () => {
    rendererCount = rendererTimings.length;
    saveCount = await main(() => globalThis.stableMetaSamples.length);
    await page().evaluate(() => {
      const m = window.stableMetaObserve;
      m.events = [];
      m.samples = [];
      m.keyAt = 0;
      m.exitMs = null;
    });
  };
  const quiet = async () => {
    await expect(page().locator(".inline-metadata-marker")).toHaveCount(0);
    const s = page().locator("#inline-metadata-status [role='status']");
    if (await s.count())
      assert.equal(
        await page()
          .locator("#inline-metadata-status")
          .evaluate((e) => e.getBoundingClientRect().height),
        0,
      );
  };
  async function begin(column, value) {
    await row(ctx.ids.A).locator(`[data-cell-column="${column}"]`).dblclick();
    await expect(input()).toBeVisible();
    await expect(input()).not.toHaveAttribute("readonly", "");
    await input().fill(value);
  }
  async function remains(url, advancing = true) {
    const before = await audio();
    assert.equal(before.url, url);
    if (advancing) {
      await expect
        .poll(async () => (await audio()).position, { timeout: 3000 })
        .toBeGreaterThan(before.position + 0.2);
      assert.equal((await audio()).paused, false);
    }
    assert.equal((await audio()).url, url);
    assert.equal((await audio()).error, null);
  }
  async function range(url) {
    const result = await app().evaluate(async ({ net }, url) => {
      const r = await net.fetch(url, { headers: { Range: "bytes=0-4095" } });
      return {
        status: r.status,
        bytes: [...new Uint8Array(await r.arrayBuffer())],
      };
    }, url);
    assert.equal(result.status, 206);
    assert.equal(Buffer.from(result.bytes).subarray(0, 4).toString(), "fLaC");
    assert.equal(
      sha(Buffer.from(result.bytes)),
      heads.get(url),
      "Protocol must serve the captured clone revision, including old tags",
    );
    const denied = await app().evaluate(
      async ({ net }, url) =>
        (await net.fetch(url.replace(/use=[^&]+/, "use=unauthorized"))).status,
      url,
    );
    assert([403, 404].includes(denied));
  }
  async function finish(label, { controlled = false } = {}) {
    await waitSave();
    const sample = await main(() => globalThis.stableMetaSamples.at(-1));
    assert.equal(
      sample.ok,
      true,
      sample.diagnostic || "Expected production UI save success",
    );
    await expect.poll(async () => (await phase()).pending).toBe(0);
    await expect
      .poll(() =>
        rendererTimings.slice(rendererCount).some((x) => x.ok === true),
      )
      .toBe(true);
    const renderer = rendererTimings
      .slice(rendererCount)
      .filter((x) => x.ok === true)
      .at(-1);
    const timings = await main(() =>
      globalThis.stableMetaTimings.filter((x) => x.operation === "edit").at(-1),
    );
    const observation = await page().evaluate(() => ({
      exitMs: window.stableMetaObserve.exitMs,
      events: window.stableMetaObserve.events,
      samples: window.stableMetaObserve.samples,
    }));
    if (ctx.naturalOnly) {
      assert(
        !observation.events.some((e) =>
          ["waiting", "stalled", "emptied", "error"].includes(e.event),
        ),
        "Natural size-boundary save interrupted the decoder",
      );
    }
    const nativeStart = timings?.stages.revalidate;
    const nativeEnd = timings?.stages.publish;
    const windowStart = timings?.startedAt + nativeStart,
      windowEnd = timings?.startedAt + nativeEnd;
    const beforePublication = observation.samples
      .filter((s) => s.t <= windowStart)
      .at(-1);
    const afterPublication = observation.samples.find((s) => s.t >= windowEnd);
    const transportTransition =
      beforePublication &&
      afterPublication &&
      observation.events.some(
        (e) =>
          e.t >= beforePublication.t &&
          e.t <= afterPublication.t &&
          ["seeked", "seeking", "pause", "emptied", "loadeddata"].includes(
            e.event,
          ),
      );
    const publicationBracket =
      beforePublication && afterPublication
        ? {
            elapsedMs: afterPublication.t - beforePublication.t,
            positionAdvance: transportTransition
              ? null
              : afterPublication.position - beforePublication.position,
            transportTransition: !!transportTransition,
            pausedBefore: beforePublication.paused,
            pausedAfter: afterPublication.paused,
            readinessBefore: beforePublication.ready,
            readinessAfter: afterPublication.ready,
          }
        : null;
    if (
      ["Enter-active", "Tab-natural", "TrackInfo-paused-natural"].includes(
        label,
      )
    ) {
      assert(
        !observation.events.some(
          (e) => e.event === "emptied" || e.event === "error",
        ),
      );
    }
    emit({
      label,
      controlled,
      publicationBracket,
      ...sample,
      editorExitMs: observation.exitMs,
      rendererSaveMs: renderer.wallMs,
      ipcMs: renderer.ipcMs,
      replyToFrameMs: renderer.replyToFrameMs,
      publication: timings?.details.publication?.[0]?.strategy,
      publicationWindowMs:
        nativeStart === undefined || nativeEnd === undefined
          ? null
          : nativeEnd - nativeStart,
      timingStages: timings?.stages,
      transportSamples: observation.samples.length,
      decoderEvents: observation.events.map((x) => x.event),
      note: "HTMLMediaElement decoder/transport evidence; no PCM or acoustic claim",
    });
    assert.equal(
      sample.ok,
      true,
      sample.diagnostic || "Expected production UI save success",
    );
    await quiet();
  }
  async function select(id) {
    await row(id)
      .getByRole("button", { name: /^Play / })
      .click();
    await expect
      .poll(
        async () => {
          const a = await audio();
          return (
            !!a.url &&
            new URL(a.url).pathname.slice(1) === id &&
            !a.paused &&
            a.ready >= 3
          );
        },
        { timeout: 30000 },
      )
      .toBe(true);
  }
  await install();
  const originalUrl = (await audio()).url;
  await rememberHead(originalUrl);
  const initial = await phase();
  assert.equal(initial.isolated.length, 1);
  assert.equal(initial.isolated[0].originalUse, false);
  await main(() => {
    globalThis.stableMetaFailRecovery = false;
  });
  if (ctx.naturalOnly) {
    await begin("genre", "Large natural probe");
    await startSave();
    await input().press("Tab");
    await expect(input()).toBeFocused();
    await input().press("Escape");
    await finish("Tab-natural");
    await remains(originalUrl);
    await range(originalUrl);
    assert.equal(
      sha(inspectFlac(await readFile(track.path)).audio),
      beforeAudio,
    );
    assert.equal(
      (await snapshot()).tracks.find((t) => t.id === ctx.ids.A).genre,
      "Large natural probe",
    );
    return;
  }
  // Enter while real preparation is held: editor exits, audio and commands continue.
  await begin("genre", "Stable Enter");
  await arm(1);
  await startSave();
  await input().press("Enter");
  await expect(input()).toHaveCount(0);
  await held();
  assert.equal((await phase()).phase, "preparing");
  await quiet();
  await remains(originalUrl);
  await range(originalUrl);
  const pauseAt = performance.now();
  await page().getByRole("button", { name: "Pause", exact: true }).click();
  await expect.poll(async () => (await audio()).paused).toBe(true);
  const pauseMs = performance.now() - pauseAt;
  const resumeAt = performance.now();
  await page().getByRole("button", { name: "Play", exact: true }).click();
  await expect.poll(async () => (await audio()).paused).toBe(false);
  const resumeMs = performance.now() - resumeAt;
  const seekAt = performance.now();
  await page().getByRole("slider", { name: "Seek", exact: true }).fill("8");
  await expect.poll(async () => (await audio()).position).toBeGreaterThan(7.9);
  const seekMs = performance.now() - seekAt;
  await release();
  await finish("Enter-active", { controlled: true });
  assert.equal((await audio()).url, originalUrl);
  assert.notEqual((await phase()).revision, initial.revision);
  assert.equal((await phase()).isolated[0].digest, initial.revision);
  emit({ label: "commands-during-preparation", pauseMs, resumeMs, seekMs });
  // Natural Tab save: no artificial hold in measured save duration.
  await begin("genre", "Stable Tab");
  await startSave();
  await input().press("Tab");
  await expect(input()).toBeFocused();
  await input().press("Escape");
  await finish("Tab-natural");
  assert.equal((await audio()).url, originalUrl);
  const noOpTime = (await stat(track.path)).mtimeMs;
  await begin("genre", "Stable Tab");
  await startSave();
  await input().press("Enter");
  await expect(input()).toHaveCount(0);
  assert.equal(
    await main(() => globalThis.stableMetaSamples.length),
    saveCount,
  );
  assert.equal((await stat(track.path)).mtimeMs, noOpTime);
  await begin("genre", "Cancelled proposal");
  await input().press("Escape");
  assert.equal(
    await main(() => globalThis.stableMetaSamples.length),
    saveCount,
  );
  assert.equal(
    (await snapshot()).tracks.find((t) => t.id === ctx.ids.A).genre,
    "Stable Tab",
  );
  emit({ label: "cancel-and-noop", noRewrite: true });
  const strategy = await main(
    () =>
      globalThis.stableMetaTimings.filter((x) => x.operation === "edit").at(-1)
        .details.publication[0].strategy,
  );
  // Paused Track Info uses the same production coordinator and old clone.
  await page().getByRole("button", { name: "Pause", exact: true }).click();
  await row(ctx.ids.A).click({ button: "right" });
  await app().evaluate(() =>
    globalThis.stableMetaMenu.getMenuItemById("track-info").click(),
  );
  const dialog = () => page().getByRole("dialog", { name: "Track Info" });
  await expect(dialog().getByLabel("Genre", { exact: true })).toBeVisible();
  await dialog()
    .getByLabel("Genre", { exact: true })
    .fill("Stable paused Info");
  await startSave();
  await dialog().getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog()).toHaveCount(0, {
    timeout: large ? saveTimeout : 5000,
  });
  await finish("TrackInfo-paused-natural");
  assert.equal((await audio()).paused, true);
  assert.equal((await audio()).url, originalUrl);
  await page().getByRole("button", { name: "Play", exact: true }).click();
  await remains(originalUrl);
  // Hold published verification, then switch to an unrelated track. Save must not restore A.
  await begin("genre", "Stable switch");
  await arm(strategy === "in-place" ? 2 : 3);
  await startSave();
  await input().press("Enter");
  await held();
  assert.equal((await phase()).phase, "published");
  await remains(originalUrl);
  await range(originalUrl);
  await select(ctx.ids.Reference);
  const switched = (await audio()).url;
  await release();
  await finish("switch-after-publication", { controlled: true });
  await remains(switched);
  assert.equal(
    new URL((await audio()).url).pathname.slice(1),
    ctx.ids.Reference,
  );
  const reacquireAt = performance.now();
  await select(ctx.ids.A);
  emit({
    label: "subsequent-acquisition",
    ms: performance.now() - reacquireAt,
    verifiedPreparationMs: (await phase()).isolated[0].acquisitionMs,
  });
  assert.equal((await phase()).isolated[0].digest, (await phase()).revision);
  const newUrl = (await audio()).url;
  await rememberHead(newUrl);
  // Genuine production error response preserves the proposed inline value.
  await begin("genre", "Stable retry proposal");
  await arm(1);
  await startSave();
  await input().press("Enter");
  await held();
  await release(true);
  await waitSave();
  await expect(
    page().getByRole("button", { name: "Review edit", exact: true }),
  ).toBeVisible();
  await remains(newUrl);
  await page()
    .getByRole("button", { name: "Review edit", exact: true })
    .click();
  await expect(input()).toHaveValue("Stable retry proposal");
  await startSave();
  await input().press("Enter");
  await finish("failed-draft-retry");
  // A post-publication verification failure and failed reconciliation need real startup recovery.
  await begin("genre", "Stable recovery");
  await arm(strategy === "in-place" ? 2 : 3);
  await startSave();
  await input().press("Enter");
  await held();
  await release(true, strategy === "staged");
  await waitSave();
  assert.equal(
    (await phase()).phase,
    strategy === "staged" ? "recovery-required" : "done",
  );
  await expect(
    page().getByRole("button", { name: "Review edit", exact: true }),
  ).toBeVisible();
  if (strategy === "staged")
    await expect(
      page()
        .getByRole("alert")
        .filter({ hasText: /recovery/i }),
    ).toBeVisible();
  await remains(newUrl);
  await range(newUrl);
  emit({
    label:
      strategy === "staged"
        ? "recovery-required-retains-clone"
        : "in-place-verified-forward-recovery",
    strategy,
    safe: true,
  });
  await ctx.restart();
  await install();
  assert.equal((await phase()).pending, 0);
  assert.equal(
    (await snapshot()).tracks.find((t) => t.id === ctx.ids.A).genre,
    "Stable recovery",
  );
  assert.equal((await phase()).isolated[0].digest, (await phase()).revision);
  emit({ label: "startup-forward-recovery", safe: true });
  // Quit with preparation outstanding: shutdown revokes source use and safely aborts the edit.
  await begin("genre", "Quit must not publish");
  await arm(1);
  await startSave();
  await input().press("Enter");
  await held();
  const quitting = new Promise((resolve) =>
    app().process().once("exit", resolve),
  );
  await app().evaluate(({ app }) => {
    setImmediate(() => app.quit());
  });
  await expect
    .poll(() =>
      main(
        (_, { modules }) =>
          process.getBuiltinModule("module").createRequire(modules.playback)(
            modules.playback,
          ).playbackUse.closing,
      ),
    )
    .toBe(true);
  await release();
  await quitting;
  await ctx.restart(true);
  assert.equal((await phase()).pending, 0);
  assert.equal(
    (await snapshot()).tracks.find((t) => t.id === ctx.ids.A).genre,
    "Stable recovery",
  );
  assert.equal(sha(inspectFlac(await readFile(track.path)).audio), beforeAudio);
  assert.equal(
    (await snapshot()).tracks.find((t) => t.id === ctx.ids.A).path,
    track.path,
  );
  assert.equal(
    (await snapshot()).tracks.find((t) => t.id === ctx.ids.A).favorite,
    track.favorite,
  );
  assert.deepEqual(
    (await snapshot()).playlists.map((p) => ({
      id: p.id,
      trackIds: p.trackIds,
    })),
    references,
  );
  emit({
    label: "quit-during-save",
    abortedSafely: true,
    trackIdPathAndAudioPreserved: true,
  });
}

/** Hold real preparation, then let the caller detach only its disposable image. */
export async function prepareUnavailableMetadata({
  getApp,
  getPage,
  modules,
  id,
  emit,
}) {
  const page = getPage(),
    app = getApp();
  const current = () =>
    app.evaluate(
      (_, { modules, id }) => {
        const l = process
          .getBuiltinModule("module")
          .createRequire(modules.playback)(modules.playback).playbackUse
          .currentLibrary;
        return {
          receipt: l.db
            .prepare(
              "SELECT digest,device,inode FROM managed_file_receipts WHERE trackId=?",
            )
            .get(id),
          journals: l.db.prepare("SELECT count(*) n FROM metadata_edits").get()
            .n,
          latest: l.db
            .prepare(
              "SELECT phase,journal FROM metadata_edits ORDER BY rowid DESC LIMIT 1",
            )
            .get(),
        };
      },
      { modules, id },
    );
  const before = await current();
  await page
    .locator(`.song-row[data-track-id="${id}"] [data-cell-column="genre"]`)
    .dblclick();
  const input = page.locator(".inline-metadata-input");
  await expect(input).not.toHaveAttribute("readonly", "");
  await input.fill("Unavailable volume proposal");
  await app.evaluate(() => {
    globalThis.stableMetaAutoRelease = false;
    const { Worker } = process.getBuiltinModule("worker_threads"),
      once = Worker.prototype.once;
    let armed = true;
    const states = new WeakMap();
    Worker.prototype.once = function (name, listener) {
      const state = states.get(this);
      if (name === "exit" && state)
        return once.call(this, name, (...args) => {
          if (state.released) listener.apply(this, args);
          else state.exit = () => listener.apply(this, args);
        });
      if (name !== "message" || !armed) return once.call(this, name, listener);
      armed = false;
      const next = { released: false };
      states.set(this, next);
      return once.call(this, name, (...args) => {
        globalThis.stableMetaRelease = () => {
          next.released = true;
          listener.apply(this, args);
          next.exit?.();
          delete globalThis.stableMetaRelease;
        };
        if (globalThis.stableMetaAutoRelease) globalThis.stableMetaRelease();
      });
    };
  });
  await input.press("Enter");
  await expect(input).toHaveCount(0);
  await expect
    .poll(() => app.evaluate(() => !!globalThis.stableMetaRelease), {
      timeout: 20000,
    })
    .toBe(true);
  assert.equal((await current()).latest.phase, "preparing");
  return async () => {
    await app.evaluate(() => globalThis.stableMetaRelease());
    await expect(
      page.getByRole("button", { name: "Review edit", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Discard edit", exact: true }),
    ).toBeVisible();
    const after = await current();
    assert.deepEqual(after.receipt, before.receipt);
    assert.equal(after.journals, before.journals + 1);
    assert(["aborted", "recovery-required"].includes(after.latest.phase));
    assert.notEqual(JSON.parse(after.latest.journal).writeStarted, true);
    emit({
      event: "metadata-concurrency",
      label: "unavailable-volume-during-preparation",
      beforePublication: true,
      draftRetained: true,
    });
  };
}
