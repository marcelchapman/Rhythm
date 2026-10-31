import path from "node:path";
import { createHash } from "node:crypto";
import type { IAudioMetadata } from "music-metadata";
const clean = (v: unknown, fallback: string) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, 4000) : fallback;
const number = (v: unknown) =>
  typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
/** Shared import/edit display projection. Missing native values retain existing display fallbacks. */
export function trackMetadata(
  filename: string,
  metadata: Pick<IAudioMetadata, "common" | "format">,
) {
  const c = metadata.common,
    artist = clean(c.artist, "Unknown artist"),
    albumArtist = c.compilation
      ? "Various Artists"
      : clean(c.albumartist, artist);
  const folder = path.dirname(filename),
    albumFolder = /^(cd|disc|disk)[ _-]*\d+$/i.test(path.basename(folder))
      ? path.dirname(folder)
      : folder;
  const album = clean(c.album, path.basename(albumFolder));
  return {
    title: clean(c.title, path.basename(filename, path.extname(filename))),
    artist,
    albumArtist,
    album,
    albumId: createHash("sha256")
      .update(
        `${albumArtist.toLocaleLowerCase()}\0${album.toLocaleLowerCase()}\0${albumFolder}`,
      )
      .digest("hex"),
    genre: clean(c.genre?.join(", "), "Unknown genre"),
    year: number(c.year),
    disc: number(c.disk.no),
    track: number(c.track.no),
    duration: number(metadata.format.duration),
    bpm: number(c.bpm) || null,
    comments: clean(
      c.comment
        ?.map((v) => v.text ?? "")
        .filter(Boolean)
        .join("\n"),
      "",
    ),
    bitRate: number(metadata.format.bitrate) || null,
    codec: clean(metadata.format.codec, clean(metadata.format.container, "")),
    composer: clean(c.composer?.join(", "), ""),
    trackTotal: number(c.track.of) || null,
    discTotal: number(c.disk.of) || null,
  };
}
export type TrackMetadata = ReturnType<typeof trackMetadata>;
