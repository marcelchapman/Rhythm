/** Production source/transport ownership, independent of saved player references. */
import { randomUUID } from "node:crypto";
import type { ReadStream } from "node:fs";
import type { Library } from "../domain/library.js";
import {
  MetadataUseGate,
  type MetadataUsage,
} from "../domain/metadata-edit.js";
import { mediaResponse } from "./media.js";

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
};
/** Only this service can authorize file reads; renderer release alone never proves fd closure. */
export class PlaybackUse {
  private current: Library | null = null;
  private gate = new MetadataUseGate();
  private known = new Set<string>();
  private sources = new Map<string, Source>();
  private owners = new Set<number>();
  private epoch = 0;
  private changing = false;
  private closing = false;
  private edits = new Set<Promise<void>>();
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
        const lease = this.gate.acquireIdle(id);
        let finish!: () => void;
        const done = new Promise<void>((resolve) => {
          finish = resolve;
        });
        this.edits.add(done);
        let released = false;
        return {
          assertIdle: () => {
            this.checkLibrary(library);
            if (epoch !== this.epoch)
              throw new Error("Playback ownership scope changed.");
            lease.assertIdle();
          },
          release: () => {
            if (released) return;
            released = true;
            lease.release();
            this.edits.delete(done);
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
    });
    return { token, url: `rio-media://track/${id}?use=${token}` };
  }
  private source(token: string, id: string) {
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
    const current = s.library.media(id);
    if (!current || current.path !== s.path || current.format !== s.format)
      throw new Error("Playback location changed.");
    return s;
  }
  async respond(token: string, id: string, request: Request) {
    let s: Source;
    try {
      s = this.source(token, id);
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
      return await mediaResponse(s.path, s.format, request, {
        assertActive: () => {
          this.source(token, id);
          if (request.signal.aborted) throw new Error("Media request aborted.");
        },
        opened: (stream: ReadStream) => {
          opened = true;
          reader.cancel = () => stream.destroy();
          stream.once("close", () => {
            s.readers.delete(reader);
            finish();
          });
        },
      });
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
    s.released = Promise.all(readers.map((r) => r.done)).then(() => {
      this.sources.delete(s.token);
      if (
        s.library === this.current &&
        ![...this.sources.values()].some(
          (other) => other.id === s.id && other.library === s.library,
        )
      )
        this.gate.setInUse(s.id, false);
    });
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
