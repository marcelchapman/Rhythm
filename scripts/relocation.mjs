import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  realpath,
  writeFile,
  readFile,
  rm,
  stat,
  rename,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { Library } from "../dist/domain/library.js";
import { wavFixture } from "../tests/fixtures.ts";
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-relocation-desktop-")),
);
const folder = path.join(root, "Rhythm 3"),
  parent = path.join(root, "Rhythm 4"),
  profile = path.join(root, "Profile"),
  review = path.resolve(".impeccable/review");
let app;
const executable =
  process.env.RIO_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rio.app/Contents/MacOS/Rio"
          : "release/linux-unpacked/rio-desktop",
      )
    : undefined);
try {
  for (const dir of [parent, profile, review])
    await mkdir(dir, { recursive: true });
  const original = path.join(root, "Original.wav"),
    bytes = wavFixture({ title: "Move safely", seconds: 30 });
  await writeFile(original, bytes);
  const originalStat = await stat(original);
  const library = await Library.open(folder, { setupMediaRoot: true });
  library.saveMediaSettings({ copyOnAdd: true });
  await library.add([original]);
  const track = library.tracks()[0];
  library.favorite(track.id);
  const playlist = library.createPlaylist("Preserved", [track.id]);
  const state = library.state();
  const receipt = library.db
    .prepare("SELECT id,stageInode FROM managed_imports WHERE status='done'")
    .get();
  library.close();
  // Same-inode spelling aliases used to leak the managed-recovery error during preflight.
  const actualPath = path.join(
    path.dirname(track.path),
    path.basename(track.path).toUpperCase(),
  );
  await rename(track.path, actualPath);
  if (!(await stat(track.path).catch(() => null)))
    await rename(actualPath, track.path);
  const pointer = path.join(profile, "library.json");
  await writeFile(pointer, JSON.stringify({ libraryPath: folder }));
  async function launch() {
    app = await electron.launch({
      ...(executable
        ? { executablePath: executable, args: [] }
        : { args: ["."] }),
      env: { ...process.env, RIO_DATA_DIR: profile },
      timeout: 30000,
    });
    assert.equal(
      await app.evaluate(({ app }) => app.isPackaged),
      !!executable,
      "Relocation runs against the requested source/packaged application",
    );
    const page = await app.firstWindow();
    await page
      .getByRole("button", { name: "Library settings", exact: true })
      .first()
      .waitFor();
    return page;
  }
  let page = await launch();
  const snapshot = () => page.evaluate(() => window.rio.snapshot());
  await page
    .getByRole("button", { name: "Library settings", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Library settings",
    exact: true,
  });
  await dialog.waitFor();
  const move = dialog.getByRole("button", {
    name: "Move Library…",
    exact: true,
  });
  async function select(canceled, response = 1) {
    await app.evaluate(
      ({ dialog }, { canceled, response, parent }) => {
        dialog.showOpenDialog = async (_window, options) => {
          globalThis.rioMovePicker = options;
          return { canceled, filePaths: canceled ? [] : [parent] };
        };
        dialog.showMessageBox = async (_window, options) => {
          globalThis.rioMoveConfirmation = options;
          return { response };
        };
      },
      { canceled, response, parent },
    );
  }
  for (const [cancelPicker, response] of [
    [true, 1],
    [false, 0],
  ]) {
    await select(cancelPicker, response);
    await move.click();
    await move.waitFor();
    assert.equal((await snapshot()).libraryPath, folder);
    assert.equal(
      JSON.parse(await readFile(pointer, "utf8")).libraryPath,
      folder,
    );
    await stat(path.join(folder, "rio.sqlite"));
  }
  // A pre-existing destination is never merged or overwritten.
  const conflict = parent;
  await writeFile(path.join(conflict, "unrelated"), "keep");
  await select(false);
  await move.click();
  await dialog.getByRole("alert").waitFor();
  assert.equal(
    await readFile(path.join(conflict, "unrelated"), "utf8"),
    "keep",
  );
  assert.equal((await snapshot()).libraryPath, folder);
  let failure = await page.getByTestId("library-relocation-error").innerText();
  assert.match(failure, /^MOVE FAILED/);
  assert(
    !/Managed file location changed|Choose its recovery source|RELOCATION RECOVERY REQUIRED/.test(
      failure,
    ),
  );
  await rm(path.join(conflict, "unrelated")); // Only the disposable test file.
  const corrupt = new DatabaseSync(path.join(folder, "rio.sqlite"));
  corrupt
    .prepare(
      "UPDATE managed_imports SET stageInode='invalid-receipt' WHERE id=?",
    )
    .run(receipt.id);
  corrupt.close();
  await move.click();
  await page
    .getByTestId("library-relocation-error")
    .filter({ hasText: "preflight" })
    .waitFor();
  failure = await page.getByTestId("library-relocation-error").innerText();
  assert.match(failure, /^MOVE FAILED/);
  assert(
    !/Managed file location changed|Choose its recovery source|RELOCATION RECOVERY REQUIRED/.test(
      failure,
    ),
  );
  assert.equal((await snapshot()).libraryPath, folder);
  assert.equal((await snapshot()).mediaSettings.setupError, undefined);
  assert.deepEqual(await readdir(parent), []);
  assert.equal(await page.getByText(/^Library moved to /).count(), 0);
  const restore = new DatabaseSync(path.join(folder, "rio.sqlite"));
  restore
    .prepare("UPDATE managed_imports SET stageInode=? WHERE id=?")
    .run(receipt.stageInode, receipt.id);
  restore.close();
  await move.click();
  await dialog.getByText(parent, { exact: true }).waitFor();
  await move.waitFor();
  const moved = await snapshot();
  assert.equal(moved.libraryPath, parent);
  assert((await readdir(parent)).includes("rio.sqlite"));
  assert(!(await readdir(parent)).includes("Rhythm 3"));
  assert.equal(JSON.parse(await readFile(pointer, "utf8")).libraryPath, parent);
  await page
    .getByText(`Library moved to ${parent}. Original retained at ${folder}.`, {
      exact: true,
    })
    .waitFor();
  const confirmation = await app.evaluate(() => globalThis.rioMoveConfirmation);
  assert(confirmation.detail.includes(`To: ${parent}\n`));
  assert.equal(moved.mediaSettings.root.path, path.join(parent, "Rio Media"));
  assert.equal(moved.mediaSettings.setupError, undefined);
  assert.equal(moved.tracks[0].id, track.id);
  assert(moved.tracks[0].favorite);
  assert.deepEqual(
    moved.playlists.find((p) => p.id === playlist.id),
    playlist,
  );
  assert.deepEqual(moved.state, state);
  assert.equal(await dialog.getByRole("alert").count(), 0);
  const picker = await app.evaluate(() => globalThis.rioMovePicker);
  assert.equal(picker.title, "Move Rio library");
  await page.screenshot({ path: path.join(review, "library-relocation.png") });
  await app.close();
  app = undefined;
  page = await launch();
  const reopened = await snapshot();
  assert.equal(reopened.libraryPath, moved.libraryPath);
  assert.deepEqual(reopened.mediaSettings, moved.mediaSettings);
  assert.equal(await page.getByRole("dialog").count(), 0);
  assert.equal(reopened.tracks[0].id, track.id);
  assert(reopened.tracks[0].favorite);
  // Normal Quit requested during native confirmation is deferred until commit/cleanup.
  const secondParent = path.join(root, "Second destination");
  await mkdir(secondParent);
  await page
    .getByRole("button", { name: "Library settings", exact: true })
    .first()
    .click();
  await app.evaluate(({ app, dialog }, parent) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [parent],
    });
    dialog.showMessageBox = async () => {
      setImmediate(() => app.quit());
      return { response: 1 };
    };
  }, secondParent);
  const quit = new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Quit was not resumed after relocation")),
      30000,
    );
    app.process().once("exit", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });
  await page
    .getByRole("button", { name: "Move Library…", exact: true })
    .click();
  assert.equal(await quit, 0);
  app = undefined;
  assert.equal(
    JSON.parse(await readFile(pointer, "utf8")).libraryPath,
    secondParent,
  );
  page = await launch();
  const afterQuit = await snapshot();
  assert.equal(afterQuit.libraryPath, secondParent);
  assert.equal(afterQuit.mediaSettings.setupError, undefined);
  assert.equal(afterQuit.tracks[0].id, track.id);
  assert.deepEqual(await readFile(original), bytes);
  assert.equal((await stat(original)).mtimeMs, originalStat.mtimeMs);
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "exact selected Rhythm 4 destination, never an appended Rhythm 3 child",
          "preflight failure leaves empty destination, original authority and explicit MOVE FAILED without media recovery or success banner",
          "native picker and confirmation cancellation",
          "destination conflict leaves source and unrelated files intact",
          "Move Library UI with internal media and identity/state persistence",
          "restart follows new pointer without recovery",
          "normal Quit is deferred through relocation and restart follows committed destination",
          "external original bytes/mtime unchanged",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
