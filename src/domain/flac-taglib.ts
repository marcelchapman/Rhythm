/** Internal engine adapter. It can edit only supplied bytes, never an audio path. */
import { FlacMetadataWriteError } from "./flac-document.js";

export interface FrontCover {
  data: Uint8Array;
  mimeType: "image/png" | "image/jpeg";
  description: string;
}
let tail: Promise<unknown> = Promise.resolve();
let engine: Promise<import("taglib-wasm").TagLib> | undefined;
export async function renderFlacCandidate(
  original: Uint8Array,
  operations: ReadonlyMap<string, string | null>,
  artwork: FrontCover | "remove" | undefined,
): Promise<{ bytes: Uint8Array; version: string }> {
  const run = tail.then(async () => {
    const { TagLib } = await import("taglib-wasm");
    // Force the qualified engine. The package resolves its own local WASM asset;
    // no caller-provided paths, default WASI preopens, or network URL are used.
    const lib = await (engine ??= TagLib.initialize({
      forceWasmType: "emscripten",
    }).catch((error) => {
      engine = undefined;
      throw error;
    }));
    const file = await lib.open(original, { partial: false });
    try {
      if (!file.isValid() || file.getFormat() !== "FLAC")
        throw new FlacMetadataWriteError(
          "invalid-input",
          "The writer did not recognize native FLAC audio.",
        );
      for (const [key, value] of operations) {
        if (value === null) file.removeProperty(key);
        else file.setProperty(key, value);
      }
      if (artwork === "remove") file.removePictures();
      else if (artwork) file.setPictures([{ ...artwork, type: "FrontCover" }]);
      if (!file.save())
        throw new Error("TagLib could not save the candidate buffer.");
      // Copy before dispose: never return a view into WASM-owned memory.
      return {
        bytes: new Uint8Array(file.getFileBuffer()),
        version: lib.version(),
      };
    } finally {
      file.dispose();
    }
  });
  tail = run.catch(() => {});
  return run;
}
