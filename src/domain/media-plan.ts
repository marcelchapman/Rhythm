import path from "node:path";

export interface OrganizationMetadata {
  albumArtist?: string;
  artist?: string;
  album?: string;
  title?: string;
  compilation?: boolean;
  track?: number;
  disc?: number;
  discTotal?: number;
}
/** Conservative on every platform, including case-insensitive macOS/Windows volumes. */
export function mediaName(
  value: string | undefined,
  fallback: string,
  limit = 80,
): string {
  let name = (value?.normalize("NFKC") ?? "")
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f\p{Cf}]/gu, "-")
    .replace(/\s+/g, " ")
    .replace(/^[. ]+|[. ]+$/g, "");
  if (!name) name = fallback;
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(name))
    name = `_${name}`;
  let bounded = "",
    bytes = 0;
  for (const character of name) {
    bytes += Buffer.byteLength(character, "utf8");
    if (bytes > limit) break;
    bounded += character;
  }
  return bounded.replace(/[. ]+$/g, "") || fallback;
}
export function inside(root: string, filename: string): boolean {
  const relative = path.relative(root, filename);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}
export function mediaDestination(
  root: string,
  metadata: OrganizationMetadata,
  extension: string,
  organized: boolean,
  sourceName = "Untitled",
  collision = 1,
) {
  if (!path.isAbsolute(root))
    throw new Error("Choose an absolute Rhythm Media folder.");
  if (!/^\.[a-z0-9]{1,8}$/i.test(extension))
    throw new Error("Invalid audio extension.");
  if (!Number.isInteger(collision) || collision < 1 || collision > 10000)
    throw new Error("Too many destination collisions.");
  const number = (n: number | undefined, fallback: number) =>
    Number.isFinite(n) && n! > 0 ? Math.min(999999, Math.floor(n!)) : fallback;
  const track = String(number(metadata.track, 0)).padStart(2, "0");
  const disc =
    metadata.discTotal! > 1 || metadata.disc! > 1
      ? `${number(metadata.disc, 1)}-`
      : "";
  const stem = organized
    ? `${disc}${track} ${mediaName(metadata.title, mediaName(sourceName, "Untitled"))}`
    : mediaName(sourceName, "Untitled", 100);
  const filename = `${stem}${collision > 1 ? ` (${collision})` : ""}${extension.toLowerCase()}`;
  const segments = organized
    ? [
        mediaName(
          metadata.compilation
            ? "Various Artists"
            : metadata.albumArtist || metadata.artist,
          "Unknown Artist",
        ),
        mediaName(metadata.album, "Unknown Album"),
        filename,
      ]
    : [filename];
  const destination = path.resolve(root, ...segments);
  if (!inside(root, destination))
    throw new Error("Destination is outside Rhythm Media.");
  return { path: destination, relative: segments.join("/") };
}
