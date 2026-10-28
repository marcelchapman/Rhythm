// Disposable qualification helpers, deliberately separate from Rhythm's writer/indexer.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, realpath, lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { parseFile } from "../../node_modules/music-metadata/lib/index.js";

export const lab = path.dirname(fileURLToPath(import.meta.url));
export const generated = path.join(lab, "generated");
export const sha = (data) => createHash("sha256").update(data).digest("hex");
export function command(program, args) {
  return execFileSync(program, args, {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
}
// Every writer entry point must pass this lab-only guard. No caller-supplied music paths.
export async function fixture(file) {
  const root = await realpath(generated),
    canonical = await realpath(file);
  if (
    !canonical.startsWith(root + path.sep) ||
    !(await lstat(file)).isFile() ||
    (await lstat(file)).isSymbolicLink()
  )
    throw Error(
      "LAB SAFETY: only existing generated regular fixtures may be edited",
    );
  return canonical;
}
export function ffmpeg(args) {
  command("ffmpeg", ["-v", "error", "-nostdin", ...args]);
}
export function packets(file) {
  const result = JSON.parse(
    command("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "a:0",
      "-show_packets",
      "-show_data_hash",
      "sha256",
      "-show_entries",
      "packet=size,data_hash",
      "-of",
      "json",
      file,
    ]),
  );
  if (!result.packets?.length || result.packets.some((p) => !p.data_hash))
    throw Error("No independently hashed audio packets");
  return {
    count: result.packets.length,
    sha256: sha(
      JSON.stringify(result.packets.map((p) => [p.size, p.data_hash])),
    ),
  };
}
export function pcm(file) {
  return command("ffmpeg", [
    "-v",
    "error",
    "-nostdin",
    "-i",
    file,
    "-map",
    "0:a:0",
    "-f",
    "hash",
    "-hash",
    "sha256",
    "-c:a",
    "pcm_s32le",
    "-",
  ]).trim();
}
export async function independent(file) {
  const m = await parseFile(file, { duration: true, skipPostHeaders: false });
  return {
    common: m.common,
    format: m.format,
    pictures: (m.common.picture ?? []).map((p) => ({
      type: p.type,
      description: p.description ?? "",
      format: p.format,
      hash: sha(p.data),
    })),
    native: Object.fromEntries(
      Object.entries(m.native).map(([family, tags]) => [
        family,
        tags.map((t) => ({ id: t.id, value: t.value })),
      ]),
    ),
    warnings: m.quality.warnings,
  };
}
export const fields = {
  title: ["TITLE", "title", "Edited title ü 音楽"],
  albumArtist: ["ALBUMARTIST", "albumartist", "Edited album owner"],
  composer: ["COMPOSER", "composer", "Edited composer"],
  genre: ["GENRE", "genre", "Trip-Hop"],
  year: ["DATE", "year", "2001"],
  bpm: ["BPM", "bpm", "123.5"],
  comments: ["COMMENT", "comment", "Edited comments ü 音楽\nSecond line"],
};
export function observed(common, field) {
  if (field === "comments")
    return common.comment?.map((x) => x.text).join("\n");
  if (field === "trackNumber") return common.track.no;
  if (field === "trackTotal") return common.track.of;
  if (field === "discNumber") return common.disk.no;
  if (field === "discTotal") return common.disk.of;
  const value = common[fields[field]?.[1] ?? field];
  return Array.isArray(value) ? value.join("; ") : value;
}
export async function generate() {
  await mkdir(path.join(generated, "originals"), { recursive: true });
  const assets = path.join(generated, "assets");
  await mkdir(assets, { recursive: true });
  for (const [name, color] of [
    ["front.png", "red"],
    ["back.png", "blue"],
    ["new.png", "green"],
    ["new.jpg", "yellow"],
  ])
    ffmpeg([
      "-y",
      "-f",
      "lavfi",
      "-i",
      `color=c=${color}:s=32x32`,
      "-frames:v",
      "1",
      "-update",
      "1",
      path.join(assets, name),
    ]);
  const encoders = command("ffmpeg", ["-hide_banner", "-encoders"]);
  const specs = [
    ["mp3", "libmp3lame"],
    ["flac", "flac"],
    ["m4a", "aac"],
    ["ogg", encoders.includes(" libvorbis ") ? "libvorbis" : "vorbis"],
    ["opus", "libopus"],
    ["wav", "pcm_s16le"],
    ["aiff", "pcm_s16be"],
    ["aac", "aac"],
  ];
  const result = [];
  for (const [ext, codec] of specs) {
    const file = path.join(generated, "originals", `sine.${ext}`);
    try {
      ffmpeg([
        "-y",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:sample_rate=48000:duration=2",
        "-ac",
        "2",
        "-c:a",
        codec,
        "-metadata",
        "title=Existing title",
        "-metadata",
        "artist=Existing artist",
        "-metadata",
        "album=Existing album",
        "-metadata",
        "album_artist=Original album owner",
        "-metadata",
        "composer=Original composer",
        "-metadata",
        "date=1999-12-31",
        "-metadata",
        "track=03/12",
        "-metadata",
        "disc=2/4",
        "-metadata",
        "genre=Ambient",
        "-metadata",
        "comment=Original notes",
        "-metadata",
        "copyright=Lab copyright",
        "-metadata",
        "RHYTHM_LAB_UNKNOWN=Original unknown ü 音楽",
        "-strict",
        "experimental",
        file,
      ]);
      result.push({
        ext,
        file,
        codec,
        hash: sha(await readFile(file)),
        packets: packets(file),
        pcm: pcm(file),
      });
    } catch (e) {
      result.push({ ext, error: String(e) });
    }
  }
  await writeFile(
    path.join(generated, "manifest.json"),
    JSON.stringify(result, null, 2) + "\n",
  );
  return result;
}
