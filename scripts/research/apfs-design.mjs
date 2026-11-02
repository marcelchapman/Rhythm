// Phase 2C.3: documented APIs, benign own-file changes and disposable crash tests.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { flacFixture } from "../../tests/metadata-fixtures.ts";
import { parseFile } from "music-metadata";
assert.equal(process.platform, "darwin");
const sha = (b) => createHash("sha256").update(b).digest("hex");
const root = await fs.realpath(
  await fs.mkdtemp("/private/tmp/rio-apfs-design-"),
);
const mounted = [],
  rows = [],
  binding = path.join(root, "object-model.node"),
  primitive = path.join(root, "binding");
const exec = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8" });
const productionSource = sha(await fs.readFile("native/publication.cc"));
const productionBinary = sha(await fs.readFile("dist/native/publication.node"));
let retained = false;
try {
  exec("cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-Wno-deprecated-declarations",
    "native/qualification/apfs-binding.c",
    "-o",
    primitive,
  ]);
  exec("c++", [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DNAPI_VERSION=8",
    "-I/usr/local/include/node",
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "native/qualification/apfs-object-model.cc",
    "-o",
    binding,
  ]);
  for (const mode of ["on", "off"]) {
    const volume = path.join(root, mode);
    await fs.mkdir(volume);
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
      `Rio Design Research ${mode}`,
      path.join(root, `${mode}.sparseimage`),
    ]);
    exec("/usr/bin/hdiutil", [
      "attach",
      "-nobrowse",
      "-owners",
      mode,
      "-mountpoint",
      volume,
      path.join(root, `${mode}.sparseimage`),
    ]);
    mounted.push(volume);
    await fs.mkdir(path.join(volume, "Bindings"));
  }
  const primitives = [];
  for (const mode of ["on", "off"]) {
    const other = mode === "on" ? "off" : "on";
    primitives.push({
      mode,
      ...JSON.parse(
        exec(primitive, [
          path.join(root, mode, "Bindings"),
          path.join(root, other, "Bindings"),
        ]),
      ),
    });
  }
  const control = path.join(root, "on", "Control");
  await fs.mkdir(control, { mode: 0o700 });
  const original = flacFixture();
  const faults = [
    "after-intent",
    "after-create",
    "during-write",
    "after-verify",
    "after-revalidate",
    "during-pointer-transaction",
    "after-commit",
    "before-reconcile",
    "after-reconcile",
    "retention-recorded",
  ];
  const changes = [
    ["rename", "source", "after-verify"],
    ["replace", "source", "after-revalidate"],
    ["remove-recreate", "source", "after-verify"],
    ["modify", "source", "after-verify"],
    ["symlink", "source", "after-revalidate"],
    ["hardlink", "source", "after-verify"],
    ["rename", "candidate", "after-verify"],
    ["replace", "candidate", "after-revalidate"],
    ["remove-recreate", "candidate", "after-verify"],
    ["modify", "candidate", "after-verify"],
    ["symlink", "candidate", "after-revalidate"],
    ["hardlink", "candidate", "after-verify"],
    ["replace", "candidate", "after-commit"],
    ["modify", "candidate", "before-reconcile"],
    ["directory", "source", "after-intent"],
    ["directory", "source", "after-revalidate"],
  ];
  let index = 0;
  for (const mode of ["on", "off"]) {
    const cases = [
      { kind: "normal" },
      ...faults.map((crashAt) => ({ kind: "crash", crashAt })),
      ...changes.map(([change, changeTarget, changeAt]) => ({
        kind: "ordinary-change",
        change,
        changeTarget,
        changeAt,
      })),
    ];
    for (const test of cases) {
      const id = `case-${index++}`,
        caseRoot = path.join(root, mode, id),
        media = path.join(caseRoot, "Media"),
        store = path.join(control, id);
      await fs.mkdir(caseRoot);
      await fs.mkdir(media, { mode: 0o700 });
      await fs.mkdir(store, { mode: 0o700 });
      const source = path.join(media, "Track.flac");
      await fs.writeFile(source, original, { mode: 0o600 });
      const candidateInput = path.join(store, "ordinary-change.flac"),
        otherInput = path.join(store, "other.flac");
      await fs.writeFile(
        candidateInput,
        flacFixture({
          entries: [["TITLE", "Other ordinary application edit"]],
        }),
      );
      await fs.writeFile(
        otherInput,
        flacFixture({ entries: [["TITLE", "Other disposable file"]] }),
      );
      const fp = async (p) => {
        const s = await fs.stat(p, { bigint: true });
        return {
          device: String(s.dev),
          inode: String(s.ino),
          size: String(s.size),
          links: String(s.nlink),
          mtime: String(s.mtimeNs),
          ctime: String(s.ctimeNs),
          file: s.isFile(),
          directory: s.isDirectory(),
        };
      };
      const config = {
        ...test,
        media,
        control: store,
        binding,
        candidateInput,
        otherInput,
        rootIdentity: await fp(media),
        originalRef: {
          token: "original",
          trackId: sha(Buffer.from("stable-disposable-track")),
          name: "Track.flac",
          identity: await fp(source),
          sha256: sha(original),
        },
      };
      const configPath = path.join(store, "case.json");
      await fs.writeFile(configPath, JSON.stringify(config));
      const run = (op) =>
        spawnSync(
          process.execPath,
          ["scripts/research/apfs-versioned-model.mjs", op, configPath],
          { encoding: "utf8", timeout: 30000, maxBuffer: 200000 },
        );
      const publisher = run("publish");
      let publication;
      if (test.kind === "crash") {
        assert.equal(
          publisher.signal,
          "SIGKILL",
          publisher.stderr + publisher.stdout,
        );
      } else {
        assert.equal(publisher.status, 0, publisher.stderr);
        publication = JSON.parse(publisher.stdout);
      }
      const recovery = run("recover");
      assert.equal(recovery.status, 0, recovery.stderr);
      const recovered = JSON.parse(recovery.stdout);
      if (test.kind === "normal") {
        assert.equal(publication.result.status, "new-generation");
        assert.equal(recovered.result.status, "new-generation");
        assert.deepEqual(await fs.readFile(source), original);
        const parsed = await parseFile(
          path.join(media, recovered.result.ref.name),
        );
        assert.equal(parsed.common.title, "Versioned publication research");
        assert.equal(parsed.common.year, 2001);
        assert.equal(parsed.common.comment, undefined);
      }
      if (test.kind === "crash") {
        const published = [
          "after-commit",
          "before-reconcile",
          "after-reconcile",
          "retention-recorded",
        ].includes(test.crashAt);
        assert.equal(
          recovered.result.status,
          published ? "new-generation" : "original",
        );
        assert.deepEqual(await fs.readFile(source), original);
      }
      if (test.kind === "ordinary-change") {
        const committed = publication.ledger.some(
          (x) => x.operation === "publish-db-reference",
        );
        const expected =
          test.changeTarget === "candidate" && !committed
            ? "original"
            : "fail-closed";
        const detail = JSON.stringify({ test, recovered, publication });
        assert.equal(publication.result.status, "fail-closed", detail);
        assert.equal(recovered.result.status, expected, detail);
        for (const item of publication.ledger.find((x) => x.ordinaryProcess)
          .ordinaryProcess.preserved) {
          const s = await fs.lstat(item.file, { bigint: true });
          assert.equal(String(s.dev), item.device);
          assert.equal(String(s.ino), item.inode);
          assert.equal(String(s.nlink), item.links);
          assert.equal(s.isSymbolicLink(), item.symlink);
          assert.equal(
            item.symlink
              ? await fs.readlink(item.file)
              : sha(await fs.readFile(item.file)),
            item.value,
          );
        }
      }
      let retentionLimit;
      if (test.kind === "normal") {
        const before = await fs.readdir(media);
        const retry = run("publish");
        assert.equal(retry.status, 0, retry.stderr);
        retentionLimit = JSON.parse(retry.stdout);
        assert.equal(retentionLimit.result.status, "fail-closed");
        assert.match(
          retentionLimit.result.reason,
          /single-attempt retention budget exhausted/,
        );
        assert.deepEqual(await fs.readdir(media), before);
        const again = run("recover");
        assert.equal(again.status, 0, again.stderr);
        assert.equal(JSON.parse(again.stdout).result.status, "new-generation");
      }
      if (recovered.result.ref)
        assert.equal(recovered.result.ref.trackId, config.originalRef.trackId);
      const names = await fs.readdir(media);
      const savedNames = await fs.readdir(media + "-moved").catch(() => []);
      // This ledger is the model's protocol operations; fixture preparation and the
      // explicit ordinary-file change process are not product cleanup behavior.
      if (publication)
        assert(
          publication.ledger.every(
            (x) =>
              !x.operation ||
              [
                "create-exclusive",
                "write-created-fd",
                "publish-db-reference",
                "retain-superseded-and-orphan-evidence",
              ].includes(x.operation),
          ),
        );
      rows.push({
        mode,
        test,
        publisherSignal: publisher.signal ?? null,
        publication,
        recovery: recovered,
        retentionLimit,
        mediaNames: names,
        movedDirectoryNames: savedNames,
      });
      console.log(
        `${mode} ${test.kind} ${test.crashAt ?? test.change ?? "baseline"}: ${recovered.result.status}`,
      );
    }
  }
  assert.equal(
    sha(await fs.readFile("native/publication.cc")),
    productionSource,
  );
  assert.equal(
    sha(await fs.readFile("dist/native/publication.node")),
    productionBinary,
  );
  const output = {
    date: "2026-11-01",
    system: exec("/usr/bin/sw_vers", []),
    architecture: process.arch,
    sdk: exec("xcrun", ["--show-sdk-version"]).trim(),
    mounts: exec("/sbin/mount", [])
      .split("\n")
      .filter((x) => x.includes(root)),
    scope:
      "Documented APIs; ordinary own-file changes and self-SIGKILL of disposable model processes only. No cross-UID or offensive/adversarial probing.",
    productionSourceSha256: productionSource,
    productionBinarySha256: productionBinary,
    primitives,
    model: {
      description:
        "New unique media object + private ownership-enabled SQLite reference transaction; no destructive media cleanup. One attempt per DB research demonstrator only, not Rio integration or complete architecture qualification.",
      maxFileBytes: 64 * 1024 * 1024,
      reservedAttemptsLimit: 1,
      cleanup: "retain only; no unlink/rename/replace",
      rows,
    },
    unresolved: [
      "Hostile/cross-UID testing not performed under revised mission limits",
      "Complete trusted-control-store and recovery namespace proof",
      "Multi-generation recovery and production retention budgeting",
      "I/O/flush/ENOSPC faults, unavailable volumes and physical power failure",
      "Production Library/receipt/playback/UI/packaged integration",
      "All supported macOS/APFS versions",
      "Whether user accepts changed authoritative path and storage retention",
    ],
  };
  await fs.writeFile(
    "docs/qualification/apfs-design-macos-x64.json",
    JSON.stringify(output, null, 2) + "\n",
  );
  if (process.argv.includes("--retain")) {
    retained = true;
    console.log(`Retained disposable fixtures: ${root}`);
  }
  console.log(
    JSON.stringify({
      bindingCases: primitives.length,
      modelCases: rows.length,
      productionUnchanged: true,
    }),
  );
} finally {
  if (!retained) {
    for (const volume of mounted.reverse())
      exec("/usr/bin/hdiutil", ["detach", "-quiet", volume]);
    await fs.rm(root, { recursive: true, force: true });
  }
}
