/** Phase 2A domain coordinator. No UI, IPC, path relocation or external-file writes. */
import { Worker } from "node:worker_threads";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat, realpath, readdir } from "node:fs/promises";
import path from "node:path";
import type { Library } from "./library.js";
import type {
  FlacMetadataPatch,
  FlacMetadataWriteResult,
} from "./metadata-writer.js";
import type { TrackMetadata } from "./track-metadata.js";
import {
  validateCurrentManagedReceipt,
  validateMediaRoot,
  type MediaRoot,
} from "./managed-copy.js";
import {
  openPublicationLease,
  resumePublicationCleanup,
  inspectInterruptedPublication,
  type PublicationRecord,
  type PublicationFingerprint,
  type PublicationLease,
} from "./publication.js";
import { pendingMetadataEdits } from "./metadata-edit-schema.js";

export type MetadataEditPatch = Omit<FlacMetadataPatch, "artwork">;
export interface TargetUseLease {
  assertIdle(): void;
  release(): void;
}
export interface MetadataUsage {
  acquireIdle(trackId: string): TargetUseLease;
}
/** A host must explicitly declare idle and route every target acquisition through this gate. */
export class MetadataUseGate implements MetadataUsage {
  private state = new Map<string, boolean>();
  private locked = new Set<string>();
  setInUse(trackId: string, inUse: boolean) {
    if (this.locked.has(trackId))
      throw new Error("Track is locked for metadata editing.");
    this.state.set(trackId, inUse);
  }
  acquireIdle(trackId: string) {
    if (this.state.get(trackId) !== false || this.locked.has(trackId))
      throw new Error("Target is in use or its playback-use state is unknown.");
    this.locked.add(trackId);
    let released = false;
    return {
      assertIdle: () => {
        if (
          released ||
          !this.locked.has(trackId) ||
          this.state.get(trackId) !== false
        )
          throw new Error("Playback-use lease changed.");
      },
      release: () => {
        released = true;
        this.locked.delete(trackId);
      },
    };
  }
}
export class MetadataEditInterruption extends Error {}
export interface MetadataEditHooks {
  at?: (
    phase:
      | "journal"
      | "staged"
      | "candidate-staged"
      | "before-publish"
      | "published"
      | "committed"
      | "artifacts-cleaned"
      | "cleaned",
    editId: string,
  ) => Promise<void>;
}
type Phase =
  | "preparing"
  | "staged"
  | "published"
  | "committed"
  | "done"
  | "aborted"
  | "recovery-required";
