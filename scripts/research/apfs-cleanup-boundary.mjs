// Research-only counterexample. No production adapter or package is modified.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import path from "node:path";
import {
  digest,
  fingerprint,
  productionQualificationCases,
  qualificationCases,
  withPublicationFixture,
} from "../lib/publication-qualification.mjs";
assert.equal(process.platform, "darwin");
assert(process.argv.includes("--cross-uid"), "Explicit --cross-uid required");
const root = await fs.realpath(
  await fs.mkdtemp("/private/tmp/rio-apfs-boundary-"),
);
await fs.chmod(root, 0o755);
const exec = (file, args) => execFileSync(file, args, { encoding: "utf8" });
const api = await import(
  pathToFileURL(path.resolve("dist/domain/publication.js"))
);
const require = createRequire(import.meta.url);
const source = await fs.readFile("native/publication.cc", "utf8");
const originalHash = digest(Buffer.from(source));
const productionHash = digest(
  await fs.readFile("dist/native/publication.node"),
);
const temporarySource = path.join(root, "boundary-only.cc");
// Three behavioral edits in an unshipped copy, plus a testing-only build guard:
// accept a fourth cleanup argument, and pause after the final check before unlink.
const policy = "(MNT_IGNORE_OWNERSHIP|MNT_RDONLY)";
assert.equal(source.split(policy).length, 2);
let experimental = source.replace(policy, "MNT_RDONLY");
const start = experimental.indexOf("napi_value cleanup(");
assert(start > 0);
const header = experimental.slice(0, start);
let body = experimental.slice(start);
assert(body.includes("auto a=args(e,info,3)"));
body = body.replace("auto a=args(e,info,3)", "auto a=args(e,info,4)");
const boundary =
  'privateExpected(l,"slot",stats(slot.n)); workspaceCheck(l); io(unlinkat';
assert.equal(body.split(boundary).length, 2);
body = body.replace(
  boundary,
  'privateExpected(l,"slot",stats(slot.n)); workspaceCheck(l); { napi_value ignored, receiver; js(napi_get_undefined(e,&receiver)); js(napi_call_function(e,receiver,a[3],0,nullptr,&ignored)); } io(unlinkat',
);
experimental =
  "#ifndef RIO_PUBLICATION_TESTING\n#error Research copy must never be built as production\n#endif\n" +
  header +
  body;
