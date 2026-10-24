import path from "node:path";
export const isPlaylistFile = (filename: string) => /\.m3u8?$/i.test(filename);
/** Queue early OS events until the library and renderer are ready; dedupe delivery bursts. */
export class PlaylistOpenInbox {
  private pending = new Set<string>();
  private processing: string | null = null;
  private recent = new Map<string, number>();
  private draining = false;
  constructor(private readonly now: () => number = Date.now) {}
  get size() {
    return this.pending.size;
  }
  add(filename: string) {
    if (!path.isAbsolute(filename) || !isPlaylistFile(filename)) return false;
    const key = path.normalize(filename);
    for (const [file, time] of this.recent)
      if (this.now() - time >= 2000) this.recent.delete(file);
    if (
      this.pending.has(key) ||
      this.processing === key ||
      this.recent.has(key) ||
      this.pending.size >= 1000
    )
      return false;
    this.pending.add(key);
    return true;
  }
  async drain(
    ready: () => boolean,
    consume: (filename: string) => Promise<void>,
  ) {
    if (this.draining) return;
    this.draining = true;
    try {
      while (ready() && this.pending.size) {
        const file = this.pending.values().next().value!;
        this.pending.delete(file);
        this.processing = file;
        try {
          await consume(file);
        } finally {
          this.recent.set(file, this.now());
          this.processing = null;
        }
      }
    } finally {
      this.draining = false;
    }
  }
}
