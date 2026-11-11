// Measure real keyboard/pointer interactions while the production Save is held.
// Browser timestamps exclude Playwright's polling/transport from event latency.
import assert from "node:assert/strict";
import { expect } from "playwright/test";
import path from "node:path";
import { parseFile } from "music-metadata";

export async function heldInlineInteraction({
  page,
  app,
  track,
  other,
  key,
  label,
  packaged,
}) {
  const cell = (id, column) =>
    page.locator(
      `.song-row[data-track-id="${id}"] [data-cell-column="${column}"]`,
    );
  const input = page.locator(".inline-metadata-input");
  await cell(track.id, "genre").dblclick();
  await expect(input).not.toHaveAttribute("readonly", "");
  await input.fill(label);
  await app.evaluate(() => {
    globalThis.inlineHoldWorker = true;
    globalThis.inlineReleaseWorker = undefined;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Performance.enable");
  const metrics = async () =>
    Object.fromEntries(
      (await cdp.send("Performance.getMetrics")).metrics.map((m) => [
        m.name,
        m.value,
      ]),
    );
  const before = await metrics();
  await page.evaluate(
    ({ key, other }) => {
      const result = (window.inlineInteraction = {
        visibleSaving: false,
        longTasks: [],
      });
      let started, pointerAt, arrowAt, playAt;
      const field = document.querySelector(".inline-metadata-input");
      const elapsed = () => performance.now() - started;
      const selected = () =>
        document
          .querySelector(`.song-row[data-track-id="${other}"]`)
          ?.getAttribute("aria-selected") === "true";
      const sample = () => {
        if (started === undefined) return;
        if (!field.isConnected && result.inputRemovedMs === undefined)
          result.inputRemovedMs = elapsed();
        if (
          selected() &&
          pointerAt !== undefined &&
          result.selectionMs === undefined
        ) {
          result.selectionMs = performance.now() - pointerAt;
          result.keyToSelectionMs = elapsed();
        }
        if (
          selected() &&
          arrowAt !== undefined &&
          result.navigationMs === undefined
        ) {
          result.navigationMs = performance.now() - arrowAt;
          result.keyToNavigationMs = elapsed();
        }
        // A clipped live region remains accessible, but no visible routine label
        // or cell marker may appear, even transiently on the first Save.
        if (
          document.querySelector(".inline-metadata-marker") ||
          /Saving(?:…|\.{3})/.test(document.body.innerText)
        )
          result.visibleSaving = true;
      };
      const mutation = new MutationObserver(sample);
      mutation.observe(document.body, {
        subtree: true,
        childList: true,
        attributes: true,
        characterData: true,
      });
      const keys = (event) => {
        if (
          event.key === key &&
          event.target === field &&
          started === undefined
        ) {
          started = performance.now();
          requestAnimationFrame(() => {
            result.firstFrameMs = elapsed();
            sample();
          });
        } else if (
          event.key === "ArrowDown" &&
          event.target.matches(".songs-viewport")
        )
          arrowAt = performance.now();
      };
      const focus = (event) => {
        if (
          started !== undefined &&
          result.focusMs === undefined &&
          event.target !== field &&
          event.target.matches(".songs-viewport,.inline-metadata-input")
        )
          result.focusMs = elapsed();
      };
      const pointer = (event) => {
        const row = event.target.closest(".song-row");
        if (row?.dataset.trackId !== other) return;
        if (event.target.closest(".song-play")) playAt = performance.now();
        else pointerAt = performance.now();
      };
      const load = () => {
        if (playAt !== undefined) {
          result.playSourceMs = performance.now() - playAt;
          result.keyToPlaySourceMs = elapsed();
        }
      };
      const audio = document.querySelector("audio");
      const tasks = new PerformanceObserver((list) => {
        result.longTasks.push(
          ...list.getEntries().map((entry) => entry.duration),
        );
      });
      tasks.observe({ type: "longtask" });
      document.addEventListener("keydown", keys, true);
      document.addEventListener("focusin", focus);
      document.addEventListener("pointerdown", pointer, true);
      audio.addEventListener("loadstart", load);
      window.stopInlineInteraction = () => {
        sample();
        mutation.disconnect();
        tasks.disconnect();
        document.removeEventListener("keydown", keys, true);
        document.removeEventListener("focusin", focus);
        document.removeEventListener("pointerdown", pointer, true);
        audio.removeEventListener("loadstart", load);
      };
    },
    { key: key === "Shift+Tab" ? "Tab" : key, other: other.id },
  );
  try {
    await input.press(key);
    if (key === "Enter") {
      // Send the next real key without polling for editor removal first.
      // An early ArrowDown would otherwise still edit the old input.
      await page.keyboard.press("ArrowDown");
      await expect(
        page.locator(`.song-row[data-track-id="${other.id}"]`),
      ).toHaveAttribute("aria-selected", "true");
      await expect(input).toHaveCount(0);
      await expect(page.locator(".songs-viewport")).toBeFocused();
      await page.locator(".songs-viewport").press("Home");
    } else {
      await expect(input).toBeFocused();
      await expect(input).toHaveAttribute("readonly", "");
    }
    await cell(other.id, "artist").click();
    await expect(
      page.locator(`.song-row[data-track-id="${other.id}"]`),
    ).toHaveAttribute("aria-selected", "true");
    await page
      .locator(`.song-row[data-track-id="${other.id}"] .song-play`)
      .click();
    await page.waitForFunction((id) => {
      const audio = document.querySelector("audio");
      return (
        audio.currentSrc &&
        new URL(audio.currentSrc).pathname.slice(1) === id &&
        !audio.paused &&
        audio.currentTime > 0.1
      );
    }, other.id);
    await expect
      .poll(() => app.evaluate(() => typeof globalThis.inlineReleaseWorker))
      .toBe("function");
    await expect(
      page.locator('#inline-metadata-status [role="status"]'),
    ).toContainText("Saving metadata");
    const after = await metrics();
    if (label.startsWith("first-"))
      await page.screenshot({
        path: path.resolve(
          `.impeccable/review/inline-${label}-${packaged ? "packaged" : "source"}.png`,
        ),
      });
    const result = await page.evaluate(() => {
      window.stopInlineInteraction();
      return window.inlineInteraction;
    });
    assert.equal(result.visibleSaving, false);
    assert(result.focusMs < 250, `Focus delayed: ${result.focusMs}ms`);
    if (key === "Enter") {
      assert(result.inputRemovedMs < 250);
      assert(result.navigationMs < 250);
    }
    assert(result.selectionMs < 250);
    assert(Number.isFinite(result.playSourceMs));
    const playback = await app.evaluate(() => globalThis.inlinePlaybackSamples);
    const last = playback.at(-1);
    assert.equal(last.id, other.id);
    const mainLoop = await app.evaluate(() => globalThis.inlineMainLoop);
    console.log(
      "RIO_INLINE_INITIAL",
      JSON.stringify({
        label,
        key,
        ...result,
        playbackMainMs: last.wallMs,
        mainMaxSampleGapMs: mainLoop.maxGapMs,
        rendererScriptMs: 1000 * (after.ScriptDuration - before.ScriptDuration),
        rendererLayoutMs: 1000 * (after.LayoutDuration - before.LayoutDuration),
        rendererStyleMs:
          1000 * (after.RecalcStyleDuration - before.RecalcStyleDuration),
      }),
    );
  } finally {
    await cdp.detach();
    await app.evaluate(() => globalThis.inlineReleaseWorker?.());
  }
  await expect(
    page.locator('#inline-metadata-status [role="status"]'),
  ).not.toContainText("Saving metadata");
  await expect(page.getByRole("alert")).toHaveCount(0);
  assert.equal((await parseFile(track.path)).common.genre[0], label);
  const saved = await page.evaluate(() => window.rio.snapshot());
  const updated = saved.tracks.find((t) => t.id === track.id);
  assert.equal(updated.path, track.path);
  assert.equal(updated.genre, label);
}
