import type { ViewPreferences, TrackListPatch } from "./preferences.js";
export interface Track {
  id: string;
  path: string;
  title: string;
  artist: string;
  albumArtist: string;
  album: string;
  albumId: string;
  genre: string;
  year: number;
  disc: number;
  track: number;
  duration: number;
  addedAt: number;
  favorite: boolean;
  missing: boolean;
  hasArtwork: boolean;
  format: string;
  bpm: number | null;
  comments: string;
  bitRate: number | null;
  codec: string;
  locationKind: "referenced" | "managed";
  mediaRootId: string | null;
  mediaRelativePath: string | null;
}
export interface MediaSettings {
  root: { id: string; path: string } | null;
  copyOnAdd: boolean;
  keepOrganized: boolean;
  pendingImports: number;
}
export interface Playlist {
  id: string;
  name: string;
  trackIds: string[];
}
export interface PlayerState {
  queue: string[];
  currentId: string | null;
  position: number;
  volume: number;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  view: string;
}
export interface Snapshot {
  libraryPath: string | null;
  tracks: Track[];
  playlists: Playlist[];
  roots: string[];
  state: PlayerState;
  preferences: ViewPreferences;
  mediaSettings: MediaSettings;
}
export interface PlaylistImportResult {
  playlist: Playlist;
  added: number;
  count: number;
  issueCount: number;
  issues: string[];
}
export interface ScanResult {
  added: number;
  updated: number;
  unchanged: number;
  errors: string[];
  skipped: number;
  copied?: number;
}
export interface DropImportResult extends ScanResult {
  playlists: PlaylistImportResult[];
  playlistErrors: string[];
}
export interface ConsolidationResult {
  consolidated: number;
  alreadyManaged: number;
  failed: number;
  errors: string[];
}
export type DesktopPlaylistEvent =
  { result: PlaylistImportResult } | { error: string } | { waiting: number };
export interface ScanProgress {
  scanned: number;
  current: string;
}
export type TrackAction = {
  command:
    | "play"
    | "next"
    | "queue"
    | "playlist"
    | "favorite"
    | "new-playlist"
    | "locate"
    | "consolidate"
    | "remove-from-playlist"
    | "delete-from-library"
    | "reveal"
    | "info";
  trackIds: string[];
  playlistId?: string;
};
export interface RhythmAPI {
  checkTrack(id: string): Promise<{ missing: boolean }>;
  revealTrack(id: string): Promise<void>;
  locateTrack(id: string): Promise<boolean>;
  consolidateTracks(ids?: string[]): Promise<ConsolidationResult | null>;
  showAlbumMenu(albumId: string): Promise<void>;
  chooseMediaRoot(): Promise<MediaSettings | null>;
  saveMediaSettings(patch: {
    copyOnAdd?: boolean;
    keepOrganized?: boolean;
  }): Promise<MediaSettings>;
  saveTrackListPreferences(patch: TrackListPatch): Promise<ViewPreferences>;
  desktopReady(): Promise<void>;
  onDesktopPlaylist(
    callback: (event: DesktopPlaylistEvent) => void,
  ): () => void;
  importPlaylist(): Promise<PlaylistImportResult | null>;
  exportPlaylist(
    id: string,
  ): Promise<{ count: number; unavailable: number } | null>;
  snapshot(): Promise<Snapshot>;
  chooseLibrary(): Promise<Snapshot | null>;
  importMusic(): Promise<ScanResult | null>;
  rescan(): Promise<ScanResult>;
  importDroppedFiles(files: File[]): Promise<DropImportResult>;
  addToPlaylist(id: string, trackIds: string[]): Promise<void>;
  showTrackMenu(
    trackIds: string[],
    contextTrackId?: string,
    playlistId?: string,
  ): Promise<void>;
  removeFromPlaylist(playlistId: string, trackId: string): Promise<void>;
  deleteTrack(id: string): Promise<boolean>;
  onTrackAction(callback: (action: TrackAction) => void): () => void;
  favorite(id: string): Promise<void>;
  createPlaylist(name: string): Promise<Playlist>;
  renamePlaylist(id: string, name: string): Promise<void>;
  deletePlaylist(id: string): Promise<void>;
  playlistTracks(id: string, trackIds: string[]): Promise<void>;
  saveState(state: PlayerState): Promise<void>;
  onProgress(callback: (progress: ScanProgress) => void): () => void;
  onCommand(callback: (command: string) => void): () => void;
}
export const defaultState = (): PlayerState => ({
  queue: [],
  currentId: null,
  position: 0,
  volume: 0.7,
  shuffle: false,
  repeat: "off",
  view: "Home",
});
