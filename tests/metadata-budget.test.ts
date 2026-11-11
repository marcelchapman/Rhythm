import { expect, test } from "vitest";
import { reserveMetadataInput } from "../src/domain/metadata-budget";
import { MAX_FLAC_FILE_BYTES } from "../src/shared/flac-limits";
import { metadataError } from "../src/main/metadata-editor";

test("two maximum-sized edits exhaust the aggregate budget until released", () => {
  const release = reserveMetadataInput(MAX_FLAC_FILE_BYTES);
  const other = reserveMetadataInput(MAX_FLAC_FILE_BYTES);
  try {
    expect(() => reserveMetadataInput(1)).toThrow(/memory budget/);
  } finally {
    release();
    other();
  }
  release();
  const next = reserveMetadataInput(MAX_FLAC_FILE_BYTES);
  next();
});
test("four former-budget inputs fit but their aggregate cannot grow unbounded", () => {
  const releases = Array.from({ length: 4 }, () =>
    reserveMetadataInput(64 * 1024 * 1024),
  );
  try {
    expect(() => reserveMetadataInput(1)).toThrow(/memory budget/);
  } finally {
    releases.forEach((release) => release());
  }
});
test.each([-1, NaN, Infinity, 0.5, MAX_FLAC_FILE_BYTES + 1])(
  "invalid/oversize admission fails without retaining budget: %s",
  (bytes) => {
    expect(() => reserveMetadataInput(bytes)).toThrow(/128 MiB/);
    reserveMetadataInput(MAX_FLAC_FILE_BYTES)();
  },
);
test("size, file type, hard links, authority and playback failures stay distinct", () => {
  const size = metadataError(
    Error("FLAC exceeds supported 128 MiB file-size limit"),
  );
  expect(size).toMatch(/128 MiB/);
  expect(size).not.toMatch(/Locate File|playback/);
  expect(metadataError(Error("Metadata target is not a regular file"))).toMatch(
    /regular/,
  );
  expect(
    metadataError(Error("Metadata target has unexpected hard links")),
  ).toMatch(/independent managed copy/);
  expect(metadataError(Error("Managed receipt identity changed"))).toMatch(
    /verify this managed file/,
  );
  expect(metadataError(Error("Target is in use"))).toMatch(
    /loaded for playback/,
  );
});
