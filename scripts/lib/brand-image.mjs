// Build-time support for the owner's RGBA PNG artwork; no shipping dependency.
import assert from "node:assert/strict";
import { inflateSync, deflateSync } from "node:zlib";
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crc = (bytes) => {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
  }
  return (n ^ 0xffffffff) >>> 0;
};
export function decodeArtwork(png) {
  assert(png.subarray(0, 8).equals(signature), "Artwork must be PNG");
  const chunks = [];
  let width, height;
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at),
      end = at + 8 + length;
    const type = png.toString("ascii", at + 4, at + 8);
    assert.equal(
      crc(png.subarray(at + 4, end)),
      png.readUInt32BE(end),
      "Artwork PNG CRC",
    );
    const data = png.subarray(at + 8, end);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert(
        data.subarray(8).equals(Buffer.from([8, 6, 0, 0, 0])),
        "Source artwork must be non-interlaced 8-bit RGBA PNG",
      );
    }
    if (type === "IDAT") chunks.push(data);
    at = end + 4;
    if (type === "IEND") break;
  }
  assert(width > 0 && height > 0 && width * height <= 16e6);
  const stride = width * 4,
    raw = inflateSync(Buffer.concat(chunks));
  assert.equal(raw.length, (stride + 1) * height);
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    assert(filter <= 4);
    for (let x = 0; x < stride; x++) {
      const i = y * stride + x;
      const left = x >= 4 ? pixels[i - 4] : 0;
      const above = y ? pixels[i - stride] : 0;
      const corner = y && x >= 4 ? pixels[i - stride - 4] : 0;
      const p = left + above - corner;
      const distances = [
        Math.abs(p - left),
        Math.abs(p - above),
        Math.abs(p - corner),
      ];
      const paeth =
        distances[0] <= distances[1] && distances[0] <= distances[2]
          ? left
          : distances[1] <= distances[2]
            ? above
            : corner;
      const prediction = [
        0,
        left,
        above,
        Math.floor((left + above) / 2),
        paeth,
      ][filter];
      pixels[i] = raw[y * (stride + 1) + 1 + x] + prediction;
    }
  }
  return { width, height, pixels };
}
export function encodeArtwork({ width, height, pixels }, origin) {
  const chunk = (type, data) => {
    const size = Buffer.alloc(4),
      sum = Buffer.alloc(4);
    size.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([size, body, sum]);
  };
  const header = Buffer.alloc(13),
    raw = Buffer.alloc((width * 4 + 1) * height);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  for (let y = 0; y < height; y++)
    pixels.copy(
      raw,
      y * (width * 4 + 1) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  return Buffer.concat([
    signature,
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk("tEXt", Buffer.from(`Source\0${origin}`)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
export function resizeArtwork(source, width) {
  const height = Math.round((width * source.height) / source.width);
  const pixels = Buffer.alloc(width * height * 4);
  // Premultiplied-alpha bilinear resampling preserves transparent stroke edges.
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, ((x + 0.5) * source.width) / width - 0.5);
      const sy = Math.max(0, ((y + 0.5) * source.height) / height - 0.5);
      const ix = Math.floor(sx),
        iy = Math.floor(sy),
        dx = sx - ix,
        dy = sy - iy;
      const samples = [
        [ix, iy, (1 - dx) * (1 - dy)],
        [ix + 1, iy, dx * (1 - dy)],
        [ix, iy + 1, (1 - dx) * dy],
        [ix + 1, iy + 1, dx * dy],
      ];
      const out = (y * width + x) * 4;
      let alpha = 0;
      const rgb = [0, 0, 0];
      for (const [px, py, weight] of samples) {
        const at =
          (Math.min(py, source.height - 1) * source.width +
            Math.min(px, source.width - 1)) *
          4;
        const a = source.pixels[at + 3] * weight;
        alpha += a;
        for (let c = 0; c < 3; c++) rgb[c] += source.pixels[at + c] * a;
      }
      pixels[out + 3] = Math.round(alpha);
      for (let c = 0; c < 3; c++)
        pixels[out + c] = alpha ? Math.round(rgb[c] / alpha) : 0;
    }
  return { width, height, pixels };
}
