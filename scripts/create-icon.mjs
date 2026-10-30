import { mkdir, readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  decodeArtwork,
  encodeArtwork,
  resizeArtwork,
} from "./lib/brand-image.mjs";

// The supplied artwork is read only. All derivatives have separate filenames.
const origin =
  "Owner-supplied artfiles/rio-logo-white.png; resized original handwriting, never a font recreation.";
const artwork = decodeArtwork(await readFile("artfiles/rio-logo-white.png"));
await mkdir("build", { recursive: true });
await mkdir("assets", { recursive: true });
await writeFile(
  "assets/rio-wordmark.png",
  encodeArtwork(resizeArtwork(artwork, 440), origin),
);
const w = 1024,
  logo = resizeArtwork(artwork, 820);
const pixels = Buffer.alloc(w * w * 4);
const left = Math.round((w - logo.width) / 2),
  top = Math.round((w - logo.height) / 2);
for (let y = 0; y < w; y++)
  for (let x = 0; x < w; x++) {
    const offset = (y * w + x) * 4;
    const dx = Math.max(0, Math.abs(x - 511.5) - 280);
    const dy = Math.max(0, Math.abs(y - 511.5) - 280);
    const inside = dx * dx + dy * dy <= 210 * 210;
    const at = ((y - top) * logo.width + x - left) * 4;
    const a =
      x >= left && x < left + logo.width && y >= top && y < top + logo.height
        ? logo.pixels[at + 3] / 255
        : 0;
    for (let c = 0; c < 3; c++)
      pixels[offset + c] = Math.round(
        [19, 31, 47][c] * (1 - a) + (a ? logo.pixels[at + c] : 0) * a,
      );
    pixels[offset + 3] = inside ? 255 : 0;
  }
await writeFile(
  "build/rio.png",
  encodeArtwork({ width: w, height: w, pixels }, origin),
);
if (process.platform === "darwin") {
  // Regenerate every time: an existing ICNS must not conceal an artwork update.
  const temp = await mkdtemp(path.join(tmpdir(), "rio-icon-"));
  const set = path.join(temp, "rio.iconset");
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
            "build/rio.png",
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
      path.resolve("build/rio.icns"),
    ]);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
