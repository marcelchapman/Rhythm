import type { Track } from "./types.js";

export type SummaryTrack = Pick<Track, "albumId" | "duration" | "fileSize">;
export type SummaryKind = "songs" | "albums" | "playlists";
export interface CollectionTotals {
  songs: number;
  albums: number;
  seconds: number;
  bytes: number;
  unknownDurations: number;
  unknownSizes: number;
}
const integer = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const days = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** Indexed data only. Never consult selection, the decoder or the filesystem. */
export function collectionTotals(
  tracks: readonly SummaryTrack[],
): CollectionTotals {
  const albums = new Set<string>();
  let microseconds = 0;
  const totals = {
    songs: tracks.length,
    albums: 0,
    seconds: 0,
    bytes: 0,
    unknownDurations: 0,
    unknownSizes: 0,
  };
  for (const track of tracks) {
    albums.add(track.albumId);
    // Integer microseconds keep visible totals independent of sort/addition order.
    const duration = Math.round(track.duration * 1e6);
    if (Number.isSafeInteger(duration) && duration > 0)
      microseconds += duration;
    else totals.unknownDurations++;
    if (
      typeof track.fileSize === "number" &&
      Number.isSafeInteger(track.fileSize) &&
      track.fileSize >= 0
    )
      totals.bytes += track.fileSize;
    else totals.unknownSizes++;
  }
  totals.albums = albums.size;
  totals.seconds = microseconds / 1e6;
  return totals;
}

/** Whole seconds/minutes below a day; days rounded to one decimal above it. */
export function formatCollectionDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 min";
  if (seconds < 1) return "<1 sec";
  if (seconds < 60) return `${Math.floor(seconds)} sec`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) {
    const minutes = Math.floor(seconds / 60) % 60;
    return `${Math.floor(seconds / 3600)} hr${minutes ? ` ${minutes} min` : ""}`;
  }
  const value = days.format(seconds / 86400);
  return `${value} ${value === "1" ? "day" : "days"}`;
}

/** Decimal SI units (1 MB = 1,000,000 bytes), at most two fractional digits. */
export function formatCollectionSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 MB";
  if (bytes < 10000) return "<0.01 MB";
  const [divisor, unit]: [number, string] =
    bytes >= 1e12 ? [1e12, "TB"] : bytes >= 1e9 ? [1e9, "GB"] : [1e6, "MB"];
  return `${decimal.format(bytes / divisor)} ${unit}`;
}

function knownAmount(
  amount: string,
  unknown: number,
  songs: number,
  label: string,
) {
  return !unknown
    ? amount
    : unknown === songs
      ? `${label} unknown`
      : `${amount} + unknown`;
}
export function collectionSummaryText(
  totals: CollectionTotals,
  kind: SummaryKind = "songs",
  playlists = 0,
) {
  const count =
    kind === "songs"
      ? totals.songs
      : kind === "albums"
        ? totals.albums
        : playlists;
  const parts = [
    `${integer.format(count)} ${count === 1 ? kind.slice(0, -1) : kind}`,
  ];
  if (kind === "songs")
    parts.push(
      knownAmount(
        formatCollectionDuration(totals.seconds),
        totals.unknownDurations,
        totals.songs,
        "Duration",
      ),
    );
  parts.push(
    knownAmount(
      formatCollectionSize(totals.bytes),
      totals.unknownSizes,
      totals.songs,
      "Size",
    ),
  );
  return parts.join(" · ");
}
