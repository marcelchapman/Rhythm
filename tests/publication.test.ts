import { test } from "vitest";
import { createRequire } from "node:module";
import * as api from "../src/domain/publication";
import {
  qualificationCases,
  withPublicationFixture,
} from "../scripts/lib/publication-qualification.mjs";
const binding = ["darwin", "linux"].includes(process.platform)
  ? createRequire(import.meta.url)("../dist/native/testing/publication.node")
  : undefined;
for (const [name, run] of binding ? qualificationCases(api, binding) : [])
  test(name, () => withPublicationFixture(api, run));
test("production binding exposes no deterministic injection hooks", async () => {
  if (!binding) return;
  const production = createRequire(import.meta.url)(
    "../dist/native/publication.node",
  );
  const assert = await import("node:assert/strict");
  for (const hook of [
    "exchangeWithInterleave",
    "exchangeWithAfterInterleave",
    "syncWithFailure",
    "checkFilesystem",
    "injectWorkspaceAcl",
  ])
    assert.equal(production[hook], undefined);
});
test("package hook validates matching binary and rejects another target architecture", async () => {
  if (!binding) return;
  const check = createRequire(import.meta.url)(
    "../scripts/check-publication-package.cjs",
  );
  const context = {
    packager: { info: { appDir: process.cwd() } },
    electronPlatformName: process.platform,
    arch: process.arch === "x64" ? 1 : 3,
  };
  await check(context);
  const assert = await import("node:assert/strict");
  await assert.rejects(
    check({ ...context, arch: context.arch === 1 ? 3 : 1 }),
    /exact package/,
  );
});
