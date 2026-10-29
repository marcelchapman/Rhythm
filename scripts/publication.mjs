import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  qualificationCases,
  productionQualificationCases,
  withPublicationFixture,
  fingerprint,
} from "./lib/publication-qualification.mjs";
const packaged = process.argv.includes("--packaged");
const resources = process.argv[process.argv.indexOf("--resources") + 1];
if (packaged) {
  assert(
    process.argv.includes("--resources"),
    "Launch through publication-electron.mjs --packaged",
  );
  assert(process.versions.electron, "Packaged qualification requires Electron");
  assert.equal(
    await realpath(resources),
    await realpath(
      path.resolve(
        path.dirname(process.execPath),
        process.platform === "darwin" ? "../Resources" : "resources",
      ),
    ),
    "Qualification must use this executable's own resources",
  );
}
const entry = packaged
  ? path.resolve(resources, "app.asar/dist/domain/publication.js")
  : path.resolve("dist/domain/publication.js");
const api = await import(pathToFileURL(entry));
const productionChecks = [];
for (const [name, run] of productionQualificationCases(api)) {
  await withPublicationFixture(api, run);
  productionChecks.push(name);
}
const requireProduction = createRequire(entry);
const productionPath = requireProduction.resolve("../native/publication.node");
// The production checks above must have loaded the actual adjacent addon,
// before any local instrumented addon is even loaded by this harness.
assert(
  requireProduction.cache[productionPath],
  "Production addon was not exercised",
);
const native = requireProduction(productionPath);
for (const hook of [
  "exchangeWithInterleave",
  "exchangeWithAfterInterleave",
  "syncWithFailure",
  "checkFilesystem",
  "injectWorkspaceAcl",
])
  assert.equal(native[hook], undefined, "Production addon exposes test hooks");
const manifest = requireProduction("../native/publication-build.json");
const productionBinary = packaged
  ? path.join(resources, "app.asar.unpacked/dist/native/publication.node")
  : productionPath;
assert.equal(manifest.testing, false);
assert.equal(manifest.platform, process.platform);
assert.equal(manifest.arch, process.arch);
assert.equal(
  createHash("sha256")
    .update(await readFile(productionBinary))
    .digest("hex"),
  manifest.sha256,
);
const binding = createRequire(import.meta.url)(
  path.resolve("dist/native/testing/publication.node"),
);
const checks = [];
for (const [name, run] of qualificationCases(api, binding)) {
  await withPublicationFixture(api, run);
  checks.push(name);
}
// Separate policy observation on the workspace volume; never use a real Media folder.
const probe = await realpath(
  await mkdtemp(path.resolve("labs/.publication-volume-probe-")),
);
let volume;
try {
  volume = api.probePublicationSupport({
    root: probe,
    rootIdentity: await fingerprint(probe),
    relative: "probe",
  });
} finally {
  await rm(probe, { recursive: true, force: true });
}
console.log(
  JSON.stringify(
    {
      passed: true,
      runtime: {
        node: process.versions.node,
        electron: process.versions.electron ?? null,
        platform: process.platform,
        arch: process.arch,
      },
      packaged,
      fixtureParent: tmpdir(),
      productionBinary,
      productionSha256: manifest.sha256,
      productionChecks,
      // Includes local instrumented-addon boundary injection and crash children;
      // these are not all claims about the packaged production binary.
      instrumentedBinary: path.resolve("dist/native/testing/publication.node"),
      checks,
      workspaceVolume: volume,
    },
    null,
    2,
  ),
);
