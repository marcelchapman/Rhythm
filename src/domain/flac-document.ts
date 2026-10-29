/** Internal, read-only native FLAC inspection. No paths, decoder or writer authority. */
import { createHash } from "node:crypto";

export class FlacMetadataWriteError extends Error {
  constructor(
    readonly code:
      | "invalid-input"
      | "unsupported-input"
      | "invalid-patch"
      | "unsafe-artwork"
      | "verification-failed"
      | "writer-failed"
      | "resource-limit",
    message: string,
  ) {
    super(message);
    this.name = "FlacMetadataWriteError";
  }
}
export const digest = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function invalid(message: string): never {
  throw new FlacMetadataWriteError("invalid-input", message);
}
const utf8 = new TextDecoder("utf-8", { fatal: true });
export interface FlacBlock {
  type: number;
  data: Uint8Array;
}
export interface VorbisEntry {
  key: string;
  value: string;
}
export interface FlacPicture {
  type: number;
  mime: string;
  description: string;
  data: Uint8Array;
  block: Uint8Array;
}
export interface FlacDocument {
  blocks: FlacBlock[];
  entries: VorbisEntry[];
  vendor?: Uint8Array;
  pictures: FlacPicture[];
  audio: Uint8Array;
  frames: number;
  samples: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  minBlockSize: number;
  maxBlockSize: number;
}
class Cursor {
  at = 0;
  constructor(readonly data: Uint8Array) {}
  take(n: number): Uint8Array {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.data.length - this.at)
      invalid("Truncated FLAC metadata.");
    const value = this.data.subarray(this.at, this.at + n);
    this.at += n;
    return value;
  }
  number(little = false): number {
    const value = this.take(4);
    return new DataView(value.buffer, value.byteOffset, 4).getUint32(0, little);
  }
  text(n: number): string {
    try {
      return utf8.decode(this.take(n));
    } catch {
      return invalid("Invalid UTF-8 in FLAC metadata.");
    }
  }
  end() {
    if (this.at !== this.data.length)
      invalid("Unexpected FLAC metadata bytes.");
  }
}
export function entryGroups(entries: readonly VorbisEntry[]) {
  const groups = new Map<string, VorbisEntry[]>();
  for (const entry of entries) {
    const key = entry.key.toUpperCase();
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  return groups;
}
function comments(data: Uint8Array) {
  const c = new Cursor(data);
  const vendor = c.take(c.number(true));
  try {
    utf8.decode(vendor);
  } catch {
    invalid("Invalid Vorbis vendor string.");
  }
  const count = c.number(true);
  if (count > 10000) invalid("Too many FLAC comment entries.");
  const entries: VorbisEntry[] = [];
  for (let i = 0; i < count; i++) {
    const raw = c.text(c.number(true)),
      separator = raw.indexOf("=");
    const key = raw.slice(0, separator);
    if (separator < 1 || !/^[\x20-\x3c\x3e-\x7d]+$/.test(key))
      invalid("Invalid Vorbis comment field name.");
    entries.push({ key, value: raw.slice(separator + 1) });
  }
  c.end();
  return { vendor, entries };
}
function picture(data: Uint8Array): FlacPicture {
  const c = new Cursor(data),
    type = c.number();
  const mime = c.text(c.number()),
    description = c.text(c.number());
  c.take(16); // Width, height, depth and palette count are preserved in the raw block.
  const image = c.take(c.number());
  c.end();
  if (image.length > 10 * 1024 * 1024)
    throw new FlacMetadataWriteError(
      "resource-limit",
      "An embedded picture exceeds 10 MiB.",
    );
  return { type, mime, description, data: image, block: data };
}
const crcTable = (bits: 8 | 16, polynomial: number) =>
  Array.from({ length: 256 }, (_, byte) => {
    let crc = byte << (bits - 8);
    for (let i = 0; i < 8; i++)
      crc = (crc << 1) ^ (crc & (1 << (bits - 1)) ? polynomial : 0);
    return crc & ((1 << bits) - 1);
  });
const crc8 = crcTable(8, 0x07),
  crc16 = crcTable(16, 0x8005);
interface FrameHeader {
  end: number;
  blockSize: number;
  number: number;
  variable: boolean;
}
function frameHeader(
  bytes: Uint8Array,
  at: number,
  info: Omit<FlacDocument, "frames">,
): FrameHeader | undefined {
  const start = at;
  if (bytes[at++] !== 255 || (bytes[at] & 254) !== 248) return;
  const variable = !!(bytes[at++] & 1),
    codes = bytes[at++],
    channels = bytes[at++];
  if (channels === undefined || channels & 1 || channels >> 4 > 10) return;
  const depth = [info.bitsPerSample, 8, 12, 0, 16, 20, 24, 32][
    (channels >> 1) & 7
  ];
  if (
    depth !== info.bitsPerSample ||
    (channels >> 4 < 8 ? (channels >> 4) + 1 : 2) !== info.channels
  )
    return;
  const first = bytes[at++];
  if (first === undefined || first === 255) return;
  let length = 1,
    number = first;
  if (first >= 128) {
    length = 0;
    while (first & (128 >> length)) length++;
    if (length < 2 || length > 7) return;
    number = first & ((1 << (7 - length)) - 1);
    for (let i = 1; i < length; i++) {
      const byte = bytes[at++];
      if (byte === undefined || (byte & 192) !== 128) return;
      number = number * 64 + (byte & 63);
    }
    const minimum = [0, 0, 128, 2048, 65536, 2097152, 67108864, 2147483648][
      length
    ];
    if (number < minimum) return;
  }
  const take = () => bytes[at++];
  const blockCode = codes >> 4,
    rateCode = codes & 15;
  let blockSize =
    blockCode === 1
      ? 192
      : blockCode <= 5
        ? 576 * 2 ** (blockCode - 2)
        : 256 * 2 ** (blockCode - 8);
  if (blockCode === 0) return;
  if (blockCode === 6) blockSize = take() + 1;
  if (blockCode === 7) blockSize = take() * 256 + take() + 1;
  let rate = [
    info.sampleRate,
    88200,
    176400,
    192000,
    8000,
    16000,
    22050,
    24000,
    32000,
    44100,
    48000,
    96000,
  ][rateCode];
  if (rateCode === 12) rate = take() * 1000;
  if (rateCode === 13) rate = take() * 256 + take();
  if (rateCode === 14) rate = (take() * 256 + take()) * 10;
  if (
    rate !== info.sampleRate ||
    blockSize < 1 ||
    blockSize > info.maxBlockSize ||
    !Number.isSafeInteger(blockSize)
  )
    return;
  let crc = 0;
  for (let i = start; i < at; i++) crc = crc8[crc ^ bytes[i]];
  if (bytes[at++] !== crc || at + 3 > bytes.length || bytes[at] & 128) return;
  const subframeType = (bytes[at] >> 1) & 63;
  if (
    subframeType > 1 &&
    (subframeType < 8 || (subframeType > 12 && subframeType < 32))
  )
    return;
  return { end: at, blockSize, number, variable };
}
/** Walk syntax without reconstructing, transforming or encoding samples. */
class Bits {
  constructor(
    readonly data: Uint8Array,
    public at: number,
  ) {}
  skip(n: number) {
    if (!Number.isSafeInteger(n) || n < 0 || n > this.data.length * 8 - this.at)
      invalid("Truncated FLAC subframe.");
    this.at += n;
  }
  read(n: number): number {
    if (n > 32) invalid("Unsupported FLAC bit field.");
    this.skip(n);
    let value = 0;
    for (let bit = this.at - n; bit < this.at; bit++)
      value = value * 2 + ((this.data[bit >> 3] >> (7 - (bit & 7))) & 1);
    return value;
  }
  unary(limit: number): number {
    let zeros = 0;
    while (this.read(1) === 0)
      if (++zeros > limit) invalid("Invalid FLAC unary value.");
    return zeros;
  }
}
function subframes(
  info: Omit<FlacDocument, "frames">,
  header: FrameHeader,
  start: number,
) {
  const bits = new Bits(info.audio, header.end * 8),
    assignment = info.audio[start + 3] >> 4;
  for (let channel = 0; channel < info.channels; channel++) {
    if (bits.read(1)) invalid("Invalid FLAC subframe padding bit.");
    const type = bits.read(6),
      wasted = bits.read(1);
    let depth =
      info.bitsPerSample +
      ((assignment === 8 && channel === 1) ||
      (assignment === 9 && channel === 0) ||
      (assignment === 10 && channel === 1)
        ? 1
        : 0);
    if (wasted) depth -= bits.unary(depth - 2) + 1;
    if (depth < 1) invalid("Invalid FLAC wasted-bit count.");
    if (type === 0) {
      bits.skip(depth);
      continue;
    }
    if (type === 1) {
      bits.skip(header.blockSize * depth);
      continue;
    }
    let order: number;
    if (type >= 8 && type <= 12) order = type - 8;
    else if (type >= 32) order = type - 31;
    else return invalid("Reserved FLAC subframe type.");
    if (order > header.blockSize) invalid("Invalid FLAC predictor order.");
    bits.skip(order * depth);
    if (type >= 32) {
      const precision = bits.read(4) + 1;
      if (precision === 16) invalid("Reserved FLAC coefficient precision.");
      bits.skip(5 + order * precision);
    }
    const method = bits.read(2),
      partitionOrder = bits.read(4);
    if (method > 1 || header.blockSize % 2 ** partitionOrder)
      invalid("Invalid FLAC residual coding.");
    const partitions = 2 ** partitionOrder,
      size = header.blockSize / partitions;
    if (size < order) invalid("Invalid FLAC residual partition size.");
    const parameterBits = method === 0 ? 4 : 5;
    for (let partition = 0; partition < partitions; partition++) {
      const parameter = bits.read(parameterBits),
        count = size - (partition === 0 ? order : 0);
      if (parameter === 2 ** parameterBits - 1) bits.skip(count * bits.read(5));
      else
        for (let sample = 0; sample < count; sample++) {
          const quotient = bits.unary(Math.floor(0xfffffffe / 2 ** parameter));
          if (quotient * 2 ** parameter + bits.read(parameter) > 0xfffffffe)
            invalid("Invalid FLAC residual magnitude.");
        }
    }
  }
  const padding = (8 - (bits.at % 8)) % 8;
  if (bits.read(padding)) invalid("Nonzero FLAC frame padding.");
  const footer = bits.at / 8;
  bits.skip(16);
  let crc = 0;
  for (let i = start; i < footer + 2; i++)
    crc = ((crc << 8) ^ crc16[((crc >> 8) ^ info.audio[i]) & 255]) & 65535;
  if (crc !== 0) invalid("Invalid FLAC audio frame checksum.");
  return footer + 2;
}
/** Structural subframes, CRC and sample-sequence checks, not a PCM decoder. */
function audioFrames(info: Omit<FlacDocument, "frames">) {
  const { audio, samples } = info;
  let start = 0,
    frames = 0,
    total = 0,
    variable: boolean | undefined;
  while (start < audio.length) {
    const header = frameHeader(audio, start, info);
    if (
      !header ||
      header.number !== (header.variable ? total : frames) ||
      (variable !== undefined && variable !== header.variable)
    )
      invalid("Invalid FLAC audio frame sequence.");
    variable = header.variable;
    start = subframes(info, header, start);
    if (start < audio.length && header.blockSize < info.minBlockSize)
      invalid("Invalid non-final FLAC block size.");
    total += header.blockSize;
    if (total > samples) invalid("Too many FLAC audio samples.");
    frames++;
  }
  if (total !== samples)
    invalid("FLAC frame sample count does not match STREAMINFO.");
  return frames;
}
export function parseFlac(bytes: Uint8Array): FlacDocument {
  if (Buffer.from(bytes.subarray(0, 4)).toString("ascii") !== "fLaC")
    throw new FlacMetadataWriteError(
      "unsupported-input",
      "Only native FLAC bytes without foreign tag prefixes are supported.",
    );
  const c = new Cursor(bytes);
  c.take(4);
  const blocks: FlacBlock[] = [],
    pictures: FlacPicture[] = [];
  let entries: VorbisEntry[] = [],
    vendor: Uint8Array | undefined,
    seenComment = false;
  while (true) {
    if (blocks.length >= 256) invalid("Too many FLAC metadata blocks.");
    const h = c.take(4),
      type = h[0] & 127,
      data = c.take(h[1] * 65536 + h[2] * 256 + h[3]);
    if (type > 6)
      throw new FlacMetadataWriteError(
        "unsupported-input",
        "Unqualified FLAC metadata block type.",
      );
    if (
      (blocks.length === 0) !== (type === 0) ||
      (type === 0 && data.length !== 34)
    )
      invalid("Invalid FLAC STREAMINFO.");
    if (type === 1 && data.some((byte) => byte !== 0))
      invalid("Nonzero FLAC padding.");
    if (type === 2 && data.length < 4)
      invalid("Truncated FLAC APPLICATION block.");
    if (type === 3 && data.length % 18 !== 0)
      invalid("Invalid FLAC seek table length.");
    if (type === 4) {
      if (seenComment)
        invalid("Multiple Vorbis comment blocks are unsupported.");
      seenComment = true;
      ({ entries, vendor } = comments(data));
    }
    if (type === 6) pictures.push(picture(data));
    blocks.push({ type, data });
    if (h[0] & 128) break;
  }
  const stream = blocks[0].data,
    packed = new DataView(
      stream.buffer,
      stream.byteOffset + 10,
      8,
    ).getBigUint64(0);
  const sampleRate = Number(packed >> 44n),
    channels = Number((packed >> 41n) & 7n) + 1,
    bitsPerSample = Number((packed >> 36n) & 31n) + 1,
    samples = Number(packed & 0xfffffffffn),
    minBlockSize = stream[0] * 256 + stream[1],
    maxBlockSize = stream[2] * 256 + stream[3];
  if (
    !sampleRate ||
    sampleRate > 655350 ||
    bitsPerSample < 4 ||
    !samples ||
    stream[0] * 256 + stream[1] < 16 ||
    stream[2] * 256 + stream[3] < stream[0] * 256 + stream[1]
  )
    invalid("Invalid or unknown FLAC stream parameters.");
  const info = {
    blocks,
    entries,
    vendor,
    pictures,
    audio: bytes.subarray(c.at),
    samples,
    sampleRate,
    channels,
    bitsPerSample,
    minBlockSize,
    maxBlockSize,
  };
  return { ...info, frames: audioFrames(info) };
}
