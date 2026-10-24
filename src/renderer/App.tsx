import { TrackList } from "./TrackList";
import { TRACK_COLUMNS } from "./track-columns";
import {
  patchTrackListPreferences,
  type TrackListPatch,
} from "../shared/preferences";
import type { DesktopPlaylistEvent } from "../shared/types";
import type { PlaylistImportResult } from "../shared/types";
import { TRACK_DRAG_TYPE, dragTrackIds } from "./track-columns";
import type { TrackAction } from "../shared/types";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  Home,
  Search,
  Disc3,
  UserRound,
  Music2,
  LayoutGrid,
  ListMusic,
  Clock3,
  Heart,
  Plus,
  ChevronLeft,
  ChevronRight,
  MoreHorizontal,
  Play,
  Pause,
  SkipBack,
  SkipForward,
  Shuffle,
  Repeat,
  Repeat1,
  Volume2,
  VolumeX,
  List,
  FolderPlus,
  FolderOpen,
  RefreshCw,
  X,
  Check,
  AlertCircle,
  Settings2,
  LoaderCircle,
} from "lucide-react";
import {
  defaultState,
  type Track,
  type Playlist,
  type Snapshot,
  type PlayerState,
  type ScanResult,
} from "../shared/types";

const api = window.rhythm;
const time = (seconds: number) => {
  const n = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};