interface Journal {
  version: 1;
  trackId: string;
  filename: string;
  root: MediaRoot;
  relative: string;
  original: PublicationFingerprint;
  originalSha256: string;
  receipt: {
    digest: string;
    device: string;
    inode: string;
    rootId: string;
    relative: string;
  };
  patch: MetadataEditPatch;
  record?: PublicationRecord;
  candidateSha256?: string;
  audioSha256?: string;
  metadata?: TrackMetadata;
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const matches = (
  a: { device: string; inode: string; type?: string } | undefined,
  b: { device: string; inode: string; type?: string },
) =>
  !!a &&
  a.device === b.device &&
  a.inode === b.inode &&
  (!a.type || !b.type || a.type === b.type);
async function fingerprint(filename: string): Promise<PublicationFingerprint> {
  const s = await lstat(filename, { bigint: true });
  return {
    device: String(s.dev),
    inode: String(s.ino),
    type: s.isFile()
      ? "file"
      : s.isDirectory()
        ? "directory"
        : s.isSymbolicLink()
          ? "symlink"
          : "other",
    size: String(s.size),
    links: String(s.nlink),
    mode: String(s.mode),
    uid: String(s.uid),
    gid: String(s.gid),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
  };
}
async function bytesAt(
  filename: string,
  expected: { device: string; inode: string },
  digest?: string,
) {
  if ((await realpath(filename)) !== filename)
    throw new Error("Metadata file path changed or traverses a link.");
  const handle = await open(
    filename,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.size > 64n * 1024n * 1024n ||
      String(before.dev) !== expected.device ||
      String(before.ino) !== expected.inode
    )
      throw new Error("Metadata file identity/size is unsafe.");
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const chunk = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        offset,
      );
      if (!chunk.bytesRead)
        throw new Error("Metadata file was truncated while reading.");
      offset += chunk.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      (digest && sha(bytes) !== digest)
    )
      throw new Error("Metadata file changed while reading.");
    return bytes;
  } finally {
    await handle.close();
  }
}
let workers = 0;
function worker<T>(data: object): Promise<T> {
  if (workers >= 4)
    return Promise.reject(new Error("Metadata worker budget is exhausted."));
  workers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, value?: T) => {
      if (settled) return;
      settled = true;
      workers--;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const url = new URL(
      import.meta.url.endsWith(".ts")
        ? "../../dist/domain/metadata-edit-worker.js"
        : "./metadata-edit-worker.js",
      import.meta.url,
    );
    const timer = setTimeout(() => {
      finish(new Error("Metadata worker timed out; original retained."));
      void thread.terminate();
    }, 30000);
    let thread: Worker;
    try {
      thread = new Worker(url, {
        workerData: data,
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 384,
          maxYoungGenerationSizeMb: 32,
        },
      });
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    thread.once("message", (reply) => {
      reply.ok
        ? finish(undefined, reply.value as T)
        : finish(new Error(reply.error));
      void thread.terminate();
    });
    thread.once("error", (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
    thread.once("exit", (code) => {
      if (!settled)
        finish(new Error(`Metadata worker exited before replying (${code}).`));
    });
  });
}
function put(
  l: Library,
  id: string,
  phase: Phase,
  journal: Journal,
  error?: string,
) {
  l.db
    .prepare("UPDATE metadata_edits SET phase=?,journal=?,error=? WHERE id=?")
    .run(phase, JSON.stringify(journal), error ?? null, id);
}
function rootOf(l: Library, rootId: string) {
  const root = l.db
    .prepare(
      "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
    )
    .get(rootId) as unknown as MediaRoot | undefined;
  if (!root) throw new Error("Media root is no longer configured.");
  return root;
}
async function lock(l: Library) {
  if (l.scanning) throw new Error("Wait for the current library operation.");
  l.scanning = true;
  try {
    l.db.exec("PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; COMMIT;");
  } catch (error) {
    l.scanning = false;
    throw error;
  }
}
function unlock(l: Library) {
  try {
    l.db.exec("ROLLBACK");
  } catch {
    /* No outstanding transaction is normal. */
  }
  try {
    l.db.exec(
      "PRAGMA locking_mode=NORMAL; SELECT count(*) FROM sqlite_master;",
    );
  } finally {
    l.scanning = false;
  }
}
async function verifyCandidate(
  j: Journal,
  original: Uint8Array,
  candidate: Uint8Array,
) {
  const result = await worker<{
    proof: {
      originalSha256: string;
      candidateSha256: string;
      audioSha256: string;
    };
    metadata: TrackMetadata;
  }>({
    mode: "verify",
    original,
    candidate,
    patch: j.patch,
    filename: j.filename,
  });
  if (
    result.proof.originalSha256 !== j.originalSha256 ||
    result.proof.candidateSha256 !== j.candidateSha256 ||
    result.proof.audioSha256 !== j.audioSha256
  )
    throw new Error("Publication failed FLAC/audio verification.");
  return result.metadata;
}
function checkTrack(l: Library, j: Journal) {
  const track = l.tracks(j.trackId)[0];
  if (
    !track ||
    track.locationKind !== "managed" ||
    track.path !== j.filename ||
    track.mediaRootId !== j.root.id ||
    track.mediaRelativePath !== j.relative
  )
    throw new Error("Track/path ownership changed during metadata editing.");
  const root = rootOf(l, j.root.id);
  if (JSON.stringify(root) !== JSON.stringify(j.root))
    throw new Error("Managed root changed during metadata editing.");
  return track;
}
function commit(
  l: Library,
  id: string,
  j: Journal,
  info: PublicationFingerprint,
  metadata: TrackMetadata,
) {
  checkTrack(l, j);
  l.db.exec("BEGIN IMMEDIATE");
  try {
    const receipt = l.db
      .prepare("SELECT * FROM managed_file_receipts WHERE trackId=?")
      .get(j.trackId);
    if (
      !receipt ||
      receipt.rootId !== j.root.id ||
      receipt.relative !== j.relative ||
      !(
        (receipt.digest === j.originalSha256 &&
          receipt.device === j.original.device &&
          receipt.inode === j.original.inode) ||
        (receipt.digest === j.candidateSha256 &&
          receipt.device === info.device &&
          receipt.inode === info.inode)
      )
    )
      throw new Error("Current receipt changed during commit.");
    l.db
      .prepare(
        `UPDATE tracks SET title=?,artist=?,albumArtist=?,album=?,albumId=?,genre=?,year=?,disc=?,track=?,duration=?,bpm=?,comments=?,bitRate=?,codec=?,composer=?,trackTotal=?,discTotal=?,size=?,mtime=?,metadataVersion=3,missing=0 WHERE id=?`,
      )
      .run(
        metadata.title,
        metadata.artist,
        metadata.albumArtist,
        metadata.album,
        metadata.albumId,
        metadata.genre,
        metadata.year,
        metadata.disc,
        metadata.track,
        metadata.duration,
        metadata.bpm,
        metadata.comments,
        metadata.bitRate,
        metadata.codec,
        metadata.composer,
        metadata.trackTotal,
        metadata.discTotal,
        Number(info.size),
        Number(info.mtimeNs) / 1e6,
        j.trackId,
      );
    l.db
      .prepare(
        "UPDATE managed_file_receipts SET digest=?,device=?,inode=? WHERE trackId=? AND rootId=? AND relative=?",
      )
      .run(
        j.candidateSha256!,
        info.device,
        info.inode,
        j.trackId,
        j.root.id,
        j.relative,
      );
    if (l.db.prepare("SELECT changes() AS n").get()!.n !== 1)
      throw new Error("Current receipt changed during commit.");
    j.metadata = metadata;
    put(l, id, "committed", j);
    l.db.exec("COMMIT");
  } catch (error) {
    l.db.exec("ROLLBACK");
    throw error;
  }
}
async function reconcile(l: Library, j: Journal) {
  checkTrack(l, j);
  await validateCurrentManagedReceipt(
    l.db,
    j.root,
    j.trackId,
    j.filename,
    j.relative,
  );
  const track = l.tracks(j.trackId)[0];
  const row = l.db.prepare("SELECT * FROM tracks WHERE id=?").get(j.trackId)!;
  for (const [key, value] of Object.entries(j.metadata!))
    if (row[key] !== value)
      throw new Error(`Metadata reconciliation mismatch: ${key}.`);
  return track;
}
async function cleanup(
  l: Library,
  id: string,
  j: Journal,
  lease: PublicationLease,
  disposition: "abort" | "committed",
  hooks?: MetadataEditHooks,
) {
  const synced = lease.syncPublication();
  if (synced.status !== "synced")
    throw new Error(`Publication durability unresolved: ${synced.reason}`);
  const result = lease.cleanupVerifiedArtifacts(disposition);
  if (result.status !== "cleaned")
    throw new Error(`Publication cleanup unresolved: ${result.reason}`);
  await hooks?.at?.("artifacts-cleaned", id);
  put(l, id, disposition === "committed" ? "done" : "aborted", j);
}

