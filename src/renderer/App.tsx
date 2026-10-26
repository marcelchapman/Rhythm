import { MediaSource } from "./media-source";
import { TrackList } from "./TrackList";
import { useTrackSelection } from "./use-track-selection";
import { selectionModifier } from "./track-selection";
import { TRACK_COLUMNS } from "./track-columns";
import {
  patchTrackListPreferences,
  type TrackListPatch,
} from "../shared/preferences";
import type { DesktopPlaylistEvent } from "../shared/types";
import type { PlaylistImportResult } from "../shared/types";
import { TRACK_DRAG_TYPE, dragTrackIds } from "./track-columns";
import type { TrackAction, ConsolidationResult } from "../shared/types";
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
  const [mediaError, setMediaError] = useState("");
  const [recoveryId, setRecoveryId] = useState<string | null>(null);
  const [consolidationReport, setConsolidationReport] =
    useState<ConsolidationResult | null>(null);
  const [report, setReport] = useState<ScanResult | null>(null);
  const [modal, setModal] = useState<
    | "settings"
    | "playlist"
    | "delete"
    | "export-playlist"
    | "consolidate"
    | "info"
    | null
  >(null);
  const [editPlaylist, setEditPlaylist] = useState<Playlist | null>(null);
  const [name, setName] = useState("");
  const [actionTrack, setActionTrack] = useState<Track | null>(null);
  const audio = useRef<HTMLAudioElement>(null);
  const mediaSource = useRef<MediaSource | null>(null);
  const playRequest = useRef(0);
  const pendingPlay = useRef<{ key: string; promise: Promise<void> } | null>(
    null,
  );
  const reportedPlaybackError = useRef("");
  const playbackMounted = useRef(true);
  const loadedTrackId = useRef<string | null>(null);
  const lastPlaybackPosition = useRef(0);
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
  const detailTracks = useMemo(
    () =>
      showQueue
        ? state.queue
            .map((id) => byId.get(id))
            .filter((track): track is Track => !!track)
        : (rightAlbum?.tracks ?? []),
    [showQueue, state.queue, byId, rightAlbum],
  );
  const detailOrder = useMemo(
    () => detailTracks.map((track) => track.id),
    [detailTracks],
  );
  const detailSelection = useTrackSelection(
    detailOrder,
    showQueue ? "queue" : `album:${rightAlbum?.id}`,
  );
  const detailList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (detailSelection.selection.focus)
      detailList.current
        ?.querySelector<HTMLElement>(
          `[data-detail-track-id="${detailSelection.selection.focus}"]`,
        )
        ?.scrollIntoView({ block: "nearest" });
  }, [detailSelection.selection.focus, detailLimit]);
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
  const prepareMedia = (track: Track, position = 0, force = false) => {
    const loader = (mediaSource.current ??= new MediaSource(audio.current!));
    return loader.ensure(
      `${dataRef.current?.libraryPath}\0${track.id}\0${track.path}`,
      media(track),
      position,
      force,
    );
  };
  const unavailable = (track: Track) => {
    desiredPlay.current = false;
    audio.current?.pause();
    setPlaying(false);
    setData((previous) =>
      previous
        ? {
            ...previous,
            tracks: previous.tracks.map((t) =>
              t.id === track.id ? { ...t, missing: true } : t,
            ),
          }
        : previous,
    );
    setRecoveryId(track.id);
    setError(
      `Rhythm can't find “${track.title}” at its recorded location. Locate the file to reconnect this track.`,
    );
  };
  const playbackFailure = async (
    cause: unknown,
    id: string,
    generation: number,
    request: number,
  ) => {
    const name = cause instanceof Error ? cause.name : "Error";
    const stale =
      request !== playRequest.current ||
      generation !== mediaSource.current?.generation ||
      !playbackMounted.current;
    if (stale || (name === "AbortError" && !desiredPlay.current)) {
      console.debug("Rhythm playback superseded", {
        id,
        generation,
        request,
        name,
      });
      return;
    }
    const key = `${generation}/${request}`;
    if (reportedPlaybackError.current === key) return;
    reportedPlaybackError.current = key;
    console.warn("Rhythm playback failed", { id, generation, request, cause });
    try {
      const result = await api.checkTrack(id);
      if (
        request !== playRequest.current ||
        generation !== mediaSource.current?.generation ||
        !playbackMounted.current
      )
        return;
      const track = dataRef.current?.tracks.find((t) => t.id === id);
      if (!track) return;
      if (result.missing) unavailable(track);
      else {
        desiredPlay.current = false;
        setPlaying(false);
        setRecoveryId(null);
        setError(
          name === "AbortError"
            ? "Playback was interrupted. Press Play to try again."
            : "This track could not be played. The file may be damaged or use an unsupported codec. Try another track.",
        );
      }
    } catch (e) {
      console.warn("Rhythm playback availability check failed", {
        id,
        cause: e,
      });
      if (
        request === playRequest.current &&
        generation === mediaSource.current?.generation &&
        playbackMounted.current
      )
        setError(
          "Rhythm could not check this file. Try Play again or check its drive.",
        );
    }
  };
  const playPrepared = (id: string, request: number) => {
    const generation = mediaSource.current!.generation;
    if (
      request !== playRequest.current ||
      !desiredPlay.current ||
      !audio.current!.paused
    )
      return Promise.resolve();
    const key = `${generation}/${request}`;
    if (pendingPlay.current?.key === key) return pendingPlay.current.promise;
    const promise = audio
      .current!.play()
      .catch((e) => playbackFailure(e, id, generation, request));
    pendingPlay.current = { key, promise };
    return promise;
  };
  const locateTrack = async (id: string) => {
    if (busy) return;
    const libraryPath = dataRef.current?.libraryPath;
    if (stateRef.current.currentId === id) {
      playRequest.current++;
      desiredPlay.current = false;
      audio.current?.pause();
    }
    setRecoveryId(id);
    setMessage("");
    setBusy(true);
    setProgress("Choose a file to recover this track…");
    let located = false;
    try {
      if (await api.locateTrack(id)) {
        located = true;
        const latest = await api.snapshot();
        const track = latest.tracks.find((t) => t.id === id);
        if (!track) throw new Error("The recovered track is unavailable.");
        // Start the one forced recovery load before React observes the new location.
        // The normal source effect will reuse this same readiness promise.
        const ready =
          stateRef.current.currentId === id
            ? prepareMedia(
                track,
                lastPlaybackPosition.current || stateRef.current.position,
                true,
              )
            : Promise.resolve();
        setData(latest);
        setError("");
        setRecoveryId(null);
        setProgress("Preparing the recovered track…");
        await ready;
        if (dataRef.current?.libraryPath !== libraryPath) return;
        setRecoveryId(null);
        setError("");
        setMessage(
          stateRef.current.currentId === id
            ? "File located. The track is ready to play; its original stays unchanged."
            : "File located. Its original stays unchanged.",
        );
        setModal(null);
      } else await refresh();
    } catch (e) {
      if (located) {
        console.warn("Rhythm recovery playback preparation", { id, cause: e });
        if (e instanceof Error && e.name === "AbortError") {
          if (dataRef.current?.libraryPath === libraryPath)
            setMessage("File located. Its original stays unchanged.");
        } else {
          setRecoveryId(null);
          setError(
            "The file was located, but playback could not be prepared. Check its format and try Play again.",
          );
        }
      } else fail(e);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  const consolidate = async (ids?: string[]) => {
    if (busy) return;
    setBusy(true);
    setProgress("Copying referenced tracks to Rhythm Media…");
    setError("");
    setModal(null);
    try {
      const result = await api.consolidateTracks(ids);
      if (result) setConsolidationReport(result);
      await refresh();
      // The track URL uses stable identity, even when its local file changed.
      // Path changes reload the decoder; also reset an errored same-path decoder.
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
  const playbackError = () => {
    const a = audio.current;
    const id = stateRef.current.currentId;
    if (!id || !a?.error || !a.src || new URL(a.src).pathname.slice(1) !== id)
      return;
    void playbackFailure(
      new Error(`Media decoder error ${a.error.code}`),
      id,
      mediaSource.current?.generation ?? 0,
      playRequest.current,
    );
  };
  const changeMedia = async (patch?: {
    copyOnAdd?: boolean;
    keepOrganized?: boolean;
  }) => {
    if (busy) return;
    const previousSettings = dataRef.current?.mediaSettings;
    if (patch)
      setData((previous) =>
        previous
          ? {
              ...previous,
              mediaSettings: { ...previous.mediaSettings, ...patch },
            }
          : previous,
      );
    setBusy(true);
    setMediaError("");
    try {
      const mediaSettings = patch
        ? await api.saveMediaSettings(patch)
        : await api.chooseMediaRoot();
      if (mediaSettings)
        setData((previous) =>
          previous ? { ...previous, mediaSettings } : previous,
        );
    } catch (e) {
      if (previousSettings)
        setData((previous) =>
          previous
            ? { ...previous, mediaSettings: previousSettings }
            : previous,
        );
      const message = e instanceof Error ? e.message : String(e);
      setMediaError(
        message.replace(
          /^Error invoking remote method '[^']+': (?:Error: )?/,
          "",
        ),
      );
    } finally {
      setBusy(false);
    }
  };
  const load = (snapshot: Snapshot) => {
    suppressSave.current = true;
    desiredPlay.current = false;
    playRequest.current++;
    mediaSource.current?.clear();
    loadedTrackId.current = null;
    setRecoveryId(null);
    setConsolidationReport(null);
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
    playbackMounted.current = true;
    return () => {
      playbackMounted.current = false;
      playRequest.current++;
      mediaSource.current?.cancel();
    };
  }, []);
  useEffect(() => {
    const a = audio.current!;
    if (!current) {
      mediaSource.current?.clear();
      setPlaying(false);
      setDuration(0);
      return;
    }
    if (current.missing) {
      mediaSource.current?.clear();
      setPlaying(false);
      return;
    }
    const savedPosition =
      loadedTrackId.current === current.id
        ? a.error
          ? lastPlaybackPosition.current
          : a.currentTime || resume.current
        : resume.current;
    loadedTrackId.current = current.id;
    lastPlaybackPosition.current = savedPosition;
    resume.current = 0;
    setDuration(current.duration);
    const request = playRequest.current;
    const ready = prepareMedia(current, savedPosition);
    const generation = mediaSource.current!.generation;
    void ready
      .then(() => playPrepared(current.id, request))
      .catch((e) => playbackFailure(e, current.id, generation, request));
  }, [current?.id, current?.path, current?.missing, data?.libraryPath]);
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
            position:
              audio.current.error ||
              dataRef.current?.tracks.find(
                (t) => t.id === stateRef.current.currentId,
              )?.missing
                ? lastPlaybackPosition.current
                : audio.current.currentTime || 0,
          })
          .catch(fail);
    }, 4000);
    const save = () => {
      if (dataRef.current?.libraryPath)
        void api
          .saveState({
            ...stateRef.current,
            position:
              audio.current?.error ||
              dataRef.current?.tracks.find(
                (t) => t.id === stateRef.current.currentId,
              )?.missing
                ? lastPlaybackPosition.current
                : audio.current?.currentTime || 0,
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
  const requestPlayback = async (
    track: Track,
    queue?: Track[],
    restart = true,
    autoplay = true,
  ) => {
    const request = ++playRequest.current;
    const libraryPath = dataRef.current?.libraryPath;
    reportedPlaybackError.current = "";
    setMessage("");
    try {
      const { missing } = await api.checkTrack(track.id);
      if (
        request !== playRequest.current ||
        dataRef.current?.libraryPath !== libraryPath ||
        !dataRef.current?.tracks.some((t) => t.id === track.id)
      )
        return;
      const ids = queue
        ?.filter((t) => !t.missing || t.id === track.id)
        .map((t) => t.id);
      if (missing) {
        if (stateRef.current.currentId !== track.id)
          lastPlaybackPosition.current = 0;
        unavailable(track);
        setState((s) => ({
          ...s,
          currentId: track.id,
          ...(ids ? { queue: ids } : {}),
        }));
        return;
      }
      desiredPlay.current = autoplay;
      if (track.missing)
        setData((previous) =>
          previous
            ? {
                ...previous,
                tracks: previous.tracks.map((t) =>
                  t.id === track.id ? { ...t, missing: false } : t,
                ),
              }
            : previous,
        );
      setRecoveryId(null);
      setError("");
      const savedPosition = restart ? 0 : lastPlaybackPosition.current;
      resume.current = savedPosition;
      if (restart) {
        lastPlaybackPosition.current = 0;
        setPosition(0);
      }
      setState((s) => ({
        ...s,
        currentId: track.id,
        position: savedPosition,
        ...(ids ? { queue: ids } : {}),
      }));
      const ready = prepareMedia(track, savedPosition);
      const generation = mediaSource.current!.generation;
      try {
        await ready;
        if (request !== playRequest.current) return;
        if (restart) audio.current!.currentTime = 0;
        if (autoplay) await playPrepared(track.id, request);
      } catch (e) {
        await playbackFailure(e, track.id, generation, request);
      }
    } catch (e) {
      console.warn("Rhythm Play request failed", { id: track.id, cause: e });
      if (request === playRequest.current)
        setError(
          "Rhythm could not check this file. Try Play again or check its drive.",
        );
    }
  };
  const playTrack = (track: Track, queue?: Track[]) => {
    void requestPlayback(track, queue ?? [track]);
  };
  const pausePlayback = () => {
    playRequest.current++;
    desiredPlay.current = false;
    audio.current?.pause();
  };
  const toggle = () => {
    const s = stateRef.current;
    if (!s.currentId) {
      const available = dataRef.current?.tracks ?? [];
      const queued = s.queue
        .map((id) => available.find((t) => t.id === id))
        .filter((t): t is Track => !!t);
      const items = queued.length ? queued : available;
      if (items[0]) playTrack(items[0], items);
      return;
    }
    if (!audio.current!.paused) pausePlayback();
    else {
      const track = dataRef.current?.tracks.find((t) => t.id === s.currentId);
      if (track) void requestPlayback(track, undefined, false);
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
      const track = dataRef.current?.tracks.find((t) => t.id === s.currentId);
      if (track) void requestPlayback(track, undefined, true);
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
    const track = dataRef.current?.tracks.find((t) => t.id === id);
    if (track)
      void requestPlayback(track, undefined, true, ended || playingRef.current);
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
        else if (command === "settings") setModal("settings");
        else if (command === "consolidate-library") setModal("consolidate");
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
    if ("mediaSession" in navigator && !current) {
      navigator.mediaSession.metadata = null;
      for (const action of [
        "play",
        "pause",
        "nexttrack",
        "previoustrack",
      ] as const)
        navigator.mediaSession.setActionHandler(action, null);
    }
    if ("mediaSession" in navigator && current) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: current.title,
        artist: current.artist,
        album: current.album,
      });
      navigator.mediaSession.setActionHandler("play", () => {
        const track = dataRef.current?.tracks.find(
          (t) => t.id === stateRef.current.currentId,
        );
        if (track) void requestPlayback(track, undefined, false);
      });
      navigator.mediaSession.setActionHandler("pause", pausePlayback);
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
  const removeTrack = async (ids: string[], playlistId?: string) => {
    if (busy) return;
    setBusy(true);
    setProgress(
      playlistId
        ? "Removing tracks from playlist…"
        : "Reviewing track removal…",
    );
    setError("");
    setMessage("");
    try {
      if (playlistId) {
        await api.removeFromPlaylist(playlistId, ids);
        await refresh();
        setMessage(
          `${ids.length} track${ids.length === 1 ? "" : "s"} removed from playlist. Your library and files are unchanged.`,
        );
      } else {
        const result = await api.deleteTrack(ids);
        if (!result) return;
        const removed = new Set(result.removedIds);
        const previous = stateRef.current;
        const wasCurrent =
          !!previous.currentId && removed.has(previous.currentId);
        if (wasCurrent) {
          pausePlayback();
          mediaSource.current?.clear();
          loadedTrackId.current = null;
          resume.current = 0;
          lastPlaybackPosition.current = 0;
          pendingPlay.current = null;
          setPlaying(false);
          setPosition(0);
          setDuration(0);
        }
        const next = {
          ...previous,
          queue: previous.queue.filter((queued) => !removed.has(queued)),
          currentId: wasCurrent ? null : previous.currentId,
          position: wasCurrent ? 0 : previous.position,
        };
        // Update refs immediately, so pending Play checks and periodic saves
        // cannot revive a removed track before React commits this render.
        stateRef.current = next;
        setState(next);
        if (dataRef.current) {
          dataRef.current = {
            ...dataRef.current,
            tracks: dataRef.current.tracks.filter((t) => !removed.has(t.id)),
            playlists: dataRef.current.playlists.map((p) => ({
              ...p,
              trackIds: p.trackIds.filter((trackId) => !removed.has(trackId)),
            })),
          };
          setData(dataRef.current);
        }
        setPendingPlaylistTracks((ids) =>
          ids.filter((trackId) => !removed.has(trackId)),
        );
        setRecoveryId((currentId) =>
          currentId && removed.has(currentId) ? null : currentId,
        );
        if (actionTrack && removed.has(actionTrack.id)) {
          setActionTrack(null);
          setModal(null);
        }
        if (
          result.failures.some(
            (failure) => failure.fileTrashed && failure.id === next.currentId,
          )
        )
          pausePlayback();
        await refresh();
        const summary = `${removed.size} of ${ids.length} track${ids.length === 1 ? "" : "s"} removed from your library.`;
        if (result.failures.length)
          setError(
            `${summary} ${result.failures.length} retained: ${result.failures
              .slice(0, 5)
              .map((failure) => `${failure.title}: ${failure.message}`)
              .join(
                "; ",
              )}${result.failures.length > 5 ? `; and ${result.failures.length - 5} more. Retry retained tracks individually for details.` : ""}`,
          );
        else setMessage(summary);
      }
    } catch (e) {
      // Preflight/confirmation errors do not interrupt unrelated or untouched playback.
      // Per-track Trash/cleanup failures are returned and reconciled above.
      await refresh().catch(() => {});
      fail(e);
    } finally {
      setBusy(false);
      setProgress("");
    }
  };
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
    else if (action.command === "locate") void locateTrack(items[0].id);
    else if (action.command === "consolidate")
      void consolidate(action.trackIds);
    else if (action.command === "remove-from-playlist" && action.playlistId)
      void removeTrack(action.trackIds, action.playlistId);
    else if (action.command === "delete-from-library")
      void removeTrack(action.trackIds);
    else if (action.command === "reveal")
      void api.revealTrack(action.trackIds[0]).catch(fail);
    else if (action.command === "info")
      void (async () => {
        try {
          await api.checkTrack(action.trackIds[0]);
          const latest = await refresh();
          const track = latest.tracks.find((t) => t.id === action.trackIds[0]);
          if (!track) throw new Error("Track no longer exists.");
          setActionTrack(track);
          setModal("info");
        } catch (e) {
          fail(e);
        }
      })();
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
  const showTrackMenu = (
    ids: string[],
    contextId?: string,
    playlistId?: string,
  ) => {
    void api.showTrackMenu(ids, contextId, playlistId).catch(fail);
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
  const detailContext = (track: Track) => {
    const ids = detailSelection.context(track.id);
    detailList.current?.focus({ preventScroll: true });
    showTrackMenu(ids, track.id);
  };
  const renderTracks = (items: Track[], compact = false, queueMode = false) => (
    <div
      ref={detailList}
      className={`track-list ${compact ? "compact" : ""}`}
      role="listbox"
      aria-multiselectable="true"
      tabIndex={0}
      aria-label={queueMode ? "Playback queue" : "Tracks"}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        const index = items.findIndex(
          (track) => track.id === detailSelection.selection.focus,
        );
        const last = Math.min(items.length, detailLimit) - 1;
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
          e.preventDefault();
          const next =
            e.key === "Home"
              ? 0
              : e.key === "End"
                ? last
                : Math.max(
                    0,
                    Math.min(last, index + (e.key === "ArrowDown" ? 1 : -1)),
                  );
          if (items[next]) {
            detailSelection.choose(items[next].id, e.shiftKey);
          }
        } else if (e.key === "Enter" && index >= 0) {
          e.preventDefault();
          playTrack(items[index], items);
        } else if (
          (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) &&
          index >= 0
        ) {
          e.preventDefault();
          detailContext(items[index]);
        }
      }}
    >
      {(compact ? items.slice(0, detailLimit) : items).map((t, i) => (
        <div
          className={`track-row ${detailSelection.selection.ids.has(t.id) ? "selected" : ""} ${t.id === current?.id ? "is-playing" : ""} ${t.missing ? "is-missing" : ""}`}
          role="option"
          data-detail-track-id={t.id}
          aria-selected={detailSelection.selection.ids.has(t.id)}
          onClick={(e) => {
            if ((e.target as HTMLElement).closest(".track-play,.icon-button"))
              return;
            detailSelection.choose(
              t.id,
              e.shiftKey,
              selectionModifier(e, navigator.platform),
            );
            detailList.current?.focus({ preventScroll: true });
          }}
          onDoubleClick={(e) => {
            if (!(e.target as HTMLElement).closest(".track-play,.icon-button"))
              playTrack(t, items);
          }}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(
              TRACK_DRAG_TYPE,
              JSON.stringify(detailSelection.dragIds(t.id)),
            );
            e.dataTransfer.effectAllowed = "copy";
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            detailContext(t);
          }}
          onKeyDown={(e) => {
            if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
              e.preventDefault();
              detailContext(t);
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
            onClick={(e) => {
              // Keep explicit keyboard activation; pointer clicks use row selection.
              if (e.detail === 0) playTrack(t, items);
            }}
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
          {queueMode && (
            <IconButton
              data-queue-remove=""
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
          onContextMenu={(e) => {
            e.preventDefault();
            void api.showAlbumMenu(a.id).catch(fail);
          }}
          onKeyDown={(e) => {
            if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
              e.preventDefault();
              void api.showAlbumMenu(a.id).catch(fail);
            }
          }}
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
        onTimeUpdate={() => {
          const a = audio.current!;
          if (!a.error && a.readyState >= 1)
            lastPlaybackPosition.current = a.currentTime;
          setPosition(a.currentTime);
        }}
        onEnded={() => advance(1, true)}
        onError={() => void playbackError()}
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
            <span>
              {recoveryId && (
                <>
                  <strong>Track unavailable</strong>
                  <br />
                </>
              )}
              {error}
            </span>
            {recoveryId && (
              <button
                className="quiet"
                disabled={busy}
                onClick={() => void locateTrack(recoveryId)}
              >
                Locate File…
              </button>
            )}
            {recoveryId && (
              <button
                className="quiet"
                onClick={() => {
                  setError("");
                  setRecoveryId(null);
                }}
              >
                Cancel
              </button>
            )}
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
              {!!report.copied && ` · ${report.copied} copied to Rhythm Media`}
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
        {consolidationReport && !busy && (
          <div className="notice" role="status">
            <Check size={18} />
            <span>
              <strong>Library consolidation complete</strong>
              <br />
              {consolidationReport.consolidated} tracks consolidated ·{" "}
              {consolidationReport.alreadyManaged} already managed ·{" "}
              {consolidationReport.failed} could not be consolidated
              {!!consolidationReport.errors.length && (
                <details>
                  <summary>View consolidation issues</summary>
                  <p>
                    Failed tracks remain referenced. Locate missing files, then
                    consolidate again to retry.
                  </p>
                  <ul>
                    {consolidationReport.errors.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}
            </span>
            <IconButton
              label="Dismiss consolidation report"
              onClick={() => setConsolidationReport(null)}
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
                    onContext={(ids, contextId) =>
                      showTrackMenu(
                        ids,
                        contextId,
                        !query ? activePlaylist?.id : undefined,
                      )
                    }
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
              renderTracks(detailTracks, true, true)
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
            {renderTracks(detailTracks, true)}
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
          <section
            className="media-settings"
            aria-labelledby="media-settings-title"
          >
            <h3 id="media-settings-title">Rhythm Media folder</h3>
            <p className="path">
              {data?.mediaSettings.root?.path ?? "No folder chosen"}
            </p>
            <button
              className="quiet"
              disabled={busy || !data?.libraryPath}
              onClick={() => void changeMedia()}
            >
              <FolderOpen size={17} />
              {data?.mediaSettings.root
                ? "Change Rhythm Media folder…"
                : "Choose Rhythm Media folder…"}
            </button>
            <label className="media-option">
              <input
                type="checkbox"
                checked={data?.mediaSettings.copyOnAdd ?? false}
                disabled={busy || !data?.mediaSettings.root}
                onChange={(e) =>
                  void changeMedia({ copyOnAdd: e.target.checked })
                }
                aria-describedby="media-copy-help"
              />
              <span>
                Copy files to Rhythm Media folder when adding to library
              </span>
            </label>
            <p id="media-copy-help" className="muted">
              {!data?.mediaSettings.root
                ? "Choose a folder to enable copying. "
                : ""}
              When on, Add Music and audio drops copy new music here. Originals
              stay unchanged. When off, files are referenced where they are.
            </p>
            <label className="media-option">
              <input
                type="checkbox"
                checked={data?.mediaSettings.keepOrganized ?? true}
                disabled={busy || !data?.libraryPath}
                onChange={(e) =>
                  void changeMedia({ keepOrganized: e.target.checked })
                }
                aria-describedby="media-organize-help"
              />
              <span>Keep Rhythm Media folder organized</span>
            </label>
            <p id="media-organize-help" className="muted">
              Organize new copies by Album Artist and Album. Existing files stay
              where they are. Playlist files reference music without copying it.
            </p>
            <p className="muted">
              {data?.tracks.filter((t) => t.locationKind === "managed")
                .length ?? 0}{" "}
              managed ·{" "}
              {data?.tracks.filter((t) => t.locationKind === "referenced")
                .length ?? 0}{" "}
              referenced
            </p>
            {!!data?.mediaSettings.pendingImports && (
              <p role="status">
                {data.mediaSettings.pendingImports} unfinished import
                {data.mediaSettings.pendingImports === 1 ? "" : "s"}. Add the
                original files again to retry; copies are checked before use.
              </p>
            )}
            {mediaError && (
              <p className="media-error" role="alert">
                {mediaError}
              </p>
            )}
            <button
              className="quiet"
              disabled={busy || !data?.libraryPath}
              onClick={() => setModal("consolidate")}
            >
              Consolidate Library…
            </button>
          </section>
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
      {modal === "info" && actionTrack && (
        <Modal title="Track Info" close={() => setModal(null)}>
          <p className="muted">Read only. Your audio file stays unchanged.</p>
          <dl className="track-info-fields">
            {(
              [
                ["Title", actionTrack.title],
                ["Artist", actionTrack.artist],
                ["Album", actionTrack.album],
                ["Album Artist", actionTrack.albumArtist],
                ["Genre", actionTrack.genre],
                ["Year", actionTrack.year || "—"],
                ["Track number", actionTrack.track || "—"],
                ["Disc number", actionTrack.disc || "—"],
                ["BPM", actionTrack.bpm || "—"],
                ["Comments", actionTrack.comments || "—"],
                ["Duration", time(actionTrack.duration)],
                ["Format", actionTrack.format.toUpperCase()],
                ["Codec", actionTrack.codec || "—"],
                [
                  "Bit rate",
                  actionTrack.bitRate
                    ? `${Math.round(actionTrack.bitRate / 1000)} kbps`
                    : "—",
                ],
                [
                  "Ownership",
                  actionTrack.locationKind === "managed"
                    ? "Managed copy in Rhythm Media"
                    : "Referenced file",
                ],
                [
                  "Availability",
                  actionTrack.missing
                    ? "Unavailable · use Locate File to reconnect"
                    : "Available",
                ],
                ["File location", actionTrack.path],
              ] as const
            ).map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="dialog-actions">
            <button className="quiet" onClick={() => setModal(null)}>
              Done
            </button>
          </div>
        </Modal>
      )}
      {modal === "consolidate" && (
        <Modal title="Consolidate Library?" close={() => setModal(null)}>
          <p>
            Copy referenced music into Rhythm Media. External originals stay
            where they are and remain unchanged.
          </p>
          <p className="muted">
            {tracks.filter((t) => t.locationKind === "referenced").length}{" "}
            referenced tracks to copy ·{" "}
            {tracks.filter((t) => t.locationKind === "managed").length} already
            managed and will be skipped.
          </p>
          <p className="muted">
            Successful tracks stay consolidated if another file fails. Running
            this again retries only referenced tracks.
          </p>
          {data?.mediaSettings.root ? (
            <p className="path">{data.mediaSettings.root.path}</p>
          ) : (
            <p>
              Choose a Rhythm Media folder in Library settings before
              consolidating.
            </p>
          )}
          <div className="dialog-actions">
            <button className="quiet" onClick={() => setModal(null)}>
              Cancel
            </button>
            {!data?.mediaSettings.root && (
              <button className="quiet" onClick={() => setModal("settings")}>
                Library settings
              </button>
            )}
            <button
              className="primary"
              disabled={
                busy ||
                !data?.mediaSettings.root ||
                !tracks.some((t) => t.locationKind === "referenced")
              }
              onClick={() => void consolidate()}
            >
              Consolidate library
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
