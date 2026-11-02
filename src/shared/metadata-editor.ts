import type { Track } from "./types.js";
import type { MetadataEditPatch } from "../domain/metadata-edit.js";

export const metadataFields = [
  ["title", "Title"],
  ["artist", "Artist"],
  ["album", "Album"],
  ["albumArtist", "Album Artist"],
  ["composer", "Composer"],
  ["genre", "Genre"],
  ["year", "Year"],
  ["trackNumber", "Track number"],
  ["trackTotal", "Track total"],
  ["discNumber", "Disc number"],
  ["discTotal", "Disc total"],
  ["bpm", "BPM"],
  ["comments", "Comments"],
] as const;
export type MetadataField = (typeof metadataFields)[number][0];
export type MetadataDraft = Record<MetadataField, string>;
export type { MetadataEditPatch };
export const numericMaximum = (field: string) =>
  field === "year"
    ? 9999
    : field === "bpm"
      ? 1000
      : ["trackNumber", "trackTotal", "discNumber", "discTotal"].includes(field)
        ? 999999
        : null;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value));

/** Strict, bounded wire input. No paths, artwork, coercion or generic operations. */
export function validateMetadataPatch(value: unknown): MetadataEditPatch {
  if (!object(value)) throw new Error("Supply metadata changes.");
  for (const [field, edit] of Object.entries(value)) {
    if (!metadataFields.some(([key]) => key === field) || !object(edit))
      throw new Error("Unsupported metadata field or edit.");
    if (
      (edit.action === "preserve" || edit.action === "clear") &&
      Object.keys(edit).length === 1
    )
      continue;
    if (
      edit.action !== "set" ||
      Object.keys(edit).length !== 2 ||
      !Object.hasOwn(edit, "value")
    )
      throw new Error(`Invalid edit for ${field}.`);
    const max = numericMaximum(field);
    if (max !== null) {
      if (
        typeof edit.value !== "number" ||
        !Number.isInteger(edit.value) ||
        edit.value < 1 ||
        edit.value > max
      )
        throw new Error(
          `${field} must be a whole number from 1 to ${max}, or empty to clear.`,
        );
    } else if (
      typeof edit.value !== "string" ||
      !edit.value.length ||
      edit.value.length > 4000 ||
      edit.value.includes("\0") ||
      new TextDecoder().decode(new TextEncoder().encode(edit.value)) !==
        edit.value
    )
      throw new Error(
        `${field} must contain valid text of at most 4,000 characters, or be empty to clear.`,
      );
  }
  return value as MetadataEditPatch;
}
export function metadataDraft(track: Track): MetadataDraft {
  return Object.fromEntries(
    metadataFields.map(([key]) => {
      const value =
        key === "trackNumber"
          ? track.track
          : key === "discNumber"
            ? track.disc
            : track[key];
      return [key, value == null || value === 0 ? "" : String(value)];
    }),
  ) as MetadataDraft;
}
/** Untouched blanks and display fallbacks never become implicit clears. */
export function metadataChanges(
  before: MetadataDraft,
  after: MetadataDraft,
): MetadataEditPatch {
  const patch: Record<string, unknown> = {};
  for (const [key, label] of metadataFields) {
    if (before[key] === after[key]) continue;
    const text = after[key],
      max = numericMaximum(key);
    if (text === "") patch[key] = { action: "clear" };
    else {
      if (max !== null && !/^\d+$/.test(text))
        throw new Error(`${label} must be a whole number, or empty to clear.`);
      patch[key] = { action: "set", value: max === null ? text : Number(text) };
    }
  }
  return validateMetadataPatch(patch);
}
