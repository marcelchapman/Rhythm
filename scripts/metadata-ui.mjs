// Real Track Info -> preload -> privileged IPC -> coordinator; disposable fixtures only.
import { _electron as electron } from "playwright";
import { expect } from "playwright/test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  mkdir,
  stat,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { resolvePublicationPackage } from "./lib/publication-package.mjs";
import { wavFixture } from "../tests/fixtures.ts";
import { parseFile } from "music-metadata";
import { playbackFlacFixture } from "../tests/metadata-fixtures.ts";
import { unsupportedMetadataVolume } from "./lib/unsupported-metadata-volume.mjs";
import { localMetadataVolume } from "./lib/local-metadata-volume.mjs";
const packaged =
  !!process.env.RIO_EXECUTABLE || process.argv.includes("--packaged");
const bundle =
  packaged && !process.env.RIO_EXECUTABLE
    ? await resolvePublicationPackage()
    : undefined;
const executable = process.env.RIO_EXECUTABLE || bundle?.executable;
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-metadata-ui-")),
);
let app, modules, unsupportedVolume, localVolume, externalFixture;
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
        editor: path.join(appPath, "dist/main/metadata-editor.js"),
        worker: path.join(appPath, "dist/domain/metadata-edit-worker.js"),
        publication: path.join(appPath, "dist/domain/metadata-publication.js"),
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
    "Actual preload must expose the production playback handshake",
  );
  return page;
}
const fingerprint = async (file) => ({
  sha: createHash("sha256")
    .update(await readFile(file))
    .digest("hex"),
  mtime: (await stat(file)).mtimeMs,
});
try {
  if (process.argv.includes("--noowners"))
    localVolume = await localMetadataVolume(root);
  if (process.env.RIO_METADATA_EXTERNAL_PARENT)
    externalFixture = await realpath(
      await mkdtemp(
        path.join(
          process.env.RIO_METADATA_EXTERNAL_PARENT,
          ".rio-metadata-disposable-",
        ),
      ),
    );
  const mediaParent = externalFixture || localVolume?.directory;
  const media = mediaParent ? path.join(mediaParent, "Rio Media") : null;
  if (media) await mkdir(media);
  const externalA = path.join(root, "A.flac"),
    externalB = path.join(root, "B.flac"),
    referenced = path.join(root, "Reference.flac"),
    wav = path.join(root, "Other.wav");
  for (const [file, title] of [
    [externalA, "UI A"],
    [externalB, "UI B"],
    [referenced, "UI Reference"],
  ])
    await writeFile(
      file,
      playbackFlacFixture([
        ["TITLE", title],
        ["ARTIST", "Original artist"],
        ["ALBUM", "Original album"],
        ["COMMENT", "Preserve this comment"],
      ]),
    );
  await writeFile(wav, wavFixture({ title: "UI WAV", seconds: 30 }));
  const originals = new Map();
  for (const file of [externalA, externalB, referenced, wav])
    originals.set(file, await fingerprint(file));
  const directory = path.join(root, "Library"),
    profile = path.join(root, "Profile");
  await mkdir(profile);
  const page = await launch(profile);
  const { a, b, reference, other } = await app.evaluate(
    async (
      _,
      { modules, directory, externalA, externalB, referenced, wav, media },
    ) => {
      const require = process
          .getBuiltinModule("module")
          .createRequire(modules.library),
        { Library } = require(modules.library);
      const l = await Library.open(directory, { setupMediaRoot: true });
      try {
        if (media) await l.chooseMediaRoot(media);
        l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
        const added = await l.add([externalA, externalB, wav]);
        if (added.errors.length) throw new Error(added.errors.join("\n"));
        l.saveMediaSettings({ copyOnAdd: false });
        await l.add([referenced]);
        const a = l.tracks().find((t) => t.title === "UI A"),
          b = l.tracks().find((t) => t.title === "UI B");
        l.favorite(a.id);
        l.createPlaylist("Keep UI references", [a.id, b.id]);
        l.saveState({ ...l.state(), queue: [a.id, b.id], view: "Songs" });
        return {
          a,
          b,
          reference: l.tracks().find((t) => t.title === "UI Reference"),
          other: l.tracks().find((t) => t.title === "UI WAV"),
        };
      } finally {
        l.close();
      }
    },
    { modules, directory, externalA, externalB, referenced, wav, media },
  );
  // Observe the real coordinator-created worker URLs/replies. Forward URL/options unchanged.
  await app.evaluate(
    (_, { modules }) => {
      const threads = process.getBuiltinModule("worker_threads"),
        nodeModule = process.getBuiltinModule("module"),
        { fileURLToPath } = process.getBuiltinModule("url");
      globalThis.metadataUIWorkers = [];
      const Original = threads.Worker;
      threads.Worker = class extends Original {
        constructor(url, options) {
          const filename =
            typeof url === "string" ? url : fileURLToPath(url.href);
          if (filename !== modules.worker)
            throw new Error("Worker did not come from the running application");
          super(url, options);
          this.on("message", (reply) =>
            globalThis.metadataUIWorkers.push({
              path: filename,
              mode: options.workerData.mode,
              ok: reply.ok,
              backend: reply.value?.verification?.backend,
            }),
          );
        }
      };
      nodeModule.syncBuiltinESMExports();
    },
    { modules },
  );
  await app.evaluate(({ dialog, Menu }, directory) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
    Menu.getApplicationMenu()
      .items.find((i) => i.label === "File")
      .submenu.items.find((i) => i.label === "Choose Library…")
      .click();
    Menu.prototype.popup = function () {
      globalThis.metadataUIMenu = this;
    };
  }, directory);
  await page.waitForSelector(".song-row");
  const snapshot = () => page.evaluate(() => window.rio.snapshot());
  const session = (await snapshot()).metadataSession;
  const row = (id) => page.locator(`.song-row[data-track-id="${id}"]`);
  const dialog = page.getByRole("dialog", { name: "Track Info" });
  async function openInfo(id) {
    await app.evaluate(() => {
      globalThis.metadataUIMenu = null;
    });
    await row(id).click({ button: "right" });
    await expect
      .poll(() => app.evaluate(() => !!globalThis.metadataUIMenu))
      .toBe(true);
    await app.evaluate(() =>
      globalThis.metadataUIMenu.getMenuItemById("track-info").click(),
    );
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("status")).not.toHaveText(/Checking/);
  }
  async function closeInfo() {
    await dialog.getByRole("button", { name: /^(Cancel|Done)$/ }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  }
  const save = async () => {
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".modal-backdrop")).toHaveCount(0);
  };
  const request = (id, changes, token = session) =>
    page.evaluate(
      ({ id, changes, token }) =>
        window.rio.editTrackMetadata(id, token, changes),
      { id, changes, token },
    );
  const titlePatch = (title) => ({ title: { action: "set", value: title } });
  // These are the renderer's real restored queue references. Do not overwrite
  // only main's saved currentId behind the live renderer's state/autosave.
  assert.deepEqual((await snapshot()).state.queue, [a.id, b.id]);
  assert.equal(await page.locator("audio").getAttribute("src"), null);
  const original = await fingerprint(a.path);
  await openInfo(a.id);
  await expect(dialog.getByLabel("Title", { exact: true })).toHaveValue("UI A");
  await dialog
    .getByLabel("Title", { exact: true })
    .fill("Cancel must not write");
  await closeInfo();
  assert.deepEqual(await fingerprint(a.path), original);
  assert.equal(
    (await snapshot()).tracks.find((t) => t.id === a.id).title,
    "UI A",
  );
  await openInfo(a.id);
  await dialog.getByLabel("Year", { exact: true }).fill("1e2");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("whole number");
  assert.deepEqual(await fingerprint(a.path), original);
  const values = {
    Title: "UI edited title",
    Artist: "UI edited artist",
    Album: "UI edited album",
    "Album Artist": "UI album artist",
    Composer: "UI composer",
    Genre: "Jazz",
    Year: "2026",
    "Track number": "3",
    "Track total": "12",
    "Disc number": "1",
    "Disc total": "2",
    BPM: "123",
  };
  for (const [label, value] of Object.entries(values))
    await dialog.getByLabel(label, { exact: true }).fill(value);
  const review = path.resolve(".impeccable/review");
  await mkdir(review, { recursive: true });
  await page.screenshot({ path: path.join(review, "metadata-editor.png") });
  // Hold only the IPC reply: this observes duplicate-submit protection without bypassing the edit.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("metadata:edit");
    if (!original) throw new Error("Production metadata handler missing");
    globalThis.metadataUIOriginalHandler = original;
    globalThis.metadataUICalls = 0;
    ipcMain.removeHandler("metadata:edit");
    ipcMain.handle("metadata:edit", async (...args) => {
      globalThis.metadataUICalls++;
      const result = await original(...args);
      await new Promise((resolve) => {
        globalThis.metadataUIReply = resolve;
      });
      return result;
    });
  });
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(
    dialog.getByRole("button", { name: "Saving…", exact: true }),
  ).toBeDisabled();
  await expect(
    dialog.getByRole("button", { name: "Cancel", exact: true }),
  ).toBeDisabled();
  await dialog.locator("form").evaluate((form) => {
    form.requestSubmit();
    form.requestSubmit();
  });
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.metadataUIReply))
    .toBe("function");
  assert.equal(await app.evaluate(() => globalThis.metadataUICalls), 1);
  await app.evaluate(({ ipcMain }) => {
    globalThis.metadataUIReply();
    ipcMain.removeHandler("metadata:edit");
    ipcMain.handle("metadata:edit", globalThis.metadataUIOriginalHandler);
  });
  await expect(dialog).toHaveCount(0);
  let after = await snapshot(),
    edited = after.tracks.find((t) => t.id === a.id);
  assert.equal(edited.path, a.path);
  assert.equal(edited.favorite, true);
  assert.deepEqual(after.playlists[0].trackIds, [a.id, b.id]);
  assert.deepEqual(after.state.queue, [a.id, b.id]);
  assert.equal(after.state.currentId, null);
  assert.equal(edited.comments, "Preserve this comment");
  const strategy = await app.evaluate((_, modules) => {
    const require = process
      .getBuiltinModule("module")
      .createRequire(modules.playback);
    const l = require(modules.playback).playbackUse.currentLibrary;
    const j = JSON.parse(
      l.db
        .prepare(
          "SELECT journal FROM metadata_edits WHERE phase='done' ORDER BY createdAt DESC LIMIT 1",
        )
        .get().journal,
    );
    return {
      strategy: j.strategy || "staged",
      filename: j.filename,
      record: !!j.record,
      capability:
        process.platform === "darwin"
          ? require(
              process
                .getBuiltinModule("path")
                .join(
                  process.getBuiltinModule("path").dirname(modules.metadata),
                  "publication.js",
                ),
            )
              .publicationNativeBinding()
              .metadataSupport({
                root: j.root.path,
                rootIdentity: {
                  device: j.root.device,
                  inode: j.root.inode,
                  type: "directory",
                },
                relative: j.relative,
              })
          : null,
    };
  }, modules);
  if (media) {
    assert.equal(strategy.strategy, "in-place");
    assert.equal(strategy.record, false);
    assert.equal(strategy.capability.ownershipEnabled, false);
    assert(a.path.startsWith(media + path.sep));
  } else assert.equal(strategy.strategy, "staged");
  assert.deepEqual(
    [
      edited.year,
      edited.track,
      edited.trackTotal,
      edited.disc,
      edited.discTotal,
      edited.bpm,
    ],
    [2026, 3, 12, 1, 2, 123],
  );
  await expect(row(a.id)).toContainText("UI edited title");
  await expect(row(a.id)).toContainText("UI edited artist");
  const file = await parseFile(a.path);
  assert.equal(file.common.title, "UI edited title");
  assert.equal(file.common.composer[0], "UI composer");
  assert.deepEqual(file.common.track, { no: 3, of: 12 });
  assert.deepEqual(file.common.disk, { no: 1, of: 2 });
  assert.equal(file.common.bpm, 123);
  await page
    .getByRole("searchbox", { name: "Search library" })
    .fill("UI edited title");
  await expect(row(a.id)).toBeVisible();
  await page.getByRole("searchbox", { name: "Search library" }).fill("");
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await expect(
    page.getByText("UI edited album", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await expect(
    page.getByText("UI edited artist", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  await openInfo(a.id);
  await dialog
    .getByLabel("Comments", { exact: true })
    .fill("UI edited comments");
  await save();
  assert.equal(
    (await parseFile(a.path)).common.comment[0].text,
    "UI edited comments",
  );
  await openInfo(a.id);
  await dialog.getByLabel("Comments", { exact: true }).fill("");
  await save();
  assert.equal((await parseFile(a.path)).common.comment?.length ?? 0, 0);
  async function play(id) {
    await row(id)
      .getByRole("button", { name: /^Play / })
      .click();
    await page.waitForFunction(
      (id) => {
        const audio = document.querySelector("audio");
        return (
          audio.currentSrc &&
          new URL(audio.currentSrc).pathname.slice(1) === id &&
          !audio.paused &&
          audio.readyState >= 3 &&
          audio.currentTime > 0.2
        );
      },
      id,
      { timeout: 15000 },
    );
  }
  await play(a.id);
  const beforeFailure = await fingerprint(a.path);
  await openInfo(a.id);
  await expect(dialog.getByRole("status")).toContainText("loaded for playback");
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  assert.equal((await request(a.id, titlePatch("Blocked active"))).ok, false);
  await closeInfo();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await openInfo(a.id);
  await expect(dialog.getByRole("status")).toContainText("loaded for playback");
  assert.equal((await request(a.id, titlePatch("Blocked paused"))).ok, false);
  await closeInfo();
  assert.deepEqual(await fingerprint(a.path), beforeFailure);
  await play(b.id);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            ({ id, session }) => window.rio.metadataEligibility(id, session),
            { id: a.id, session },
          )
        ).editable,
    )
    .toBe(true);
  await openInfo(a.id);
  await dialog.getByLabel("Title", { exact: true }).fill("UI released edit");
  await save();
  assert.equal((await parseFile(a.path)).common.title, "UI released edit");
  // A real decoder error fully releases B while its queue/current references
  // remain. Restoring our generated bytes must permit a UI edit, without an
  // artificial idle declaration or clearing saved player state.
  await play(a.id);
  const bBytes = await readFile(b.path);
  await writeFile(b.path, "invalid generated FLAC");
  await row(b.id)
    .getByRole("button", { name: /^Play / })
    .click();
  await page.locator(".notice.error").waitFor();
  await expect(page.locator("audio")).not.toHaveAttribute("src");
  await writeFile(b.path, bBytes);
  await expect
    .poll(
      async () =>
        (
          await page.evaluate(
            ({ id, session }) => window.rio.metadataEligibility(id, session),
            { id: b.id, session },
          )
        ).editable,
    )
    .toBe(true);
  await expect.poll(async () => (await snapshot()).state.currentId).toBe(b.id);
  const releasedState = (await snapshot()).state;
  assert.equal(releasedState.currentId, b.id);
  assert(releasedState.queue.includes(b.id));
  await openInfo(b.id);
  await dialog
    .getByLabel("Genre", { exact: true })
    .fill("Released queue reference");
  await save();
  assert.equal(
    (await parseFile(b.path)).common.genre[0],
    "Released queue reference",
  );
  assert.equal((await snapshot()).state.currentId, b.id);
  assert.equal(await page.locator("audio").getAttribute("src"), null);
  // Save-time write access can disappear after advisory eligibility.
  // Exercise the production error/diagnostic path without corrupting any file.
  if (media) {
    await openInfo(a.id);
    await dialog
      .getByLabel("Title", { exact: true })
      .fill("Unwritable must fail");
    const before = await fingerprint(a.path),
      mode = (await stat(a.path)).mode;
    await chmod(a.path, 0o444);
    try {
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect(dialog.getByRole("alert")).toContainText("Reference:");
      assert.deepEqual(await fingerprint(a.path), before);
      const entries = (
        await readFile(path.join(profile, "metadata-edit-errors.log"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse);
      const diagnostic = entries.at(-1);
      assert.match(diagnostic.error, /writable metadata target|read only/i);
      assert(
        (await dialog.getByRole("alert").innerText()).includes(
          diagnostic.reference,
        ),
      );
    } finally {
      await chmod(a.path, mode & 0o777);
    }
    await closeInfo();
  }
  // Race: eligibility is advisory. Save revalidates real ownership after the dialog opens.
  await openInfo(a.id);
  await dialog.getByLabel("Title", { exact: true }).fill("Must fail safely");
  const lease = await page.evaluate(
    ({ id, directory }) => window.rio.acquirePlayback(id, directory),
    { id: a.id, directory },
  );
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("loaded for playback");
  assert.equal((await parseFile(a.path)).common.title, "UI released edit");
  await page.evaluate(
    (token) => window.rio.releasePlayback(token),
    lease.token,
  );
  await closeInfo();
  for (const id of [reference.id, other.id]) {
    await openInfo(id);
    await expect(dialog.getByRole("status")).toContainText("managed FLAC");
    await expect(dialog.locator("input")).toHaveCount(0);
    await expect(
      dialog.getByRole("button", { name: "Save", exact: true }),
    ).toHaveCount(0);
    await closeInfo();
  }
  await page.evaluate(() =>
    window.rio.saveMediaSettings({ keepOrganized: true }),
  );
  await openInfo(a.id);
  await expect(dialog.getByRole("status")).toContainText(
    "Keep Rio Media organized",
  );
  await closeInfo();
  assert.equal(
    (await request(a.id, titlePatch("Organized must reject"))).ok,
    false,
  );
  await page.evaluate(() =>
    window.rio.saveMediaSettings({ keepOrganized: false }),
  );
  assert.equal((await request("invalid", titlePatch("Invalid"))).ok, false);
  assert.equal(
    (await request("a".repeat(64), titlePatch("Missing"))).ok,
    false,
  );
  assert.equal(
    (await request(a.id, titlePatch("Stale"), "stale-session")).ok,
    false,
  );
  assert.equal(
    (
      await request(a.id, {
        title: { action: "set", value: "bad", path: "/tmp/forged" },
      })
    ).ok,
    false,
  );
  // A second renderer at the same trusted URL still has no metadata authority.
  const untrusted = await app.evaluate(
    async ({ BrowserWindow }, { modules, id, session }) => {
      const foreign = new BrowserWindow({
        show: false,
        webPreferences: {
          preload: modules.preload,
          contextIsolation: true,
          sandbox: true,
        },
      });
      try {
        await foreign.loadURL("rio://app/index.html");
        return await foreign.webContents.executeJavaScript(
          `window.rio.editTrackMetadata(${JSON.stringify(id)}, ${JSON.stringify(session)}, {title:{action:"set",value:"Foreign renderer"}}).then(() => "unexpected success", error => String(error))`,
        );
      } finally {
        foreign.destroy();
      }
    },
    { modules, id: a.id, session },
  );
  assert.match(untrusted, /Untrusted metadata request/);
  // Unsupported HFS+ (or tmpfs on Linux) still fails closed.
  unsupportedVolume = await unsupportedMetadataVolume(root);
  const unsupportedLibrary = path.join(root, "Unsupported library");
  await mkdir(path.join(unsupportedVolume.directory, "Rio Media"));
  const bad = await app.evaluate(
    async (_, { modules, directory, media, source }) => {
      const require = process
          .getBuiltinModule("module")
          .createRequire(modules.library),
        { Library } = require(modules.library);
      const l = await Library.open(directory, { setupMediaRoot: true });
      try {
        await l.chooseMediaRoot(media);
        l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
        const result = await l.add([source]);
        if (result.errors.length) throw new Error(result.errors.join("\n"));
        l.saveState({ ...l.state(), view: "Songs" });
        return l.tracks()[0];
      } finally {
        l.close();
      }
    },
    {
      modules,
      directory: unsupportedLibrary,
      media: path.join(unsupportedVolume.directory, "Rio Media"),
      source: externalA,
    },
  );
  async function selectLibrary(directory) {
    await app.evaluate(({ dialog, Menu }, directory) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
      Menu.getApplicationMenu()
        .items.find((i) => i.label === "File")
        .submenu.items.find((i) => i.label === "Choose Library…")
        .click();
    }, directory);
    await expect
      .poll(async () => (await snapshot()).libraryPath)
      .toBe(directory);
    await expect(page.locator(".song-row").first()).toBeVisible();
  }
  await selectLibrary(unsupportedLibrary);
  await openInfo(bad.id);
  await expect(dialog.getByRole("status")).toContainText(
    "unavailable on this volume",
  );
  await expect(
    dialog.getByRole("button", { name: "Save", exact: true }),
  ).toHaveCount(0);
  await closeInfo();
  // Simulate a previously cached eligible reply. Only advisory presentation is
  // overridden; the following Save uses the exact real production IPC handler,
  // coordinator, worker and native rejection on this genuinely unsupported FS.
  await app.evaluate(({ ipcMain }) => {
    const original = ipcMain._invokeHandlers.get("metadata:eligibility");
    globalThis.metadataUIEligibilityHandler = original;
    ipcMain.removeHandler("metadata:eligibility");
    ipcMain.handle("metadata:eligibility", async (...args) => {
      const result = await original(...args);
      if (
        result.editable ||
        !result.message.includes("unavailable on this volume")
      )
        throw new Error("Expected real filesystem-policy rejection");
      return { editable: true };
    });
  });
  await openInfo(bad.id);
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("metadata:eligibility");
    ipcMain.handle(
      "metadata:eligibility",
      globalThis.metadataUIEligibilityHandler,
    );
  });
  const badBefore = await fingerprint(bad.path);
  await dialog.getByLabel("Genre", { exact: true }).fill("Jazz & Fusion");
  await dialog.getByRole("button", { name: "Save", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText(
    "unavailable on this volume",
  );
  await expect(dialog.getByRole("alert")).toContainText("Reference:");
  assert.deepEqual(await fingerprint(bad.path), badBefore);
  const diagnostics = (
    await readFile(path.join(profile, "metadata-edit-errors.log"), "utf8")
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  const diagnostic = diagnostics.at(-1);
  assert(diagnostic.error.includes(`${unsupportedVolume.reason}`));
  assert(
    (await dialog.getByRole("alert").innerText()).includes(
      diagnostic.reference,
    ),
  );
  const unchanged = await snapshot();
  assert.equal(unchanged.tracks[0].id, bad.id);
  assert.equal(unchanged.tracks[0].path, bad.path);
  assert.equal(unchanged.tracks[0].genre, bad.genre);
  await app.evaluate((_, modules) => {
    const require = process
        .getBuiltinModule("module")
        .createRequire(modules.playback),
      { playbackUse } = require(modules.playback);
    const row = playbackUse.currentLibrary.db
      .prepare(
        "SELECT phase,journal FROM metadata_edits ORDER BY createdAt DESC LIMIT 1",
      )
      .get();
    if (row && (row.phase !== "aborted" || JSON.parse(row.journal).record))
      throw new Error(
        "Unsupported-volume Save must abort before publication, preserving original authority",
      );
  }, modules);
  await closeInfo();
  await selectLibrary(directory);
  const resources = await app.evaluate(
    async (_, { modules, packaged }) => {
      const require = process
          .getBuiltinModule("module")
          .createRequire(modules.library),
        path = process.getBuiltinModule("path"),
        fs = process.getBuiltinModule("fs"),
        assert = process.getBuiltinModule("assert/strict"),
        { createHash } = process.getBuiltinModule("crypto");
      const inspector = new (process.getBuiltinModule("inspector").Session)(),
        executed = [];
      inspector.connect();
      inspector.on("Debugger.scriptParsed", (e) => executed.push(e.params.url));
      try {
        await new Promise((resolve, reject) =>
          inspector.post("Debugger.enable", (error) =>
            error ? reject(error) : resolve(),
          ),
        );
      } finally {
        inspector.disconnect();
      }
      const { fileURLToPath } = process.getBuiltinModule("url");
      for (const entry of [
        modules.library,
        modules.metadata,
        modules.editor,
        modules.playback,
        modules.publication,
      ])
        assert(
          executed.some(
            (url) => url.startsWith("file:") && fileURLToPath(url) === entry,
          ),
          `Module must already be loaded by production path: ${entry}`,
        );
      const { playbackUse } = require(modules.playback),
        l = playbackUse.currentLibrary;
      assert.equal(
        l.db
          .prepare(
            "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
          )
          .get().n,
        0,
      );
      const native = require.resolve(
        path.join(path.dirname(modules.main), "../native/publication.node"),
      );
      assert(require.cache[native]?.loaded);
      const binary = packaged
        ? path.join(
            process.resourcesPath,
            "app.asar.unpacked/dist/native/publication.node",
          )
        : native;
      const manifest = require(
        path.join(path.dirname(native), "publication-build.json"),
      );
      assert.equal(manifest.testing, false);
      assert.equal(manifest.platform, process.platform);
      assert.equal(manifest.arch, process.arch);
      assert.equal(
        createHash("sha256").update(fs.readFileSync(binary)).digest("hex"),
        manifest.sha256,
      );
      assert(
        globalThis.metadataUIWorkers.some(
          (w) => w.mode === "prepare" && w.ok && w.backend === "emscripten",
        ),
      );
      assert(
        globalThis.metadataUIWorkers.some((w) => w.mode === "verify" && w.ok),
      );
      const taglib = process
        .getBuiltinModule("module")
        .createRequire(modules.worker)
        .resolve("taglib-wasm");
      assert(
        taglib.startsWith(require("electron").app.getAppPath() + path.sep),
      );
      return {
        executed: executed.filter(
          (url) =>
            url.startsWith("file:") &&
            Object.values(modules).includes(fileURLToPath(url)),
        ),
        workers: globalThis.metadataUIWorkers,
        native: binary,
        manifest,
        taglib,
        wasm: path.join(path.dirname(taglib), "taglib-web.wasm"),
      };
    },
    { modules, packaged },
  );
  for (const [file, before] of originals)
    assert.deepEqual(await fingerprint(file), before);
  // Restart proves file/database persistence, not only a patched visible form.
  await app.close();
  app = undefined;
  const restarted = await launch(profile);
  await restarted.waitForSelector(".song-row");
  after = await restarted.evaluate(() => window.rio.snapshot());
  edited = after.tracks.find((t) => t.id === a.id);
  assert.equal(edited.title, "UI released edit");
  assert.equal(edited.path, a.path);
  assert.equal(edited.artist, "UI edited artist");
  assert.equal(edited.album, "UI edited album");
  assert.equal(edited.albumArtist, "UI album artist");
  assert.equal(edited.composer, "UI composer");
  assert.equal(edited.genre, "Jazz");
  assert.deepEqual(after.playlists[0].trackIds, [a.id, b.id]);
  for (const [file, before] of originals)
    assert.deepEqual(await fingerprint(file), before);
  console.log(
    JSON.stringify(
      {
        passed: true,
        packaged,
        provenance,
        resources,
        publication: strategy,
        mediaParent,
        checks: [
          "real Track Info/save/cancel/numeric validation/clear/unchanged fields",
          "duplicate Save and visible saving state",
          "same ID/path and playlist/favourite/queue/current persistence",
          "global Songs/Albums/Artists/search refresh and restart",
          "active/paused rejection; release permits edit; eligibility race fails safely",
          "real decoder release permits UI Save with queue/current references retained",
          "real unsupported volume is read-only; stale advisory UI Save retains authority and logs exact native cause",
          "reference/non-FLAC/organized read-only; malformed/stale IPC rejected",
          "packaged/source main/preload/renderer/coordinator/worker/native provenance",
          "unchanged external bytes/mtimes",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await unsupportedVolume?.close();
  await localVolume?.close();
  if (externalFixture)
    await rm(externalFixture, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
}
