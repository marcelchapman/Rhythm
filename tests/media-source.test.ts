import { expect, test, vi } from "vitest";
import { MediaSource } from "../src/renderer/media-source";
class Decoder extends EventTarget {
  src = "";
  readyState = 0;
  error: { code: number } | null = null;
  currentTime = 0;
  duration = 30;
  paused = true;
  seeking = false;
  loads = 0;
  pause() {
    this.paused = true;
  }
  load() {
    this.loads++;
    this.readyState = 0;
    this.error = null;
  }
  getAttribute() {
    return this.src || null;
  }
  removeAttribute() {
    this.src = "";
  }
  metadata() {
    this.readyState = 1;
    this.dispatchEvent(new Event("loadedmetadata"));
  }
  ready() {
    this.readyState = 3;
    this.dispatchEvent(new Event("canplay"));
  }
}
const setup = () => {
  const audio = new Decoder();
  return {
    audio,
    loader: new MediaSource(
      audio as unknown as HTMLAudioElement,
      async (url) => ({ url, release: async () => {} }),
    ),
  };
};
test("effect and transport share one pending source, and readiness requires decodable future data", async () => {
  const { audio, loader } = setup();
  let ready = false;
  const one = loader.ensure("track", "rio-media://track/id", 0);
  one.then(() => {
    ready = true;
  });
  const two = loader.ensure("track", "rio-media://track/id", 0);
  expect(two).toBe(one);
  await vi.waitFor(() => expect(audio.loads).toBe(1));
  audio.metadata();
  await Promise.resolve();
  expect(ready).toBe(false);
  audio.ready();
  await one;
  expect(ready).toBe(true);
  expect(loader.ensure("track", audio.src, 0)).toBe(one);
  await vi.waitFor(() => expect(audio.loads).toBe(1));
});
test("forced recovery invalidates the old waiter and cannot resolve from a stale event with no ready decoder", async () => {
  const { audio, loader } = setup();
  const old = loader.ensure("same ID old path", "rio-media://track/id", 0);
  const rejected = expect(old).rejects.toMatchObject({ name: "AbortError" });
  const restored = loader.ensure(
    "same ID new path",
    "rio-media://track/id",
    4,
    true,
  );
  await rejected;
  await vi.waitFor(() => expect(audio.src).toBe("rio-media://track/id"));
  let ready = false;
  restored.then(() => {
    ready = true;
  });
  audio.dispatchEvent(new Event("canplay"));
  await Promise.resolve();
  expect(ready).toBe(false);
  audio.metadata();
  expect(audio.currentTime).toBe(4);
  audio.ready();
  await restored;
  expect(ready).toBe(true);
  expect(audio.loads).toBe(2);
});
test("restored seek position waits for seek completion and canplay", async () => {
  const { audio, loader } = setup();
  let ready = false;
  const restored = loader.ensure("track", "rio-media://track/id", 7);
  restored.then(() => {
    ready = true;
  });
  await vi.waitFor(() => expect(audio.loads).toBe(1));
  audio.seeking = true;
  audio.metadata();
  audio.ready();
  await Promise.resolve();
  expect(ready).toBe(false);
  audio.seeking = false;
  audio.dispatchEvent(new Event("seeked"));
  await restored;
  expect(audio.currentTime).toBe(7);
});
test("genuine decoder error rejects readiness and a later explicit retry reloads", async () => {
  const { audio, loader } = setup();
  const pending = loader.ensure("track", "rio-media://track/id", 0);
  const rejected = expect(pending).rejects.toThrow("code 4");
  await vi.waitFor(() => expect(audio.loads).toBe(1));
  audio.error = { code: 4 };
  audio.dispatchEvent(new Event("error"));
  await rejected;
  const retry = loader.ensure("track", "rio-media://track/id", 0);
  await vi.waitFor(() => expect(audio.src).toBe("rio-media://track/id"));
  audio.metadata();
  audio.ready();
  await retry;
});
test("unavailable/library clear cancels pending preparation and releases the old source", async () => {
  const { audio, loader } = setup();
  const pending = loader.ensure("track", "rio-media://track/id", 0);
  const rejected = expect(pending).rejects.toMatchObject({
    name: "AbortError",
  });
  loader.clear();
  await rejected;
  expect(audio.src).toBe("");
  expect(audio.paused).toBe(true);
  expect(audio.readyState).toBe(0);
});
test("readiness timeout is diagnosable rather than a false success", async () => {
  vi.useFakeTimers();
  try {
    const { loader } = setup();
    const pending = loader.ensure("track", "rio-media://track/id", 0);
    const rejected = expect(pending).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
  } finally {
    vi.useRealTimers();
  }
});

