import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { parseFlac } from "../src/domain/flac-document";
import { verifyFlacMetadataCandidate } from "../src/domain/metadata-writer";
import { block, inspectFlac } from "./metadata-fixtures";

// Build one 32-bit mono frame with a fixed predictor of order zero. The
// independent bit writer and bitwise CRC do not reuse the production reader.
type Partition =
  { rice: number; folded: number[] } | { raw: number; pcm: number[] };
const unfolded = (n: number) => (n % 2 ? -(Math.floor(n / 2) + 1) : n / 2);
function crc(bytes: Uint8Array, width: 8 | 16) {
  const mask = (1 << width) - 1;
  let value = 0;
  for (const byte of bytes) {
    value ^= byte << (width - 8);
    for (let bit = 0; bit < 8; bit++)
      value =
        ((value << 1) ^
          (value & (1 << (width - 1)) ? (width === 8 ? 7 : 0x8005) : 0)) &
        mask;
  }
  return value;
}
function fixture(
  method: 0 | 1,
  partitions: Partition[],
  options: { badPadding?: boolean; variable?: boolean } = {},
) {
  const samples = partitions.flatMap((p) =>
    "folded" in p ? p.folded.map(unfolded) : p.pcm,
  );
  const pcm = Buffer.alloc(samples.length * 4);
  samples.forEach((sample, i) => {
    // The reserved code cannot be represented as valid signed PCM.
    pcm.writeInt32LE(
      sample < -2147483648 || sample > 2147483647 ? 0 : sample,
      i * 4,
    );
  });
  const header = Buffer.from([
    255,
    options.variable ? 249 : 248,
    0x6a,
    0x0e,
    0,
    samples.length - 1,
  ]);
  let bits = "";
  const push = (n: number, width: number) => {
    if (width) bits += n.toString(2).padStart(width, "0");
  };
  push(0x10, 8); // Fixed predictor, order zero.
  push(method, 2);
  push(Math.log2(partitions.length), 4);
  const parameterWidth = method === 0 ? 4 : 5;
  for (const part of partitions) {
    if ("raw" in part) {
      push(2 ** parameterWidth - 1, parameterWidth);
      push(part.raw, 5);
      for (const sample of part.pcm)
        push(sample < 0 ? sample + 2 ** part.raw : sample, part.raw);
    } else {
      push(part.rice, parameterWidth);
      const radix = 2 ** part.rice;
      for (const sample of part.folded) {
        bits += "0".repeat(Math.floor(sample / radix)) + "1";
        push(sample % radix, part.rice);
      }
    }
  }
  if (options.badPadding) {
    expect(bits.length % 8).not.toBe(0);
    bits += "1";
  }
  bits = bits.padEnd(Math.ceil(bits.length / 8) * 8, "0");
  const body = Buffer.concat([
    header,
    Buffer.from([crc(header, 8)]),
    Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2))),
  ]);
  const footer = Buffer.alloc(2);
  footer.writeUInt16BE(crc(body, 16));
  const stream = Buffer.alloc(34);
  stream.writeUInt16BE(samples.length, 0);
  stream.writeUInt16BE(samples.length, 2);
  stream.writeBigUInt64BE(
    (48000n << 44n) | (31n << 36n) | BigInt(samples.length),
    10,
  );
  createHash("md5").update(pcm).digest().copy(stream, 18);
  return {
    flac: Buffer.concat([
      Buffer.from("fLaC"),
      block(0, stream, true),
      body,
      footer,
    ]),
    pcm,
  };
}
const valid = [
  {
    name: "Rice method 0 with unary prefixes spanning bytes and a zero-bit remainder",
    input: fixture(0, [
      {
        rice: 0,
        folded: [0, 1, 6, 7, 8, 15, 16, 17, 23, 24, 25, 31, 32, 33, 0, 1],
      },
    ]),
  },
  {
    name: "mixed Rice and 31-bit escape partitions",
    input: fixture(0, [
      { rice: 14, folded: [0, 1, 16383, 16384, 32767, 131071, 65537, 8] },
      { raw: 31, pcm: [-1073741824, 1073741823, -1, 0, 1, -7, 15, -1234567] },
    ]),
  },
  {
    name: "variable blocking with a zero-width escape and the maximum permitted Rice residual",
    input: fixture(
      1,
      [
        { raw: 0, pcm: Array<number>(8).fill(0) },
        {
          rice: 30,
          folded: [
            0xfffffffe, 0xfffffffd, 0xbfffffff, 1, 0, 42, 0xfffffffc, 123,
          ],
        },
      ],
      { variable: true },
    ),
  },
];
test.each(valid)("$name is structurally valid", ({ input }) => {
  expect(parseFlac(input.flac)).toMatchObject({
    frames: 1,
    samples: 16,
    channels: 1,
    sampleRate: 48000,
    bitsPerSample: 32,
  });
});
const haveFfmpeg =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test.skipIf(!haveFfmpeg).each(valid)(
  "$name decodes to the expected PCM in FFmpeg",
  ({ input }) => {
    expect(
      execFileSync(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          "pipe:0",
          "-c:a",
          "pcm_s32le",
          "-f",
          "s32le",
          "pipe:1",
        ],
        { input: input.flac },
      ),
    ).toEqual(input.pcm);
  },
);
test.each([
  [0xffffffff, /residual magnitude/],
  [0x100000000, /unary value/],
] as const)(
  "rejects out-of-range folded Rice value %s despite a valid CRC",
  (folded, reason) => {
    const { flac } = fixture(1, [
      { rice: 30, folded: [folded, ...Array<number>(15).fill(0)] },
    ]);
    expect(() => parseFlac(flac)).toThrow(reason);
  },
);
test("rejects every truncated suffix of a Rice frame", () => {
  const { flac } = valid[2].input;
  const start = flac.length - inspectFlac(flac).audio.length;
  for (let end = start; end < flac.length; end++)
    expect(() => parseFlac(flac.subarray(0, end))).toThrow();
});
test("bounds an unterminated unary run of zero bytes", () => {
  const { flac } = valid[0].input;
  const start = flac.length - inspectFlac(flac).audio.length;
  const broken = Buffer.from(flac);
  broken.fill(0, start + 8); // Keep the frame header and fixed subframe type.
  expect(() => parseFlac(broken)).toThrow(/Truncated FLAC subframe/);
});
test("rejects nonzero alignment padding even with a valid CRC", () => {
  const { flac } = fixture(
    0,
    [{ rice: 0, folded: Array<number>(16).fill(0) }],
    { badPadding: true },
  );
  expect(() => parseFlac(flac)).toThrow(/frame padding/);
});
test("rejects corruption in the frame CRC footer", () => {
  const { flac } = valid[1].input;
  const broken = Buffer.from(flac);
  broken[broken.length - 1] ^= 1;
  expect(() => parseFlac(broken)).toThrow(/frame checksum/);
});
test("encoded-audio comparison rejects a different independently CRC-valid frame", async () => {
  const { flac: original } = valid[0].input;
  const { flac: changed } = fixture(0, [
    {
      rice: 0,
      folded: [1, 1, 6, 7, 8, 15, 16, 17, 23, 24, 25, 31, 32, 33, 0, 1],
    },
  ]);
  expect(parseFlac(changed).frames).toBe(1);
  await expect(
    verifyFlacMetadataCandidate(original, changed, {}),
  ).rejects.toThrow(/encoded FLAC audio payload changed/);
});
