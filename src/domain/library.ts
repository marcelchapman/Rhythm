import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  realpath,
  readdir,
  stat,
  access,
  lstat,
} from "node:fs/promises";
import path from "node:path";
import { parseFile, selectCover } from "music-metadata";
import { inside } from "./media-plan.js";
import {
  fileDigest,
  prepareManagedCopy,
  finishManagedCopy,
  validateManagedLocation,
  validateManagedTrash,
  planManagedAlbumCleanup,
  removeEmptyManagedAlbumDirectory,
  type ManagedAlbumDirectory,
  type ManagedLocation,
  type MediaRoot,
} from "./managed-copy.js";
import {
  defaultState,
  type Track,
  type Playlist,
  type PlayerState,
  type ScanResult,
  type ScanProgress,
  type MediaSettings,
  type ConsolidationResult,
  type TrackRemovalResult,
} from "../shared/types.js";

class TrashedTrackRemovalError extends Error {}

export const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".flac",
  ".m4a",
  ".aac",
  ".ogg",
  ".opus",
  ".wav",
  ".aif",
  ".aiff",
]);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const clean = (value: unknown, fallback: string) =>
  typeof value === "string" && value.trim()
    ? value.trim().slice(0, 4000)
    : fallback;
const numeric = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
export function normalizeState(
  value: Partial<PlayerState>,
  ids: Set<string>,
): PlayerState {
  const queue = Array.isArray(value.queue)
    ? value.queue
        .filter((id): id is string => typeof id === "string" && ids.has(id))
        .slice(0, 50000)
    : [];
  return {
    queue,
    currentId:
      value.currentId && ids.has(value.currentId) ? value.currentId : null,
    position:
      value.currentId && ids.has(value.currentId) ? numeric(value.position) : 0,
    volume: Math.max(
      0,
      Math.min(
        1,
        typeof value.volume === "number" && Number.isFinite(value.volume)
          ? value.volume
          : 0.7,
      ),
    ),
    shuffle: value.shuffle === true,
    repeat: ["all", "one"].includes(value.repeat ?? "") ? value.repeat! : "off",
    view: typeof value.view === "string" ? value.view.slice(0, 200) : "Home",
  };
}

/** SQLite belongs to Rhythm. External source audio is only ever opened for reading. */
export class Library {
  readonly db: DatabaseSync;
  scanning = false;
  private constructor(
    readonly directory: string,
    db: DatabaseSync,
  ) {
    this.db = db;
  }

