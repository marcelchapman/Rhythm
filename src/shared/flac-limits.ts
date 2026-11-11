// Whole-file verification/WASM publication is bounded, not a streaming writer.
// Native build flags import this same policy; it is never renderer-selected.
const MAX_FLAC_FILE_MIB = 128;
export const MAX_FLAC_FILE_BYTES = MAX_FLAC_FILE_MIB * 1024 * 1024;
export const FLAC_SIZE_MESSAGE = `This FLAC exceeds Rio’s supported ${MAX_FLAC_FILE_MIB} MiB file-size limit.`;
