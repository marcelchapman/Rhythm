// Phase 2E.3 research ONLY. No production module is patched or overwritten.
// Separate capabilities for a disposable clone and its managed original model
// the architectural change under study; they are not a production authorization API.
import { buildCloneHelper } from "./stable-source-clone.mjs";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { _electron as electron } from "playwright";
import { expect } from "playwright/test";
import {
  inspectFlac,
  block,
  commentBlock,
} from "../../tests/metadata-fixtures.ts";

assert.equal(process.platform, "darwin");
const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const smallOnly = process.argv.includes("--small-only");
const largeIndex = process.argv.indexOf("--large");
const large = largeIndex < 0 ? undefined : process.argv[largeIndex + 1];
if (!smallOnly && (!large || large.startsWith("--")))
  throw Error("Pass --large <disposable FLAC> or --small-only.");
const hash = (b) => createHash("sha256").update(b).digest("hex");
const originalLarge = !smallOnly ? hash(await readFile(large)) : undefined;
const parentIndex = process.argv.indexOf("--external-parent");
const externalParent =
  parentIndex < 0 ? repo : await realpath(process.argv[parentIndex + 1]);
assert.equal((await stat(repo)).dev, (await stat(externalParent)).dev);
const scratch = await mkdtemp("/private/tmp/rio-2e3-");
const external = await mkdtemp(path.join(externalParent, ".rio-2e3-"));
const rows = [];
const emit = (r) => {
  rows.push(r);
  console.log("RIO_STABLE_SOURCE", JSON.stringify(r));
};
let desktop;
try {
  const native = await buildCloneHelper(scratch);
  // Tone gives an inexpensive small fixture with detectable non-silent PCM.
  const small = path.join(scratch, "small.flac"),
    other = path.join(scratch, "other.flac");
  for (const [filename, freq] of [
    [small, 997],
    [other, 1499],
  ])
    execFileSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${freq}:sample_rate=48000:duration=60`,
      "-ac",
      "2",
      "-c:a",
      "flac",
      filename,
    ]);
  const fixtureLarge = path.join(scratch, "large.flac");
  const fixtures = [
    [small, small],
    [other, other],
  ];
  if (!smallOnly) fixtures.push([large, fixtureLarge]);
  for (const [input, output] of fixtures) {
    const parsed = inspectFlac(await readFile(input));
    const blocks = [
      ...parsed.blocks.filter((b) => b.type !== 4),
      {
        type: 4,
        body: commentBlock([
          ["TITLE", "Disposable"],
          ["GENRE", "Original"],
        ]),
      },
    ];
    await writeFile(
      output,
      Buffer.concat([
        Buffer.from("fLaC"),
        ...blocks.map((b, i) => block(b.type, b.body, i === blocks.length - 1)),
        parsed.audio,
      ]),
    );
    execFileSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-xerror",
      "-i",
      output,
      "-f",
      "null",
      "-",
    ]);
  }
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
  await writeFile(
    path.join(scratch, "preload.cjs"),
    `const {contextBridge,ipcRenderer}=require('electron');contextBridge.exposeInMainWorld('stableLab',{acquire:id=>ipcRenderer.invoke('lab:acquire',id),release:token=>ipcRenderer.invoke('lab:release',token),probe:(token,id)=>ipcRenderer.invoke('lab:probe',token,id)});`,
  );
  await writeFile(
    path.join(scratch, "index.html"),
    "<!doctype html><html><body><h1>Disposable stable-source lab</h1></body></html>",
  );
  await writeFile(
    path.join(scratch, "meter.js"),
    `class Meter extends AudioWorkletProcessor {constructor(){super();this.n=0;this.rows=[];this.port.onmessage=e=>{this.port.postMessage({flush:e.data,rows:this.rows.splice(0),throughFrame:currentFrame});};}process(inputs,outputs){const a=inputs[0]?.[0];let energy=0;if(a)for(let i=0;i<a.length;i++)energy+=a[i]*a[i];this.rows.push([currentFrame,a?.length||128,energy]);if(++this.n%64===0){this.port.postMessage(this.rows);this.rows=[];}return true;}}registerProcessor('meter',Meter);`,
  );
  await writeFile(
    path.join(scratch, "main.cjs"),
    `const {app,BrowserWindow,protocol}=require('electron');app.setPath('userData',${JSON.stringify(path.join(scratch, "profile"))});protocol.registerSchemesAsPrivileged([{scheme:'rio',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true}},{scheme:'rio-media',privileges:{standard:true,secure:true,supportFetchAPI:true,stream:true,corsEnabled:true}}]);app.whenReady().then(()=>{protocol.handle('rio',r=>new Response(require('fs').readFileSync(require('path').join(${JSON.stringify(scratch)},new URL(r.url).pathname==='/'?'index.html':new URL(r.url).pathname.slice(1))),{headers:{'Content-Type':r.url.endsWith('.js')?'text/javascript':'text/html'}}));const w=new BrowserWindow({show:true,webPreferences:{preload:${JSON.stringify(path.join(scratch, "preload.cjs"))},contextIsolation:true,nodeIntegration:false}});w.loadURL('rio://app/index.html');});`,
  );
  desktop = await electron.launch({
    args: [
      path.join(scratch, "main.cjs"),
      "--autoplay-policy=no-user-gesture-required",
    ],
    env: { ...process.env, RIO_METADATA_TIMING: "1" },
    timeout: 30000,
  });
  const page = await desktop.firstWindow();
  await page.waitForSelector("h1");
  page.on("console", (m) => console.log("RENDERER", m.text()));
  desktop.process().stderr.on("data", (b) => process.stderr.write(b));
  await desktop.evaluate(installMain, { repo, scratch, native });
  await page.reload();
  await page.evaluate(decoder + "\nwindow.LabSource=MediaSource;");
  await page.evaluate(async (meter) => {
    const audio = document.createElement("audio");
    audio.crossOrigin = "anonymous";
    document.body.append(audio);
    const context = new AudioContext({ sampleRate: 48000 });
    await context.audioWorklet.addModule(meter);
    const worklet = new AudioWorkletNode(context, "meter"),
      gain = context.createGain();
    gain.gain.value = 0; // Decode real PCM, without playing sound to the user's speakers.
    context.createMediaElementSource(audio).connect(worklet);
    worklet.connect(gain).connect(context.destination);
    const l = (window.lab = {
      audio,
      context,
      pcm: [],
      events: [],
      leases: [],
      released: [],
      worklet,
      roundTrips: [],
      rendererTicks: [],
    });
    let previous = performance.now(),
      probing = false;
    setInterval(() => {
      const now = performance.now();
      l.rendererTicks.push(now - previous);
      previous = now;
      if (!audio.paused && !probing && l.leases.length) {
        probing = true;
        const t = performance.now();
        window.stableLab
          .probe(l.leases.at(-1).token, l.playingId)
          .then((status) =>
            l.roundTrips.push({ ms: performance.now() - t, status }),
          )
          .finally(() => (probing = false));
      }
    }, 50);
    l.flushers = new Map();
    l.flushSerial = 0;
    worklet.port.onmessage = (e) => {
      if (Array.isArray(e.data)) l.pcm.push(...e.data);
      else {
        l.pcm.push(...e.data.rows);
        l.flushers.get(e.data.flush)?.(e.data.throughFrame);
        l.flushers.delete(e.data.flush);
      }
    };
    l.flush = () =>
      new Promise((resolve) => {
        const id = ++l.flushSerial;
        l.flushers.set(id, resolve);
        worklet.port.postMessage(id);
      });
    for (const name of [
      "waiting",
      "stalled",
      "error",
      "seeking",
      "seeked",
      "pause",
      "playing",
      "ended",
      "loadedmetadata",
    ])
      audio.addEventListener(name, () =>
        l.events.push({
          name,
          wall: performance.now(),
          position: audio.currentTime,
        }),
      );
    l.source = new window.LabSource(audio, async (id) => {
      const grant = await window.stableLab.acquire(id);
      l.leases.push(grant);
      return {
        url: grant.url,
        release: () => {
          const p = window.stableLab.release(grant.token);
          l.released.push(p);
          return p;
        },
      };
    });
    l.play = async (id, position = 2) => {
      l.playingId = id;
      await context.resume();
      const t = performance.now();
      await l.source.ensure(id, id, position, true);
      await audio.play();
      return performance.now() - t;
    };
    l.clear = async () => {
      l.source.clear();
      await Promise.resolve();
      await Promise.all(l.released);
    };
    l.mark = () => ({
      frame: context.currentTime * context.sampleRate,
      position: audio.currentTime,
      wall: performance.now(),
      events: l.events.length,
      roundTrips: l.roundTrips.length,
      ticks: l.rendererTicks.length,
    });
    l.report = async (m) => {
      const throughFrame = await l.flush();
      const end = l.mark();
      const samples = l.pcm.filter(
        (r) => r[0] >= m.frame && r[0] + r[1] <= throughFrame,
      );
      let zeroFrames = 0,
        maxZeroFrames = 0,
        run = 0;
      for (const r of samples) {
        if (r[2] < 1e-12) {
          zeroFrames += r[1];
          run += r[1];
          maxZeroFrames = Math.max(maxZeroFrames, run);
        } else run = 0;
      }
      let missingFrames = 0;
      for (let i = 1; i < samples.length; i++)
        missingFrames += samples[i][0] - samples[i - 1][0] - samples[i - 1][1];
      const requests = l.roundTrips.slice(m.roundTrips),
        ticks = l.rendererTicks.slice(m.ticks);
      return {
        rangeProbeCount: requests.length,
        maxRangeRoundTripMs: Math.max(0, ...requests.map((r) => r.ms)),
        rangeStatuses: [...new Set(requests.map((r) => r.status))],
        maxRendererTickGapMs: Math.max(0, ...ticks),
        missingFrames,
        pcmWindowMs:
          (samples.reduce((n, r) => n + r[1], 0) / context.sampleRate) * 1000,
        unobservedTailMs:
          ((end.frame - throughFrame) / context.sampleRate) * 1000,
        wallMs: end.wall - m.wall,
        advancedSeconds: end.position - m.position,
        renderedFrames: samples.reduce((n, r) => n + r[1], 0),
        zeroFrames,
        maxZeroMs: (maxZeroFrames / context.sampleRate) * 1000,
        sampleRate: context.sampleRate,
        events: l.events.slice(m.events),
        end,
      };
    };
  }, "rio://app/meter.js");
  let serial = 0;
  for (const strategy of ["staged", "in-place"])
    for (const [size, source] of smallOnly
      ? [["small", small]]
      : [
          ["small", small],
          ["large", fixtureLarge],
        ]) {
      const directory = path.join(
        strategy === "staged" ? scratch : external,
        "library-" + ++serial,
      );
      const setup = await desktop.evaluate(
        async (_, args) => globalThis.stableStudy.setup(args),
        { directory, source, other },
      );
      assert.equal(setup.noowners, strategy === "in-place");
      emit({ event: "source-established", strategy, size, ...setup });
      const probe = await desktop.evaluate(async () => {
        const l = globalThis.stableStudy,
          g = l.use.acquire(l.owner, l.track.id, l.library.directory);
        const r = await l.use.respond(g.token, l.track.id, new Request(g.url));
        const b = await r.arrayBuffer();
        await l.use.release(l.owner, g.token);
        return {
          status: r.status,
          bytes: b.byteLength,
          head: Array.from(new Uint8Array(b).slice(0, 4)),
        };
      });
      emit({ event: "probe", ...probe });
      const playMs = await page.evaluate((id) => window.lab.play(id), setup.id);
      await expect
        .poll(() => page.evaluate(() => window.lab.audio.currentTime))
        .toBeGreaterThan(2.4);
      emit({ event: "playback-start", strategy, size, playMs });
      for (const repeat of [0, 1, 2]) {
        const mark = await page.evaluate(() => window.lab.mark());
        await desktop.evaluate(
          (_, { repeat }) => {
            globalThis.stableStudy.startSave({ repeat });
          },
          { repeat },
        );
        await expect
          .poll(() => desktop.evaluate(() => globalThis.stableStudy.done), {
            timeout: 60000,
          })
          .toBe(true);
        const result = await desktop.evaluate(
          () => globalThis.stableStudy.result,
        );
        assert(!result.error, JSON.stringify(result));
        assert.equal(result.strategy, strategy);
        // Wait for the worklet's final batch, not a save/readiness delay.
        await expect
          .poll(() =>
            page.evaluate(
              (frame) => window.lab.pcm.at(-1)?.[0] ?? 0,
              mark.frame,
            ),
          )
          .toBeGreaterThan(mark.frame + 128);
        const continuity = await page.evaluate(
          (m) => window.lab.report(m),
          mark,
        );
        assert(continuity.renderedFrames > 0);
        assert.equal(continuity.zeroFrames, 0, JSON.stringify(continuity));
        assert.equal(continuity.missingFrames, 0);
        assert(
          !continuity.events.some((e) =>
            [
              "waiting",
              "stalled",
              "error",
              "pause",
              "ended",
              "loadedmetadata",
            ].includes(e.name),
          ),
          JSON.stringify(continuity),
        );
        assert(
          Math.abs(continuity.advancedSeconds - continuity.wallMs / 1000) <
            0.25,
          JSON.stringify(continuity),
        );
        const proof = await desktop.evaluate(() =>
          globalThis.stableStudy.proof(),
        );
        assert(
          proof.cloneUnchanged &&
            proof.audioUnchanged &&
            proof.idPreserved &&
            proof.pathPreserved &&
            proof.referencesPreserved,
          JSON.stringify(proof),
        );
        emit({
          event: "continuous-save",
          strategy,
          size,
          repeat,
          ...result,
          continuity,
          proof,
        });
      }
      // A deliberate pre-publication hold tests controls while a save really remains pending.
      await desktop.evaluate(() => {
        globalThis.stableStudy.startSave({ repeat: 3, hold: true });
      });
      await expect
        .poll(() => desktop.evaluate(() => !!globalThis.stableStudy.proceed), {
          timeout: 60000,
        })
        .toBe(true);
      const controls = await page.evaluate(async () => {
        const l = window.lab;
        l.audio.pause();
        const t = performance.now();
        l.audio.currentTime = 17;
        await new Promise((resolve, reject) => {
          l.audio.addEventListener("seeked", resolve, { once: true });
          l.audio.addEventListener("error", reject, { once: true });
        });
        const seekMs = performance.now() - t;
        await l.audio.play();
        return {
          seekMs,
          position: l.audio.currentTime,
          paused: l.audio.paused,
        };
      });
      assert(!controls.paused);
      assert(controls.position >= 16.9);
      const switched = await page.evaluate(
        (id) => window.lab.play(id, 3),
        setup.otherId,
      );
      const reacquired = await page.evaluate(
        (id) => window.lab.play(id, 24),
        setup.id,
      );
      await desktop.evaluate(() => {
        globalThis.stableStudy.proceed();
        globalThis.stableStudy.proceed = null;
      });
      await expect
        .poll(() => desktop.evaluate(() => globalThis.stableStudy.done), {
          timeout: 60000,
        })
        .toBe(true);
      assert(
        !(await desktop.evaluate(() => globalThis.stableStudy.result)).error,
      );
      emit({
        event: "controls-during-save",
        strategy,
        size,
        ...controls,
        switchMs: switched,
        reacquireMs: reacquired,
      });
      // Existing coordinator hooks exercise safe refusal and genuine post-publication recovery.
      for (const fault of ["before-publish", "published"]) {
        const mark = await page.evaluate(() => window.lab.mark());
        await desktop.evaluate((_, fault) => {
          globalThis.stableStudy.startSave({ repeat: 4, fault });
        }, fault);
        await expect
          .poll(() => desktop.evaluate(() => globalThis.stableStudy.done), {
            timeout: 60000,
          })
          .toBe(true);
        const failure = await desktop.evaluate(
          () => globalThis.stableStudy.result,
        );
        assert(
          failure.error?.includes("Disposable " + fault),
          JSON.stringify(failure),
        );
        const p = await desktop.evaluate(() => globalThis.stableStudy.proof());
        assert(p.cloneUnchanged && p.audioUnchanged);
        const continuity = await page.evaluate(
          (m) => window.lab.report(m),
          mark,
        );
        assert.equal(continuity.zeroFrames, 0);
        emit({
          event: "publication-fault",
          strategy,
          size,
          fault,
          ...failure,
          continuity,
        });
        {
          const recovered = await desktop.evaluate(() =>
            globalThis.stableStudy.recover(),
          );
          assert.equal(recovered.pending, 0);
          emit({ event: "recovery", strategy, size, ...recovered });
        }
      }
      await page.evaluate(() => window.lab.clear());
      const revision = await desktop.evaluate(() =>
        globalThis.stableStudy.refresh(),
      );
      assert(revision.revisionChanged && revision.anonymous);
      const newPlayMs = await page.evaluate(
        (id) => window.lab.play(id, 29),
        setup.id,
      );
      emit({
        event: "new-revision-reacquired",
        strategy,
        size,
        ...revision,
        newPlayMs,
      });
      const authentication = await desktop.evaluate(async () => {
        const l = globalThis.stableStudy,
          g = l.use.acquire(l.owner, l.track.id, l.library.directory);
        let wrongOwner = false;
        try {
          await l.use.release(l.owner + 1000, g.token);
        } catch {
          wrongOwner = true;
        }
        const concurrent = await l.use.respond(
          g.token,
          l.track.id,
          new Request(g.url, { headers: { range: "bytes=0-4095" } }),
        );
        const concurrentBytes = (await concurrent.arrayBuffer()).byteLength;
        const concurrentSources = l.use.sources.size;
        const noToken = (
          await l.use.respond("", l.track.id, new Request(g.url))
        ).status;
        const wrongTrack = (
          await l.use.respond(g.token, "not-the-track", new Request(g.url))
        ).status;
        await l.use.release(l.owner, g.token);
        return {
          wrongOwner,
          noToken,
          wrongTrack,
          concurrentBytes,
          concurrentSources,
        };
      });
      assert(authentication.wrongOwner);
      assert.equal(authentication.noToken, 403);
      assert.equal(authentication.wrongTrack, 403);
      assert.equal(authentication.concurrentBytes, 4096);
      assert.equal(authentication.concurrentSources, 2);
      emit({ event: "authorization", strategy, size, ...authentication });
      const stale = await page.evaluate(() => window.lab.leases.at(-1));
      if (strategy === "in-place" && size === "large") {
        await desktop.evaluate(() =>
          globalThis.stableStudy.ownerWeb.forcefullyCrashRenderer(),
        );
        await expect
          .poll(
            () =>
              desktop.evaluate(() => globalThis.stableStudy.use.sources.size),
            { timeout: 10000 },
          )
          .toBe(0);
        emit({ event: "renderer-crash", strategy, size, sourcesDrained: true });
      } else await page.evaluate(() => window.lab.clear());
      const cleanup = await desktop.evaluate(
        async (_, stale) => globalThis.stableStudy.cleanup(stale),
        stale,
      );
      assert.equal(cleanup.sources, 0);
      assert.equal(cleanup.staleStatus, 403);
      assert(cleanup.clonesRemoved);
      emit({ event: "cleanup", strategy, size, ...cleanup });
      await rm(directory, { recursive: true, force: true });
    }
  if (!smallOnly) assert.equal(hash(await readFile(large)), originalLarge);
  const output = {
    date: new Date().toISOString(),
    kind: "research-only; real Electron FLAC decoder + AudioWorklet PCM, muted destination; no acoustic loopback",
    rows,
  };
  const outIndex = process.argv.indexOf("--output");
  if (outIndex >= 0)
    await writeFile(
      process.argv[outIndex + 1],
      JSON.stringify(output, null, 2) + "\n",
    );
  console.log("Stable-source research passed", rows.length, "observations");
} finally {
  await desktop?.close();
  await rm(external, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}

async function installMain(
  { app, BrowserWindow, ipcMain, protocol },
  { repo, scratch, native },
) {
  const req = process
    .getBuiltinModule("module")
    .createRequire(repo + "/dist/main/main.js");
  const { Library } = req(repo + "/dist/domain/library.js"),
    core = req(repo + "/dist/domain/metadata-edit.js"),
    { PlaybackUse } = req(repo + "/dist/main/playback-use.js");
  const fs = process.getBuiltinModule("fs"),
    fsp = process.getBuiltinModule("fs/promises"),
    path = process.getBuiltinModule("path"),
    crypto = process.getBuiltinModule("crypto"),
    cp = process.getBuiltinModule("child_process");
  const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
  const owner = BrowserWindow.getAllWindows()[0].webContents;
  const lab = (globalThis.stableStudy = {
    owner: owner.id,
    ownerWeb: owner,
    done: true,
    entries: new Map(),
    use: new PlaybackUse(),
    originalUse: new PlaybackUse(),
  });
  owner.on("render-process-gone", () => {
    lab.crashDrain = lab.use.revokeOwner(owner.id);
  });
  function assertSender(e) {
    if (
      e.sender !== owner ||
      e.senderFrame !== owner.mainFrame ||
      e.senderFrame.url !== "rio://app/index.html"
    )
      throw Error("Unexpected research sender");
  }
  ipcMain.handle("lab:acquire", (e, id) => {
    assertSender(e);
    if (typeof id !== "string" || !lab.entries.has(id))
      throw Error("Unknown track");
    return lab.use.acquire(owner.id, id, lab.library.directory);
  });
  ipcMain.handle("lab:release", async (e, token) => {
    assertSender(e);
    await lab.use.release(owner.id, token);
  });
  ipcMain.handle("lab:probe", async (e, token, id) => {
    assertSender(e);
    const r = await lab.use.respond(
      token,
      id,
      new Request("rio-media://track/" + id + "?use=" + token, {
        headers: { range: "bytes=0-4095" },
      }),
    );
    await r.arrayBuffer();
    return r.status;
  });
  let tick = performance.now();
  setInterval(() => {
    const now = performance.now();
    lab.maxMainTickGapMs = Math.max(lab.maxMainTickGapMs || 0, now - tick);
    tick = now;
  }, 16);
  protocol.handle("rio-media", async (request) => {
    const u = new URL(request.url);
    if (u.hostname !== "track" || u.pathname.split("/").length !== 2)
      return new Response(null, { status: 403 });
    const r = await lab.use.respond(
      u.searchParams.get("use") || "",
      u.pathname.slice(1),
      request,
    );
    r.headers.set("Access-Control-Allow-Origin", "rio://app");
    return r;
  });
  lab.setup = async ({ directory, source, other }) => {
    lab.library = await Library.open(directory, { setupMediaRoot: true });
    const l = lab.library;
    l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    const added = await l.add([source, other]);
    if (added.errors.length) throw Error(JSON.stringify(added.errors));
    const tracks = l.tracks();
    if (tracks.length !== 2) throw Error("Expected two tracks");
    // Import order is deterministic; source title/filename never leaves this lab.
    lab.track =
      tracks.find((t) => path.basename(t.path) === path.basename(source)) ||
      tracks[0];
    const alternate = tracks.find((t) => t.id !== lab.track.id);
    l.favorite(lab.track.id);
    l.createPlaylist("Disposable", [lab.track.id]);
    l.saveState({ ...l.state(), queue: [lab.track.id] });
    lab.cache = path.join(directory, ".disposable-playback-cache");
    await fsp.mkdir(lab.cache, { mode: 0o700 });
    const clones = [];
    lab.originalUse.bindLibrary(l);
    for (const track of tracks) {
      const idle = lab.originalUse.usageFor(l).acquireIdle(track.id);
      try {
        const t = performance.now(),
          before = await fsp.readFile(track.path),
          base = crypto.randomUUID() + ".flac";
        const info = JSON.parse(
          cp.execFileSync(native, [track.path, lab.cache, base], {
            encoding: "utf8",
          }),
        );
        const filename = path.join(lab.cache, base);
        const fd = fs.openSync(
          filename,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        const bytes = await fsp.readFile(filename);
        if (
          sha(bytes) !== sha(before) ||
          sha(await fsp.readFile(track.path)) !== sha(before)
        )
          throw Error("Unstable capture");
        const identity = fs.fstatSync(fd);
        await fsp.unlink(filename);
        lab.entries.set(track.id, {
          fd,
          filename,
          identity,
          digest: sha(bytes),
          audio: sha(audioBytes(bytes)),
          originalInode: fs.statSync(track.path).ino,
          unlinked: true,
        });
        clones.push({ ...info, establishMs: performance.now() - t });
      } finally {
        idle.release();
      }
    }
    // Facade gives the unchanged PlaybackUse a distinct, read-only physical resource scope.
    // /dev/fd opens the retained clone object, not a mutable cache pathname.
    lab.facade = {
      directory: l.directory,
      db: l.db,
      tracks: (id) => l.tracks(id),
      media: (id) => {
        const e = lab.entries.get(id);
        if (!e) return;
        const s = fs.fstatSync(e.fd);
        if (
          s.dev !== e.identity.dev ||
          s.ino !== e.identity.ino ||
          s.size !== e.identity.size
        )
          return;
        return { path: "/dev/fd/" + e.fd, format: "flac" };
      },
    };
    lab.use.bindLibrary(lab.facade);
    lab.use.allowOwner(owner.id);
    lab.done = true;
    const space = JSON.parse(
      cp.execFileSync(native, ["space", directory], { encoding: "utf8" }),
    );
    return {
      anonymousClones: true,
      id: lab.track.id,
      otherId: alternate.id,
      bytes: fs.statSync(lab.track.path).size,
      noowners: space.noowners,
      clones,
    };
  };
  function audioBytes(b) {
    let p = 4;
    for (let n = 0; n < 256; n++) {
      if (p + 4 > b.length) throw Error("Invalid metadata");
      const last = b[p] & 128;
      const size = b.readUIntBE(p + 1, 3);
      p += 4 + size;
      if (p > b.length) throw Error("Truncated metadata");
      if (last) return b.subarray(p);
    }
    throw Error("Metadata budget");
  }
  lab.startSave = ({ repeat, hold, fault }) => {
    if (!lab.done) throw Error("Conflicting save");
    lab.done = false;
    lab.result = null;
    lab.maxMainTickGapMs = 0;
    tick = performance.now();
    const readersAtStart = [...lab.use.sources.values()].reduce(
      (n, s) => n + s.readers.size,
      0,
    );
    const t = performance.now(),
      stages = {};
    lab.running = core
      .editManagedFlac(
        lab.library,
        lab.track.id,
        {
          genre: {
            action: "set",
            value: "Disposable revision " + repeat + " " + (fault || ""),
          },
        },
        {
          usage: lab.originalUse.usageFor(lab.library),
          timing: (stage, detail) => {
            if (detail?.strategy) lab.strategy = detail.strategy;
            if (!detail) stages[stage] = performance.now() - t;
          },
          hooks: {
            at: async (phase) => {
              if (hold && phase === "before-publish")
                await new Promise((resolve) => (lab.proceed = resolve));
              if (fault === phase)
                throw new core.MetadataEditInterruption("Disposable " + fault);
            },
          },
        },
      )
      .then(
        (result) => {
          lab.result = {
            saveMs: performance.now() - t,
            maxMainTickGapMs: Math.max(
              lab.maxMainTickGapMs,
              performance.now() - tick,
            ),
            readersAtStart,
            strategy: lab.strategy,
            status: result.status,
            stages,
          };
        },
        (error) => {
          lab.result = {
            saveMs: performance.now() - t,
            maxMainTickGapMs: Math.max(
              lab.maxMainTickGapMs,
              performance.now() - tick,
            ),
            readersAtStart,
            strategy: lab.strategy,
            error: String(error),
            stages,
          };
        },
      )
      .finally(() => (lab.done = true));
  };
  function fdBytes(fd) {
    const size = fs.fstatSync(fd).size,
      b = Buffer.alloc(size);
    let at = 0;
    while (at < size) {
      const n = fs.readSync(fd, b, at, size - at, at);
      if (!n) throw Error("Short clone read");
      at += n;
    }
    return b;
  }
  lab.proof = async () => {
    const t = lab.library.tracks(lab.track.id)[0],
      e = lab.entries.get(t.id),
      b = await fsp.readFile(t.path);
    return {
      cloneUnchanged: sha(fdBytes(e.fd)) === e.digest,
      audioUnchanged: sha(audioBytes(b)) === e.audio,
      idPreserved: t.id === lab.track.id,
      pathPreserved: t.path === lab.track.path,
      inodeReplaced: fs.statSync(t.path).ino !== e.originalInode,
      referencesPreserved:
        !!t.favorite &&
        lab.library.playlists()[0].trackIds[0] === t.id &&
        lab.library.state().queue[0] === t.id,
    };
  };
  lab.recover = async () => {
    await core.recoverMetadataEdits(lab.library);
    return {
      pending: lab.library.db
        .prepare(
          "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
        )
        .get().n,
    };
  };
  lab.refresh = async () => {
    if (lab.use.sources.size)
      throw Error("Drain before replacing clone revision");
    const track = lab.library.tracks(lab.track.id)[0],
      old = lab.entries.get(track.id),
      t = performance.now();
    const use = lab.originalUse.usageFor(lab.library).acquireIdle(track.id);
    try {
      const base = crypto.randomUUID() + ".flac";
      const info = JSON.parse(
        cp.execFileSync(native, [track.path, lab.cache, base], {
          encoding: "utf8",
        }),
      );
      const filename = path.join(lab.cache, base),
        fd = fs.openSync(
          filename,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        ),
        bytes = fdBytes(fd),
        identity = fs.fstatSync(fd);
      if (sha(bytes) !== sha(await fsp.readFile(track.path)))
        throw Error("Changed revision");
      await fsp.unlink(filename);
      fs.closeSync(old.fd);
      lab.entries.set(track.id, {
        fd,
        filename,
        identity,
        digest: sha(bytes),
        audio: sha(audioBytes(bytes)),
        originalInode: fs.statSync(track.path).ino,
        unlinked: true,
      });
      return {
        cloneMs: info.cloneMs,
        establishMs: performance.now() - t,
        revisionChanged: sha(bytes) !== old.digest,
        anonymous: fs.fstatSync(fd).nlink === 0,
      };
    } finally {
      use.release();
    }
  };
  lab.cleanup = async (stale) => {
    const t = performance.now();
    await lab.use.shutdown();
    await lab.originalUse.shutdown();
    const staleStatus = (
      await lab.use.respond(stale.token, lab.track.id, new Request(stale.url))
    ).status;
    for (const e of lab.entries.values()) {
      if (fs.fstatSync(e.fd).nlink !== 0)
        throw Error("Expected anonymous source");
      fs.closeSync(e.fd);
    }
    lab.entries.clear();
    await fsp.rmdir(lab.cache);
    lab.library.close();
    return {
      cleanupMs: performance.now() - t,
      sources: lab.use.sources.size,
      staleStatus,
      clonesRemoved: !fs.existsSync(lab.cache),
    };
  };
}
