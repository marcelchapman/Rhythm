import { createRequire } from "node:module";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  qualificationCases,
  withPublicationFixture,
  fingerprint,
} from "./lib/publication-qualification.mjs";
const packaged = process.argv.includes("--packaged");
const resources =
  process.platform === "darwin"
    ? "release/mac/Rhythm.app/Contents/Resources"
    : "release/linux-unpacked/resources";
const entry = packaged
  ? path.resolve(resources, "app.asar/dist/domain/publication.js")
  : path.resolve("dist/domain/publication.js");
const api = await import(pathToFileURL(entry));
const binding = createRequire(import.meta.url)(
  path.resolve("dist/native/testing/publication.node"),
);
const checks = [];
for (const [name, run] of qualificationCases(api, binding)) {
  await withPublicationFixture(api, run);
  checks.push(name);
}
if (packaged) {
  const native = createRequire(entry)("../native/publication.node");
  for (const hook of [
    "exchangeWithInterleave",
    "exchangeWithAfterInterleave",
    "syncWithFailure",
    "checkFilesystem",
    "injectWorkspaceAcl",
  ])
    if (native[hook] !== undefined)
      throw Error("Test hooks were included in the production package.");
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
      checks,
      workspaceVolume: volume,
    },
    null,
    2,
  ),
);
