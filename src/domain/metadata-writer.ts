import { parseBuffer } from "music-metadata";
import { renderFlacCandidate, type FrontCover } from "./flac-taglib.js";
import { validateArtwork } from "./flac-artwork.js";
import {
  parseFlac,
  entryGroups,
  digest,
  FlacMetadataWriteError,
  type FlacDocument,
} from "./flac-document.js";
export { FlacMetadataWriteError } from "./flac-document.js";

export type MetadataEdit<T> =
  { action: "preserve" } | { action: "set"; value: T } | { action: "clear" };
export interface FlacMetadataPatch {
  title?: MetadataEdit<string>;
  artist?: MetadataEdit<string>;
  album?: MetadataEdit<string>;
  albumArtist?: MetadataEdit<string>;
  composer?: MetadataEdit<string>;
  genre?: MetadataEdit<string>;
  year?: MetadataEdit<number>;
  trackNumber?: MetadataEdit<number>;
  trackTotal?: MetadataEdit<number>;
  discNumber?: MetadataEdit<number>;
  discTotal?: MetadataEdit<number>;
  bpm?: MetadataEdit<number>;
  comments?: MetadataEdit<string>;
  artwork?:
    | { action: "preserve" }
    | { action: "remove-front" }
    | {
        action: "replace-front";
        data: Uint8Array;
        mimeType: "image/png" | "image/jpeg";
        description?: string;
      };
}
export interface FlacMetadataWriteResult {
  candidate: Uint8Array;
  changedFields: (keyof FlacMetadataPatch)[];
  verification: {
    format: "FLAC";
    backend: "emscripten";
    engineVersion: string | null;
    originalSha256: string;
    candidateSha256: string;
    audioSha256: string;
    audioBytes: number;
    frames: number;
    preservedCommentFields: number;
    preservedPictureCount: number;
    preservedBlockTypes: number[];
  };
}
const MAX_BYTES = 64 * 1024 * 1024;
const textKeys = {
  title: "TITLE",
  artist: "ARTIST",
  album: "ALBUM",
  albumArtist: "ALBUMARTIST",
  composer: "COMPOSER",
  genre: "GENRE",
  comments: "COMMENT",
} as const;
const numberKeys = [
  "year",
  "trackNumber",
  "trackTotal",
  "discNumber",
  "discTotal",
  "bpm",
] as const;
type Field = Exclude<keyof FlacMetadataPatch, "artwork">;
type Edits = Map<Field, string | number | null>;
function badPatch(message: string): never {
  throw new FlacMetadataWriteError("invalid-patch", message);
}
function unsafe(message: string): never {
  throw new FlacMetadataWriteError("unsupported-input", message);
}
const verify = (condition: boolean, message: string) => {
  if (!condition)
    throw new FlacMetadataWriteError("verification-failed", message);
};
function object(value: unknown): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value))
  );
}
function string(value: unknown, limit = 4000): string {
  if (
    typeof value !== "string" ||
    !value.length ||
    value.length > limit ||
    value.includes("\0") ||
    Buffer.from(value).toString("utf8") !== value
  )
    badPatch(
      "Supply a nonempty UTF-8 string of at most 4,000 characters, or explicitly clear the field.",
    );
  return value;
}
function patchPlan(patch: unknown): {
  edits: Edits;
  artwork: FrontCover | "remove" | undefined;
} {
  if (!object(patch)) badPatch("Supply an explicit metadata patch.");
  const edits: Edits = new Map();
  let artwork: FrontCover | "remove" | undefined;
  for (const [key, change] of Object.entries(patch)) {
    if (!(
      Object.hasOwn(textKeys, key) ||
      numberKeys.includes(key as (typeof numberKeys)[number]) ||
      key === "artwork"
    ))
      badPatch(`Unsupported metadata field: ${key}.`);
    if (!object(change) || typeof change.action !== "string")
      badPatch(`Invalid patch for ${key}.`);
    if (change.action === "preserve") {
      if (Object.keys(change).length !== 1)
        badPatch("Preserved fields cannot carry a replacement value.");
      continue;
    }
    if (key === "artwork") {
      if (change.action === "remove-front" && Object.keys(change).length === 1)
        artwork = "remove";
      else if (
        change.action === "replace-front" &&
        Object.keys(change).every((k) =>
          ["action", "data", "mimeType", "description"].includes(k),
        )
      ) {
        if (
          !(change.data instanceof Uint8Array) ||
          !["image/png", "image/jpeg"].includes(String(change.mimeType))
        )
          badPatch(
            "Supply JPEG or PNG artwork bytes and their matching MIME type.",
          );
        if (change.data.length > 10 * 1024 * 1024)
          throw new FlacMetadataWriteError(
            "resource-limit",
            "Artwork exceeds 10 MiB.",
          );
        const data = new Uint8Array(change.data);
        const mimeType = change.mimeType as FrontCover["mimeType"];
        if (
          change.description !== undefined &&
          typeof change.description !== "string"
        )
          badPatch("Artwork description must be text.");
        const description =
          change.description === undefined || change.description === ""
            ? ""
            : string(change.description, 1000);
        validateArtwork(data, mimeType);
        artwork = { data, mimeType, description };
      } else badPatch("Invalid artwork patch.");
    } else if (change.action === "clear" && Object.keys(change).length === 1)
      edits.set(key as Field, null);
    else if (
      change.action === "set" &&
      Object.keys(change).length === 2 &&
      Object.hasOwn(change, "value")
    ) {
      if (Object.hasOwn(textKeys, key))
        edits.set(key as Field, string(change.value));
      else {
        const max = key === "year" ? 9999 : key === "bpm" ? 1000 : 999999;
        if (
          typeof change.value !== "number" ||
          !Number.isInteger(change.value) ||
          change.value < 1 ||
          change.value > max
        )
          badPatch(
            `${key} must be an integer between 1 and ${max}; clearing is explicit.`,
          );
        edits.set(key as Field, change.value);
      }
    } else badPatch(`Invalid patch action for ${key}.`);
  }
  return { edits, artwork };
}
function operationsFor(before: FlacDocument, edits: Edits) {
  const groups = entryGroups(before.entries),
    operations = new Map<string, string | null>();
  const changedPairs = new Set<Field>();
  const values = (key: string) => (groups.get(key) ?? []).map((e) => e.value);
  const set = (key: string, value: string | null) => {
    const old = values(key);
    if (
      value === null ? old.length !== 0 : old.length !== 1 || old[0] !== value
    )
      operations.set(key, value);
  };
  for (const [field, key] of Object.entries(textKeys))
    if (edits.has(field as Field)) {
      if (
        field === "comments" &&
        (groups.has("DESCRIPTION") || values("COMMENT").length > 1)
      )
        unsafe(
          "Comments with DESCRIPTION or multiple COMMENT entries cannot be edited unambiguously.",
        );
      if (field === "genre" && groups.has("STYLE"))
        unsafe("Genre edits with STYLE aliases are not qualified.");
      if (field === "albumArtist" && groups.has("ALBUM ARTIST"))
        unsafe("Album Artist aliases require separate qualification.");
      set(key, edits.get(field as Field) as string | null);
    }
  if (edits.has("year")) {
    const old = values("DATE");
    if (old.length > 1 || old.some((v) => !/^\d{4}$/.test(v)))
      unsafe(
        "Year edits are limited to an absent or single year-only DATE; full dates stay untouched.",
      );
    const value = edits.get("year");
    set("DATE", value === null ? null : String(value).padStart(4, "0"));
  }
  if (edits.has("bpm"))
    set("BPM", edits.get("bpm") === null ? null : String(edits.get("bpm")));
  const pairs: Record<string, { no: number | null; total: number | null }> = {};
  for (const [prefix, canonical, aliases] of [
    ["track", "TRACKNUMBER", ["TRACKTOTAL", "TOTALTRACKS"]],
    ["disc", "DISCNUMBER", ["DISCTOTAL", "TOTALDISCS"]],
  ] as const) {
    const noField = `${prefix}Number` as Field,
      totalField = `${prefix}Total` as Field;
    if (!edits.has(noField) && !edits.has(totalField)) continue;
    const raw = values(canonical),
      totalKeys = aliases.filter((k) => groups.has(k));
    if (
      raw.length > 1 ||
      totalKeys.length > 1 ||
      totalKeys.some((k) => values(k).length !== 1)
    )
      unsafe("Ambiguous track/disc number metadata.");
    const match = raw.length
      ? /^(\d{1,6})?(?:\/(\d{1,6}))?$/.exec(raw[0])
      : null;
    if (raw.length && !match)
      unsafe("Unqualified track/disc number representation.");
    const number = (v: string | undefined) => {
      if (v === undefined) return null;
      if (!/^\d{1,6}$/.test(v) || Number(v) < 1)
        unsafe("Invalid existing track/disc component.");
      return Number(v);
    };
    const oldNo = number(match?.[1]),
      inlineTotal = number(match?.[2]);
    const aliasTotal = totalKeys.length
      ? number(values(totalKeys[0])[0])
      : null;
    if (
      inlineTotal !== null &&
      aliasTotal !== null &&
      inlineTotal !== aliasTotal
    )
      unsafe("Conflicting track/disc totals.");
    const no = edits.has(noField)
      ? (edits.get(noField) as number | null)
      : oldNo;
    const total = edits.has(totalField)
      ? (edits.get(totalField) as number | null)
      : (inlineTotal ?? aliasTotal);
    if (no !== null && total !== null && no > total)
      badPatch("Track/disc number cannot exceed its total.");
    pairs[prefix] = { no, total };
    if (no !== oldNo) changedPairs.add(noField);
    if (total !== (inlineTotal ?? aliasTotal)) changedPairs.add(totalField);
    const numberText =
      edits.has(noField) && no !== oldNo
        ? no === null
          ? ""
          : String(no)
        : (match?.[1] ?? "");
    let totalText = match?.[2];
    if (edits.has(totalField) && total !== (inlineTotal ?? aliasTotal)) {
      if (totalKeys.length)
        set(totalKeys[0], total === null ? null : String(total));
      if (!totalKeys.length || totalText !== undefined)
        totalText = total === null ? undefined : String(total);
    }
    // A separate existing total is retained verbatim when only the number changes.
    const combined = `${numberText}${totalText === undefined ? "" : `/${totalText}`}`;
    set(canonical, combined || null);
  }
  return { operations, pairs, changedPairs };
}
function normalized(value: unknown): unknown {
  if (value instanceof Uint8Array) return digest(value);
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalized(v)]),
    );
  return Number.isNaN(value) ? "NaN" : value;
}
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(normalized(a)) === JSON.stringify(normalized(b));
async function read(bytes: Uint8Array, document: FlacDocument) {
  const m = await parseBuffer(
    bytes,
    { mimeType: "audio/flac", size: bytes.length },
    { duration: true, skipPostHeaders: false, maxMemoryAllocation: MAX_BYTES },
  ).catch((error) => {
    throw new FlacMetadataWriteError(
      "invalid-input",
      `The independent FLAC reader failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (
    m.format.container !== "FLAC" ||
    m.format.codec !== "FLAC" ||
    m.format.sampleRate !== document.sampleRate ||
    m.format.numberOfChannels !== document.channels ||
    m.format.bitsPerSample !== document.bitsPerSample ||
    Math.round((m.format.duration ?? NaN) * document.sampleRate) !==
      document.samples
  )
    throw new FlacMetadataWriteError(
      "invalid-input",
      "The independent reader could not verify the FLAC stream parameters.",
    );
  return m.common;
}
function preservation(
  before: FlacDocument,
  after: FlacDocument,
  operations: ReadonlyMap<string, string | null>,
  artwork: FrontCover | "remove" | undefined,
) {
  verify(
    equal(before.audio, after.audio),
    "The encoded FLAC audio payload changed.",
  );
  const untouched = (d: FlacDocument) =>
    d.blocks
      .filter((b) => ![1, 4, 6].includes(b.type))
      .map((b) => [b.type, digest(b.data)]);
  verify(
    equal(untouched(before), untouched(after)),
    "A protected FLAC metadata block changed.",
  );
  if (before.vendor)
    verify(
      equal(before.vendor, after.vendor),
      "The Vorbis vendor string changed.",
    );
  const a = entryGroups(before.entries),
    b = entryGroups(after.entries);
  for (const key of new Set([...a.keys(), ...b.keys(), ...operations.keys()])) {
    if (operations.has(key)) {
      const expected = operations.get(key);
      verify(
        equal(
          (b.get(key) ?? []).map((e) => e.value),
          expected === null ? [] : [expected],
        ),
        `Requested ${key} did not round-trip exactly.`,
      );
    } else
      verify(
        equal(a.get(key) ?? [], b.get(key) ?? []),
        `Unedited Vorbis field ${key} changed.`,
      );
  }
  if (artwork === undefined)
    verify(
      equal(
        before.pictures.map((p) => p.block),
        after.pictures.map((p) => p.block),
      ),
      "Unedited artwork or picture attributes changed.",
    );
  else if (artwork === "remove")
    verify(
      after.pictures.length === 0,
      "Front-cover removal did not round-trip.",
    );
  else
    verify(
      after.pictures.length === 1 &&
        after.pictures[0].type === 3 &&
        after.pictures[0].mime === artwork.mimeType &&
        after.pictures[0].description === artwork.description &&
        equal(after.pictures[0].data, artwork.data),
      "Front-cover replacement did not round-trip exactly.",
    );
}
function verifyCommon(
  originalCommon: Awaited<ReturnType<typeof read>>,
  common: Awaited<ReturnType<typeof read>>,
  edits: Edits,
  pairs: Record<string, { no: number | null; total: number | null }>,
  artwork: FrontCover | "remove" | undefined,
) {
  const ignored = new Set<string>([
    ...(artwork === undefined ? [] : ["picture"]),
  ]);
  const commonNames = {
    title: ["title"],
    artist: ["artist", "artists"],
    album: ["album"],
    albumArtist: ["albumartist", "albumartists"],
    composer: ["composer"],
    genre: ["genre"],
    comments: ["comment"],
    year: ["year", "date"],
    bpm: ["bpm"],
  };
  for (const [field, names] of Object.entries(commonNames))
    if (edits.has(field as Field)) {
      names.forEach((n) => ignored.add(n));
      const value = edits.get(field as Field),
        c = common as unknown as Record<string, unknown>;
      const actual =
        field === "comments" ? common.comment?.map((c) => c.text) : c[names[0]];
      const expected =
        value === null
          ? undefined
          : ["composer", "genre", "comments"].includes(field)
            ? [value]
            : value;
      verify(
        equal(actual, expected) ||
          (value === null && Array.isArray(actual) && actual.length === 0),
        `The independent reader could not verify ${field}.`,
      );
    }
  for (const [prefix, expected] of Object.entries(pairs)) {
    const key = prefix === "track" ? "track" : "disk";
    ignored.add(key);
    verify(
      equal(common[key], { no: expected.no, of: expected.total }),
      "The independent reader could not verify track/disc components.",
    );
  }
  for (const key of new Set([
    ...Object.keys(originalCommon),
    ...Object.keys(common),
  ]))
    if (!ignored.has(key))
      verify(
        equal(
          originalCommon[key as keyof typeof common],
          common[key as keyof typeof common],
        ),
        `Independent readback changed unedited ${key}.`,
      );
}
/** Re-read staged/published bytes using the same qualified preservation/readback contract. */
export async function verifyFlacMetadataCandidate(
  original: Uint8Array,
  candidate: Uint8Array,
  patch: FlacMetadataPatch,
) {
  if (original.length > MAX_BYTES || candidate.length > MAX_BYTES)
    throw new FlacMetadataWriteError(
      "resource-limit",
      "FLAC verification exceeds 64 MiB.",
    );
  const plan = patchPlan(patch),
    before = parseFlac(original),
    after = parseFlac(candidate);
  const { operations, pairs } = operationsFor(before, plan.edits);
  preservation(before, after, operations, plan.artwork);
  verifyCommon(
    await read(original, before),
    await read(candidate, after),
    plan.edits,
    pairs,
    plan.artwork,
  );
  return {
    originalSha256: digest(original),
    candidateSha256: digest(candidate),
    audioSha256: digest(after.audio),
    frames: after.frames,
  };
}
let active = 0;
/** Bytes in, verified candidate bytes out. No file, database, track or root capabilities. */
export async function prepareFlacMetadataEdit(
  original: Uint8Array,
  patch: FlacMetadataPatch,
): Promise<FlacMetadataWriteResult> {
  if (!(original instanceof Uint8Array))
    badPatch("Supply audio bytes, not a path or library record.");
  if (original.length > MAX_BYTES || active >= 4)
    throw new FlacMetadataWriteError(
      "resource-limit",
      "The initial writer permits files up to 64 MiB and at most four pending requests.",
    );
  active++;
  try {
    // Snapshot caller-owned data before the first await, including artwork/draft values.
    const input = new Uint8Array(original),
      plan = patchPlan(patch),
      before = parseFlac(input);
    const { operations, pairs, changedPairs } = operationsFor(
      before,
      plan.edits,
    );
    let artwork = plan.artwork;
    if (
      artwork !== undefined &&
      (before.pictures.length > 1 || before.pictures.some((p) => p.type !== 3))
    )
      throw new FlacMetadataWriteError(
        "unsafe-artwork",
        "Artwork editing is limited to no picture or one front cover; additional pictures must remain untouched.",
      );
    if (artwork === "remove" && before.pictures.length === 0)
      artwork = undefined;
    const originalCommon = await read(input, before);
    let candidate: Uint8Array = new Uint8Array(input),
      engineVersion: string | null = null;
    if (operations.size || artwork !== undefined) {
      try {
        const rendered = await renderFlacCandidate(
          new Uint8Array(input),
          operations,
          artwork,
        );
        candidate = rendered.bytes;
        engineVersion = rendered.version;
      } catch (error) {
        if (error instanceof FlacMetadataWriteError) throw error;
        throw new FlacMetadataWriteError(
          "writer-failed",
          `FLAC candidate preparation failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    let after: FlacDocument, common: typeof originalCommon;
    try {
      if (candidate.length > MAX_BYTES)
        throw new Error("Candidate exceeds the initial size limit.");
      after = parseFlac(candidate);
      preservation(before, after, operations, artwork);
      common = await read(candidate, after);
    } catch (error) {
      if (
        error instanceof FlacMetadataWriteError &&
        error.code === "verification-failed"
      )
        throw error;
      throw new FlacMetadataWriteError(
        "verification-failed",
        `The candidate could not be independently verified: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    verifyCommon(originalCommon, common, plan.edits, pairs, artwork);
    const changedFields = [...plan.edits.keys()].filter((field) => {
      if (field.startsWith("track") || field.startsWith("disc"))
        return changedPairs.has(field);
      const key =
        textKeys[field as keyof typeof textKeys] ??
        (field === "year"
          ? "DATE"
          : field === "bpm"
            ? "BPM"
            : field.startsWith("track")
              ? "TRACKNUMBER"
              : "DISCNUMBER");
      return operations.has(key);
    }) as (keyof FlacMetadataPatch)[];
    if (artwork !== undefined) changedFields.push("artwork");
    return {
      candidate: new Uint8Array(candidate),
      changedFields,
      verification: {
        format: "FLAC",
        backend: "emscripten",
        engineVersion,
        originalSha256: digest(input),
        candidateSha256: digest(candidate),
        audioSha256: digest(before.audio),
        audioBytes: before.audio.length,
        frames: before.frames,
        preservedCommentFields: [...entryGroups(before.entries).keys()].filter(
          (k) => !operations.has(k),
        ).length,
        preservedPictureCount:
          artwork === undefined ? before.pictures.length : 0,
        preservedBlockTypes: before.blocks
          .filter((b) => ![1, 4, 6].includes(b.type))
          .map((b) => b.type),
      },
    };
  } finally {
    active--;
  }
}
