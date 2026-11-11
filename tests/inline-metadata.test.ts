import { test, expect } from "vitest";
import type { Snapshot, Track } from "../src/shared/types";
import { metadataDraft } from "../src/shared/metadata-editor";
import {
  inlineColumn,
  inlineCandidate,
  inlinePatch,
  inlineDestinations as destinations,
} from "../src/renderer/inline-metadata";
import { applyInlineSave } from "../src/renderer/inline-save";
const inlineDestinations = (...args: Parameters<typeof destinations>) => [
  ...destinations(...args),
];
const a = {
  id: "a",
  title: "Alpha",
  artist: "Artist",
  album: "Album",
  genre: "Jazz",
  year: 2026,
  track: 2,
  disc: 1,
  bpm: 120,
  locationKind: "managed",
  format: "flac",
  missing: false,
} as Track;
test("inline fields are limited to existing simple metadata columns", () => {
  for (const column of [
    "title",
    "artist",
    "album",
    "genre",
    "year",
    "track",
    "disc",
    "bpm",
  ] as const)
    expect(inlineColumn(column)).toBe(true);
  for (const column of ["comments", "duration", "codec", "bitRate"] as const)
    expect(inlineColumn(column)).toBe(false);
  expect(inlineCandidate(a)).toBe(true);
  expect(inlineCandidate({ ...a, locationKind: "referenced" })).toBe(false);
  expect(inlineCandidate({ ...a, format: "mp3" })).toBe(false);
  expect(inlineCandidate({ ...a, missing: true })).toBe(false);
});
test("one cell uses Track Info set/clear semantics and skips exact or equivalent numeric no-ops", () => {
  const before = metadataDraft(a);
  expect(inlinePatch(before, "title", "Changed")).toEqual({
    title: { action: "set", value: "Changed" },
  });
  expect(inlinePatch(before, "track", "")).toEqual({
    trackNumber: { action: "clear" },
  });
  expect(inlinePatch(before, "disc", "2")).toEqual({
    discNumber: { action: "set", value: 2 },
  });
  expect(inlinePatch(before, "artist", "")).toEqual({
    artist: { action: "clear" },
  });
  expect(inlinePatch(before, "title", a.title)).toEqual({});
  expect(inlinePatch(before, "track", "02")).toEqual({});
  expect(before).toEqual(metadataDraft(a));
});
test.each(["1e2", "-1", "1.5", "0", "10000", " "])(
  "inline numeric validation matches Track Info: %s",
  (value) => {
    expect(() => inlinePatch(metadataDraft(a), "year", value)).toThrow();
  },
);
test("invalid text and BPM limits are not bypassed", () => {
  expect(() => inlinePatch(metadataDraft(a), "title", "\0")).toThrow();
  expect(() =>
    inlinePatch(metadataDraft(a), "title", "x".repeat(4001)),
  ).toThrow();
  expect(() => inlinePatch(metadataDraft(a), "bpm", "1001")).toThrow();
});
test("Tab destinations follow displayed columns and pre-save IDs, skip read-only tracks and never wrap", () => {
  const b = { ...a, id: "b" },
    reference = { ...a, id: "ref", locationKind: "referenced" as const };
  const tracks = [a, reference, b];
  const columns = ["year", "duration", "title", "comments", "artist"] as const;
  const next = inlineDestinations(
    tracks,
    [...columns],
    { id: "a", column: "title" },
    1,
  );
  expect(next).toEqual([
    { id: "a", column: "artist" },
    { id: "b", column: "year" },
    { id: "b", column: "title" },
    { id: "b", column: "artist" },
  ]);
  // Re-sorting the backing list cannot mutate a captured ID destination.
  tracks.reverse();
  expect(next[0]).toEqual({ id: "a", column: "artist" });
  expect(
    inlineDestinations([a, b], [...columns], { id: "b", column: "artist" }, 1),
  ).toEqual([]);
  expect(
    inlineDestinations([a, b], [...columns], { id: "a", column: "year" }, -1),
  ).toEqual([]);
  expect(
    inlineDestinations(
      [a, b],
      [...columns],
      { id: "b", column: "title" },
      -1,
    )[0],
  ).toEqual({ id: "b", column: "year" });
});

test("an inline reply preserves newer favorites and leaves a newer edit or session alone", () => {
  const before = { ...a, path: "/managed/a.flac", favorite: false };
  const current = {
    metadataSession: "session",
    tracks: [{ ...before, favorite: true }],
    playlists: [],
  } as unknown as Snapshot;
  const reply = { ...current, tracks: [{ ...before, title: "Saved" }] };
  expect(applyInlineSave(current, before, reply)?.tracks[0]).toMatchObject({
    title: "Saved",
    favorite: true,
  });
  const newer = { ...current, tracks: [{ ...before, title: "Newer" }] };
  expect(applyInlineSave(newer, before, reply)).toBe(newer);
  const other = { ...current, metadataSession: "other" };
  expect(applyInlineSave(other, before, reply)).toBe(other);
});
