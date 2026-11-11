import { MAX_FLAC_FILE_BYTES } from "../shared/flac-limits.js";
/** Production source/transport ownership, independent of saved player references. */
import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import {
  stableSources,
  type StableSourceManager,
  type StableSourceLease,
} from "./stable-source-manager.js";
import type { Library } from "../domain/library.js";
import {
  MetadataUseGate,
  type MetadataUsage,
  type MetadataFileRevision,
} from "../domain/metadata-edit.js";
import { mediaResponse, mediaResponseFromSource } from "./media.js";

type Reader = { cancel?: () => void; done: Promise<void> };
type Source = {
  token: string;
  owner: number;
  library: Library;
  id: string;
  path: string;
  format: string;
  retired: boolean;
  readers: Set<Reader>;
  released?: Promise<void>;
  preparing?: Promise<void>;
  isolated?: StableSourceLease;
  originalUse: boolean;
  managedRevision?: Readonly<MetadataFileRevision>;
};
/** Only this service can authorize file reads; renderer release alone never proves fd closure. */
export class PlaybackUse {
  constructor(
    private readonly stableManager: StableSourceManager = stableSources,
    private readonly concurrentEditing = process.env
      .RIO_STABLE_PLAYBACK_SOURCES === "1" && stableManager.enabledForPlayback,
  ) {}
  private current: Library | null = null;
  private gate = new MetadataUseGate();
  private known = new Set<string>();
  private sources = new Map<string, Source>();
  private owners = new Set<number>();
  private epoch = 0;
  private changing = false;
  private closing = false;
  private edits = new Set<Promise<void>>();
  private editing = new Set<string>();
  private revision(library: Library, id: string) {
    return library.db
      .prepare(
        "SELECT rootId,relative,device,inode,digest FROM managed_file_receipts WHERE trackId=?",
      )
      .get(id) as unknown as MetadataFileRevision | undefined;
  }
  private sameRevision(
    a: Readonly<MetadataFileRevision> | undefined,
    b: Readonly<MetadataFileRevision> | undefined,
  ) {
    return (
      !!a &&
      !!b &&
      ["rootId", "relative", "device", "inode", "digest"].every(
        (k) =>
          a[k as keyof MetadataFileRevision] ===
          b[k as keyof MetadataFileRevision],
      )
    );
  }
  private releaseOriginal(s: Source) {
    if (!s.originalUse) return;
    s.originalUse = false;
    if (
      s.library === this.current &&
      ![...this.sources.values()].some(
        (other) => other.id === s.id && other.originalUse,
      )
    )
      this.gate.setInUse(s.id, false);
  }
  blockNewUse() {
    if (this.changing || this.closing || this.edits.size)
      throw new Error(
        "Finish the current playback/metadata operation before changing libraries.",
      );
    this.changing = true;
    return () => {
      this.changing = false;
    };
  }
  get currentLibrary() {
    return this.current;
  }
  /** Called only after revoking the previous library's sources. Starts a known-empty scope. */
  bindLibrary(library: Library | null) {
    if (this.sources.size || this.edits.size)
      throw new Error(
        "Playback sources must be released before switching libraries.",
      );
    this.current = library;
    this.closing = false;
    this.gate = new MetadataUseGate();
    this.known.clear();
    this.epoch++;
  }
  allowOwner(owner: number) {
    this.owners.add(owner);
  }
  private checkLibrary(library: Library | null) {
    if (
      this.changing ||
      this.closing ||
      !library ||
      library !== this.current ||
      !library.db.isOpen
    )
      throw new Error("Playback ownership is unknown or the library changed.");
    return library;
  }
  private initialize(id: string) {
    const library = this.checkLibrary(this.current);
    if (!library.tracks(id)[0]) throw new Error("Track no longer exists.");
    if (!this.known.has(id)) {
      this.gate.setInUse(id, false);
      this.known.add(id);
    }
  }
  usageFor(library: Library): MetadataUsage {
    const epoch = this.epoch;
    return {
      acquireIdle: (id: string) => {
        this.checkLibrary(library);
        if (epoch !== this.epoch)
          throw new Error("Playback ownership scope changed.");
        this.initialize(id);
        const previous = this.revision(library, id);
        let expectedRevision = previous;
        for (const s of this.sources.values()) {
          if (s.id !== id || s.retired || s.originalUse) continue;
          s.isolated!.assertActive();
          if (!this.sameRevision(s.managedRevision, previous))
            throw Error(
              "Managed playback receipt revision changed outside metadata publication.",
            );
        }
        const lease = this.gate.acquireIdle(id);
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        this.edits.add(done);
        this.editing.add(id);
        let released = false;
        return {
          assertIdle: () => {
            this.checkLibrary(library);
            if (epoch !== this.epoch)
              throw new Error("Playback ownership scope changed.");
            lease.assertIdle();
            if (
              this.concurrentEditing &&
              expectedRevision &&
              !this.sameRevision(expectedRevision, this.revision(library, id))
            )
              throw Error(
                "Managed metadata revision changed during publication authority.",
              );
            for (const s of this.sources.values()) {
              if (s.id === id && !s.retired && !s.originalUse)
                s.isolated!.assertActive();
            }
          },
          committedRevision: this.concurrentEditing
            ? (before, next) => {
                this.checkLibrary(library);
                lease.assertIdle();
                if (
                  epoch !== this.epoch ||
                  !this.sameRevision(before, previous) ||
                  !this.sameRevision(next, this.revision(library, id))
                )
                  throw Error(
                    "Metadata publication revision authority changed.",
                  );
                for (const s of this.sources.values()) {
                  if (s.id !== id || s.retired || s.originalUse) continue;
                  if (
                    !this.sameRevision(s.managedRevision, before) &&
                    !this.sameRevision(s.managedRevision, next)
                  )
                    throw Error("Stable playback revision lineage changed.");
                  s.managedRevision = Object.freeze({ ...next });
                }
                expectedRevision = Object.freeze({ ...next });
              }
            : undefined,
          release: () => {
            if (released) return;
            released = true;
            lease.release();
            this.edits.delete(done);
            this.editing.delete(id);
            finish();
          },
        };
      },
    };
  }
  acquire(owner: number, id: string, directory: string) {
    const library = this.checkLibrary(this.current);
    if (!this.owners.has(owner) || directory !== library.directory)
      throw new Error("Playback renderer/library is not active.");
    this.initialize(id);
    const track = library.media(id);
    if (!track)
      throw new Error(
        "Track is unavailable or has an unfinished metadata edit.",
      );
    // Synchronous with acquireIdle: no decoder or file request can slip through an edit lease.
    this.gate.setInUse(id, true);
    const token = randomUUID();
    this.sources.set(token, {
      token,
      owner,
      library,
      id,
      path: track.path,
      format: track.format,
      retired: false,
      readers: new Set(),
      originalUse: true,
    });
    return { token, url: `rio-media://track/${id}?use=${token}` };
  }
  /** Flagged real-player selection; ineligible kinds/platforms stay on their old path. */
  acquireForPlayback(owner: number, id: string, directory: string) {
    if (!this.stableManager.enabledForPlayback)
      return this.acquire(owner, id, directory);
    const library = this.checkLibrary(this.current),
      track = library.tracks(id)[0];
    // Another track's metadata operation keeps capture serialized. Its existing
    // original-file route remains safe through that track's independent use gate.
    if (
      this.concurrentEditing &&
      library.scanning &&
      this.edits.size &&
      !this.editing.has(id)
    )
      return this.acquire(owner, id, directory);
    if (
      !track ||
      track.locationKind !== "managed" ||
      track.format.toLowerCase() !== "flac" ||
      !track.path.toLowerCase().endsWith(".flac") ||
      (track.fileSize !== null && track.fileSize > MAX_FLAC_FILE_BYTES)
    )
      return this.acquire(owner, id, directory);
    return this.capture(owner, id, directory, true);
  }
  /** Capture reserves original-file use until isolation is fully verified. */
  acquireIsolated(owner: number, id: string, directory: string) {
    return this.capture(owner, id, directory, false);
  }
  private async capture(
    owner: number,
    id: string,
    directory: string,
    select: boolean,
  ) {
    if ([...this.sources.values()].filter((s) => s.preparing).length >= 2)
      throw new Error("Playback source lease budget exhausted.");
    const grant = this.acquire(owner, id, directory);
    const s = this.sources.get(grant.token)!;
    const pending = select
      ? this.stableManager.acquireSelected(s.library, id, () => {
          this.source(grant.token, id, false);
        })
      : this.stableManager.acquire(s.library, id, () => {
          this.source(grant.token, id, false);
        });
    const capture = pending.then((lease) => {
      if (lease) {
        s.isolated = lease;
        if (this.concurrentEditing && !s.retired) {
          lease.assertActive();
          if (!this.sameRevision(lease.revision, this.revision(s.library, id)))
            throw Error(
              "Managed playback revision changed before isolation handoff.",
            );
          s.managedRevision = lease.revision;
          this.releaseOriginal(s);
        }
      } else s.preparing = undefined;
      return lease;
    });
    s.preparing = capture.then(
      () => {},
      () => {},
    );
    try {
      await capture;
      this.source(grant.token, id);
      return grant;
    } catch (error) {
      await this.retire(s);
      throw error;
    }
  }
  private source(token: string, id: string, checkIsolation = true) {
    const s = this.sources.get(token);
    if (
      !s ||
      s.retired ||
      !this.owners.has(s.owner) ||
      s.id !== id ||
      s.library !== this.current ||
      !s.library.db.isOpen
    )
      throw new Error("Playback source was released or is unknown.");
    const current =
      s.isolated && !s.originalUse
        ? s.library.tracks(id)[0]
        : s.library.media(id);
    if (!current || current.path !== s.path || current.format !== s.format)
      throw new Error("Playback location changed.");
    if (!s.originalUse && checkIsolation) s.isolated!.assertActive();
    return s;
  }
  /** Existing verified tokens alone may serve a prior revision during a journal. */
  canServeIsolated(token: string, id: string) {
    try {
      const s = this.source(token, id);
      return !!s.isolated && !s.originalUse;
    } catch {
      return false;
    }
  }
  hasIsolatedPlayback(owner: number, id: string) {
    return [...this.sources.values()].some(
      (s) =>
        s.owner === owner && s.id === id && this.canServeIsolated(s.token, id),
    );
  }
  async respond(token: string, id: string, request: Request) {
    let s: Source;
    try {
      s = this.source(token, id);
      if (s.preparing && !s.isolated)
        throw new Error("Playback source is still being prepared.");
    } catch {
      return new Response(null, { status: 403 });
    }
    let finish!: () => void;
    const done = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const reader: Reader = { done };
    s.readers.add(reader);
    let opened = false;
    try {
      const ownership = {
        assertActive: () => {
          this.source(token, id);
          if (request.signal.aborted) throw new Error("Media request aborted.");
        },
        opened: (stream: Readable) => {
          opened = true;
          reader.cancel = () => stream.destroy();
          stream.once("close", () => {
            s.readers.delete(reader);
            finish();
          });
        },
      };
      return await (s.isolated
        ? mediaResponseFromSource(s.isolated, s.format, request, ownership)
        : mediaResponse(s.path, s.format, request, ownership));
    } catch {
      return new Response(null, { status: 503 });
    } finally {
      if (!opened) {
        s.readers.delete(reader);
        finish();
      }
    }
  }
  private retire(s: Source) {
    if (s.released) return s.released;
    // Revoke authorization before any await, including requests still awaiting stat().
    s.retired = true;
    const readers = [...s.readers];
    for (const reader of readers) reader.cancel?.();
    s.released = Promise.all([...readers.map((r) => r.done), s.preparing]).then(
      async () => {
        await s.isolated?.release();
        this.releaseOriginal(s);
        this.sources.delete(s.token);
      },
    );
    return s.released;
  }
  async release(owner: number, token: string) {
    const s = this.sources.get(token);
    if (!s) return; // Duplicate/stale acknowledgments cannot change another source.
    if (s.owner !== owner)
      throw new Error("Playback source belongs to another renderer.");
    await this.retire(s);
  }
  async revokeOwner(owner: number) {
    this.owners.delete(owner);
    await Promise.all(
      [...this.sources.values()]
        .filter((s) => s.owner === owner)
        .map((s) => this.retire(s)),
    );
  }
  async shutdown() {
    this.closing = true;
    this.owners.clear();
    await this.releaseLibrary();
    // Invalidate idle assertions immediately; let an in-flight coordinator finish
    // its safe failure/reconciliation before the application closes the database.
    await Promise.all([...this.edits]);
    this.bindLibrary(null);
  }
  async releaseLibrary() {
    await Promise.all([...this.sources.values()].map((s) => this.retire(s)));
  }
}
export const playbackUse = new PlaybackUse();
