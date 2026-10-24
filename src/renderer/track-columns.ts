import type { Track } from "../shared/types";
export const TRACK_COLUMNS = [
  { key: "title", label: "Title", width: 230 },
  { key: "duration", label: "Time", width: 68 },
  { key: "artist", label: "Artist", width: 150 },
  { key: "album", label: "Album", width: 170 },
  { key: "genre", label: "Genre", width: 110 },
  { key: "bpm", label: "BPM", width: 62 },
  { key: "bitRate", label: "Bit Rate", width: 84 },
  { key: "codec", label: "Kind / Format", width: 140 },
  { key: "disc", label: "Disc", width: 52 },
  { key: "track", label: "Track", width: 55 },
  { key: "comments", label: "Comments", width: 260 },
  { key: "year", label: "Year", width: 68 },
] as const;
export type TrackSortKey = (typeof TRACK_COLUMNS)[number]["key"];
const numeric = new Set<TrackSortKey>([
  "duration",
  "bpm",
  "bitRate",
  "disc",
  "track",
  "year",
]);
const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
export function sortTracks(
  tracks: Track[],
  key: TrackSortKey,
  direction: 1 | -1,
): Track[] {
  return [...tracks].sort((a, b) => {
    const x = a[key],
      y = b[key];
    const missingX = x === null || x === "" || (numeric.has(key) && x === 0);
    const missingY = y === null || y === "" || (numeric.has(key) && y === 0);
    if (missingX !== missingY) return missingX ? 1 : -1;
    return (
      (numeric.has(key)
        ? Number(x) - Number(y)
        : collator.compare(String(x), String(y))) * direction ||
      collator.compare(a.title, b.title) ||
      a.id.localeCompare(b.id)
    );
  });
}
export const TRACK_DRAG_TYPE = "application/x-rhythm-track-ids";
export function dragTrackIds(data: string): string[] {
  try {
    const ids: unknown = JSON.parse(data);
    return Array.isArray(ids) &&
      ids.length <= 50000 &&
      ids.every((id) => typeof id === "string" && /^[a-f0-9]{64}$/.test(id))
      ? [...new Set(ids)]
      : [];
  } catch {
    return [];
  }
}
