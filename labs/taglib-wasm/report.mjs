import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { lab, generated, independent, packets, pcm, sha } from "./lab.mjs";
const names = [
  "node-wasi",
  "node-emscripten",
  "electron-wasi",
  "electron-emscripten",
  "electron-emscripten-buffer",
];
const runs = [];
for (const name of names) {
  const r = JSON.parse(await readFile(path.join(generated, name + ".json")));
  runs.push({
    label: r.label,
    io: r.io ?? "path",
    node: r.runtime.node,
    electron: r.runtime.electron ?? null,
    backend: r.actualBackend,
    version: r.version,
    formats: r.formats.map((f) => ({
      ext: f.ext,
      error: f.error,
      initialRead: f.initialRead?.format,
      initialProperties: f.initialRead?.properties,
      pictureSeedError: f.pictureSeedError,
      seedAudioIntegrity: f.seedAudioIntegrity,
      noFallbackPollution: f.noFallbackPollution,
      picturesSeeded: f.seeded?.pictures,
      cases: f.cases.map((c) => ({
        name: c.name,
        passed: c.passed,
        fieldPassed: c.fieldPassed,
        observed: c.observed,
        writerValue: c.writerValue,
        propertyChangesOutsidePatch: c.propertyChangesOutsidePatch,
        picturesPreserved: c.uneditedPicturesPreserved,
        frontPassed: c.frontPassed,
        additionalPictureBytesPreserved: c.backBytesPreserved,
        audioPacketsUnchanged: c.audioPacketsUnchanged,
        decodedPcmUnchanged: c.decodedPcmUnchanged,
        error: c.error,
      })),
      defaultPartial: f.defaultPartial,
    })),
  });
}
const edges = [];
for (const backend of ["wasi", "emscripten"])
  edges.push(
    JSON.parse(
      await readFile(path.join(generated, "edges-" + backend + ".json")),
    ),
  );
const refinements = JSON.parse(
  await readFile(path.join(generated, "refinements.json")),
);
const asar = JSON.parse(await readFile(path.join(generated, "asar.json")));
const manifest = JSON.parse(
  await readFile(path.join(generated, "manifest.json")),
);
const flac = manifest.find((x) => x.ext === "flac");
for (const c of asar.cases) {
  const file = path.join(generated, `asar-${c.backend}-${c.location}.flac`);
  c.independentTitle = (await independent(file)).common.title;
  c.audioPacketsUnchanged =
    JSON.stringify(packets(file)) === JSON.stringify(flac.packets);
  c.decodedPcmUnchanged = pcm(file) === flac.pcm;
  assert(
    c.passed &&
      c.independentTitle === "ASAR fixture edit" &&
      c.audioPacketsUnchanged &&
      c.decodedPcmUnchanged,
  );
}
for (const f of manifest)
  if (!f.error)
    assert.equal(
      sha(await readFile(f.file)),
      f.hash,
      "Generated originals retained",
    );
const fixtureManifest = manifest.map(({ file, ...f }) => ({
  ...f,
  file: path.relative(lab, file),
}));
const pkg = JSON.parse(
  await readFile(path.join(lab, "node_modules/taglib-wasm/package.json")),
);
const licenseInventory = (
  await readdir(path.join(lab, "node_modules/taglib-wasm"))
).filter((n) => /LICENSE|NOTICE|COPYING|legal/i.test(n));
const productionDiff = execFileSync("git", ["diff", "--name-only"], {
  cwd: lab,
  encoding: "utf8",
}).trim();
assert.equal(productionDiff, "", "No tracked production changes permitted");
const allCases = runs.flatMap((r) => r.formats.flatMap((f) => f.cases));
const summary = {
  date: "2026-10-28",
  decision:
    "accepted with restrictions for future integration, not blanket production approval",
  recommendedInitialScope:
    "Native FLAC only, forced Emscripten full-buffer core API; exact preservation verification; unambiguous comment edits; integer BPM through current Rhythm reader; artwork replacement/removal only when there are no retained additional pictures. Other formats stay read-only pending requalification.",
  package: {
    version: pkg.version,
    nodeEngines: pkg.engines,
    licenseLabel: pkg.license,
    licenseInventory,
    gitHead: "1ef771c91a81c81ecdd22e92b334fab4b27a5bb4",
    wasmSha256: {},
  },
  counts: {
    matrixOperations: allCases.length,
    matrixRuns: runs.length,
    edgeCases: edges.reduce((n, r) => n + r.cases.length, 0),
    refinements: refinements.length,
    asarCases: asar.cases.length,
  },
  integrity: {
    matrixAudioPacketFailures: allCases.filter(
      (c) => c.audioPacketsUnchanged !== true,
    ).length,
    matrixPcmFailures: allCases.filter((c) => c.decodedPcmUnchanged !== true)
      .length,
    allGeneratedOriginalHashesRetained: true,
    trackedProductionChanges: productionDiff,
  },
  fixtureManifest,
  runs,
  edges,
  refinements,
  asar,
  organization: JSON.parse(
    await readFile(path.join(generated, "organization.json")),
  ),
};
for (const engine of ["web", "wasi"])
  summary.package.wasmSha256[engine] = sha(
    await readFile(
      path.join(lab, "node_modules/taglib-wasm/dist", `taglib-${engine}.wasm`),
    ),
  );
await writeFile(
  path.join(lab, "RESULTS.json"),
  JSON.stringify(summary, null, 2) + "\n",
);
const matrix = [
  "| Run | MP3 | FLAC | M4A | Ogg | Opus | WAV | AIFF | AAC |",
  "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ...runs.map(
    (r) =>
      "| " +
      r.label +
      " | " +
      ["mp3", "flac", "m4a", "ogg", "opus", "wav", "aiff", "aac"]
        .map((ext) => {
          const f = r.formats.find((f) => f.ext === ext);
          return f
            ? f.cases.filter((c) => c.passed).length + "/" + f.cases.length
            : "—";
        })
        .join(" | ") +
      " |",
  ),
].join("\n");
await writeFile(path.join(generated, "matrix.md"), matrix + "\n");
console.log(
  JSON.stringify(
    {
      counts: summary.counts,
      integrity: summary.integrity,
      licenseInventory,
      matrix,
    },
    null,
    2,
  ),
);
