import { inflateSync } from "node:zlib";
import { FlacMetadataWriteError } from "./flac-document.js";

const bad = (message: string): never => {
  throw new FlacMetadataWriteError("unsafe-artwork", message);
};
const pngCrc = Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function dimensions(width: number, height: number) {
  if (!width || !height || width * height > 16_000_000)
    bad("Artwork must have positive dimensions and at most 16 million pixels.");
}
/** Bounded structural validation; does not invoke an OS image service. */
export function validateArtwork(
  data: Uint8Array,
  mime: "image/png" | "image/jpeg",
) {
  const b = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  if (!b.length || b.length > 10 * 1024 * 1024)
    bad("Artwork must be between 1 byte and 10 MiB.");
  if (mime === "image/png") {
    if (
      !b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      bad("Artwork does not contain PNG bytes.");
    let at = 8,
      width = 0,
      height = 0,
      channels = 0,
      ended = false;
    const compressed: Buffer[] = [];
    while (at < b.length) {
      if (at + 12 > b.length) bad("Truncated PNG chunk.");
      const length = b.readUInt32BE(at),
        type = b.toString("ascii", at + 4, at + 8),
        end = at + 12 + length;
      if (end > b.length) bad("Truncated PNG data.");
      let crc = 0xffffffff;
      for (let i = at + 4; i < end - 4; i++)
        crc = (crc >>> 8) ^ pngCrc[(crc ^ b[i]) & 255];
      if ((crc ^ 0xffffffff) >>> 0 !== b.readUInt32BE(end - 4))
        bad("Invalid PNG checksum.");
      if (at === 8 && type !== "IHDR") bad("PNG must start with IHDR.");
      if (type === "IHDR") {
        if (at !== 8 || length !== 13) bad("Invalid PNG header.");
        width = b.readUInt32BE(at + 8);
        height = b.readUInt32BE(at + 12);
        dimensions(width, height);
        channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 } as Record<number, number>)[
          b[at + 17]
        ];
        if (
          b[at + 16] !== 8 ||
          !channels ||
          b[at + 18] ||
          b[at + 19] ||
          b[at + 20]
        )
          bad(
            "Only non-interlaced 8-bit gray/RGB/RGBA PNG artwork is qualified.",
          );
      } else if (type === "IDAT") compressed.push(b.subarray(at + 8, end - 4));
      else if (type === "IEND") {
        if (length || end !== b.length) bad("Invalid PNG end marker.");
        ended = true;
      } else if (["acTL", "fcTL", "fdAT"].includes(type))
        bad("Animated PNG artwork is not qualified.");
      at = end;
    }
    if (!ended || !compressed.length) bad("Incomplete PNG artwork.");
    try {
      const stride = width * channels + 1,
        expected = stride * height;
      const decoded = inflateSync(Buffer.concat(compressed), {
        maxOutputLength: expected,
      });
      if (decoded.length !== expected) bad("Invalid PNG image data size.");
      for (let i = 0; i < decoded.length; i += stride)
        if (decoded[i] > 4) bad("Invalid PNG row filter.");
    } catch (error) {
      if (error instanceof FlacMetadataWriteError) throw error;
      bad("PNG image data could not be validated.");
    }
  } else {
    if (b[0] !== 255 || b[1] !== 216 || b.at(-2) !== 255 || b.at(-1) !== 217)
      bad("Artwork does not contain a complete JPEG.");
    let at = 2,
      foundFrame = false,
      foundScan = false;
    while (at < b.length - 2) {
      if (b[at++] !== 255) bad("Invalid JPEG marker.");
      while (b[at] === 255) at++;
      const marker = b[at++];
      if (marker === 217) break;
      if (at + 2 > b.length) bad("Truncated JPEG.");
      const length = b.readUInt16BE(at);
      if (length < 2 || at + length > b.length - 2)
        bad("Truncated JPEG segment.");
      if ([192, 193, 194].includes(marker)) {
        if (length < 8 || b[at + 2] !== 8 || ![1, 3].includes(b[at + 7]))
          bad("Unqualified JPEG sample layout.");
        dimensions(b.readUInt16BE(at + 5), b.readUInt16BE(at + 3));
        foundFrame = true;
      }
      at += length;
      if (marker === 218) {
        foundScan = true;
        break;
      }
    }
    if (!foundFrame || !foundScan || at >= b.length - 2)
      bad("JPEG lacks a qualified frame or image scan.");
  }
}
