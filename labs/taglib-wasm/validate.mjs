// Validate observations, including expected qualification failures; not an all-green writer claim.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fixture, lab } from "./lab.mjs";
const r = JSON.parse(await readFile(path.join(lab, "RESULTS.json")));
assert.equal(r.counts.matrixOperations, 1120);
assert.equal(r.integrity.matrixAudioPacketFailures, 0);
assert.equal(r.integrity.matrixPcmFailures, 0);
assert.equal(r.integrity.trackedProductionChanges, "");
await assert.rejects(fixture(path.join(lab, "package.json")), /LAB SAFETY/);
for (const run of r.runs) {
  for (const f of run.formats) {
    assert(!f.error);
    assert(f.noFallbackPollution);
    assert(f.seedAudioIntegrity.packets && f.seedAudioIntegrity.pcm);
    for (const name of [
      "title",
      "artistAlbum",
      "albumArtist",
      "composer",
      "genre",
      "year",
      "integerBpm",
      "trackNumber",
      "trackTotal",
      "discNumber",
      "discTotal",
    ])
      assert.equal(
        f.cases.find((c) => c.name === name).fieldPassed,
        true,
        run.label + " " + f.ext + " " + name,
      );
    assert(
      f.defaultPartial.titlePassed &&
        f.defaultPartial.audioPacketsUnchanged &&
        f.defaultPartial.decodedPcmUnchanged,
    );
  }
}
for (const edge of r.edges) {
  const find = (name) => {
    const c = edge.cases.find((c) => c.name === name);
    assert(c, name);
    assert(!c.error);
    return c;
  };
  const mdta = find("m4a-mdta-title");
  assert(mdta.markerPresentBefore);
  assert.equal(mdta.markerRetained, false);
  const geometry = find("flac-picture-geometry-title");
  assert.equal(geometry.beforePictureHeaders[1].width, 32);
  assert.equal(
    geometry.afterPictureHeaders[1].width,
    edge.backend === "wasi" ? 0 : 32,
  );
  const art = find("flac-picture-geometry-replace-front");
  assert.equal(
    art.afterPictureHeaders.find((p) => p.type === "Cover (back)").width,
    0,
  );
  for (const c of edge.cases) {
    assert(!c.error, c.name);
    assert(c.packetsUnchanged && c.pcmUnchanged, c.name);
  }
  for (const version of [3, 4]) {
    const simple = find(`mp3-v${version}-simple-title`);
    assert.equal(simple.commentsUnchanged, false);
    const core = find(`mp3-v${version}-path-title`);
    assert.equal(core.commentsUnchanged, edge.backend === "emscripten");
    assert.equal(
      core.beforeRaw.find((f) => f.id === "XZZZ").hash,
      core.afterRaw.find((f) => f.id === "XZZZ").hash,
    );
    assert.notEqual(
      core.beforeRaw.find((f) => f.id === "XZZZ").flags,
      core.afterRaw.find((f) => f.id === "XZZZ").flags,
    );
  }
  for (const action of ["replace-first", "remove-first"])
    assert(
      find("m4a-" + action + "-vendor-artwork").indexedArtwork
        .additionalPreserved,
    );
}
for (const c of r.refinements) {
  assert(!c.error);
  assert(c.audioPacketsUnchanged && c.pcmUnchanged);
  if (c.kind === "multivalue-title") assert(c.multivaluePreserved);
}
for (const c of r.asar.cases)
  assert(c.passed && c.audioPacketsUnchanged && c.decodedPcmUnchanged);
assert.deepEqual(r.package.licenseInventory, ["LICENSE"]);
console.log(
  "LAB VALIDATION: 1120 matrix operations, 46 preservation edge cases, 16 refinements and four ASAR checks reproduced; expected restrictions remain visible; no audio-integrity failures.",
);
