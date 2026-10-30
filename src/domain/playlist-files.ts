import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  readFile,
  realpath,
  stat,
  lstat,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import { Library, AUDIO_EXTENSIONS } from "./library.js";
import { parseM3U, serializeM3U, MAX_PLAYLIST_BYTES } from "./m3u.js";
import type { PlaylistImportResult, ScanProgress } from "../shared/types.js";

export async function importPlaylistFile(
  library: Library,
  filename: string,
  progress?: (p: ScanProgress) => void,
): Promise<PlaylistImportResult> {
  if (!/\.m3u8?$/i.test(filename))
    throw new Error("Choose an M3U or M3U8 playlist.");
  if ((await stat(filename)).size > MAX_PLAYLIST_BYTES)
    throw new Error("Playlist exceeds the 10 MB limit.");
  const parsed = parseM3U(await readFile(filename), filename);
  const candidates: string[] = [];
  const seen = new Set<string>();
  const issue = (message: string) => {
    parsed.issueCount++;
    if (parsed.issues.length < 100) parsed.issues.push(message.slice(0, 800));
  };
  for (const entry of parsed.entries) {
    try {
      if (!AUDIO_EXTENSIONS.has(path.extname(entry.path).toLowerCase()))
        throw new Error("Unsupported audio type");
      const canonical = await realpath(entry.path);
      if (!(await stat(canonical)).isFile())
        throw new Error("Not an audio file");
      if (!seen.has(canonical)) {
        seen.add(canonical);
        candidates.push(canonical);
      }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      const message =
        code === "ENOENT" || code === "ENOTDIR"
          ? "File unavailable"
          : code === "EACCES" || code === "EPERM"
            ? "Permission denied"
            : e instanceof Error
              ? e.message
              : "Cannot read file";
      issue(`Line ${entry.line}: ${message} (${entry.path})`);
    }
  }
  const scan = await library.scan(candidates, progress);
  const ids: string[] = [];
  for (const file of candidates) {
    const id = (await library.trackForFile(file))?.id;
    if (id) ids.push(id);
    else issue(`Could not index: ${file}`);
  }
  const base =
    path.basename(filename, path.extname(filename)).trim().slice(0, 110) ||
    "Imported playlist";
  const names = new Set(
    library.playlists().map((p) => p.name.toLocaleLowerCase()),
  );
  let name = base,
    suffix = 2;
  while (names.has(name.toLocaleLowerCase())) name = `${base} (${suffix++})`;
  const playlist = library.createPlaylist(name, ids);
  return {
    playlist,
    added: scan.added,
    count: ids.length,
    issueCount: parsed.issueCount,
    issues: parsed.issues,
  };
}

export async function exportPlaylistFile(
  library: Library,
  id: string,
  destination: string,
) {
  if (
    !path.isAbsolute(destination) ||
    path.extname(destination).toLowerCase() !== ".m3u8"
  )
    throw new Error("Export as an absolute .m3u8 file path.");
  const playlist = library.playlists().find((p) => p.id === id);
  if (!playlist) throw new Error("Playlist no longer exists.");
  const tracks = new Map(library.tracks().map((t) => [t.id, t]));
  const ordered = playlist.trackIds.map((trackId) => {
    const track = tracks.get(trackId);
    if (!track)
      throw new Error("Playlist references a track no longer in the library.");
    return track;
  });
  // Canonical parent makes relative references work even when the dialog folder is a symlink.
  const filename = path.join(
    await realpath(path.dirname(destination)),
    path.basename(destination),
  );
  const text = serializeM3U(ordered, filename);
  let existing;
  try {
    existing = await lstat(filename);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  if (existing) {
    if (!existing.isFile() || existing.isSymbolicLink())
      throw new Error(
        "Choose a regular playlist file, not a folder or symbolic link.",
      );
    const canonical = await realpath(filename);
    for (const track of tracks.values()) {
      if (track.path === canonical)
        throw new Error("Cannot overwrite source audio.");
      if (existing.nlink < 2) continue;
      try {
        const source = await stat(track.path);
        if (source.dev === existing.dev && source.ino === existing.ino)
          throw new Error("Cannot overwrite source audio.");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }
  }
  const temporary = path.join(
    path.dirname(filename),
    `.rio-playlist-${randomUUID()}.tmp`,
  );
  try {
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(text, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, filename);
  } finally {
    await unlink(temporary).catch(() => {});
  }
  return {
    count: ordered.length,
    unavailable: ordered.filter((t) => t.missing).length,
  };
}
