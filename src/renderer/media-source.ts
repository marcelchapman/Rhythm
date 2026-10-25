/** Own one decoder load at a time. React renders and transport requests share readiness. */
export class MediaSource {
  generation = 0;
  private active?: {
    key: string;
    pending: boolean;
    promise: Promise<void>;
    cancel: () => void;
  };
  constructor(private readonly audio: HTMLAudioElement) {}
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
      a.src === url &&
      !a.error &&
      (this.active.pending || (a.readyState >= 3 && !a.seeking))
    )
      return this.active.promise;
    this.cancel();
    const generation = this.generation;
    let cancel!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        for (const event of ["canplay", "seeked"])
          a.removeEventListener(event, ready);
        a.removeEventListener("loadedmetadata", metadata);
        a.removeEventListener("error", failed);
        if (this.active?.promise === promise) this.active.pending = false;
        if (error) reject(error);
        else resolve();
      };
      const ready = () => {
        if (generation === this.generation && a.readyState >= 3 && !a.seeking)
          finish();
      };
      const metadata = () => {
        if (generation !== this.generation) return;
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
        if (a.error)
          finish(new Error(`Media preparation failed (code ${a.error.code}).`));
      };
      cancel = () =>
        finish(new DOMException("Decoder load superseded", "AbortError"));
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
    // Register readiness before changing the source; load() invalidates older play promises.
    a.pause();
    a.src = url;
    a.load();
    return promise;
  }
  cancel() {
    this.generation++;
    this.active?.cancel();
    this.active = undefined;
  }
  clear() {
    this.cancel();
    this.audio.pause();
    this.audio.removeAttribute("src");
    this.audio.load();
  }
}
