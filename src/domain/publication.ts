/** Isolated native publication capabilities. Never imported by UI, IPC or Library. */
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

export interface PublicationIdentity {
  device: string;
  inode: string;
  type: "file" | "directory" | "symlink" | "other";
}
export interface PublicationFingerprint extends PublicationIdentity {
  size: string;
  links: string;
  mode: string;
  uid: string;
  gid: string;
  mtimeNs: string;
  ctimeNs: string;
}
export interface PublicationTarget {
  root: string;
  rootIdentity: PublicationIdentity;
  relative: string;
}
export interface PublicationRecord extends PublicationTarget {
  version: 1;
  workspace: string;
  parentIdentity: PublicationIdentity;
  workspaceIdentity: PublicationIdentity;
  expected: PublicationFingerprint;
  originalSha256: string;
  candidateSha256: string;
  candidateIdentity: PublicationFingerprint;
  rollbackIdentity: PublicationFingerprint;
}
export interface PublicationEntry {
  identity?: PublicationFingerprint;
  sha256?: string;
  error?: string;
}
export interface PublicationInspection {
  boundaryValid: boolean;
  boundaryError?: string;
  target: PublicationEntry;
  slot: PublicationEntry;
  rollback: PublicationEntry;
}
export type PublicationStatus =
  | "unsupported"
  | "no-change"
  | "exchanged-expected"
  | "exchanged-conflict"
  | "recovery-required"
  | "synced"
  | "sync-failed"
  | "cleaned"
  | "cleanup-incomplete"
  | "cleanup-refused";
export interface PublicationResult {
  status: PublicationStatus;
  reason?: string;
  inspection?: PublicationInspection;
  barrier?: "fullfsync" | "fsync";
  /** Diagnostic only. Never authority for recursive cleanup or automatic adoption. */
  retainedWorkspace?: {
    root: string;
    relative: string;
    workspace: string;
    identity: PublicationIdentity;
  };
}
interface NativeEntry extends PublicationEntry {
  data?: Uint8Array;
}
interface NativeInspection {
  boundaryValid: boolean;
  boundaryError?: string;
  target: NativeEntry;
  slot: NativeEntry;
  rollback: NativeEntry;
  workspaceIdentity: PublicationFingerprint;
  workspace?: string;
  parentIdentity?: PublicationFingerprint;
}
/** Internal test seam; the packaged binding has no interleave/failure hooks. */
export interface NativePublicationBinding {
  open(config: PublicationTarget & { expected: PublicationFingerprint }): {
    handle: object;
    original: Uint8Array;
  };
  prepare(
    handle: object,
    workspace: string,
    candidate: Buffer,
  ): NativeInspection;
  probe(
    target: PublicationTarget,
    workspace: string,
  ): {
    status: "supported";
    filesystem: string;
    barrier: "fullfsync" | "fsync";
  };
  inspect(handle: object): NativeInspection;
  reopen(record: PublicationRecord): object;
  reopenCleanup(
    record: PublicationRecord,
    disposition: "abort" | "committed",
  ): object;
  exchange(
    handle: object,
  ): PublicationResult & { inspection?: NativeInspection };
  sync(handle: object): PublicationResult;
  cleanup(
    handle: object,
    proof: Record<string, PublicationFingerprint>,
    disposition: "abort" | "committed",
  ): PublicationResult;
  close(handle: object): unknown;
}
const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (a: PublicationIdentity | undefined, b: PublicationIdentity) =>
  !!a && a.device === b.device && a.inode === b.inode && a.type === b.type;
function inspection(raw: NativeInspection): PublicationInspection {
  const entry = ({ identity, data, error }: NativeEntry): PublicationEntry => ({
    ...(identity ? { identity: { ...identity } } : {}),
    ...(data ? { sha256: sha(data) } : {}),
    ...(error ? { error } : {}),
  });
  return {
    boundaryValid: raw.boundaryValid,
    ...(raw.boundaryError ? { boundaryError: raw.boundaryError } : {}),
    target: entry(raw.target),
    slot: entry(raw.slot),
    rollback: entry(raw.rollback),
  };
}
function failure(error: unknown): PublicationResult {
  const e = error as { code?: string; errno?: string; message?: string };
  return {
    status: e.code === "unsupported" ? "unsupported" : "no-change",
    reason: e.message ?? String(error),
  };
}
function snapshot<T>(value: T): T {
  return structuredClone(value);
}

