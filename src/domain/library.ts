import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, realpath, readdir, stat, access } from "node:fs/promises";
import path from "node:path";
import { parseFile, selectCover } from "music-metadata";
import {
  defaultState,
  type Track,
  type Playlist,
  type PlayerState,
  type ScanResult,
  type ScanProgress,
} from "../shared/types.js";

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
    position: numeric(value.position),
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

/** SQLite belongs to Rhythm; source audio is only ever opened for reading. */
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
        if (version.user_version > 1)
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
      PRAGMA application_id=1380471885; PRAGMA user_version=1;`);
    return new Library(canonical, db);
  }

  tracks(): Track[] {
    const rows = this.db
      .prepare(
        `SELECT id,path,title,artist,albumArtist,album,albumId,genre,year,disc,track,duration,addedAt,favorite,missing,format,artwork IS NOT NULL AS hasArtwork FROM tracks ORDER BY album COLLATE NOCASE, disc, track, title COLLATE NOCASE`,
      )
      .all();
    return rows.map((row) => ({
      ...row,
      favorite: !!row.favorite,
      missing: !!row.missing,
      hasArtwork: !!row.hasArtwork,
    })) as unknown as Track[];
  }
  roots(): string[] {
    return this.db
      .prepare("SELECT path FROM roots ORDER BY path")
      .all()
      .map((row) => row.path as string);
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
  favorite(id: string) {
    this.db.prepare("UPDATE tracks SET favorite=1-favorite WHERE id=?").run(id);
  }
  createPlaylist(name: string): Playlist {
    name = this.playlistName(name);
    const id = randomUUID();
    this.db.prepare("INSERT INTO playlists VALUES(?,?)").run(id, name);
    return { id, name, trackIds: [] };
  }
  private playlistName(name: string) {
    if (typeof name !== "string" || !name.trim() || name.trim().length > 120)
      throw new Error("Use a playlist name between 1 and 120 characters.");
    return name.trim();
  }
  renamePlaylist(id: string, name: string) {
    this.db
      .prepare("UPDATE playlists SET name=? WHERE id=?")
      .run(this.playlistName(name), id);
  }
  deletePlaylist(id: string) {
    this.db.prepare("DELETE FROM playlists WHERE id=?").run(id);
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
  ): Promise<ScanResult> {
    if (this.scanning) throw new Error("An import is already running.");
    this.scanning = true;
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
        const canonical = await realpath(filename);
        if (seen.has(canonical)) return;
        seen.add(canonical);
        const info = await stat(canonical);
        const old = this.db
          .prepare("SELECT size,mtime FROM tracks WHERE path=?")
          .get(canonical);
        if (old && old.size === info.size && old.mtime === info.mtimeMs) {
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
        const albumArtist = clean(
          c.albumartist,
          c.compilation ? "Various Artists" : artist,
        );
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
          hash(canonical),
          canonical,
          clean(c.title, path.basename(canonical, path.extname(canonical))),
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
        ];
        this.db
          .prepare(
            `INSERT INTO tracks(id,path,title,artist,albumArtist,album,albumId,genre,year,disc,track,duration,addedAt,format,size,mtime,artwork,artworkType)
          VALUES(${values.map(() => "?").join(",")}) ON CONFLICT(path) DO UPDATE SET
          title=excluded.title,artist=excluded.artist,albumArtist=excluded.albumArtist,album=excluded.album,albumId=excluded.albumId,
          genre=excluded.genre,year=excluded.year,disc=excluded.disc,track=excluded.track,duration=excluded.duration,
          format=excluded.format,size=excluded.size,mtime=excluded.mtime,artwork=excluded.artwork,artworkType=excluded.artworkType,missing=0`,
          )
          .run(...values);
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
          if (!(await stat(root)).isDirectory())
            throw new Error("Not a folder");
        } catch {
          report(`Music folder unavailable: ${directory}`);
          continue;
        }
        this.db.prepare("INSERT OR IGNORE INTO roots VALUES(?)").run(root);
        const complete = await walk(root);
        // Incomplete traversal never marks a whole unavailable subtree missing.
        if (complete) {
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
