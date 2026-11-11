import { MAX_FLAC_FILE_BYTES } from "../src/shared/flac-limits.ts";
// Real Songs cell -> preload -> existing production metadata IPC/coordinator.
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
  link,
  unlink,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { parseFile } from "music-metadata";
import {
  playbackFlacFixture,
  inspectFlac,
  block,
  commentBlock,
} from "../tests/metadata-fixtures.ts";
import { wavFixture } from "../tests/fixtures.ts";
import { resolvePublicationPackage } from "./lib/publication-package.mjs";
import { localMetadataVolume } from "./lib/local-metadata-volume.mjs";
import { heldInlineInteraction } from "./lib/inline-initial.mjs";
const historicalTimingBaseline = process.argv.includes(
  "--historical-timing-baseline",
);
if (historicalTimingBaseline) {
  console.warn(
    "Running the historical inline timing baseline with reduced acceptance coverage.",
  );
} else if (process.env.RIO_METADATA_TIMING_BASELINE === "1") {
  console.warn(
    "Ignoring RIO_METADATA_TIMING_BASELINE. Normal inline acceptance checks are enabled.",
  );
}
const packaged =
  !!process.env.RIO_EXECUTABLE || process.argv.includes("--packaged");
const bundle =
  packaged && !process.env.RIO_EXECUTABLE
    ? await resolvePublicationPackage()
    : null;
const executable = process.env.RIO_EXECUTABLE || bundle?.executable;
const root = await realpath(
  await mkdtemp(
    path.join(
      process.env.RIO_INLINE_TEST_PARENT || tmpdir(),
      "rio-inline-metadata-",
    ),
  ),
);
const profile = path.join(root, "Profile"),
  directory = path.join(root, "Library");