/** Caller must hold an idle playback-use capability; unknown use fails closed. */
export async function editManagedFlac(
  l: Library,
  trackId: string,
  patch: MetadataEditPatch,
  options: { usage?: MetadataUsage; hooks?: MetadataEditHooks } = {},
) {
  const snapshot = structuredClone(patch);
  if (
    !snapshot ||
    typeof snapshot !== "object" ||
    Object.hasOwn(snapshot, "artwork")
  )
    throw new Error("Phase 2A permits metadata fields only, not artwork.");
  if (pendingMetadataEdits(l.db))
    throw new Error("Resolve unfinished metadata edits first.");
  const use = options.usage?.acquireIdle(trackId);
  if (!use)
    throw new Error(
      "A reliable idle playback-use lease is required; editing an in-use or unknown target is not permitted.",
    );
  let leased: PublicationLease | undefined;
  let journal: Journal | undefined;
  let id: string | undefined;
  let locked = false;
  try {
    await lock(l);
    locked = true;
    const track = l.tracks(trackId)[0],
      settings = l.mediaSettings();
    if (
      !track ||
      track.locationKind !== "managed" ||
      track.format.toLowerCase() !== "flac" ||
      path.extname(track.path).toLowerCase() !== ".flac"
    )
      throw new Error("Metadata editing requires one managed FLAC track.");
    if (
      settings.keepOrganized !== false ||
      settings.root?.id !== track.mediaRootId
    )
      throw new Error(
        "Keep Rio Media organized must be OFF and the track must use the current media root.",
      );
    if (settings.pendingImports)
      throw new Error("Finish managed imports first.");
    const root = rootOf(l, track.mediaRootId!);
    await validateCurrentManagedReceipt(
      l.db,
      root,
      track.id,
      track.path,
      track.mediaRelativePath!,
    );
    if (
      (await readdir(path.dirname(track.path))).some((n) =>
        n.startsWith(".rio-publication-"),
      )
    )
      throw new Error(
        "An unfinished publication workspace conflicts with this edit.",
      );
    const originalFingerprint = await fingerprint(track.path);
    const receipt = l.db
      .prepare(
        "SELECT rootId,relative,digest,device,inode FROM managed_file_receipts WHERE trackId=?",
      )
      .get(trackId) as unknown as Journal["receipt"];
    const original = await bytesAt(track.path, receipt, receipt.digest);
    id = randomUUID();
    journal = {
      version: 1,
      trackId,
      filename: track.path,
      root,
      relative: track.mediaRelativePath!,
      original: originalFingerprint,
      originalSha256: sha(original),
      receipt: structuredClone(receipt),
      patch: snapshot,
    };
    l.db
      .prepare("INSERT INTO metadata_edits VALUES(?,?,?,?,?,?,NULL,?)")
      .run(
        id,
        trackId,
        root.id,
        journal.relative,
        "preparing",
        JSON.stringify(journal),
        Date.now(),
      );
    await options.hooks?.at?.("journal", id);
    const prepared = await worker<FlacMetadataWriteResult>({
      mode: "prepare",
      original,
      patch: snapshot,
    });
    if (
      prepared.verification.originalSha256 !== journal.originalSha256 ||
      sha(prepared.candidate) !== prepared.verification.candidateSha256
    )
      throw new Error("FLAC writer candidate proof does not match bytes.");
    if (!prepared.changedFields.length) {
      put(l, id, "aborted", journal);
      return {
        status: "no-change" as const,
        editId: id,
        track: l.tracks(trackId)[0],
      };
    }
    journal.candidateSha256 = prepared.verification.candidateSha256;
    journal.audioSha256 = prepared.verification.audioSha256;
    put(l, id, "preparing", journal);
    const opened = openPublicationLease({
      root: root.path,
      rootIdentity: {
        device: root.device,
        inode: root.inode,
        type: "directory",
      },
      relative: journal.relative,
      expected: originalFingerprint,
      originalSha256: journal.originalSha256,
      candidate: prepared.candidate,
    });
    if (!("lease" in opened))
      throw new Error(
        `Publication staging failed: ${opened.reason ?? opened.status}`,
      );
    leased = opened.lease;
    journal.record = leased.record;
    put(l, id, "staged", journal);
    await options.hooks?.at?.("candidate-staged", id);
    const staged = await bytesAt(
      path.join(
        path.dirname(journal.filename),
        journal.record.workspace,
        "slot",
      ),
      journal.record.candidateIdentity,
      journal.candidateSha256,
    );
    journal.metadata = await verifyCandidate(journal, original, staged);
    put(l, id, "staged", journal);
    await options.hooks?.at?.("staged", id);
    await options.hooks?.at?.("before-publish", id);
    await validateMediaRoot(root);
    checkTrack(l, journal);
    const nowReceipt = l.db
      .prepare(
        "SELECT rootId,relative,digest,device,inode FROM managed_file_receipts WHERE trackId=?",
      )
      .get(trackId);
    if (JSON.stringify(nowReceipt) !== JSON.stringify(receipt))
      throw new Error("Managed receipt changed before publication.");
    await validateCurrentManagedReceipt(
      l.db,
      root,
      trackId,
      track.path,
      journal.relative,
    );
    use.assertIdle();
    if (
      l.db.prepare("SELECT phase FROM metadata_edits WHERE id=?").get(id)
        ?.phase !== "staged"
    )
      throw new Error("Metadata edit journal changed before publication.");
    const published = leased.exchangeAndObserve();
    if (published.status !== "exchanged-expected")
      throw new Error(
        `Publication did not verify: ${published.status} ${published.reason ?? ""}`,
      );
    put(l, id, "published", journal);
    await options.hooks?.at?.("published", id);
    if (leased.syncPublication().status !== "synced")
      throw new Error("Publication durability is unresolved.");
    const authoritative = await bytesAt(
      track.path,
      journal.record.candidateIdentity,
      journal.candidateSha256,
    );
    const metadata = await verifyCandidate(journal, original, authoritative);
    use.assertIdle();
    commit(l, id, journal, await fingerprint(track.path), metadata);
    await options.hooks?.at?.("committed", id);
    const reconciled = await reconcile(l, journal);
    await cleanup(l, id, journal, leased, "committed", options.hooks);
    await options.hooks?.at?.("cleaned", id);
    return { status: "committed" as const, editId: id, track: reconciled };
  } catch (error) {
    if (id && journal && !(error instanceof MetadataEditInterruption)) {
      await recoverOne(l, id, journal).catch((recovery) =>
        put(l, id!, "recovery-required", journal!, String(recovery)),
      );
      const phase = l.db
        .prepare("SELECT phase FROM metadata_edits WHERE id=?")
        .get(id)?.phase;
      if (phase === "done")
        return {
          status: "reconciled" as const,
          editId: id,
          track: l.tracks(trackId)[0],
        };
    }
    throw error;
  } finally {
    leased?.close();
    if (locked) unlock(l);
    use.release();
  }
}

