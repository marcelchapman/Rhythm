import type { Track } from "../shared/types";
import { metadataChanges, type MetadataDraft } from "../shared/metadata-editor";
import type { TrackColumnId } from "../shared/preferences";

// Only existing table columns. Complex fields remain in Track Info.
export const inlineFields = {
  title: "title",
  artist: "artist",
  album: "album",
  genre: "genre",
  year: "year",
  track: "trackNumber",
  disc: "discNumber",
  bpm: "bpm",
} as const;
export type InlineColumn = keyof typeof inlineFields;
export const inlineColumn = (column: TrackColumnId): column is InlineColumn =>
  Object.hasOwn(inlineFields, column);
/** Presentation hint only; main repeats all authoritative eligibility checks. */
export const inlineCandidate = (track: Track) =>
  track.locationKind === "managed" &&
  track.format.toLowerCase() === "flac" &&
  !track.missing;
export function inlinePatch(
  before: MetadataDraft,
  column: InlineColumn,
  value: string,
) {
  const field = inlineFields[column];
  const patch = metadataChanges(before, { ...before, [field]: value });
  const edit = patch[field];
  // Numeric spelling alone (e.g. 02 -> 2) is not a metadata change.
  if (
    edit?.action === "set" &&
    typeof edit.value === "number" &&
    Number(before[field]) === edit.value
  )
    return {};
  return patch;
}
export interface InlineCell {
  id: string;
  column: InlineColumn;
}
/** Walk the displayed order without allocating a cell for every track. */
export function* inlineDestinations(
  tracks: Track[],
  columns: TrackColumnId[],
  current: InlineCell,
  direction: 1 | -1,
  skipTrack = false,
): Generator<InlineCell, undefined> {
  const editable = columns.filter(inlineColumn);
  const row = tracks.findIndex((track) => track.id === current.id);
  const column = editable.indexOf(current.column);
  if (row < 0 || column < 0) return;
  const edge = direction === 1 ? 0 : editable.length - 1;
  for (
    let index = row;
    index >= 0 && index < tracks.length;
    index += direction
  ) {
    const track = tracks[index];
    if (!inlineCandidate(track) || (skipTrack && index === row)) continue;
    for (
      let i = index === row ? column + direction : edge;
      i >= 0 && i < editable.length;
      i += direction
    )
      yield { id: track.id, column: editable[i] };
  }
}
