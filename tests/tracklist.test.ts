import { expect, test } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  normalizeViewPreferences,
  patchTrackListPreferences,
  TRACK_COLUMN_IDS,
} from "../src/shared/preferences";
import { ViewPreferenceStore } from "../src/domain/view-preferences";
import { PlaylistOpenInbox, isPlaylistFile } from "../src/domain/playlist-open";

test("legacy order migrates, new columns append, invalid sizes clamp, Title cannot hide", () => {
  const migrated = normalizeViewPreferences({
    version: 1,
    songs: {
      columns: {
        order: ["artist", "title", "artist", "future"],
        widths: { title: 5, artist: 5000, bpm: NaN },
        hidden: ["title", "bpm", "future", "bpm"],
      },
    },
  });
  expect(migrated.version).toBe(2);
  expect(migrated.trackList.columns.order.slice(0, 3)).toEqual([
    "artist",
    "title",
    "duration",
  ]);
  expect(migrated.trackList.columns.order.at(-1)).toBe("year");
  expect(migrated.trackList.columns.widths).toEqual({
    title: 160,
    artist: 1200,
  });
  expect(migrated.trackList.columns.hidden).toEqual(["bpm"]);
});
test("hide/show preserves full order and widths and leaves newly introduced columns visible", () => {
  let preferences = normalizeViewPreferences({
    trackList: {
      columns: {
        order: ["bpm", "title"],
        widths: { bpm: 104 },
        hidden: ["bpm"],
      },
    },
  });
  const order = [...preferences.trackList.columns.order];
  preferences = patchTrackListPreferences(preferences, { hidden: [] });
  expect(preferences.trackList.columns.widths.bpm).toBe(104);
  expect(preferences.trackList.columns.order).toEqual(order);
  expect(preferences.trackList.columns.order).toHaveLength(
    TRACK_COLUMN_IDS.length,
  );
  expect(preferences.trackList.columns.hidden).not.toContain("year");
});
test("global preferences migrate once, persist across restart/libraries, serialize concurrent patches and recover corruption", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "rio-global-views-"));
  try {
    const store = await ViewPreferenceStore.open(root);
    await store.migrateLegacy({
      songs: { columns: { order: ["artist", "title"] } },
    });
    await Promise.all([
      store.update({ widths: { title: 300 } }),
      store.update({ widths: { artist: 210 } }),
      store.update({ hidden: ["comments"] }),
    ]);
    const next = await ViewPreferenceStore.open(root);
    await next.migrateLegacy({
      songs: { columns: { order: ["bpm", "title"] } },
    });
    expect(next.get().trackList.columns.order[0]).toBe("artist");
    expect(next.get().trackList.columns.widths).toEqual({
      title: 300,
      artist: 210,
    });
    expect(next.get().trackList.columns.hidden).toEqual(["comments"]);
    expect(
      JSON.parse(
        await readFile(path.join(root, "view-preferences.json"), "utf8"),
      ).version,
    ).toBe(2);
    await writeFile(path.join(root, "view-preferences.json"), "bad json");
    expect((await ViewPreferenceStore.open(root)).get()).toEqual(
      normalizeViewPreferences(),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("file-open inbox retains cold events until readiness, deduplicates startup/running delivery and allows deliberate reopening later", async () => {
  let clock = 0,
    ready = false;
  const inbox = new PlaylistOpenInbox(() => clock);
  const imported: string[] = [];
  expect(inbox.add("/tmp/mix.m3u8")).toBe(true);
  expect(inbox.add("/tmp/mix.m3u8")).toBe(false);
  expect(inbox.add("/tmp/song.wav")).toBe(false);
  expect(inbox.add("relative.m3u")).toBe(false);
  await inbox.drain(
    () => ready,
    async (file) => {
      imported.push(file);
    },
  );
  expect(imported).toEqual([]);
  expect(inbox.size).toBe(1);
  ready = true;
  await inbox.drain(
    () => ready,
    async (file) => {
      expect(inbox.add(file)).toBe(false);
      imported.push(file);
    },
  );
  expect(inbox.add("/tmp/mix.m3u8")).toBe(false);
  clock += 2001;
  expect(inbox.add("/tmp/mix.m3u8")).toBe(true);
  await inbox.drain(
    () => ready,
    async (file) => {
      imported.push(file);
    },
  );
  expect(imported).toHaveLength(2);
  expect(isPlaylistFile("/tmp/Unicode 音楽.M3U")).toBe(true);
});
test("multiple queued playlist files remain ordered, processing does not run concurrently and failures do not erase pending files", async () => {
  const inbox = new PlaylistOpenInbox();
  inbox.add("/tmp/a.m3u");
  inbox.add("/tmp/b.m3u8");
  const result: string[] = [];
  await expect(
    inbox.drain(
      () => true,
      async () => {
        throw Error("test failure");
      },
    ),
  ).rejects.toThrow("test failure");
  expect(inbox.size).toBe(1);
  await inbox.drain(
    () => true,
    async (file) => {
      await inbox.drain(
        () => true,
        async () => {
          throw Error("must not overlap");
        },
      );
      result.push(file);
    },
  );
  expect(result).toEqual(["/tmp/b.m3u8"]);
});
