import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Track } from "../shared/types.js";

export const MAX_PLAYLIST_BYTES = 10 * 1024 * 1024;
export const MAX_PLAYLIST_ENTRIES = 50000;
export interface PlaylistEntry {
  path: string;
  line: number;
}
export interface ParsedPlaylist {
  entries: PlaylistEntry[];
  issues: string[];
  issueCount: number;
}

/** Local-file M3U only. Directives never become media or network requests. */
export function parseM3U(bytes: Uint8Array, filename: string): ParsedPlaylist {
  if (bytes.byteLength > MAX_PLAYLIST_BYTES)
    throw new Error("Playlist exceeds the 10 MB limit.");
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(
      "Playlist is not valid UTF-8. Save it as UTF-8 M3U8 and try again.",
    );
  }
  const result: ParsedPlaylist = { entries: [], issues: [], issueCount: 0 };
  let count = 0;
  for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
    const entry = raw.trim();
    if (!entry || entry.startsWith("#")) continue;
    if (++count > MAX_PLAYLIST_ENTRIES)
      throw new Error("Playlist exceeds the 50,000-entry limit.");
    try {
      if (entry.includes("\0")) throw new Error("Invalid path");
      let local = entry;
      if (/^file:/i.test(local)) local = fileURLToPath(new URL(local));
      else if (/^[a-z][a-z\d+.-]*:/i.test(local) && !path.isAbsolute(local))
        throw new Error("Only local file paths are supported");
      result.entries.push({
        path: path.resolve(path.dirname(filename), local),
        line: index + 1,
      });
    } catch (e) {
      result.issueCount++;
      if (result.issues.length < 100)
        result.issues.push(
          `Line ${index + 1}: ${e instanceof Error ? e.message : "Invalid entry"} (${entry.slice(0, 200)})`,
        );
    }
  }
  return result;
}

/** Relative references only within the export directory's tree; external roots stay absolute. */
export function serializeM3U(
  tracks: Pick<Track, "path" | "artist" | "title" | "duration">[],
  filename: string,
): string {
  const lines = ["#EXTM3U"];
  const label = (s: string) => s.replace(/[\r\n\0]/g, " ");
  for (const track of tracks) {
    if (
      !path.isAbsolute(track.path) ||
      /[\r\n\0]/.test(track.path) ||
      track.path.trim() !== track.path
    )
      throw new Error(
        "A track path cannot be represented safely in an M3U playlist.",
      );
    const relative = path.relative(path.dirname(filename), track.path);
    const local =
      relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative);
    const reference = local ? `.${path.sep}${relative}` : track.path;
    lines.push(
      `#EXTINF:${Math.max(0, Math.floor(track.duration))},${label(track.artist)} - ${label(track.title)}`,
      reference,
    );
  }
  return `${lines.join("\n")}\n`;
}
