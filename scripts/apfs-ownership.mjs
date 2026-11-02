// Phase 2C.1 research only. Never enables noowners publication in the native adapter.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { userInfo } from "node:os";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import {
  qualificationCases,
  productionQualificationCases,
  withPublicationFixture,
  fingerprint,
  digest,
} from "./lib/publication-qualification.mjs";
import { flacFixture } from "../tests/metadata-fixtures.ts";

assert.equal(
  process.platform,
  "darwin",
  "This matrix uses disposable APFS disk images on macOS only",
);
const exec = promisify(execFile),
  root = await realpath(await mkdtemp("/private/tmp/rio-apfs-study-"));
await chmod(root, 0o755); // Permit an optional second-UID actor to reach the mountpoints.
const mounted = [],
  rows = [],
  binary = path.join(root, "apfs-ownership");
const api = await import(
  pathToFileURL(path.resolve("dist/domain/publication.js"))
);
const binding = createRequire(import.meta.url)(
  "../dist/native/testing/publication.node",
);
let retained = false;
const originalTmp = process.env.TMPDIR,
  originalOther = process.env.RIO_PUBLICATION_OTHER_VOLUME;
try {
  await exec(process.env.CC || "cc", [
    "-std=c11",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-mmacosx-version-min=13.0",
    "native/qualification/apfs-ownership.c",
    "-o",
    binary,
  ]);
  for (const ownership of ["on", "off"]) {
    const image = path.join(root, `${ownership}.sparseimage`),
      volume = path.join(root, ownership);
    await mkdir(volume);
    await exec("/usr/bin/hdiutil", [
      "create",
      "-quiet",
      "-size",
      "256m",
      "-fs",
      "APFS",
      "-type",
      "SPARSE",
      "-volname",
      `Rio APFS Research ${ownership}`,
      image,
    ]);
    await exec("/usr/bin/hdiutil", [
      "attach",
      "-nobrowse",
      "-owners",
      ownership,
      "-mountpoint",
      volume,
      image,
    ]);
    mounted.push(volume);
    const raw = path.join(volume, "Raw");
    await mkdir(raw);
    const syscalls = JSON.parse((await exec(binary, [raw])).stdout);
    assert.equal(syscalls.noowners, ownership === "off");
    const aclPrivate = path.join(raw, "acl-private");
    await mkdir(aclPrivate, { mode: 0o700 });
    await writeFile(path.join(aclPrivate, "slot"), "Candidate", {
      mode: 0o600,
    });
    await exec("/bin/chmod", [
      "+a",
      `user:${userInfo().username} allow list,search,add_file,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity`,
      aclPrivate,
    ]);
    await exec("/bin/chmod", [
      "+a",
      "everyone deny list,search,add_file,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity,writesecurity",
      aclPrivate,
    ]);
    const media = path.join(volume, "Media");
    await mkdir(media);
    const target = path.join(media, "Track.flac"),
      original = flacFixture();
    await writeFile(target, original);
    const options = {
      root: media,
      rootIdentity: await fingerprint(media),
      relative: "Track.flac",
      expected: await fingerprint(target),
      originalSha256: digest(original),
      candidate: flacFixture({ entries: [["TITLE", "Candidate"]] }),
    };
    const probe = api.probePublicationSupport(options),
      opened = api.openPublicationLease(options);
    if (ownership === "on") {
      assert.equal(probe.status, "supported", probe.reason);
      assert.equal(opened.status, "ready", opened.reason);
      assert.equal(
        opened.lease.cleanupVerifiedArtifacts("abort").status,
        "cleaned",
      );
      opened.lease.close();
    } else {
      assert.equal(probe.status, "unsupported");
      assert.equal(opened.status, "unsupported");
      assert.match(opened.reason, /ownership enabled/);
      assert.deepEqual(await readFile(target), original);
      assert.deepEqual(await readdir(media), ["Track.flac"]);
    }
    rows.push({
      ownership,
      volume,
      syscalls,
      probe,
      open: { status: opened.status, reason: opened.reason },
    });
  }
  const enabled = rows[0],
    disabled = rows[1];
  process.env.TMPDIR = enabled.volume;
  process.env.RIO_PUBLICATION_OTHER_VOLUME = disabled.volume;
  const checks = [];
  for (const [name, run] of [
    ...productionQualificationCases(api),
    ...qualificationCases(api, binding),
  ]) {
    await withPublicationFixture(api, async (fixture) => {
      assert(
        fixture.directory.startsWith(enabled.volume + path.sep),
        "Qualification fixtures must remain inside the disposable APFS image",
      );
      await run(fixture);
    });
    checks.push(name);
  }
  // Coordinator integration is executed only against fixtures inside these images.
  const { Library } = await import(
    pathToFileURL(path.resolve("dist/domain/library.js"))
  );
  const { editManagedFlac, MetadataUseGate, MetadataEditInterruption } =
    await import(pathToFileURL(path.resolve("dist/domain/metadata-edit.js")));
  for (const row of rows) {
    const source = path.join(row.volume, "Source.flac");
    await writeFile(source, flacFixture());
    let l = await Library.open(path.join(row.volume, "Library"), {
      setupMediaRoot: true,
    });
    try {
      l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
      const added = await l.add([source]);
      assert.deepEqual(added.errors, []);
      const t = l.tracks()[0],
        use = new MetadataUseGate();
      use.setInUse(t.id, false);
      const edit = () =>
        editManagedFlac(
          l,
          t.id,
          { title: { action: "set", value: "Coordinator edited" } },
          { usage: use },
        );
      if (row.ownership === "off") {
        const before = await readFile(t.path);
        await assert.rejects(edit(), /ownership enabled/);
        assert.deepEqual(await readFile(t.path), before);
        assert.equal(l.tracks(t.id)[0].title, t.title);
        assert.equal(
          l.db.prepare("SELECT phase FROM metadata_edits").get().phase,
          "aborted",
        );
        row.coordinator =
          "refused before publication; bytes/DB unchanged, journal aborted";
      } else {
        const committed = await edit();
        assert.equal(committed.track.id, t.id);
        assert.equal(committed.track.path, t.path);
        for (const phase of ["staged", "published"]) {
          await assert.rejects(
            editManagedFlac(
              l,
              t.id,
              { comments: { action: "set", value: phase } },
              {
                usage: use,
                hooks: {
                  at: async (at) => {
                    if (at === phase)
                      throw new MetadataEditInterruption(
                        "Disposable research interruption",
                      );
                  },
                },
              },
            ),
            MetadataEditInterruption,
          );
          const directory = l.directory;
          l.close();
          l = await Library.open(directory, { setupMediaRoot: true });
          assert.equal(
            l.db
              .prepare(
                "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
              )
              .get().n,
            0,
          );
          assert.equal(
            l.tracks(t.id)[0].comments,
            phase === "published" ? phase : t.comments,
          );
        }
        row.coordinator =
          "same ID/path commit; pre/post-publication startup recovery passed";
      }
    } finally {
      l.close();
    }
    assert.deepEqual(await readFile(source), flacFixture());
  }
  const output = {
    platform: process.platform,
    arch: process.arch,
    productionSourceSha256: createHash("sha256")
      .update(await readFile("native/publication.cc"))
      .digest("hex"),
    nativeManifest: JSON.parse(
      await readFile("dist/native/publication-build.json", "utf8"),
    ),
    rows,
    enabledNativeChecks: checks,
    crossUid: {
      executed: false,
      reason:
        "Requires an administrator-authorized launcher; ordinary process cannot impersonate a second UID.",
    },
  };
  if (process.argv.includes("--cross-uid")) {
    const uid =
      Number((await exec("/usr/bin/id", ["-u", "nobody"])).stdout.trim()) >>> 0;
    const gid =
      Number((await exec("/usr/bin/id", ["-g", "nobody"])).stdout.trim()) >>> 0;
    assert(uid !== 0 && uid !== process.getuid());
    // No shell interpolation of caller-provided paths: root is the mkdtemp token
    // above, and the privileged C parent only forks children that drop identity.
    assert(/^\/private\/tmp\/rio-apfs-study-[A-Za-z0-9]+$/.test(root));
    const command = `${binary} actors ${root} ${uid} ${gid}`;
    const actors = await exec("/usr/bin/osascript", [
      "-e",
      `do shell script "${command}" with administrator privileges`,
    ]);
    const observations = actors.stdout
      .trim()
      .split(/[\r\n]+/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    assert.equal(observations.length, 4);
    for (const observation of observations) assert.equal(observation.uid, uid);
    for (const observation of observations.filter((o) =>
      o.path.startsWith(rows[0].volume + path.sep),
    )) {
      assert.equal(observation.entered, 0);
      assert.equal(observation.removedAcl, 0);
      assert.equal(observation.readWriteAfterAclRemoval, 0);
    }
    const plain = observations.find(
      (o) => o.path === path.join(rows[1].volume, "Raw/private"),
    );
    const acl = observations.find(
      (o) => o.path === path.join(rows[1].volume, "Raw/acl-private"),
    );
    assert.equal(plain.entered, 1);
    assert.equal(plain.reportedOwner, uid);
    assert.equal(plain.readWriteBeforeAclRemoval, 1);
    assert.equal(plain.createdEntry, 1);
    assert.equal(acl.entered, 0);
    assert.equal(acl.removedAcl, 1);
    assert.equal(acl.readWriteAfterAclRemoval, 1);
    output.crossUid = { executed: true, uid, gid, observations };
  }
  if (process.env.RIO_APFS_RESEARCH_RETAIN === "1") {
    retained = true;
    output.retainedRoot = root;
    output.actorExecutable = binary;
    console.log(JSON.stringify(output, null, 2));
  } else console.log(JSON.stringify(output, null, 2));
} finally {
  if (originalTmp === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmp;
  if (originalOther === undefined)
    delete process.env.RIO_PUBLICATION_OTHER_VOLUME;
  else process.env.RIO_PUBLICATION_OTHER_VOLUME = originalOther;
  if (!retained) {
    for (const volume of mounted.reverse())
      await exec("/usr/bin/hdiutil", ["detach", "-quiet", volume]);
    await rm(root, { recursive: true, force: true });
  }
}
