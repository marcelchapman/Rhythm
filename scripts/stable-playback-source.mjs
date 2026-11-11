// Infrastructure qualification only. The real player's IPC remains unchanged.
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  mkdir,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { _electron as electron } from "playwright";
import { expect } from "playwright/test";
import { playbackFlacFixture } from "../tests/metadata-fixtures.ts";
assert.equal(process.platform, "darwin");
const repo = await realpath(process.cwd()),
  root = await mkdtemp("/private/tmp/rio-stable-desktop-");
const i = process.argv.indexOf("--external-parent"),
  external = await mkdtemp(
    path.join(
      i < 0 ? repo : await realpath(process.argv[i + 1]),
      ".rio-stable-desktop-",
    ),
  );
const largeIndex = process.argv.indexOf("--large"),
  large = largeIndex < 0 ? undefined : process.argv[largeIndex + 1];
const digest = (b) => createHash("sha256").update(b).digest("hex");
const largeBefore = large ? digest(await readFile(large)) : undefined;
let app;
const rows = [];
const emit = (r) => {
  rows.push(r);
  console.log("RIO_STABLE_MANAGER", JSON.stringify(r));
};
try {
  const small = path.join(root, "small.flac");
  await writeFile(small, playbackFlacFixture());
  await mkdir(path.join(root, "Profile"));
  app = await electron.launch({
    args: [repo],
    env: {
      ...process.env,
      RIO_DATA_DIR: path.join(root, "Profile"),
      RIO_STABLE_PLAYBACK_SOURCES: "1",
    },
    timeout: 30000,
  });
  let page = await app.firstWindow();
  await page.waitForSelector("h1");
  const runtime = await app.evaluate(async ({ app }) => {
    assertSource();
    function assertSource() {
      if (app.isPackaged)
        throw Error("Infrastructure qualification requires source app.");
    }
    const { Readable } = process.getBuiltinModule("stream");
    let reads = 0;
    const chunk = Buffer.alloc(256 * 1024),
      stream = Readable.from(
        (async function* () {
          for (let n = 0; n < 256; n++) {
            reads++;
            yield chunk;
          }
        })(),
        { objectMode: false, highWaterMark: 256 * 1024 },
      );
    const web = Readable.toWeb(stream);
    await new Promise((resolve) => setImmediate(resolve));
    const bufferedChunks = reads;
    await web.cancel();
    return {
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
      electron: process.versions.electron,
      unconsumedChunks: bufferedChunks,
    };
  });
  assert(
    runtime.unconsumedChunks <= 4,
    "Runtime must apply byte-bounded Web-stream backpressure",
  );

  for (const [storage, parent] of [
    ["owned", root],
    ["noowners", external],
  ])
    for (const [size, source] of [
      ["small", small],
      ...(large ? [["large", large]] : []),
    ]) {
      const directory = path.join(parent, `Library-${size}`);
      await app.evaluate(async ({ BrowserWindow }, repo) => {
        const req = process
            .getBuiltinModule("module")
            .createRequire(repo + "/dist/main/main.js"),
          { playbackUse: use } = req(repo + "/dist/main/playback-use.js");
        if (use.currentLibrary)
          await use.acquireIsolated(
            BrowserWindow.getAllWindows()[0].webContents.id,
            use.currentLibrary.tracks()[0].id,
            use.currentLibrary.directory,
          );
      }, repo);
      const setup = await app.evaluate(
        async ({ dialog, Menu }, { repo, directory, source }) => {
          const req = process
              .getBuiltinModule("module")
              .createRequire(repo + "/dist/main/main.js"),
            { Library } = req(repo + "/dist/domain/library.js"),
            l = await Library.open(directory, { setupMediaRoot: true });
          let t;
          try {
            l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
            await l.add([source]);
            t = l.tracks()[0];
            l.saveState({
              ...l.state(),
              view: "Songs",
              currentId: null,
              queue: [t.id],
            });
          } finally {
            l.close();
          }
          dialog.showOpenDialog = async () => ({
            canceled: false,
            filePaths: [directory],
          });
          Menu.getApplicationMenu()
            .items.find((x) => x.label === "File")
            .submenu.items.find((x) => x.label === "Choose Library…")
            .click();
          return { id: t.id, bytes: t.fileSize };
        },
        { repo, directory, source },
      );
      await expect
        .poll(
          () =>
            app.evaluate(
              (_, { repo, directory }) => {
                const req = process
                  .getBuiltinModule("module")
                  .createRequire(repo + "/dist/main/main.js");
                return (
                  req(repo + "/dist/main/playback-use.js").playbackUse
                    .currentLibrary?.directory === directory
                );
              },
              { repo, directory },
            ),
          { timeout: 30000 },
        )
        .toBe(true);
      // Even with the flag armed, ordinary renderer acquisition uses the original path.
      const regular = await page.evaluate(
        async ({ id, directory }) => {
          const g = await window.rio.acquirePlayback(id, directory);
          await window.rio.releasePlayback(g.token);
          return Object.keys(g).sort();
        },
        { id: setup.id, directory },
      );
      assert.deepEqual(regular, ["token", "url"]);
      assert.equal(
        await app.evaluate((_, repo) => {
          const req = process
            .getBuiltinModule("module")
            .createRequire(repo + "/dist/main/main.js");
          return req(repo + "/dist/main/stable-source-manager.js").stableSources
            .activeSources;
        }, repo),
        0,
      );
      for (const repeat of [0, 1, 2]) {
        const capture = await app.evaluate(
          async ({ BrowserWindow }, { repo, id, directory }) => {
            const req = process
                .getBuiltinModule("module")
                .createRequire(repo + "/dist/main/main.js"),
              { playbackUse: use } = req(repo + "/dist/main/playback-use.js"),
              { stableSources } = req(
                repo + "/dist/main/stable-source-manager.js",
              );
            const owner = BrowserWindow.getAllWindows()[0].webContents.id;
            const originalFactory = stableSources.factory;
            let workerConstructorMs = 0;
            stableSources.factory = (config) => {
              const t = performance.now();
              try {
                return originalFactory(config);
              } finally {
                workerConstructorMs += performance.now() - t;
              }
            };
            const cpu = process.threadCpuUsage?.();

            let previous = performance.now(),
              maxGapMs = 0;
            const clock = setInterval(() => {
                const now = performance.now();
                maxGapMs = Math.max(maxGapMs, now - previous);
                previous = now;
              }, 5),
              started = performance.now();
            try {
              const grant = await use.acquireIsolated(owner, id, directory);
              maxGapMs = Math.max(maxGapMs, performance.now() - previous);
              let blocked = false;
              try {
                const idle = use.usageFor(use.currentLibrary).acquireIdle(id);
                idle.release();
              } catch {
                blocked = true;
              }
              if (!blocked)
                throw Error("Clone must not enable active-track edits");
              return {
                grant,
                wallMs: performance.now() - started,
                workerConstructorMs,
                mainThreadCpuMs: cpu
                  ? (() => {
                      const now = process.threadCpuUsage();
                      return (
                        (now.user + now.system - cpu.user - cpu.system) / 1000
                      );
                    })()
                  : null,
                maxMainTickGapMs: maxGapMs,
                metrics: use.sources.get(grant.token).isolated.metrics,
                active: stableSources.activeSources,
              };
            } finally {
              clearInterval(clock);
              stableSources.factory = originalFactory;
            }
          },
          { repo, id: setup.id, directory },
        );
        assert.equal(capture.active, 1);
        assert.deepEqual(Object.keys(capture.grant).sort(), ["token", "url"]);
        const playing = await page.evaluate(async ({ url }) => {
          const audio = document.createElement("audio");
          audio.muted = true;
          document.body.append(audio);
          window.stableTestAudio = audio;
          const t = performance.now();
          audio.src = url;
          await audio.play();
          return { playMs: performance.now() - t };
        }, capture.grant);
        await expect
          .poll(() => page.evaluate(() => window.stableTestAudio.currentTime))
          .toBeGreaterThan(0.2);
        await page.evaluate(() => window.stableTestAudio.pause());
        assert(
          await app.evaluate(
            (_, { repo, id }) => {
              const req = process
                  .getBuiltinModule("module")
                  .createRequire(repo + "/dist/main/main.js"),
                { playbackUse: use } = req(repo + "/dist/main/playback-use.js");
              try {
                const lease = use.usageFor(use.currentLibrary).acquireIdle(id);
                lease.release();
                return false;
              } catch {
                return true;
              }
            },
            { repo, id: setup.id },
          ),
        );
        await page.evaluate(async (token) => {
          const a = window.stableTestAudio;
          a.removeAttribute("src");
          a.load();
          a.remove();
          await window.rio.releasePlayback(token);
        }, capture.grant.token);
        const revoked = await app.evaluate(
          async ({ net }, { repo, id, grant }) => {
            const req = process
                .getBuiltinModule("module")
                .createRequire(repo + "/dist/main/main.js"),
              { stableSources } = req(
                repo + "/dist/main/stable-source-manager.js",
              ),
              { playbackUse: use } = req(repo + "/dist/main/playback-use.js");
            const status = (await net.fetch(grant.url)).status;
            const idle = use.usageFor(use.currentLibrary).acquireIdle(id);
            idle.release();
            return { status, active: stableSources.activeSources };
          },
          { repo, id: setup.id, grant: capture.grant },
        );
        assert.equal(revoked.status, 403);
        assert.equal(revoked.active, 0);
        delete capture.grant;
        emit({
          storage,
          size,
          repeat,
          bytes: setup.bytes,
          ...capture,
          ...playing,
          revoked,
        });
      }
    }
  // Quit with a real outstanding isolated lease. Actual application before-quit drains it.
  await app.evaluate(async ({ BrowserWindow }, repo) => {
    const req = process
        .getBuiltinModule("module")
        .createRequire(repo + "/dist/main/main.js"),
      { playbackUse: use } = req(repo + "/dist/main/playback-use.js");
    await use.acquireIsolated(
      BrowserWindow.getAllWindows()[0].webContents.id,
      use.currentLibrary.tracks()[0].id,
      use.currentLibrary.directory,
    );
  }, repo);
  const quitProof = path.join(root, "quit-proof.json");
  await app.evaluate(
    ({ app }, { repo, quitProof }) => {
      const req = process
        .getBuiltinModule("module")
        .createRequire(repo + "/dist/main/main.js");
      app.on("will-quit", () =>
        process.getBuiltinModule("fs").writeFileSync(
          quitProof,
          JSON.stringify({
            active: req(repo + "/dist/main/stable-source-manager.js")
              .stableSources.activeSources,
          }),
        ),
      );
    },
    { repo, quitProof },
  );
  await app.close();
  app = undefined;
  assert.equal(JSON.parse(await readFile(quitProof, "utf8")).active, 0);
  app = await electron.launch({
    args: [repo],
    env: {
      ...process.env,
      RIO_DATA_DIR: path.join(root, "Profile"),
      RIO_STABLE_PLAYBACK_SOURCES: "1",
    },
    timeout: 30000,
  });
  page = await app.firstWindow();
  await page.waitForSelector("h1");
  const crashGrant = await app.evaluate(async ({ BrowserWindow }, repo) => {
    const req = process
        .getBuiltinModule("module")
        .createRequire(repo + "/dist/main/main.js"),
      { playbackUse: use } = req(repo + "/dist/main/playback-use.js");
    return use.acquireIsolated(
      BrowserWindow.getAllWindows()[0].webContents.id,
      use.currentLibrary.tracks()[0].id,
      use.currentLibrary.directory,
    );
  }, repo);
  await page.evaluate(async (g) => {
    const a = document.createElement("audio");
    a.muted = true;
    document.body.append(a);
    a.src = g.url;
    await a.play();
  }, crashGrant);
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
  );
  await expect
    .poll(
      () =>
        app.evaluate((_, repo) => {
          const req = process
            .getBuiltinModule("module")
            .createRequire(repo + "/dist/main/main.js");
          return req(repo + "/dist/main/stable-source-manager.js").stableSources
            .activeSources;
        }, repo),
      { timeout: 15000 },
    )
    .toBe(0);
  emit({ event: "renderer-crash", sourcesDrained: true });
  await app.close();
  app = undefined;
  if (large) assert.equal(digest(await readFile(large)), largeBefore);
  const out = process.argv.indexOf("--output");
  if (out >= 0)
    await writeFile(
      process.argv[out + 1],
      JSON.stringify({ runtime, rows, quitDrained: true }, null, 2) + "\n",
    );
  console.log("Stable source infrastructure desktop qualification passed.");
} finally {
  await app?.close();
  await rm(external, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
