import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
} from "electron";
import { readFile, writeFile, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Library } from "../domain/library.js";
import { defaultState, type TrackAction } from "../shared/types.js";
import { mediaResponse } from "./media.js";

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
const pointerPath = () => path.join(app.getPath("userData"), "library.json");
const snapshot = () => ({
  libraryPath: library?.directory ?? null,
  tracks: library?.tracks() ?? [],
  playlists: library?.playlists() ?? [],
  roots: library?.roots() ?? [],
  state: library?.state() ?? defaultState(),
});
function requireLibrary() {
  if (!library) throw new Error("Set up your Rhythm library first.");
  return library;
}
function send(command: string) {
  win?.webContents.send("player:command", command);
}

async function chooseLibrary() {
  if (library?.scanning)
    throw new Error("Wait for the current import before switching libraries.");
  const result = await dialog.showOpenDialog(win!, {
    title: "Choose where to store your Rhythm library",
    buttonLabel: "Use this folder",
    properties: ["openDirectory", "createDirectory"],
    message:
      "Rhythm stores its database here. Your music can stay in another folder.",
  });
  if (result.canceled) return null;
  const next = await Library.open(result.filePaths[0]);
  try {
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
  send("library-changed");
  return snapshot();
}
async function importMusic() {
  const current = requireLibrary();
  const result = await dialog.showOpenDialog(win!, {
    title: "Add music folders",
    buttonLabel: "Add music",
    properties: ["openDirectory", "multiSelections"],
    message:
      "Files stay where they are. Rhythm only reads and indexes your music.",
  });
  if (result.canceled) return null;
  return current.scan(result.filePaths, (p) =>
    win?.webContents.send("scan:progress", p),
  );
}
function handlers() {
  const handle = (name: string, fn: (...args: any[]) => unknown) =>
    ipcMain.handle(name, (event, ...args) => {
      if (event.senderFrame?.url !== "rhythm://app/index.html")
        throw new Error("Untrusted request.");
      return fn(...args);
    });
  handle("library:drop", (paths: string[]) => {
    if (
      !Array.isArray(paths) ||
      !paths.length ||
      paths.length > 1000 ||
      paths.some((p) => typeof p !== "string" || !path.isAbsolute(p))
    )
      throw new Error("Drop valid local music files or folders.");
    return requireLibrary().scan(paths, (p) =>
      win?.webContents.send("scan:progress", p),
    );
  });
  handle("playlist:add", (id: string, ids: string[]) =>
    requireLibrary().addToPlaylist(id, ids),
  );
  handle("track:menu", (ids: string[]) => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 50000)
      throw new Error("Select tracks first.");
    const l = requireLibrary();
    const indexed = new Map(l.tracks().map((t) => [t.id, t]));
    const tracks = [...new Set(ids)].map((id) => indexed.get(id));
    if (tracks.some((t) => !t)) throw new Error("Track no longer exists.");
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
    ]).popup({ window: win! });
  });
  handle("library:snapshot", snapshot);
  handle("library:choose", chooseLibrary);
  handle("library:import", importMusic);
  handle("library:rescan", () => {
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
  app.on("second-instance", () => {
    win?.show();
    win?.focus();
  });
  app
    .whenReady()
    .then(async () => {
      let rememberedLibrary = false;
      try {
        const pointer = JSON.parse(await readFile(pointerPath(), "utf8"));
        rememberedLibrary = true;
        // A remembered missing drive must never silently become a fresh library.
        await stat(path.join(pointer.libraryPath, "rhythm.sqlite"));
        library = await Library.open(pointer.libraryPath);
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
      protocol.handle("rhythm-media", (request) => {
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
        return track
          ? mediaResponse(track.path, track.format, request)
          : new Response(null, { status: 404 });
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
    if (process.platform !== "darwin") app.quit();
  });
  app.on("will-quit", () => {
    library?.close();
    library = null;
  });
}
