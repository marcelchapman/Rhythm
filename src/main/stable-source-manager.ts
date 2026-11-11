import {
  MAX_FLAC_FILE_BYTES,
  FLAC_SIZE_MESSAGE,
} from "../shared/flac-limits.js";
/** Main-owned experimental source infrastructure; selection remains in main. */
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import path from "node:path";
import type { Library } from "../domain/library.js";
import type { MediaRoot } from "../domain/managed-copy.js";
import { pendingMetadataEdits } from "../domain/metadata-edit-schema.js";
import type { MediaReader } from "./media.js";
import type { MetadataFileRevision } from "../domain/metadata-edit.js";

const MAX_FILE = MAX_FLAC_FILE_BYTES;
/** Internal worker seam for deterministic I/O/failure lifecycle qualification. */
export interface SnapshotBackend {
  assertAvailable?(): void;
  capture(): Promise<{ size: number; cloneMs: number } | { unsupported: true }>;
  check(): Promise<number>;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}
export interface SnapshotConfig {
  database: string;
  id: string;
  filename: string;
  relative: string;
  root: MediaRoot;
  receipt: { device: string; inode: string; digest: string };
  workspace: string;
  select?: boolean;
}
class SourceWorker implements SnapshotBackend {
  private worker: Worker;
  private serial = 0;
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (error: Error) => void }
  >();
  private exit: Promise<void>;
  private failed?: Error;
  private closing?: Promise<void>;
  constructor(config: SnapshotConfig) {
    this.worker = new Worker(
      new URL(
        import.meta.url.endsWith(".ts")
          ? "../../dist/main/stable-source-worker.js"
          : "./stable-source-worker.js",
        import.meta.url,
      ),
      {
        workerData: config,
        execArgv: [],
        resourceLimits: {
          maxOldGenerationSizeMb: 96,
          maxYoungGenerationSizeMb: 16,
        },
      },
    );
    this.exit = new Promise((resolve) =>
      this.worker.once("exit", () => {
        this.fail(Error("Playback source worker exited."));
        resolve();
      }),
    );
    this.worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : Error(String(error))),
    );
    this.worker.on("message", (reply) => {
      const p = this.pending.get(reply.id);
      if (!p) return;
      this.pending.delete(reply.id);
      reply.ok
        ? p.resolve(reply.value)
        : p.reject(Object.assign(Error(reply.error), { code: reply.code }));
    });
  }
  private fail(error: Error) {
    this.failed = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
  }
  private request(method: string, extra: object = {}) {
    if (this.failed) return Promise.reject(this.failed);
    if (method !== "close" && this.pending.size >= 16)
      return Promise.reject(Error("Playback source request budget exhausted."));
    return new Promise<any>((resolve, reject) => {
      const id = ++this.serial;
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, method, ...extra });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  capture() {
    return this.request("capture");
  }
  assertAvailable() {
    if (this.failed || this.closing)
      throw this.failed ?? Error("Playback source worker is closing.");
  }
  check() {
    return this.request("check");
  }
  read(offset: number, length: number) {
    return this.request("read", { offset, length });
  }
  close() {
    return (this.closing ??= this.finish());
  }
  private async finish() {
    try {
      if (!this.failed) await this.request("close");
    } finally {
      await this.exit;
    }
  }
}
export interface StableSourceLease extends MediaReader {
  readonly revision: Readonly<MetadataFileRevision>;
  assertActive(): void;
  readonly metrics: { size: number; cloneMs: number; acquisitionMs: number };
  release(): Promise<void>;
}
type Entry = {
  backend: SnapshotBackend;
  streams: Set<Readable>;
  drains: Set<Promise<void>>;
  retired: boolean;
  release?: Promise<void>;
  ready: Promise<void>;
};
export class StableSourceManager {
  private entries = new Set<Entry>();
  private closing = false;
  private enabled: boolean;
  private factory: (config: SnapshotConfig) => SnapshotBackend;
  constructor(
    options: {
      enabled?: boolean;
      backend?: (config: SnapshotConfig) => SnapshotBackend;
    } = {},
  ) {
    this.enabled =
      options.enabled ?? process.env.RIO_STABLE_PLAYBACK_SOURCES === "1";
    this.factory =
      options.backend ??
      ((config) => {
        if (process.platform !== "darwin")
          throw Error("Playback clones require supported local APFS.");
        return new SourceWorker(config);
      });
  }
  get enabledForPlayback() {
    return this.enabled && process.platform === "darwin";
  }
  get activeSources() {
    return this.entries.size;
  }
  /** No waiting queue: each slot reserves the full 128 MiB worst case, including capture. */
  async acquire(
    library: Library,
    id: string,
    assertSession: () => void,
  ): Promise<StableSourceLease> {
    const lease = await this.prepare(library, id, assertSession, false);
    if (!lease) throw Error("Unsupported isolated playback source.");
    return lease;
  }
  acquireSelected(
    library: Library,
    id: string,
    assertSession: () => void,
  ): Promise<StableSourceLease | null> {
    return this.prepare(library, id, assertSession, true);
  }
  private async prepare(
    library: Library,
    id: string,
    assertSession: () => void,
    select: boolean,
  ): Promise<StableSourceLease | null> {
    if (!this.enabled) throw Error("Stable playback sources are disabled.");
    if (this.closing || this.entries.size >= 2)
      throw Error("Playback source budget is unavailable.");
    assertSession();
    const track = library.tracks(id)[0],
      settings = library.mediaSettings();
    if (
      library.scanning ||
      settings.pendingImports ||
      pendingMetadataEdits(library.db)
    )
      throw Error("Wait for the current library operation.");
    if (
      !track ||
      track.missing ||
      track.locationKind !== "managed" ||
      track.format.toLowerCase() !== "flac" ||
      path.extname(track.path).toLowerCase() !== ".flac" ||
      !track.mediaRelativePath ||
      !library.media(id)
    )
      throw Error("An available managed FLAC is required.");
    if (
      track.fileSize !== null &&
      (track.fileSize <= 0 || track.fileSize > MAX_FILE)
    )
      throw Error(FLAC_SIZE_MESSAGE);
    const root = library.db
      .prepare(
        "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
      )
      .get(track.mediaRootId!) as unknown as MediaRoot | undefined;
    const receipt = library.db
      .prepare(
        "SELECT rootId,relative,device,inode,digest FROM managed_file_receipts WHERE trackId=?",
      )
      .get(id);
    if (
      !root ||
      root.id !== settings.root?.id ||
      !receipt ||
      receipt.rootId !== root.id ||
      receipt.relative !== track.mediaRelativePath
    )
      throw Error("Managed playback receipt/root changed.");
    const config: SnapshotConfig = {
      database: path.join(library.directory, "rio.sqlite"),
      id,
      filename: track.path,
      relative: track.mediaRelativePath,
      root,
      receipt: {
        device: String(receipt.device),
        inode: String(receipt.inode),
        digest: String(receipt.digest),
      },
      workspace: ".rio-playback-" + randomUUID(),
      select,
    };
    const backend = this.factory(config),
      started = performance.now();
    let finish!: () => void;
    const entry: Entry = {
      backend,
      streams: new Set(),
      drains: new Set(),
      retired: false,
      ready: new Promise((resolve) => (finish = resolve)),
    };
    this.entries.add(entry);
    library.scanning = true;
    const active = () => {
      if (this.closing || entry.retired || !library.db.isOpen)
        throw Error("Playback source authority was revoked.");
      backend.assertAvailable?.();
      assertSession();
      const current = library.tracks(id)[0],
        currentRoot = library.mediaSettings().root,
        rootIdentity = library.db
          .prepare(
            "SELECT device,inode FROM media_root_locations WHERE rootId=?",
          )
          .get(root.id);
      if (
        !current ||
        current.locationKind !== "managed" ||
        current.mediaRootId !== root.id ||
        current.mediaRelativePath !== track.mediaRelativePath ||
        current.path !== track.path ||
        current.format !== track.format ||
        currentRoot?.id !== root.id ||
        currentRoot.path !== root.path ||
        rootIdentity?.device !== root.device ||
        rootIdentity.inode !== root.inode
      )
        throw Error("Managed playback authority changed.");
    };
    try {
      const info = await backend.capture();
      active();
      if ("unsupported" in info) {
        if (!select) throw Error("Unsupported isolated playback source.");
        finish();
        await this.retire(entry);
        return null;
      }
      const latestReceipt = library.db
        .prepare(
          "SELECT rootId,relative,device,inode,digest FROM managed_file_receipts WHERE trackId=?",
        )
        .get(id);
      const latestRoot = library.db
        .prepare(
          "SELECT path,device,inode FROM media_root_locations WHERE rootId=?",
        )
        .get(root.id);
      if (
        !latestReceipt ||
        latestReceipt.rootId !== root.id ||
        latestReceipt.relative !== config.relative ||
        latestReceipt.device !== config.receipt.device ||
        latestReceipt.inode !== config.receipt.inode ||
        latestReceipt.digest !== config.receipt.digest ||
        !latestRoot ||
        latestRoot.path !== root.path ||
        latestRoot.device !== root.device ||
        latestRoot.inode !== root.inode
      )
        throw Error("Managed playback receipt/root changed during capture.");
      if (info.size <= 0 || info.size > MAX_FILE)
        throw Error("Invalid playback source size.");
      const manager = this;
      return {
        revision: Object.freeze({
          rootId: root.id,
          relative: config.relative,
          ...config.receipt,
        }),
        assertActive: active,
        metrics: { ...info, acquisitionMs: performance.now() - started },
        async size() {
          try {
            active();
            const size = await backend.check();
            active();
            if (size !== info.size)
              throw Error("Playback snapshot size changed.");
            return size;
          } catch (error) {
            void manager.retire(entry);
            throw error;
          }
        },
        stream(start, end) {
          active();
          if (entry.streams.size >= 8)
            throw Error("Playback reader budget exhausted.");
          const stream = Readable.from(
            (async function* () {
              for (let at = start; at <= end;) {
                let bytes: Uint8Array;
                try {
                  active();
                  const length = Math.min(256 * 1024, end - at + 1);
                  bytes = await backend.read(at, length);
                  active();
                  if (bytes.length !== length)
                    throw Error("Short playback snapshot read.");
                  at += length;
                } catch (error) {
                  void manager.retire(entry);
                  throw error;
                }
                // Chromium cancels range bodies when seeking or probing a file.
                // Cancellation injected at yield retires only this reader. Real
                // I/O/authority failures above still retire the shared source.
                yield bytes;
              }
            })(),
            { objectMode: false, highWaterMark: 256 * 1024 },
          );
          entry.streams.add(stream);
          const done = new Promise<void>((resolve) =>
            stream.once("close", () => {
              entry.streams.delete(stream);
              entry.drains.delete(done);
              resolve();
            }),
          );
          entry.drains.add(done);
          return stream;
        },
        release: () => manager.retire(entry),
      };
    } catch (error) {
      finish();
      await this.retire(entry);
      throw error;
    } finally {
      library.scanning = false;
      finish();
    }
  }
  private retire(entry: Entry) {
    if (entry.release) return entry.release;
    entry.retired = true;
    for (const stream of entry.streams) stream.destroy();
    entry.release = (async () => {
      await entry.ready;
      await Promise.all([...entry.drains]);
      try {
        await entry.backend.close();
      } finally {
        this.entries.delete(entry);
      }
    })();
    // Background error cleanup must not create an unhandled rejection. Explicit
    // release still receives the original failure and cannot clear the use gate.
    void entry.release.catch(() => {});
    return entry.release;
  }
  async shutdown() {
    this.closing = true;
    await Promise.all([...this.entries].map((e) => this.retire(e)));
  }
}
export const stableSources = new StableSourceManager();
