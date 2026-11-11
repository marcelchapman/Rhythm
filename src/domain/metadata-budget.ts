import {
  MAX_FLAC_FILE_BYTES,
  FLAC_SIZE_MESSAGE,
} from "../shared/flac-limits.js";

// Retain the former four-by-64 MiB aggregate envelope.
const INPUT_BUDGET = 256 * 1024 * 1024;
let reserved = 0;
/** No queue: bound aggregate original bytes for the entire admitted edit lifetime. */
export function reserveMetadataInput(bytes: number) {
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_FLAC_FILE_BYTES)
    throw new Error(FLAC_SIZE_MESSAGE);
  if (reserved + bytes > INPUT_BUDGET)
    throw new Error(
      "Wait for the current metadata operation: memory budget is busy.",
    );
  reserved += bytes;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    reserved -= bytes;
  };
}