const media = (t: Track) => `rhythm-media://track/${t.id}`;
const nav = [
  ["Albums", Disc3],
  ["Artists", UserRound],
  ["Songs", Music2],
  ["Genres", LayoutGrid],
  ["Playlists", ListMusic],
  ["Recently Added", Clock3],
  ["Favourites", Heart],
] as const;
interface Album {
  id: string;
  name: string;
  artist: string;
  tracks: Track[];
  added: number;
}
function Art({ track, className = "" }: { track?: Track; className?: string }) {
  return track?.hasArtwork ? (
    <img
      className={`art ${className}`}
      src={`rhythm-media://artwork/${track.id}`}
      alt={`${track.album} artwork`}
      loading="lazy"
    />
  ) : (
    <div
      className={`art art-placeholder ${className}`}
      aria-label="No album artwork"
    >
      <Disc3 strokeWidth={1} />
    </div>
  );
}
function IconButton({
  label,
  children,
  active,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      className={`icon-button ${active ? "active" : ""}`}
      aria-label={label}
      title={label}
      aria-pressed={active === undefined ? undefined : active}
      {...props}
    >
      {children}
    </button>
  );
}
function Modal({
  title,
  children,
  close,
}: {
  title: string;
  children: ReactNode;
  close: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current!;
    const elements = () => [
      ...root.querySelectorAll<HTMLElement>(
        'button:not(:disabled), input:not(:disabled), select:not(:disabled), [tabindex="0"]',
      ),
    ];
    (
      root.querySelector<HTMLElement>(
        "input:not(:disabled), select:not(:disabled)",
      ) ?? elements()[0]
    )?.focus();
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeRef.current();
      if (e.key === "Tab") {
        const all = elements();
        const first = all[0];
        const last = all.at(-1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    root.addEventListener("keydown", handler);
    return () => {
      root.removeEventListener("keydown", handler);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={ref}
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
      >
        <header>
          <h2 id="modal-title">{title}</h2>
          <IconButton label="Close dialog" onClick={close}>
            <X />
          </IconButton>
        </header>
        {children}
      </div>
    </div>
  );
}

export function App() {
  const preferenceRequest = useRef(0);
  const desktopEventRef = useRef<(event: DesktopPlaylistEvent) => void>(
    () => {},
  );
  const playlistCommandRef = useRef<(command: string) => void>(() => {});
  const [playlistReport, setPlaylistReport] = useState<PlaylistImportResult[]>(
    [],
  );
  const [exportPlaylistId, setExportPlaylistId] = useState("");
  const [message, setMessage] = useState("");
  const [pendingPlaylistTracks, setPendingPlaylistTracks] = useState<string[]>(
    [],
  );
  const [detailLimit, setDetailLimit] = useState(200);
  const [fileDrag, setFileDrag] = useState(false);
  const [dropPlaylist, setDropPlaylist] = useState<string | null>(null);
  const dragDepth = useRef(0);
  const trackActionRef = useRef<(action: TrackAction) => void>(() => {});
  const [data, setData] = useState<Snapshot | null>(null);
  const [state, setState] = useState<PlayerState>(defaultState);
  const [playing, setPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);
  const [view, setView] = useState("Home");
  const [history, setHistory] = useState(["Home"]);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("az");
  const [genre, setGenre] = useState("All Genres");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [group, setGroup] = useState<string | null>(null);
  const [selectedAlbum, setSelectedAlbum] = useState<string | null>(null);
  const [showQueue, setShowQueue] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [report, setReport] = useState<ScanResult | null>(null);
  const [modal, setModal] = useState<
    "settings" | "playlist" | "track" | "delete" | "export-playlist" | null
  >(null);
  const [editPlaylist, setEditPlaylist] = useState<Playlist | null>(null);
  const [name, setName] = useState("");
  const [actionTrack, setActionTrack] = useState<Track | null>(null);
  const [targetPlaylist, setTargetPlaylist] = useState("");
  const audio = useRef<HTMLAudioElement>(null);
  const stateRef = useRef(state);
  const dataRef = useRef(data);
  const playingRef = useRef(false);
  const resume = useRef(0);
  const desiredPlay = useRef(false);
  const suppressSave = useRef(true);
  const searchRef = useRef<HTMLInputElement>(null);
  stateRef.current = { ...state, view };
  dataRef.current = data;
  playingRef.current = playing;
  const tracks = data?.tracks ?? [];
  const byId = useMemo(() => new Map(tracks.map((t) => [t.id, t])), [tracks]);
  const current = state.currentId ? byId.get(state.currentId) : undefined;
  const albums = useMemo(() => {
    const map = new Map<string, Album>();
    for (const track of tracks) {
      let album = map.get(track.albumId);
      if (!album) {
        album = {
          id: track.albumId,
          name: track.album,
          artist: track.albumArtist,
          tracks: [],
          added: track.addedAt,
        };
        map.set(track.albumId, album);
      }
      album.tracks.push(track);
      album.added = Math.max(album.added, track.addedAt);
    }
    return [...map.values()];
  }, [tracks]);
  const rightAlbum =
    albums.find((a) => a.id === selectedAlbum) ??
    albums.find((a) => a.id === current?.albumId);
  useEffect(
    () => setDetailLimit(200),
    [selectedAlbum, current?.albumId, showQueue],
  );
  const activePlaylist = data?.playlists.find(
    (p) => `playlist:${p.id}` === view,
  );
  const title = activePlaylist?.name ?? (query ? "Search results" : view);
  const favorite = async (id: string) => {
    try {
      await api.favorite(id);
      await refresh();
    } catch (e) {
      fail(e);
    }
  };
  const fail = (e: unknown) =>
    setError(
      e instanceof Error
        ? e.message.replace(
            /^Error invoking remote method '[^']+': Error: /,
            "",
          )
        : String(e),
    );
  const refresh = async () => {
    const snapshot = await api.snapshot();
    setData(snapshot);
    return snapshot;
  };
  const load = (snapshot: Snapshot) => {
    suppressSave.current = true;
    desiredPlay.current = false;
    audio.current?.pause();
    setPlaying(false);
    setData(snapshot);
    setState(snapshot.state);
    resume.current = snapshot.state.position;
    setPosition(snapshot.state.position);
    setView(snapshot.state.view);
    setHistory([snapshot.state.view]);
    setHistoryIndex(0);
    setSelectedAlbum(null);
    setGroup(null);
    setQuery("");
    setShowQueue(false);
    void api.desktopReady().catch(fail);
    setTimeout(() => {
      suppressSave.current = false;
    }, 100);
  };
  useEffect(
    () => api.onDesktopPlaylist((event) => desktopEventRef.current(event)),
    [],
  );
  useEffect(() => {
    api.snapshot().then(load).catch(fail);
    return api.onProgress((p) =>
      setProgress(`${p.scanned} files checked · ${p.current}`),
    );
  }, []);
  useEffect(() => {
    if (!data?.libraryPath || suppressSave.current) return;
    const timer = setTimeout(() => {
      void api.saveState({ ...state, view }).catch(fail);
    }, 350);
    return () => clearTimeout(timer);
  }, [state, view, data?.libraryPath]);
  useEffect(() => {
    const a = audio.current!;
    a.volume = state.volume;
  }, [state.volume]);
  useEffect(() => {
    const a = audio.current!;
    if (!current) {
      a.removeAttribute("src");
      a.load();
      setPlaying(false);
      setDuration(0);
      return;
    }
    a.src = media(current);
    a.load();
    setDuration(current.duration);
    const ready = () => {
      if (resume.current) {
        a.currentTime = Math.min(
          resume.current,
          Number.isFinite(a.duration) ? a.duration : resume.current,
        );
        resume.current = 0;
      }
      if (desiredPlay.current) void a.play().catch(fail);
    };
    a.addEventListener("loadedmetadata", ready, { once: true });
    return () => {
      a.removeEventListener("loadedmetadata", ready);
    };
  }, [current?.id, data?.libraryPath]);
  useEffect(() => {
    const timer = setInterval(() => {
      if (
        dataRef.current?.libraryPath &&
        audio.current &&
        !suppressSave.current
      )
        void api
          .saveState({
            ...stateRef.current,
            position: audio.current.currentTime || 0,
          })
          .catch(fail);
    }, 4000);
    const save = () => {
      if (dataRef.current?.libraryPath)
        void api
          .saveState({
            ...stateRef.current,
            position: audio.current?.currentTime || 0,
          })
          .catch(() => {});
    };
    window.addEventListener("beforeunload", save);
    return () => {
      clearInterval(timer);
      window.removeEventListener("beforeunload", save);
    };
  }, []);

  const navigate = (next: string) => {
    setQuery("");
    setGroup(null);
    setView(next);
    setHistory((h) => [...h.slice(0, historyIndex + 1), next]);
    setHistoryIndex((i) => i + 1);
  };
  const goHistory = (index: number) => {
    setHistoryIndex(index);
    setView(history[index]);
    setQuery("");
    setGroup(null);
  };
  const playTrack = (track: Track, queue?: Track[]) => {
    if (track.missing) {
      setError(
        "This music file is unavailable. Reconnect its drive or restore the file, then rescan.",
      );
      return;
    }
    desiredPlay.current = true;
    resume.current = 0;
    setPosition(0);
    const ids = (queue ?? [track]).filter((t) => !t.missing).map((t) => t.id);
    if (track.id === stateRef.current.currentId) {
      audio.current!.currentTime = 0;
      void audio.current!.play().catch(fail);
    }
    setState((s) => ({ ...s, currentId: track.id, position: 0, queue: ids }));
  };
  const toggle = () => {
    if (!stateRef.current.currentId) {
      const available = dataRef.current?.tracks ?? [];
      const queued = stateRef.current.queue
        .map((id) => available.find((t) => t.id === id))
        .filter((t): t is Track => !!t && !t.missing);
      const items = queued.length ? queued : available;
      const t = items.find((t) => !t.missing);
      if (t) playTrack(t, items);
      return;
    }
    if (audio.current!.paused) {
      desiredPlay.current = true;
      void audio.current!.play().catch(fail);
    } else {
      desiredPlay.current = false;
      audio.current!.pause();
    }
  };
  const advance = (direction: number, ended = false) => {
    const s = stateRef.current;
    const a = audio.current!;
    if (direction < 0 && a.currentTime > 3) {
      a.currentTime = 0;
      return;
    }
    if (ended && s.repeat === "one") {
      a.currentTime = 0;
      void a.play().catch(fail);
      return;
    }
    const valid = s.queue.filter((id) => {
      const t = dataRef.current?.tracks.find((t) => t.id === id);
      return t && !t.missing;
    });
    if (!valid.length) {
      setPlaying(false);
      return;
    }
    const index = valid.indexOf(s.currentId ?? "");
    let next = index + direction;
    if (s.shuffle && direction > 0 && valid.length > 1) {
      const others = valid.filter((id) => id !== s.currentId);
      next = valid.indexOf(others[Math.floor(Math.random() * others.length)]);
    }
    if (next >= valid.length || next < 0) {
      if (s.repeat === "all" || !ended)
        next = (next + valid.length) % valid.length;
      else {
        desiredPlay.current = false;
        setPlaying(false);
        return;
      }
    }
    const id = valid[next];
    desiredPlay.current = ended || playingRef.current;
    resume.current = 0;
    if (id === s.currentId) {
      a.currentTime = 0;
      if (desiredPlay.current) void a.play().catch(fail);
    }
    setPosition(0);
    setState((prev) => ({ ...prev, currentId: id, position: 0 }));
  };
  const chooseLibrary = async () => {
    try {
      const snapshot = await api.chooseLibrary();
      if (snapshot) load(snapshot);
    } catch (e) {
      fail(e);
    }
  };
  const scan = async (rescan = false) => {
    setBusy(true);
    setError("");
    setProgress(rescan ? "Checking music folders…" : "Choose folders to add…");
    try {
      const result = await (rescan ? api.rescan() : api.importMusic());
      if (result) {
        setReport(result);
        await refresh();
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  useEffect(
    () =>
      api.onCommand((command) => {
        if (command === "toggle") {
          if (
            !["INPUT", "TEXTAREA", "SELECT"].includes(
              document.activeElement?.tagName ?? "",
            )
          )
            toggle();
        } else if (command === "next") advance(1);
        else if (command === "previous") advance(-1);
        else if (command === "import") {
          if (dataRef.current?.libraryPath) void scan();
          else void chooseLibrary();
        } else if (command === "new-playlist") {
          if (dataRef.current?.libraryPath) makePlaylist();
          else setError("Choose a library folder before creating playlists.");
        } else if (
          command === "import-playlist" ||
          command === "export-playlist"
        ) {
          playlistCommandRef.current(command);
        } else if (command === "choose-library") void chooseLibrary();
      }),
    [],
  );
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (
        e.code === "Space" &&
        !modal &&
        !["INPUT", "TEXTAREA", "SELECT", "BUTTON", "SUMMARY"].includes(
          document.activeElement?.tagName ?? "",
        )
      ) {
        e.preventDefault();
        toggle();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [modal]);
  useEffect(() => {
    if ("mediaSession" in navigator && current) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist,
        album: current.album,
      });
      navigator.mediaSession.setActionHandler("play", () => {
        void audio.current!.play().catch(fail);
      });
      navigator.mediaSession.setActionHandler("pause", () =>
        audio.current!.pause(),
      );
      navigator.mediaSession.setActionHandler("nexttrack", () => advance(1));
      navigator.mediaSession.setActionHandler("previoustrack", () =>
        advance(-1),
      );
    }
  }, [current?.id]);

  const visible = useMemo(() => {
    let visible = tracks;
    if (activePlaylist)
      visible = activePlaylist.trackIds
        .map((id) => byId.get(id))
        .filter((t): t is Track => !!t);
    if (view === "Favourites") visible = visible.filter((t) => t.favorite);
    if (view === "Artists" && group)
      visible = visible.filter(
        (t) => t.artist === group || t.albumArtist === group,
      );
    if (view === "Genres" && group)
      visible = visible.filter((t) => t.genre.split(", ").includes(group));
    if (genre !== "All Genres")
      visible = visible.filter((t) => t.genre.split(", ").includes(genre));
    const q = query.toLocaleLowerCase().trim();
    if (q)
      visible = tracks.filter((t) =>
        [
          t.title,
          t.artist,
          t.album,
          t.albumArtist,
          t.genre,
          t.comments,
          t.codec,
        ].some((v) => v.toLocaleLowerCase().includes(q)),
      );
    visible = [...visible];
    if (!activePlaylist && (view === "Recently Added" || sort === "recent"))
      visible.sort((a, b) => b.addedAt - a.addedAt);
    else if (!activePlaylist)
      visible.sort((a, b) =>
        sort === "year"
          ? b.year - a.year || a.album.localeCompare(b.album)
          : a.album.localeCompare(b.album) ||
            a.disc - b.disc ||
            a.track - b.track ||
            a.title.localeCompare(b.title),
      );
    return visible;
  }, [tracks, activePlaylist, view, group, genre, query, sort, byId]);
  const visibleAlbums = useMemo(() => {
    const visibleIds = new Set(visible.map((t) => t.albumId));
    const result = albums
      .filter((a) => visibleIds.has(a.id))
      .sort((a, b) =>
        sort === "recent" || view === "Recently Added"
          ? b.added - a.added
          : sort === "year"
            ? b.tracks[0].year - a.tracks[0].year
            : a.name.localeCompare(b.name),
      );
    return result;
  }, [visible, albums, sort, view]);
  const groups = useMemo(
    () =>
      [
        ...new Set(
          tracks.flatMap((t) =>
            view === "Artists" ? [t.artist] : t.genre.split(", "),
          ),
        ),
      ].sort((a, b) => a.localeCompare(b)),
    [tracks, view],
  );
  const genres = useMemo(
    () => [...new Set(tracks.flatMap((t) => t.genre.split(", ")))].sort(),
    [tracks],
  );
  const makePlaylist = (p: Playlist | null = null, trackIds: string[] = []) => {
    setPendingPlaylistTracks(trackIds);
    setEditPlaylist(p);
    setName(p?.name ?? "");
    setModal("playlist");
  };
  const trackActions = (track: Track) => {
    setActionTrack(track);
    setTargetPlaylist("");
    setModal("track");
  };
  const appendToPlaylist = async (id: string, ids: string[]) => {
    try {
      await api.addToPlaylist(id, ids);
      const latest = await refresh();
      const p = latest.playlists.find((p) => p.id === id);
      setMessage(`Songs are in “${p?.name ?? "your playlist"}”.`);
      setModal(null);
    } catch (e) {
      fail(e);
    }
  };
  const queueTracks = (items: Track[], next: boolean) => {
    setState((s) => {
      const incoming = [
        ...new Set(
          items
            .filter((t) => !t.missing && t.id !== s.currentId)
            .map((t) => t.id),
        ),
      ];
      const remove = new Set(incoming);
      const queue = s.queue.filter((id) => !remove.has(id));
      queue.splice(
        next ? queue.indexOf(s.currentId ?? "") + 1 : queue.length,
        0,
        ...incoming,
      );
      return { ...s, queue };
    });
    setShowQueue(true);
    setModal(null);
  };
  const queueTrack = (track: Track, next: boolean) =>
    queueTracks([track], next);
  trackActionRef.current = (action) => {
    const items = action.trackIds
      .map((id) => byId.get(id))
      .filter((t): t is Track => !!t);
    if (!items.length) return;
    if (action.command === "play")
      playTrack(items.find((t) => !t.missing) ?? items[0], items);
    else if (action.command === "next" || action.command === "queue")
      queueTracks(items, action.command === "next");
    else if (action.command === "playlist" && action.playlistId)
      void appendToPlaylist(action.playlistId, action.trackIds);
    else if (action.command === "new-playlist")
      makePlaylist(null, action.trackIds);
    else if (action.command === "favorite")
      void (async () => {
        try {
          const target = !items.every((t) => t.favorite);
          for (const t of items)
            if (t.favorite !== target) await api.favorite(t.id);
          await refresh();
        } catch (e) {
          fail(e);
        }
      })();
  };
  useEffect(
    () => api.onTrackAction((action) => trackActionRef.current(action)),
    [],
  );
  const showTrackMenu = (ids: string[]) => {
    void api.showTrackMenu(ids).catch(fail);
  };
  const importDrop = async (files: File[]) => {
    if (!dataRef.current?.libraryPath) {
      setError("Choose a library folder before dropping music.");
      return;
    }
    if (busy) {
      setError("Wait for the current import to finish.");
      return;
    }
    setBusy(true);
    setProgress("Reading dropped files and folders…");
    setError("");
    try {
      const result = await api.importDroppedFiles(files);
      setReport(
        result.playlists.length
          ? result.added || result.updated || result.errors.length
            ? result
            : null
          : result,
      );
      if (result.playlists.length) {
        setPlaylistReport(result.playlists);
        navigate(`playlist:${result.playlists.at(-1)!.playlist.id}`);
      }
      if (result.playlistErrors.length)
        setError(result.playlistErrors.join(" · "));
      await refresh();
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  const savePresentation = (patch: TrackListPatch) => {
    const request = ++preferenceRequest.current;
    setData((previous) =>
      previous
        ? {
            ...previous,
            preferences: patchTrackListPreferences(previous.preferences, patch),
          }
        : previous,
    );
    void api
      .saveTrackListPreferences(patch)
      .then((preferences) => {
        if (request === preferenceRequest.current)
          setData((previous) =>
            previous ? { ...previous, preferences } : previous,
          );
      })
      .catch((e) => {
        fail(e);
        void refresh();
      });
  };
  desktopEventRef.current = (event) => {
    if ("waiting" in event) {
      setMessage(
        `${event.waiting} playlist${event.waiting === 1 ? " is" : "s are"} waiting. Choose a library folder to import.`,
      );
      return;
    }
    if ("error" in event) {
      setError(event.error);
      return;
    }
    void refresh()
      .then(() => {
        setPlaylistReport((previous) => [...previous, event.result]);
        setMessage("");
        navigate(`playlist:${event.result.playlist.id}`);
      })
      .catch(fail);
  };
  const exportPlaylist = async (id: string) => {
    if (busy) return;
    setBusy(true);
    setProgress("Choose where to export your playlist…");
    setError("");
    try {
      const result = await api.exportPlaylist(id);
      if (result) {
        setModal(null);
        setMessage(
          `Exported ${result.count} songs as M3U8.${result.unavailable ? ` ${result.unavailable} references are currently unavailable.` : ""}`,
        );
      }
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  playlistCommandRef.current = (command) => {
    if (!data?.libraryPath) {
      setError(
        "Choose a library folder before importing or exporting playlists.",
      );
      return;
    }
    if (busy) {
      setError("Wait for the current import/export to finish.");
      return;
    }
    if (command === "export-playlist") {
      if (activePlaylist) void exportPlaylist(activePlaylist.id);
      else if (data.playlists.length) {
        setExportPlaylistId(data.playlists[0].id);
        setModal("export-playlist");
      } else setError("Create or import a playlist before exporting.");
      return;
    }
    void (async () => {
      setBusy(true);
      setProgress("Choose an M3U or M3U8 playlist…");
      setError("");
      try {
        const result = await api.importPlaylist();
        if (result) {
          await refresh();
          setPlaylistReport([result]);
          navigate(`playlist:${result.playlist.id}`);
        }
      } catch (e) {
        fail(e);
      } finally {
        setBusy(false);
        setProgress("");
      }
    })();
  };
  const renderTracks = (items: Track[], compact = false, queueMode = false) => (
    <div
      className={`track-list ${compact ? "compact" : ""}`}
      role="list"
      aria-label={queueMode ? "Playback queue" : "Tracks"}
    >
      {(compact ? items.slice(0, detailLimit) : items).map((t, i) => (
        <div
          className={`track-row ${t.id === current?.id ? "is-playing" : ""} ${t.missing ? "is-missing" : ""}`}
          role="listitem"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(TRACK_DRAG_TYPE, JSON.stringify([t.id]));
            e.dataTransfer.effectAllowed = "copy";
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            showTrackMenu([t.id]);
          }}
          onKeyDown={(e) => {
            if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
              e.preventDefault();
              showTrackMenu([t.id]);
            }
          }}
          key={`${t.id}-${i}`}
        >
          <button
            className="track-play"
            aria-label={`Play ${t.title}`}
            onClick={() => playTrack(t, items)}
            disabled={t.missing}
          >
            {t.id === current?.id && playing ? (
              <Activity size={16} />
            ) : (
              <>
                <span className="track-number">{i + 1}</span>
                <Play className="row-play" size={15} />
              </>
            )}
          </button>
          {!compact && <Art track={t} />}
          <button
            className="track-title"
            onClick={() => {
              setSelectedAlbum(t.albumId);
              if (compact) playTrack(t, items);
            }}
            onDoubleClick={() => playTrack(t, items)}
          >
            <span>
              {t.title}
              {t.missing && " · Unavailable"}
            </span>
            {!compact && <small>{t.artist}</small>}
          </button>
          {!compact && <span className="track-album">{t.album}</span>}
          {!compact && (
            <IconButton
              label={
                t.favorite ? `Unfavourite ${t.title}` : `Favourite ${t.title}`
              }
              active={t.favorite}
              onClick={() => void favorite(t.id)}
            >
              <Heart fill={t.favorite ? "currentColor" : "none"} size={16} />
            </IconButton>
          )}
          <span className="track-duration">{time(t.duration)}</span>
          {queueMode ? (
            <IconButton
              label={`Remove ${t.title} from queue`}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  queue: s.queue.filter((_, index) => index !== i),
                }))
              }
            >
              <X size={14} />
            </IconButton>
          ) : (
            <IconButton
              label={`Options for ${t.title}`}
              onClick={() => trackActions(t)}
            >
              <MoreHorizontal size={16} />
            </IconButton>
          )}
        </div>
      ))}
      {compact && items.length > detailLimit && (
        <button
          className="quiet more-tracks"
          onClick={() => setDetailLimit((n) => n + 200)}
        >
          Show more tracks ({detailLimit.toLocaleString()} of{" "}
          {items.length.toLocaleString()})
        </button>
      )}
    </div>
  );
  const renderAlbums = (items: Album[]) => (
    <div className="album-grid">
      {items.map((a) => (
        <article
          className={`album-card ${a.id === selectedAlbum ? "selected" : ""}`}
          key={a.id}
        >
          <button
            className="album-cover"
            onClick={() => {
              setSelectedAlbum(a.id);
              setShowQueue(false);
            }}
            onDoubleClick={() => playTrack(a.tracks[0], a.tracks)}
            aria-label={`Open ${a.name} by ${a.artist}`}
          >
            <Art track={a.tracks.find((t) => t.hasArtwork) ?? a.tracks[0]} />
            <span className="cover-hint">
              <ListMusic size={19} /> View tracks
            </span>
          </button>
          <button
            className="album-start"
            aria-label={`Play album ${a.name}`}
            onClick={() =>
              playTrack(
                a.tracks.find((t) => !t.missing) ?? a.tracks[0],
                a.tracks,
              )
            }
          >
            <Play size={20} fill="currentColor" />
          </button>
          <div className="album-caption">
            <button
              onClick={() => {
                setSelectedAlbum(a.id);
                setShowQueue(false);
              }}
            >
              {a.name}
            </button>
            <small>{a.artist}</small>
          </div>
        </article>
      ))}
    </div>
  );

  return (
    <div
      className={`app-shell ${fileDrag ? "file-drag-active" : ""}`}
      onDragEnter={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          dragDepth.current++;
          setFileDrag(true);
        }
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.dataTransfer.dropEffect =
            data?.libraryPath && !busy ? "copy" : "none";
        }
      }}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setFileDrag(false);
        }
      }}
      onDrop={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          e.stopPropagation();
          dragDepth.current = 0;
          setFileDrag(false);
          void importDrop([...e.dataTransfer.files]);
        }
      }}
    >
      {fileDrag && (
        <div className="file-drop-cue" role="status">
          <FolderPlus size={22} />
          <span>
            {data?.libraryPath
              ? "Drop to add music or playlists"
              : "Choose a library folder first"}
            <small>Your source files stay where they are.</small>
          </span>
        </div>
      )}
      <audio
        ref={audio}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onLoadedMetadata={() =>
          setDuration(
            Number.isFinite(audio.current!.duration)
              ? audio.current!.duration
              : (current?.duration ?? 0),
          )
        }
        onTimeUpdate={() => setPosition(audio.current!.currentTime)}
        onEnded={() => advance(1, true)}
        onError={() => {
          desiredPlay.current = false;
          setPlaying(false);
          setError(
            "This track could not be played. The file may be unavailable, damaged, or use an unsupported codec. Try another track or rescan its folder.",
          );
        }}
      />
      <aside className="sidebar">
        <div className="window-drag" />
        <div className="brand">
          <Activity />
          <span>Rhythm</span>
        </div>
        <nav aria-label="Music library">
          <button
            className={`nav-item ${view === "Home" ? "selected" : ""}`}
            onClick={() => navigate("Home")}
          >
            <Home />
            Home
          </button>
          <button
            className="nav-item"
            onClick={() => searchRef.current?.focus()}
          >
            <Search />
            Search
          </button>
          <p className="nav-label">Library</p>
          {nav.map(([label, Icon]) => (
            <button
              className={`nav-item ${view === label ? "selected" : ""}`}
              key={label}
              onClick={() => navigate(label)}
            >
              <Icon />
              {label}
            </button>
          ))}
        </nav>
        <div className="playlist-heading">
          <span>Playlists</span>
          <IconButton
            label="Create playlist"
            onClick={() => makePlaylist()}
            disabled={!data?.libraryPath}
          >
            <Plus />
          </IconButton>
        </div>
        <nav className="playlist-nav" aria-label="Playlists">
          {data?.playlists.map((p) => (
            <button
              key={p.id}
              className={`nav-item ${activePlaylist?.id === p.id ? "selected" : ""} ${dropPlaylist === p.id ? "drop-target" : ""}`}
              onDragOver={(e) => {
                if (e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) {
                  e.preventDefault();
                  e.stopPropagation();
                  e.dataTransfer.dropEffect = "copy";
                  setDropPlaylist(p.id);
                }
              }}
              onDragLeave={() => setDropPlaylist(null)}
              onDrop={(e) => {
                if (e.dataTransfer.types.includes(TRACK_DRAG_TYPE)) {
                  e.preventDefault();
                  e.stopPropagation();
                  setDropPlaylist(null);
                  const ids = dragTrackIds(
                    e.dataTransfer.getData(TRACK_DRAG_TYPE),
                  );
                  if (ids.length) void appendToPlaylist(p.id, ids);
                }
              }}
              onClick={() => navigate(`playlist:${p.id}`)}
            >
              <Music2 />
              <span>{p.name}</span>
            </button>
          ))}
          {!data?.playlists.length && (
            <p className="sidebar-hint">Your mixes belong here.</p>
          )}
        </nav>
        <div className="sidebar-bottom">
          <button
            className="nav-item"
            disabled={!data?.libraryPath || busy}
            onClick={() => void scan()}
          >
            <FolderPlus />
            Add music
          </button>
          <button className="nav-item" onClick={() => setModal("settings")}>
            <Settings2 />
            Library settings
          </button>
        </div>
      </aside>
      <main className="workspace">
        <header className="toolbar">
          <div className="history-controls">
            <IconButton
              label="Go back"
              disabled={historyIndex === 0}
              onClick={() => goHistory(historyIndex - 1)}
            >
              <ChevronLeft />
            </IconButton>
            <IconButton
              label="Go forward"
              disabled={historyIndex === history.length - 1}
              onClick={() => goHistory(historyIndex + 1)}
            >
              <ChevronRight />
            </IconButton>
          </div>
          <label className="search-field">
            <Search size={18} />
            <input
              ref={searchRef}
              type="search"
              placeholder="Search songs, albums, artists…"
              aria-label="Search library"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            {query && (
              <IconButton label="Clear search" onClick={() => setQuery("")}>
                <X size={15} />
              </IconButton>
            )}
          </label>
          <div className="view-controls">
            <IconButton
              label="Album grid"
              active={layout === "grid"}
              onClick={() => setLayout("grid")}
            >
              <LayoutGrid />
            </IconButton>
            <IconButton
              label="Track list"
              active={layout === "list"}
              onClick={() => setLayout("list")}
            >
              <List />
            </IconButton>
            <IconButton
              label="Library settings"
              onClick={() => setModal("settings")}
            >
              <MoreHorizontal />
            </IconButton>
          </div>
        </header>
        {message && (
          <div className="notice" role="status">
            <Check size={18} />
            <span>{message}</span>
            <IconButton label="Dismiss message" onClick={() => setMessage("")}>
              <X />
            </IconButton>
          </div>
        )}
        {playlistReport.length > 0 && (
          <div className="notice" role="status">
            <Check size={18} />
            <span>
              Imported{" "}
              {playlistReport.length === 1
                ? `“${playlistReport[0].playlist.name}”`
                : `${playlistReport.length} playlists`}{" "}
              · {playlistReport.reduce((n, p) => n + p.count, 0)} songs ·{" "}
              {playlistReport.reduce((n, p) => n + p.added, 0)} newly indexed
              {playlistReport.some((p) => p.issueCount) &&
                ` · ${playlistReport.reduce((n, p) => n + p.issueCount, 0)} ${playlistReport.reduce((n, p) => n + p.issueCount, 0) === 1 ? "issue" : "issues"}`}
              {playlistReport.some((p) => p.issues.length) && (
                <details>
                  <summary>View playlist issues</summary>
                  <ul>
                    {playlistReport
                      .flatMap((p) =>
                        p.issues.map((issue) =>
                          playlistReport.length > 1
                            ? `${p.playlist.name}: ${issue}`
                            : issue,
                        ),
                      )
                      .slice(0, 100)
                      .map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                  </ul>
                </details>
              )}
            </span>
            <IconButton
              label="Dismiss playlist report"
              onClick={() => setPlaylistReport([])}
            >
              <X />
            </IconButton>
          </div>
        )}
        {error && (
          <div className="notice error" role="alert">
            <AlertCircle size={18} />
            <span>{error}</span>
            <IconButton label="Dismiss error" onClick={() => setError("")}>
              <X />
            </IconButton>
          </div>
        )}
        {busy && (
          <div className="notice" role="status">
            <LoaderCircle className="spin" size={18} />
            <span>{progress}</span>
          </div>
        )}
        {report && !busy && (
          <div className="notice" role="status">
            <Check size={18} />
            <span>
              {report.added} added · {report.updated} updated ·{" "}
              {report.unchanged} unchanged
              {report.errors.length > 0 && ` · ${report.errors.length} issues`}
              {report.errors.length > 0 && (
                <details>
                  <summary>View import issues</summary>
                  <ul>
                    {report.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </span>
            <IconButton
              label="Dismiss import report"
              onClick={() => setReport(null)}
            >
              <X />
            </IconButton>
          </div>
        )}
        <div className="main-scroll">
          {!data ? (
            <div className="empty-state">
              <LoaderCircle className="spin" />
              <h1>Opening Rhythm…</h1>
            </div>
          ) : !data.libraryPath ? (
            <div className="setup empty-state">
              <div className="setup-mark">
                <Activity size={42} />
              </div>
              <h1>A home for your music.</h1>
              <p>
                Build a library around the music you own.
                <br />
                Your files stay exactly where they are.
              </p>
              <div className="setup-step">
                <span>1</span>
                <div>
                  <h3>Choose a library folder</h3>
                  <p>
                    Pick where Rhythm stores its library database, playlists,
                    and listening state. This can be separate from your music.
                  </p>
                </div>
              </div>
              <div className="setup-step">
                <span>2</span>
                <div>
                  <h3>Add your music</h3>
                  <p>
                    Select music folders to index. Rhythm reads your files
                    without moving, copying, or changing them.
                  </p>
                </div>
              </div>
              <button className="primary" onClick={() => void chooseLibrary()}>
                <FolderOpen size={18} />
                Choose library folder
              </button>
              <small>
                Already have a Rhythm library? Choose its existing folder.
              </small>
            </div>
          ) : !tracks.length ? (
            <div className="empty-state">
              <Disc3 size={52} strokeWidth={1} />
              <h1>Your library starts here.</h1>
              <p>
                Add a folder of music to see your albums, artists, and songs.
                <br />
                Your original files remain untouched.
              </p>
              <button
                className="primary"
                disabled={busy}
                onClick={() => void scan()}
              >
                <FolderPlus size={18} />
                Add music folders
              </button>
              <small>
                MP3, FLAC, M4A, AAC, Ogg, Opus, and WAV.
                <br />
                Playback depends on the file’s codec.
              </small>
            </div>
          ) : (
            <>
              {view === "Home" && !query && (
                <section className="recent-section">
                  <div className="section-heading">
                    <h2>Recently Added</h2>
                    <IconButton
                      label="See all recently added"
                      onClick={() => navigate("Recently Added")}
                    >
                      <ChevronRight />
                    </IconButton>
                  </div>
                  {renderAlbums(
                    [...albums].sort((a, b) => b.added - a.added).slice(0, 5),
                  )}
                </section>
              )}
              <section>
                <div className="section-heading">
                  <div>
                    <h1>
                      {query
                        ? "Search results"
                        : view === "Home"
                          ? "Albums"
                          : title}
                    </h1>
                    {query && (
                      <p className="section-meta">
                        {visible.length}{" "}
                        {visible.length === 1 ? "song" : "songs"} matching “
                        {query}”
                      </p>
                    )}
                    {activePlaylist && (
                      <p className="section-meta">
                        {visible.length} songs ·{" "}
                        {time(
                          visible.reduce((total, t) => total + t.duration, 0),
                        )}
                      </p>
                    )}
                  </div>
                  <div className="filters">
                    {activePlaylist ? (
                      <>
                        <button
                          className="quiet"
                          disabled={!visible.length}
                          onClick={() => playTrack(visible[0], visible)}
                        >
                          <Play size={15} />
                          Play
                        </button>
                        <IconButton
                          label="Rename playlist"
                          onClick={() => makePlaylist(activePlaylist)}
                        >
                          <MoreHorizontal />
                        </IconButton>
                        <IconButton
                          label="Delete playlist"
                          onClick={() => {
                            setEditPlaylist(activePlaylist);
                            setModal("delete");
                          }}
                        >
                          <X />
                        </IconButton>
                      </>
                    ) : (
                      <>
                        {!["Songs", "Favourites"].includes(view) &&
                          !group &&
                          layout !== "list" && (
                            <select
                              aria-label="Sort library"
                              value={sort}
                              onChange={(e) => setSort(e.target.value)}
                            >
                              <option value="az">A – Z</option>
                              <option value="recent">Newest added</option>
                              <option value="year">Release year</option>
                            </select>
                          )}
                        <select
                          aria-label="Filter genre"
                          value={genre}
                          onChange={(e) => setGenre(e.target.value)}
                        >
                          <option>All Genres</option>
                          {genres.map((g) => (
                            <option key={g}>{g}</option>
                          ))}
                        </select>
                      </>
                    )}
                  </div>
                </div>
                {group && (
                  <button
                    className="quiet group-back"
                    onClick={() => setGroup(null)}
                  >
                    <ChevronLeft size={15} />
                    All {view.toLowerCase()}
                    <span> / {group}</span>
                  </button>
                )}
                {view === "Playlists" && !query ? (
                  <div className="playlist-grid">
                    {data.playlists.map((p) => (
                      <button
                        className="playlist-card"
                        key={p.id}
                        onClick={() => navigate(`playlist:${p.id}`)}
                      >
                        <ListMusic size={32} />
                        <strong>{p.name}</strong>
                        <small>{p.trackIds.length} songs</small>
                      </button>
                    ))}
                    <button
                      className="playlist-card create-playlist"
                      onClick={() => makePlaylist()}
                    >
                      <Plus size={32} />
                      <strong>Create playlist</strong>
                      <small>Make a mix of your own.</small>
                    </button>
                  </div>
                ) : (view === "Artists" || view === "Genres") &&
                  !group &&
                  !query ? (
                  <div className="group-list">
                    {groups.map((g) => {
                      const items = tracks.filter((t) =>
                        view === "Artists"
                          ? t.artist === g
                          : t.genre.split(", ").includes(g),
                      );
                      return (
                        <button key={g} onClick={() => setGroup(g)}>
                          <Art
                            track={items.find((t) => t.hasArtwork) ?? items[0]}
                          />
                          <span>
                            <strong>{g}</strong>
                            <small>{items.length} songs</small>
                          </span>
                          <ChevronRight size={18} />
                        </button>
                      );
                    })}
                  </div>
                ) : !visible.length ? (
                  <div className="empty-inline">
                    <Search size={30} />
                    <h3>
                      {query
                        ? "No matching music"
                        : activePlaylist
                          ? "Make this playlist yours."
                          : "Nothing here yet."}
                    </h3>
                    <p>
                      {query
                        ? "Try another title, artist, or album."
                        : activePlaylist
                          ? "Right-click a song to add it to this playlist."
                          : "Favourite a song using its heart, or adjust the genre filter."}
                    </p>
                    {genre !== "All Genres" && (
                      <button
                        className="quiet"
                        onClick={() => setGenre("All Genres")}
                      >
                        Clear genre filter
                      </button>
                    )}
                  </div>
                ) : query ||
                  activePlaylist ||
                  ["Songs", "Favourites"].includes(view) ||
                  ((view === "Artists" || view === "Genres") && !!group) ||
                  layout === "list" ? (
                  <TrackList
                    key={`${view}\0${group}\0${query ? "search" : "browse"}`}
                    label={
                      query
                        ? "Search results"
                        : (activePlaylist?.name ?? group ?? view)
                    }
                    ordered={!!activePlaylist && !query}
                    presentation={data.preferences.trackList.columns}
                    onPresentationChange={savePresentation}
                    resetKey={`${view}\0${query}\0${genre}`}
                    tracks={visible}
                    currentId={current?.id}
                    playing={playing}
                    onPlay={playTrack}
                    onContext={showTrackMenu}
                    onSelect={(t) => {
                      setSelectedAlbum(t.albumId);
                      setShowQueue(false);
                    }}
                    onFavorite={(id) => void favorite(id)}
                  />
                ) : (
                  renderAlbums(visibleAlbums)
                )}
              </section>
            </>
          )}
        </div>
      </main>
      <aside
        className="detail-panel"
        aria-label={showQueue ? "Queue" : "Album details"}
      >
        {showQueue ? (
          <>
            <div className="detail-heading">
              <h2>Queue</h2>
              <IconButton
                label="Close queue"
                onClick={() => setShowQueue(false)}
              >
                <X />
              </IconButton>
            </div>
            <p className="muted">{state.queue.length} songs in this session</p>
            {state.queue.length ? (
              renderTracks(
                state.queue
                  .map((id) => byId.get(id))
                  .filter((t): t is Track => !!t),
                true,
                true,
              )
            ) : (
              <p className="detail-empty">
                Play an album or add songs using their options.
              </p>
            )}
          </>
        ) : rightAlbum ? (
          <>
            <Art
              track={
                rightAlbum.tracks.find((t) => t.hasArtwork) ??
                rightAlbum.tracks[0]
              }
              className="detail-art"
            />
            <div className="detail-title">
              <div>
                <h2>{rightAlbum.name}</h2>
                <p>{rightAlbum.artist}</p>
              </div>
              <IconButton
                label={`Play ${rightAlbum.name}`}
                onClick={() =>
                  playTrack(
                    rightAlbum.tracks.find((t) => !t.missing) ??
                      rightAlbum.tracks[0],
                    rightAlbum.tracks,
                  )
                }
              >
                <Play />
              </IconButton>
            </div>
            <p className="album-meta">
              {rightAlbum.tracks[0].year || ""}
              {rightAlbum.tracks[0].year ? " · " : ""}
              {rightAlbum.tracks.length} songs ·{" "}
              {time(rightAlbum.tracks.reduce((n, t) => n + t.duration, 0))}
            </p>
            {renderTracks(rightAlbum.tracks, true)}
          </>
        ) : (
          <div className="detail-empty">
            <Disc3 size={44} strokeWidth={1} />
            <h3>A closer listen.</h3>
            <p>Select an album to explore its tracks.</p>
          </div>
        )}
      </aside>
      <footer className="player">
        <div className="now-playing">
          <Art track={current} />
          <div>
            <strong>{current?.title ?? "Nothing playing"}</strong>
            <small>
              {current?.artist ?? "Choose something from your library"}
            </small>
          </div>
          <IconButton
            label={
              current?.favorite
                ? "Unfavourite current track"
                : "Favourite current track"
            }
            active={!!current?.favorite}
            disabled={!current}
            onClick={() => current && void favorite(current.id)}
          >
            <Heart fill={current?.favorite ? "currentColor" : "none"} />
          </IconButton>
        </div>
        <div className="transport">
          <div className="transport-buttons">
            <IconButton
              label="Shuffle"
              active={state.shuffle}
              disabled={!tracks.length}
              onClick={() => setState((s) => ({ ...s, shuffle: !s.shuffle }))}
            >
              <Shuffle size={18} />
            </IconButton>
            <IconButton
              label="Previous track"
              disabled={!current}
              onClick={() => advance(-1)}
            >
              <SkipBack size={20} />
            </IconButton>
            <button
              className="play-button"
              aria-label={playing ? "Pause" : "Play"}
              disabled={!tracks.some((t) => !t.missing)}
              onClick={toggle}
            >
              {playing ? (
                <Pause size={23} fill="currentColor" />
              ) : (
                <Play size={23} fill="currentColor" />
              )}
            </button>
            <IconButton
              label="Next track"
              disabled={!current}
              onClick={() => advance(1)}
            >
              <SkipForward size={20} />
            </IconButton>
            <IconButton
              label={`Repeat: ${state.repeat}`}
              active={state.repeat !== "off"}
              disabled={!tracks.length}
              onClick={() =>
                setState((s) => ({
                  ...s,
                  repeat:
                    s.repeat === "off"
                      ? "all"
                      : s.repeat === "all"
                        ? "one"
                        : "off",
                }))
              }
            >
              {state.repeat === "one" ? (
                <Repeat1 size={18} />
              ) : (
                <Repeat size={18} />
              )}
            </IconButton>
          </div>
          <div className="seek">
            <span>{time(position)}</span>
            <input
              aria-label="Seek"
              type="range"
              min="0"
              max={duration || 1}
              step="0.1"
              value={Math.min(position, duration || 1)}
              disabled={!current || !duration}
              style={
                {
                  "--range": `${duration ? (position / duration) * 100 : 0}%`,
                } as React.CSSProperties
              }
              onChange={(e) => {
                const p = Number(e.target.value);
                audio.current!.currentTime = p;
                setPosition(p);
                setState((s) => ({ ...s, position: p }));
              }}
            />
            <span>{time(duration)}</span>
          </div>
        </div>
        <div className="player-tools">
          <IconButton
            label={state.volume ? "Mute" : "Unmute"}
            onClick={() =>
              setState((s) => ({ ...s, volume: s.volume ? 0 : 0.7 }))
            }
          >
            {state.volume ? <Volume2 size={19} /> : <VolumeX size={19} />}
          </IconButton>
          <input
            type="range"
            aria-label="Volume"
            min="0"
            max="1"
            step="0.01"
            value={state.volume}
            style={
              { "--range": `${state.volume * 100}%` } as React.CSSProperties
            }
            onChange={(e) =>
              setState((s) => ({ ...s, volume: Number(e.target.value) }))
            }
          />
          <IconButton
            label="Show queue"
            active={showQueue}
            onClick={() => setShowQueue(!showQueue)}
          >
            <ListMusic size={21} />
          </IconButton>
        </div>
      </footer>
      {modal === "settings" && (
        <Modal title="Library settings" close={() => setModal(null)}>
          <p className="muted">Rhythm 0.1 · Local music, under your control.</p>
          <h3>Library database</h3>
          <p className="path">{data?.libraryPath ?? "No library configured"}</p>
          <button
            className="quiet"
            disabled={busy}
            onClick={() => {
              setModal(null);
              void chooseLibrary();
            }}
          >
            <FolderOpen size={17} />
            Choose or switch library…
          </button>
          <h3>Track List columns</h3>
          <p className="muted">
            Shared across Songs, playlists and other Track Lists. Title stays
            visible.
          </p>
          <div
            className="column-settings"
            role="group"
            aria-label="Track List columns"
          >
            {TRACK_COLUMNS.map((column) => (
              <label key={column.key}>
                <input
                  type="checkbox"
                  checked={
                    !data?.preferences.trackList.columns.hidden.includes(
                      column.key,
                    )
                  }
                  disabled={column.key === "title"}
                  onChange={(e) => {
                    const hidden =
                      data?.preferences.trackList.columns.hidden ?? [];
                    savePresentation({
                      hidden: e.target.checked
                        ? hidden.filter((id) => id !== column.key)
                        : [...hidden, column.key],
                    });
                  }}
                />
                {column.label}
              </label>
            ))}
          </div>
          <h3>Music folders</h3>
          {data?.roots.length ? (
            <ul className="root-list">
              {data.roots.map((root) => (
                <li className="path" key={root}>
                  {root}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No music folders added yet.</p>
          )}
          <div className="dialog-actions">
            <button
              className="quiet"
              disabled={busy || !data?.roots.length}
              onClick={() => {
                setModal(null);
                void scan(true);
              }}
            >
              <RefreshCw size={16} />
              Rescan folders
            </button>
            <button
              className="primary"
              disabled={busy || !data?.libraryPath}
              onClick={() => {
                setModal(null);
                void scan();
              }}
            >
              <FolderPlus size={17} />
              Add music
            </button>
          </div>
          <p className="fine-print">
            Music files are read only. Rhythm does not move, rename, delete, or
            edit them. Cloud sync and mobile clients are outside version 0.1.
          </p>
        </Modal>
      )}
      {modal === "export-playlist" && (
        <Modal title="Export playlist" close={() => setModal(null)}>
          <div className="form-label">
            <label htmlFor="export-playlist">Playlist to export</label>
            <select
              id="export-playlist"
              value={exportPlaylistId}
              onChange={(e) => setExportPlaylistId(e.target.value)}
            >
              {data?.playlists.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <p className="muted">
            Save an M3U8 playlist. Your audio files stay where they are.
          </p>
          <div className="dialog-actions">
            <button
              className="primary"
              disabled={busy || !exportPlaylistId}
              onClick={() => void exportPlaylist(exportPlaylistId)}
            >
              Export…
            </button>
          </div>
        </Modal>
      )}
      {modal === "playlist" && (
        <Modal
          title={editPlaylist ? "Rename playlist" : "New playlist"}
          close={() => setModal(null)}
        >
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                if (editPlaylist)
                  await api.renamePlaylist(editPlaylist.id, name);
                else {
                  const p = await api.createPlaylist(name);
                  if (pendingPlaylistTracks.length)
                    await api.addToPlaylist(p.id, pendingPlaylistTracks);
                  setPendingPlaylistTracks([]);
                  navigate(`playlist:${p.id}`);
                }
                await refresh();
                setModal(null);
              } catch (e) {
                fail(e);
                setModal(null);
              }
            }}
          >
            <label className="form-label">
              Playlist name
              <input
                autoFocus
                value={name}
                maxLength={120}
                placeholder="A name for your mix"
                onChange={(e) => setName(e.target.value)}
                required
              />
            </label>
            <div className="dialog-actions">
              <button
                className="quiet"
                type="button"
                onClick={() => setModal(null)}
              >
                Cancel
              </button>
              <button className="primary" disabled={!name.trim()} type="submit">
                {editPlaylist ? "Save name" : "Create playlist"}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {modal === "delete" && editPlaylist && (
        <Modal title="Delete playlist?" close={() => setModal(null)}>
          <p>
            Delete “{editPlaylist.name}” from Rhythm? Your music files and
            library tracks stay in place.
          </p>
          <div className="dialog-actions">
            <button className="quiet" onClick={() => setModal(null)}>
              Keep playlist
            </button>
            <button
              className="danger"
              onClick={async () => {
                try {
                  await api.deletePlaylist(editPlaylist.id);
                  navigate("Playlists");
                  await refresh();
                  setModal(null);
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Delete playlist
            </button>
          </div>
        </Modal>
      )}
      {modal === "track" && actionTrack && (
        <Modal title={actionTrack.title} close={() => setModal(null)}>
          <p className="muted">
            {actionTrack.artist} · {actionTrack.album}
          </p>
          <div className="track-menu">
            <button
              className="quiet"
              disabled={actionTrack.missing}
              onClick={() => queueTrack(actionTrack, true)}
            >
              <SkipForward size={17} />
              Play next
            </button>
            <button
              className="quiet"
              disabled={actionTrack.missing}
              onClick={() => queueTrack(actionTrack, false)}
            >
              <ListMusic size={17} />
              Add to queue
            </button>
          </div>
          <h3>Add to playlist</h3>
          {data?.playlists.length ? (
            <div className="dialog-actions">
              <select
                aria-label="Choose playlist"
                value={targetPlaylist}
                onChange={(e) => setTargetPlaylist(e.target.value)}
              >
                <option value="">Choose a playlist…</option>
                {data.playlists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <button
                className="primary"
                disabled={!targetPlaylist}
                onClick={async () => {
                  await appendToPlaylist(targetPlaylist, [actionTrack.id]);
                }}
              >
                Add song
              </button>
            </div>
          ) : (
            <button
              className="quiet"
              onClick={() => makePlaylist(null, [actionTrack.id])}
            >
              Create a playlist first
            </button>
          )}
          {activePlaylist && (
            <button
              className="quiet"
              onClick={async () => {
                try {
                  await api.playlistTracks(
                    activePlaylist.id,
                    activePlaylist.trackIds.filter(
                      (id) => id !== actionTrack.id,
                    ),
                  );
                  await refresh();
                  setModal(null);
                } catch (e) {
                  fail(e);
                }
              }}
            >
              Remove from this playlist
            </button>
          )}
          <h3>File information</h3>
          <p className="path">{actionTrack.path}</p>
          <p className="fine-print">
            {actionTrack.format.toUpperCase()} · {time(actionTrack.duration)} ·{" "}
            {actionTrack.genre}
            {actionTrack.year ? ` · ${actionTrack.year}` : ""}
          </p>
        </Modal>
      )}
    </div>
  );
}