export class PublicationLease {
  #closed = false;
  #exchanged = false;
  readonly #binding: NativePublicationBinding;
  readonly #handle: object;
  readonly #record: PublicationRecord;
  /** Construction is internal; callers obtain leases through openPublicationLease. */
  constructor(
    binding: NativePublicationBinding,
    handle: object,
    record: PublicationRecord,
    exchanged = false,
  ) {
    this.#exchanged = exchanged;
    this.#binding = binding;
    this.#handle = handle;
    this.#record = snapshot(record);
  }
  get record(): PublicationRecord {
    return snapshot(this.#record);
  }
  #check() {
    if (this.#closed) throw Error("Publication lease is closed.");
  }
  inspectPublication(): PublicationInspection {
    this.#check();
    return inspection(this.#binding.inspect(this.#handle));
  }
  exchangeAndObserve(): PublicationResult {
    this.#check();
    // Independent byte verification immediately before the native precheck/exchange.
    const before = this.inspectPublication(),
      r = this.#record;
    if (
      !before.boundaryValid ||
      !identity(before.target.identity, r.expected) ||
      before.target.sha256 !== r.originalSha256 ||
      !identity(before.slot.identity, r.candidateIdentity) ||
      before.slot.sha256 !== r.candidateSha256 ||
      !identity(before.rollback.identity, r.rollbackIdentity) ||
      before.rollback.sha256 !== r.originalSha256
    )
      return {
        status: "no-change",
        reason: "Publication evidence changed before exchange.",
        inspection: before,
      };
    let raw: ReturnType<NativePublicationBinding["exchange"]>;
    try {
      raw = this.#binding.exchange(this.#handle);
    } catch (error) {
      // A binding failure after entry can never be classified as 'nothing changed'.
      return { status: "recovery-required", reason: String(error) };
    }
    this.#exchanged ||= [
      "exchanged-expected",
      "exchanged-conflict",
      "recovery-required",
    ].includes(raw.status);
    const observed = raw.inspection ? inspection(raw.inspection) : undefined;
    if (
      raw.status === "exchanged-expected" &&
      (!observed?.boundaryValid ||
        observed.slot.sha256 !== r.originalSha256 ||
        observed.target.sha256 !== r.candidateSha256 ||
        observed.rollback.sha256 !== r.originalSha256)
    )
      return {
        status: "exchanged-conflict",
        reason: "Post-exchange digest verification failed.",
        inspection: observed,
      };
    return { ...raw, ...(observed ? { inspection: observed } : {}) };
  }
  syncPublication(): PublicationResult {
    this.#check();
    return this.#binding.sync(this.#handle);
  }
  cleanupVerifiedArtifacts(
    disposition: "abort" | "committed",
  ): PublicationResult {
    this.#check();
    const observed = this.inspectPublication(),
      r = this.#record;
    const committed = disposition === "committed";
    if (
      !observed.boundaryValid ||
      (committed && !this.#exchanged) ||
      !identity(
        observed.target.identity,
        committed ? r.candidateIdentity : r.expected,
      ) ||
      observed.target.sha256 !==
        (committed ? r.candidateSha256 : r.originalSha256) ||
      !identity(
        observed.slot.identity,
        committed ? r.expected : r.candidateIdentity,
      ) ||
      observed.slot.sha256 !==
        (committed ? r.originalSha256 : r.candidateSha256) ||
      !identity(observed.rollback.identity, r.rollbackIdentity) ||
      observed.rollback.sha256 !== r.originalSha256
    )
      return {
        status: "cleanup-refused",
        reason:
          "Cleanup requires exact owned identities, verified bytes and the requested layout.",
        inspection: observed,
      };
    return this.#binding.cleanup(
      this.#handle,
      {
        target: observed.target.identity!,
        slot: observed.slot.identity!,
        rollback: observed.rollback.identity!,
      },
      disposition,
    );
  }
  close() {
    if (!this.#closed) {
      this.#binding.close(this.#handle);
      this.#closed = true;
    }
  }
}

export function createPublicationAdapter(binding: NativePublicationBinding) {
  return {
    probePublicationSupport(target: PublicationTarget) {
      try {
        return binding.probe(
          snapshot(target),
          `.rio-publication-${randomUUID()}`,
        );
      } catch (error) {
        return failure(error);
      }
    },
    openPublicationLease(
      options: PublicationTarget & {
        expected: PublicationFingerprint;
        originalSha256: string;
        candidate: Uint8Array;
      },
    ): { status: "ready"; lease: PublicationLease } | PublicationResult {
      let handle: object | undefined;
      try {
        if (
          !(options.candidate instanceof Uint8Array) ||
          options.candidate.byteLength > 64 * 1024 * 1024 ||
          !/^[a-f0-9]{64}$/.test(options.originalSha256)
        )
          throw Error(
            "Supply bounded candidate bytes and an independently verified original SHA-256.",
          );
        const candidate = Buffer.from(options.candidate),
          target = snapshot({
            root: options.root,
            rootIdentity: options.rootIdentity,
            relative: options.relative,
          });
        const expected = snapshot(options.expected),
          opened = binding.open({ ...target, expected });
        handle = opened.handle;
        if (sha(opened.original) !== options.originalSha256)
          throw Error("Opened target does not match the supplied digest.");
        const prepared = binding.prepare(
            handle,
            `.rio-publication-${randomUUID()}`,
            candidate,
          ),
          observed = inspection(prepared);
        if (
          !observed.boundaryValid ||
          observed.slot.sha256 !== sha(candidate) ||
          observed.rollback.sha256 !== options.originalSha256
        )
          throw Error("Prepared artifact verification failed.");
        const record: PublicationRecord = {
          ...target,
          version: 1,
          workspace: prepared.workspace!,
          parentIdentity: prepared.parentIdentity!,
          workspaceIdentity: prepared.workspaceIdentity,
          expected,
          originalSha256: options.originalSha256,
          candidateSha256: sha(candidate),
          candidateIdentity: observed.slot.identity!,
          rollbackIdentity: observed.rollback.identity!,
        };
        return {
          status: "ready",
          lease: new PublicationLease(binding, handle, record),
        };
      } catch (error) {
        const result = failure(error);
        if (handle) {
          try {
            const state = binding.inspect(handle);
            if (state.workspace)
              result.retainedWorkspace = {
                root: options.root,
                relative: options.relative,
                workspace: state.workspace,
                identity: state.workspaceIdentity,
              };
          } catch {
            /* Never guess ownership if even inspection fails. */
          }
          binding.close(handle);
        }
        return result;
      }
    },
    resumePublicationCleanup(
      record: PublicationRecord,
      disposition: "abort" | "committed",
    ): { status: "ready"; lease: PublicationLease } | PublicationResult {
      let handle: object | undefined;
      try {
        if (record.version !== 1)
          throw Error("Unsupported publication record.");
        handle = binding.reopenCleanup(snapshot(record), disposition);
        const lease = new PublicationLease(
          binding,
          handle,
          record,
          disposition === "committed",
        );
        const observed = lease.inspectPublication();
        const committed = disposition === "committed";
        if (
          !observed.boundaryValid ||
          !identity(
            observed.target.identity,
            committed ? record.candidateIdentity : record.expected,
          ) ||
          observed.target.sha256 !==
            (committed ? record.candidateSha256 : record.originalSha256) ||
          !identity(
            observed.slot.identity,
            committed ? record.expected : record.candidateIdentity,
          ) ||
          observed.slot.sha256 !==
            (committed ? record.originalSha256 : record.candidateSha256) ||
          !identity(observed.rollback.identity, record.rollbackIdentity) ||
          observed.rollback.sha256 !== record.originalSha256
        )
          throw Error(
            "Recovery cleanup requires exact recorded identities and bytes.",
          );
        return { status: "ready", lease };
      } catch (error) {
        if (handle) binding.close(handle);
        return failure(error);
      }
    },
    inspectInterruptedPublication(
      record: PublicationRecord,
    ): PublicationInspection | PublicationResult {
      let handle: object | undefined;
      try {
        if (record.version !== 1)
          throw Error("Unsupported publication record.");
        handle = binding.reopen(snapshot(record));
        return inspection(binding.inspect(handle));
      } catch (error) {
        return failure(error);
      } finally {
        if (handle) binding.close(handle);
      }
    },
  };
}
let adapter: ReturnType<typeof createPublicationAdapter> | undefined;
function current() {
  if (!adapter) {
    if (!["darwin", "linux"].includes(process.platform))
      throw Error("Native publication is unsupported on this platform.");
    const source = fileURLToPath(import.meta.url).endsWith(".ts");
    const filename = new URL(
      source
        ? "../../dist/native/publication.node"
        : "../native/publication.node",
      import.meta.url,
    );
    adapter = createPublicationAdapter(
      createRequire(import.meta.url)(
        fileURLToPath(filename),
      ) as NativePublicationBinding,
    );
  }
  return adapter;
}
export function probePublicationSupport(target: PublicationTarget) {
  try {
    return current().probePublicationSupport(target);
  } catch (error) {
    return { ...failure(error), status: "unsupported" as const };
  }
}
export function openPublicationLease(
  options: Parameters<
    ReturnType<typeof createPublicationAdapter>["openPublicationLease"]
  >[0],
) {
  try {
    return current().openPublicationLease(options);
  } catch (error) {
    return { ...failure(error), status: "unsupported" as const };
  }
}
export function inspectInterruptedPublication(record: PublicationRecord) {
  try {
    return current().inspectInterruptedPublication(record);
  } catch (error) {
    return { ...failure(error), status: "unsupported" as const };
  }
}

export function resumePublicationCleanup(
  record: PublicationRecord,
  disposition: "abort" | "committed",
) {
  try {
    return current().resumePublicationCleanup(record, disposition);
  } catch (error) {
    return { ...failure(error), status: "unsupported" as const };
  }
}
