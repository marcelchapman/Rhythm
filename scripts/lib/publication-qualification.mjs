import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as sync from "node:fs";
import path from "node:path";
import { tmpdir, userInfo } from "node:os";
import { createHash } from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";
import { flacFixture } from "../../tests/metadata-fixtures.ts";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function fingerprint(file) {
  const s = await fs.lstat(file, { bigint: true });
  return {
    device: String(s.dev),
    inode: String(s.ino),
    size: String(s.size),
    links: String(s.nlink),
    mode: String(s.mode),
    uid: String(s.uid),
    gid: String(s.gid),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
    type: s.isFile()
      ? "file"
      : s.isDirectory()
        ? "directory"
        : s.isSymbolicLink()
          ? "symlink"
          : "other",
  };
}
export async function withPublicationFixture(api, run) {
  const directory = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "rhythm-publication-test-")),
  );
  const leases = [];
  try {
    const root = path.join(directory, "Media"),
      parent = path.join(root, "Artist", "Album");
    await fs.mkdir(parent, { recursive: true });
    const target = path.join(parent, "Track.flac"),
      original = flacFixture(),
      candidate = flacFixture({ entries: [["TITLE", "Candidate"]] });
    await fs.writeFile(target, original);
    const config = {
      root,
      rootIdentity: await fingerprint(root),
      relative: "Artist/Album/Track.flac",
    };
    const options = async () => ({
      ...config,
      expected: await fingerprint(target),
      originalSha256: digest(original),
      candidate,
    });
    const open = async (adapter = api, patch = {}) => {
      const result = adapter.openPublicationLease({
        ...(await options()),
        ...patch,
      });
      assert.equal(result.status, "ready", result.reason);
      leases.push(result.lease);
      return result.lease;
    };
    await run({
      directory,
      root,
      parent,
      target,
      original,
      candidate,
      config,
      options,
      open,
      leases,
    });
  } finally {
    for (const lease of leases) lease.close();
    // Test-owned disposable tree only. This is not the adapter's cleanup policy.
    await fs.rm(directory, { recursive: true, force: true });
  }
}
const slotPath = (f, lease) =>
  path.join(f.parent, lease.record.workspace, "slot");
const rollbackPath = (f, lease) =>
  path.join(f.parent, lease.record.workspace, "rollback");
