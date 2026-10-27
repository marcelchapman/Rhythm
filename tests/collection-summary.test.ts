import { expect, test } from "vitest";
import {
  collectionTotals,
  collectionSummaryText,
  formatCollectionDuration,
  formatCollectionSize,
} from "../src/shared/collection-summary";
import type { SummaryTrack } from "../src/shared/collection-summary";

const track = (
  duration = 60,
  fileSize: number | null = 1e6,
  albumId = "album",
): SummaryTrack => ({ duration, fileSize, albumId });
test.each([
  [0, "0 min"],
  [NaN, "0 min"],
  [-1, "0 min"],
  [Infinity, "0 min"],
  [0.25, "<1 sec"],
  [59.9, "59 sec"],
  [60, "1 min"],
  [2520, "42 min"],
  [3600, "1 hr"],
  [8280, "2 hr 18 min"],
  [86399, "23 hr 59 min"],
  [86400, "1 day"],
  [319680, "3.7 days"],
  [86400 * 12000, "12,000 days"],
])("duration %s has deterministic human units: %s", (seconds, expected) => {
  expect(formatCollectionDuration(seconds)).toBe(expected);
});
test.each([
  [0, "0 MB"],
  [NaN, "0 MB"],
  [-1, "0 MB"],
  [Infinity, "0 MB"],
  [44, "<0.01 MB"],
  [10000, "0.01 MB"],
  [1e6, "1 MB"],
  [42.125e6, "42.13 MB"],
  [1e9, "1 GB"],
  [2.5e9, "2.5 GB"],
  [1e12, "1 TB"],
  [1.237e12, "1.24 TB"],
])("decimal size %s formats as %s", (bytes, expected) => {
  expect(formatCollectionSize(bytes)).toBe(expected);
});
test("song and album summaries count domain album identities, not same title or disc", () => {
  const tracks = [
    track(60, 1e6, "same-title-artist-A-disc-1-and-2"),
    track(120, 2e6, "same-title-artist-A-disc-1-and-2"),
    track(180, 3e6, "same-title-artist-B"),
  ];
  const totals = collectionTotals(tracks);
  expect(totals).toEqual({
    songs: 3,
    albums: 2,
    seconds: 360,
    bytes: 6e6,
    unknownDurations: 0,
    unknownSizes: 0,
  });
  expect(collectionSummaryText(totals)).toBe("3 songs · 6 min · 6 MB");
  expect(collectionSummaryText(totals, "albums")).toBe("2 albums · 6 MB");
  expect(collectionSummaryText(collectionTotals([tracks[0]]))).toBe(
    "1 song · 1 min · 1 MB",
  );
  expect(collectionSummaryText(collectionTotals([tracks[0]]), "albums")).toBe(
    "1 album · 1 MB",
  );
});
test("empty collections and partial/wholly unknown metadata remain explicit", () => {
  expect(collectionSummaryText(collectionTotals([]))).toBe(
    "0 songs · 0 min · 0 MB",
  );
  expect(collectionSummaryText(collectionTotals([]), "albums")).toBe(
    "0 albums · 0 MB",
  );
  expect(collectionSummaryText(collectionTotals([track(0, null)]))).toBe(
    "1 song · Duration unknown · Size unknown",
  );
  expect(
    collectionSummaryText(
      collectionTotals([track(), track(NaN, null), track(Infinity, -1)]),
    ),
  ).toBe("3 songs · 1 min + unknown · 1 MB + unknown");
  expect(collectionSummaryText(collectionTotals([track(10, 0)]))).toBe(
    "1 song · 10 sec · 0 MB",
  );
});
test("sorting fractional indexed durations does not change totals or formatting", () => {
  const tracks = Array.from({ length: 10000 }, (_, i) =>
    track(i % 3 ? 0.1 : 0.3, i + 1),
  );
  const before = collectionTotals(tracks);
  expect(collectionTotals([...tracks].reverse())).toEqual(before);
  expect(
    collectionSummaryText(
      collectionTotals([...tracks].sort((a, b) => a.duration - b.duration)),
    ),
  ).toBe(collectionSummaryText(before));
});
test("10,000 tracks aggregate every item and established multi-disc identity cheaply", () => {
  const tracks = Array.from({ length: 10000 }, (_, i) =>
    track(319.68, 25e6, `album-${Math.floor(i / 10)}`),
  );
  const start = performance.now();
  const totals = collectionTotals(tracks);
  console.log("SUMMARY_AGGREGATION", {
    tracks: tracks.length,
    milliseconds: performance.now() - start,
  });
  expect(totals.songs).toBe(10000);
  expect(totals.albums).toBe(1000);
  expect(totals.seconds).toBe(3196800);
  expect(totals.bytes).toBe(250e9);
  expect(collectionSummaryText(totals)).toBe("10,000 songs · 37 days · 250 GB");
});
