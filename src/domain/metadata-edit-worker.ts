import { parentPort, workerData } from "node:worker_threads";
import { parseBuffer } from "music-metadata";
import {
  prepareFlacMetadataEdit,
  verifyFlacMetadataCandidate,
} from "./metadata-writer.js";
import { trackMetadata } from "./track-metadata.js";
try {
  if (workerData.mode === "prepare")
    parentPort!.postMessage({
      ok: true,
      value: await prepareFlacMetadataEdit(
        workerData.original,
        workerData.patch,
      ),
    });
  else {
    const proof = await verifyFlacMetadataCandidate(
      workerData.original,
      workerData.candidate,
      workerData.patch,
    );
    const parsed = await parseBuffer(
      workerData.candidate,
      { mimeType: "audio/flac", size: workerData.candidate.length },
      { duration: true, maxMemoryAllocation: 64 * 1024 * 1024 },
    );
    parentPort!.postMessage({
      ok: true,
      value: { proof, metadata: trackMetadata(workerData.filename, parsed) },
    });
  }
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