let app, volume;
const proof = async (filename) => ({
  sha: createHash("sha256")
    .update(await readFile(filename))
    .digest("hex"),
  mtime: (await stat(filename)).mtimeMs,
});
async function installControls() {
  await app.evaluate(({ ipcMain, dialog, Menu }, directory) => {
    globalThis.inlinePlaybackSamples = [];
    const acquire = ipcMain._invokeHandlers.get("playback:acquire");
    ipcMain.removeHandler("playback:acquire");
    ipcMain.handle("playback:acquire", async (...args) => {
      const started = performance.now();
      const result = await acquire(...args);
      globalThis.inlinePlaybackSamples.push({
        id: args[1],
        wallMs: performance.now() - started,
      });
      return result;
    });
    const workers = process.getBuiltinModule("worker_threads");
    const once = workers.Worker.prototype.once;
    const heldWorkers = new WeakMap();
    workers.Worker.prototype.once = function (name, listener) {
      const held = heldWorkers.get(this);
      if (name === "exit" && held)
        return once.call(this, name, (...args) => {
          // A worker may exit naturally after posting the held reply.
          if (held.released) listener.apply(this, args);
          else held.exit = () => listener.apply(this, args);
        });
      if (name !== "message" || !globalThis.inlineHoldWorker)
        return once.call(this, name, listener);
      globalThis.inlineHoldWorker = false;
      const state = { released: false };
      heldWorkers.set(this, state);
      return once.call(this, name, (...args) => {
        globalThis.inlineReleaseWorker = () => {
          state.released = true;
          listener.apply(this, args);
          state.exit?.();
        };
      });
    };
    globalThis.inlineCalls = [];
    const eligibility = ipcMain._invokeHandlers.get("metadata:eligibility");
    ipcMain.removeHandler("metadata:eligibility");
    ipcMain.handle("metadata:eligibility", async (...args) => {
      const result = await eligibility(...args);
      if (globalThis.inlineEligibilityHold)
        await new Promise((resolve) => {
          globalThis.inlineEligibilityRelease = resolve;
        });
      return result;
    });
    const original = ipcMain._invokeHandlers.get("metadata:edit");
    ipcMain.removeHandler("metadata:edit");
    ipcMain.handle("metadata:edit", async (...args) => {
      const call = {
        id: args[1],
        session: args[2],
        patch: structuredClone(args[3]),
      };
      globalThis.inlineCalls.push(call);
      let last = performance.now(),
        maxGap = 0;
      const loop = { maxGapMs: 0 };
      globalThis.inlineMainLoop = loop;
      const sample = () => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        loop.maxGapMs = maxGap;
        last = now;
      };
      const timer = setInterval(sample, 5);
      const result = await original(...args).finally(() => {
        clearInterval(timer);
        sample();
        if (process.env.RIO_METADATA_TIMING === "1") {
          console.info(
            "RIO_METADATA_LOOP",
            JSON.stringify({ maxSampleGapMs: maxGap }),
          );
        }
      });
      if (!result.ok) call.diagnosticId = result.diagnosticId;
      if (globalThis.inlineHold)
        await new Promise((resolve) => {
          globalThis.inlineRelease = resolve;
        });
      return result;
    });
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [directory],
    });
    Menu.prototype.popup = function () {
      globalThis.inlineMenu = this;
    };
  }, directory);
}
async function launch() {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    ...(packaged ? { cwd: root } : {}),
    env: { ...process.env, RIO_DATA_DIR: profile },
    timeout: 30000,
  });
  if (process.env.RIO_INLINE_DIAGNOSTICS === "1")
    app.process().stderr.on("data", (chunk) => process.stderr.write(chunk));
  const page = await app.firstWindow();
  await installControls();
  await page.waitForSelector("h1");
  // Compare the resources actually served to this window with this build.
  // This checks the initial renderer, CSS, preload and main, not just the addon.
  const provenance = await app.evaluate(({ app }) => {
    const fs = process.getBuiltinModule("fs"),
      path = process.getBuiltinModule("path"),
      crypto = process.getBuiltinModule("crypto");
    const renderer = path.join(app.getAppPath(), "dist/renderer/assets");
    const files = fs
      .readdirSync(renderer)
      .filter((name) => /\.(js|css)$/.test(name))
      .map((name) => "dist/renderer/assets/" + name);
    files.push(
      "dist/renderer/index.html",
      "dist/main/main.js",
      "dist/main/preload.cjs",
    );
    return {
      packaged: app.isPackaged,
      files: files.map((file) => ({
        file,
        sha: crypto
          .createHash("sha256")
          .update(fs.readFileSync(path.join(app.getAppPath(), file)))
          .digest("hex"),
      })),
    };
  });
  assert.equal(provenance.packaged, packaged);
  for (const resource of provenance.files)
    assert.equal(
      createHash("sha256")
        .update(await readFile(resource.file))
        .digest("hex"),
      resource.sha,
      `Stale application resource: ${resource.file}`,
    );
  const loaded = await page.evaluate(async () => {
    const urls = [
      ...document.querySelectorAll('script[src],link[rel="stylesheet"]'),
    ].map((element) => element.src || element.href);
    return Promise.all(
      urls.map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error("Renderer resource unavailable");
        const hash = await crypto.subtle.digest(
          "SHA-256",
          await response.arrayBuffer(),
        );
        return {
          file: "dist/renderer" + new URL(url).pathname,
          sha: [...new Uint8Array(hash)]
            .map((byte) => byte.toString(16).padStart(2, "0"))
            .join(""),
        };
      }),
    );
  });
  assert.equal(loaded.length, 2);
  for (const resource of loaded)
    assert.deepEqual(
      resource,
      provenance.files.find((file) => file.file === resource.file),
    );
  console.log("RIO_INLINE_RESOURCES", JSON.stringify(provenance));
  if (process.env.RIO_METADATA_TIMING === "1") {
    createInterface({ input: app.process().stdout }).on("line", (line) => {
      if (line.startsWith("RIO_METADATA_")) console.error(line);
    });
    page.on("console", (message) => {
      if (message.text().startsWith("RIO_METADATA_"))
        console.error(message.text());
    });
    await page.evaluate(() => {
      sessionStorage.setItem("rio:metadata-timing", "1");
      let started = 0;
      document.addEventListener(
        "keydown",
        (event) => {
          if (
            event.key === "Enter" &&
            event.target.matches(".inline-metadata-input")
          )
            started = performance.now();
        },
        true,
      );
      new MutationObserver(() => {
        if (started && !document.querySelector(".inline-metadata-input")) {
          console.info(
            "RIO_METADATA_TABLE",
            JSON.stringify({ keyToDomMs: performance.now() - started }),
          );
          started = 0;
        }
      }).observe(document.body, { childList: true, subtree: true });
    });
  }
  return page;
}
async function run() {
  await mkdir(profile);
  if (process.argv.includes("--noowners"))
    volume = await localMetadataVolume(root);
  const media = volume ? path.join(volume.directory, "Rio Media") : null;
  if (media) await mkdir(media);
  const sources = [
    path.join(root, "A.flac"),
    path.join(root, "B.flac"),
    path.join(root, "Reference.flac"),
    path.join(root, "Other.wav"),
  ];
  // Optional independently encoded, disposable audio for real-storage diagnostics.
  // Default CI fixtures remain self-contained and need no global encoder.
  const audioFixture = process.env.RIO_INLINE_AUDIO_FIXTURE
    ? inspectFlac(await readFile(process.env.RIO_INLINE_AUDIO_FIXTURE))
    : null;
  for (let i = 0; i < 3; i++) {
    const entries = [
      ["TITLE", ["Alpha", "Beta", "Reference"][i]],
      ["ARTIST", "Original artist"],
      ["ALBUM", "Original album"],
      ["DATE", String(2026 + i)],
      ["TRACKNUMBER", "2"],
      ["COMMENT", "Keep comments"],
    ];
    await writeFile(
      sources[i],
      audioFixture && i === 0
        ? Buffer.concat([
            Buffer.from("fLaC"),
            ...audioFixture.blocks.map((b, index) =>
              block(
                b.type,
                b.type === 4 ? commentBlock(entries) : b.body,
                index === audioFixture.blocks.length - 1,
              ),
            ),
            audioFixture.audio,
          ])
        : playbackFlacFixture(
            entries,
            i === 0 && process.env.RIO_METADATA_TIMING === "1" ? 120 : 30,
          ),
    );
  }
  const fixtureBytes = (await stat(sources[0])).size;
  assert(fixtureBytes <= MAX_FLAC_FILE_BYTES);
  assert.equal((await parseFile(sources[0])).format.container, "FLAC");
  console.log("RIO_INLINE_FIXTURE", JSON.stringify({ bytes: fixtureBytes }));
  await writeFile(
    sources[3],
    wavFixture({ title: "Other format", seconds: 30 }),
  );
  const originals = await Promise.all(sources.map(proof));
  let page = await launch();
  const fixture = await app.evaluate(
    async (
      { app, dialog, Menu, ipcMain },
      { packaged, directory, sources, media },
    ) => {
      const assert = process.getBuiltinModule("assert/strict"),
        path = process.getBuiltinModule("path");
      assert.equal(app.isPackaged, packaged);
      if (packaged)
        assert.equal(
          app.getAppPath(),
          path.join(process.resourcesPath, "app.asar"),
        );
      const libraryPath = path.join(app.getAppPath(), "dist/domain/library.js");
      const require = process
        .getBuiltinModule("module")
        .createRequire(libraryPath);
      const { Library } = require(libraryPath);
      const l = await Library.open(directory, { setupMediaRoot: true });
      let tracks;
      try {
        if (media) await l.chooseMediaRoot(media);
        l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
        const added = await l.add([sources[0], sources[1], sources[3]]);
        assert.deepEqual(added.errors, []);
        l.saveMediaSettings({ copyOnAdd: false });
        await l.add([sources[2]]);
        tracks = l.tracks();
        const a = tracks.find((t) => t.title === "Alpha"),
          b = tracks.find((t) => t.title === "Beta");
        l.favorite(a.id);
        l.createPlaylist("Inline references", [a.id, b.id]);
        l.saveState({ ...l.state(), view: "Songs", queue: [a.id, b.id] });
      } finally {
        l.close();
      }
      Menu.getApplicationMenu()
        .items.find((i) => i.label === "File")
        .submenu.items.find((i) => i.label === "Choose Library…")
        .click();
      return { tracks, libraryPath };
    },
    { packaged, directory, sources, media },
  );
  const a = fixture.tracks.find((t) => t.title === "Alpha"),
    b = fixture.tracks.find((t) => t.title === "Beta"),
    reference = fixture.tracks.find((t) => t.title === "Reference"),
    other = fixture.tracks.find((t) => t.title === "Other format");
  await page.waitForSelector(".song-row");
  const row = (id) => page.locator(`.song-row[data-track-id="${id}"]`);
  const cell = (id, column) =>
    row(id).locator(`[role="cell"][data-cell-column="${column}"]`);
  const input = () => page.locator(".inline-metadata-input");
  const snap = () => page.evaluate(() => window.rio.snapshot());
  const count = () => app.evaluate(() => globalThis.inlineCalls.length);
  function managedReceipt() {
    const db = new DatabaseSync(path.join(directory, "rio.sqlite"), {
      readOnly: true,
    });
    try {
      return db
        .prepare("SELECT * FROM managed_file_receipts WHERE trackId=?")
        .get(a.id);
    } finally {
      db.close();
    }
  }
  async function refusedSave(submit) {
    const before = await proof(a.path);
    const info = await stat(a.path, { bigint: true });
    const receipt = managedReceipt();
    assert.equal(receipt.digest, before.sha);
    assert.equal(receipt.device, String(info.dev));
    assert.equal(receipt.inode, String(info.ino));
    assert.equal(info.nlink, 1n);
    const calls = await count();
    const linux = process.platform === "linux";
    const alias = path.join(
      path.dirname(a.path),
      ".rio-inline-staging-refusal",
    );
    // Linux exchanges directory entries even when the target is mode 0444.
    // An extra link to this disposable file triggers the native staging guard.
    if (linux) await link(a.path, alias);
    else await chmod(a.path, 0o444);
    try {
      if (linux) assert.equal((await stat(a.path)).nlink, 2);
      await submit();
      assert.equal(await count(), calls + 1);
      const reference = await app.evaluate(
        () => globalThis.inlineCalls.at(-1).diagnosticId,
      );
      assert.match(reference, /^[a-f0-9]{8}$/);
      const diagnostic = (
        await readFile(path.join(profile, "metadata-edit-errors.log"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse)
        .find((entry) => entry.reference === reference);
      assert.equal(diagnostic?.trackId, a.id);
      assert.match(
        diagnostic.error,
        linux
          ? /^Publication staging failed: Metadata target has unexpected hard links/
          : /Opening writable metadata target|Metadata target is read only/i,
      );
      assert.deepEqual(managedReceipt(), receipt);
      assert.deepEqual(await proof(a.path), before);
      const current = await stat(a.path, { bigint: true });
      assert.equal(current.dev, info.dev);
      assert.equal(current.ino, info.ino);
      assert.deepEqual(await proof(sources[0]), originals[0]);
      console.log("RIO_INLINE_SAVE_REFUSED", diagnostic.error);
      return reference;
    } finally {
      if (linux) await unlink(alias);
      else await chmod(a.path, Number(info.mode & 0o7777n));
    }
  }
  const releaseSaveReply = () =>
    app.evaluate(() => {
      globalThis.inlineHold = false;
      globalThis.inlineRelease?.();
    });
  async function begin(id, column) {
    await cell(id, column).dblclick();
    await expect(input()).toBeVisible();
    await expect(input()).not.toHaveAttribute("readonly", "");
    await expect(input()).toBeFocused();
    assert.equal(
      await input().locator("..").locator("..").getAttribute("data-track-id"),
      id,
    );
  }
  async function commit() {
    await input().press("Enter");
    await expect(input()).toHaveCount(0);
    await waitSaved();
  }
  async function waitSaved() {
    await expect(quietStatus.locator('[role="status"]')).not.toContainText(
      "Saving metadata",
    );
  }
  let quietStatus = page.locator("#inline-metadata-status");
  async function expectQuietEditing() {
    await expect(
      page.getByText(
        "Double-click FLAC metadata to edit · Use Play to listen",
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(quietStatus.locator('[role="status"]')).toHaveClass(
      "inline-metadata-accessible",
    );
    assert.equal(
      await quietStatus.evaluate(
        (element) => element.getBoundingClientRect().height,
      ),
      0,
    );
    await expect(quietStatus.locator('[role="alert"]')).toHaveCount(0);
    await expect(page.locator(".inline-metadata-marker")).toHaveCount(0);
  }
  {
    await mkdir(path.resolve(".impeccable/review"), { recursive: true });
    const initialState = (await snap()).state;
    async function resetPlayback() {
      await page.evaluate((state) => window.rio.saveState(state), initialState);
      const session = (await snap()).metadataSession;
      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          .items.find((i) => i.label === "File")
          .submenu.items.find((i) => i.label === "Choose Library…")
          .click(),
      );
      await expect
        .poll(async () => (await snap()).metadataSession)
        .not.toBe(session);
      await expect(page.locator("audio")).not.toHaveAttribute("src", /.+/);
    }
    for (const key of ["Enter", "Tab", "Shift+Tab"]) {
      await heldInlineInteraction({
        page,
        app,
        track: a,
        other: b,
        key,
        packaged,
        label: key === "Enter" ? "first-launch" : `subsequent-${key}`,
      });
      await resetPlayback();
      await expectQuietEditing();
    }
    await app.close();
    app = undefined;
    page = await launch();
    quietStatus = page.locator("#inline-metadata-status");
    await page.waitForSelector(".song-row");
    for (const key of ["Tab", "Shift+Tab", "Enter"]) {
      await heldInlineInteraction({
        page,
        app,
        track: a,
        other: b,
        key,
        packaged,
        label: key === "Tab" ? "first-reopen" : `subsequent-reopen-${key}`,
      });
      await resetPlayback();
      await expectQuietEditing();
    }
    await app.evaluate(() => {
      globalThis.inlineCalls = [];
    });
  }
  if (process.argv.includes("--initial-only")) {
    for (let i = 0; i < sources.length; i++)
      assert.deepEqual(await proof(sources[i]), originals[i]);
    console.log(
      JSON.stringify({
        passed: true,
        packaged,
        initialOnly: true,
        fixtureBytes,
      }),
    );
    return;
  }
  await expectQuietEditing();
  const before = await proof(a.path);
  const originalState = (await snap()).state;
  await app.evaluate(() => {
    globalThis.inlineEligibilityHold = true;
  });
  await cell(a.id, "title").dblclick();
  await expect(input()).toHaveAttribute("aria-busy", "true");
  await input().press("Escape");
  await expect(input()).toHaveCount(0);
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.inlineEligibilityRelease))
    .toBe("function");
  await app.evaluate(() => {
    globalThis.inlineEligibilityHold = false;
    globalThis.inlineEligibilityRelease();
  });
  assert.equal(await count(), 0);
  await begin(a.id, "title");
  await input().fill("Cancelled");
  await input().press("Escape");
  assert.deepEqual(await proof(a.path), before);
  assert.equal(await count(), 0);
  await begin(a.id, "title");
  await commit();
  assert.equal(await count(), 0);
  assert.deepEqual(await proof(a.path), before);
  await begin(a.id, "title");
  await input().press("Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Artist");
  await expect(input()).toBeFocused();
  await expect(input()).not.toHaveAttribute("readonly", "");
  await input().press("Escape");
  assert.equal(await count(), 0);
  assert.deepEqual(await proof(a.path), before);
  await begin(a.id, "track");
  await input().fill("02");
  await commit();
  assert.equal(await count(), 0);
  await begin(a.id, "year");
  await input().fill("1e2");
  await input().press("Enter");
  await expect(input()).toHaveValue("1e2");
  await input().press("Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Year");
  await expect(input()).toBeFocused();
  await expect(page.getByRole("alert")).toContainText("whole number");
  assert.equal(await count(), 0);
  await page.getByRole("heading", { name: "Songs", exact: true }).click();
  await expect(input()).toBeVisible();
  await expect(input()).toHaveValue("1e2");
  await input().fill("2029");
  await input().press("Escape");
  assert.equal(await count(), 0);
  // Space/arrows are text editing, not playback/row selection.
  await begin(a.id, "title");
  await input().fill("Space");
  await input().press("Space");
  await input().press("ArrowDown");
  assert.equal(await page.locator("audio").getAttribute("src"), null);
  assert.equal(await row(a.id).getAttribute("aria-selected"), "true");
  await input().press("Escape");
  await begin(a.id, "genre");
  await input().fill("Double-click committed");
  await cell(b.id, "artist").dblclick();
  await expect(input()).toHaveCount(0);
  await waitSaved();
  assert.equal(await page.locator("audio").getAttribute("src"), null);
  // Hold the real worker. Focus must move while the coordinator still owns
  // the save, without a second write or eligibility check against its lock.
  await begin(a.id, "title");
  await expectQuietEditing();
  await input().fill("Zed inline");
  const navigationCalls = await count();
  const originalRowIndex = await row(a.id).getAttribute("aria-rowindex");
  await app.evaluate(() => {
    globalThis.inlineHoldWorker = true;
    globalThis.inlineReleaseWorker = undefined;
  });
  await page.evaluate(() => {
    let keyAt;
    window.inlineNavSamples = [];
    document.addEventListener(
      "keydown",
      (event) => {
        if (
          event.key === "Tab" &&
          event.target.matches(".inline-metadata-input")
        )
          keyAt = performance.now();
      },
      true,
    );
    document.addEventListener("focusin", (event) => {
      if (
        keyAt !== undefined &&
        event.target.matches(".inline-metadata-input")
      ) {
        window.inlineNavSamples.push(performance.now() - keyAt);
        keyAt = undefined;
      }
    });
  });
  await input().press("Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Artist");
  await expect(input()).toBeFocused();
  await expect(input()).toHaveAttribute("readonly", "");
  await expect(
    cell(a.id, "title").getByText("Saving…", { exact: true }),
  ).toHaveCount(0);
  await expectQuietEditing();
  await expect(quietStatus.locator('[role="status"]')).toContainText(
    "Saving metadata",
  );

  await expect
    .poll(() => app.evaluate(() => typeof globalThis.inlineReleaseWorker))
    .toBe("function");
  await input().press("Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Album");
  await input().press("Shift+Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Artist");
  await input().press("Enter");
  assert.equal(await count(), navigationCalls + 1);
  assert.equal((await parseFile(a.path)).common.title, "Alpha");
  await mkdir(path.resolve(".impeccable/review"), { recursive: true });
  await page.screenshot({
    path: path.resolve(".impeccable/review/inline-metadata-pending.png"),
  });
  console.log(
    "RIO_INLINE_NAVIGATION",
    JSON.stringify(await page.evaluate(() => window.inlineNavSamples)),
  );
  await app.evaluate(() => globalThis.inlineReleaseWorker());
  await expect(input()).not.toHaveAttribute("readonly", "");
  await expect(input()).toBeFocused();
  assert.equal(
    await input().locator("..").locator("..").getAttribute("data-track-id"),
    a.id,
  );
  assert.notEqual(
    await row(a.id).getAttribute("aria-rowindex"),
    originalRowIndex,
  );
  await expectQuietEditing();
  await input().fill("Inline artist");
  await input().press("Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Album");
  await input().press("Shift+Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Artist");
  await expect(input()).not.toHaveAttribute("readonly", "");
  await input().press("Escape");
  assert.equal((await parseFile(a.path)).common.title, "Zed inline");
  assert.equal((await parseFile(b.path)).common.title, "Beta");
  assert.equal(await row(a.id).getAttribute("aria-selected"), "true");
  // Every displayed supported column, including explicit clears.
  for (const [column, value] of [
    ["album", "Inline album"],
    ["genre", "Fusion"],
    ["disc", "3"],
    ["track", "7"],
    ["bpm", "125"],
    ["year", "2026"],
  ]) {
    await begin(a.id, column);
    await input().fill(value);
    await commit();
  }
  await begin(a.id, "bpm");
  await input().fill("");
  await commit();
  assert.equal((await parseFile(a.path)).common.bpm, undefined);
  assert.equal(
    (await parseFile(a.path)).common.comment[0].text,
    "Keep comments",
  );
  // Save + sort + cross-row Tab uses the pre-save target ID, never its index.
  await page.getByRole("button", { name: "Year", exact: true }).click();
  await begin(a.id, "year");
  await input().fill("2030");
  await input().press("Tab");
  await expect(input()).toHaveAttribute("aria-label", "Edit Title");
  assert.equal(
    await input().locator("..").locator("..").getAttribute("data-track-id"),
    b.id,
  );
  await expect(input()).not.toHaveAttribute("readonly", "");
  await input().press("Escape");
  // Click elsewhere commits, without selecting/playing a row that may move.
  await begin(a.id, "genre");
  await input().fill("Click committed");
  await cell(b.id, "artist").click();
  await expect(input()).toHaveCount(0);
  await waitSaved();
  assert.equal((await parseFile(a.path)).common.genre[0], "Click committed");
  assert.equal(await row(a.id).getAttribute("aria-selected"), "true");
  // Enter exits while the actual publication worker is held, without
  // interpreting editor removal as publication success.
  await begin(a.id, "genre");
  await input().fill("One submission");
  const calls = await count();
  await app.evaluate(() => {
    globalThis.inlineHoldWorker = true;
    globalThis.inlineReleaseWorker = undefined;
  });
  await page.evaluate(() => {
    const field = document.querySelector(".inline-metadata-input");
    field.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      const started = performance.now();
      const observer = new MutationObserver(() => {
        if (field.isConnected) return;
        window.inlineEnterExitMs = performance.now() - started;
        observer.disconnect();
      });
      observer.observe(document.body, { subtree: true, childList: true });
    });
  });
  await input().press("Enter");
  await expect(input()).toHaveCount(0);
  await expect(page.locator(".songs-viewport")).toBeFocused();
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.inlineReleaseWorker))
    .toBe("function");
  await expectQuietEditing();
  await expect(quietStatus.locator('[role="status"]')).toContainText(
    "Saving metadata",
  );
  assert.equal((await parseFile(a.path)).common.genre[0], "Click committed");
  console.log(
    "RIO_INLINE_ENTER_EXIT",
    await page.evaluate(() => window.inlineEnterExitMs),
  );
  await page.screenshot({
    path: path.resolve(".impeccable/review/inline-metadata-enter-pending.png"),
  });

  // Repeated Enter cannot start playback or submit the pending track again.
  await page.locator(".songs-viewport").press("Enter");
  await cell(a.id, "genre").dblclick();
  await expect(input()).toHaveAttribute("readonly", "");
  await input().press("Enter");
  await input().press("Tab");
  await input().press("Escape");
  assert.equal(await count(), calls + 1);
  await cell(b.id, "artist").click();
  await expect(row(b.id)).toHaveAttribute("aria-selected", "true");
  await page.getByRole("button", { name: "Title", exact: true }).click();
  await expect(row(b.id)).toHaveAttribute("aria-selected", "true");
  await app.evaluate(() => globalThis.inlineReleaseWorker());
  await waitSaved();
  await expect(input()).toHaveCount(0);
  await expect(row(b.id)).toHaveAttribute("aria-selected", "true");
  assert.equal((await parseFile(a.path)).common.genre[0], "One submission");
  assert.equal(await count(), calls + 1);

  // A delayed successful reply cannot replace a newer favourite snapshot.
  await begin(a.id, "genre");
  await input().fill("Delayed reply");
  await app.evaluate(() => {
    globalThis.inlineHold = true;
    globalThis.inlineRelease = undefined;
  });
  await input().press("Enter");
  await expect(input()).toHaveCount(0);
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.inlineRelease))
    .toBe("function");
  await row(b.id)
    .getByRole("button", { name: /^Favourite / })
    .click();
  await expect(
    row(b.id).getByRole("button", { name: /^Unfavourite / }),
  ).toBeVisible();
  await app.evaluate(() => {
    globalThis.inlineHold = false;
    globalThis.inlineRelease();
  });
  await waitSaved();
  await expect(
    row(b.id).getByRole("button", { name: /^Unfavourite / }),
  ).toBeVisible();
  await row(b.id)
    .getByRole("button", { name: /^Unfavourite / })
    .click();
  await expect(
    row(b.id).getByRole("button", { name: /^Favourite / }),
  ).toBeVisible();
  // A genuine Save-time refusal retains the exact proposal for retry.
  await begin(a.id, "genre");
  await input().fill("Retry preserved");
  const firstRefusal = await refusedSave(async () => {
    await input().press("Enter");
    await expect(page.getByRole("alert")).toContainText("Reference:");
    await expect(input()).toHaveCount(0);
  });
  await expect(page.getByRole("alert")).toContainText(
    `Reference: ${firstRefusal}`,
  );
  await page.getByRole("button", { name: "Review edit", exact: true }).click();
  await expect(input()).toHaveValue("Retry preserved");
  await expect(input()).not.toHaveAttribute("readonly", "");
  await commit();
  assert.equal((await parseFile(a.path)).common.genre[0], "Retry preserved");
  await begin(a.id, "genre");
  await input().fill("Tab failure retained");
  await app.evaluate(() => {
    globalThis.inlineHold = true;
    globalThis.inlineRelease = undefined;
  });
  let tabRefusal;
  try {
    tabRefusal = await refusedSave(async () => {
      await input().press("Shift+Tab");
      await expect(input()).toHaveAttribute("aria-label", "Edit Album");
      await expect(input()).toBeFocused();
      await expect(input()).toHaveAttribute("readonly", "");
      await expect
        .poll(() => app.evaluate(() => typeof globalThis.inlineRelease))
        .toBe("function");
    });
  } finally {
    await releaseSaveReply();
  }
  await expect(page.getByRole("alert")).toContainText(
    `Reference: ${tabRefusal}`,
  );
  await expect(input()).toHaveAttribute("aria-label", "Edit Album");
  await expect(input()).toBeFocused();
  assert((await quietStatus.boundingBox()).height > 0);
  await expect(
    page.getByRole("button", { name: "Discard edit", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: path.resolve(".impeccable/review/inline-metadata-failure.png"),
  });
  await page.getByRole("button", { name: "Review edit", exact: true }).click();
  await expect(input()).toHaveValue("Tab failure retained");
  await commit();
  assert.equal(
    (await parseFile(a.path)).common.genre[0],
    "Tab failure retained",
  );
  if (!historicalTimingBaseline) {
    // A failure arriving after leaving Songs still keeps the proposal.
    await begin(a.id, "genre");
    await input().fill("Detached proposal");
    await app.evaluate(() => {
      globalThis.inlineHold = true;
      globalThis.inlineRelease = undefined;
    });
    try {
      await refusedSave(async () => {
        await input().press("Enter");
        await expect
          .poll(() => app.evaluate(() => typeof globalThis.inlineRelease))
          .toBe("function");
        await page.getByRole("button", { name: "Albums", exact: true }).click();
        await expect(input()).toHaveCount(0);
      });
    } finally {
      await releaseSaveReply();
    }
    await expect(
      page.getByText(/reopen the edited cell in Songs/i),
    ).toBeVisible();
    await page.getByRole("button", { name: "Songs", exact: true }).click();
    await begin(a.id, "genre");
    await expect(input()).toHaveValue("Detached proposal");
    await input().press("Escape");
  }
  // Global projections refresh, not just the edited DOM text.
  await page
    .getByRole("searchbox", { name: "Search library" })
    .fill("Zed inline");
  await expect(row(a.id)).toBeVisible();
  await page.getByRole("searchbox", { name: "Search library" }).fill("");
  await page.getByRole("button", { name: "Albums", exact: true }).click();
  await expect(
    page.getByText("Inline album", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Artists", exact: true }).click();
  await expect(
    page.getByText("Inline artist", { exact: true }).first(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Songs", exact: true }).click();
  assert.deepEqual((await snap()).state.queue, originalState.queue);
  assert.equal((await snap()).state.currentId, originalState.currentId);
  async function play(id, timeout = 15000) {
    await row(id)
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
      { timeout },
    );
  }
  await begin(a.id, "genre");
  await input().fill("Pending playback test");
  await app.evaluate(() => {
    globalThis.inlineHoldWorker = true;
    globalThis.inlineReleaseWorker = undefined;
  });
  await input().press("Enter");
  await expect
    .poll(() => app.evaluate(() => typeof globalThis.inlineReleaseWorker))
    .toBe("function");
  await expect(input()).toHaveCount(0);
  await expect(quietStatus.locator('[role="status"]')).toContainText(
    "Saving metadata",
  );
  const playbackStarted = performance.now();
  try {
    if (historicalTimingBaseline) {
      await assert.rejects(play(b.id, 1000), { name: "TimeoutError" });
      console.error(
        "RIO_METADATA_INTERACTION",
        JSON.stringify({
          playbackWhilePending: false,
          observedMs: performance.now() - playbackStarted,
        }),
      );
    } else {
      await play(b.id);
      await expect(input()).toHaveCount(0);
      await expect(quietStatus.locator('[role="status"]')).toContainText(
        "Saving metadata",
      );
      console.error(
        "RIO_METADATA_INTERACTION",
        JSON.stringify({
          playbackWhilePending: true,
          readyMs: performance.now() - playbackStarted,
        }),
      );
      await assert.rejects(
        page.evaluate(
          ({ id, directory }) => window.rio.acquirePlayback(id, directory),
          { id: a.id, directory },
        ),
        /locked|metadata|unavailable/i,
      );
      await cell(b.id, "artist").click();
      await expect(row(b.id)).toHaveAttribute("aria-selected", "true");
      await expect(input()).toHaveCount(0);
      await expect(quietStatus.locator('[role="status"]')).toContainText(
        "Saving metadata",
      );
    }
  } finally {
    await app.evaluate(() => globalThis.inlineReleaseWorker());
  }
  await expect(input()).toHaveCount(0);
  await waitSaved();
  if (!historicalTimingBaseline)
    await expect(row(b.id)).toHaveAttribute("aria-selected", "true");
  await play(a.id);
  await cell(a.id, "title").dblclick();
  await expect(input()).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("loaded for playback");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await cell(a.id, "title").dblclick();
  await expect(input()).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("loaded for playback");
  await begin(b.id, "genre");
  await input().fill("Unrelated while paused");
  await commit();
  await play(b.id);
  await begin(a.id, "genre");
  await input().fill("Released target");
  await commit();
  // Eligibility remains authoritative for settings, references and other formats.
  await page.evaluate(() =>
    window.rio.saveMediaSettings({ keepOrganized: true }),
  );
  await cell(a.id, "title").dblclick();
  await expect(input()).toHaveCount(0);
  await expect(page.getByRole("alert")).toContainText("organized");
  await page.evaluate(() =>
    window.rio.saveMediaSettings({ keepOrganized: false }),
  );
  for (const t of [reference, other]) {
    await cell(t.id, "artist").dblclick();
    await expect(input()).toHaveCount(0);
  }
  // Track Info still edits complex fields through its unchanged production path.
  await row(a.id).click({ button: "right" });
  await expect
    .poll(() => app.evaluate(() => !!globalThis.inlineMenu))
    .toBe(true);
  await app.evaluate(() =>
    globalThis.inlineMenu.getMenuItemById("track-info").click(),
  );
  const info = page.getByRole("dialog", { name: "Track Info" });
  await expect(info.getByLabel("Comments", { exact: true })).toBeVisible();
  await info
    .getByLabel("Comments", { exact: true })
    .fill("Track Info still works");
  const infoSave = info.getByRole("button", { name: "Save", exact: true });
  if (process.env.RIO_METADATA_TIMING === "1")
    await infoSave.evaluate((button) => {
      button.addEventListener(
        "click",
        () => {
          const started = performance.now();
          const dialog = button.closest('[role="dialog"]');
          const observer = new MutationObserver(() => {
            if (dialog?.isConnected) return;
            observer.disconnect();
            console.info(
              "RIO_METADATA_TRACK_INFO",
              JSON.stringify({ clickToDomMs: performance.now() - started }),
            );
          });
          observer.observe(document.body, { subtree: true, childList: true });
        },
        { once: true },
      );
    });
  await infoSave.click();
  await expect(info).toHaveCount(0);
  const final = await snap();
  assert.equal(final.tracks.find((t) => t.id === a.id).path, a.path);
  assert.equal(final.tracks.find((t) => t.id === a.id).favorite, true);
  assert.deepEqual(final.playlists[0].trackIds, [a.id, b.id]);
  const callsProof = await app.evaluate(() => globalThis.inlineCalls);
  for (const call of callsProof.slice(0, -1)) {
    assert.equal(Object.keys(call.patch).length, 1);
    assert(!Object.hasOwn(call.patch, "path"));
    assert(!Object.hasOwn(call.patch, "strategy"));
  }
  for (let i = 0; i < sources.length; i++)
    assert.deepEqual(await proof(sources[i]), originals[i]);
  await mkdir(path.resolve(".impeccable/review"), { recursive: true });
  await begin(a.id, "year");
  await input().fill("not a year");
  await input().press("Enter");
  await page.screenshot({
    path: path.resolve(
      `.impeccable/review/inline-metadata-${packaged ? "packaged" : "source"}.png`,
    ),
  });
  await input().press("Escape");
  await app.close();
  app = undefined;
  page = await launch();
  await page.waitForSelector(".song-row");
  const reopened = await page.evaluate(() => window.rio.snapshot());
  const edited = reopened.tracks.find((t) => t.id === a.id);
  assert.equal(edited.path, a.path);
  assert.equal(edited.title, "Zed inline");
  assert.equal(edited.artist, "Inline artist");
  assert.equal(edited.album, "Inline album");
  assert.equal(edited.year, 2030);
  assert.equal(edited.genre, "Released target");
  assert.equal(edited.comments, "Track Info still works");
  assert.equal(edited.favorite, true);
  assert.deepEqual(reopened.state.queue, final.state.queue);
  assert.equal(reopened.state.currentId, final.state.currentId);
  assert.deepEqual(reopened.playlists[0].trackIds, [a.id, b.id]);
  for (let i = 0; i < sources.length; i++)
    assert.deepEqual(await proof(sources[i]), originals[i]);
  console.log(
    JSON.stringify(
      {
        passed: true,
        mode: historicalTimingBaseline
          ? "historical-timing-baseline"
          : "acceptance",
        packaged,
        noowners: !!volume,
        libraryImplementation: fixture.libraryPath,
        saves: callsProof.length,
        checks: [
          "first-save/reopen Enter/Tab/Shift+Tab focus, selection, renderer cost and real unrelated playback while held",
          "loaded renderer/style and application/preload resource hashes match this build",
          "real cell/IPC/coordinator Save; all eight existing simple columns",
          "Enter/Escape/Tab/Shift+Tab/outside click; no duplicate or parallel submission",
          "Enter removes editor before held publication; quiet visible UI and accessible pending state",
          "numeric/text validation, no-op and cancellation preserve file",
          "ID-bound sort/tab/focus/selection and hidden/noneditable column traversal",
          "Tab and Shift+Tab focus while publication is held; one save and deferred eligibility",
          "failed Tab proposal stays discoverable without stealing focus; explicit review and retry",
          "native Save refusal preserves managed bytes, receipt and external source; draft/reference and explicit retry",
          historicalTimingBaseline
            ? "historical one-second playback observation during a held save"
            : "detached failure draft recovery and unrelated playback/selection during a held save",
          "active/paused rejection, unrelated and released edits",
          "read-only references/formats/organized and existing Track Info",
          "global refresh, restart, ID/path/favourite/playlist/queue preservation",
          "external source bytes/mtime unchanged",
        ],
      },
      null,
      2,
    ),
  );
}
try {
  await run();
} finally {
  await app?.close();
  await volume?.close();
  await rm(root, { recursive: true, force: true });
}
