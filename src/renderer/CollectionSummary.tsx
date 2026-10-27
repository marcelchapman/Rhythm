import { useMemo } from "react";
import {
  collectionTotals,
  collectionSummaryText,
  type SummaryKind,
} from "../shared/collection-summary";
import type { Track } from "../shared/types";

/** Passive, pane-local collection information; independent of row selection. */
export function CollectionSummary({
  tracks,
  label,
  kind = "songs",
  playlists = 0,
}: {
  tracks: readonly Track[];
  label: string;
  kind?: SummaryKind;
  playlists?: number;
}) {
  const totals = useMemo(() => collectionTotals(tracks), [tracks]);
  const unknown = [
    totals.unknownDurations && kind === "songs"
      ? `Duration unknown for ${totals.unknownDurations} of ${totals.songs} songs.`
      : "",
    totals.unknownSizes
      ? `Size unknown for ${totals.unknownSizes} of ${totals.songs} songs.`
      : "",
    "Storage uses last indexed file sizes, including currently unavailable files. Decimal units: 1 MB = 1,000,000 bytes.",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div
      className="collection-summary"
      role="note"
      aria-label={`${label} summary`}
      title={unknown}
    >
      {collectionSummaryText(totals, kind, playlists)
        .split(" · ")
        .map((metric, index) => (
          <span key={index}>
            {index ? " · " : ""}
            {metric}
          </span>
        ))}
    </div>
  );
}
