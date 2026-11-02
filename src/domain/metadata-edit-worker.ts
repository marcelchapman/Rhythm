import { parentPort, workerData } from "node:worker_threads";
import { parseBuffer } from "music-metadata";
import {
  prepareFlacMetadataEdit,
  verifyFlacMetadataCandidate,
} from "./metadata-writer.js";
import { trackMetadata } from "./track-metadata.js";
import { digest, parseFlac } from "./flac-document.js";
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
    const recovering = workerData.mode === "recover-in-place";
    if (recovering) {
      if (
        digest(parseFlac(workerData.candidate).audio) !== workerData.audioSha256
      )
        throw new Error("In-place recovery audio verification failed.");
      const check = await prepareFlacMetadataEdit(
        workerData.candidate,
        workerData.patch,
      );
      if (check.changedFields.length)
        throw new Error("In-place recovery metadata verification failed.");
    }
    const proof = recovering
      ? undefined
      : await verifyFlacMetadataCandidate(
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
      value: recovering
        ? trackMetadata(workerData.filename, parsed)
        : { proof, metadata: trackMetadata(workerData.filename, parsed) },
    });
  }
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
