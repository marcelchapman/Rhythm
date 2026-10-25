import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  rm,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { wavFixture } from "../tests/fixtures.ts";

// Only generated, disposable media can reach the real OS Trash in this suite.
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rhythm-removal-app-")),
);
const library = path.join(root, "Library"),
  media = path.join(root, "Media"),
  incoming = path.join(root, "Referenced"),
  managedInputs = path.join(root, "Managed originals");
for (const directory of [library, media, incoming, managedInputs])
  await mkdir(directory);
const originals = new Map();
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const suffix = randomUUID();
for (const [directory, titles] of [
  [incoming, ["A", "B", "C", "D"]],
  [managedInputs, ["Managed one", "Managed two"]],
]) {
  for (const title of titles) {
    const file = path.join(directory, `${title}.wav`);
    await writeFile(
      file,
      wavFixture({
        title: `${title} ${suffix}`,
        artist: "Removal artist",
        album: "Removal album",
        seconds: 30,
      }),
    );
    originals.set(file, {
      hash: sha(await readFile(file)),
      mtime: (await stat(file)).mtimeMs,
    });
  }
}
let app;
const executable =
  process.env.RHYTHM_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rhythm.app/Contents/MacOS/Rhythm"
          : "release/linux-unpacked/rhythm-desktop",
      )
    : undefined);
