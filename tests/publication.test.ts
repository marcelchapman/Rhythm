import { test } from "vitest";
import { createRequire } from "node:module";
import * as api from "../src/domain/publication";
import {
  qualificationCases,
  productionQualificationCases,
  withPublicationFixture,
} from "../scripts/lib/publication-qualification.mjs";
const binding = ["darwin", "linux"].includes(process.platform)
  ? createRequire(import.meta.url)("../dist/native/testing/publication.node")
  : undefined;
for (const [name, run] of binding ? qualificationCases(api, binding) : [])
  test(name, () => withPublicationFixture(api, run));
for (const [name, run] of binding ? productionQualificationCases(api) : [])
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

for (const disposition of ["abort", "committed"] as const) {
  test(`cleanup-only recovery resumes exact ${disposition} layout without authority to exchange`, async () => {
    if (!binding) return;
    const assert = await import("node:assert/strict");
    const fs = await import("node:fs/promises");
    await withPublicationFixture(api, async (f: any) => {
      const lease = await f.open();
      if (disposition === "committed")
        assert.equal(lease.exchangeAndObserve().status, "exchanged-expected");
      const record = lease.record;
      lease.close();
      const resumed = api.resumePublicationCleanup(record, disposition);
      assert.equal(resumed.status, "ready");
      if (!("lease" in resumed)) throw Error("Recovery lease missing");
      try {
        assert.equal(resumed.lease.exchangeAndObserve().status, "no-change");
        assert.equal(resumed.lease.syncPublication().status, "synced");
        assert.equal(
          resumed.lease.cleanupVerifiedArtifacts(disposition).status,
          "cleaned",
        );
        assert.deepEqual(
          await fs.readFile(f.target),
          disposition === "committed" ? f.candidate : f.original,
        );
      } finally {
        resumed.lease.close();
      }
    });
  });
}
for (const change of [
  "bytes",
  "identity",
  "unknown entry",
  "wrong layout",
] as const) {
  test(`recovery cleanup refuses ${change} and retains original`, async () => {
    if (!binding) return;
    const assert = await import("node:assert/strict");
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await withPublicationFixture(api, async (f: any) => {
      const lease = await f.open(),
        record = lease.record;
      lease.close();
      const work = path.join(f.parent, record.workspace),
        slot = path.join(work, "slot");
      if (change === "bytes") await fs.writeFile(slot, "changed");
      if (change === "identity") {
        await fs.rename(slot, path.join(work, "saved"));
        await fs.writeFile(slot, f.candidate);
      }
      if (change === "unknown entry")
        await fs.writeFile(path.join(work, "unknown"), "retain");
      const result = api.resumePublicationCleanup(
        record,
        change === "wrong layout" ? "committed" : "abort",
      );
      if ("lease" in result) {
        try {
          assert.equal(
            result.lease.cleanupVerifiedArtifacts("abort").status,
            "cleanup-refused",
          );
        } finally {
          result.lease.close();
        }
      } else assert.notEqual(result.status, "ready");
      assert.deepEqual(await fs.readFile(f.target), f.original);
      assert.deepEqual(
        await fs.readFile(path.join(work, "rollback")),
        f.original,
      );
    });
  });
}
