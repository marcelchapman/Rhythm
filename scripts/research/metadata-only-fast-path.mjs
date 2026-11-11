// Phase 2E.2: disposable A/B/C/D comparison; never imported by the application.
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  cp,
  symlink,
  rm,
  stat,
  realpath,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { _electron as electron } from "playwright";
import { expect } from "playwright/test";
import {
  playbackFlacFixture,
  inspectFlac,
  block,
  commentBlock,
  pictureBlock,
} from "../../tests/metadata-fixtures.ts";
import { prepareRegion, metadataRegion } from "./flac-metadata-region.mjs";
import { buildResearchNative } from "./flac-region-native.mjs";
assert.equal(process.platform, "darwin", "Local APFS research only");
const repo = await realpath(fileURLToPath(new URL("../../", import.meta.url)));
const scratch = await mkdtemp("/private/tmp/rio-2e2-");
const externalIndex = process.argv.indexOf("--external-parent");
const externalParent =
  externalIndex >= 0 ? await realpath(process.argv[externalIndex + 1]) : repo;
assert.equal(
  (await stat(externalParent)).dev,
  (await stat(repo)).dev,
  "External control must use the same volume",
);
const external = await mkdtemp(path.join(externalParent, ".rio-2e2-"));
const sha = (b) => createHash("sha256").update(b).digest("hex");
const evidence = [];
const emit = (row) => {
  evidence.push(row);
  console.log("RIO_FAST_PATH", JSON.stringify(row));
};
let app;
try {
  const variants = {};
  for (const name of ["A", "B", "C"]) {
    const resources = path.join(scratch, name);
    await mkdir(path.join(resources, "dist/native"), { recursive: true });
    await cp(
      path.join(repo, "dist/domain"),
      path.join(resources, "dist/domain"),
      { recursive: true },
    );
    await cp(
      path.join(repo, "dist/shared"),
      path.join(resources, "dist/shared"),
      { recursive: true },
    );
    await writeFile(path.join(resources, "package.json"), '{"type":"module"}');
    await symlink(
      path.join(repo, "node_modules"),
      path.join(resources, "node_modules"),
      "dir",
    );
    if (name !== "A") {
      const writer = path.join(resources, "dist/domain/metadata-writer.js");
      const before = await readFile(writer, "utf8");
      assert(before.includes('from "./flac-taglib.js"'));
      await writeFile(
        writer,
        before.replace(
          'from "./flac-taglib.js"',
          `from ${JSON.stringify(new URL("./flac-metadata-region.mjs", import.meta.url).href)}`,
        ),
      );
    }
    await buildResearchNative(
      repo,
      path.join(resources, "dist/native"),
      name === "C",
    );
    variants[name] = resources;
    assert.equal(
      sha(await readFile(path.join(resources, "dist/domain/metadata-edit.js"))),
      sha(await readFile(path.join(repo, "dist/domain/metadata-edit.js"))),
    );
  }
  const largeIndex = process.argv.indexOf("--large");
  const large =
    largeIndex >= 0 ? await readFile(process.argv[largeIndex + 1]) : null;
  if (large)
    assert(large.length > 25 * 1024 * 1024 && large.length < 64 * 1024 * 1024);
  const originalLarge = large && sha(large);
  const fixtures = [];
  for (const size of large ? ["small", "large"] : ["small"])
    for (const padding of [0, 65536]) {
      const base =
        size === "large"
          ? large
          : playbackFlacFixture([["TITLE", "Small"]], 30);
      const parsed = inspectFlac(base);
      const blocks = [
        ...parsed.blocks.filter(
          (b) => b.type !== 1 && b.type !== 4 && b.type !== 6,
        ),
        {
          type: 4,
          body: commentBlock([
            ["TITLE", "Disposable"],
            ["ARTIST", "Generated"],
            ["GENRE", "Original"],
            ["RIO_UNKNOWN", "Preserve raw ü 音楽"],
          ]),
        },
        {
          type: 2,
          body: Buffer.from("RIOX-opaque-unrecognized-application-data"),
        },
        { type: 6, body: pictureBlock() },
        ...(padding ? [{ type: 1, body: Buffer.alloc(padding) }] : []),
      ];
      const bytes = Buffer.concat([
        Buffer.from("fLaC"),
        ...blocks.map((b, i) => block(b.type, b.body, i === blocks.length - 1)),
        parsed.audio,
      ]);
      const filename = path.join(scratch, `${size}-${padding}.flac`);
      await writeFile(filename, bytes);
      const decoded = execFileSync(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-xerror",
          "-i",
          filename,
          "-map",
          "0:a:0",
          "-f",
          "hash",
          "-hash",
          "md5",
          "-",
        ],
        { encoding: "utf8" },
      ).trim();
      fixtures.push({
        size,
        padding,
        filename,
        bytes: bytes.length,
        sha: sha(bytes),
        audio: sha(parsed.audio),
        decoded,
      });
    }
  // Bounded-header and malformed-input tests are independent of native publication.
  for (const f of fixtures) {
    const bytes = await readFile(f.filename),
      original = metadataRegion(bytes);
    const growth = prepareRegion(bytes, new Map([["GENRE", "G".repeat(400)]]));
    assert.equal(growth.fits, f.padding > 0);
    assert.equal(growth.audioBytesProcessed, 0);
    const changed = Buffer.concat([
      growth.prefix,
      bytes.subarray(original.audioOffset),
    ]);
    assert.equal(sha(inspectFlac(changed).audio), f.audio);
    const shrink = prepareRegion(changed, new Map([["GENRE", "J"]]));
    assert(shrink.fits);
    assert.equal(shrink.newAudioOffset, growth.newAudioOffset);
    const noOp = prepareRegion(bytes, new Map());
    assert(noOp.prefix.equals(original.prefix));
  }
  const malformed = [];
  const valid = await readFile(fixtures[0].filename);
  malformed.push(
    Buffer.from("not flac"),
    valid.subarray(0, 6),
    valid.subarray(0, 44),
  );
  const duplicate = Buffer.concat([
    Buffer.from("fLaC"),
    block(0, inspectFlac(valid).blocks[0].body),
    block(4, commentBlock([])),
    block(4, commentBlock([]), true),
    inspectFlac(valid).audio,
  ]);
  malformed.push(duplicate);
  for (const bytes of malformed)
    assert.throws(() => prepareRegion(bytes, new Map([["TITLE", "X"]])));
  for (const [value, fits] of [
    ["Origina", false],
    ["Origin", false],
    ["Origi", false],
    ["Orig", true],
  ]) {
    assert.equal(
      prepareRegion(valid, new Map([["GENRE", value]])).fits,
      fits,
      "A new PADDING header needs four bytes",
    );
  }
  emit({
    event: "planner-tests",
    fixtures: fixtures.length,
    malformedRejected: malformed.length,
    artworkAndOpaqueBlocksPreserved: true,
  });

  await mkdir(path.join(scratch, "Profile"));
  app = await electron.launch({
    args: [repo],
    env: {
      ...process.env,
      RIO_DATA_DIR: path.join(scratch, "Profile"),
      RIO_METADATA_TIMING: "1",
    },
    timeout: 30000,
  });
  const traces = new Map();
  let active;
  createInterface({ input: app.process().stdout }).on("line", (line) => {
    if (line.startsWith("RIO_LAB_BEGIN ")) active = line.slice(14);
    else if (line.startsWith("RIO_METADATA_NATIVE ") && active)
      traces.get(active)?.native.push(JSON.parse(line.slice(20)));
    else if (line.startsWith("RIO_LAB_END ")) {
      traces.get(line.slice(12))?.resolve();
      active = undefined;
    }
  });
  app.process().stderr.on("data", (b) => {
    if (process.env.RIO_FAST_DEBUG) process.stderr.write(b);
  });
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  await app.evaluate(({ app }) => {
    if (app.isPackaged) throw Error("Research requires source app");
  });
  let serial = 0;
  const repeats = process.argv.includes("--qualification-only")
    ? 0
    : process.argv.includes("--quick")
      ? 1
      : 2;
  for (const strategy of ["staged", "in-place"])
    for (const fixture of fixtures)
      for (const variant of ["A", "B", "C"])
        for (let repeat = 0; repeat < repeats; repeat++) {
          const token = String(++serial);
          const directory = path.join(
            strategy === "staged" ? scratch : external,
            `library-${token}`,
          );
          const native = [];
          let resolve;
          const done = new Promise((r) => (resolve = r));
          traces.set(token, { native, resolve });
          const result = await app.evaluate(
            async (
              _,
              { repo, resources, directory, source, token, regionModule },
            ) => {
              const require = process
                .getBuiltinModule("module")
                .createRequire(resources + "/dist/domain/library.js");
              const { Library } = require(
                resources + "/dist/domain/library.js",
              );
              const { editManagedFlac } = require(
                resources + "/dist/domain/metadata-edit.js",
              );
              const { PlaybackUse } = require(
                repo + "/dist/main/playback-use.js",
              );
              const region = require(regionModule),
                fs = process.getBuiltinModule("fs/promises");
              const l = await Library.open(directory, { setupMediaRoot: true });
              const use = new PlaybackUse();
              use.bindLibrary(l);
              use.allowOwner(123);
              try {
                l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
                const added = await l.add([source]);
                if (added.errors.length)
                  throw Error(JSON.stringify(added.errors));
                const track = l.tracks()[0];
                l.favorite(track.id);
                l.createPlaylist("Preserved", [track.id]);
                l.saveState({ ...l.state(), queue: [track.id] });
                const readStarted = performance.now();
                const prefix = await region.readMetadataRegion(track.path);
                const readMs = performance.now() - readStarted;
                const plannedAt = performance.now();
                const plan = region.prepareRegion(
                  prefix.prefix,
                  new Map([["GENRE", "G".repeat(400)]]),
                );
                const planMs = performance.now() - plannedAt;
                const stages = {},
                  details = [];
                let selected;
                console.log("RIO_LAB_BEGIN " + token);
                const started = performance.now();
                let editError;
                const edited = await editManagedFlac(
                  l,
                  track.id,
                  { genre: { action: "set", value: "G".repeat(400) } },
                  {
                    usage: use.usageFor(l),
                    timing: (stage, detail) => {
                      if (detail) {
                        details.push({ category: stage, ...detail });
                        if (stage === "publication") selected = detail.strategy;
                      } else stages[stage] = performance.now() - started;
                    },
                  },
                ).catch((error) => {
                  editError = String(error);
                });
                const wallMs = performance.now() - started;
                console.log("RIO_LAB_END " + token);
                if (editError) {
                  const journal = l.db
                    .prepare(
                      "SELECT journal FROM metadata_edits WHERE trackId=? ORDER BY createdAt DESC LIMIT 1",
                    )
                    .get(track.id);
                  const expected = journal
                    ? JSON.parse(journal.journal).original
                    : {};
                  const current = await fs.lstat(track.path, { bigint: true });
                  const actual = {
                    device: String(current.dev),
                    inode: String(current.ino),
                    size: String(current.size),
                    links: String(current.nlink),
                    mode: String(current.mode),
                    uid: String(current.uid),
                    gid: String(current.gid),
                    mtimeNs: String(current.mtimeNs),
                    ctimeNs: String(current.ctimeNs),
                  };
                  const crypto = process.getBuiltinModule("crypto");
                  const hash = (b) =>
                    crypto.createHash("sha256").update(b).digest("hex");
                  return {
                    error: editError,
                    selected,
                    wallMs,
                    originalPreserved:
                      hash(await fs.readFile(track.path)) ===
                      hash(await fs.readFile(source)),
                    fingerprintDifferences: Object.keys(actual)
                      .filter((key) => actual[key] !== expected[key])
                      .map((key) => ({
                        key,
                        expected: expected[key],
                        actual: actual[key],
                      })),
                  };
                }
                if (!["committed", "reconciled"].includes(edited.status))
                  throw Error("Save did not commit");
                if (
                  edited.track.id !== track.id ||
                  edited.track.path !== track.path
                )
                  throw Error("Track identity changed");
                if (
                  !l.tracks()[0].favorite ||
                  l.playlists()[0].trackIds[0] !== track.id ||
                  l.state().queue[0] !== track.id
                )
                  throw Error("Relationships changed");
                if (
                  l.db
                    .prepare(
                      "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
                    )
                    .get().n
                )
                  throw Error("Pending journal");
                const after = await fs.readFile(track.path);
                const metadata = region.metadataRegion(after);
                return {
                  wallMs,
                  selected,
                  stages,
                  details,
                  sourceBytes: (await fs.stat(source)).size,
                  candidateBytes: after.length,
                  actualAudioOffset: metadata.audioOffset,
                  raw: {
                    readMs,
                    planMs,
                    metadataBytesRead: prefix.audioOffset,
                    audioBytesProcessed: 0,
                    fits: plan.fits,
                    oldOffset: plan.oldAudioOffset,
                    newOffset: plan.newAudioOffset,
                  },
                  file: track.path,
                };
              } finally {
                l.close();
              }
            },
            {
              repo,
              resources: variants[variant],
              directory,
              source: fixture.filename,
              token,
              regionModule: fileURLToPath(
                new URL("./flac-metadata-region.mjs", import.meta.url),
              ),
            },
          );
          await done;
          assert.equal(result.selected, strategy);
          if (result.error) {
            emit({
              event: "benchmark-refused",
              variant,
              strategy,
              fixture: fixture.size,
              padding: fixture.padding,
              repeat,
              ...result,
            });
            assert(
              result.originalPreserved &&
                /fingerprint changed before writing/.test(result.error),
              "Unexpected study failure",
            );
            traces.delete(token);
            await rm(directory, { recursive: true, force: true });
            continue;
          }
          const candidate = await readFile(result.file);
          assert.equal(sha(inspectFlac(candidate).audio), fixture.audio);
          const decode = execFileSync(
            "ffmpeg",
            [
              "-nostdin",
              "-v",
              "error",
              "-xerror",
              "-i",
              result.file,
              "-map",
              "0:a:0",
              "-f",
              "hash",
              "-hash",
              "md5",
              "-",
            ],
            { encoding: "utf8" },
          ).trim();
          assert.equal(decode, fixture.decoded);
          delete result.file;
          const s = result.stages;
          const row = {
            event: "benchmark",
            variant,
            strategy,
            fixture: fixture.size,
            padding: fixture.padding,
            repeat,
            bytes: fixture.bytes,
            ...result,
            logicalNativeWriteBytes: native.reduce(
              (n, r) => n + r.logicalWriteBytes,
              0,
            ),
            native,
            actualIdleLeaseMs: s["release-done"] - s["playback-gate-acquired"],
            prospectivePublicationTailMs:
              s["release-done"] - s["revalidate-start"],
            workerFrameParseMs: result.details
              .filter(
                (d) => d.category === "worker" && /frame-parse/.test(d.stage),
              )
              .reduce((n, d) => n + d.wallMs, 0),
            journalMs: s.preflight - s["journal-insert-start"],
            dbCommitMs: s["db-commit"] - s["sqlite-commit-start"],
            reconciliationMs: s.reconcile - s["db-commit"],
          };
          emit(row);
          traces.delete(token);
          await rm(directory, { recursive: true, force: true });
        }
  // Existing semantic validation + all thirteen fields stay in Rio's writer.
  const validation = await app.evaluate(
    async (_, { a, b, source }) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(a + "/dist/domain/metadata-writer.js");
      const original = require(a + "/dist/domain/metadata-writer.js"),
        research = require(b + "/dist/domain/metadata-writer.js");
      const fs = process.getBuiltinModule("fs/promises"),
        bytes = await fs.readFile(source);
      const values = {
        title: "New title",
        artist: "New artist",
        album: "New album",
        albumArtist: "Album artist",
        composer: "Composer",
        genre: "Jazz",
        year: 2026,
        trackNumber: 3,
        trackTotal: 12,
        discNumber: 2,
        discTotal: 4,
        bpm: 99,
        comments: "Notes",
      };
      const set = Object.fromEntries(
        Object.entries(values).map(([key, value]) => [
          key,
          { action: "set", value },
        ]),
      );
      const candidate = await research.prepareFlacMetadataEdit(bytes, set);
      await original.verifyFlacMetadataCandidate(
        bytes,
        candidate.candidate,
        set,
      );
      const clear = Object.fromEntries(
        Object.keys(values).map((key) => [key, { action: "clear" }]),
      );
      const cleared = await research.prepareFlacMetadataEdit(
        candidate.candidate,
        clear,
      );
      await original.verifyFlacMetadataCandidate(
        candidate.candidate,
        cleared.candidate,
        clear,
      );
      let rejected = 0;
      for (const data of [
        bytes.subarray(0, bytes.length - 1),
        Buffer.concat([
          bytes.subarray(0, bytes.length - 1),
          Buffer.from([bytes.at(-1) ^ 1]),
        ]),
      ]) {
        try {
          await research.prepareFlacMetadataEdit(data, {
            genre: { action: "set", value: "X" },
          });
        } catch {
          rejected++;
        }
      }
      if (rejected !== 2)
        throw Error("Malformed/truncated frames were accepted");
      return {
        fields: Object.keys(values).length,
        originalVerifierAccepted: true,
        malformedFramesRejected: rejected,
      };
    },
    {
      a: variants.A,
      b: variants.B,
      source: fixtures.find((f) => f.size === "small").filename,
    },
  );
  emit({ event: "compatibility", ...validation });
  const geometry = await app.evaluate(
    async (_, { resources, sources, regionModule }) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(resources + "/dist/domain/metadata-writer.js");
      const writer = require(resources + "/dist/domain/metadata-writer.js"),
        region = require(regionModule),
        fs = process.getBuiltinModule("fs/promises"),
        rows = [];
      for (const source of sources) {
        const input = await fs.readFile(source.filename),
          before = region.metadataRegion(input);
        const candidate = await writer.prepareFlacMetadataEdit(input, {
          genre: { action: "set", value: "G".repeat(400) },
        });
        const after = region.metadataRegion(candidate.candidate);
        rows.push({
          fixture: source.size,
          padding: source.padding,
          originalOffset: before.audioOffset,
          candidateOffset: after.audioOffset,
          existingQualifiedWriterPrefixEligible:
            input.length === candidate.candidate.length &&
            before.audioOffset === after.audioOffset,
        });
      }
      return rows;
    },
    {
      resources: variants.A,
      sources: fixtures.map((f) => ({
        filename: f.filename,
        size: f.size,
        padding: f.padding,
      })),
      regionModule: fileURLToPath(
        new URL("./flac-metadata-region.mjs", import.meta.url),
      ),
    },
  );
  emit({ event: "existing-writer-geometry", fixtures: geometry });
  for (const strategy of ["staged", "in-place"]) {
    const directory = path.join(
      strategy === "staged" ? scratch : external,
      "sequence",
    );
    const fixture = fixtures.find(
      (f) => f.size === "small" && f.padding === 65536,
    );
    const row = await app.evaluate(
      async (_, { repo, resources, directory, source, regionModule }) => {
        const require = process
          .getBuiltinModule("module")
          .createRequire(resources + "/dist/domain/library.js");
        const { Library } = require(resources + "/dist/domain/library.js"),
          { editManagedFlac } = require(
            resources + "/dist/domain/metadata-edit.js",
          );
        const { PlaybackUse } = require(repo + "/dist/main/playback-use.js"),
          fs = process.getBuiltinModule("fs/promises"),
          crypto = process.getBuiltinModule("crypto"),
          region = require(regionModule);
        const hash = (b) => crypto.createHash("sha256").update(b).digest("hex");
        const l = await Library.open(directory, { setupMediaRoot: true }),
          use = new PlaybackUse();
        use.bindLibrary(l);
        try {
          l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
          const added = await l.add([source]);
          if (added.errors.length) throw Error(JSON.stringify(added.errors));
          const track = l.tracks()[0];
          const initial = await fs.readFile(track.path),
            originalOffset = region.metadataRegion(initial).audioOffset,
            audio = hash(initial.subarray(originalOffset));
          for (const value of [
            "G".repeat(400),
            "J",
            "K".repeat(300),
            null,
            "L".repeat(400),
          ]) {
            await editManagedFlac(
              l,
              track.id,
              {
                genre:
                  value === null
                    ? { action: "clear" }
                    : { action: "set", value },
              },
              { usage: use.usageFor(l) },
            );
            const bytes = await fs.readFile(track.path),
              offset = region.metadataRegion(bytes).audioOffset;
            if (
              hash(bytes.subarray(offset)) !== audio ||
              offset !== originalOffset
            )
              throw Error("Sequence moved/changed audio");
          }
          const before = await fs.readFile(track.path),
            time = (await fs.stat(track.path, { bigint: true })).mtimeNs;
          const noOp = await editManagedFlac(
            l,
            track.id,
            { genre: { action: "set", value: "L".repeat(400) } },
            { usage: use.usageFor(l) },
          );
          if (
            noOp.status !== "no-change" ||
            hash(await fs.readFile(track.path)) !== hash(before) ||
            (await fs.stat(track.path, { bigint: true })).mtimeNs !== time
          )
            throw Error("No-op rewrote target");
          return {
            edits: 5,
            growthShrinkClearAndRepeat: true,
            audioOffsetPreserved: true,
            noOpPreservedBytesAndMtime: true,
          };
        } finally {
          l.close();
        }
      },
      {
        repo,
        resources: variants.C,
        directory,
        source: fixture.filename,
        regionModule: fileURLToPath(
          new URL("./flac-metadata-region.mjs", import.meta.url),
        ),
      },
    );
    emit({ event: "sequence", strategy, ...row });
    await rm(directory, { recursive: true, force: true });
  }
  // Faults remain in disposable native copies. Recovery uses A's ORIGINAL
  // coordinator/writer, proving that no new journal interpretation is required.
  for (const strategy of ["staged", "in-place"])
    for (const fault of strategy === "staged"
      ? [
          "before-publication",
          "after-exchange",
          "after-publication",
          "stale-source",
        ]
      : [
          "before-publication",
          "during-region",
          "after-write",
          "after-publication",
          "stale-source",
        ]) {
      const token = String(++serial),
        directory = path.join(
          strategy === "staged" ? scratch : external,
          `fault-${token}`,
        );
      const fixture = fixtures.find(
        (f) => f.size === "small" && f.padding === 65536,
      );
      const row = await app.evaluate(
        async (
          _,
          {
            repo,
            resources,
            recoveryResources,
            directory,
            source,
            fault,
            regionModule,
          },
        ) => {
          const require = process
            .getBuiltinModule("module")
            .createRequire(resources + "/dist/domain/library.js");
          const { Library } = require(resources + "/dist/domain/library.js"),
            core = require(resources + "/dist/domain/metadata-edit.js");
          const { Library: RecoveryLibrary } = require(
            recoveryResources + "/dist/domain/library.js",
          );
          const { PlaybackUse } = require(repo + "/dist/main/playback-use.js");
          const fs = process.getBuiltinModule("fs/promises"),
            crypto = process.getBuiltinModule("crypto"),
            region = require(regionModule);
          const hash = (b) =>
            crypto.createHash("sha256").update(b).digest("hex");
          const l = await Library.open(directory, { setupMediaRoot: true });
          const use = new PlaybackUse();
          use.bindLibrary(l);
          use.allowOwner(123);
          let track, before, originalOffset, result, error, injected;
          try {
            l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
            const added = await l.add([source]);
            if (added.errors.length) throw Error(JSON.stringify(added.errors));
            track = l.tracks()[0];
            before = await fs.readFile(track.path);
            originalOffset = region.metadataRegion(before).audioOffset;
            if (
              ["during-region", "after-write", "after-exchange"].includes(fault)
            )
              process.env.RIO_RESEARCH_FAULT = fault;
            try {
              result = await core.editManagedFlac(
                l,
                track.id,
                { genre: { action: "set", value: "F".repeat(400) } },
                {
                  usage: use.usageFor(l),
                  hooks: {
                    at: async (phase) => {
                      if (
                        fault === "before-publication" &&
                        phase === "before-publish"
                      )
                        throw new core.MetadataEditInterruption(
                          "Disposable before-publication stop",
                        );
                      if (
                        fault === "after-publication" &&
                        phase === "published"
                      )
                        throw new core.MetadataEditInterruption(
                          "Disposable post-publication stop",
                        );
                      if (
                        fault === "stale-source" &&
                        phase === "before-publish"
                      ) {
                        injected = Buffer.from(before);
                        injected[originalOffset + 20] ^= 1;
                        const h = await fs.open(track.path, "r+");
                        try {
                          await h.write(
                            injected.subarray(
                              originalOffset + 20,
                              originalOffset + 21,
                            ),
                            0,
                            1,
                            originalOffset + 20,
                          );
                        } finally {
                          await h.close();
                        }
                      }
                    },
                  },
                },
              );
            } catch (e) {
              error = String(e);
            } finally {
              delete process.env.RIO_RESEARCH_FAULT;
            }
          } finally {
            l.close();
          }
          const recovered = await RecoveryLibrary.open(directory, {
            setupMediaRoot: true,
          });
          try {
            const current = recovered.tracks()[0],
              actual = await fs.readFile(track.path);
            return {
              fault,
              error,
              status: result?.status,
              pending: recovered.db
                .prepare(
                  "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
                )
                .get().n,
              originalPreserved: hash(actual) === hash(before),
              encodedRegionPreserved:
                hash(actual.subarray(originalOffset)) ===
                hash(before.subarray(originalOffset)),
              injectedChangePreserved: injected
                ? hash(actual) === hash(injected)
                : undefined,
              missing: current.missing,
              genre: current.genre,
              mediaPathAvailable: !!recovered.media(track.id),
              idPreserved: current.id === track.id,
              pathPreserved: current.path === track.path,
            };
          } finally {
            recovered.close();
          }
        },
        {
          repo,
          resources: variants.C,
          recoveryResources: variants.A,
          directory,
          source: fixture.filename,
          fault,
          regionModule: fileURLToPath(
            new URL("./flac-metadata-region.mjs", import.meta.url),
          ),
        },
      );
      assert(row.idPreserved && row.pathPreserved);
      if (fault === "stale-source") {
        assert(row.error);
        assert(row.injectedChangePreserved);
        if (strategy === "staged") {
          assert(row.pending > 0);
          assert(!row.mediaPathAvailable);
        } else {
          assert.equal(row.pending, 0);
          assert(row.missing);
        }
      } else if (fault === "during-region") {
        assert(row.error);
        assert(row.encodedRegionPreserved);
        assert(row.missing);
        assert.equal(row.pending, 0);
      } else if (fault === "before-publication") {
        assert(row.originalPreserved);
        assert.equal(row.pending, 0);
      } else {
        assert.equal(row.genre, "F".repeat(400));
        assert.equal(row.pending, 0);
        assert(!row.missing);
      }
      delete row.genre;
      emit({ event: "fault", strategy, ...row });
      await rm(directory, { recursive: true, force: true });
    }
  // Real production preload/main/protocol/decoder reacquisition AFTER C commits.
  // This is a failure/retry check, not a new concurrent-playback implementation.
  const playbackDirectory = path.join(external, "playback-reacquisition");
  const playback = await app.evaluate(
    async (
      { dialog, Menu, ipcMain },
      { repo, resources, directory, source },
    ) => {
      const require = process
        .getBuiltinModule("module")
        .createRequire(resources + "/dist/domain/library.js");
      const { Library } = require(resources + "/dist/domain/library.js"),
        { editManagedFlac } = require(
          resources + "/dist/domain/metadata-edit.js",
        ),
        { PlaybackUse } = require(repo + "/dist/main/playback-use.js");
      const l = await Library.open(directory, { setupMediaRoot: true }),
        use = new PlaybackUse();
      use.bindLibrary(l);
      let track;
      try {
        l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
        const added = await l.add([source]);
        if (added.errors.length) throw Error(JSON.stringify(added.errors));
        track = l.tracks()[0];
        await editManagedFlac(
          l,
          track.id,
          { genre: { action: "set", value: "Playback recovery" } },
          { usage: use.usageFor(l) },
        );
        l.saveState({
          ...l.state(),
          view: "Songs",
          queue: [track.id],
          currentId: null,
        });
      } finally {
        l.close();
      }
      const original = ipcMain._invokeHandlers.get("playback:acquire");
      let once = true;
      ipcMain.removeHandler("playback:acquire");
      ipcMain.handle("playback:acquire", async (...args) => {
        if (once && args[1] === track.id) {
          once = false;
          throw Error("Disposable playback reacquisition failure");
        }
        return original(...args);
      });
      globalThis.restoreResearchAcquisition = () => {
        ipcMain.removeHandler("playback:acquire");
        ipcMain.handle("playback:acquire", original);
      };
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [directory],
      });
      Menu.getApplicationMenu()
        .items.find((i) => i.label === "File")
        .submenu.items.find((i) => i.label === "Choose Library…")
        .click();
      return { id: track.id, path: track.path };
    },
    {
      repo,
      resources: variants.C,
      directory: playbackDirectory,
      source: fixtures.find((f) => f.size === "small" && f.padding === 65536)
        .filename,
    },
  );
  const publishedHash = sha(await readFile(playback.path));
  const row = page.locator(`.song-row[data-track-id="${playback.id}"]`);
  await row.getByRole("button", { name: /^Play / }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(page.locator("audio")).not.toHaveAttribute("src", /.+/);
  await app.evaluate(
    (_, { repo, id }) => {
      const require = process
          .getBuiltinModule("module")
          .createRequire(repo + "/dist/main/playback-use.js"),
        { playbackUse } = require(repo + "/dist/main/playback-use.js");
      const lease = playbackUse
        .usageFor(playbackUse.currentLibrary)
        .acquireIdle(id);
      lease.assertIdle();
      lease.release();
    },
    { repo, id: playback.id },
  );
  await app.evaluate(() => globalThis.restoreResearchAcquisition());
  await row.getByRole("button", { name: /^Play / }).click();
  await page.waitForFunction((id) => {
    const audio = document.querySelector("audio");
    return (
      audio.currentSrc &&
      new URL(audio.currentSrc).pathname.slice(1) === id &&
      !audio.paused &&
      audio.readyState >= 3 &&
      audio.currentTime > 0.1
    );
  }, playback.id);
  assert.equal(sha(await readFile(playback.path)), publishedHash);
  assert.equal(
    (await page.evaluate(() => window.rio.snapshot())).tracks[0].genre,
    "Playback recovery",
  );
  emit({
    event: "playback-reacquisition",
    publicationRetainedAfterFailure: true,
    releasedAfterFailure: true,
    realDecoderRetryPassed: true,
  });
  for (const f of fixtures)
    assert.equal(sha(await readFile(f.filename)), f.sha);
  if (large)
    assert.equal(
      sha(await readFile(process.argv[largeIndex + 1])),
      originalLarge,
    );
  emit({
    event: "complete",
    passed: true,
    benchmarks: evidence.filter((r) => r.event === "benchmark").length,
    benchmarkRefusals: evidence.filter((r) => r.event === "benchmark-refused")
      .length,
  });
} finally {
  await app?.close();
  await rm(external, { recursive: true, force: true });
  await rm(scratch, { recursive: true, force: true });
}
