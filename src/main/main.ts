import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
} from "electron";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  stat,
  realpath,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "../domain/library.js";
import { defaultState, type TrackAction } from "../shared/types.js";
import { mediaResponse } from "./media.js";
import { normalizeViewPreferences } from "../shared/preferences.js";
import {
  importPlaylistFile,
  exportPlaylistFile,
} from "../domain/playlist-files.js";
import { ViewPreferenceStore } from "../domain/view-preferences.js";
import { PlaylistOpenInbox, isPlaylistFile } from "../domain/playlist-open.js";
import type { DesktopPlaylistEvent } from "../shared/types.js";
import type { TrackListPatch } from "../shared/preferences.js";

const here = path.dirname(fileURLToPath(import.meta.url));
app.setName("Rhythm");
if (process.env.RHYTHM_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.RHYTHM_DATA_DIR));
protocol.registerSchemesAsPrivileged([
  {
    scheme: "rhythm",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
  {
    scheme: "rhythm-media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
]);
let win: BrowserWindow | null = null;
let library: Library | null = null;
let startupError: string | null = null;
let playlistIO = false;
let choosingLibrary = false;
let preferences: ViewPreferenceStore;
let rendererReady = false;
let desktopInitialized = false;
const playlistInbox = new PlaylistOpenInbox();
const notifyPlaylist = (event: DesktopPlaylistEvent) =>
  win?.webContents.send("playlist:desktop", event);
async function flushPlaylistFiles() {
  if (rendererReady && !library && playlistInbox.size)
    notifyPlaylist({ waiting: playlistInbox.size });
  await playlistInbox.drain(
    () =>
      rendererReady &&
      !!library &&
      !playlistIO &&
      !choosingLibrary &&
      !library.scanning,
    async (filename) => {
      try {
        const result = await playlistOperation((l) =>
          importPlaylistFile(l, filename, (p) =>
            win?.webContents.send("scan:progress", p),
          ),
        );
        notifyPlaylist({ result });
      } catch (e) {
        notifyPlaylist({
          error: `${path.basename(filename)}: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    },
  );
}
function receivePlaylistFile(filename: string) {
  if (!path.isAbsolute(filename) || !isPlaylistFile(filename)) return;
  void realpath(filename)
    .catch(() => filename)
    .then((canonical) => {
      if (!playlistInbox.add(canonical)) return;
      if (desktopInitialized) {
        if (!win || win.isDestroyed()) void createWindow();
        else {
          if (win.isMinimized()) win.restore();
          win.show();
          win.focus();
        }
      }
      void flushPlaylistFiles();
    });
}
// Register before ready: Finder/Dock may deliver documents during cold startup.
app.on("open-file", (event, filename) => {
  if (!isPlaylistFile(filename)) return;
  event.preventDefault();
  receivePlaylistFile(filename);
});
async function playlistOperation<T>(operation: (l: Library) => Promise<T>) {
  if (playlistIO || library?.scanning || choosingLibrary)
    throw new Error("Wait for the current import/export to finish.");
  const l = requireLibrary();
  playlistIO = true;
  try {
    return await operation(l);
  } finally {
    playlistIO = false;
  }
}
const pointerPath = () => path.join(app.getPath("userData"), "library.json");
const snapshot = () => ({
  libraryPath: library?.directory ?? null,
  tracks: library?.tracks() ?? [],
  playlists: library?.playlists() ?? [],
  roots: library?.roots() ?? [],
  state: library?.state() ?? defaultState(),
  preferences: preferences?.get() ?? normalizeViewPreferences(),
  mediaSettings: library?.mediaSettings() ?? {
    root: null,
    copyOnAdd: false,
    keepOrganized: true,
    pendingImports: 0,
  },
});
function requireLibrary() {
  if (!library) throw new Error("Set up your Rhythm library first.");
  return library;
}
function send(command: string) {
  win?.webContents.send("player:command", command);
}

async function chooseLibrary() {
  if (library?.scanning || playlistIO || choosingLibrary)
    throw new Error("Wait for the current import before switching libraries.");
  choosingLibrary = true;
  try {
    const result = await dialog.showOpenDialog(win!, {
      title: "Choose where to store your Rhythm library",
      buttonLabel: "Use this folder",
      properties: ["openDirectory", "createDirectory"],
      message:
        "Rhythm stores its database here. Your music can stay in another folder.",
    });
    if (result.canceled) return null;
    if (library?.scanning || playlistIO)
      throw new Error(
        "Wait for the current import/export before switching libraries.",
      );
    const next = await Library.open(result.filePaths[0]);
    try {
      await preferences.migrateLegacy(next.legacyViewPreferences());
      await mkdir(app.getPath("userData"), { recursive: true });
      await writeFile(
        `${pointerPath()}.tmp`,
        JSON.stringify({ libraryPath: next.directory }),
        { mode: 0o600 },
      );
      await rename(`${pointerPath()}.tmp`, pointerPath());
    } catch (error) {
      next.close();
      throw error;
    }
    library?.close();
    library = next;
    rendererReady = false;
    send("library-changed");
    return snapshot();
  } finally {
    choosingLibrary = false;
  }
}
async function importMusic() {
  if (playlistIO || choosingLibrary)
    throw new Error("Wait for the current import/export to finish.");
  const current = requireLibrary();
  const result = await dialog.showOpenDialog(win!, {
    title: "Add music",
    buttonLabel: "Add music",
    properties: ["openFile", "openDirectory", "multiSelections"],
    message: current.mediaSettings().copyOnAdd
      ? "Rhythm copies new music into your Rhythm Media folder. Originals stay unchanged."
      : "Files stay where they are. Rhythm only reads and indexes your music.",
  });
  if (result.canceled) return null;
  if (playlistIO || current !== library)
    throw new Error(
      "The library changed or another import/export is running. Try again.",
    );
  return current.add(result.filePaths, (p) =>
    win?.webContents.send("scan:progress", p),
  );
}
function handlers() {
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(name, (event, ...args) => {
      if (event.senderFrame?.url !== "rhythm://app/index.html")
        throw new Error("Untrusted request.");
      return Promise.resolve(fn(...args)).finally(() => {
        setImmediate(() => void flushPlaylistFiles());
      });
    });
  handle("views:track-list", (patch: TrackListPatch) =>
    preferences.update(patch),
  );
  handle("media:settings", (patch) => {
    if (playlistIO || choosingLibrary)
      throw new Error("Wait for the current operation to finish.");
    return requireLibrary().saveMediaSettings(patch);
  });
  handle("media:choose-root", () =>
    playlistOperation(async (l) => {
      const result = await dialog.showOpenDialog(win!, {
        title: "Choose a Rhythm Media folder",
        buttonLabel: "Use this folder",
        properties: ["openDirectory", "createDirectory"],
        message:
          "New managed imports will be copied here. Existing files will stay where they are.",
      });
      return result.canceled ? null : l.chooseMediaRoot(result.filePaths[0]);
    }),
  );
  handle("track:check", (id: string) => requireLibrary().checkTrack(id));
  handle("track:locate", (id: string) =>
    playlistOperation(async (l) => {
      const track = l.tracks(id)[0];
      if (!track) throw new Error("Track no longer exists.");
      const result = await dialog.showOpenDialog(win!, {
        title: "Locate File",
        buttonLabel: "Locate File",
        properties: ["openFile"],
        filters: [
          {
            name: "Audio",
            extensions: [
              "mp3",
              "flac",
              "m4a",
              "aac",
              "ogg",
              "opus",
              "wav",
              "aif",
              "aiff",
            ],
          },
        ],
        message:
          track.locationKind === "managed"
            ? "Rhythm will restore a copy into Rhythm Media. The selected original stays unchanged."
            : "Relink this track to the selected file. It stays in place and is not copied.",
      });
      if (result.canceled) return false;
      await l.locateTrack(id, result.filePaths[0], (p) =>
        win?.webContents.send("scan:progress", p),
      );
      return true;
    }),
  );
  handle("media:consolidate", (ids?: string[]) =>
    playlistOperation((l) =>
      l.consolidate(ids, (p) => win?.webContents.send("scan:progress", p)),
    ),
  );
  handle("album:menu", (id: string) => {
    const ids = requireLibrary()
      .tracks()
      .filter((t) => t.albumId === id)
      .map((t) => t.id);
    return showTrackMenu(ids, true);
  });
  handle("desktop:ready", () => {
    rendererReady = true;
  });
  handle("playlist:import-file", () =>
    playlistOperation(async (l) => {
      const result = await dialog.showOpenDialog(win!, {
        title: "Import playlist",
        properties: ["openFile"],
        filters: [{ name: "M3U playlists", extensions: ["m3u8", "m3u"] }],
      });
      if (result.canceled) return null;
      return importPlaylistFile(l, result.filePaths[0], (p) =>
        win?.webContents.send("scan:progress", p),
      );
    }),
  );
  handle("playlist:export-file", (id: string) =>
    playlistOperation(async (l) => {
      const playlist = l.playlists().find((p) => p.id === id);
      if (!playlist) throw new Error("Choose a playlist to export.");
      const safeName = playlist.name.replace(/[/\\\0\r\n:]/g, "_");
      const result = await dialog.showSaveDialog(win!, {
        title: "Export playlist",
        defaultPath: `${safeName}.m3u8`,
        filters: [{ name: "UTF-8 M3U playlist", extensions: ["m3u8"] }],
      });
      if (result.canceled || !result.filePath) return null;
      const filename = /\.m3u8$/i.test(result.filePath)
        ? result.filePath
        : `${result.filePath}.m3u8`;
      return exportPlaylistFile(l, id, filename);
    }),
  );
  handle("library:drop", (paths: string[]) =>
    playlistOperation(async (l) => {
      if (
        !Array.isArray(paths) ||
        !paths.length ||
        paths.length > 1000 ||
        paths.some((p) => typeof p !== "string" || !path.isAbsolute(p))
      )
        throw new Error("Drop valid local music files, folders or playlists.");
      const unique = [...new Set(paths)];
      const scan = await l.add(
        unique.filter((p) => !isPlaylistFile(p)),
        (p) => win?.webContents.send("scan:progress", p),
      );
      const playlists = [],
        playlistErrors: string[] = [];
      for (const filename of unique.filter(isPlaylistFile)) {
        try {
          playlists.push(
            await importPlaylistFile(l, filename, (p) =>
              win?.webContents.send("scan:progress", p),
            ),
          );
        } catch (e) {
          playlistErrors.push(
            `${path.basename(filename)}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }
      return { ...scan, playlists, playlistErrors };
    }),
  );
  handle("playlist:add", (id: string, ids: string[]) =>
    requireLibrary().addToPlaylist(id, ids),
  );
  handle("track:menu", (ids: string[], contextId?: string) =>
    showTrackMenu(ids, false, contextId),
  );
  async function showTrackMenu(
    ids: string[],
    album = false,
    contextId = ids[0],
  ) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50000)
      throw new Error("Select tracks first.");
    const l = requireLibrary();
    if (ids.length === 1) await l.checkTrack(ids[0]);
    const indexed = new Map(l.tracks().map((t) => [t.id, t]));
    const tracks = [...new Set(ids)].map((id) => indexed.get(id));
    if (tracks.some((t) => !t)) throw new Error("Track no longer exists.");
    if (!ids.includes(contextId))
      throw new Error("Select the track to inspect.");
    const dispatch =
      (command: TrackAction["command"], playlistId?: string) => () =>
        win?.webContents.send("track:action", {
          command,
          trackIds: [...new Set(ids)],
          playlistId,
        } satisfies TrackAction);
    const playable = tracks.some((t) => !t!.missing);
    Menu.buildFromTemplate([
      {
        id: "track-play",
        label: "Play",
        enabled: playable,
        click: dispatch("play"),
      },
      {
        id: "track-next",
        label: "Play Next",
        enabled: playable,
        click: dispatch("next"),
      },
      {
        id: "track-queue",
        label: "Add to Queue",
        enabled: playable,
        click: dispatch("queue"),
      },
      { type: "separator" },
      {
        id: "track-playlist",
        label: "Add to Playlist",
        submenu: [
          ...l.playlists().map((p) => ({
            id: `playlist-${p.id}`,
            label: p.name.replace(/&/g, "&&"),
            click: dispatch("playlist", p.id),
          })),
          { type: "separator" as const },
          {
            id: "track-new-playlist",
            label: "New Playlist…",
            click: dispatch("new-playlist"),
          },
        ],
      },
      {
        id: "track-favorite",
        label: tracks.every((t) => t!.favorite)
          ? "Remove from Favourites"
          : "Favourite",
        click: dispatch("favorite"),
      },
      ...(tracks.length === 1 && tracks[0]!.missing
        ? [
            {
              id: "track-locate",
              label: "Locate File…",
              enabled: !playlistIO && !l.scanning,
              click: dispatch("locate"),
            },
          ]
        : []),
      ...(tracks.some((t) => t!.locationKind === "referenced")
        ? [
            {
              id: "track-consolidate",
              label: album
                ? "Consolidate Album to Rhythm Media"
                : "Consolidate to Rhythm Media",
              enabled: !!l.mediaSettings().root && !playlistIO && !l.scanning,
              click: dispatch("consolidate"),
            },
          ]
        : []),
      ...(!album
        ? [
            { type: "separator" as const },
            {
              id: "track-info",
              label: "Track Info…",
              click: () =>
                win?.webContents.send("track:action", {
                  command: "info",
                  trackIds: [contextId],
                } satisfies TrackAction),
            },
          ]
        : []),
    ]).popup({ window: win! });
  }
  handle("library:snapshot", snapshot);
  handle("library:choose", chooseLibrary);
  handle("library:import", importMusic);
  handle("library:rescan", () => {
    if (playlistIO || choosingLibrary)
      throw new Error("Wait for the current import/export to finish.");
    const l = requireLibrary();
    return l.scan(l.roots(), (p) => win?.webContents.send("scan:progress", p));
  });
  handle("library:favorite", (id: string) => requireLibrary().favorite(id));
  handle("playlist:create", (name: string) =>
    requireLibrary().createPlaylist(name),
  );
  handle("playlist:rename", (id: string, name: string) =>
    requireLibrary().renamePlaylist(id, name),
  );
  handle("playlist:delete", (id: string) =>
    requireLibrary().deletePlaylist(id),
  );
  handle("playlist:tracks", (id: string, ids: string[]) =>
    requireLibrary().playlistTracks(id, ids),
  );
  handle("player:save", (state) => library?.saveState(state));
}
async function createWindow() {
  if (win && !win.isDestroyed()) return;
  rendererReady = false;
  win = new BrowserWindow({
    title: "Rhythm",
    width: 1464,
    height: 940,
    minWidth: 980,
    minHeight: 660,
    backgroundColor: "#101720",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 17 },
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.on("close", () => {
    rendererReady = false;
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== "rhythm://app/index.html") event.preventDefault();
  });
  await win.loadURL("rhythm://app/index.html");
  if (startupError) {
    dialog.showErrorBox(
      "Library unavailable",
      `${startupError}\n\nChoose the existing library folder again, or create a new one. Your music has not been changed.`,
    );
    startupError = null;
  }
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    for (const filename of argv)
      if (path.isAbsolute(filename) && isPlaylistFile(filename))
        receivePlaylistFile(filename);
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      preferences = await ViewPreferenceStore.open(app.getPath("userData"));
      let rememberedLibrary = false;
      try {
        const pointer = JSON.parse(await readFile(pointerPath(), "utf8"));
        rememberedLibrary = true;
        // A remembered missing drive must never silently become a fresh library.
        await stat(path.join(pointer.libraryPath, "rhythm.sqlite"));
        library = await Library.open(pointer.libraryPath);
        await preferences.migrateLegacy(library.legacyViewPreferences());
      } catch (error) {
        if (
          rememberedLibrary ||
          (error as NodeJS.ErrnoException).code !== "ENOENT"
        )
          startupError = String(error);
      }
      protocol.handle("rhythm", async (request) => {
        const url = new URL(request.url);
        const relative =
          decodeURIComponent(url.pathname).replace(/^\//, "") || "index.html";
        const root = path.resolve(here, "../renderer");
        const filename = path.resolve(root, relative);
        if (
          url.hostname !== "app" ||
          !filename.startsWith(`${root}${path.sep}`)
        )
          return new Response(null, { status: 403 });
        const types: Record<string, string> = {
          ".html": "text/html",
          ".js": "application/javascript",
          ".css": "text/css",
          ".svg": "image/svg+xml",
          ".png": "image/png",
        };
        try {
          return new Response(new Uint8Array(await readFile(filename)), {
            headers: {
              "Content-Type":
                types[path.extname(filename)] ?? "application/octet-stream",
            },
          });
        } catch {
          return new Response(null, { status: 404 });
        }
      });
      protocol.handle("rhythm-media", async (request) => {
        const url = new URL(request.url);
        const id = url.pathname.slice(1);
        if (!/^[a-f0-9]{64}$/.test(id))
          return new Response(null, { status: 404 });
        if (url.hostname === "artwork") {
          const art = library?.artwork(id);
          return art
            ? new Response(new Uint8Array(art.artwork), {
                headers: {
                  "Content-Type": art.artworkType,
                  "Cache-Control": "no-store",
                },
              })
            : new Response(null, { status: 404 });
        }
        const track = url.hostname === "track" ? library?.media(id) : undefined;
        if (!track) return new Response(null, { status: 404 });
        const owner = library!;
        const response = await mediaResponse(track.path, track.format, request);
        if (response.status === 404 && owner === library)
          await owner.checkTrack(id);
        return response;
      });
      session.defaultSession.setPermissionRequestHandler(
        (_wc, _permission, callback) => callback(false),
      );
      session.defaultSession.webRequest.onBeforeRequest((details, callback) =>
        callback({
          cancel: !["rhythm:", "rhythm-media:", "devtools:"].includes(
            new URL(details.url).protocol,
          ),
        }),
      );
      handlers();
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          ...(process.platform === "darwin"
            ? [
                {
                  label: "Rhythm",
                  submenu: [
                    { role: "about" as const },
                    { type: "separator" as const },
                    { role: "hide" as const },
                    { role: "quit" as const },
                  ],
                },
              ]
            : []),
          {
            label: "File",
            submenu: [
              { label: "Choose Library…", click: () => send("choose-library") },
              {
                label: "Add Music…",
                accelerator: "CmdOrCtrl+O",
                click: () => send("import"),
              },
              {
                label: "New Playlist…",
                accelerator: "CmdOrCtrl+N",
                click: () => send("new-playlist"),
              },
              {
                label: "Import Playlist…",
                click: () => send("import-playlist"),
              },
              {
                label: "Export Playlist…",
                click: () => send("export-playlist"),
              },
              {
                label: "Consolidate Library…",
                click: () => send("consolidate-library"),
              },
              { type: "separator" },
              { role: "close" },
            ],
          },
          {
            label: "Edit",
            submenu: [
              { role: "undo" },
              { role: "redo" },
              { type: "separator" },
              { role: "cut" },
              { role: "copy" },
              { role: "paste" },
              { role: "selectAll" },
            ],
          },
          {
            label: "Playback",
            submenu: [
              { label: "Play / Pause", click: () => send("toggle") },
              {
                label: "Next",
                accelerator: "CmdOrCtrl+Right",
                click: () => send("next"),
              },
              {
                label: "Previous",
                accelerator: "CmdOrCtrl+Left",
                click: () => send("previous"),
              },
            ],
          },
          {
            label: "View",
            submenu: [
              { role: "togglefullscreen" },
              ...(!app.isPackaged ? [{ role: "toggleDevTools" as const }] : []),
            ],
          },
        ]),
      );
      desktopInitialized = true;
      for (const filename of process.argv)
        if (path.isAbsolute(filename) && isPlaylistFile(filename))
          playlistInbox.add(await realpath(filename).catch(() => filename));
      await createWindow();
      app.on("activate", () => {
        if (BrowserWindow.getAllWindows().length === 0) void createWindow();
      });
    })
    .catch((error) => {
      dialog.showErrorBox("Rhythm could not start", String(error));
      app.quit();
    });
  app.on("window-all-closed", () => {
    win = null;
    rendererReady = false;
    if (process.platform === "darwin" && playlistInbox.size) {
      void createWindow();
      return;
    }
    if (process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", () => {
    library?.close();
    library = null;
  });
  let preferencesFlushed = false;
  app.on("before-quit", (event) => {
    if (preferencesFlushed || !preferences) return;
    event.preventDefault();
    void preferences.flush().then(() => {
      preferencesFlushed = true;
      app.quit();
    });
  });
}
