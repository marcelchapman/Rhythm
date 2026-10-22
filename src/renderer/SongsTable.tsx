import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowDown,
  Play,
  Heart,
  MoreHorizontal,
  Activity,
} from "lucide-react";
import type { Track } from "../shared/types";
import {
  SONG_COLUMNS,
  sortSongs,
  TRACK_DRAG_TYPE,
  type SongSortKey,
} from "./song-columns";

const ROW = 34;
const gridTemplateColumns = `${SONG_COLUMNS.map((c) => `${c.width}px`).join(" ")} 42px`;
const width = SONG_COLUMNS.reduce((sum, c) => sum + c.width, 42);
const time = (n: number) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
export function SongsTable({
  tracks,
  currentId,
  playing,
  onPlay,
  onContext,
  onOptions,
  onSelect,
  onFavorite,
  resetKey,
}: {
  tracks: Track[];
  currentId?: string;
  playing: boolean;
  onPlay: (track: Track, queue: Track[]) => void;
  onContext: (trackIds: string[]) => void;
  onOptions: (track: Track) => void;
  onSelect: (track: Track) => void;
  onFavorite: (id: string) => void;
  resetKey: string;
}) {
  const [sort, setSort] = useState<{ key: SongSortKey; direction: 1 | -1 }>({
    key: "title",
    direction: 1,
  });
  const items = useMemo(
    () => sortSongs(tracks, sort.key, sort.direction),
    [tracks, sort],
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const anchor = useRef(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(500);
  const viewport = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = viewport.current!;
    const observer = new ResizeObserver(() => setHeight(el.clientHeight));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    viewport.current!.scrollTop = 0;
    setScrollTop(0);
  }, [resetKey, sort]);
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
    onContext(ids);
  };
  const text = (track: Track, key: SongSortKey) => {
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
          {items.length.toLocaleString()} songs
          {selected.size
            ? ` · ${items.filter((t) => selected.has(t.id)).length} selected`
            : ""}
        </span>
        <span>Double-click to play · Right-click for actions</span>
      </div>
      <div
        className="songs-viewport"
        ref={viewport}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
        tabIndex={0}
        aria-label="Songs table, use arrow keys to select tracks"
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
          aria-label="Songs"
          aria-rowcount={items.length + 1}
          aria-colcount={SONG_COLUMNS.length + 1}
          className="songs-table"
          style={{ width }}
        >
          <div
            role="row"
            className="songs-header"
            style={{ gridTemplateColumns }}
          >
            {SONG_COLUMNS.map((c) => (
              <div
                key={c.key}
                role="columnheader"
                aria-sort={
                  sort.key === c.key
                    ? sort.direction === 1
                      ? "ascending"
                      : "descending"
                    : "none"
                }
                className={c.key === "title" ? "sticky-title" : ""}
              >
                <button
                  onClick={() =>
                    setSort((s) => ({
                      key: c.key,
                      direction: s.key === c.key && s.direction === 1 ? -1 : 1,
                    }))
                  }
                >
                  {c.label}
                  {sort.key === c.key &&
                    (sort.direction === 1 ? (
                      <ArrowUp size={12} />
                    ) : (
                      <ArrowDown size={12} />
                    ))}
                </button>
              </div>
            ))}
            <div role="columnheader" aria-label="Actions" />
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
                  {SONG_COLUMNS.map((c) => (
                    <div
                      role="cell"
                      className={`${c.key === "title" ? "sticky-title song-title" : ""} ${["duration", "bpm", "bitRate", "disc", "track"].includes(c.key) ? "numeric" : ""}`}
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
                  <div role="cell">
                    <button
                      className="icon-button song-options"
                      aria-label={`Options for ${track.title}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onOptions(track);
                      }}
                    >
                      <MoreHorizontal size={16} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
