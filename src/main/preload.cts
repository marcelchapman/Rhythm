import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  PlayerState,
  ScanProgress,
  RhythmAPI,
  TrackAction,
} from "../shared/types.js";
const api: RhythmAPI = {
  checkTrack: (id) => ipcRenderer.invoke("track:check", id),
  revealTrack: (id) => ipcRenderer.invoke("track:reveal", id),
  locateTrack: (id) => ipcRenderer.invoke("track:locate", id),
  consolidateTracks: (ids) => ipcRenderer.invoke("media:consolidate", ids),
  showAlbumMenu: (id) => ipcRenderer.invoke("album:menu", id),
  chooseMediaRoot: () => ipcRenderer.invoke("media:choose-root"),
  saveMediaSettings: (patch) => ipcRenderer.invoke("media:settings", patch),
  saveTrackListPreferences: (patch) =>
    ipcRenderer.invoke("views:track-list", patch),
  desktopReady: () => ipcRenderer.invoke("desktop:ready"),
  onDesktopPlaylist: (callback) => {
    const listener = (
      _: unknown,
      event: import("../shared/types.js").DesktopPlaylistEvent,
    ) => callback(event);
    ipcRenderer.on("playlist:desktop", listener);
    return () => ipcRenderer.removeListener("playlist:desktop", listener);
  },
  importPlaylist: () => ipcRenderer.invoke("playlist:import-file"),
  exportPlaylist: (id) => ipcRenderer.invoke("playlist:export-file", id),
  importDroppedFiles: (files: File[]) => {
    const paths = files
      .map((file) => webUtils.getPathForFile(file))
      .filter(Boolean);
    if (!paths.length)
      return Promise.reject(
        new Error("Drop files or folders from your file manager."),
      );
    return ipcRenderer.invoke("library:drop", paths);
  },
  addToPlaylist: (id, ids) => ipcRenderer.invoke("playlist:add", id, ids),
  showTrackMenu: (ids, contextId, playlistId) =>
    ipcRenderer.invoke("track:menu", ids, contextId, playlistId),
  removeFromPlaylist: (playlistId, trackId) =>
    ipcRenderer.invoke("playlist:remove-track", playlistId, trackId),
  deleteTrack: (id) => ipcRenderer.invoke("track:delete", id),
  onTrackAction: (callback: (action: TrackAction) => void) => {
    const listener = (_: unknown, action: TrackAction) => callback(action);
    ipcRenderer.on("track:action", listener);
    return () => ipcRenderer.removeListener("track:action", listener);
  },
  snapshot: () => ipcRenderer.invoke("library:snapshot"),
  chooseLibrary: () => ipcRenderer.invoke("library:choose"),
  importMusic: () => ipcRenderer.invoke("library:import"),
  rescan: () => ipcRenderer.invoke("library:rescan"),
  favorite: (id: string) => ipcRenderer.invoke("library:favorite", id),
  createPlaylist: (name: string) => ipcRenderer.invoke("playlist:create", name),
  renamePlaylist: (id: string, name: string) =>
    ipcRenderer.invoke("playlist:rename", id, name),
  deletePlaylist: (id: string) => ipcRenderer.invoke("playlist:delete", id),
  playlistTracks: (id: string, trackIds: string[]) =>
    ipcRenderer.invoke("playlist:tracks", id, trackIds),
  saveState: (state: PlayerState) => ipcRenderer.invoke("player:save", state),
  onProgress: (callback: (p: ScanProgress) => void) => {
    const listener = (_: unknown, progress: ScanProgress) => callback(progress);
    ipcRenderer.on("scan:progress", listener);
    return () => ipcRenderer.removeListener("scan:progress", listener);
  },
  onCommand: (callback: (command: string) => void) => {
    const listener = (_: unknown, command: string) => callback(command);
    ipcRenderer.on("player:command", listener);
    return () => ipcRenderer.removeListener("player:command", listener);
  },
};
contextBridge.exposeInMainWorld("rhythm", api);
