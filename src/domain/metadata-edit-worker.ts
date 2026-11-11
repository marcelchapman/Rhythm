import { MAX_FLAC_FILE_BYTES } from "../shared/flac-limits.js";
import { parentPort, workerData } from "node:worker_threads";
import { parseBuffer } from "music-metadata";
import {
  prepareFlacMetadataEdit,
  verifyFlacMetadataCandidate,
} from "./metadata-writer.js";
import { trackMetadata } from "./track-metadata.js";
import { digest, parseFlac } from "./flac-document.js";
async function project(candidate: Uint8Array, filename: string) {
  const parsed = await parseBuffer(
    candidate,
    { mimeType: "audio/flac", size: candidate.length },
    { duration: true, maxMemoryAllocation: MAX_FLAC_FILE_BYTES },
  );
  return trackMetadata(filename, parsed);
}
const timings: {
  mode: string;
  stage: string;
  wallMs: number;
  threadCpuMs: number;
}[] = [];
let lastWall = workerData.timing ? performance.now() : 0;
let lastCpu = workerData.timing ? process.threadCpuUsage() : undefined;
const timing =
  lastCpu &&
  ((stage: string) => {
    const wall = performance.now(),
      cpu = process.threadCpuUsage();
    timings.push({
      mode: workerData.mode,
      stage,
      wallMs: wall - lastWall,
      threadCpuMs:
        (cpu.user + cpu.system - lastCpu!.user - lastCpu!.system) / 1000,
    });
    lastWall = wall;
    lastCpu = cpu;
  });
try {
  if (workerData.mode === "prepare") {
    const prepared = await prepareFlacMetadataEdit(
      workerData.original,
      workerData.patch,
      timing,
    );
    const metadata =
      workerData.filename && prepared.changedFields.length
        ? await project(prepared.candidate, workerData.filename)
        : undefined;
    timing?.("projection");
    parentPort!.postMessage({
      ok: true,
      value: { ...prepared, metadata },
      ...(timing ? { timings } : {}),
    });
  } else {
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
          timing,
        );
    const metadata = await project(workerData.candidate, workerData.filename);
    timing?.("projection");
    parentPort!.postMessage({
      ok: true,
      ...(timing ? { timings } : {}),
      value: recovering ? metadata : { proof, metadata },
    });
  }
} catch (error) {
  parentPort!.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
    ...(timing ? { timings } : {}),
  });
}
