import { FLAC_SIZE_MESSAGE } from "../shared/flac-limits.js";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { open, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import type { Library } from "../domain/library.js";
import {
  editManagedFlac,
  type MetadataUsage,
} from "../domain/metadata-edit.js";
import { pendingMetadataEdits } from "../domain/metadata-edit-schema.js";
import {
  validateCurrentManagedReceipt,
  type MediaRoot,
} from "../domain/managed-copy.js";
import { validateMetadataPatch } from "../shared/metadata-editor.js";
import { selectMetadataPublication } from "../domain/metadata-publication.js";

/** Main-owned profile log: aborted pre-publication journals need not retain errors. */
export async function recordMetadataFailure(
  directory: string,
  trackId: unknown,
  error: unknown,
) {
  const reference = randomUUID().slice(0, 8);
  try {
    await mkdir(directory, { recursive: true });
    const log = await open(
      path.join(directory, "metadata-edit-errors.log"),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_APPEND |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await log.stat();
      if (!info.isFile() || info.nlink !== 1)
        throw new Error("Unsafe diagnostic log.");
      await log.appendFile(
        JSON.stringify({
          reference,
          time: new Date().toISOString(),
          trackId:
            typeof trackId === "string" && /^[a-f0-9]{64}$/.test(trackId)
              ? trackId
              : null,
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        }) + "\n",
      );
    } finally {
      await log.close();
    }
  } catch (loggingError) {
    console.error("Could not persist metadata diagnostic:", loggingError);
  }
  return reference;
}

const sessions = new WeakMap<Library, string>();
export function metadataSession(library: Library | null) {
  if (!library) return null;
  if (!sessions.has(library)) sessions.set(library, randomUUID());
  return sessions.get(library)!;
}
export function assertMetadataSender(
  event: { sender: unknown; senderFrame?: unknown },
  owner: { mainFrame: unknown } | null | undefined,
) {
  if (
    !owner ||
    event.sender !== owner ||
    event.senderFrame !== owner.mainFrame ||
    (event.senderFrame as { url?: string })?.url !== "rio://app/index.html"
  )
    throw new Error("Untrusted metadata request.");
}
export function validateMetadataTarget(
  id: unknown,
  session: unknown,
  library: Library | null,
) {
  if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id))
    throw new Error("Choose a valid track.");
  if (
    !library ||
    !library.db.isOpen ||
    typeof session !== "string" ||
    session !== metadataSession(library)
  )
    throw new Error("The library changed. Reopen Track Info and try again.");
  const track = library.tracks(id)[0];
  if (!track) throw new Error("Track no longer exists. Reopen Track Info.");
  return track;
}
export function metadataError(error: unknown, recoveryRequired = false) {
  const message = error instanceof Error ? error.message : String(error);
  if (recoveryRequired)
    return "An unfinished metadata operation needs recovery. Restart Rio; if this continues, keep the library and media files intact and review the diagnostic log.";
  if (message.includes("file-size limit")) return FLAC_SIZE_MESSAGE;
  if (/not a regular file/i.test(message))
    return "Rio can edit only regular managed FLAC files.";
  if (/unexpected hard links/i.test(message))
    return "Rio can’t edit a file with additional filesystem hard links. Import an independent managed copy.";
  if (/In-place metadata write failed/.test(message))
    return "Rio couldn’t save these changes. Reopen Track Info to check the file, or use Locate File to restore it. See the diagnostic reference for details.";
  if (/Require local writable APFS/.test(message))
    return "Editing is unavailable on this volume. Rio requires local writable APFS.";
  if (/Require writable local ext4/.test(message))
    return "Editing is unavailable on this volume. Rio requires a writable local ext4 filesystem.";
  if (/Publication support unavailable/.test(message))
    return "Rio can’t safely publish metadata changes on this volume. See the diagnostic log for details.";
  if (
    /in use|playback-use|Playback ownership|Playback renderer|Playback source|locked for metadata/i.test(
      message,
    )
  )
    return "Rio can’t edit this track while it is loaded for playback or its playback state is unknown. Switch to another track, then try again.";
  if (/organized/i.test(message))
    return "Turn off Keep Rio Media organized in Settings to edit metadata.";
  if (/unfinished|recovery|publication.*unresolved|ambiguous/i.test(message))
    return "An unfinished metadata operation needs recovery. Restart Rio; if this continues, keep the library and media files intact and review the diagnostic log.";
  if (
    /receipt|revision|location changed|Track\/path ownership|identity|link|root|ENOENT|EACCES|unavailable|missing/i.test(
      message,
    )
  )
    return "Rio can’t verify this managed file. Check that its media folder is available and use Locate File if needed. No unverified file will be edited.";
  if (
    /^(Referenced files are read only|This format is read only)/.test(message)
  )
    return message;
  if (/managed FLAC/i.test(message))
    return "Editing is available only for managed FLAC tracks.";
  if (/current.*operation|current.*import|Wait for|budget/i.test(message))
    return "Wait for the current library operation to finish, then try again.";
  if (
    /valid track|no longer exists|library changed|Unsupported metadata|Invalid edit|must be|Supply metadata/i.test(
      message,
    )
  )
    return message;
  return "Rio couldn’t complete this metadata edit. Reopen Track Info and try again. If this continues, review the diagnostic log.";
}