async function launch() {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: {
      ...process.env,
      RHYTHM_DATA_DIR: path.join(root, "Profile"),
      ...(process.platform === "linux"
        ? { XDG_DATA_HOME: path.join(root, "xdg-data") }
        : {}),
    },
    timeout: 30000,
  });
  const p = await app.firstWindow();
  await p.waitForSelector("h1");
  await app.evaluate(({ Menu, dialog, shell }, media) => {
    Menu.prototype.popup = function () {
      globalThis.removalMenu = this;
    };
    globalThis.confirmations = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.confirmations.push(options);
      return new Promise((resolve) => {
        globalThis.answerRemoval = (response) =>
          resolve({ response, checkboxChecked: false });
      });
    };
    const realTrash = shell.trashItem.bind(shell);
    globalThis.trashCalls = [];
    globalThis.trashSuccesses = [];
    shell.trashItem = async (file) => {
      // Fail closed if any regression tries to trash a source or real user path.
      if (!file.startsWith(`${media}/`))
        throw Error("TEST SAFETY: refusing non-sacrificial path");
      globalThis.trashCalls.push(file);
      if (globalThis.failTrash)
        throw Error("Injected Trash unavailable; track retained");
      await realTrash(file);
      globalThis.trashSuccesses.push(file);
    };
  }, media);
  return p;
}
const snapshot = (p) => p.evaluate(() => window.rhythm.snapshot());
const select = (file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
const row = (p, id) => p.locator(`.song-row[data-track-id="${id}"]`);
const nav = (p, name) =>
  p.locator(".sidebar").getByRole("button", { name, exact: true }).click();
async function settled(p, predicate) {
  for (let n = 0; n < 150; n++) {
    const s = await snapshot(p);
    if (predicate(s)) return s;
    await p.waitForTimeout(100);
  }
  throw Error("Removal state did not converge");
}
async function menu(p, id, playlist = false) {
  await app.evaluate(() => {
    globalThis.removalMenu = null;
  });
  await row(p, id).click({ button: "right" });
  for (let n = 0; n < 100; n++) {
    if (await app.evaluate(() => !!globalThis.removalMenu)) break;
    await p.waitForTimeout(50);
  }
  const items = await app.evaluate(() =>
    globalThis.removalMenu.items.map((i) => ({ id: i.id, enabled: i.enabled })),
  );
  assert(items.some((i) => i.id === "track-delete" && i.enabled));
  assert.equal(
    items.some((i) => i.id === "track-remove-playlist"),
    playlist,
  );
}
const clickMenu = (id) =>
  app.evaluate((_, id) => {
    const item = globalThis.removalMenu.getMenuItemById(id);
    if (!item?.enabled) throw Error(`Missing/disabled ${id}`);
    item.click(undefined, undefined, {});
  }, id);
async function confirm(p, id, managed, response = 1, playlist = false) {
  await menu(p, id, playlist);
  const before = await snapshot(p),
    count = await app.evaluate(() => globalThis.confirmations.length);
  await clickMenu("track-delete");
  for (let n = 0; n < 100; n++) {
    if (
      await app.evaluate(
        (count) => globalThis.confirmations.length > count,
        count,
      )
    )
      break;
    await p.waitForTimeout(50);
  }
  const options = await app.evaluate(() => globalThis.confirmations.at(-1));
  assert.equal(
    await app.evaluate(() => globalThis.confirmations.length),
    count + 1,
  );
  assert.equal(options.title, "Delete from Library");
  assert.deepEqual(options.buttons, [
    "Cancel",
    managed ? "Move to Trash" : "Remove from Library",
  ]);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  assert.match(
    options.detail,
    managed
      ? /managed audio file moved to the Trash/
      : /remains at its original location/,
  );
  const pending = await snapshot(p);
  assert.deepEqual(pending.tracks, before.tracks);
  assert.deepEqual(pending.playlists, before.playlists);
  assert.deepEqual(pending.state.queue, before.state.queue);
  assert.equal(pending.state.currentId, before.state.currentId);
  await app.evaluate((_, response) => {
    globalThis.answerRemoval(response);
  }, response);
  if (response === 0) {
    // Invoke completes after the dialog answer; another operation must become available.
    await p.waitForFunction(
      () => !document.querySelector(".sidebar-bottom button").disabled,
    );
    assert.deepEqual((await snapshot(p)).tracks, before.tracks);
    assert.deepEqual((await snapshot(p)).playlists, before.playlists);
  }
}
async function play(p, track) {
  await row(p, track.id)
    .getByRole("button", { name: `Play ${track.title}`, exact: true })
    .click();
  await p.waitForFunction((id) => {
    const a = document.querySelector("audio");
    return (
      a.currentSrc.endsWith(id) && !a.paused && !a.error && a.currentTime > 0.2
    );
  }, track.id);
  await settled(p, (s) => s.state.currentId === track.id);
}
async function cleared(p, id) {
  await settled(
    p,
    (s) =>
      !s.tracks.some((t) => t.id === id) &&
      !s.playlists.some((list) => list.trackIds.includes(id)) &&
      !s.state.queue.includes(id) &&
      s.state.currentId !== id,
  );
  await row(p, id).waitFor({ state: "detached" });
}
async function stopped(p) {
  await p.waitForFunction(() => {
    const a = document.querySelector("audio");
    return (
      a.paused &&
      !a.getAttribute("src") &&
      navigator.mediaSession.metadata === null
    );
  });
  const s = await snapshot(p);
  assert.equal(s.state.currentId, null);
  assert.equal(s.state.position, 0);
}
function sql(statement, ...args) {
  const db = new DatabaseSync(path.join(library, "rhythm.sqlite"));
  try {
    return args.length
      ? db.prepare(statement).run(...args)
      : db.exec(statement);
  } finally {
    db.close();
  }
}
function noRelationships(id) {
  const db = new DatabaseSync(path.join(library, "rhythm.sqlite"), {
    readOnly: true,
  });
  try {
    for (const [table, key] of [
      ["tracks", "id"],
      ["track_locations", "trackId"],
      ["playlist_tracks", "trackId"],
      ["managed_imports", "trackId"],
    ])
      assert.deepEqual(
        db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).all(id),
        [],
      );
  } finally {
    db.close();
  }
}
try {
  let p = await launch();
  await select(library);
  await p
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await p.getByRole("heading", { name: "Your library starts here." }).waitFor();
  await select(incoming);
  await p
    .getByRole("button", { name: "Add music folders", exact: true })
    .click();
  const s = await settled(p, (s) => s.tracks.length === 4);
  const [a, b, c, d] = ["A", "B", "C", "D"].map((prefix) =>
    s.tracks.find((t) => t.title === `${prefix} ${suffix}`),
  );
  const lists = await p.evaluate(
    async ({ a, b, c }) => {
      const first = await window.rhythm.createPlaylist("Removal first"),
        second = await window.rhythm.createPlaylist("Removal second");
      await window.rhythm.playlistTracks(first.id, [a, b, c]);
      await window.rhythm.playlistTracks(second.id, [c, a, b]);
      await window.rhythm.favorite(a);
      return [first, second];
    },
    { a: a.id, b: b.id, c: c.id },
  );
  await p.reload();
  await nav(p, "Songs");
  await play(p, a);
  await nav(p, lists[0].name);
  await menu(p, a.id, true);
  await clickMenu("track-remove-playlist");
  await settled(
    p,
    (s) =>
      !s.playlists
        .find((list) => list.id === lists[0].id)
        .trackIds.includes(a.id),
  );
  await row(p, a.id).waitFor({ state: "detached" });
  const removed = await snapshot(p);
  assert(removed.tracks.find((t) => t.id === a.id).favorite);
  assert.deepEqual(
    removed.playlists.find((l) => l.id === lists[1].id).trackIds,
    [c.id, a.id, b.id],
  );
  assert.equal(removed.state.currentId, a.id);
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  assert.equal(await app.evaluate(() => globalThis.confirmations.length), 0);
  await row(p, c.id).click();
  await row(p, b.id).click({
    modifiers: [process.platform === "darwin" ? "Meta" : "Control"],
  });
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 2);
  await confirm(p, b.id, false, 0, true);
  assert.equal(await app.evaluate(() => globalThis.trashCalls.length), 0);
  await confirm(p, b.id, false, 1, true);
  await cleared(p, b.id);
  assert.equal(await row(p, c.id).getAttribute("aria-selected"), "true");
  assert.equal(await p.locator('.song-row[aria-selected="true"]').count(), 1);
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  noRelationships(b.id);
  // The playlist relationship is never inferred from the overall navigation view.
  await nav(p, lists[1].name);
  await p.getByRole("searchbox", { name: "Search library" }).fill(a.title);
  await menu(p, a.id);
  await p.getByRole("searchbox", { name: "Search library" }).fill("");
  for (const view of ["Songs", "Albums", "Artists", "Genres", "Favourites"]) {
    await nav(p, view);
    if (view === "Albums")
      await p.getByRole("button", { name: "Track list", exact: true }).click();
    if (view === "Artists")
      await p
        .locator(".group-list button")
        .filter({ hasText: "Removal artist" })
        .click();
    if (view === "Genres")
      await p
        .locator(".group-list button")
        .filter({ hasText: "Ambient" })
        .click();
    await menu(p, a.id);
  }
  await confirm(p, a.id, false);
  await cleared(p, a.id);
  await stopped(p);
  noRelationships(a.id);
  await app.close();
  p = await launch();
  const afterRestart = await settled(p, (s) => s.tracks.length === 2);
  assert.deepEqual(
    new Set(afterRestart.tracks.map((t) => t.id)),
    new Set([c.id, d.id]),
  );
  assert(
    afterRestart.playlists.every(
      (list) => JSON.stringify(list.trackIds) === JSON.stringify([c.id]),
    ),
  );
  await stopped(p);
  // Configure through the real main/preload APIs; no test-only production bypass.
  await select(media);
  await p.evaluate(async () => {
    await window.rhythm.chooseMediaRoot();
    await window.rhythm.saveMediaSettings({ copyOnAdd: true });
  });
  await nav(p, "Songs");
  await select(managedInputs);
  await p
    .getByRole("button", { name: "Add music", exact: true })
    .first()
    .click();
  const managed = await settled(p, (s) => s.tracks.length === 4);
  const m1 = managed.tracks.find((t) => t.title.startsWith("Managed one")),
    m2 = managed.tracks.find((t) => t.title.startsWith("Managed two"));
  assert.equal(m1.locationKind, "managed");
  assert.equal(m2.locationKind, "managed");
  await p.evaluate(
    async ({ ids, lists }) => {
      for (const id of ids) {
        await window.rhythm.favorite(id);
        for (const list of lists) await window.rhythm.addToPlaylist(list, [id]);
      }
    },
    { ids: [m1.id, m2.id], lists: lists.map((l) => l.id) },
  );
  await p.reload();
  await nav(p, "Songs");
  await play(p, m1);
  const managedHash = sha(await readFile(m1.path));
  await confirm(p, m1.id, true, 0);
  assert.equal(sha(await readFile(m1.path)), managedHash);
  assert.equal(await p.locator("audio").evaluate((a) => a.paused), false);
  await app.evaluate(() => {
    globalThis.failTrash = true;
  });
  await confirm(p, m1.id, true);
  await p
    .getByRole("alert")
    .filter({ hasText: "Injected Trash unavailable" })
    .waitFor();
  assert.equal(sha(await readFile(m1.path)), managedHash);
  const failed = await snapshot(p);
  assert(failed.tracks.find((t) => t.id === m1.id).favorite);
  assert(failed.playlists.every((l) => l.trackIds.includes(m1.id)));
  assert.equal(failed.state.currentId, m1.id);
  assert.equal(await app.evaluate(() => globalThis.trashSuccesses.length), 0);
  await app.evaluate(() => {
    globalThis.failTrash = false;
  });
  // A forged DB pathname must not reach even the guarded Trash adapter.
  const calls = await app.evaluate(() => globalThis.trashCalls.length);
  sql(
    "UPDATE tracks SET path=? WHERE id=?",
    path.join(managedInputs, "Managed one.wav"),
    m1.id,
  );
  await confirm(p, m1.id, true);
  await p
    .getByRole("alert")
    .filter({ hasText: "managed copy receipt" })
    .waitFor();
  assert.equal(await app.evaluate(() => globalThis.trashCalls.length), calls);
  sql("UPDATE tracks SET path=? WHERE id=?", m1.path, m1.id);
  await p.reload();
  await nav(p, "Songs");
  await play(p, m1);
  await confirm(p, m1.id, true);
  await cleared(p, m1.id);
  await stopped(p);
  await assert.rejects(stat(m1.path), { code: "ENOENT" });
  assert.deepEqual(await app.evaluate(() => globalThis.trashSuccesses), [
    m1.path,
  ]);
  noRelationships(m1.id);
  // Prove truthful recovery when Trash succeeded but SQLite cleanup failed.
  await play(p, m2);
  sql(
    "CREATE TRIGGER reject_removal BEFORE DELETE ON tracks BEGIN SELECT RAISE(ABORT,'injected removal database failure'); END;",
  );
  await confirm(p, m2.id, true);
  await p
    .getByRole("alert")
    .filter({
      hasText:
        "file was moved to the Trash, but its library entry could not be removed",
    })
    .waitFor();
  const partial = await settled(
    p,
    (s) => s.tracks.find((t) => t.id === m2.id)?.missing,
  );
  assert(partial.tracks.find((t) => t.id === m2.id).favorite);
  assert(partial.playlists.every((l) => l.trackIds.includes(m2.id)));
  await p.waitForFunction(() => document.querySelector("audio").paused);
  await assert.rejects(stat(m2.path), { code: "ENOENT" });
  sql("DROP TRIGGER reject_removal");
  await app.close();
  p = await launch();
  await nav(p, "Songs");
  await menu(p, m2.id);
  await select(path.join(managedInputs, "Managed two.wav"));
  await clickMenu("track-locate");
  await settled(p, (s) => !s.tracks.find((t) => t.id === m2.id).missing);
  await play(p, m2);
  await confirm(p, m2.id, true);
  await cleared(p, m2.id);
  await stopped(p);
  noRelationships(m2.id);
  await app.close();
  p = await launch();
  const final = await settled(p, (s) => s.tracks.length === 2);
  assert.deepEqual(
    new Set(final.tracks.map((t) => t.id)),
    new Set([c.id, d.id]),
  );
  assert(
    final.playlists.every(
      (l) => JSON.stringify(l.trackIds) === JSON.stringify([c.id]),
    ),
  );
  await stopped(p);
  for (const [file, before] of originals) {
    assert.equal(sha(await readFile(file)), before.hash, file);
    assert.equal((await stat(file)).mtimeMs, before.mtime, file);
  }
  console.log(
    JSON.stringify(
      {
        passed: true,
        checks: [
          "playlist-only removal preserves library, other playlist, favourite and real playback",
          "playlist deletion and non-playlist menu exposure including global search from a playlist",
          "referenced and managed native confirmation options, pending and cancellation zero mutation",
          "complete identity, playlist, favourite, queue, current decoder and media-session cleanup",
          "queued deletion preserves unrelated real playback",
          "managed Trash failure and forged external path retain identity and sources",
          "real Electron OS Trash for sacrificial receipt-validated managed copies",
          "post-Trash database failure retains recoverable identity, restart and Locate/retry",
          "immediate UI refresh, restart persistence, source SHA-256 and mtimes unchanged",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    "REMOVAL_FAILURE",
    await app
      ?.firstWindow()
      .then((p) => p.locator("body").innerText())
      .catch(() => "unavailable"),
  );
  throw error;
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