await fs.writeFile(temporarySource, experimental);
const actor = path.join(root, "actor");
const bindingPath = path.join(root, "boundary-only.node");
const mounted = [];
const results = [];
const production = [];
const baselineChecks = [];
const oldTmp = process.env.TMPDIR;
const oldOther = process.env.RIO_PUBLICATION_OTHER_VOLUME;
try {
  exec("cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "native/qualification/apfs-cleanup-actor.c",
    "-o",
    actor,
  ]);
  exec("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DNAPI_VERSION=8",
    "-DRIO_PUBLICATION_TESTING",
    "-I/usr/local/include/node",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-mmacosx-version-min=13.0",
    temporarySource,
    "-o",
    bindingPath,
  ]);
  const native = require(bindingPath);
  const otherUid = Number(exec("/usr/bin/id", ["-u", "nobody"]).trim()) >>> 0;
  const otherGid = Number(exec("/usr/bin/id", ["-g", "nobody"]).trim()) >>> 0;
  assert(otherUid !== 0 && otherUid !== process.getuid());
  for (const mode of ["on", "off"]) {
    const volume = path.join(root, mode);
    await fs.mkdir(volume);
    const image = path.join(root, `${mode}.sparseimage`);
    exec("/usr/bin/hdiutil", [
      "create",
      "-quiet",
      "-size",
      "256m",
      "-fs",
      "APFS",
      "-type",
      "SPARSE",
      "-volname",
      `Rio Cleanup Boundary ${mode}`,
      image,
    ]);
    exec("/usr/bin/hdiutil", [
      "attach",
      "-nobrowse",
      "-owners",
      mode,
      "-mountpoint",
      volume,
      image,
    ]);
    mounted.push(volume);
  }
  for (const [mode, timing, disposition] of [
    ["on", "late", "abort"],
    ["off", "early", "abort"],
    ["off", "late", "abort"],
    ["off", "late", "committed"],
  ]) {
    const volume = path.join(root, mode);
    const media = path.join(volume, "Media");
    const unrelated = path.join(volume, "Unrelated");
    await fs.mkdir(media, { mode: 0o700 });
    await fs.mkdir(unrelated, { mode: 0o700 });
    const target = path.join(media, "Track.flac");
    const victim = path.join(unrelated, "victim");
    const original = Buffer.from("Original managed opaque bytes");
    const candidate = Buffer.from("Verified candidate opaque bytes");
    const victimBytes = Buffer.from(
      "Unrelated disposable user data: not a publication artifact",
    );
    await fs.writeFile(target, original, { mode: 0o600 });
    await fs.writeFile(victim, victimBytes, { mode: 0o600 });
    const victimFd = await fs.open(victim, "r");
    const beforeVictim = await fingerprint(victim);
    const config = {
      root: media,
      rootIdentity: await fingerprint(media),
      relative: "Track.flac",
    };
    const probe = api.probePublicationSupport(config);
    assert.equal(probe.status, mode === "on" ? "supported" : "unsupported");
    if (mode === "off") assert.match(probe.reason, /ownership enabled/);
    production.push({ mode, timing, disposition, probe });
    let lease;
    let actorResult;
    let callbackReached = false;
    const invokeActor = () => {
      const workspace = lease.record.workspace;
      assert(/^\.rio-publication-[a-f0-9-]{36}$/.test(workspace));
      const command = `${actor} ${root} ${mode} ${workspace} ${otherUid} ${otherGid} replace-slot`;
      actorResult = JSON.parse(
        exec("/usr/bin/osascript", [
          "-e",
          `do shell script "${command}" with administrator privileges`,
        ]).trim(),
      );
      assert.equal(actorResult.uid, otherUid);
      assert.equal(actorResult.euid, otherUid);
    };
    const adapter = api.createPublicationAdapter(
      Object.defineProperty(Object.create(native), "cleanup", {
        value: (handle, proof, intent) =>
          native.cleanup(handle, proof, intent, () => {
            callbackReached = true;
            if (timing === "late") invokeActor();
          }),
      }),
    );
    try {
      const opened = adapter.openPublicationLease({
        ...config,
        expected: await fingerprint(target),
        originalSha256: digest(original),
        candidate,
      });
      assert.equal(opened.status, "ready", opened.reason);
      lease = opened.lease;
      if (disposition === "committed") {
        assert.equal(lease.exchangeAndObserve().status, "exchanged-expected");
        assert.equal(lease.syncPublication().status, "synced");
      }
      const record = lease.record;
      const before = lease.inspectPublication();
      assert.equal(before.boundaryValid, true);
      if (timing === "early") invokeActor();
      const outcome = lease.cleanupVerifiedArtifacts(disposition);
      const v = await victimFd.stat({ bigint: true });
      const victimAtOriginalPath = await fs.lstat(victim).then(
        () => true,
        () => false,
      );
      const workspaceExists = await fs
        .lstat(path.join(media, record.workspace))
        .then(
          () => true,
          () => false,
        );
      const observedTarget = await fs.readFile(target);
      assert.deepEqual(
        observedTarget,
        disposition === "committed" ? candidate : original,
      );
      const result = {
        mode,
        timing,
        disposition,
        before,
        record,
        actor: actorResult,
        callbackReached,
        outcome,
        beforeVictim,
        afterVictim: {
          inode: String(v.ino),
          links: String(v.nlink),
          size: String(v.size),
          sha256: digest(await victimFd.readFile()),
        },
        victimAtOriginalPath,
        workspaceExists,
        authoritativeSha256: digest(observedTarget),
      };
      if (mode === "on") {
        assert.equal(actorResult.entered, false);
        assert.equal(outcome.status, "cleaned");
        assert.equal(v.nlink, 1n);
        assert(victimAtOriginalPath);
      } else if (timing === "early") {
        assert.equal(outcome.status, "cleanup-refused");
        assert.equal(callbackReached, false);
        assert.equal(v.nlink, 1n);
        assert(workspaceExists);
      } else {
        assert.equal(actorResult.replaced, true);
        assert.equal(callbackReached, true);
        assert.equal(outcome.status, "cleaned");
        assert.equal(v.nlink, 0n);
        assert.equal(victimAtOriginalPath, false);
        assert.equal(workspaceExists, false);
      }
      results.push(result);
    } finally {
      lease?.close();
      await victimFd.close();
      // Entirely test-owned trees. Never a proposed product cleanup policy.
      await fs.rm(media, { recursive: true, force: true });
      await fs.rm(unrelated, { recursive: true, force: true });
    }
  }
  process.env.TMPDIR = path.join(root, "on");
  process.env.RIO_PUBLICATION_OTHER_VOLUME = path.join(root, "off");
  const testNative = require(
    path.resolve("dist/native/testing/publication.node"),
  );
  for (const [name, run] of [
    ...productionQualificationCases(api),
    ...qualificationCases(api, testNative),
  ]) {
    await withPublicationFixture(api, run);
    baselineChecks.push(name);
  }
  assert.equal(
    digest(await fs.readFile("native/publication.cc")),
    originalHash,
  );
  assert.equal(
    digest(await fs.readFile("dist/native/publication.node")),
    productionHash,
  );
  const output = {
    date: "2026-11-01",
    platform: process.platform,
    arch: process.arch,
    system: exec("/usr/bin/sw_vers", []),
    mounts: exec("/sbin/mount", [])
      .split("\n")
      .filter((x) => x.includes(root)),
    productionSourceSha256: originalHash,
    productionBinarySha256: productionHash,
    researchCopySha256: digest(Buffer.from(experimental)),
    experiment:
      "Unshipped copy of native/publication.cc; noowners guard admitted solely for research; deterministic interleave after final slot check and workspace check, before unlinkat; fourth cleanup argument is test-only",
    production,
    results,
    ownershipEnabledBaselineChecks: baselineChecks,
    decision:
      "STOP: checked-name cleanup can silently unlink an unrelated replacement under noowners; production refusal retained",
  };
  await fs.writeFile(
    "docs/qualification/apfs-cleanup-boundary-macos-x64.json",
    JSON.stringify(output, null, 2) + "\n",
  );
  console.log(
    JSON.stringify(
      {
        root,
        cases: results.map((r) => ({
          mode: r.mode,
          timing: r.timing,
          disposition: r.disposition,
          outcome: r.outcome.status,
          victimLinks: r.afterVictim.links,
        })),
        baselineChecks: baselineChecks.length,
      },
      null,
      2,
    ),
  );
} finally {
  if (oldTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = oldTmp;
  if (oldOther === undefined) delete process.env.RIO_PUBLICATION_OTHER_VOLUME;
  else process.env.RIO_PUBLICATION_OTHER_VOLUME = oldOther;
  for (const volume of mounted.reverse())
    exec("/usr/bin/hdiutil", ["detach", "-quiet", volume]);
  await fs.rm(root, { recursive: true, force: true });
}
