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
    loader: new MediaSource(audio as unknown as HTMLAudioElement),
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
  expect(audio.loads).toBe(1);
  audio.metadata();
  await Promise.resolve();
  expect(ready).toBe(false);
  audio.ready();
  await one;
  expect(ready).toBe(true);
  expect(loader.ensure("track", audio.src, 0)).toBe(one);
  expect(audio.loads).toBe(1);
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
  audio.error = { code: 4 };
  audio.dispatchEvent(new Event("error"));
  await rejected;
  const retry = loader.ensure("track", audio.src, 0);
  expect(audio.loads).toBe(2);
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