test("acquisition is required before src assignment and denial leaves no decoder source", async () => {
  const audio = new Decoder();
  let grant!: (v: any) => void;
  const loader = new MediaSource(
    audio as unknown as HTMLAudioElement,
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  const pending = loader.ensure("one", "one", 0);
  await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
  expect(audio.src).toBe("");
  let released = 0;
  grant({
    url: "authorized",
    release: async () => {
      released++;
    },
  });
  await vi.waitFor(() => expect(audio.src).toBe("authorized"));
  audio.ready();
  await pending;
  audio.pause();
  expect(released).toBe(0);
  loader.clear();
  await vi.waitFor(() => expect(released).toBe(1));
  expect(audio.src).toBe("");
});
test("cancelled in-flight acquisition can never set src and releases a late grant", async () => {
  const audio = new Decoder();
  let grant!: (v: any) => void,
    released = 0;
  const loader = new MediaSource(
    audio as unknown as HTMLAudioElement,
    () =>
      new Promise((resolve) => {
        grant = resolve;
      }),
  );
  const pending = loader.ensure("one", "one", 0),
    rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(grant).toBeTypeOf("function"));
  loader.clear();
  await rejected;
  grant({
    url: "stale",
    release: async () => {
      released++;
    },
  });
  await vi.waitFor(() => expect(released).toBe(1));
  expect(audio.src).toBe("");
});
test("replacement clears old decoder and awaits release before acquiring the next source", async () => {
  const audio = new Decoder();
  let release!: (value?: unknown) => void;
  const events: string[] = [];
  const loader = new MediaSource(
    audio as unknown as HTMLAudioElement,
    async (url) => {
      events.push(`acquire ${url}`);
      return {
        url,
        release: () => {
          events.push(`release ${url}`);
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        },
      };
    },
  );
  const one = loader.ensure("one", "one", 0);
  await vi.waitFor(() => expect(audio.src).toBe("one"));
  audio.ready();
  await one;
  const two = loader.ensure("two", "two", 0);
  await vi.waitFor(() => expect(release).toBeTypeOf("function"));
  expect(audio.src).toBe("");
  expect(events).toEqual(["acquire one", "release one"]);
  release();
  await vi.waitFor(() => expect(audio.src).toBe("two"));
  audio.ready();
  await two;
  expect(events[2]).toBe("acquire two");
  loader.clear();
  release();
});
test("decoder error after readiness clears source and releases it without pause-based guessing", async () => {
  const audio = new Decoder();
  let released = 0;
  const loader = new MediaSource(
    audio as unknown as HTMLAudioElement,
    async (url) => ({
      url,
      release: async () => {
        released++;
      },
    }),
  );
  const ready = loader.ensure("one", "one", 0);
  await vi.waitFor(() => expect(audio.src).toBe("one"));
  audio.ready();
  await ready;
  audio.error = { code: 3 };
  audio.dispatchEvent(new Event("error"));
  await vi.waitFor(() => expect(released).toBe(1));
  expect(audio.src).toBe("");
});
test("failed release is ambiguous and blocks subsequent acquisitions", async () => {
  const audio = new Decoder();
  const acquire = vi.fn(async (url: string) => ({
    url,
    release: async () => {
      throw Error("release unavailable");
    },
  }));
  const loader = new MediaSource(audio as unknown as HTMLAudioElement, acquire);
  const one = loader.ensure("one", "one", 0);
  await vi.waitFor(() => expect(audio.src).toBe("one"));
  audio.ready();
  await one;
  loader.clear();
  await expect(loader.ensure("two", "two", 0)).rejects.toThrow(
    "release unavailable",
  );
  expect(acquire).toHaveBeenCalledTimes(1);
});

test("synchronous release-channel failure is retained as unknown ownership", async () => {
  const audio = new Decoder();
  const acquire = vi.fn(async (url: string) => ({
    url,
    release: () => {
      throw Error("release channel closed");
    },
  }));
  const loader = new MediaSource(audio as unknown as HTMLAudioElement, acquire);
  const one = loader.ensure("one", "one", 0);
  await vi.waitFor(() => expect(audio.src).toBe("one"));
  audio.ready();
  await one;
  loader.clear();
  await expect(loader.ensure("two", "two", 0)).rejects.toThrow(
    "release channel closed",
  );
  expect(acquire).toHaveBeenCalledTimes(1);
});