export function qualificationCases(api, testBinding) {
  const interleave = (hook, after = false) =>
    api.createPublicationAdapter(
      Object.defineProperty(Object.create(testBinding), "exchange", {
        value: (handle) =>
          testBinding[
            after ? "exchangeWithAfterInterleave" : "exchangeWithInterleave"
          ](handle, hook),
      }),
    );
  return [
    [
      "filesystem capabilities and occupied no-overwrite probe",
      async (f) => {
        const p = api.probePublicationSupport(f.config);
        assert.equal(p.status, "supported", p.reason);
        assert(["apfs", "ext4"].includes(p.filesystem));
        assert(["fullfsync", "fsync"].includes(p.barrier));
        assert.equal((await fs.readdir(f.parent)).length, 1);
      },
    ],
    [
      "expected exchange retains candidate, displaced A and independent rollback",
      async (f) => {
        const lease = await f.open();
        const record = lease.record;
        assert.notEqual(record.rollbackIdentity.inode, record.expected.inode);
        assert.equal(lease.exchangeAndObserve().status, "exchanged-expected");
        assert.deepEqual(await fs.readFile(f.target), f.candidate);
        assert.deepEqual(await fs.readFile(slotPath(f, lease)), f.original);
        assert.deepEqual(await fs.readFile(rollbackPath(f, lease)), f.original);
        assert.equal(lease.syncPublication().status, "synced");
        assert.equal(lease.exchangeAndObserve().status, "no-change");
        assert.equal(
          lease.cleanupVerifiedArtifacts("committed").status,
          "cleaned",
        );
        assert.deepEqual(await fs.readdir(f.parent), ["Track.flac"]);
        assert.deepEqual(await fs.readFile(f.target), f.candidate);
      },
    ],
    [
      "substitution before entry produces no namespace change",
      async (f) => {
        const lease = await f.open(),
          B = Buffer.from("B before validation");
        await fs.rename(f.target, path.join(f.directory, "saved-A"));
        await fs.writeFile(f.target, B);
        assert.equal(lease.exchangeAndObserve().status, "no-change");
        assert.deepEqual(await fs.readFile(f.target), B);
      },
    ],
    [
      "unexpected B at exact precheck/exchange boundary is preserved as conflict",
      async (f) => {
        let lease;
        const B = Buffer.from("B external object");
        const adapter = interleave(() => {
          sync.renameSync(f.target, path.join(f.directory, "saved-A"));
          sync.writeFileSync(f.target, B);
        });
        lease = await f.open(adapter);
        const outcome = lease.exchangeAndObserve();
        assert.equal(outcome.status, "exchanged-conflict");
        assert.deepEqual(await fs.readFile(f.target), f.candidate);
        assert.deepEqual(await fs.readFile(slotPath(f, lease)), B);
        assert.equal(
          lease.cleanupVerifiedArtifacts("committed").status,
          "cleanup-refused",
        );
        assert.deepEqual(await fs.readFile(slotPath(f, lease)), B);
      },
    ],
    [
      "same-inode in-place mutation at exchange boundary fails digest verification",
      async (f) => {
        const B = Buffer.from(f.original);
        B[B.length - 1] ^= 1;
        const lease = await f.open(
          interleave(() => sync.writeFileSync(f.target, B)),
        );
        assert.equal(lease.exchangeAndObserve().status, "exchanged-conflict");
        assert.deepEqual(await fs.readFile(slotPath(f, lease)), B);
        assert.equal(
          lease.cleanupVerifiedArtifacts("committed").status,
          "cleanup-refused",
        );
      },
    ],
    [
      "unexpected directory at exact exchange boundary is retained intact",
      async (f) => {
        const adapter = interleave(() => {
          sync.renameSync(f.target, path.join(f.directory, "saved-A"));
          sync.mkdirSync(f.target);
          sync.writeFileSync(
            path.join(f.target, "unknown"),
            "B directory contents",
          );
        });
        const lease = await f.open(adapter);
        assert.equal(lease.exchangeAndObserve().status, "exchanged-conflict");
        assert.equal(
          await fs.readFile(path.join(slotPath(f, lease), "unknown"), "utf8"),
          "B directory contents",
        );
        assert.equal(
          lease.cleanupVerifiedArtifacts("committed").status,
          "cleanup-refused",
        );
      },
    ],
    [
      "unexpected symlink at exchange boundary never edits its referent",
      async (f) => {
        const referent = path.join(f.directory, "referent");
        await fs.writeFile(referent, "external B");
        const lease = await f.open(
          interleave(() => {
            sync.renameSync(f.target, path.join(f.directory, "saved-A"));
            sync.symlinkSync(referent, f.target);
          }),
        );
        assert.equal(lease.exchangeAndObserve().status, "exchanged-conflict");
        assert((await fs.lstat(slotPath(f, lease))).isSymbolicLink());
        assert.equal(await fs.readFile(referent, "utf8"), "external B");
        assert.equal(
          lease.cleanupVerifiedArtifacts("committed").status,
          "cleanup-refused",
        );
      },
    ],
    [
      "independent digest check rejects a falsely positive native observation",
      async (f) => {
        const driver = Object.defineProperty(
          Object.create(testBinding),
          "exchange",
          {
            value: (h) => {
              const r = testBinding.exchangeWithInterleave(h, () =>
                sync.writeFileSync(f.target, "B changed bytes"),
              );
              return { ...r, status: "exchanged-expected" };
            },
          },
        );
        const lease = await f.open(api.createPublicationAdapter(driver));
        const r = lease.exchangeAndObserve();
        assert.equal(r.status, "exchanged-conflict");
        assert.match(r.reason, /digest/);
      },
    ],
    [
      "failed preparation reports retained workspace without changing public file",
      async (f) => {
        const driver = Object.defineProperty(
          Object.create(testBinding),
          "prepare",
          {
            value: (...args) => {
              testBinding.prepare(...args);
              throw Error("Injected failure after preparation");
            },
          },
        );
        const r = api
          .createPublicationAdapter(driver)
          .openPublicationLease(await f.options());
        assert.equal(r.status, "no-change");
        assert(r.retainedWorkspace);
        assert.deepEqual(await fs.readFile(f.target), f.original);
        assert.deepEqual(
          await fs.readFile(
            path.join(f.parent, r.retainedWorkspace.workspace, "rollback"),
          ),
          f.original,
        );
      },
    ],
    [
      "leaf symlink rejected without touching referent",
      async (f) => {
        const external = path.join(f.directory, "external");
        await fs.writeFile(external, "B");
        await fs.unlink(f.target);
        await fs.symlink(external, f.target);
        const r = api.openPublicationLease(await f.options());
        assert.notEqual(r.status, "ready");
        assert.equal(await fs.readFile(external, "utf8"), "B");
      },
    ],
    [
      "parent substitution before exchange is refused",
      async (f) => {
        const lease = await f.open(),
          external = path.join(f.directory, "External"),
          parked = path.join(f.directory, "parked");
        await fs.mkdir(external);
        await fs.writeFile(path.join(external, "Track.flac"), "B");
        await fs.rename(f.parent, parked);
        await fs.symlink(external, f.parent, "dir");
        assert.equal(lease.exchangeAndObserve().status, "no-change");
        assert.equal(
          await fs.readFile(path.join(external, "Track.flac"), "utf8"),
          "B",
        );
        assert.deepEqual(
          await fs.readFile(path.join(parked, "Track.flac")),
          f.original,
        );
      },
    ],
    [
      "parent swapped at syscall boundary cannot redirect anchored exchange",
      async (f) => {
        const external = path.join(f.directory, "External"),
          parked = path.join(f.directory, "parked");
        await fs.mkdir(external);
        await fs.writeFile(path.join(external, "Track.flac"), "B");
        const lease = await f.open(
          interleave(() => {
            sync.renameSync(f.parent, parked);
            sync.symlinkSync(external, f.parent, "dir");
          }),
        );
        const r = lease.exchangeAndObserve();
        assert.equal(r.status, "exchanged-conflict");
        assert.equal(r.inspection.boundaryValid, false);
        assert.equal(
          await fs.readFile(path.join(external, "Track.flac"), "utf8"),
          "B",
        );
        assert.deepEqual(
          await fs.readFile(path.join(parked, "Track.flac")),
          f.candidate,
        );
        assert.equal(
          lease.cleanupVerifiedArtifacts("committed").status,
          "cleanup-refused",
        );
      },
    ],
    [
      "changed registered root and forged expected digest are rejected",
      async (f) => {
        for (const patch of [
          { rootIdentity: { ...f.config.rootIdentity, inode: "0" } },
          { originalSha256: "0".repeat(64) },
        ]) {
          assert.notEqual(
            api.openPublicationLease({ ...(await f.options()), ...patch })
              .status,
            "ready",
          );
        }
        assert.deepEqual(await fs.readFile(f.target), f.original);
      },
    ],
    [
      "hard-linked target rejected",
      async (f) => {
        await fs.link(f.target, path.join(f.directory, "alias"));
        assert.notEqual(
          api.openPublicationLease(await f.options()).status,
          "ready",
        );
        assert.deepEqual(await fs.readFile(f.target), f.original);
      },
    ],
    [
      "non-regular target rejected",
      async (f) => {
        await fs.unlink(f.target);
        await fs.mkdir(f.target);
        assert.notEqual(
          api.openPublicationLease(await f.options()).status,
          "ready",
        );
      },
    ],
    [
      "traversal and candidate paths cannot enter publication API",
      async (f) => {
        for (const relative of [
          "../outside",
          "/absolute",
          "Artist/../outside",
          "Artist\\Album\\Track.flac",
        ])
          assert.notEqual(
            api.openPublicationLease({ ...(await f.options()), relative })
              .status,
            "ready",
          );
        assert.notEqual(
          api.openPublicationLease({
            ...(await f.options()),
            candidate: f.target,
          }).status,
          "ready",
        );
      },
    ],
    [
      "foreign-device guard rejects cross-filesystem artifacts where available",
      async (f) => {
        const base =
          process.env.RHYTHM_PUBLICATION_OTHER_VOLUME ||
          (process.platform === "darwin" ? path.resolve("labs") : "/dev/shm");
        let foreign;
        try {
          foreign = await fs.mkdtemp(
            path.join(base, ".rhythm-publication-foreign-"),
          );
        } catch (error) {
          if (["ENOENT", "EACCES", "EROFS"].includes(error.code)) return;
          throw error;
        }
        try {
          if ((await fs.stat(foreign)).dev === (await fs.stat(f.root)).dev)
            return;
          const foreignFile = path.join(foreign, "synthetic"),
            input = path.join(f.directory, "cross-source");
          await fs.writeFile(foreignFile, "foreign");
          await fs.writeFile(input, "local");
          await assert.rejects(
            fs.rename(input, path.join(foreign, "destination")),
            { code: "EXDEV" },
          );
          const driver = Object.defineProperty(
            Object.create(testBinding),
            "exchange",
            {
              value: (h) => {
                const fd = sync.openSync(foreignFile, "r");
                try {
                  assert.throws(
                    () => testBinding.checkFilesystem(h, fd),
                    /Cross-filesystem/,
                  );
                } finally {
                  sync.closeSync(fd);
                }
                return {
                  status: "no-change",
                  reason:
                    "Foreign artifact refused by the production filesystem guard",
                };
              },
            },
          );
          const lease = await f.open(api.createPublicationAdapter(driver));
          assert.equal(lease.exchangeAndObserve().status, "no-change");
          assert.deepEqual(await fs.readFile(f.target), f.original);
          assert.equal(await fs.readFile(foreignFile, "utf8"), "foreign");
        } finally {
          await fs.rm(foreign, { recursive: true, force: true });
        }
      },
    ],
    [
      "candidate substitution before exchange is refused",
      async (f) => {
        const lease = await f.open();
        await fs.rename(
          slotPath(f, lease),
          path.join(f.directory, "saved-candidate"),
        );
        await fs.writeFile(slotPath(f, lease), "B");
        assert.equal(lease.exchangeAndObserve().status, "no-change");
        assert.equal(await fs.readFile(slotPath(f, lease), "utf8"), "B");
      },
    ],
    [
      "cleanup preserves unexpected slot substitution",
      async (f) => {
        const lease = await f.open();
        assert.equal(lease.exchangeAndObserve().status, "exchanged-expected");
        await fs.rename(slotPath(f, lease), path.join(f.directory, "saved-A"));
        await fs.writeFile(slotPath(f, lease), "B");
        assert.equal(
          lease.cleanupVerifiedArtifacts("committed").status,
          "cleanup-refused",
        );
        assert.equal(await fs.readFile(slotPath(f, lease), "utf8"), "B");
      },
    ],
    [
      "cleanup preserves changed rollback bytes",
      async (f) => {
        const lease = await f.open();
        await fs.writeFile(rollbackPath(f, lease), "B changed rollback");
        assert.equal(
          lease.cleanupVerifiedArtifacts("abort").status,
          "cleanup-refused",
        );
        assert.equal(
          await fs.readFile(rollbackPath(f, lease), "utf8"),
          "B changed rollback",
        );
      },
    ],
    [
      "unknown workspace entries prevent cleanup",
      async (f) => {
        const lease = await f.open(),
          unknown = path.join(f.parent, lease.record.workspace, "unknown");
        await fs.mkdir(unknown);
        assert.equal(
          lease.cleanupVerifiedArtifacts("abort").status,
          "cleanup-refused",
        );
        assert((await fs.stat(unknown)).isDirectory());
      },
    ],
    [
      "cancellation-style abort cleans only owned private artifacts",
      async (f) => {
        const lease = await f.open();
        assert.equal(lease.cleanupVerifiedArtifacts("abort").status, "cleaned");
        assert.deepEqual(await fs.readFile(f.target), f.original);
        assert.deepEqual(await fs.readdir(f.parent), ["Track.flac"]);
      },
    ],
    [
      "workspace permission or identity substitution refuses operations",
      async (f) => {
        const lease = await f.open(),
          work = path.join(f.parent, lease.record.workspace);
        await fs.chmod(work, 0o755);
        assert.equal(lease.exchangeAndObserve().status, "no-change");
        assert.equal(
          lease.cleanupVerifiedArtifacts("abort").status,
          "cleanup-refused",
        );
      },
    ],
    [
      "extended workspace ACL is rejected despite mode 0700",
      async (f) => {
        const lease = await f.open(),
          work = path.join(f.parent, lease.record.workspace);
        if (process.platform === "darwin")
          execFileSync("/bin/chmod", [
            "+a",
            `user:${userInfo().username} allow list,search,add_file,add_subdirectory`,
            work,
          ]);
        else {
          const driver = Object.defineProperty(
            Object.create(testBinding),
            "exchange",
            {
              value: (h) => {
                testBinding.injectWorkspaceAcl(h);
                return {
                  status: "no-change",
                  reason: "Injected workspace ACL",
                };
              },
            },
          );
          const injected = await f.open(api.createPublicationAdapter(driver));
          assert.equal(injected.exchangeAndObserve().status, "no-change");
          assert.equal(injected.inspectPublication().boundaryValid, false);
          assert.equal(
            injected.cleanupVerifiedArtifacts("abort").status,
            "cleanup-refused",
          );
          assert.deepEqual(await fs.readFile(f.target), f.original);
          return;
        }
        assert.equal((await fs.stat(work)).mode & 0o777, 0o700);
        assert.equal(lease.exchangeAndObserve().status, "no-change");
        assert.equal(lease.inspectPublication().boundaryValid, false);
        assert.equal(
          lease.cleanupVerifiedArtifacts("abort").status,
          "cleanup-refused",
        );
        assert.deepEqual(await fs.readFile(f.target), f.original);
      },
    ],
    [
      "interrupted exchange is inspectable after original lease closes",
      async (f) => {
        const lease = await f.open(),
          record = lease.record;
        assert.equal(lease.exchangeAndObserve().status, "exchanged-expected");
        lease.close();
        const recovered = api.inspectInterruptedPublication(
          JSON.parse(JSON.stringify(record)),
        );
        assert.equal(recovered.boundaryValid, true);
        assert.equal(recovered.target.sha256, record.candidateSha256);
        assert.equal(recovered.slot.sha256, record.originalSha256);
        assert.equal(recovered.rollback.sha256, record.originalSha256);
        const wrong = api.inspectInterruptedPublication({
          ...record,
          workspaceIdentity: { ...record.workspaceIdentity, inode: "0" },
        });
        assert.equal(wrong.status, "no-change");
      },
    ],
    [
      "post-exchange observation interruption reports recovery-required",
      async (f) => {
        const lease = await f.open(
          interleave(() => {
            throw Error("Injected interruption after exchange");
          }, true),
        );
        assert.equal(lease.exchangeAndObserve().status, "recovery-required");
        assert.deepEqual(await fs.readFile(f.target), f.candidate);
        assert.deepEqual(await fs.readFile(slotPath(f, lease)), f.original);
        assert.equal(
          lease.inspectPublication().slot.sha256,
          digest(f.original),
        );
      },
    ],
    [
      "synchronization error is propagated with evidence intact",
      async (f) => {
        const driver = Object.defineProperty(
          Object.create(testBinding),
          "sync",
          { value: (h) => testBinding.syncWithFailure(h) },
        );
        const lease = await f.open(api.createPublicationAdapter(driver));
        assert.equal(lease.exchangeAndObserve().status, "exchanged-expected");
        const outcome = lease.syncPublication();
        assert.equal(outcome.status, "sync-failed");
        assert.match(outcome.reason, /descriptor|fsync/i);
        assert.deepEqual(await fs.readFile(f.target), f.candidate);
        assert.deepEqual(await fs.readFile(slotPath(f, lease)), f.original);
      },
    ],
    [
      "lease records are snapshots and closed handles cannot mutate",
      async (f) => {
        const lease = await f.open();
        const record = lease.record;
        record.expected.inode = "0";
        record.workspace = "../outside";
        assert.notEqual(lease.record.expected.inode, "0");
        assert.equal(lease.cleanupVerifiedArtifacts("abort").status, "cleaned");
        lease.close();
        assert.throws(() => lease.exchangeAndObserve(), /closed/);
      },
    ],
    ...["prepared", "before", "after", "synced"].map((phase) => [
      `SIGKILL at ${phase} boundary retains inspectable evidence`,
      async (f) => {
        const options = await f.options();
        delete options.candidate;
        const candidate = path.join(f.directory, "candidate-input.flac"),
          manifest = path.join(f.directory, "publication-record.json");
        await fs.writeFile(candidate, f.candidate);
        const child = spawnSync(
          process.execPath,
          [
            path.resolve("scripts/publication-crash.mjs"),
            JSON.stringify(options),
            candidate,
            manifest,
            phase,
          ],
          { env: process.env, encoding: "utf8", timeout: 20000 },
        );
        assert.equal(child.error, undefined);
        assert.equal(child.signal, "SIGKILL", child.stderr);
        const record = JSON.parse(await fs.readFile(manifest, "utf8")),
          observed = api.inspectInterruptedPublication(record);
        assert.equal(observed.boundaryValid, true);
        assert.equal(
          observed.target.sha256,
          ["prepared", "before"].includes(phase)
            ? record.originalSha256
            : record.candidateSha256,
        );
        assert.equal(
          observed.slot.sha256,
          ["prepared", "before"].includes(phase)
            ? record.candidateSha256
            : record.originalSha256,
        );
        assert.equal(observed.rollback.sha256, record.originalSha256);
      },
    ]),
  ];
}
