import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  realpath,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import path from "node:path";
import { tmpdir } from "node:os";
import { finderStoreFixture, wavFixture } from "../tests/fixtures.ts";

// All files and native Trash handoffs are restricted to this disposable tree.
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rhythm-album-app-")),
);
const library = path.join(root, "Library");
const originals = new Map();
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const executable =
  process.env.RHYTHM_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rhythm.app/Contents/MacOS/Rhythm"
          : "release/linux-unpacked/rhythm-desktop",
      )
    : undefined);
let app, p;
async function launch() {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: {
      ...process.env,
      RHYTHM_DATA_DIR: path.join(root, "Profile"),
      ...(process.platform === "linux"
        ? { XDG_DATA_HOME: path.join(root, "xdg") }
        : {}),
    },
    timeout: 30000,
  });
  p = await app.firstWindow();
  p.setDefaultTimeout(30000);
  await p.waitForSelector("h1");
  await app.evaluate(
    ({ Menu, dialog, shell }, { root, originals }) => {
      globalThis.albumMenu = null;
      globalThis.albumDialogs = [];
      globalThis.albumReveals = [];
      globalThis.albumTrash = [];
      globalThis.albumOriginals = originals;
      Menu.prototype.popup = function () {
        globalThis.albumMenu = this;
      };
      dialog.showMessageBox = async (_win, options) => {
        globalThis.albumDialogs.push(options);
        return new Promise((resolve) => {
          globalThis.answerAlbum = (response) =>
            resolve({ response, checkboxChecked: false });
        });
      };
      shell.showItemInFolder = (file) => {
        globalThis.albumReveals.push(file);
      };
      const trash = shell.trashItem.bind(shell);
      shell.trashItem = async (file) => {
        if (
          !file.startsWith(`${root}/Media`) ||
          globalThis.albumOriginals.includes(file)
        )
          throw Error("TEST SAFETY: non-sacrificial Trash path");
        globalThis.albumTrash.push(file);
        await trash(file);
        if (globalThis.replaceCleanupDirectory) {
          const directory = globalThis.replaceCleanupDirectory;
          if (file.slice(0, file.lastIndexOf("/")) !== directory)
            throw Error("TEST SAFETY: unexpected directory replacement");
          const fs = process.getBuiltinModule("fs").promises;
          await fs.rename(directory, `${directory}-parked`);
          await fs.mkdir(directory);
          globalThis.replaceCleanupDirectory = null;
        }
      };
    },
    { root, originals: [...originals.keys()] },
  );
}
const snapshot = () => p.evaluate(() => window.rhythm.snapshot());
const select = (file) =>
  app.evaluate(({ dialog }, file) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [file],
    });
  }, file);
const nav = (name) =>
  p.locator(".sidebar").getByRole("button", { name, exact: true }).click();
const card = (track) =>
  p.locator(".album-card").filter({
    has: p.getByRole("button", {
      name: `Open ${track.album} by ${track.albumArtist}`,
      exact: true,
    }),
  });
