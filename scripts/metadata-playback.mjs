// Real renderer -> preload -> main -> protocol ownership; no metadata IPC endpoint.
import { _electron as electron } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolvePublicationPackage } from "./lib/publication-package.mjs";
import {
  block,
  commentBlock,
  inspectFlac,
} from "../tests/metadata-fixtures.ts";
import { wavFixture } from "../tests/fixtures.ts";
const packaged =
  !!process.env.RIO_EXECUTABLE || process.argv.includes("--packaged");
const bundle =
  packaged && !process.env.RIO_EXECUTABLE
    ? await resolvePublicationPackage()
    : undefined;
const executable = process.env.RIO_EXECUTABLE || bundle?.executable;
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-metadata-playback-")),
);
let app, modules;
const provenance = [];
async function launch(profile) {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    ...(packaged ? { cwd: root } : {}),
    env: { ...process.env, RIO_DATA_DIR: profile },
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  const rendererURLs = await page
    .locator("script[src]")
    .evaluateAll((scripts) => scripts.map((script) => script.src));
  assert(rendererURLs.length, "Renderer must load its application script");
  const debuggerSession = await page.context().newCDPSession(page),
    loaded = [];
  debuggerSession.on("Debugger.scriptParsed", (event) =>
    loaded.push(event.url),
  );
  try {
    await debuggerSession.send("Debugger.enable");
  } finally {
    await debuggerSession.detach();
  }
  for (const url of rendererURLs)
    assert(loaded.includes(url), `Renderer script did not execute: ${url}`);
  const evidence = await app.evaluate(
    async ({ app, net }, { packaged, rendererURLs }) => {
      const path = process.getBuiltinModule("path"),
        fs = process.getBuiltinModule("fs"),
        { createHash } = process.getBuiltinModule("crypto"),
        assert = process.getBuiltinModule("assert/strict"),
        { fileURLToPath } = process.getBuiltinModule("url");
      assert.equal(
        app.isPackaged,
        packaged,
        "Must run requested source/packaged application",
      );
      const appPath = app.getAppPath();
      if (packaged)
        assert.equal(appPath, path.join(process.resourcesPath, "app.asar"));
      const paths = {
        main: path.join(appPath, "dist/main/main.js"),
        preload: path.join(appPath, "dist/main/preload.cjs"),
        playback: path.join(appPath, "dist/main/playback-use.js"),
        metadata: path.join(appPath, "dist/domain/metadata-edit.js"),
        library: path.join(appPath, "dist/domain/library.js"),
      };

      const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
      const proof = (filename) => ({
        path: filename,
        sha256: hash(fs.readFileSync(filename)),
      });
      // Observe the already executed main entry; do not require it a second time.
      const inspector = process.getBuiltinModule("inspector"),
        session = new inspector.Session(),
        scripts = [];
      session.connect();
      session.on("Debugger.scriptParsed", (event) =>
        scripts.push(event.params.url),
      );
      try {
        await new Promise((resolve, reject) =>
          session.post("Debugger.enable", (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      } finally {
        session.disconnect();
      }
      const executedMain = scripts.find(
        (url) => url.startsWith("file:") && fileURLToPath(url) === paths.main,
      );
      assert(
        executedMain,
        "Running main entry must be this application's bundled code",
      );
      const renderer = [];
      for (const url of ["rio://app/index.html", ...rendererURLs]) {
        const parsed = new URL(url);
        assert.equal(parsed.protocol, "rio:");
        assert.equal(parsed.hostname, "app");
        const filename = path.join(
          appPath,
          "dist/renderer",
          parsed.pathname.slice(1),
        );
        assert(
          filename.startsWith(path.join(appPath, "dist/renderer") + path.sep),
        );
        const served = Buffer.from(await (await net.fetch(url)).arrayBuffer());
        const resource = proof(filename);
        assert.equal(
          hash(served),
          resource.sha256,
          "Served renderer bytes must match this application's resources",
        );
        renderer.push({ url, ...resource });
      }
      return {
        packaged: app.isPackaged,
        runtime: {
          platform: process.platform,
          arch: process.arch,
          electron: process.versions.electron,
          node: process.versions.node,
        },
        appPath,
        executable: process.execPath,
        resourcesPath: process.resourcesPath,
        executedMain,
        paths,
        files: Object.fromEntries(
          Object.entries(paths).map(([key, filename]) => [
            key,
            proof(filename),
          ]),
        ),
        renderer,
      };
    },
    { packaged, rendererURLs },
  );
  modules = evidence.paths;
  const expectedPreload = pathToFileURL(modules.preload).href;
  const executedPreload = loaded.find(
    (url) => url === modules.preload || url === expectedPreload,
  );
  assert(
    executedPreload,
    `Expected executed preload ${modules.preload}; observed ${loaded.filter((url) => url.includes("preload")).join(", ")}`,
  );
  evidence.executedPreload = executedPreload;
  evidence.executedRenderer = rendererURLs;
  provenance.push(evidence);
  assert(
    await page.evaluate(
      () =>
        typeof window.rio.acquirePlayback === "function" &&
        typeof window.rio.releasePlayback === "function",
    ),
    "Actual preload must expose playback-only handshake",
  );
  return page;
}
const protectedFiles = new Map();
const fingerprint = async (file) => ({
  sha256: createHash("sha256")
    .update(await readFile(file))
    .digest("hex"),
  mtime: (await stat(file)).mtimeMs,
});
try {
  const original = path.join(root, "Original.flac"),
    wav = path.join(root, "Generated.wav");
  await writeFile(wav, wavFixture({ seconds: 30 }));
  execFileSync("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-i",
    wav,
    "-c:a",
    "flac",
    original,
  ]);
  const parts = inspectFlac(await readFile(original));
  const canonical = (title) =>
    Buffer.concat([
      Buffer.from("fLaC"),
      ...parts.blocks.map((b, i) =>
        block(
          b.type,
          b.type === 4
            ? commentBlock([
                ["TITLE", title],
                ["ARTIST", "Generated artist"],
                ["ALBUM", "Playback use"],
              ])
            : b.body,
          i === parts.blocks.length - 1,
        ),
      ),
      parts.audio,
    ]);
  const externalA = path.join(root, "A.flac"),
    externalB = path.join(root, "B.flac");
  await writeFile(externalA, canonical("Playback A"));
  await writeFile(externalB, canonical("Playback B"));
  for (const f of [externalA, externalB])
    protectedFiles.set(f, await fingerprint(f));
  const directory = path.join(root, "Library"),
    nextDirectory = path.join(root, "Next library"),
    profile = path.join(root, "Profile");
  await mkdir(profile);
  const page = await launch(profile);
  // Build disposable fixtures using this app's Library as well: packaged mode
  // never imports a production implementation from the checkout's dist tree.
  const { a, b, nextTrack } = await app.evaluate(
    async (_, { modules, directory, nextDirectory, externalA, externalB }) => {
      const require = process
          .getBuiltinModule("module")
          .createRequire(modules.library),
        { Library } = require(modules.library);
      const setup = await Library.open(directory, { setupMediaRoot: true });
      let a, b, nextTrack;
      try {
        setup.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
        await setup.add([externalA, externalB]);
        a = setup.tracks().find((t) => t.title === "Playback A");
        b = setup.tracks().find((t) => t.title === "Playback B");
        setup.saveState({
          ...setup.state(),
          queue: [a.id, b.id],
          view: "Songs",
        });
      } finally {
        setup.close();
      }
      const next = await Library.open(nextDirectory, { setupMediaRoot: true });
      try {
        next.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
        await next.add([externalA]);
        nextTrack = next.tracks()[0];
        next.saveState({ ...next.state(), view: "Songs" });
      } finally {
        next.close();
      }
      return { a, b, nextTrack };
    },
    { modules, directory, nextDirectory, externalA, externalB },
  );
  await app.evaluate(({ dialog, Menu }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
    Menu.getApplicationMenu()
      .items.find((item) => item.label === "File")
      .submenu.items.find((item) => item.label === "Choose Library…")
      .click();
  }, directory);
  await page.waitForSelector(".song-row");
  // Internal main-process calls use the production singleton bound by main.ts.
  const edit = (id, title) =>
    app.evaluate(
      async (_, { modules, id, title }) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(modules.playback);
        const { playbackUse } = require(modules.playback),
          { editManagedFlac } = require(modules.metadata);
        const l = playbackUse.currentLibrary;
        const assert = process.getBuiltinModule("assert/strict"),
          { Library } = require(modules.library);
        assert(
          l instanceof Library,
          "Production singleton must own this app's Library instance",
        );
        assert(
          require.cache[modules.playback]?.loaded &&
            require.cache[modules.metadata]?.loaded,
          "App implementation modules must actually be loaded",
        );
        try {
          const result = await editManagedFlac(
            l,
            id,
            { title: { action: "set", value: title } },
            { usage: playbackUse.usageFor(l) },
          );
          return {
            status: result.status,
            id: result.track.id,
            path: result.track.path,
          };
        } catch (error) {
          return { error: String(error) };
        }
      },
      { modules, id, title },
    );
  const idle = (id) =>
    app.evaluate(
      (_, { modules, id }) => {
        const require = process
            .getBuiltinModule("module")
            .createRequire(modules.playback),
          { playbackUse } = require(modules.playback);
        try {
          const lease = playbackUse
            .usageFor(playbackUse.currentLibrary)
            .acquireIdle(id);
          lease.assertIdle();
          lease.release();
          return true;
        } catch {
          return false;
        }
      },
      { modules, id },
    );
  const waitIdle = (id) =>
    expect
      .poll(() => idle(id), {
        timeout: 15000,
        message: "source revocation and fd closure must complete",
      })
      .toBe(true);
  const play = async (id) => {
    await page
      .locator(`.song-row[data-track-id="${id}"]`)
      .getByRole("button", { name: /^Play / })
      .click();
    await page.waitForFunction(
      (id) => {
        const a = document.querySelector("audio");
        return (
          a.currentSrc &&
          new URL(a.currentSrc).pathname.slice(1) === id &&
          !a.paused &&
          a.readyState >= 3 &&
          a.currentTime > 0.2
        );
      },
      id,
      { timeout: 15000 },
    );
  };
  const pause = () =>
    page.getByRole("button", { name: "Pause", exact: true }).click();
  assert.equal(await page.locator("audio").getAttribute("src"), null);
  await page.evaluate(
    ({ a, b }) =>
      window.rio.saveState({
        queue: [a, b],
        currentId: a,
        position: 2,
        volume: 0.7,
        shuffle: false,
        repeat: "off",
        view: "Songs",
      }),
    { a: a.id, b: b.id },
  );
  assert.equal((await edit(a.id, "Queue reference edit")).status, "committed");
  console.log("METADATA_PLAYBACK: queue-only edit passed");
  await play(a.id);
  const oldURL = await page.locator("audio").getAttribute("src");
  assert.match((await edit(a.id, "Blocked active")).error, /in use/);
  await pause();
  assert.match((await edit(a.id, "Blocked paused")).error, /in use/);
  console.log("METADATA_PLAYBACK: active/pause rejection passed");
  await play(b.id);
  await waitIdle(a.id);
  const edited = await edit(a.id, "Released A");
  assert.equal(edited.status, "committed");
  assert.equal(edited.id, a.id);
  assert.equal(edited.path, a.path);
  assert.match((await edit(b.id, "Blocked B")).error, /in use/);
  console.log(
    "METADATA_PLAYBACK: released edit passed; acquiring idle barrier",
  );
  await app.evaluate(
    (_, { modules, id }) => {
      const require = process
          .getBuiltinModule("module")
          .createRequire(modules.playback),
        { playbackUse } = require(modules.playback);
      globalThis.metadataPlaybackLease = playbackUse
        .usageFor(playbackUse.currentLibrary)
        .acquireIdle(id);
    },
    { modules, id: a.id },
  );
  await page
    .locator(`.song-row[data-track-id="${a.id}"]`)
    .getByRole("button", { name: /^Play / })
    .click();
  await page.locator(".notice.error").waitFor();
  assert.equal(await page.locator("audio").getAttribute("src"), null);
  assert.equal(
    await app.evaluate(
      ({ net }, url) => net.fetch(url).then((r) => r.status),
      oldURL,
    ),
    403,
  );
  assert.equal(
    await app.evaluate(
      ({ net }, id) =>
        net.fetch(`rio-media://track/${id}`).then((r) => r.status),
      a.id,
    ),
    403,
  );
  await app.evaluate(() => {
    globalThis.metadataPlaybackLease.assertIdle();
    globalThis.metadataPlaybackLease.release();
    delete globalThis.metadataPlaybackLease;
  });
  console.log(
    "METADATA_PLAYBACK: idle barrier denies Play and unauthorized reads",
  );
  await play(a.id);
  const bBytes = await readFile(b.path);
  await writeFile(b.path, "invalid generated FLAC");
  await page
    .locator(`.song-row[data-track-id="${b.id}"]`)
    .getByRole("button", { name: /^Play / })
    .click();
  await page.locator(".notice.error").waitFor();
  await waitIdle(b.id);
  assert.equal(await page.locator("audio").getAttribute("src"), null);
  await writeFile(b.path, bBytes);
  assert.equal(
    (await edit(b.id, "Edited after decode error")).status,
    "committed",
  );
  // Native library switch revokes old sources even before renderer snapshot adoption.
  await play(a.id);
  await app.evaluate(({ dialog }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
  }, nextDirectory);
  await app.evaluate(({ Menu }) => {
    Menu.getApplicationMenu()
      .items.find((item) => item.label === "File")
      .submenu.items.find((item) => item.label === "Choose Library…")
      .click();
  });
  await page.waitForFunction(
    (dir) => window.rio.snapshot().then((s) => s.libraryPath === dir),
    nextDirectory,
  );
  await page.waitForFunction(
    () => !document.querySelector("audio").getAttribute("src"),
  );
  assert.equal(
    (await edit(nextTrack.id, "New library independent")).status,
    "committed",
  );
  assert.equal(
    await app.evaluate(
      ({ net }, url) => net.fetch(url).then((r) => r.status),
      oldURL,
    ),
    404,
  );
  await play(nextTrack.id);
  const quitReport = path.join(root, "quit.json");
  await app.evaluate(
    ({ app }, { modules, quitReport }) => {
      const require = process
          .getBuiltinModule("module")
          .createRequire(modules.playback),
        { playbackUse } = require(modules.playback);
      app.once("will-quit", () =>
        process
          .getBuiltinModule("fs")
          .writeFileSync(
            quitReport,
            JSON.stringify({ unbound: playbackUse.currentLibrary === null }),
          ),
      );
    },
    { modules, quitReport },
  );
  await app.close();
  app = undefined;
  assert.equal(JSON.parse(await readFile(quitReport)).unbound, true);
  // Fresh renderer uses the remembered currentId to really preload a decoder.
  // Crash it last: Playwright marks a crashed page target permanently unusable.
  const reopened = await launch(profile);
  await reopened.waitForSelector(".song-row");
  await reopened.waitForFunction(() => {
    const a = document.querySelector("audio");
    return !!a.getAttribute("src") && a.readyState >= 3;
  });
  assert.match(
    (await edit(nextTrack.id, "Blocked restored source")).error,
    /in use/,
  );
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  await waitIdle(nextTrack.id);
  assert.equal(
    (await edit(nextTrack.id, "Edited after renderer teardown")).status,
    "committed",
  );
  await app.close();
  app = undefined;
  for (const [file, expected] of protectedFiles)
    assert.deepEqual(await fingerprint(file), expected);
  console.log(
    JSON.stringify(
      {
        passed: true,
        packaged,
        provenance,
        checks: [
          "queue/current references alone permit edit",
          "real active and paused decoders block edit",
          "track switch releases old source and keeps new source busy",
          "edit idle lease denies real Play and unleased/stale protocol requests",
          "renderer crash cleanup and restored decoder reacquisition",
          "real decode error releases source; restored managed file edits safely",
          "library switch and application quit revoke all source authority",
          "same pathname/track ID and unchanged external source bytes/mtimes",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (app) {
    await app
      .evaluate(() => {
        globalThis.metadataPlaybackLease?.release();
        delete globalThis.metadataPlaybackLease;
      })
      .catch(() => {});
    await app.close();
  }
  await rm(root, { recursive: true, force: true });
}
