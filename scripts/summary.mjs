import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../dist/domain/library.js";
import { wavFixture } from "../tests/fixtures.ts";
import {
  collectionTotals,
  collectionSummaryText,
} from "../src/shared/collection-summary.ts";

const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-summary-app-")),
);
const folder = path.join(root, "Library"),
  media = path.join(root, "Media"),
  review = path.resolve(".impeccable/review");
const originals = new Map();
const executable =
  process.env.RIO_EXECUTABLE ||
  (process.argv.includes("--packaged")
    ? path.resolve(
        process.platform === "darwin"
          ? "release/mac/Rio.app/Contents/MacOS/Rio"
          : "release/linux-unpacked/rio-desktop",
      )
    : undefined);
let app, page, l;
async function launch() {
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    env: { ...process.env, RIO_DATA_DIR: path.join(root, "Profile") },
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.setDefaultTimeout(30000);
  await page.waitForSelector("h1");
}
async function nav(name) {
  await page
    .locator(".sidebar")
    .getByRole("button", { name, exact: true })
    .click();
}
const mainSummary = () => page.locator(".workspace > .collection-summary");
const albumSummary = () => page.locator(".detail-pane > .collection-summary");
async function summary(tracks, kind = "songs", playlists = 0) {
  const expected = collectionSummaryText(
    collectionTotals(tracks),
    kind,
    playlists,
  );
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".workspace > .collection-summary")
        ?.textContent === expected,
    expected,
  );
  assert.equal(await mainSummary().innerText(), expected);
  return expected;
}
const snapshot = () => page.evaluate(() => window.rio.snapshot());
async function frame() {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(resolve)),
      ),
  );
}
async function bounds() {
  const measured = await page.evaluate(() => {
    const box = (selector) => {
      const r = document.querySelector(selector)?.getBoundingClientRect();
      return (
        r && {
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          height: r.height,
        }
      );
    };
    const style = getComputedStyle(
      document.querySelector(".collection-summary"),
    );
    return {
      summary: box(".workspace > .collection-summary"),
      main: box(".main-scroll"),
      detail: box(".detail-panel"),
      album: box(".detail-pane > .collection-summary"),
      player: box(".player"),
      overflow: document.documentElement.scrollWidth > innerWidth,
      style: {
        fontSize: style.fontSize,
        color: style.color,
        background: style.backgroundColor,
        border: style.borderTopWidth,
      },
      footers: [...document.querySelectorAll(".collection-summary")].map(
        (footer) => {
          const r = footer.getBoundingClientRect(),
            s = getComputedStyle(footer);
          const lines = new Map();
          for (const metric of footer.children) {
            const m = metric.getBoundingClientRect(),
              key = Math.round(m.top);
            const line = lines.get(key) ?? { left: m.left, right: m.right };
            line.left = Math.min(line.left, m.left);
            line.right = Math.max(line.right, m.right);
            lines.set(key, line);
          }
          return {
            height: r.height,
            center: (r.left + r.right) / 2,
            lineHeight: parseFloat(s.lineHeight),
            paddingTop: parseFloat(s.paddingTop),
            paddingBottom: parseFloat(s.paddingBottom),
            grow: s.flexGrow,
            lines: [...lines.values()],
          };
        },
      ),
    };
  });
  assert(measured.main.bottom <= measured.summary.top + 1);
  assert(Math.abs(measured.summary.bottom - measured.player.top) <= 1);
  if (measured.album) {
    assert(measured.detail.bottom <= measured.album.top + 1);
    assert(Math.abs(measured.album.bottom - measured.player.top) <= 1);
  }
  assert.equal(measured.overflow, false);
  assert.equal(measured.style.fontSize, "11px");
  assert.equal(measured.style.border, "0px");
  for (const footer of measured.footers) {
    assert.equal(footer.grow, "0");
    assert.equal(footer.paddingTop, 4);
    assert.equal(footer.paddingBottom, 4);
    assert(
      Math.abs(footer.height - (footer.lines.length * footer.lineHeight + 8)) <=
        1,
      "Footer height must follow its text lines and modest padding",
    );
    for (const line of footer.lines)
      assert(
        Math.abs((line.left + line.right) / 2 - footer.center) <= 1,
        "Summary text must be centred within its own pane",
      );
  }
  return measured;
}
async function lastContentVisible(selector) {
  const last = page.locator(selector).last();
  await last.scrollIntoViewIfNeeded();
  const content = await last.boundingBox(),
    footer = await mainSummary().boundingBox();
  assert(
    content && footer && content.y + content.height <= footer.y + 1,
    "Last content must remain fully visible above the summary",
  );
  assert(content.y >= (await page.locator(".main-scroll").boundingBox()).y - 1);
}
try {
  await mkdir(media);
  await mkdir(review, { recursive: true });
  l = await Library.open(folder);
  await l.chooseMediaRoot(media);
  const specs = [
    ["Dawn", "Aurora", "Shared", "Edition A/CD1", "Ambient", 60],
    ["Noon", "Guest", "Shared", "Edition A/Disc 2", "Jazz", 120],
    ["Night", "Boreal", "Shared", "Edition B", "Jazz", 180],
    ["Short", "Aurora", "Shorts", "Shorts", "Ambient", 30],
    ["Managed", "Cedar", "Managed album", "Managed original", "Ambient", 90],
  ];
  for (const [title, artist, album, directory, genre, seconds] of specs) {
    const target = path.join(root, "Originals", directory);
    await mkdir(target, { recursive: true });
    const file = path.join(target, `${title}.wav`),
      bytes = wavFixture({
        title,
        artist,
        album,
        genre,
        seconds,
        albumArtist: title === "Noon" ? "Aurora" : artist,
        disc: title === "Dawn" ? "1/2" : title === "Noon" ? "2/2" : undefined,
      });
    await writeFile(file, bytes);
    originals.set(file, { bytes, mtime: (await stat(file)).mtimeMs });
    l.saveMediaSettings({ copyOnAdd: title === "Managed" });
    assert.deepEqual((await l.add([file])).errors, []);
  }
  let tracks = l.tracks();
  const named = (name) => tracks.find((t) => t.title === name);
  const dawn = named("Dawn"),
    noon = named("Noon"),
    night = named("Night"),
    short = named("Short"),
    managed = named("Managed");
  assert.equal(dawn.albumId, noon.albumId);
  assert.notEqual(dawn.albumId, night.albumId);
  for (const t of tracks) assert.equal(t.fileSize, (await stat(t.path)).size);
  assert.equal(managed.locationKind, "managed");
  assert.equal(dawn.locationKind, "referenced");
  l.favorite(dawn.id);
  l.favorite(night.id);
  const playlist = l.createPlaylist("Daily mix", [
    noon.id,
    managed.id,
    dawn.id,
  ]);
  l.createPlaylist("Another mix", [dawn.id, night.id]);
  l.createPlaylist("Empty mix");
  l.saveState({ ...l.state(), queue: [noon.id, managed.id] });
  // An unavailable location still has last indexed duration/size; never touch its source.
  l.db
    .prepare("UPDATE tracks SET path=path||'.unavailable',missing=1 WHERE id=?")
    .run(short.id);
  tracks = l.tracks();
  l.close();
  l = null;
  await launch();
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({
      canceled: false,
      filePaths: [folder],
    });
  }, folder);
  await page
    .getByRole("button", { name: "Choose library folder", exact: true })
    .click();
  await nav("Songs");
  const all = await summary(tracks);
  assert.equal(
    all,
    `5 songs · 8 min · ${collectionSummaryText(collectionTotals(tracks)).split(" · ").at(-1)}`,
  );
  assert((await mainSummary().getAttribute("title")).includes("last indexed"));
  const rows = page.locator(".song-row");
  await rows.first().click();
  await rows
    .nth(1)
    .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  assert.equal(
    await page.locator('.song-row[aria-selected="true"]').count(),
    2,
  );
  await summary(tracks);
  await page
    .getByRole("columnheader", { name: "Title", exact: true })
    .getByRole("button")
    .click();
  await summary(tracks);
  await page.getByLabel("Filter genre", { exact: true }).selectOption("Jazz");
  await summary([noon, night]);
  await page
    .getByLabel("Filter genre", { exact: true })
    .selectOption("All Genres");
  await summary(tracks);
  await nav("Daily mix");
  await summary([noon, managed, dawn]);
  await page
    .getByRole("columnheader", { name: "Title", exact: true })
    .getByRole("button")
    .click();
  await summary([noon, managed, dawn]);
  assert.deepEqual(
    (await snapshot()).playlists.find((p) => p.id === playlist.id).trackIds,
    [noon.id, managed.id, dawn.id],
  );
  await nav("Empty mix");
  await summary([]);
  await nav("Favourites");
  await summary([dawn, night]);
  await nav("Artists");
  await summary(tracks);
  await page
    .locator(".group-list")
    .getByRole("button")
    .filter({ has: page.getByText("Aurora", { exact: true }) })
    .click();
  await summary([dawn, noon, short]);
  await nav("Genres");
  await summary(tracks);
  await page
    .locator(".group-list")
    .getByRole("button")
    .filter({ has: page.getByText("Jazz", { exact: true }) })
    .click();
  await summary([noon, night]);
  // Search is global in the existing app, including when started within a playlist.
  await nav("Daily mix");
  await page.getByRole("searchbox").fill("Night");
  await summary([night]);
  await page.getByRole("searchbox").fill("no such recording");
  await summary([]);
  await nav("Albums");
  await summary(tracks, "albums");
  for (const order of ["recent", "year", "az"]) {
    await page.getByLabel("Sort library", { exact: true }).selectOption(order);
    await summary(tracks, "albums");
  }
  assert.equal(await page.locator(".album-card").count(), 4);
  await page.getByLabel("Filter genre", { exact: true }).selectOption("Jazz");
  // Album cards represent full album membership, including Dawn in Noon's matching album.
  await summary([dawn, noon, night], "albums");
  await page
    .getByLabel("Filter genre", { exact: true })
    .selectOption("All Genres");
  await page
    .locator(".album-card")
    .filter({
      has: page.getByRole("button", {
        name: "Open Shared by Aurora",
        exact: true,
      }),
    })
    .getByRole("button", { name: "Open Shared by Aurora", exact: true })
    .click();
  const albumExpected = collectionSummaryText(collectionTotals([dawn, noon]));
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".detail-pane > .collection-summary")
        ?.textContent === expected,
    albumExpected,
  );
  await page.locator(".detail-panel .track-row").first().click();
  await page
    .locator(".detail-panel .track-row")
    .nth(1)
    .click({ modifiers: [process.platform === "darwin" ? "Meta" : "Control"] });
  assert.equal(await albumSummary().innerText(), albumExpected);
  await summary(tracks, "albums");
  await nav("Recently Added");
  await summary(tracks, "albums");
  await page.getByRole("button", { name: "Track list", exact: true }).click();
  await summary(tracks);
  await nav("Playlists");
  await summary([dawn, noon, night, managed], "playlists", 3);
  await nav("Songs");
  await summary(tracks);
  await page.getByRole("button", { name: "Show queue", exact: true }).click();
  await page.waitForFunction(
    (expected) =>
      document.querySelector(".detail-pane > .collection-summary")
        ?.textContent === expected,
    collectionSummaryText(collectionTotals([noon, managed])),
  );
  await summary(tracks);
  await page.getByRole("button", { name: "Close queue", exact: true }).click();
  for (const width of [1464, 1250, 1050, 980]) {
    await app.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setSize(width, 720),
      width,
    );
    await page.waitForFunction((width) => innerWidth === width, width);
    await frame();
    await lastContentVisible(".song-row");
    console.log("SUMMARY_LAYOUT", { width, ...(await bounds()) });
    await page.screenshot({ path: path.join(review, `summary-${width}.png`) });
    await nav("Albums");
    await page.getByRole("button", { name: "Album grid", exact: true }).click();
    await summary(tracks, "albums");
    await lastContentVisible(".main-scroll > section .album-card");
    await bounds();
    await page.screenshot({
      path: path.join(review, `summary-albums-${width}.png`),
    });
    await nav("Songs");
    await summary(tracks);
  }
  await app.close();
  app = null;
  l = await Library.open(folder);
  l.db.prepare("UPDATE tracks SET duration=0,size=-1 WHERE id=?").run(dawn.id);
  tracks = l.tracks();
  l.close();
  l = null;
  await launch();
  await nav("Songs");
  await summary(tracks);
  assert((await mainSummary().innerText()).includes("+ unknown"));
  await page.getByRole("searchbox").fill("Dawn");
  await summary(tracks.filter((t) => t.id === dawn.id));
  assert.equal(
    await mainSummary().innerText(),
    "1 song · Duration unknown · Size unknown",
  );
  await page.locator(".song-row").first().click();
  await app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setSize(980, 720),
  );
  await page.waitForFunction(() => innerWidth === 980);
  await frame();
  await bounds();
  await page.screenshot({ path: path.join(review, "summary-unknown.png") });
  await app.close();
  app = null;
  for (const [file, before] of originals) {
    assert.deepEqual(await readFile(file), before.bytes);
    assert.equal((await stat(file)).mtimeMs, before.mtime);
  }
  console.log(
    "SUMMARY: Songs/playlists/artists/genres/favourites/global search/albums/details/recent/queue-safe layout, identity/multi-disc, selection/sort invariance, filters, mixed ownership, empty/unknown/offline metadata, restart and unchanged originals passed",
  );
} catch (error) {
  if (page && !page.isClosed()) {
    console.error(
      "SUMMARY_FAILURE",
      await page
        .locator("body")
        .innerText()
        .catch(() => ""),
    );
    await page
      .screenshot({ path: path.join(review, "summary-failure.png") })
      .catch(() => {});
  }
  throw error;
} finally {
  l?.close();
  await app?.close().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