const row = (track) => p.locator(`.song-row[data-track-id="${track.id}"]`);
async function until(predicate) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await p.waitForTimeout(50);
  }
  throw Error("Album test state did not converge");
}
async function source(folder, name, tags = {}) {
  const directory = path.join(root, folder);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.wav`);
  await writeFile(file, wavFixture({ title: name, seconds: 30, ...tags }));
  originals.set(file, {
    hash: hash(await readFile(file)),
    mtime: (await stat(file)).mtimeMs,
  });
  await app.evaluate((_, file) => globalThis.albumOriginals.push(file), file);
  return file;
}
async function importFiles(files, managed = false) {
  await p.evaluate(
    (managed) => window.rhythm.saveMediaSettings({ copyOnAdd: managed }),
    managed,
  );
  for (const file of files) {
    await select(file);
    const result = await p.evaluate(() => window.rhythm.importMusic());
    assert.deepEqual(result.errors, []);
  }
  await p.reload();
  await nav("Albums");
  return (await snapshot()).tracks;
}
async function openMenu(target, album = true) {
  await app.evaluate(() => {
    globalThis.albumMenu = null;
  });
  await target.click({ button: "right" });
  await until(() => app.evaluate(() => !!globalThis.albumMenu));
  const items = await app.evaluate(() =>
    globalThis.albumMenu.items.map((item) => ({
      id: item.id,
      label: item.label,
      enabled: item.enabled,
    })),
  );
  assert.equal(
    items.some(
      (i) =>
        i.id === "album-delete" && i.label === "Delete Album…" && i.enabled,
    ),
    album,
  );
  assert.equal(
    items.some((i) => i.id === "track-info"),
    !album,
  );
  assert.equal(
    items.some((i) => i.id === "track-delete"),
    !album,
  );
  assert.equal(
    items.some((i) => i.id === "album-reveal" && i.label === "Show in Finder"),
    album && process.platform === "darwin",
  );
  for (const id of [
    "track-play",
    "track-next",
    "track-queue",
    "track-playlist",
    "track-favorite",
  ])
    assert(items.some((i) => i.id === id));
}
const clickMenu = (id) =>
  app.evaluate((_, id) => {
    const item = globalThis.albumMenu.getMenuItemById(id);
    assertEnabled(item);
    item.click(undefined, undefined, {});
    function assertEnabled(item) {
      if (!item?.enabled) throw Error("Missing/disabled menu command");
    }
  }, id);
async function waitDialog(previous) {
  await until(() =>
    app.evaluate(
      (_, previous) => globalThis.albumDialogs.length > previous,
      previous,
    ),
  );
  assert.equal(
    await app.evaluate(() => globalThis.albumDialogs.length),
    previous + 1,
  );
  return app.evaluate(() => globalThis.albumDialogs.at(-1));
}
async function answer(response) {
  await app.evaluate(
    (_, response) => globalThis.answerAlbum(response),
    response,
  );
}
async function deletion(track, managed, referenced, response = 1) {
  await nav("Albums");
  await openMenu(card(track));
  const before = await snapshot();
  const foldersBefore = new Map();
  for (const member of before.tracks.filter(
    (t) => t.albumId === track.albumId && t.locationKind === "managed",
  )) {
    const directory = path.dirname(member.path);
    if (!foldersBefore.has(directory))
      foldersBefore.set(directory, await readdir(directory));
  }
  const calls = await app.evaluate(() => globalThis.albumTrash.length);
  const previous = await app.evaluate(() => globalThis.albumDialogs.length);
  await clickMenu("album-delete");
  const options = await waitDialog(previous);
  assert.equal(options.title, "Delete Album");
  assert.equal(options.message, `Delete “${track.album}” from your library?`);
  assert.equal(options.defaultId, 0);
  assert.equal(options.cancelId, 0);
  if (managed)
    assert(
      options.detail.includes(
        `${managed} managed track${managed === 1 ? "" : "s"} will be removed from Rhythm and moved to the Trash.`,
      ),
    );
  if (referenced)
    assert(
      options.detail.includes(
        `${referenced} referenced track${referenced === 1 ? "" : "s"} will be removed from Rhythm but remain at their original locations.`,
      ),
    );
  assert.equal(options.detail.includes("managed track"), !!managed);
  assert.equal(options.detail.includes("referenced track"), !!referenced);
  assert.deepEqual((await snapshot()).tracks, before.tracks);
  assert.deepEqual((await snapshot()).playlists, before.playlists);
  assert.deepEqual((await snapshot()).state.queue, before.state.queue);
  assert.equal((await snapshot()).state.currentId, before.state.currentId);
  assert.equal(await app.evaluate(() => globalThis.albumTrash.length), calls);
  for (const [directory, contents] of foldersBefore)
    assert.deepEqual(await readdir(directory), contents);
  await answer(response);
  if (!response) {
    await p.waitForFunction(
      () => !document.querySelector(".sidebar-bottom button").disabled,
    );
    assert.deepEqual((await snapshot()).tracks, before.tracks);
    assert.deepEqual((await snapshot()).playlists, before.playlists);
    assert.deepEqual((await snapshot()).state.queue, before.state.queue);
    assert.equal((await snapshot()).state.currentId, before.state.currentId);
    assert.equal(await app.evaluate(() => globalThis.albumTrash.length), calls);
    for (const [directory, contents] of foldersBefore)
      assert.deepEqual(await readdir(directory), contents);
  } else {
    await p
      .getByText(
        new RegExp(
          `of ${managed + referenced} tracks? removed from your library\\.`,
        ),
      )
      .first()
      .waitFor();
  }
}
async function reveal(track, expected, missing = 0, cancel = false) {
  if (process.platform !== "darwin") return;
  await nav("Albums");
  await openMenu(card(track));
  const before = await snapshot();
  const calls = await app.evaluate(() => globalThis.albumReveals.length);
  const previous = await app.evaluate(() => globalThis.albumDialogs.length);
  await clickMenu("album-reveal");
  if (!expected.length) {
    await p
      .getByRole("alert")
      .filter({ hasText: "can't find any audio files" })
      .waitFor();
  } else if (expected.length > 1 || missing) {
    const options = await waitDialog(previous);
    assert.equal(options.title, "Show in Finder");
    assert(options.detail.includes(`${expected.length} available folder`));
    for (const folder of expected) assert(options.detail.includes(folder));
    if (missing)
      assert(
        options.detail.includes(
          `${missing} track${missing === 1 ? " is" : "s are"} missing or inaccessible`,
        ),
      );
    assert.equal(
      await app.evaluate(() => globalThis.albumReveals.length),
      calls,
    );
    await answer(cancel ? 0 : 1);
  }
  if (expected.length && !cancel)
    await until(() =>
      app.evaluate(
        (_, count) => globalThis.albumReveals.length === count,
        calls + expected.length,
      ),
    );
  else
    // An enabled album command observes release of the existing operation lock.
    await until(async () => {
      await p.evaluate((id) => window.rhythm.showAlbumMenu(id), track.albumId);
      return app.evaluate(
        () => globalThis.albumMenu.getMenuItemById("album-delete").enabled,
      );
    });
  assert.deepEqual(
    await app.evaluate(
      (_, calls) => globalThis.albumReveals.slice(calls),
      calls,
    ),
    cancel ? [] : expected,
  );
  assert.deepEqual((await snapshot()).tracks, before.tracks);
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
async function relationships(ids) {
  await p.evaluate(async (ids) => {
    const list = await window.rhythm.createPlaylist(
      `Album collection ${ids[0]}`,
    );
    await window.rhythm.playlistTracks(list.id, ids);
    for (const id of ids) await window.rhythm.favorite(id);
  }, ids);
  await p.reload();
  await nav("Albums");
}
async function play(track) {
  await nav("Songs");
  await row(track)
    .getByRole("button", { name: `Play ${track.title}`, exact: true })
    .click();
  await p.waitForFunction((id) => {
    const audio = document.querySelector("audio");
    return (
      audio.currentSrc.endsWith(id) &&
      !audio.paused &&
      !audio.error &&
      audio.currentTime > 0.2
    );
  }, track.id);
  await until(async () => (await snapshot()).state.currentId === track.id);
}
async function absent(tracks) {
  const s = await snapshot();
  for (const track of tracks) {
    assert(!s.tracks.some((t) => t.id === track.id));
    assert(!s.playlists.some((p) => p.trackIds.includes(track.id)));
    assert(!s.state.queue.includes(track.id));
    assert.notEqual(s.state.currentId, track.id);
    const db = new DatabaseSync(path.join(library, "rhythm.sqlite"), {
      readOnly: true,
    });
    try {
      for (const table of [
        "track_locations",
        "managed_imports",
        "playlist_tracks",
      ])
        assert.deepEqual(
          db.prepare(`SELECT * FROM ${table} WHERE trackId=?`).all(track.id),
          [],
        );
    } finally {
      db.close();
    }
  }
}
async function stopped() {
  await p.waitForFunction(() => {
    const audio = document.querySelector("audio");
    return (
      audio.paused &&
      !audio.getAttribute("src") &&
      navigator.mediaSession.metadata === null
    );
  });
  await until(async () => (await snapshot()).state.currentId === null);
}
async function directoryCleanupAcceptance(media) {
  async function batch(album, titles, artist) {
    const files = [];
    for (const title of titles)
      files.push(
        await source("Cleanup originals", title, {
          album,
          ...(artist ? { artist } : {}),
        }),
      );
    const tracks = await importFiles(files, true);
    return titles.map((title) => tracks.find((t) => t.title === title));
  }
  const [finderTrack] = await batch(
    "Finder artist reproduction",
    ["Finder track"],
    "Finder-only artist",
  );
  const finderAlbum = path.dirname(finderTrack.path),
    finderArtist = path.dirname(finderAlbum);
  const finder = path.join(finderArtist, ".DS_Store");
  await writeFile(finder, finderStoreFixture());
  await deletion(finderTrack, 1, 0, 0);
  assert.deepEqual(await readFile(finder), finderStoreFixture());
  assert((await stat(finderAlbum)).isDirectory());
  await deletion(finderTrack, 1, 0);
  await absent([finderTrack]);
  await assert.rejects(stat(finderAlbum), { code: "ENOENT" });
  console.log(
    "FINDER_ARTIST_REPRO:",
    JSON.stringify({
      artistEntries: await readdir(finderArtist).catch((e) =>
        e.code === "ENOENT" ? null : Promise.reject(e),
      ),
      trashCalls: await app.evaluate(() => globalThis.albumTrash.slice(-2)),
    }),
  );
  await assert.rejects(stat(finderArtist), { code: "ENOENT" });
  assert.deepEqual(await app.evaluate(() => globalThis.albumTrash.slice(-2)), [
    finderTrack.path,
    finder,
  ]);
  assert((await stat(media)).isDirectory());
  for (const entry of ["unknown.txt", "unknown subdirectory"]) {
    const [track] = await batch(
      `Artist retention ${entry}`,
      [`Artist retention ${entry}`],
      `Cleanup artist ${entry}`,
    );
    const album = path.dirname(track.path),
      artist = path.dirname(album);
    const unknown = path.join(artist, entry);
    const metadata = path.join(artist, ".DS_Store");
    await writeFile(metadata, finderStoreFixture());
    if (entry === "unknown.txt") await writeFile(unknown, "user content");
    else await mkdir(unknown);
    await deletion(track, 1, 0, 0);
    await deletion(track, 1, 0);
    await absent([track]);
    await assert.rejects(stat(album), { code: "ENOENT" });
    assert.deepEqual((await readdir(artist)).sort(), [".DS_Store", entry]);
    assert.deepEqual(await readFile(metadata), finderStoreFixture());
  }
  const [firstAlbum] = await batch(
    "Artist first album",
    ["Shared artist first track"],
    "Cleanup shared artist",
  );
  const [lastAlbum] = await batch(
    "Artist last album",
    ["Shared artist last track"],
    "Cleanup shared artist",
  );
  const sharedArtist = path.dirname(path.dirname(firstAlbum.path));
  const sharedFinder = path.join(sharedArtist, ".DS_Store");
  await writeFile(sharedFinder, finderStoreFixture());
  await deletion(firstAlbum, 1, 0);
  await absent([firstAlbum]);
  await assert.rejects(stat(path.dirname(firstAlbum.path)), { code: "ENOENT" });
  assert.deepEqual((await readdir(sharedArtist)).sort(), [
    ".DS_Store",
    path.basename(path.dirname(lastAlbum.path)),
  ]);
  assert((await stat(lastAlbum.path)).isFile());
  assert.deepEqual(await readFile(sharedFinder), finderStoreFixture());
  await deletion(lastAlbum, 1, 0);
  await absent([lastAlbum]);
  await assert.rejects(stat(sharedArtist), { code: "ENOENT" });
  assert((await stat(media)).isDirectory());
  for (const entry of ["unknown.txt", "unknown subdirectory"]) {
    const [track] = await batch(`Retain ${entry}`, [`Track ${entry}`]);
    const directory = path.dirname(track.path),
      unknown = path.join(directory, entry);
    const metadata = path.join(directory, ".DS_Store");
    await writeFile(metadata, finderStoreFixture());
    if (entry === "unknown.txt")
      await writeFile(unknown, "unknown user content");
    else await mkdir(unknown);
    await deletion(track, 1, 0, 0);
    await deletion(track, 1, 0);
    await absent([track]);
    assert.deepEqual((await readdir(directory)).sort(), [".DS_Store", entry]);
    assert.deepEqual(await readFile(metadata), finderStoreFixture());
    assert((await stat(path.dirname(directory))).isDirectory());
  }
  const [good, bad] = await batch("Partial cleanup", [
    "Cleanup good",
    "Cleanup bad",
  ]);
  const partialDirectory = path.dirname(good.path);
  sql("UPDATE managed_imports SET status='ready' WHERE trackId=?", bad.id);
  await deletion(good, 2, 0);
  await absent([good]);
  await p
    .getByRole("alert")
    .filter({ hasText: "1 of 2 tracks removed" })
    .waitFor();
  assert.deepEqual(await readdir(partialDirectory), [path.basename(bad.path)]);
  sql("UPDATE managed_imports SET status='done' WHERE trackId=?", bad.id);
  await deletion(bad, 1, 0);
  await absent([bad]);
  await assert.rejects(stat(partialDirectory), { code: "ENOENT" });

  const discs = await batch("Cleanup discs", [
    "Cleanup disc one",
    "Cleanup disc two",
  ]);
  const albumDirectory = path.dirname(discs[0].path);
  for (let i = 0; i < discs.length; i++) {
    const track = discs[i];
    const destination = path.join(
      albumDirectory,
      i === 0 ? "CD1" : "Disc 2",
      path.basename(track.path),
    );
    await mkdir(path.dirname(destination));
    await rename(track.path, destination);
    const relative = path
      .relative(media, destination)
      .split(path.sep)
      .join("/");
    // Existing genuine generated copies retain their receipt identity through a rename.
    sql("UPDATE tracks SET path=? WHERE id=?", destination, track.id);
    sql(
      "UPDATE track_locations SET relativePath=? WHERE trackId=?",
      relative,
      track.id,
    );
    sql(
      "UPDATE managed_imports SET relative=? WHERE trackId=?",
      relative,
      track.id,
    );
    track.path = destination;
  }
  await p.reload();
  await deletion(discs[0], 2, 0, 0);
  await deletion(discs[0], 2, 0);
  await absent(discs);
  await assert.rejects(stat(albumDirectory), { code: "ENOENT" });
  assert((await stat(path.dirname(albumDirectory))).isDirectory());
  assert((await stat(media)).isDirectory());

  const [nested] = await batch("Cleanup nested root", [
    "Cleanup nested root track",
  ]);
  const nestedRoot = path.dirname(nested.path);
  const rootFinder = path.join(nestedRoot, ".DS_Store");
  await writeFile(rootFinder, finderStoreFixture());
  await select(nestedRoot);
  await p.evaluate(() => window.rhythm.chooseMediaRoot());
  await deletion(nested, 1, 0);
  await absent([nested]);
  assert.deepEqual(await readdir(nestedRoot), [".DS_Store"]);
  assert.deepEqual(await readFile(rootFinder), finderStoreFixture());
  await select(media);
  await p.evaluate(() => window.rhythm.chooseMediaRoot());

  const [warning] = await batch("Cleanup warning", ["Cleanup warning track"]);
  const directory = path.dirname(warning.path);
  await app.evaluate((_, directory) => {
    globalThis.replaceCleanupDirectory = directory;
  }, directory);
  await deletion(warning, 1, 0);
  await absent([warning]);
  await p
    .getByRole("alert")
    .filter({ hasText: "Folder cleanup could not finish" })
    .waitFor();
  // Successful deletion stays successful; the changed directory is explicitly retained.
  assert.deepEqual(await readdir(directory), []);
  assert((await stat(media)).isDirectory());
  console.log(
    "ALBUM_CLEANUP: sole Finder metadata Trash and artist pruning, other albums/unknown content retention, disc cleanup, partial failure, registered root protection, cancellation and truthful cleanup warning passed",
  );
}
try {
  await mkdir(library);
  await launch();
  await select(library);
  await p.evaluate(() => window.rhythm.chooseLibrary());
  const r1 = await source("References", "Ref one", {
    album: "Same title",
    albumArtist: "Owner One",
  });
  const r2 = await source("References", "Ref two", {
    album: "Same title",
    albumArtist: "Owner One",
  });
  const other = await source("References", "Unrelated", {
    album: "Same title",
    albumArtist: "Owner Two",
  });
  let tracks = await importFiles([r1, r2, other]);
  const [a, b, unrelated] = ["Ref one", "Ref two", "Unrelated"].map((name) =>
    tracks.find((t) => t.title === name),
  );
  assert.equal(a.albumId, b.albumId);
  assert.notEqual(a.albumId, unrelated.albumId);
  await reveal(a, [path.dirname(r1)]);
  // Album identity is also accessible on the opened album heading; track rows retain their own menu.
  await card(a)
    .getByRole("button", {
      name: `Open ${a.album} by ${a.albumArtist}`,
      exact: true,
    })
    .click();
  const heading = p.getByLabel(`Album ${a.album} by ${a.albumArtist}`, {
    exact: true,
  });
  await openMenu(heading);
  await openMenu(p.locator(".detail-art"));
  await heading.press("Shift+F10");
  await openMenu(
    p.locator(`.track-row[data-detail-track-id="${a.id}"]`),
    false,
  );
  // Stale menu membership cannot silently expand or narrow the target.
  const stale = await p.evaluate(
    async ({ id, ids }) => {
      try {
        await window.rhythm.deleteAlbum(id, ids);
        return "unexpected success";
      } catch (e) {
        return e.message;
      }
    },
    { id: a.albumId, ids: [a.id] },
  );
  assert.match(stale, /membership changed/);
  await relationships([a.id, b.id, unrelated.id]);
  await play(unrelated);
  await deletion(a, 0, 2, 0);
  const time = await p.locator("audio").evaluate((audio) => audio.currentTime);
  await deletion(a, 0, 2);
  await absent([a, b]);
  assert((await stat(path.dirname(r1))).isDirectory());
  await p.waitForFunction((time) => {
    const audio = document.querySelector("audio");
    return !audio.paused && audio.currentTime > time;
  }, time);
  assert.equal((await snapshot()).state.currentId, unrelated.id);
  assert.equal(await app.evaluate(() => globalThis.albumTrash.length), 0);

  const disc1 = await source("Set/CD1", "Disc one", {
    album: "Compilation",
    artist: "Singer A",
    compilation: true,
    disc: "1/2",
  });
  const disc2 = await source("Set/CD2", "Disc two", {
    album: "Compilation",
    artist: "Singer B",
    compilation: true,
    disc: "2/2",
  });
  tracks = await importFiles([disc1, disc2]);
  const d1 = tracks.find((t) => t.title === "Disc one"),
    d2 = tracks.find((t) => t.title === "Disc two");
  assert.equal(d1.albumId, d2.albumId);
  await reveal(d1, [path.dirname(disc1), path.dirname(disc2)], 0, true);
  await reveal(d1, [path.dirname(disc1), path.dirname(disc2)]);
  // Keep the originals read-only: simulate missing recorded paths without touching those files.
  sql(
    "UPDATE tracks SET path=? WHERE id=?",
    path.join(root, "Missing/two.wav"),
    d2.id,
  );
  await reveal(d1, [path.dirname(disc1)], 1);
  sql(
    "UPDATE tracks SET path=? WHERE id=?",
    path.join(root, "Missing/one.wav"),
    d1.id,
  );
  await reveal(d1, [], 2);
  await deletion(d1, 0, 2);
  await absent([d1, d2]);

  const media = path.join(root, "Media Managed");
  await mkdir(media);
  await select(media);
  await p.evaluate(() => window.rhythm.chooseMediaRoot());
  const m1file = await source("Managed originals", "Managed one", {
    album: "Managed",
  });
  const m2file = await source("Managed originals", "Managed two", {
    album: "Managed",
  });
  tracks = await importFiles([m1file, m2file], true);
  const m1 = tracks.find((t) => t.title === "Managed one"),
    m2 = tracks.find((t) => t.title === "Managed two");
  assert.equal(m1.albumId, m2.albumId);
  await reveal(m1, [path.dirname(m1.path)]);
  await relationships([m1.id, m2.id, unrelated.id]);
  await play(m1);
  await deletion(m1, 2, 0, 0);
  assert((await stat(m1.path)).isFile());
  await deletion(m1, 2, 0);
  await absent([m1, m2]);
  await stopped();
  await assert.rejects(stat(m1.path), { code: "ENOENT" });
  await assert.rejects(stat(m2.path), { code: "ENOENT" });
  await assert.rejects(stat(path.dirname(m1.path)), { code: "ENOENT" });
  await assert.rejects(stat(path.dirname(path.dirname(m1.path))), {
    code: "ENOENT",
  });
  assert((await stat(media)).isDirectory());
  await directoryCleanupAcceptance(media);

  const mixMedia = path.join(root, "Media Mixed");
  await mkdir(mixMedia);
  await select(mixMedia);
  await p.evaluate(() => window.rhythm.chooseMediaRoot());
  await p.evaluate(() =>
    window.rhythm.saveMediaSettings({ keepOrganized: false }),
  );
  const goodSource = await source("Mixed originals", "Mixed good", {
    album: "Mixed",
  });
  const badSource = await source("Mixed originals", "Mixed bad", {
    album: "Mixed",
  });
  await importFiles([goodSource, badSource], true);
  const refSource = await source("Media Mixed", "Mixed reference", {
    album: "Mixed",
  });
  tracks = await importFiles([refSource]);
  const good = tracks.find((t) => t.title === "Mixed good"),
    bad = tracks.find((t) => t.title === "Mixed bad"),
    ref = tracks.find((t) => t.title === "Mixed reference");
  assert.equal(good.albumId, bad.albumId);
  assert.equal(good.albumId, ref.albumId);
  await reveal(good, [mixMedia]);
  await relationships([good.id, bad.id, ref.id, unrelated.id]);
  sql("UPDATE managed_imports SET status='ready' WHERE trackId=?", bad.id);
  await play(unrelated);
  const calls = await app.evaluate(() => globalThis.albumTrash.length);
  await deletion(good, 2, 1, 0);
  await deletion(good, 2, 1);
  await p
    .getByRole("alert")
    .filter({ hasText: "2 of 3 tracks removed" })
    .waitFor();
  await absent([good, ref]);
  assert.deepEqual(
    await app.evaluate((_, calls) => globalThis.albumTrash.slice(calls), calls),
    [good.path],
  );
  assert((await stat(bad.path)).isFile());
  assert((await snapshot()).tracks.find((t) => t.id === bad.id).favorite);
  assert.equal(
    await p.locator("audio").evaluate((audio) => audio.paused),
    false,
  );
  // A post-Trash database failure is explicitly recoverable and uses the existing track Locate workflow.
  sql("UPDATE managed_imports SET status='done' WHERE trackId=?", bad.id);
  sql(
    `CREATE TRIGGER album_failure BEFORE DELETE ON tracks WHEN OLD.id='${bad.id}' BEGIN SELECT RAISE(ABORT,'injected album cleanup failure'); END;`,
  );
  await play(bad);
  await deletion(bad, 1, 0);
  await p
    .getByRole("alert")
    .filter({ hasText: "Restore it from Trash" })
    .waitFor();
  await p.waitForFunction(() => document.querySelector("audio").paused);
  assert((await snapshot()).tracks.find((t) => t.id === bad.id).missing);
  sql("DROP TRIGGER album_failure");
  await app.close();
  await launch();
  await nav("Songs");
  const persisted = await snapshot();
  assert.deepEqual(
    new Set(persisted.tracks.map((t) => t.id)),
    new Set([unrelated.id, bad.id]),
  );
  assert(persisted.playlists.some((list) => list.trackIds.includes(bad.id)));
  await openMenu(row(bad), false);
  await select(badSource);
  await clickMenu("track-locate");
  await p
    .getByText(
      "File located. The track is ready to play; its original stays unchanged.",
      { exact: true },
    )
    .waitFor();
  const recovered = (await snapshot()).tracks.find((t) => t.id === bad.id);
  assert.equal(recovered.missing, false);
  await play(recovered);
  await deletion(recovered, 1, 0);
  await absent([bad]);
  await stopped();
  assert.deepEqual(
    (await snapshot()).tracks.map((t) => t.id),
    [unrelated.id],
  );
  for (const [file, before] of originals) {
    assert.equal(hash(await readFile(file)), before.hash);
    assert.equal((await stat(file)).mtimeMs, before.mtime);
  }
  console.log(
    "ALBUMS: exact native targeting, multi-disc/same-name identities, Finder folder policy, reference/managed/mixed counts/cancel, real Trash authority/partial/recovery, relationships/playback/restart and unchanged originals passed",
  );
} catch (e) {
  if (p) {
    console.error(
      "ALBUM_FAILURE",
      await p
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    await mkdir(path.resolve(".impeccable/review"), { recursive: true });
    await p
      .screenshot({
        path: path.resolve(".impeccable/review/albums-failure.png"),
      })
      .catch(() => {});
  }
  throw e;
} finally {
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
