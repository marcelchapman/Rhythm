import { afterEach, expect, test, vi } from "vitest";
import { parseBuffer } from "music-metadata";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  prepareFlacMetadataEdit,
  FlacMetadataWriteError,
  type FlacMetadataPatch,
} from "../src/domain/metadata-writer";
import * as backend from "../src/domain/flac-taglib";
import {
  entries,
  flacFixture,
  playbackFlacFixture,
  inspectFlac,
  pictureBlock,
  pngFixture,
  jpegFixture,
  pcmFixture,
  block,
  commentBlock,
} from "./metadata-fixtures";
import { wavFixture } from "./fixtures";

afterEach(() => vi.restoreAllMocks());
const set = <T>(value: T) => ({ action: "set" as const, value });
const clear = { action: "clear" as const };
const read = (b: Uint8Array) =>
  parseBuffer(
    b,
    { mimeType: "audio/flac" },
    { duration: true, skipPostHeaders: false },
  );
async function edit(patch: FlacMetadataPatch, original = flacFixture()) {
  const preserved = Buffer.from(original),
    before = inspectFlac(original);
  const result = await prepareFlacMetadataEdit(original, patch);
  expect(original).toEqual(preserved);
  expect(inspectFlac(result.candidate).audio).toEqual(before.audio);
  expect(result.verification.frames).toBe(2);
  expect(result.verification.audioBytes).toBe(before.audio.length);
  expect(result.verification.backend).toBe("emscripten");
  return { result, metadata: await read(result.candidate), original };
}
test("title-only edit keeps source bytes, unrelated native tags and audio intact", async () => {
  const { result, metadata } = await edit({ title: set("Edited ü 音楽") });
  expect(metadata.common.title).toBe("Edited ü 音楽");
  expect(metadata.common.artist).toBe("Original artist");
  expect(result.changedFields).toEqual(["title"]);
  expect(result.verification.engineVersion).toContain("2.4.0");
});
test("Artist and Album use only explicit values", async () => {
  const { metadata } = await edit({
    artist: set("Massive Attack"),
    album: set("Blue Lines"),
  });
  expect(metadata.common.artist).toBe("Massive Attack");
  expect(metadata.common.album).toBe("Blue Lines");
});
test.each([
  ["albumArtist", "albumartist", "New owner"],
  ["composer", "composer", "New composer"],
  ["genre", "genre", "Trip-Hop"],
  ["year", "year", 2001],
  ["bpm", "bpm", 124],
  ["comments", "comment", "New comments ü 音楽\nSecond line"],
] as const)("independently verifies %s", async (field, common, value) => {
  const { metadata } = await edit({ [field]: set(value) });
  const actual =
    common === "comment"
      ? metadata.common.comment?.map((c) => c.text)
      : metadata.common[common];
  expect(actual).toEqual(
    ["composer", "genre", "comment"].includes(common) ? [value] : value,
  );
});
test("track and disc numbers/totals round-trip", async () => {
  const { metadata } = await edit({
    trackNumber: set(7),
    trackTotal: set(17),
    discNumber: set(3),
    discTotal: set(9),
  });
  expect(metadata.common.track).toEqual({ no: 7, of: 17 });
  expect(metadata.common.disk).toEqual({ no: 3, of: 9 });
});
test.each([
  ["trackNumber", 7, { no: 7, of: 12 }],
  ["trackTotal", 17, { no: 3, of: 17 }],
  ["discNumber", 3, { no: 3, of: 4 }],
  ["discTotal", 9, { no: 2, of: 9 }],
] as const)(
  "changing %s preserves its other component",
  async (field, value, expected) => {
    const { metadata } = await edit({ [field]: set(value) });
    expect(
      metadata.common[field.startsWith("track") ? "track" : "disk"],
    ).toEqual(expected);
  },
);
test.each([
  ["trackNumber", { no: null, of: 12 }],
  ["trackTotal", { no: 3, of: null }],
  ["discNumber", { no: null, of: 4 }],
  ["discTotal", { no: 2, of: null }],
] as const)(
  "clearing %s does not substitute zero or clear the other component",
  async (field, expected) => {
    const { metadata } = await edit({ [field]: clear });
    expect(
      metadata.common[field.startsWith("track") ? "track" : "disk"],
    ).toEqual(expected);
  },
);
test.each([
  ["title", "title", "TITLE"],
  ["artist", "artist", "ARTIST"],
  ["album", "album", "ALBUM"],
  ["albumArtist", "albumartist", "ALBUMARTIST"],
  ["composer", "composer", "COMPOSER"],
  ["genre", "genre", "GENRE"],
  ["year", "year", "DATE"],
  ["bpm", "bpm", "BPM"],
  ["comments", "comment", "COMMENT"],
] as const)(
  "clearing %s removes the native field and semantic value",
  async (field, common, native) => {
    const { metadata } = await edit({ [field]: clear });
    expect(metadata.common[common]).toBeUndefined();
    expect(
      metadata.native.vorbis.some((t) => t.id.toUpperCase() === native),
    ).toBe(false);
  },
);
test("omission/preserve/no-op never write display fallbacks", async () => {
  const input = flacFixture({ entries: [] });
  const noop = await edit({ title: { action: "preserve" } }, input);
  expect(noop.result.candidate).toEqual(new Uint8Array(input));
  expect(noop.result.verification.engineVersion).toBeNull();
  const { metadata } = await edit({ title: set("Only explicit title") }, input);
  for (const field of [
    "artist",
    "album",
    "albumartist",
    "genre",
    "composer",
  ] as const)
    expect(metadata.common[field]).toBeUndefined();
});
test("literal fallbacks are allowed only as explicit user strings", async () => {
  const { metadata } = await edit({
    artist: set("Unknown Artist"),
    album: set("Unknown Album"),
  });
  expect(metadata.common.artist).toBe("Unknown Artist");
  expect(metadata.common.album).toBe("Unknown Album");
});
test("preserves multi-values, custom metadata, ReplayGain, lyrics and APPLICATION bytes", async () => {
  const input = flacFixture(),
    before = await read(input),
    { metadata, result } = await edit({ title: set("Changed") }, input);
  expect(metadata.common.composer).toEqual(["Composer A", "Composer B"]);
  expect(metadata.common.genre).toEqual(["Ambient", "Electronic"]);
  const skipTitle = (m: typeof metadata) =>
    m.native.vorbis
      .filter((t) => t.id !== "TITLE")
      .sort((a, b) => a.id.localeCompare(b.id));
  expect(skipTitle(metadata)).toEqual(skipTitle(before));
  expect(
    inspectFlac(result.candidate).blocks.find((b) => b.type === 2)?.body,
  ).toEqual(inspectFlac(input).blocks.find((b) => b.type === 2)?.body);
});
test("text-only edit preserves both pictures including geometry and all raw attributes", async () => {
  const input = flacFixture({ pictures: [pictureBlock(), pictureBlock(4, 1)] });
  const { result } = await edit({ title: set("New") }, input);
  expect(
    inspectFlac(result.candidate).blocks.filter((b) => b.type === 6),
  ).toEqual(inspectFlac(input).blocks.filter((b) => b.type === 6));
  expect(result.verification.preservedPictureCount).toBe(2);
});
test.each(["image/png", "image/jpeg"] as const)(
  "safe %s front replacement preserves unrelated metadata",
  async (mimeType) => {
    const data = mimeType === "image/png" ? pngFixture(2) : jpegFixture();
    const { metadata } = await edit(
      {
        artwork: {
          action: "replace-front",
          data,
          mimeType,
          description: "Explicit front",
        },
      },
      flacFixture({ pictures: [pictureBlock()] }),
    );
    expect(metadata.common.picture).toHaveLength(1);
    expect(metadata.common.picture?.[0]).toMatchObject({
      type: "Cover (front)",
      format: mimeType,
      description: "Explicit front",
      data: new Uint8Array(data),
    });
  },
);
test("adding a front to an art-free FLAC and removing a sole front are safe", async () => {
  const added = await edit({
    artwork: {
      action: "replace-front",
      data: pngFixture(),
      mimeType: "image/png",
    },
  });
  expect(added.metadata.common.picture).toHaveLength(1);
  const removed = await edit(
    { artwork: { action: "remove-front" } },
    flacFixture({ pictures: [pictureBlock()] }),
  );
  expect(removed.metadata.common.picture).toBeUndefined();
  expect(
    inspectFlac(removed.result.candidate).blocks.filter((b) => b.type === 6),
  ).toEqual([]);
});
test.each(["remove-front", "replace-front"] as const)(
  "rejects %s when any additional picture would need reconstruction",
  async (action) => {
    const input = flacFixture({
        pictures: [pictureBlock(), pictureBlock(4, 1)],
      }),
      copy = Buffer.from(input);
    const artwork =
      action === "remove-front"
        ? { action }
        : { action, data: pngFixture(), mimeType: "image/png" as const };
    await expect(
      prepareFlacMetadataEdit(input, { artwork }),
    ).rejects.toMatchObject({ code: "unsafe-artwork" });
    expect(input).toEqual(copy);
  },
);
test("a sole non-front picture is not adopted as a front", async () => {
  await expect(
    prepareFlacMetadataEdit(flacFixture({ pictures: [pictureBlock(4)] }), {
      artwork: { action: "remove-front" },
    }),
  ).rejects.toMatchObject({ code: "unsafe-artwork" });
});
test.each([
  { title: set("") },
  { title: set(7) },
  { title: set("bad\0text") },
  { title: set("bad\ud800") },
  { genre: set(["Ambient"]) },
  { bpm: set(123.5) },
  { bpm: set(0) },
  { bpm: set(NaN) },
  { year: set(10000) },
  { trackNumber: set(-1) },
  { title: { action: "set" } },
  { title: { action: "preserve", value: "bad" } },
  { path: "do not accept paths" },
  { id: "do not accept IDs" },
  { title: undefined },
  { trackNumber: set(13) },
])("rejects unsupported or misleading patch values: %j", async (patch) => {
  await expect(
    prepareFlacMetadataEdit(flacFixture(), patch as FlacMetadataPatch),
  ).rejects.toBeInstanceOf(FlacMetadataWriteError);
});
test.each(
  [
    [...entries, ["DESCRIPTION", "Other notes"] as [string, string]],
    [...entries, ["COMMENT", "Second comment"] as [string, string]],
  ].map((values) => ({ values })),
)("ambiguous comments cannot be changed or cleared", async ({ values }) => {
  for (const comments of [set("New"), clear])
    await expect(
      prepareFlacMetadataEdit(flacFixture({ entries: values }), { comments }),
    ).rejects.toMatchObject({ code: "unsupported-input" });
  await edit(
    { title: set("Safe unrelated edit") },
    flacFixture({ entries: values }),
  );
});
test("full dates are preserved by unrelated edits and rejected for year-only writes", async () => {
  const input = flacFixture({
    entries: entries.map(([k, v]) => [k, k === "DATE" ? "1999-12-31" : v]),
  });
  expect((await edit({ title: set("New") }, input)).metadata.common.date).toBe(
    "1999-12-31",
  );
  await expect(
    prepareFlacMetadataEdit(input, { year: set(2001) }),
  ).rejects.toMatchObject({ code: "unsupported-input" });
  await expect(
    prepareFlacMetadataEdit(input, { year: clear }),
  ).rejects.toMatchObject({ code: "unsupported-input" });
});
test("separate totals retain their native fields and unedited component", async () => {
  const input = flacFixture({
    entries: [
      ...entries.map(([k, v]): [string, string] => [
        k,
        k === "TRACKNUMBER" ? "03" : v,
      ]),
      ["TRACKTOTAL", "12"],
    ],
  });
  expect(
    (await edit({ trackNumber: set(7) }, input)).metadata.common.track,
  ).toEqual({ no: 7, of: 12 });
  expect(
    (await edit({ trackTotal: clear }, input)).metadata.common.track,
  ).toEqual({ no: 3, of: null });
});
test.each([
  Buffer.from("not FLAC"),
  Buffer.from("ID3fake fLaC"),
  flacFixture().subarray(0, 20),
  flacFixture().subarray(0, -1),
])("rejects foreign or truncated FLAC input", async (input) => {
  await expect(
    prepareFlacMetadataEdit(input, { title: set("New") }),
  ).rejects.toBeInstanceOf(FlacMetadataWriteError);
});
test("rejects corrupted frame data and STREAMINFO sample counts", async () => {
  const corrupt = flacFixture();
  corrupt[corrupt.length - 10] ^= 1;
  await expect(prepareFlacMetadataEdit(corrupt, {})).rejects.toMatchObject({
    code: "invalid-input",
  });
  const wrongSamples = flacFixture();
  wrongSamples[25] ^= 1;
  await expect(prepareFlacMetadataEdit(wrongSamples, {})).rejects.toMatchObject(
    { code: "invalid-input" },
  );
});
test("rejects invalid image payloads and MIME mismatches before invoking the engine", async () => {
  for (const [data, mimeType] of [
    [pngFixture(), "image/jpeg"],
    [Buffer.from("not an image"), "image/png"],
  ] as const)
    await expect(
      prepareFlacMetadataEdit(flacFixture(), {
        artwork: { action: "replace-front", data, mimeType },
      }),
    ).rejects.toMatchObject({ code: "unsafe-artwork" });
});
test("fails closed on writer errors, without changing supplied bytes", async () => {
  vi.spyOn(backend, "renderFlacCandidate").mockRejectedValueOnce(
    Error("Injected engine failure"),
  );
  const input = flacFixture(),
    copy = Buffer.from(input);
  await expect(
    prepareFlacMetadataEdit(input, { title: set("New") }),
  ).rejects.toMatchObject({ code: "writer-failed" });
  expect(input).toEqual(copy);
});
test.each(["requested", "custom", "application", "artwork", "audio"] as const)(
  "verification rejects a candidate with damaged %s",
  async (what) => {
    const input = flacFixture({
      pictures: [pictureBlock(), pictureBlock(4, 1)],
    });
    let corrupt: Uint8Array;
    if (what === "requested")
      corrupt = flacFixture({ pictures: [pictureBlock(), pictureBlock(4, 1)] });
    else if (what === "custom")
      corrupt = flacFixture({
        entries: entries.map(([k, v]) => [
          k,
          k === "RIO_CUSTOM" ? "Lost custom" : k === "TITLE" ? "New" : v,
        ]),
        pictures: [pictureBlock(), pictureBlock(4, 1)],
      });
    else if (what === "application")
      corrupt = flacFixture({
        entries: entries.map(([k, v]) => [k, k === "TITLE" ? "New" : v]),
        pictures: [pictureBlock(), pictureBlock(4, 1)],
        application: false,
      });
    else if (what === "artwork")
      corrupt = flacFixture({
        entries: entries.map(([k, v]) => [k, k === "TITLE" ? "New" : v]),
        pictures: [pictureBlock()],
      });
    else {
      corrupt = new Uint8Array(input);
      corrupt[corrupt.length - 4] ^= 1;
    }
    vi.spyOn(backend, "renderFlacCandidate").mockResolvedValueOnce({
      bytes: corrupt,
      version: "Injected candidate",
    });
    await expect(
      prepareFlacMetadataEdit(input, { title: set("New") }),
    ).rejects.toMatchObject({ code: "verification-failed" });
  },
);
test("caller mutation after invocation cannot alter the snapshotted edit", async () => {
  const input = flacFixture(),
    patch = { title: set("Snapshot title") },
    pending = prepareFlacMetadataEdit(input, patch);
  input.fill(0);
  patch.title.value = "Late mutation";
  expect((await read((await pending).candidate)).common.title).toBe(
    "Snapshot title",
  );
});
test("serialized concurrent edits do not leak metadata or WASM-owned buffers", async () => {
  const results = await Promise.all(
    ["One", "Two", "Three"].map((title) =>
      prepareFlacMetadataEdit(flacFixture(), { title: set(title) }),
    ),
  );
  const snapshots = results.map((r) => new Uint8Array(r.candidate));
  await edit({ title: set("Later") });
  for (let i = 0; i < results.length; i++) {
    expect(results[i].candidate).toEqual(snapshots[i]);
    expect((await read(results[i].candidate)).common.title).toBe(
      ["One", "Two", "Three"][i],
    );
  }
});
test("unchanged numeric components retain leading zeros and are not reported as changes", async () => {
  const input = flacFixture();
  const { result } = await edit(
    { title: set("Changed"), trackNumber: set(3), trackTotal: set(12) },
    input,
  );
  expect(result.changedFields).toEqual(["title"]);
  expect(
    (await read(result.candidate)).native.vorbis.find(
      (t) => t.id === "TRACKNUMBER",
    )?.value,
  ).toBe("03/12");
});
test("totals can be added/cleared without inventing an absent number", async () => {
  const input = flacFixture({
    entries: entries.filter(([k]) => k !== "TRACKNUMBER" && k !== "DISCNUMBER"),
  });
  const { metadata } = await edit(
    { trackTotal: set(12), discTotal: set(4) },
    input,
  );
  expect(metadata.common.track).toEqual({ no: null, of: 12 });
  expect(metadata.common.disk).toEqual({ no: null, of: 4 });
});
test("conflicting totals and unsupported numeric representations fail closed", async () => {
  for (const extra of [
    ["TRACKTOTAL", "13"],
    ["TOTALTRACKS", "14"],
  ] as [string, string][])
    await expect(
      prepareFlacMetadataEdit(flacFixture({ entries: [...entries, extra] }), {
        trackNumber: set(7),
      }),
    ).rejects.toMatchObject({ code: "unsupported-input" });
});
test("preservation failure is reported when TagLib normalizes unedited custom key casing", async () => {
  const input = flacFixture({
    entries: [...entries, ["MiXeD_CUSTOM", "Keep exact spelling"]],
  });
  await expect(
    prepareFlacMetadataEdit(input, { title: set("New") }),
  ).rejects.toMatchObject({ code: "verification-failed" });
});
test("malformed metadata lengths, duplicate blocks and foreign suffixes are rejected", async () => {
  const input = flacFixture(),
    parts = inspectFlac(input);
  const brokenLength = Buffer.from(input);
  brokenLength.writeUIntBE(0xffffff, 5, 3);
  const duplicate = Buffer.concat([
    Buffer.from("fLaC"),
    block(0, parts.blocks[0].body),
    block(4, commentBlock([])),
    block(4, commentBlock([]), true),
    parts.audio,
  ]);
  for (const invalid of [
    brokenLength,
    duplicate,
    Buffer.concat([input, Buffer.from("TAGforeign footer")]),
  ])
    await expect(prepareFlacMetadataEdit(invalid, {})).rejects.toMatchObject({
      code: "invalid-input",
    });
});
test("candidate verification protects picture geometry, not just embedded image bytes", async () => {
  const input = flacFixture({ pictures: [pictureBlock(), pictureBlock(4, 1)] });
  const originalRender = backend.renderFlacCandidate;
  vi.spyOn(backend, "renderFlacCandidate").mockImplementationOnce(
    async (...args) => {
      const candidate = await originalRender(...args),
        bytes = Buffer.from(candidate.bytes);
      let at = 4;
      while (at < bytes.length) {
        const type = bytes[at] & 127,
          last = bytes[at] & 128,
          size = bytes.readUIntBE(at + 1, 3);
        if (type === 6) {
          let geometry = at + 8;
          geometry += 4 + bytes.readUInt32BE(geometry);
          geometry += 4 + bytes.readUInt32BE(geometry);
          bytes.writeUInt32BE(0, geometry);
        }
        at += 4 + size;
        if (last) break;
      }
      return { ...candidate, bytes };
    },
  );
  await expect(
    prepareFlacMetadataEdit(input, { title: set("New") }),
  ).rejects.toMatchObject({ code: "verification-failed" });
});
test("untagged native FLAC can gain its first Vorbis field", async () => {
  const original = flacFixture(),
    parts = inspectFlac(original);
  const remaining = parts.blocks.filter((b) => b.type !== 4);
  const input = Buffer.concat([
    Buffer.from("fLaC"),
    ...remaining.map((b, i) =>
      block(b.type, b.body, i === remaining.length - 1),
    ),
    parts.audio,
  ]);
  const { metadata } = await edit({ title: set("First actual tag") }, input);
  expect(metadata.common.title).toBe("First actual tag");
  expect(metadata.common.artist).toBeUndefined();
});
test("actual non-FLAC audio bytes and non-byte inputs are refused", async () => {
  await expect(prepareFlacMetadataEdit(wavFixture(), {})).rejects.toMatchObject(
    { code: "unsupported-input" },
  );
  await expect(
    prepareFlacMetadataEdit(
      "/not/a/writable/path" as unknown as Uint8Array,
      {},
    ),
  ).rejects.toMatchObject({ code: "invalid-patch" });
});
test("input, artwork and pending-request budgets are enforced", async () => {
  await expect(
    prepareFlacMetadataEdit(new Uint8Array(64 * 1024 * 1024 + 1), {}),
  ).rejects.toMatchObject({ code: "resource-limit" });
  await expect(
    prepareFlacMetadataEdit(flacFixture(), {
      artwork: {
        action: "replace-front",
        data: new Uint8Array(10 * 1024 * 1024 + 1),
        mimeType: "image/png",
      },
    }),
  ).rejects.toMatchObject({ code: "resource-limit" });
  const pending = [1, 2, 3, 4].map((n) =>
    prepareFlacMetadataEdit(flacFixture(), { title: set(`Bounded ${n}`) }),
  );
  await expect(
    prepareFlacMetadataEdit(flacFixture(), {}),
  ).rejects.toMatchObject({ code: "resource-limit" });
  await Promise.all(pending);
});
test("artwork bytes are snapshotted before an asynchronous engine load", async () => {
  const image = pngFixture(),
    before = new Uint8Array(image);
  const pending = prepareFlacMetadataEdit(flacFixture(), {
    artwork: { action: "replace-front", data: image, mimeType: "image/png" },
  });
  image.fill(0);
  expect(
    (await read((await pending).candidate)).common.picture?.[0].data,
  ).toEqual(before);
});
test("invalid subframe syntax is refused even with a repaired frame CRC", async () => {
  const input = flacFixture(),
    audio = inspectFlac(input).audio,
    start = input.length - audio.length;
  input[start + 7 + 257] = 4; // Reserved second-channel subframe type.
  const footer = start + audio.length / 2 - 2;
  let crc = 0;
  for (let at = start; at < footer; at++) {
    crc ^= input[at] << 8;
    for (let bit = 0; bit < 8; bit++)
      crc = ((crc << 1) ^ (crc & 0x8000 ? 0x8005 : 0)) & 65535;
  }
  input.writeUInt16BE(crc, footer);
  await expect(prepareFlacMetadataEdit(input, {})).rejects.toMatchObject({
    code: "invalid-input",
  });
});
const haveFfmpeg =
  spawnSync("ffmpeg", ["-version"], { stdio: "ignore" }).status === 0;