/** Advisory only: Save always repeats the authoritative coordinator checks. */
export async function metadataEligibility(
  library: Library,
  id: string,
  usage: MetadataUsage,
  timing?: import("../domain/metadata-edit.js").MetadataTiming,
) {
  const track = library.tracks(id)[0],
    settings = library.mediaSettings();
  if (!track || track.locationKind !== "managed")
    throw new Error(
      "Referenced files are read only. Editing requires a managed FLAC copy.",
    );
  if (
    track.format.toLowerCase() !== "flac" ||
    path.extname(track.path).toLowerCase() !== ".flac"
  )
    throw new Error(
      "This format is read only. Editing is available only for managed FLAC tracks.",
    );
  if (settings.keepOrganized) throw new Error("Keep organized is enabled.");
  if (library.scanning || settings.pendingImports)
    throw new Error("Wait for the current library operation.");
  if (pendingMetadataEdits(library.db))
    throw new Error("Resolve unfinished metadata edits first.");
  if (track.missing) throw new Error("Track unavailable.");
  const root = library.db
    .prepare(
      "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
    )
    .get(track.mediaRootId!) as unknown as MediaRoot;
  if (!root || root.id !== settings.root?.id)
    throw new Error("Managed root changed.");
  await validateCurrentManagedReceipt(
    library.db,
    root,
    id,
    track.path,
    track.mediaRelativePath!,
    timing && ((detail) => timing("receipt-eligibility", detail)),
  );
  timing?.("receipt-eligibility-done");
  timing?.("playback-gate-start");
  const lease = usage.acquireIdle(id);
  timing?.("playback-gate-acquired");
  try {
    lease.assertIdle();
    if (library.scanning)
      throw new Error("Wait for the current library operation.");
    // Main selects a storage capability; this advisory check never writes tags.
    selectMetadataPublication({
      root: root.path,
      rootIdentity: {
        device: root.device,
        inode: root.inode,
        type: "directory",
      },
      relative: track.mediaRelativePath!,
    });
  } finally {
    lease.release();
  }
}
export async function saveTrackMetadata(
  library: Library,
  id: string,
  session: unknown,
  patch: unknown,
  usage: MetadataUsage,
  timing?: import("../domain/metadata-edit.js").MetadataTiming,
) {
  validateMetadataTarget(id, session, library);
  const changes = validateMetadataPatch(patch);
  timing?.("validate-patch");
  return editManagedFlac(library, id, changes, { usage, timing });
}
