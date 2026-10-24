// One application-wide Track List presentation, independent of library/content state.
export const TRACK_COLUMN_IDS = [
  "title",
  "duration",
  "artist",
  "album",
  "genre",
  "bpm",
  "bitRate",
  "codec",
  "disc",
  "track",
  "comments",
  "year",
] as const;
export type TrackColumnId = (typeof TRACK_COLUMN_IDS)[number];
export interface TrackListColumns {
  order: TrackColumnId[];
  widths: Partial<Record<TrackColumnId, number>>;
  hidden: TrackColumnId[];
}
export interface ViewPreferences {
  version: 2;
  trackList: { columns: TrackListColumns };
}
export type TrackListPatch = Partial<TrackListColumns>;
export const minimumColumnWidth = (id: TrackColumnId) =>
  id === "title"
    ? 160
    : ["artist", "album", "comments", "codec"].includes(id)
      ? 100
      : 60;
export function normalizeColumnOrder(value: unknown): TrackColumnId[] {
  const valid = Array.isArray(value)
    ? value.filter((id): id is TrackColumnId => TRACK_COLUMN_IDS.includes(id))
    : [];
  return [...new Set([...valid, ...TRACK_COLUMN_IDS])];
}
export function normalizeViewPreferences(value?: unknown): ViewPreferences {
  const data = value as {
    trackList?: { columns?: Partial<TrackListColumns> };
    songs?: { columns?: Partial<TrackListColumns> };
  } | null;
  const columns = data?.trackList?.columns ?? data?.songs?.columns;
  const widths: TrackListColumns["widths"] = {};
  for (const id of TRACK_COLUMN_IDS) {
    const width = columns?.widths?.[id];
    if (typeof width === "number" && Number.isFinite(width))
      widths[id] = Math.round(
        Math.max(minimumColumnWidth(id), Math.min(1200, width)),
      );
  }
  const hidden = Array.isArray(columns?.hidden)
    ? [
        ...new Set(
          columns.hidden.filter(
            (id) => TRACK_COLUMN_IDS.includes(id) && id !== "title",
          ),
        ),
      ]
    : [];
  return {
    version: 2,
    trackList: {
      columns: { order: normalizeColumnOrder(columns?.order), widths, hidden },
    },
  };
}
export function patchTrackListPreferences(
  value: ViewPreferences,
  patch: TrackListPatch,
): ViewPreferences {
  const previous = value.trackList.columns;
  return normalizeViewPreferences({
    trackList: {
      columns: {
        ...previous,
        ...patch,
        widths: { ...previous.widths, ...patch.widths },
      },
    },
  });
}
export function moveTrackColumn(
  order: TrackColumnId[],
  source: TrackColumnId,
  target: TrackColumnId,
  after = false,
): TrackColumnId[] {
  const current = normalizeColumnOrder(order);
  if (
    source === target ||
    !current.includes(source) ||
    !current.includes(target)
  )
    return current;
  const rest = current.filter((id) => id !== source);
  rest.splice(rest.indexOf(target) + Number(after), 0, source);
  return rest;
}