test.skipIf(!haveFfmpeg)(
  "independent FFmpeg decode validates generated FLAC and edited audio; compressed frames also qualify",
  async () => {
    const input = flacFixture(),
      pcm = pcmFixture();
    const decode = (data: Uint8Array) =>
      execFileSync(
        "ffmpeg",
        [
          "-v",
          "error",
          "-nostdin",
          "-i",
          "pipe:0",
          "-map",
          "0:a:0",
          "-c:a",
          "pcm_s16le",
          "-f",
          "s16le",
          "pipe:1",
        ],
        { input: data },
      );
    expect(decode(input)).toEqual(pcm);
    const { result } = await edit(
      {
        title: set("New"),
        artwork: {
          action: "replace-front",
          data: pngFixture(),
          mimeType: "image/png",
        },
      },
      input,
    );
    expect(decode(result.candidate)).toEqual(pcm);
    // Pipe encoders cannot seek back to fill STREAMINFO. Populate only the known
    // synthetic sample count/MD5, then exercise actual compressed FLAC frame bytes.
    const compressed = execFileSync(
      "ffmpeg",
      [
        "-v",
        "error",
        "-nostdin",
        "-f",
        "s16le",
        "-ar",
        "48000",
        "-ac",
        "2",
        "-i",
        "pipe:0",
        "-c:a",
        "flac",
        "-f",
        "flac",
        "pipe:1",
      ],
      { input: pcm },
    );
    compressed.writeBigUInt64BE(
      (compressed.readBigUInt64BE(18) & ~0xfffffffffn) | 256n,
      18,
    );
    createHash("md5").update(pcm).digest().copy(compressed, 26);
    expect(decode(compressed)).toEqual(pcm);
    // FFmpeg's lowercase encoder field is deliberately not repaired by production:
    // TagLib uppercases it, so the preservation verifier must refuse that profile.
    await expect(
      prepareFlacMetadataEdit(compressed, { title: set("Compressed fixture") }),
    ).rejects.toMatchObject({ code: "verification-failed" });
    // Generate a separate canonical-tag fixture with the same compressed payload.
    const parts = inspectFlac(compressed);
    const canonical = Buffer.concat([
      Buffer.from("fLaC"),
      ...parts.blocks.map((b, i) =>
        block(
          b.type,
          b.type === 4
            ? commentBlock([["ENCODER", "Synthetic encoder"]])
            : b.body,
          i === parts.blocks.length - 1,
        ),
      ),
      parts.audio,
    ]);
    const prepared = await prepareFlacMetadataEdit(canonical, {
      title: set("Compressed fixture"),
    });
    expect(inspectFlac(prepared.candidate).audio).toEqual(
      inspectFlac(canonical).audio,
    );
    expect(decode(prepared.candidate)).toEqual(pcm);
  },
);

test("self-contained playback FLAC is deterministic, lasts 30 seconds and remains qualified for metadata edits", async () => {
  const original = playbackFlacFixture();
  expect(playbackFlacFixture()).toEqual(original);
  expect((await read(original)).format).toMatchObject({
    duration: 30,
    sampleRate: 48000,
    numberOfChannels: 2,
    bitsPerSample: 16,
  });
  const result = await prepareFlacMetadataEdit(original, {
    title: set("Playback fixture edited"),
  });
  // Qualification walks all CRCs/subframes and UTF-8 counters, not just metadata.
  expect(result.verification.frames).toBe(11250);
  expect(inspectFlac(result.candidate).audio).toEqual(
    inspectFlac(original).audio,
  );
  const metadata = await read(result.candidate);
  expect(metadata.common.title).toBe("Playback fixture edited");
  expect(metadata.format.duration).toBe(30);
});
