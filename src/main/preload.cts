import { contextBridge, ipcRenderer } from "electron";
import type { PlayerState, ScanProgress, RhythmAPI } from "../shared/types.js";
const api: RhythmAPI = {
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
