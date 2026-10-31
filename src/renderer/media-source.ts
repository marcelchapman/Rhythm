export interface DecoderSource {
  url: string;
  release(): Promise<void>;
}
/** Own one authorized decoder source; pause and saved player references are not release. */
export class MediaSource {
  generation = 0;
  private releasing: Promise<void> = Promise.resolve();
  private releaseError?: unknown;
  private active?: {
    key: string;
    pending: boolean;
    promise: Promise<void>;
    cancel(): void;
    lease?: DecoderSource;
  };
  constructor(
    private readonly audio: HTMLAudioElement,
    private readonly acquire: (url: string) => Promise<DecoderSource>,
  ) {}
  private retire(lease: DecoderSource) {
    // Preserve uncertainty on IPC failure; do not guess that the main process released it.
    this.releasing = Promise.all([
      this.releasing,
      Promise.resolve().then(() => lease.release()),
    ])
      .then(() => {})
      .catch((error) => {
        this.releaseError = error;
      });
  }
  ensure(
    key: string,
    url: string,
    position: number,
    force = false,
  ): Promise<void> {
    const a = this.audio;
    if (
      !force &&
      this.active?.key === key &&
      (this.active.pending ||
        (this.active.lease?.url === a.src &&
          !a.error &&
          a.readyState >= 3 &&
          !a.seeking))
    )
      return this.active.promise;
    this.clear();
    const generation = this.generation;
    let cancel!: () => void;
    let fail!: (error: unknown) => void;
    let lease: DecoderSource | undefined;
    let detach!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        for (const event of ["canplay", "seeked"])
          a.removeEventListener(event, ready);
        a.removeEventListener("loadedmetadata", metadata);
        if (this.active?.promise === promise) this.active.pending = false;
        if (error) {
          detach();
          reject(error);
        } else resolve();
      };
      fail = finish;
      const ready = () => {
        if (
          generation === this.generation &&
          lease &&
          a.src === lease.url &&
          a.readyState >= 3 &&
          !a.seeking
        )
          finish();
      };
      const metadata = () => {
        if (generation !== this.generation || !lease || a.src !== lease.url)
          return;
        if (position > 0)
          a.currentTime = Math.min(
            position,
            Number.isFinite(a.duration)
              ? Math.max(0, a.duration - 0.05)
              : position,
          );
        ready();
      };
      const failed = () => {
        if (!a.error) return;
        finish(new Error(`Media preparation failed (code ${a.error.code}).`));
        // A decoder can also fail after canplay resolved. Release the same source,
        // without changing generation, so the owning error handler can report it.
        detach();
      };
      detach = () => {
        a.removeEventListener("error", failed);
        if (this.active?.promise !== promise) return;
        this.active = undefined;
        a.pause();
        a.removeAttribute("src");
        a.load();
        if (lease) {
          this.retire(lease);
          lease = undefined;
        }
      };
      cancel = () => {
        finish(new DOMException("Decoder load superseded", "AbortError"));
        detach();
      };
      const timeout = setTimeout(
        () => finish(new Error("Audio preparation timed out.")),
        30000,
      );
      a.addEventListener("loadedmetadata", metadata);
      a.addEventListener("canplay", ready);
      a.addEventListener("seeked", ready);
      a.addEventListener("error", failed);
    });
    this.active = { key, pending: true, promise, cancel };
    void (async () => {
      await this.releasing;
      if (this.releaseError) throw this.releaseError;
      if (generation !== this.generation || this.active?.promise !== promise)
        return;
      const acquired = await this.acquire(url);
      if (generation !== this.generation || this.active?.promise !== promise) {
        this.retire(acquired);
        return;
      }
      lease = acquired;
      this.active.lease = acquired;
      a.pause();
      a.src = acquired.url;
      a.load();
    })().catch((error) => {
      fail(error);
    });
    return promise;
  }
  clear() {
    this.generation++;
    this.active?.cancel();
    this.active = undefined;
    if (this.audio.getAttribute("src")) {
      this.audio.pause();
      this.audio.removeAttribute("src");
      this.audio.load();
    }
  }
}
