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
}
export interface ScanResult {
  added: number;
  updated: number;
  unchanged: number;
  errors: string[];
  skipped: number;
}
export interface ScanProgress {
  scanned: number;
  current: string;
}
export interface RhythmAPI {
  snapshot(): Promise<Snapshot>;
  chooseLibrary(): Promise<Snapshot | null>;
  importMusic(): Promise<ScanResult | null>;
  rescan(): Promise<ScanResult>;
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
