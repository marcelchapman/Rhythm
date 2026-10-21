import { deflateSync } from "node:zlib";
import { mkdir, writeFile, access, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
// Original geometric waveform mark, generated reproducibly without external assets.
await mkdir("build", { recursive: true });
const crc = (bytes) => {
  let n = 0xffffffff;
  for (const byte of bytes) {
    n ^= byte;
    for (let i = 0; i < 8; i++) n = (n >>> 1) ^ (0xedb88320 & -(n & 1));
  }
  return (n ^ 0xffffffff) >>> 0;
};
const chunk = (type, data) => {
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const sum = Buffer.alloc(4);
  sum.writeUInt32BE(crc(body));
  return Buffer.concat([size, body, sum]);
};
const w = 1024;
const raw = Buffer.alloc((w * 4 + 1) * w);
for (let y = 0; y < w; y++)
  for (let x = 0; x < w; x++) {
    const offset = y * (w * 4 + 1) + 1 + x * 4;
    const dx = Math.max(0, Math.abs(x - 511.5) - 280),
      dy = Math.max(0, Math.abs(y - 511.5) - 280);
    const inside = dx * dx + dy * dy <= 210 * 210;
    const bars = [130, 270, 440, 310, 170];
    const mark = bars.some((height, i) => {
      const cx = 312 + i * 100;
      const bx = Math.abs(x - cx),
        by = Math.max(0, Math.abs(y - 512) - height / 2 + 24);
      return bx * bx + by * by <= 24 * 24;
    });
    raw[offset] = mark ? 139 : 19;
    raw[offset + 1] = mark ? 199 : 31;
    raw[offset + 2] = mark ? 255 : 47;
    raw[offset + 3] = inside ? 255 : 0;
  }
const header = Buffer.alloc(13);
header.writeUInt32BE(w);
header.writeUInt32BE(w, 4);
header[8] = 8;
header[9] = 6;
await writeFile(
  "build/rhythm.png",
  Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw)),
    chunk(
      "tEXt",
      Buffer.from(
        "impeccable:prompt\0Origin: Original geometric waveform icon authored in scripts/create-icon.mjs for Rhythm; five blue rounded bars on a dark navy rounded square. No external or proprietary assets.",
      ),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]),
);
if (process.platform === "darwin") {
  let existing = false;
  try {
    await access("build/rhythm.icns");
    existing = true;
  } catch {
    /* Generate once. */
  }
  if (!existing) {
    const temp = await mkdtemp(path.join(tmpdir(), "rhythm-icon-"));
    const set = path.join(temp, "rhythm.iconset");
    await mkdir(set);
    try {
      for (const size of [16, 32, 128, 256, 512])
        for (const scale of [1, 2])
          execFileSync(
            "sips",
            [
              "-z",
              String(size * scale),
              String(size * scale),
              "build/rhythm.png",
              "--out",
              path.join(
                set,
                `icon_${size}x${size}${scale === 2 ? "@2x" : ""}.png`,
              ),
            ],
            { stdio: "ignore" },
          );
      execFileSync("iconutil", [
        "-c",
        "icns",
        set,
        "-o",
        path.resolve("build/rhythm.icns"),
      ]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }
}
