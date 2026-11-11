// Optional macOS qualification lab, never a dependency of test:desktop/packaged.
// Requires an already available independent FFmpeg encoder/decoder; installs nothing.
import { mkdtemp, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import {
  inspectFlac,
  block,
  commentBlock,
} from "../../tests/metadata-fixtures.ts";
import assert from "node:assert/strict";
assert.equal(process.platform, "darwin");
const binary = process.env.RIO_LARGE_FIXTURE_FFMPEG || "ffmpeg";
execFileSync(binary, ["-version"], { stdio: "ignore" });
const root = await mkdtemp("/private/tmp/rio-large-fixtures-"),
  fixtures = [];
for (const targetMiB of [63.75, 64.25, 70, 100, 125, 250, 273]) {
  const filename = path.join(root, `synthetic-${targetMiB}.flac`);
  // Fixed seeded stereo high-resolution PCM. Actual file sizes are recorded.
  const seconds = (targetMiB * 1024 * 1024 - 15000) / 583000;
  execFileSync(
    binary,
    [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=white:amplitude=0.7:r=96000:seed=17",
      "-f",
      "lavfi",
      "-i",
      "anoisesrc=color=white:amplitude=0.7:r=96000:seed=23",
      "-filter_complex",
      "amerge=inputs=2",
      "-t",
      String(seconds),
      "-c:a",
      "flac",
      "-compression_level",
      "0",
      "-sample_fmt",
      "s32",
      "-bits_per_raw_sample",
      "24",
      filename,
    ],
    { timeout: 120000 },
  );
  const { blocks, audio } = inspectFlac(await readFile(filename));
  await writeFile(
    filename,
    Buffer.concat([
      Buffer.from("fLaC"),
      ...blocks.map((b, i) =>
        block(
          b.type,
          b.type === 4
            ? commentBlock([
                ["TITLE", "A"],
                ["ALBUM", "Synthetic"],
                ["GENRE", "Fixture"],
              ])
            : b.body,
          i === blocks.length - 1,
        ),
      ),
      audio,
    ]),
  );
  execFileSync(
    binary,
    ["-nostdin", "-v", "error", "-xerror", "-i", filename, "-f", "null", "-"],
    { timeout: 120000 },
  );
  fixtures.push({
    filename,
    targetMiB,
    seconds,
    size: (await stat(filename)).size,
    independentDecode: true,
  });
  console.log(JSON.stringify(fixtures.at(-1)));
}
// Exact inclusive/rejection boundaries use valid zero-padding, not trailing junk.
{
  const input = await readFile(path.join(root, "synthetic-125.flac"));
  const { blocks, audio } = inspectFlac(input);
  const padding = blocks.findIndex((b) => b.type === 1);
  assert(padding >= 0);
  for (const size of [128 * 1024 * 1024, 128 * 1024 * 1024 + 1]) {
    const filename = path.join(
      root,
      size % 2 ? "over-limit-one-byte.flac" : "synthetic-128.flac",
    );
    const bytes = Buffer.concat([
      Buffer.from("fLaC"),
      ...blocks.map((b, i) =>
        block(
          b.type,
          i === padding
            ? Buffer.alloc(b.body.length + size - input.length)
            : b.body,
          i === blocks.length - 1,
        ),
      ),
      audio,
    ]);
    assert.equal(bytes.length, size);
    await writeFile(filename, bytes);
    execFileSync(
      binary,
      ["-nostdin", "-v", "error", "-xerror", "-i", filename, "-f", "null", "-"],
      { timeout: 120000 },
    );
    fixtures.push({
      filename,
      targetMiB: size / 1024 / 1024,
      size,
      independentDecode: true,
    });
  }
}
await writeFile(
  path.join(root, "fixtures.json"),
  JSON.stringify(fixtures, null, 2) + "\n",
);
console.log(`Disposable fixtures retained for the explicit lab run: ${root}`);
