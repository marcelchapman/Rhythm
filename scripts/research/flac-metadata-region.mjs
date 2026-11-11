// Independent research implementation of FLAC metadata-region sizing.
// Not imported by production. No EasyTAG/libFLAC code is copied here.
import assert from "node:assert/strict";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
const MAX = 64 * 1024 * 1024;
const utf8 = (bytes) => new TextDecoder("utf-8", { fatal: true }).decode(bytes);
const le = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
function block(type, body, last) {
  assert(body.length <= 0xffffff);
  const header = Buffer.alloc(4);
  header[0] = type | (last ? 128 : 0);
  header.writeUIntBE(body.length, 1, 3);
  return Buffer.concat([header, body]);
}
export function metadataRegion(input) {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  assert(
    bytes.length <= MAX && bytes.subarray(0, 4).equals(Buffer.from("fLaC")),
    "Native bounded FLAC required",
  );
  let at = 4,
    seen = false;
  const blocks = [];
  while (true) {
    assert(
      blocks.length < 256 && at + 4 <= bytes.length,
      "Truncated/oversized metadata chain",
    );
    const flag = bytes[at],
      type = flag & 127,
      length = bytes.readUIntBE(at + 1, 3);
    assert(type <= 6, "Unqualified metadata type");
    assert(
      (blocks.length === 0) === (type === 0) && (type !== 0 || length === 34),
      "Invalid STREAMINFO",
    );
    assert(at + 4 + length <= bytes.length, "Truncated metadata block");
    const body = bytes.subarray(at + 4, at + 4 + length);
    if (type === 1)
      assert(
        body.every((b) => b === 0),
        "Nonzero padding",
      );
    if (type === 2) assert(length >= 4, "Truncated APPLICATION block");
    if (type === 3) assert(length % 18 === 0, "Malformed seek table");
    if (type === 4) {
      assert(!seen, "Duplicate comments");
      seen = true;
      comments(body);
    }
    blocks.push({ type, body });
    at += 4 + length;
    if (flag & 128) break;
  }
  return { blocks, audioOffset: at, prefix: bytes.subarray(0, at) };
}
function comments(body) {
  let at = 0;
  const take = (n) => {
    assert(n >= 0 && at + n <= body.length, "Truncated comment");
    const b = body.subarray(at, at + n);
    at += n;
    return b;
  };
  const size = () => take(4).readUInt32LE();
  const vendor = take(size());
  utf8(vendor);
  const count = size();
  assert(count <= body.length / 4, "Unbounded comment count");
  const entries = [];
  for (let i = 0; i < count; i++) {
    const raw = take(size());
    const text = utf8(raw),
      eq = text.indexOf("=");
    assert(
      eq > 0 && /^[\x20-\x3c\x3e-\x7d]+$/.test(text.slice(0, eq)),
      "Invalid Vorbis key",
    );
    entries.push({ key: text.slice(0, eq).toUpperCase(), raw });
  }
  assert.equal(at, body.length, "Trailing comment bytes");
  return { vendor, entries };
}
export function prepareRegion(input, operations) {
  const before = metadataRegion(input);
  let replaced = false;
  const revised = before.blocks.map((b) => {
    if (b.type !== 4) return b;
    replaced = true;
    const old = comments(b.body),
      entries = old.entries
        .filter((e) => !operations.has(e.key))
        .map((e) => e.raw);
    for (const [key, value] of operations) {
      assert(/^[\x20-\x3c\x3e-\x7d]+$/.test(key));
      if (value !== null) {
        assert(typeof value === "string");
        utf8(Buffer.from(value));
        entries.push(Buffer.from(key + "=" + value));
      }
    }
    return {
      type: 4,
      body: Buffer.concat([
        le(old.vendor.length),
        old.vendor,
        le(entries.length),
        ...entries.flatMap((e) => [le(e.length), e]),
      ]),
    };
  });
  assert(replaced, "This prototype requires an existing comment block");
  const trailing = revised.at(-1).type === 1;
  const core = trailing ? revised.slice(0, -1) : revised;
  const used = 4 + core.reduce((n, b) => n + 4 + b.body.length, 0),
    remaining = before.audioOffset - used;
  const fits = remaining === 0 || remaining >= 4;
  const padding = fits ? (remaining === 0 ? null : remaining - 4) : 4096;
  const blocks = [
    ...core,
    ...(padding === null ? [] : [{ type: 1, body: Buffer.alloc(padding) }]),
  ];
  const prefix = Buffer.concat([
    Buffer.from("fLaC"),
    ...blocks.map((b, i) => block(b.type, b.body, i === blocks.length - 1)),
  ]);
  const after = metadataRegion(prefix);
  assert(!fits || after.audioOffset === before.audioOffset);
  // Protected bodies/order are byte-exact; only comments and final padding change.
  const protectedBlocks = (bs) =>
    bs.filter((b) => b.type !== 1 && b.type !== 4);
  assert.deepEqual(
    protectedBlocks(after.blocks),
    protectedBlocks(before.blocks),
  );
  return {
    prefix,
    oldAudioOffset: before.audioOffset,
    newAudioOffset: after.audioOffset,
    fits,
    metadataBytesRead: before.audioOffset,
    audioBytesProcessed: 0,
  };
}
export async function readMetadataRegion(filename) {
  assert.equal(await realpath(filename), filename, "Linked metadata path");
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat({ bigint: true });
    assert(
      before.isFile() && before.nlink === 1n && before.size <= BigInt(MAX),
    );
    let at = 0;
    const read = async (length) => {
      assert(at + length <= Number(before.size));
      const b = Buffer.alloc(length);
      let done = 0;
      while (done < length) {
        const r = await file.read(b, done, length - done, at + done);
        assert(r.bytesRead > 0);
        done += r.bytesRead;
      }
      at += length;
      return b;
    };
    const chunks = [await read(4)];
    assert(chunks[0].equals(Buffer.from("fLaC")));
    for (let i = 0; ; i++) {
      assert(i < 256);
      const h = await read(4);
      chunks.push(h, await read(h.readUIntBE(1, 3)));
      if (h[0] & 128) break;
    }
    const after = await file.stat({ bigint: true });
    for (const key of ["dev", "ino", "size", "mtimeNs", "ctimeNs"])
      assert.equal(after[key], before[key]);
    return metadataRegion(Buffer.concat(chunks));
  } finally {
    await file.close();
  }
}
// Plugs into a TEMPORARY copy of Rio's writer. Its full original validation,
// frame parsing, independent metadata readback and preservation checks remain.
export async function renderFlacCandidate(original, operations, artwork) {
  assert.equal(artwork, undefined, "Artwork writes are outside this study");
  const plan = prepareRegion(original, operations);
  return {
    bytes: Buffer.concat([plan.prefix, original.subarray(plan.oldAudioOffset)]),
    version: "research-region-only",
  };
}
