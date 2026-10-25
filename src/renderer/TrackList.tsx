import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ArrowDown, Play, Heart, Activity } from "lucide-react";
import {
  moveTrackColumn,
  normalizeColumnOrder,
  minimumColumnWidth,
  type TrackListColumns,
  type TrackListPatch,
  type TrackColumnId,
} from "../shared/preferences";
import type { Track } from "../shared/types";
import {
  TRACK_COLUMNS,
  sortTracks,
  TRACK_DRAG_TYPE,
  type TrackSortKey,
} from "./track-columns";

const ROW = 34;
const COLUMN_DRAG_TYPE = "application/x-rhythm-song-column";

const time = (n: number) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
export function TrackList({
  tracks,
  currentId,
  playing,
  onPlay,
  onContext,
  onSelect,
  onFavorite,
  resetKey,
  presentation,
  onPresentationChange,
  label,
  ordered = false,
}: {
  tracks: Track[];
  currentId?: string;
  playing: boolean;
  onPlay: (track: Track, queue: Track[]) => void;
  onContext: (trackIds: string[], contextTrackId?: string) => void;
  onSelect: (track: Track) => void;
  onFavorite: (id: string) => void;
  resetKey: string;
  presentation: TrackListColumns;
  onPresentationChange: (patch: TrackListPatch) => void;
  label: string;
  ordered?: boolean;
}) {
  const [resizing, setResizing] = useState<{
    id: TrackColumnId;
    width: number;
  } | null>(null);
  const resizeRef = useRef<{
    id: TrackColumnId;
    startX: number;
    startWidth: number;
    width: number;
  } | null>(null);
  const columns = useMemo(
    () =>
      normalizeColumnOrder(presentation.order)
        .filter((id) => !presentation.hidden.includes(id))
        .map((id) => {
          const definition = TRACK_COLUMNS.find((c) => c.key === id)!;
          return {
            ...definition,
            width:
              resizing?.id === id
                ? resizing.width
                : (presentation.widths[id] ?? definition.width),
          };
        }),
    [presentation, resizing],
  );
  const gridTemplateColumns = columns.map((c) => `${c.width}px`).join(" ");
  const width = columns.reduce((sum, c) => sum + c.width, 0);
  const [dragged, setDragged] = useState<TrackColumnId | null>(null);
  const [drop, setDrop] = useState<{
    id: TrackColumnId;
    after: boolean;
  } | null>(null);
  const suppressSort = useRef(0);
  const [sort, setSort] = useState<{
    key: TrackSortKey;
    direction: 1 | -1;
  } | null>(ordered ? null : { key: "title", direction: 1 });
  const items = useMemo(
    () => (sort ? sortTracks(tracks, sort.key, sort.direction) : tracks),
    [tracks, sort],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef(0);
  useEffect(() => {
    const available = new Set(items.map((track) => track.id));
    setSelected((previous) => {
      const next = new Set([...previous].filter((id) => available.has(id)));
      return next.size === previous.size ? previous : next;
    });
    anchor.current = Math.min(anchor.current, Math.max(0, items.length - 1));
  }, [items]);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(500);
  const [viewportWidth, setViewportWidth] = useState(1000);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewport.current!;
    const observer = new ResizeObserver(() => {
      setHeight(el.clientHeight);
      setViewportWidth(el.clientWidth);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    viewport.current!.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey, sort]);
  const pinFirst = columns[0]?.width < viewportWidth;
  const start = Math.max(0, Math.floor(scrollTop / ROW) - 8);
  const end = Math.min(items.length, start + Math.ceil(height / ROW) + 17);
  const choose = (index: number, extend: boolean, toggle: boolean) => {
    const track = items[index];
    if (!track) return;
    setSelected((previous) => {
      if (extend)
        return new Set(
          items
            .slice(
              Math.min(anchor.current, index),
              Math.max(anchor.current, index) + 1,
            )
            .map((t) => t.id),
        );
      anchor.current = index;
      if (toggle) {
        const next = new Set(previous);
        if (next.has(track.id)) next.delete(track.id);
        else next.add(track.id);
        return next;
      }
      return new Set([track.id]);
    });
    onSelect(track);
  };
  const context = (track: Track) => {
    const ids = selected.has(track.id)
      ? items.filter((t) => selected.has(t.id)).map((t) => t.id)
      : [track.id];
    if (!selected.has(track.id)) setSelected(new Set(ids));
    onContext(ids, track.id);
  };
  const text = (track: Track, key: TrackSortKey) => {
    if (key === "duration") return time(track.duration);
    if (key === "bitRate")
      return track.bitRate ? `${Math.round(track.bitRate / 1000)} kbps` : "—";
    if (key === "codec")
      return track.codec
        ? `${track.format.toUpperCase()} · ${track.codec}`
        : track.format.toUpperCase();
    const value = track[key];
    return value === null || value === "" || value === 0 ? "—" : String(value);
  };
  return (
    <div className="songs-area">
      <div className="songs-caption">
        <span>
          {items.length.toLocaleString()}{" "}
          {items.length === 1 ? "track" : "tracks"}
          {selected.size
            ? ` · ${items.filter((t) => selected.has(t.id)).length} selected`
            : ""}
        </span>
        <span>
          {ordered && sort && (
            <button className="restore-order" onClick={() => setSort(null)}>
              Playlist order
            </button>
          )}
          Drag headers to reorder · Double-click to play
        </span>
      </div>
      <div
        className="songs-viewport"
        ref={viewport}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        tabIndex={0}
        aria-label={`${label} Track List, use arrow keys to select tracks`}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          const index = items.findIndex((t) => selected.has(t.id));
          if (
            e.key === "ArrowDown" ||
            e.key === "ArrowUp" ||
            e.key === "Home" ||
            e.key === "End"
          ) {
            e.preventDefault();
            const next =
              e.key === "Home"
                ? 0
                : e.key === "End"
                  ? items.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        items.length - 1,
                        index + (e.key === "ArrowDown" ? 1 : -1),
                      ),
                    );
            choose(next, e.shiftKey, false);
            const el = viewport.current!;
            if (next * ROW < el.scrollTop) el.scrollTop = next * ROW;
            else if ((next + 2) * ROW > el.scrollTop + el.clientHeight)
              el.scrollTop = (next + 2) * ROW - el.clientHeight;
          } else if (e.key === "Enter" && index >= 0) {
            e.preventDefault();
            onPlay(items[index], items);
          } else if (
            (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) &&
            index >= 0
          ) {
            e.preventDefault();
            context(items[index]);
          }
        }}
      >
        <div
          role="table"
          aria-label={label}
          aria-rowcount={items.length + 1}
          aria-colcount={columns.length}
          className="songs-table"
          style={{ width }}
        >
          <div
            role="row"
            className="songs-header"
            style={{ gridTemplateColumns }}
          >
            {columns.map((c, columnIndex) => (
              <div
                key={c.key}
                role="columnheader"
                aria-label={c.label}
                aria-sort={
                  sort?.key === c.key
                    ? sort.direction === 1
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                data-column-id={c.key}
                className={`${columnIndex === 0 && pinFirst ? "sticky-title" : ""} ${dragged === c.key ? "column-dragging" : ""} ${drop?.id === c.key ? (drop.after ? "column-drop-after" : "column-drop-before") : ""}`}
                onDragOver={(e) => {
                  if (
                    !dragged ||
                    !e.dataTransfer.types.includes(COLUMN_DRAG_TYPE)
                  )
                    return;
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  const bounds = e.currentTarget.getBoundingClientRect();
                  setDrop({
                    id: c.key,
                    after: e.clientX > bounds.left + bounds.width / 2,
                  });
                }}
                onDragLeave={() => setDrop(null)}
                onDrop={(e) => {
                  if (
                    !dragged ||
                    !e.dataTransfer.types.includes(COLUMN_DRAG_TYPE)
                  )
                    return;
                  e.preventDefault();
                  e.stopPropagation();
                  onPresentationChange({
                    order: moveTrackColumn(
                      presentation.order,
                      dragged,
                      c.key,
                      drop?.after ?? false,
                    ),
                  });
                  setDragged(null);
                  setDrop(null);
                  suppressSort.current = Date.now() + 200;
                }}
              >
                <button
                  draggable
                  onDragStart={(e) => {
                    if (resizeRef.current) {
                      e.preventDefault();
                      return;
                    }
                    e.stopPropagation();
                    setDragged(c.key);
                    e.dataTransfer.setData(COLUMN_DRAG_TYPE, c.key);
                    e.dataTransfer.effectAllowed = "move";
                    suppressSort.current = Infinity;
                  }}
                  onDragEnd={() => {
                    setDragged(null);
                    setDrop(null);
                    suppressSort.current = Date.now() + 200;
                  }}
                  title="Drag to reorder · Click to sort"
                  onClick={() => {
                    if (resizeRef.current || Date.now() < suppressSort.current)
                      return;
                    setSort((s) => ({
                      key: c.key,
                      direction: s?.key === c.key && s.direction === 1 ? -1 : 1,
                    }));
                  }}
                >
                  {c.label}
                  {sort?.key === c.key &&
                    (sort.direction === 1 ? (
                      <ArrowUp size={12} />
                    ) : (
                      <ArrowDown size={12} />
                    ))}
                </button>
                <span
                  role="separator"
                  aria-label={`Resize ${c.label}`}
                  aria-orientation="vertical"
                  aria-valuenow={Math.round(c.width)}
                  aria-valuemin={minimumColumnWidth(c.key)}
                  aria-valuemax={1200}
                  tabIndex={0}
                  className={`column-resize ${resizing?.id === c.key ? "resizing" : ""}`}
                  onClick={(e) => e.stopPropagation()}
                  onDragStart={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                  }}
                  onPointerDown={(e) => {
                    if (e.button !== 0) return;
                    e.preventDefault();
                    e.stopPropagation();
                    e.currentTarget.setPointerCapture(e.pointerId);
                    resizeRef.current = {
                      id: c.key,
                      startX: e.clientX,
                      startWidth: c.width,
                      width: c.width,
                    };
                    setResizing({ id: c.key, width: c.width });
                    suppressSort.current = Infinity;
                  }}
                  onPointerMove={(e) => {
                    const resize = resizeRef.current;
                    if (!resize) return;
                    resize.width = Math.round(
                      Math.max(
                        minimumColumnWidth(resize.id),
                        Math.min(
                          1200,
                          resize.startWidth + e.clientX - resize.startX,
                        ),
                      ),
                    );
                    setResizing({ id: resize.id, width: resize.width });
                  }}
                  onPointerUp={(e) => {
                    const resize = resizeRef.current;
                    if (!resize) return;
                    e.stopPropagation();
                    resizeRef.current = null;
                    // Pointer moves may be coalesced; release is the final position.
                    const finalWidth = Math.round(
                      Math.max(
                        minimumColumnWidth(resize.id),
                        Math.min(
                          1200,
                          resize.startWidth + e.clientX - resize.startX,
                        ),
                      ),
                    );
                    onPresentationChange({
                      widths: { [resize.id]: finalWidth },
                    });
                    setResizing(null);
                    suppressSort.current = Date.now() + 200;
                  }}
                  onPointerCancel={() => {
                    resizeRef.current = null;
                    setResizing(null);
                    suppressSort.current = Date.now() + 200;
                  }}
                  onKeyDown={(e) => {
                    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                    e.preventDefault();
                    e.stopPropagation();
                    onPresentationChange({
                      widths: {
                        [c.key]: Math.max(
                          minimumColumnWidth(c.key),
                          Math.min(
                            1200,
                            c.width + (e.key === "ArrowRight" ? 10 : -10),
                          ),
                        ),
                      },
                    });
                  }}
                />
              </div>
            ))}
          </div>
          <div
            role="rowgroup"
            style={{ height: items.length * ROW, position: "relative" }}
          >
            {items.slice(start, end).map((track, offset) => {
              const index = start + offset;
              return (
                <div
                  role="row"
                  aria-rowindex={index + 2}
                  aria-selected={selected.has(track.id)}
                  data-track-id={track.id}
                  key={track.id}
                  className={`song-row ${selected.has(track.id) ? "selected" : ""} ${currentId === track.id ? "is-playing" : ""} ${track.missing ? "is-missing" : ""}`}
                  style={{ gridTemplateColumns, top: index * ROW }}
                  draggable
                  onDragStart={(e) => {
                    const ids = selected.has(track.id)
                      ? items.filter((t) => selected.has(t.id)).map((t) => t.id)
                      : [track.id];
                    e.dataTransfer.setData(
                      TRACK_DRAG_TYPE,
                      JSON.stringify(ids),
                    );
                    e.dataTransfer.effectAllowed = "copy";
                  }}
                  onClick={(e) => {
                    viewport.current?.focus();
                    choose(index, e.shiftKey, e.metaKey || e.ctrlKey);
                  }}
                  onDoubleClick={() => onPlay(track, items)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    context(track);
                  }}
                >
                  {columns.map((c, columnIndex) => (
                    <div
                      role="cell"
                      className={`${columnIndex === 0 && pinFirst ? "sticky-title" : ""} ${c.key === "title" ? "song-title" : ""} ${["duration", "bpm", "bitRate", "disc", "track"].includes(c.key) ? "numeric" : ""}`}
                      key={c.key}
                      title={
                        c.key === "title"
                          ? `${track.title}${track.missing ? " · File unavailable" : ""}`
                          : text(track, c.key)
                      }
                    >
                      {c.key === "title" ? (
                        <>
                          <button
                            className="song-play"
                            disabled={track.missing}
                            aria-label={`Play ${track.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onPlay(track, items);
                            }}
                          >
                            {currentId === track.id && playing ? (
                              <Activity size={14} />
                            ) : (
                              <Play size={13} />
                            )}
                          </button>
                          <span>{track.title}</span>
                          <button
                            className={`song-heart ${track.favorite ? "active" : ""}`}
                            aria-label={`${track.favorite ? "Unfavourite" : "Favourite"} ${track.title}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              onFavorite(track.id);
                            }}
                          >
                            <Heart
                              size={12}
                              fill={track.favorite ? "currentColor" : "none"}
                            />
                          </button>
                          {track.missing && (
                            <span className="missing-mark">Unavailable</span>
                          )}
                        </>
                      ) : (
                        text(track, c.key)
                      )}
                    </div>
                  ))}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
