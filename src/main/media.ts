import { createReadStream, type ReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const MIME: Record<string, string> = {
  mp3: "audio/mpeg",
  flac: "audio/flac",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
  aif: "audio/aiff",
  aiff: "audio/aiff",
};
/** Serve only a resolved, indexed track. Byte ranges are required for reliable seeking. */
export async function mediaResponse(
  filename: string,
  format: string,
  request: Request,
  ownership?: { assertActive(): void; opened(stream: ReadStream): void },
): Promise<Response> {
  let info;
  try {
    info = await stat(filename);
  } catch {
    return new Response("Music file is unavailable", { status: 404 });
  }
  const size = info.size;
  const headers: Record<string, string> = {
    "Content-Type": MIME[format] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Cache-Control": "no-store",
  };
  let start = 0,
    end = size - 1;
  const range = request.headers.get("range");
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]))
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end =
      match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      start > end ||
      start >= size
    )
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${size}` },
      });
    headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  }
  headers["Content-Length"] = String(Math.max(0, end - start + 1));
  if (request.method === "HEAD" || size === 0)
    return new Response(null, { status: range ? 206 : 200, headers });
  ownership?.assertActive();
  const stream = createReadStream(filename, { start, end });
  ownership?.opened(stream);
  const abort = () => stream.destroy();
  request.signal.addEventListener("abort", abort, { once: true });
  stream.once("close", () =>
    request.signal.removeEventListener("abort", abort),
  );
  if (request.signal.aborted) stream.destroy();
  return new Response(Readable.toWeb(stream) as ReadableStream<Uint8Array>, {
    status: range ? 206 : 200,
    headers,
  });
}