function originalReceipt(l: Library, j: Journal) {
  const receipt = l.db
    .prepare("SELECT * FROM managed_file_receipts WHERE trackId=?")
    .get(j.trackId);
  if (
    !receipt ||
    receipt.rootId !== j.root.id ||
    receipt.relative !== j.relative ||
    receipt.digest !== j.originalSha256 ||
    receipt.device !== j.original.device ||
    receipt.inode !== j.original.inode
  )
    throw new Error("Original receipt no longer agrees with recovery.");
}
async function recoverOne(l: Library, id: string, j: Journal) {
  const phase = String(
    l.db.prepare("SELECT phase FROM metadata_edits WHERE id=?").get(id)?.phase,
  );
  if (["done", "aborted"].includes(phase)) return;
  if (j.version !== 1) throw new Error("Unsupported metadata journal.");
  checkTrack(l, j);
  await validateMediaRoot(j.root);
  if (!j.record) {
    await bytesAt(j.filename, j.original, j.originalSha256);
    if (
      (await readdir(path.dirname(j.filename))).some((n) =>
        n.startsWith(".rio-publication-"),
      )
    )
      throw new Error(
        "Unrecorded publication artifacts require manual recovery; original retained.",
      );
    originalReceipt(l, j);
    put(l, id, "aborted", j);
    return;
  }
  const record = j.record;
  if (
    record.root !== j.root.path ||
    record.relative !== j.relative ||
    !matches(record.rootIdentity, {
      device: j.root.device,
      inode: j.root.inode,
      type: "directory",
    }) ||
    !matches(record.expected, j.original) ||
    record.originalSha256 !== j.originalSha256 ||
    record.candidateSha256 !== j.candidateSha256
  )
    throw new Error(
      "Publication record does not match the metadata journal boundary.",
    );
  const observed = inspectInterruptedPublication(record);
  if (!("boundaryValid" in observed)) {
    // Cleanup may have completed just before a crash. Finalize only an exact
    // original + original receipt, or committed candidate + SQL + current receipt.
    const parent = path.dirname(j.filename),
      info = await fingerprint(parent);
    if (!matches(info, record.parentIdentity))
      throw new Error("Publication parent changed.");
    try {
      await lstat(path.join(parent, record.workspace));
      throw new Error("Workspace remains but cannot be validated.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const target = await fingerprint(j.filename);
    if (
      phase !== "committed" &&
      phase !== "published" &&
      matches(target, j.original)
    ) {
      await bytesAt(j.filename, j.original, j.originalSha256);
      originalReceipt(l, j);
      put(l, id, "aborted", j);
      return;
    }
    if (phase !== "committed" && phase !== "recovery-required")
      throw new Error("Cannot inspect interrupted publication.");
    await bytesAt(j.filename, record.candidateIdentity, record.candidateSha256);
    await reconcile(l, j);
    put(l, id, "done", j);
    return;
  }
  if (!observed.boundaryValid)
    throw new Error("Publication boundary changed; preserve both artifacts.");
  const before =
    matches(observed.target.identity, record.expected) &&
    observed.target.sha256 === record.originalSha256;
  const after =
    matches(observed.target.identity, record.candidateIdentity) &&
    observed.target.sha256 === record.candidateSha256;
  const resumed = resumePublicationCleanup(
    record,
    after ? "committed" : "abort",
  );
  if (!("lease" in resumed))
    throw new Error(
      `Publication layout is ambiguous: ${resumed.reason ?? resumed.status}`,
    );
  try {
    if (after) {
      if (resumed.lease.syncPublication().status !== "synced")
        throw new Error("Publication recovery durability failed.");
      const original = await bytesAt(
        path.join(path.dirname(j.filename), record.workspace, "rollback"),
        record.rollbackIdentity,
        record.originalSha256,
      );
      const candidate = await bytesAt(
        j.filename,
        record.candidateIdentity,
        record.candidateSha256,
      );
      const metadata = await verifyCandidate(j, original, candidate);
      // Replaying the same exact candidate is idempotent; no rollback of authoritative bytes.
      commit(l, id, j, await fingerprint(j.filename), metadata);
      await reconcile(l, j);
      await cleanup(l, id, j, resumed.lease, "committed");
    } else if (before && phase !== "committed") {
      originalReceipt(l, j);
      await cleanup(l, id, j, resumed.lease, "abort");
    } else
      throw new Error(
        "Publication state is ambiguous; preserve both artifacts.",
      );
  } finally {
    resumed.lease.close();
  }
}
/** Invoked by Library.open before the instance escapes to playback/import callers. */
export async function recoverMetadataEdits(l: Library) {
  const rows = l.db
    .prepare(
      "SELECT id,journal FROM metadata_edits WHERE phase NOT IN ('done','aborted') ORDER BY createdAt,id",
    )
    .all();
  if (!rows.length) return;
  await lock(l);
  try {
    for (const row of rows) {
      try {
        const j = JSON.parse(String(row.journal)) as Journal;
        await recoverOne(l, String(row.id), j);
      } catch (error) {
        l.db
          .prepare(
            "UPDATE metadata_edits SET phase='recovery-required',error=? WHERE id=?",
          )
          .run(String(error), row.id);
      }
    }
  } finally {
    unlock(l);
  }
}