  static async open(directory: string): Promise<Library> {
    if (!path.isAbsolute(directory))
      throw new Error("Choose an absolute library folder.");
    await mkdir(directory, { recursive: true });
    const canonical = await realpath(directory);
    const filename = path.join(canonical, "rhythm.sqlite");
    // Never claim an existing unrelated SQLite database as a Rhythm library.
    let exists = false;
    try {
      await access(filename);
      exists = true;
    } catch {
      /* New library. */
    }
    if (exists) {
      const check = new DatabaseSync(filename, { readOnly: true });
      try {
        const result = check.prepare("PRAGMA application_id").get() as {
          application_id: number;
        };
        if (result.application_id !== 1380471885)
          throw new Error(
            "This folder contains a database that is not a Rhythm library. Choose another folder.",
          );
        const version = check.prepare("PRAGMA user_version").get() as {
          user_version: number;
        };
        if (version.user_version > 3)
          throw new Error("This library needs a newer version of Rhythm.");
      } finally {
        check.close();
      }
    }
    const db = new DatabaseSync(filename);
    db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS tracks (
        id TEXT PRIMARY KEY, path TEXT UNIQUE NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
        albumArtist TEXT NOT NULL, album TEXT NOT NULL, albumId TEXT NOT NULL, genre TEXT NOT NULL,
        year INTEGER NOT NULL, disc INTEGER NOT NULL, track INTEGER NOT NULL, duration REAL NOT NULL,
        addedAt INTEGER NOT NULL, favorite INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
        format TEXT NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL, artwork BLOB, artworkType TEXT
      );
      CREATE INDEX IF NOT EXISTS tracks_album ON tracks(albumId);
      CREATE TABLE IF NOT EXISTS roots (path TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS playlists (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS playlist_tracks (
        playlistId TEXT REFERENCES playlists(id) ON DELETE CASCADE,
        trackId TEXT REFERENCES tracks(id) ON DELETE CASCADE, position INTEGER NOT NULL,
        PRIMARY KEY(playlistId, trackId)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA application_id=1380471885;`);
    // Additive, atomic migration: preserve track IDs, playlists, and all user state.
    const version = db.prepare("PRAGMA user_version").get()!
      .user_version as number;
    if (version < 2) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`ALTER TABLE tracks ADD COLUMN bpm REAL;
          ALTER TABLE tracks ADD COLUMN comments TEXT NOT NULL DEFAULT '';
          ALTER TABLE tracks ADD COLUMN bitRate REAL;
          ALTER TABLE tracks ADD COLUMN codec TEXT NOT NULL DEFAULT '';
          ALTER TABLE tracks ADD COLUMN metadataVersion INTEGER NOT NULL DEFAULT 0;
          PRAGMA user_version=2; COMMIT;`);
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
      }
    }
    if (version < 3) {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(`CREATE TABLE media_roots(id TEXT PRIMARY KEY);
          CREATE TABLE media_root_locations(rootId TEXT PRIMARY KEY REFERENCES media_roots(id), path TEXT UNIQUE NOT NULL, device TEXT NOT NULL, inode TEXT NOT NULL);
          CREATE TABLE track_locations(trackId TEXT PRIMARY KEY REFERENCES tracks(id) ON DELETE CASCADE,
            kind TEXT NOT NULL CHECK(kind IN ('referenced','managed')),
            mediaRootId TEXT REFERENCES media_roots(id), relativePath TEXT,
            CHECK((kind='referenced' AND mediaRootId IS NULL AND relativePath IS NULL) OR (kind='managed' AND mediaRootId IS NOT NULL AND relativePath IS NOT NULL)));
          INSERT INTO track_locations(trackId,kind) SELECT id,'referenced' FROM tracks;
          CREATE TABLE managed_imports(id TEXT PRIMARY KEY, source TEXT NOT NULL, digest TEXT NOT NULL,
            rootId TEXT NOT NULL REFERENCES media_roots(id), relative TEXT NOT NULL, stage TEXT NOT NULL,
            stageDevice TEXT, stageInode TEXT, status TEXT NOT NULL CHECK(status IN ('copying','ready','done')),
            trackId TEXT NOT NULL, UNIQUE(source,digest,rootId));
          PRAGMA user_version=3; COMMIT;`);
      } catch (error) {
        db.exec("ROLLBACK");
        db.close();
        throw error;
      }
    }
    return new Library(canonical, db);
  }

  tracks(id?: string): Track[] {
    const query = this.db.prepare(
      `SELECT t.id,path,title,artist,albumArtist,album,albumId,genre,year,disc,track,duration,size AS fileSize,addedAt,favorite,missing,format,bpm,comments,bitRate,codec,artwork IS NOT NULL AS hasArtwork,
        COALESCE(l.kind,'referenced') AS locationKind,l.mediaRootId,l.relativePath AS mediaRelativePath FROM tracks t LEFT JOIN track_locations l ON l.trackId=t.id ${id ? "WHERE t.id=?" : ""} ORDER BY album COLLATE NOCASE, disc, track, title COLLATE NOCASE`,
    );
    const rows = id ? query.all(id) : query.all();
    return rows.map((row) => ({
      ...row,
      fileSize:
        typeof row.fileSize === "number" &&
        Number.isSafeInteger(row.fileSize) &&
        row.fileSize >= 0
          ? row.fileSize
          : null,
      favorite: !!row.favorite,
      missing: !!row.missing,
      hasArtwork: !!row.hasArtwork,
    })) as unknown as Track[];
  }
  albumTracks(id: string): Track[] {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
      throw new Error("Choose a valid album.");
    const tracks = this.tracks().filter((track) => track.albumId === id);
    if (!tracks.length) throw new Error("Album no longer exists.");
    return tracks;
  }
  async albumLocations(id: string) {
    const tracks = this.albumTracks(id);
    const folders = new Map<string, { path: string; count: number }>();
    const missing: string[] = [];
    const locations: { id: string; path: string }[] = [];
    for (const track of tracks) {
      // Playback and track reveal use this same authoritative location.
      const location = this.media(track.id);
      locations.push({ id: track.id, path: location?.path ?? "" });
      try {
        if (!location || !(await stat(location.path)).isFile())
          throw new Error("Unavailable audio file");
        const directory = path.dirname(await realpath(location.path));
        const info = await stat(directory);
        const key = `${info.dev}:${info.ino}`;
        const folder = folders.get(key);
        if (folder) folder.count++;
        else folders.set(key, { path: directory, count: 1 });
      } catch {
        missing.push(track.id);
      }
    }
    return {
      name: tracks[0].album,
      locations,
      folders: [...folders.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      missing,
    };
  }
  roots(): string[] {
    return this.db
      .prepare("SELECT path FROM roots ORDER BY path")
      .all()
      .map((row) => row.path as string);
  }
  mediaSettings(): MediaSettings {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='media'")
      .get();
    let saved: {
      rootId?: string;
      copyOnAdd?: boolean;
      keepOrganized?: boolean;
    } = {};
    try {
      saved = row ? (JSON.parse(String(row.value)) ?? {}) : {};
    } catch {
      /* Defaults are reference-only. */
    }
    const root =
      typeof saved.rootId === "string"
        ? (this.db
            .prepare(
              "SELECT rootId AS id,path FROM media_root_locations WHERE rootId=?",
            )
            .get(saved.rootId) as unknown as
            { id: string; path: string } | undefined)
        : undefined;
    return {
      root: root ?? null,
      copyOnAdd: !!root && saved.copyOnAdd === true,
      keepOrganized: saved.keepOrganized !== false,
      pendingImports: Number(
        this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM managed_imports WHERE status!='done'",
          )
          .get()!.n,
      ),
    };
  }
  private writeMediaSettings(value: MediaSettings) {
    this.db
      .prepare(
        "INSERT INTO settings VALUES('media',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(
        JSON.stringify({
          rootId: value.root?.id,
          copyOnAdd: value.copyOnAdd,
          keepOrganized: value.keepOrganized,
        }),
      );
  }
  saveMediaSettings(patch: {
    copyOnAdd?: boolean;
    keepOrganized?: boolean;
  }): MediaSettings {
    if (this.scanning)
      throw new Error("Wait for the current import to finish.");
    if (
      !patch ||
      Object.keys(patch).some(
        (k) =>
          !["copyOnAdd", "keepOrganized"].includes(k) ||
          typeof patch[k as keyof typeof patch] !== "boolean",
      )
    )
      throw new Error("Invalid media settings.");
    const value = { ...this.mediaSettings(), ...patch };
    if (value.copyOnAdd && !value.root)
      throw new Error("Choose a Rhythm Media folder before enabling copying.");
    this.writeMediaSettings(value);
    return this.mediaSettings();
  }
  async chooseMediaRoot(directory: string): Promise<MediaSettings> {
    if (this.scanning)
      throw new Error("Wait for the current import to finish.");
    if (!path.isAbsolute(directory))
      throw new Error("Choose an absolute Rhythm Media folder.");
    this.scanning = true;
    try {
      const canonical = await realpath(directory),
        info = await lstat(canonical);
      if (
        !info.isDirectory() ||
        canonical === path.parse(canonical).root ||
        canonical === this.directory ||
        inside(canonical, this.directory)
      )
        throw new Error(
          "Choose a dedicated music folder, separate from the library database folder.",
        );
      const existing = this.db
        .prepare("SELECT rootId AS id FROM media_root_locations WHERE path=?")
        .get(canonical);
      const id = (existing?.id as string) || randomUUID();
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.prepare("INSERT OR IGNORE INTO media_roots VALUES(?)").run(id);
        this.db
          .prepare(
            "INSERT INTO media_root_locations VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET device=excluded.device,inode=excluded.inode",
          )
          .run(id, canonical, String(info.dev), String(info.ino));
        this.writeMediaSettings({
          ...this.mediaSettings(),
          root: { id, path: canonical },
        });
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return this.mediaSettings();
    } finally {
      this.scanning = false;
    }
  }
  /** Playlist/rescan aliases reuse a copied track only when the original bytes still match. */
  async trackForFile(filename: string): Promise<Track | undefined> {
    const direct = this.db
      .prepare("SELECT id FROM tracks WHERE path=?")
      .get(filename);
    if (direct) return this.tracks(String(direct.id))[0];
    const receipts = this.db
      .prepare(
        "SELECT trackId,digest FROM managed_imports WHERE source=? AND status='done'",
      )
      .all(filename);
    if (!receipts.length) return;
    const digest = await fileDigest(filename);
    const receipt = receipts.find((r) => r.digest === digest);
    const track = receipt && this.tracks(String(receipt.trackId))[0];
    if (track && (await fileDigest(track.path)) === digest) return track;
  }
  add(directories: string[], progress?: (p: ScanProgress) => void) {
    return this.scan(directories, progress, { copy: true });
  }
  /** Authority outside configured media roots is read/copy only, including recovery. */
  async checkTrack(id: string): Promise<{ missing: boolean }> {
    const track = this.tracks(id)[0];
    if (!track) throw new Error("Track no longer exists.");
    let missing = false;
    try {
      missing = !(await stat(track.path)).isFile();
    } catch {
      missing = true;
    }
    this.db
      .prepare("UPDATE tracks SET missing=? WHERE id=? AND path=?")
      .run(Number(missing), id, track.path);
    return { missing };
  }
  private selectedMediaRoot(): MediaRoot {
    const root = this.mediaSettings().root;
    if (!root)
      throw new Error(
        "Choose a Rhythm Media folder in Library settings first.",
      );
    return this.db
      .prepare(
        "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
      )
      .get(root.id) as unknown as MediaRoot;
  }
  async locateTrack(
    id: string,
    selected: string,
    progress?: (p: ScanProgress) => void,
  ) {
    if (this.scanning)
      throw new Error("Wait for the current import to finish.");
    this.scanning = true;
    try {
      const track = this.tracks(id)[0];
      if (!track) throw new Error("Track no longer exists.");
      if (
        !path.isAbsolute(selected) ||
        !AUDIO_EXTENSIONS.has(path.extname(selected).toLowerCase())
      )
        throw new Error("Choose a supported audio file.");
      const canonical = await realpath(selected);
      if (!(await stat(canonical)).isFile())
        throw new Error("Choose a supported audio file.");
      const other = this.db
        .prepare("SELECT id FROM tracks WHERE path=? AND id!=?")
        .get(canonical, id);
      if (other)
        throw new Error(
          "This file is already linked to another track. Choose a different file.",
        );
      let restoreCopy = track.locationKind === "managed";
      if (restoreCopy) {
        const root = this.selectedMediaRoot();
        if (
          canonical === track.path &&
          track.mediaRootId === root.id &&
          track.mediaRelativePath
        ) {
          await validateManagedLocation(root, track.mediaRelativePath);
          restoreCopy = false;
        }
      }
      // Handoff to the common serialized scanner without an asynchronous gap.
      this.scanning = false;
      const result = await this.scan([canonical], progress, {
        targetId: id,
        forceCopy: restoreCopy,
        recovery: true,
      });
      if (result.errors.length || result.updated !== 1)
        throw new Error(
          result.errors.join("\n") ||
            "The file could not be recovered. Choose its source again.",
        );
    } finally {
      this.scanning = false;
    }
  }
  async consolidate(
    ids?: string[],
    progress?: (p: ScanProgress) => void,
  ): Promise<ConsolidationResult> {
    if (this.scanning)
      throw new Error("Wait for the current import to finish.");
    const all = this.tracks();
    if (
      ids &&
      (!Array.isArray(ids) ||
        !ids.length ||
        ids.length > 50000 ||
        ids.some((id) => typeof id !== "string"))
    )
      throw new Error("Select valid tracks to consolidate.");
    const wanted = ids ? new Set(ids) : null;
    const selected = wanted ? all.filter((t) => wanted.has(t.id)) : all;
    if (wanted && selected.length !== wanted.size)
      throw new Error("A selected track no longer exists.");
    const referenced = selected.filter((t) => t.locationKind === "referenced");
    const alreadyManaged = selected.length - referenced.length;
    if (!referenced.length)
      return { consolidated: 0, alreadyManaged, failed: 0, errors: [] };
    this.selectedMediaRoot();
    const result = await this.scan(
      referenced.map((t) => t.path),
      progress,
      { forceCopy: true },
    );
    return {
      consolidated: result.updated,
      alreadyManaged,
      failed: referenced.length - result.updated,
      errors: result.errors,
    };
  }
  playlists(): Playlist[] {
    return this.db
      .prepare("SELECT * FROM playlists ORDER BY name COLLATE NOCASE")
      .all()
      .map((row) => ({
        id: row.id as string,
        name: row.name as string,
        trackIds: this.db
          .prepare(
            "SELECT trackId FROM playlist_tracks WHERE playlistId=? ORDER BY position",
          )
          .all(row.id!)
          .map((t) => t.trackId as string),
      }));
  }
  state(): PlayerState {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='player'")
      .get();
    try {
      return normalizeState(
        row ? JSON.parse(row.value as string) : defaultState(),
        new Set(this.tracks().map((t) => t.id)),
      );
    } catch {
      return defaultState();
    }
  }
  saveState(state: PlayerState) {
    const valid = normalizeState(
      state,
      new Set(
        this.db
          .prepare("SELECT id FROM tracks")
          .all()
          .map((t) => t.id as string),
      ),
    );
    this.db
      .prepare(
        "INSERT INTO settings VALUES('player',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(JSON.stringify(valid));
  }
  legacyViewPreferences(): unknown {
    const row = this.db
      .prepare("SELECT value FROM settings WHERE key='views'")
      .get();
    try {
      return row ? JSON.parse(row.value as string) : undefined;
    } catch {
      return undefined;
    }
  }
  favorite(id: string) {
    this.db.prepare("UPDATE tracks SET favorite=1-favorite WHERE id=?").run(id);
  }
  createPlaylist(name: string, trackIds: string[] = []): Playlist {
    name = this.playlistName(name);
    if (
      !Array.isArray(trackIds) ||
      trackIds.length > 50000 ||
      trackIds.some((id) => typeof id !== "string")
    )
      throw new Error("Invalid playlist tracks.");
    const id = randomUUID();
    const ids = [...new Set(trackIds)];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO playlists VALUES(?,?)").run(id, name);
      const insert = this.db.prepare(
        "INSERT INTO playlist_tracks VALUES(?,?,?)",
      );
      ids.forEach((trackId, position) => insert.run(id, trackId, position));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    return { id, name, trackIds: ids };
  }
  private playlistName(name: string) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
      throw new Error("Use a playlist name between 1 and 120 characters.");
    return name.trim();
  }
  duplicatePlaylist(id: string): Playlist {
    const playlists = this.playlists();
    const source = playlists.find((playlist) => playlist.id === id);
    if (!source) throw new Error("Playlist no longer exists.");
    const names = new Set(
      playlists.map((playlist) => playlist.name.toLocaleLowerCase()),
    );
    for (let number = 1; ; number++) {
      const suffix = number === 1 ? " copy" : ` copy ${number}`;
      // Keep the existing 120 UTF-16-unit limit without splitting a surrogate pair.
      const base = source.name
        .slice(0, 120 - suffix.length)
        .replace(/[\uD800-\uDBFF]$/, "")
        .trimEnd();
      const name = `${base}${suffix}`;
      if (!names.has(name.toLocaleLowerCase()))
        return this.createPlaylist(name, source.trackIds);
    }
  }
  renamePlaylist(id: string, name: string) {
    this.db
      .prepare("UPDATE playlists SET name=? WHERE id=?")
      .run(this.playlistName(name), id);
  }
  deletePlaylist(id: string) {
    this.db.prepare("DELETE FROM playlists WHERE id=?").run(id);
  }
  /** Remove only the requested memberships; preserve remaining positions and order. */
  removeFromPlaylist(playlistId: string, trackIds: string | string[]) {
    const tracks = this.removalTracks(
      Array.isArray(trackIds) ? trackIds : [trackIds],
    );
    if (!this.db.prepare("SELECT id FROM playlists WHERE id=?").get(playlistId))
      throw new Error("Playlist no longer exists.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const remove = this.db.prepare(
        "DELETE FROM playlist_tracks WHERE playlistId=? AND trackId=?",
      );
      for (const track of tracks) remove.run(playlistId, track.id);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Resolve/classify the entire selection before confirmation or mutation. */
  removalTracks(ids: string[]) {
    if (
      !Array.isArray(ids) ||
      !ids.length ||
      ids.length > 50000 ||
      ids.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    )
      throw new Error("Choose a valid track to remove.");
    const indexed = new Map(this.tracks().map((track) => [track.id, track]));
    return [...new Set(ids)].map((id) => {
      const track = indexed.get(id);
      if (!track) throw new Error("Track no longer exists.");
      return track;
    });
  }
  private sameRemovalLocation(before: Track, current: Track | undefined) {
    return (
      current &&
      current.path === before.path &&
      current.locationKind === before.locationKind &&
      current.mediaRootId === before.mediaRootId &&
      current.mediaRelativePath === before.mediaRelativePath
    );
  }
  /** One confirmation, then independent guarded transactions. Failed identities survive. */
  async deleteTracks(
    confirmed: Track[],
    trash: (filename: string) => Promise<void>,
    options: { cleanupEmptyAlbumDirectories?: boolean } = {},
  ): Promise<TrackRemovalResult> {
    if (this.scanning)
      throw new Error("Wait for the current media operation to finish.");
    const current = this.removalTracks(confirmed.map((track) => track.id));
    if (
      current.some((track, i) => !this.sameRemovalLocation(confirmed[i], track))
    )
      throw new Error(
        "The track location changed. Choose Delete from Library again to review it.",
      );
    const result: TrackRemovalResult = { removedIds: [], failures: [] };
    const directories = new Map<string, ManagedAlbumDirectory>();
    const cleanupWarnings: NonNullable<TrackRemovalResult["cleanupWarnings"]> =
      [];
    this.scanning = true;
    try {
      for (const track of confirmed) {
        try {
          if (!this.sameRemovalLocation(track, this.tracks(track.id)[0]))
            throw new Error(
              "The track location changed. Choose Delete from Library again to review it.",
            );
          const cleanup = await this.deleteTrackEntry(
            track.id,
            trash,
            options.cleanupEmptyAlbumDirectories,
          );
          result.removedIds.push(track.id);
          cleanupWarnings.push(...cleanup.warnings);
          for (const directory of cleanup.directories) {
            const key = `${directory.root.id}\0${directory.relative}`;
            if (!directories.has(key)) directories.set(key, directory);
          }
        } catch (error) {
          result.failures.push({
            id: track.id,
            title: track.title,
            message: error instanceof Error ? error.message : String(error),
            fileTrashed: error instanceof TrashedTrackRemovalError,
          });
        }
      }
      // Only successfully trashed AND committed managed tracks contribute candidates.
      // Children first through their actual ancestor chain, excluding registered roots.
      let registeredRoots:
        { path: string; device: string; inode: string }[] | undefined;
      if (directories.size) {
        try {
          registeredRoots = this.db
            .prepare("SELECT path,device,inode FROM media_root_locations")
            .all()
            .map((root) => ({
              path: String(root.path),
              device: String(root.device),
              inode: String(root.inode),
            }));
        } catch (error) {
          cleanupWarnings.push({
            path: directories.values().next().value!.root.path,
            message: `Managed folder boundaries could not be checked; folders were left in place. ${error instanceof Error ? error.message : String(error)}`,
          });
        }
      }
      for (const directory of (registeredRoots
        ? [...directories.values()]
        : []
      ).sort(
        (a, b) => b.relative.split("/").length - a.relative.split("/").length,
      )) {
        const target = path.resolve(directory.root.path, directory.relative);
        const identity = directory.parents.at(-1)!;
        // A nested/historical media root can overlap an older copy's album path.
        // Stop at every registered root, including ancestors of nested/historical roots.
        if (
          registeredRoots!.some(
            (root) =>
              (root.device === identity.device &&
                root.inode === identity.inode) ||
              target === root.path ||
              inside(target, root.path),
          )
        )
          continue;
        try {
          await removeEmptyManagedAlbumDirectory(directory, trash);
        } catch (error) {
          cleanupWarnings.push({
            path: target,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      if (cleanupWarnings.length) result.cleanupWarnings = cleanupWarnings;
      return result;
    } finally {
      this.scanning = false;
    }
  }
  /** Called only after native confirmation. The shell adapter can only trash a validated copy. */
  async deleteTrack(id: string, trash: (filename: string) => Promise<void>) {
    const tracks = this.removalTracks([id]);
    const result = await this.deleteTracks(tracks, trash);
    if (result.failures.length) throw new Error(result.failures[0].message);
  }
  private async deleteTrackEntry(
    id: string,
    trash: (filename: string) => Promise<void>,
    cleanupEmptyAlbumDirectories = false,
  ) {
    let trashed = false;
    let directories: ManagedAlbumDirectory[] = [];
    const warnings: NonNullable<TrackRemovalResult["cleanupWarnings"]> = [];
    try {
      const track = this.tracks(id)[0];
      if (!track) throw new Error("Track no longer exists.");
      let managedPath: string | undefined;
      if (track.locationKind === "managed") {
        const root = this.db
          .prepare(
            "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
          )
          .get(track.mediaRootId!) as unknown as MediaRoot | undefined;
        if (!root || !track.mediaRelativePath)
          throw new Error(
            "The managed-media authority is unavailable. The track has not been removed.",
          );
        if (cleanupEmptyAlbumDirectories) {
          try {
            directories = await planManagedAlbumCleanup(
              root,
              track.path,
              track.mediaRelativePath,
            );
          } catch (error) {
            warnings.push({
              path: path.dirname(track.path),
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
        managedPath = await validateManagedTrash(
          this.db,
          root,
          id,
          track.path,
          track.mediaRelativePath,
        );
      }
      // Preflight database writability before touching the filesystem. Never hold
      // a transaction across async shell work (player saves share this connection).
      // Filesystem and SQLite are not atomic: a later database failure retains
      // the identity and explicitly reports that the file is in Trash.
      this.db.exec("BEGIN IMMEDIATE");
      this.db.exec("COMMIT");
      if (managedPath) {
        await trash(managedPath);
        trashed = true;
      }
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const state = this.state();
        const sources = this.db
          .prepare("SELECT source FROM managed_imports WHERE trackId=?")
          .all(id);
        for (const filename of [
          track.path,
          ...sources.map((s) => String(s.source)),
        ])
          this.db
            .prepare(
              "DELETE FROM roots WHERE path=? AND NOT EXISTS (SELECT 1 FROM tracks WHERE path=? AND id!=?)",
            )
            .run(filename, filename, id);
        this.db.prepare("DELETE FROM managed_imports WHERE trackId=?").run(id);
        this.db.prepare("DELETE FROM tracks WHERE id=?").run(id);
        this.saveState({
          ...state,
          queue: state.queue.filter((queued) => queued !== id),
          currentId: state.currentId === id ? null : state.currentId,
          position: state.currentId === id ? 0 : state.position,
        });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { directories, warnings };
    } catch (error) {
      if (trashed) {
        await this.checkTrack(id).catch(() => {});
        throw new TrashedTrackRemovalError(
          `The file was moved to the Trash, but its library entry could not be removed. Restore it from Trash or use Locate File to recover it. ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      throw error;
    }
  }
  playlistTracks(id: string, trackIds: string[]) {
    if (!this.db.prepare("SELECT id FROM playlists WHERE id=?").get(id))
      throw new Error("Playlist no longer exists.");
    if (
      !Array.isArray(trackIds) ||
      trackIds.length > 50000 ||
      trackIds.some((t) => typeof t !== "string")
    )
      throw new Error("Invalid playlist tracks.");
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM playlist_tracks WHERE playlistId=?").run(id);
      const insert = this.db.prepare(
        "INSERT INTO playlist_tracks VALUES(?,?,?)",
      );
      [...new Set(trackIds)].forEach((trackId, i) =>
        insert.run(id, trackId, i),
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  /** Append against the current database state, never a stale renderer snapshot. */
  addToPlaylist(id: string, trackIds: string[]) {
    if (
      !Array.isArray(trackIds) ||
      trackIds.length > 50000 ||
      trackIds.some((t) => typeof t !== "string")
    )
      throw new Error("Invalid playlist tracks.");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (!this.db.prepare("SELECT id FROM playlists WHERE id=?").get(id))
        throw new Error("Playlist no longer exists.");
      const existing = this.db
        .prepare("SELECT trackId FROM playlist_tracks WHERE playlistId=?")
        .all(id);
      const ids = new Set(existing.map((t) => t.trackId as string));
      const additions = [...new Set(trackIds)].filter((t) => !ids.has(t));
      if (ids.size + additions.length > 50000)
        throw new Error("A playlist can contain at most 50,000 songs.");
      let position =
        Number(
          this.db
            .prepare(
              "SELECT COALESCE(MAX(position),-1) AS last FROM playlist_tracks WHERE playlistId=?",
            )
            .get(id)!.last,
        ) + 1;
      const insert = this.db.prepare(
        "INSERT INTO playlist_tracks VALUES(?,?,?)",
      );
      for (const trackId of additions) insert.run(id, trackId, position++);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  media(id: string): { path: string; format: string } | undefined {
    return this.db
      .prepare("SELECT path,format FROM tracks WHERE id=?")
      .get(id) as { path: string; format: string } | undefined;
  }
  artwork(
    id: string,
  ): { artwork: Uint8Array; artworkType: string } | undefined {
    return this.db
      .prepare(
        "SELECT artwork,artworkType FROM tracks WHERE id=? AND artwork IS NOT NULL",
      )
      .get(id) as { artwork: Uint8Array; artworkType: string } | undefined;
  }

  async scan(
    directories: string[],
    progress?: (p: ScanProgress) => void,
    options: {
      copy?: boolean;
      forceCopy?: boolean;
      targetId?: string;
      recovery?: boolean;
    } = {},
  ): Promise<ScanResult> {
    if (this.scanning) throw new Error("An import is already running.");
    this.scanning = true;
    const settings = this.mediaSettings();
    const copying =
      options.forceCopy === true ||
      (options.copy === true && settings.copyOnAdd);
    const mediaRoot = settings.root
      ? (this.db
          .prepare(
            "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
          )
          .get(settings.root.id) as unknown as MediaRoot)
      : null;
    const result: ScanResult = {
      added: 0,
      updated: 0,
      unchanged: 0,
      errors: [],
      skipped: 0,
    };
    const seen = new Set<string>();
    let scanned = 0;
    const report = (message: string) => {
      if (result.errors.length < 100) result.errors.push(message);
    };
    const inspect = async (filename: string) => {
      if (!AUDIO_EXTENSIONS.has(path.extname(filename).toLowerCase())) {
        result.skipped++;
        return;
      }
      try {
        let canonical = await realpath(filename);
        const sourceStem = path.basename(canonical, path.extname(canonical));
        if (seen.has(canonical)) return;
        seen.add(canonical);
        let info = await stat(canonical);
        const reserved = this.db
          .prepare(
            "SELECT r.path,j.relative,j.stageDevice,j.stageInode FROM managed_imports j JOIN media_root_locations r ON r.rootId=j.rootId WHERE j.status!='done'",
          )
          .all();
        if (
          reserved.some(
            (row) =>
              path.join(String(row.path), String(row.relative)) === canonical ||
              (String(info.dev) === row.stageDevice &&
                String(info.ino) === row.stageInode),
          )
        ) {
          result.skipped++;
          report(
            `${path.basename(canonical)}: Unfinished managed import. Add the original file again to retry.`,
          );
          return;
        }
        let old = this.db
          .prepare(
            `SELECT id,path,size,mtime,metadataVersion FROM tracks WHERE ${options.targetId ? "id" : "path"}=?`,
          )
          .get(options.targetId ?? canonical);
        if (options.forceCopy && !old)
          throw new Error(
            "The referenced file location changed. Use Locate File before consolidating.",
          );
        let managed: ManagedLocation | undefined;
        if (
          copying &&
          mediaRoot &&
          !old?.id &&
          (await this.trackForFile(canonical))
        ) {
          result.unchanged++;
          return;
        }
        if (!copying && !old && (await this.trackForFile(canonical))) {
          result.unchanged++;
          return;
        }
        const knownManaged =
          old &&
          this.db
            .prepare("SELECT kind FROM track_locations WHERE trackId=?")
            .get(old.id!)?.kind === "managed";
        if (
          copying &&
          mediaRoot &&
          (!knownManaged || options.recovery) &&
          (options.forceCopy ||
            (canonical !== mediaRoot.path &&
              !inside(mediaRoot.path, canonical)))
        ) {
          const expectedDigest = await fileDigest(canonical);
          const parsed = await parseFile(canonical, {
            duration: true,
            skipPostHeaders: true,
          });
          if (!parsed.format.sampleRate || !parsed.format.numberOfChannels)
            throw new Error("No supported audio stream found.");
          const c = parsed.common;
          managed = await prepareManagedCopy(
            this.db,
            mediaRoot,
            canonical,
            {
              albumArtist: c.albumartist,
              artist: c.artist,
              album: c.album,
              title: c.title,
              compilation: c.compilation,
              track: c.track.no ?? undefined,
              disc: c.disk.no ?? undefined,
              discTotal: c.disk.of ?? undefined,
            },
            settings.keepOrganized,
            old?.id as string | undefined,
            expectedDigest,
            options.recovery,
          );
          canonical = managed.path;
          info = await stat(canonical);
          old = this.db
            .prepare(
              "SELECT id,path,size,mtime,metadataVersion FROM tracks WHERE id=?",
            )
            .get(managed.trackId);
        }
        if (
          !managed &&
          !options.targetId &&
          old &&
          old.metadataVersion === 2 &&
          old.size === info.size &&
          old.mtime === info.mtimeMs
        ) {
          this.db
            .prepare("UPDATE tracks SET missing=0 WHERE path=?")
            .run(canonical);
          result.unchanged++;
          return;
        }
        const metadata = await parseFile(canonical, {
          duration: true,
          skipPostHeaders: true,
        });
        if (!metadata.format.sampleRate || !metadata.format.numberOfChannels)
          throw new Error("No supported audio stream found.");
        const c = metadata.common;
        const artist = clean(c.artist, "Unknown artist");
        const albumArtist = c.compilation
          ? "Various Artists"
          : clean(c.albumartist, artist);
        const folder = path.dirname(canonical);
        const albumFolder = /^(cd|disc|disk)[ _-]*\d+$/i.test(
          path.basename(folder),
        )
          ? path.dirname(folder)
          : folder;
        const album = clean(c.album, path.basename(albumFolder));
        const cover = selectCover(c.picture);
        // Bound database growth; malformed or huge cover payloads are not cached.
        const validCover =
          cover &&
          cover.data.length <= 10 * 1024 * 1024 &&
          ["image/jpeg", "image/png", "image/webp"].includes(cover.format)
            ? cover
            : undefined;
        const values = [
          managed?.trackId ??
            (old?.id as string | undefined) ??
            hash(randomUUID()),
          canonical,
          clean(c.title, sourceStem),
          artist,
          albumArtist,
          album,
          hash(
            `${albumArtist.toLocaleLowerCase()}\0${album.toLocaleLowerCase()}\0${albumFolder}`,
          ),
          clean(c.genre?.join(", "), "Unknown genre"),
          numeric(c.year),
          numeric(c.disk.no),
          numeric(c.track.no),
          numeric(metadata.format.duration),
          Date.now(),
          path.extname(canonical).slice(1).toLowerCase(),
          info.size,
          info.mtimeMs,
          validCover ? Buffer.from(validCover.data) : null,
          validCover?.format ?? null,
          numeric(c.bpm) || null,
          clean(
            c.comment
              ?.map((comment) => comment.text ?? "")
              .filter(Boolean)
              .join("\n"),
            "",
          ),
          numeric(metadata.format.bitrate) || null,
          clean(metadata.format.codec, clean(metadata.format.container, "")),
          2,
        ];
        this.db.exec("BEGIN IMMEDIATE");
        try {
          this.db
            .prepare(
              `INSERT INTO tracks(id,path,title,artist,albumArtist,album,albumId,genre,year,disc,track,duration,addedAt,format,size,mtime,artwork,artworkType,bpm,comments,bitRate,codec,metadataVersion)
          VALUES(${values.map(() => "?").join(",")}) ON CONFLICT(id) DO UPDATE SET path=excluded.path,
          title=excluded.title,artist=excluded.artist,albumArtist=excluded.albumArtist,album=excluded.album,albumId=excluded.albumId,
          genre=excluded.genre,year=excluded.year,disc=excluded.disc,track=excluded.track,duration=excluded.duration,
          format=excluded.format,size=excluded.size,mtime=excluded.mtime,artwork=excluded.artwork,artworkType=excluded.artworkType,bpm=excluded.bpm,comments=excluded.comments,bitRate=excluded.bitRate,codec=excluded.codec,metadataVersion=excluded.metadataVersion,missing=0`,
            )
            .run(...values);
          if (managed) {
            this.db
              .prepare(
                "INSERT INTO track_locations VALUES(?,'managed',?,?) ON CONFLICT(trackId) DO UPDATE SET kind='managed',mediaRootId=excluded.mediaRootId,relativePath=excluded.relativePath",
              )
              .run(managed.trackId, managed.rootId, managed.relative);
            this.db
              .prepare("UPDATE managed_imports SET status='done' WHERE id=?")
              .run(managed.jobId);
            this.db
              .prepare("INSERT OR IGNORE INTO roots VALUES(?)")
              .run(mediaRoot!.path);
          } else
            this.db
              .prepare(
                "INSERT OR IGNORE INTO track_locations(trackId,kind) VALUES(?,'referenced')",
              )
              .run(values[0]!);
          if ((copying && !managed) || options.targetId)
            this.db
              .prepare("INSERT OR IGNORE INTO roots VALUES(?)")
              .run(canonical);
          this.db.exec("COMMIT");
        } catch (e) {
          this.db.exec("ROLLBACK");
          throw e;
        }
        if (managed) {
          result.copied = (result.copied ?? 0) + 1;
          await finishManagedCopy(this.db, mediaRoot!, managed);
        }
        if (old) result.updated++;
        else result.added++;
      } catch (error) {
        report(
          `${path.basename(filename)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        scanned++;
        progress?.({ scanned, current: path.basename(filename) });
      }
    };
    const walk = async (directory: string): Promise<boolean> => {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        report(`Cannot read ${directory}: ${String(error)}`);
        return false;
      }
      let complete = true;
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!(await walk(filename))) complete = false;
        } else if (entry.isFile()) await inspect(filename);
        // Do not follow symlinks: avoids cycles and escaping the selected tree.
      }
      return complete;
    };
    try {
      for (const directory of directories) {
        let root: string;
        try {
          root = await realpath(directory);
          const info = await stat(root);
          if (info.isFile()) {
            if (AUDIO_EXTENSIONS.has(path.extname(root).toLowerCase())) {
              if (!copying && !options.targetId)
                this.db
                  .prepare("INSERT OR IGNORE INTO roots VALUES(?)")
                  .run(root);
              await inspect(root);
            } else result.skipped++;
            continue;
          }
          if (!info.isDirectory()) throw new Error("Not a file or folder");
          if (options.forceCopy || options.targetId)
            throw new Error("Choose a supported audio file.");
        } catch {
          report(`Music folder unavailable: ${directory}`);
          continue;
        }
        if (!copying)
          this.db.prepare("INSERT OR IGNORE INTO roots VALUES(?)").run(root);
        const complete = await walk(root);
        // Incomplete traversal never marks a whole unavailable subtree missing.
        if (complete && !copying) {
          const missing = this.db.prepare(
            "UPDATE tracks SET missing=1 WHERE id=?",
          );
          for (const t of this.tracks()) {
            const relative = path.relative(root, t.path);
            if (
              relative &&
              !relative.startsWith(`..${path.sep}`) &&
              relative !== ".." &&
              !path.isAbsolute(relative) &&
              !seen.has(t.path)
            )
              missing.run(t.id);
          }
        }
      }
      return result;
    } finally {
      this.scanning = false;
    }
  }
  close() {
    this.db.close();
  }
}
