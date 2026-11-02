// Research-only observations of generated FLACs. Never touches a real library.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import * as sync from "node:fs";
import { gzipSync } from "node:zlib";
import { parseFile } from "music-metadata";
import {
  playbackFlacFixture,
  inspectFlac,
} from "../../tests/metadata-fixtures.ts";

const [command, input, label] = process.argv.slice(2);
const hash = (b) => createHash("sha256").update(b).digest("hex");
const exec = (p, args) => execFileSync(p, args, { encoding: "utf8" });
if (command === "setup") {
  assert.equal(process.platform, "darwin");
  const root = await fs.realpath(
    await fs.mkdtemp("/private/tmp/rio-pac-publication-"),
  );
  await fs.mkdir(path.join(root, "observations"));
  const entries = [
    ["TITLE", "Rio disposable original"],
    ["ARTIST", "Rio Study Artist"],
    ["ALBUM", "Rio Publication Study"],
    ["COMMENT", "Disposable synthetic FLAC; no user media"],
  ];
  const bytes = playbackFlacFixture(entries);
  for (const mode of ["on", "off"]) {
    const volume = path.join(root, mode);
    await fs.mkdir(volume);
    exec("/usr/bin/hdiutil", [
      "create",
      "-quiet",
      "-size",
      "512m",
      "-fs",
      "APFS",
      "-type",
      "SPARSE",
      "-volname",
      `Rio PAC Study ${mode}`,
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
    await fs.mkdir(path.join(volume, "Media"));
    for (const name of [
      "Baseline",
      "Growth",
      "Rename",
      "Replace",
      "ExternalTags",
      "Remove",
    ])
      await fs.writeFile(path.join(volume, "Media", `${name}.flac`), bytes);
  }
  await fs.writeFile(
    path.join(root, "study.json"),
    JSON.stringify(
      {
        root,
        fixture: {
          duration: 30,
          sampleRate: 48000,
          channels: 2,
          bits: 16,
          bytes: bytes.length,
          sha256: hash(bytes),
          audioSha256: hash(inspectFlac(bytes).audio),
          entries,
        },
        production: {
          source: hash(await fs.readFile("native/publication.cc")),
          binary: hash(await fs.readFile("dist/native/publication.node")),
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(root);
} else {
  const root = await fs.realpath(input);
  assert.match(root, /^\/private\/tmp\/rio-pac-publication-[A-Za-z0-9]+$/);
  const observations = path.join(root, "observations");
  const names = async () => {
    const rows = [];
    for (const mode of ["on", "off"]) {
      const media = path.join(root, mode, "Media");
      for (const name of (await fs.readdir(media)).sort())
        rows.push(path.join(media, name));
    }
    return rows;
  };
  if (command === "report") {
    const load = async (n) =>
      JSON.parse(
        await fs.readFile(path.join(observations, n + ".json"), "utf8"),
      );
    const labels = [
      "before",
      "loaded",
      "baseline-off",
      "controls",
      "growth-off",
      "renamed",
      "replacement-before-save",
      "replacement-after-save",
      "external-before-save",
      "external-after-save",
      "removed",
      "interruption-before",
      "interruption-after",
      "restart",
    ];
    const snapshots = Object.fromEntries(
      await Promise.all(labels.map(async (n) => [n, await load(n)])),
    );
    const row = (label, relative) =>
      snapshots[label].rows.find((r) => r.path === path.join(root, relative));
    const normal = [
      {
        name: "baseline-off",
        relative: "off/Media/Baseline.flac",
        before: "loaded",
        after: "baseline-off",
        title: "PAC noowners baseline",
        thread: "1337793",
      },
      {
        name: "baseline-on",
        relative: "on/Media/Baseline.flac",
        before: "before",
        after: "controls",
        title: "PAC owners baseline",
        thread: "1339938",
      },
      {
        name: "growth-on",
        relative: "on/Media/Growth.flac",
        before: "before",
        after: "controls",
        title: "PAC owners growth",
        thread: "1340850",
      },
      {
        name: "growth-off",
        relative: "off/Media/Growth.flac",
        before: "before",
        after: "growth-off",
        title: "PAC noowners growth",
        thread: "1342165",
      },
    ];
    const raw = await fs.readFile(
        path.join(observations, "saves.fs-usage.txt"),
        "utf8",
      ),
      lines = raw.split("\n");
    const operations = (thread) => {
      const selected = lines.filter((l) => l.endsWith("." + thread));
      const counts = {};
      for (const l of selected) {
        const op = l.trim().split(/\s+/)[1];
        counts[op] = (counts[op] ?? 0) + 1;
      }
      return { thread, counts, first: selected[0], last: selected.at(-1) };
    };
    const results = normal.map((t) => {
      const before = row(t.before, t.relative),
        after = row(t.after, t.relative);
      assert.equal(after.inode, before.inode);
      assert.equal(after.device, before.device);
      assert.equal(after.audioSha256, before.audioSha256);
      assert.equal(after.decode.stdout, before.decode.stdout);
      assert.equal(after.decode.status, 0);
      assert.equal(after.decode.stderr, "");
      assert.equal(after.metadata.common.title, t.title);
      return { ...t, before, after, sequence: operations(t.thread) };
    });
    const renamed = row("renamed", "off/Media/Renamed.flac");
    assert.equal(renamed.sha256, row("before", "off/Media/Rename.flac").sha256);
    assert(!row("renamed", "off/Media/Rename.flac"));
    const replacementBefore = row(
        "replacement-before-save",
        "off/Media/Replace.flac",
      ),
      replacementAfter = row(
        "replacement-after-save",
        "off/Media/Replace.flac",
      );
    assert.notEqual(
      replacementBefore.inode,
      row("before", "off/Media/Replace.flac").inode,
    );
    assert.equal(replacementAfter.inode, replacementBefore.inode);
    assert.equal(
      replacementAfter.metadata.common.title,
      "PAC replacement save",
    );
    assert.equal(replacementAfter.metadata.common.artist, "Rio Study Artist");
    assert.equal(
      row("replacement-after-save", "off/Media/Replace-original.flac").sha256,
      row("replacement-before-save", "off/Media/Replace-original.flac").sha256,
    );
    const externalBefore = row(
        "external-before-save",
        "off/Media/ExternalTags.flac",
      ),
      externalAfter = row("external-after-save", "off/Media/ExternalTags.flac");
    assert.equal(externalAfter.inode, externalBefore.inode);
    assert.equal(externalAfter.metadata.common.title, "PAC cached tags save");
    assert.equal(externalAfter.metadata.common.artist, "Rio Study Artist");
    assert(!row("removed", "off/Media/Remove.flac"));
    const before = row("interruption-before", "off/Media/Interruption.flac"),
      after = row("interruption-after", "off/Media/Interruption.flac"),
      restart = row("restart", "off/Media/Interruption.flac");
    assert.equal(before.inode, after.inode);
    assert.equal(before.size, after.size);
    assert.notEqual(before.audioSha256, after.audioSha256);
    assert.notEqual(before.decode.stdout, after.decode.stdout);
    assert.match(after.decode.stderr, /decode_frame\(\) failed/);
    assert.equal(after.sha256, restart.sha256);
    const study = await load("../study");
    assert.equal(
      hash(await fs.readFile("native/publication.cc")),
      study.production.source,
    );
    assert.equal(
      hash(await fs.readFile("dist/native/publication.node")),
      study.production.binary,
    );
    const workerIds = [
      ...normal.map((x) => x.thread),
      "1343712",
      "1344832",
      "1345943",
      "1346639",
      "1350977",
    ];
    const selected =
      lines
        .filter(
          (l) =>
            l.includes(root) || workerIds.some((id) => l.endsWith("." + id)),
        )
        .join("\n") + "\n";
    const destination = "docs/studies/evidence";
    await fs.mkdir(destination, { recursive: true });
    const traceName = "pro-audio-converter-saves.fs-usage.txt.gz";
    await fs.writeFile(path.join(destination, traceName), gzipSync(selected));
    const compact = (value) =>
      JSON.parse(
        JSON.stringify(value, (key, v) => {
          if (key !== "text" || typeof v !== "string" || v.length <= 256)
            return v;
          const token = ["PAC-GROWTH-", "PAC-INTERRUPTION-"].find(
            (token) => v === token.repeat(v.length / token.length),
          );
          return {
            length: v.length,
            sha256: hash(v),
            prefix: v.slice(0, 80),
            suffix: v.slice(-80),
            ...(token
              ? { repeatToken: token, repeatCount: v.length / token.length }
              : {}),
          };
        }),
      );
    const rea = await load("rea-evidence");
    const report = {
      date: new Date().toISOString(),
      environment: {
        system: exec("/usr/bin/sw_vers", []),
        arch: process.arch,
        mounts: snapshots.before.mounts,
      },
      application: {
        path: "/Applications/Pro Audio Converter.app",
        version: "1.11.1",
        build: "307",
        identifier: "com.markvapps.proaudioconverter",
        executableSha256: hash(
          await fs.readFile(
            "/Applications/Pro Audio Converter.app/Contents/MacOS/Pro Audio Converter",
          ),
        ),
      },
      fixture: study.fixture,
      interruptionFixture: {
        generation:
          "ffmpeg -f lavfi -i anoisesrc=color=white:seed=42:sample_rate=48000:duration=600 -ac 2 -c:a flac -compression_level 0 -sample_fmt s16; synthetic only",
        ffmpeg: exec("/usr/local/bin/ffmpeg", ["-version"]).split("\n")[0],
        before,
      },
      results,
      ordinaryChanges: {
        rename: {
          renamed,
          oldPathAbsent: true,
          unchanged: true,
          sequence: operations("1343712"),
        },
        replacement: {
          before: replacementBefore,
          after: replacementAfter,
          originalRetained: row(
            "replacement-after-save",
            "off/Media/Replace-original.flac",
          ),
          sequence: operations("1344832"),
        },
        externalTags: {
          before: externalBefore,
          after: externalAfter,
          sequence: operations("1345943"),
        },
        removed: {
          before: row("before", "off/Media/Remove.flac"),
          afterPathAbsent: true,
          sequence: operations("1346639"),
        },
      },
      interruption: {
        trigger: await load("interruption-trigger"),
        before,
        after,
        restart,
        sequence: operations("1350977"),
        signalsSent: 1,
        restartUI:
          "Empty queue, no recovery prompt; reopening the study file displayed PAC interruption save. Queue cleared without writing and app quit.",
        contentUnchangedOnRestart: true,
      },
      sourceSnapshots: labels,
      trace: {
        artifact: traceName,
        rawSha256: hash(raw),
        retainedSha256: hash(selected),
        selection:
          "All save-worker lines plus all study-root lines; other app UI/resource accesses omitted",
        allPidNamespaceOrBarrierOperations: lines.filter((l) =>
          /\s(?:rename\S*|unlink\S*|exchangedata|clonefile\S*|fsync|fcntl)\s/.test(
            l,
          ),
        ),
        lostMarkerObserved: lines.some((l) => /LOST|DROPPED/.test(l)),
        scope:
          "Original PID 66664; not a system-wide/child-helper or restart trace. 10ms sibling polling supplements syscall observation.",
      },
      directoryObservations: (
        await fs.readFile(path.join(observations, "directories.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(JSON.parse),
      reaEvidence: {
        records: rea.records.filter(
          (r) => r.operation === "capture_process_scenario",
        ),
        limitations:
          "Initial rendered terminal capture was truncated; retained raw lsof frames were complete. Idle lsof snapshots have no matching media descriptors; short-lived handles remain outside that sample.",
      },
      validation: {
        normalEdits: results.length,
        ordinaryChangeCases: 4,
        interruptionCases: 1,
        assertions: "passed",
        productionNativeSourceUnchanged: true,
        productionNativeBinaryUnchanged: true,
      },
      limitations: [
        "Behavior on this version/host/fixtures only; no private-code analysis or hidden safety guarantees inferred",
        "No systematic power-loss or all-timing qualification",
        "No cross-UID, adversarial substitution or security changes",
        "Small-file metadata writes were sub-millisecond; only one large-file interruption was attempted",
        "No Rio production code changed or application package built",
      ],
    };
    await fs.writeFile(
      path.join(destination, "pro-audio-converter-noowners-macos-x64.json"),
      JSON.stringify(compact(report), null, 2) + "\n",
    );
    console.log(JSON.stringify(report.validation));
  } else if (command === "interrupt") {
    const pid = Number(label),
      target = path.join(root, "off", "Media", "Interruption.flac");
    assert(Number.isSafeInteger(pid) && pid > 1);
    const identity = () =>
      exec("/bin/ps", ["-ww", "-p", String(pid), "-o", "command="]).trim() +
      " " +
      exec("/bin/ps", ["-p", String(pid), "-o", "lstart="]).trim();
    const processIdentity = identity();
    assert(
      processIdentity.startsWith(
        "/Applications/Pro Audio Converter.app/Contents/MacOS/Pro Audio Converter ",
      ),
    );
    const before = sync.statSync(target, { bigint: true });
    assert(before.size > 20n * 1024n * 1024n);
    const started = Date.now();
    console.log(
      "Armed: one SIGKILL only, after the disposable file first changes; 60-second timeout.",
    );
    await new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          const s = sync.statSync(target, { bigint: true });
          if (s.mtimeNs !== before.mtimeNs || s.size !== before.size) {
            clearInterval(timer);
            assert.equal(identity(), processIdentity);
            const record = {
              armedAt: new Date(started).toISOString(),
              observedAt: new Date().toISOString(),
              target,
              pid,
              processIdentity,
              before: {
                inode: String(before.ino),
                size: String(before.size),
                mtimeNs: String(before.mtimeNs),
              },
              observed: {
                inode: String(s.ino),
                size: String(s.size),
                mtimeNs: String(s.mtimeNs),
              },
            };
            process.kill(pid, "SIGKILL");
            record.signaledAt = new Date().toISOString();
            sync.writeFileSync(
              path.join(observations, "interruption-trigger.json"),
              JSON.stringify(record, null, 2) + "\n",
            );
            console.log(JSON.stringify(record));
            resolve();
          } else if (Date.now() - started > 60000) {
            clearInterval(timer);
            console.log("No write observed; no signal sent.");
            resolve();
          }
        } catch (e) {
          clearInterval(timer);
          reject(e);
        }
      }, 1);
    });
  } else if (command === "change") {
    const media = path.join(root, "off", "Media");
    const titles = {
      replace: "Ordinary replacement",
      "external-tags": "Ordinary external title",
    };
    if (label === "rename")
      await fs.rename(
        path.join(media, "Rename.flac"),
        path.join(media, "Renamed.flac"),
      );
    else if (label === "replace") {
      await fs.rename(
        path.join(media, "Replace.flac"),
        path.join(media, "Replace-original.flac"),
      );
      await fs.writeFile(
        path.join(media, "Replace.flac"),
        playbackFlacFixture([
          ["TITLE", titles[label]],
          ["ARTIST", "Ordinary external artist"],
          ["ALBUM", "Ordinary external album"],
          ["COMMENT", "Ordinary external comment"],
        ]),
        { flag: "wx" },
      );
    } else if (label === "external-tags")
      await fs.writeFile(
        path.join(media, "ExternalTags.flac"),
        playbackFlacFixture([
          ["TITLE", titles[label]],
          ["ARTIST", "Ordinary external artist"],
          ["ALBUM", "Ordinary external album"],
          ["COMMENT", "Ordinary external comment"],
        ]),
      );
    else if (label === "remove")
      await fs.unlink(path.join(media, "Remove.flac"));
    else throw Error("Unknown disposable ordinary change");
    const event = { at: new Date().toISOString(), action: label, media };
    await fs.appendFile(
      path.join(observations, "actions.jsonl"),
      JSON.stringify(event) + "\n",
    );
    console.log(event);
  } else if (command === "snapshot") {
    assert.match(label, /^[a-zA-Z0-9-]+$/);
    const rows = [];
    for (const p of await names()) {
      const s = await fs.lstat(p, { bigint: true });
      const row = {
        path: p,
        device: String(s.dev),
        inode: String(s.ino),
        size: String(s.size),
        links: String(s.nlink),
        mode: (Number(s.mode) & 0o7777).toString(8),
        uid: String(s.uid),
        gid: String(s.gid),
        mtimeNs: String(s.mtimeNs),
        ctimeNs: String(s.ctimeNs),
        birthtimeNs: String(s.birthtimeNs),
        acl: exec("/bin/ls", ["-led@", p]),
        xattrs: exec("/usr/bin/xattr", ["-lx", p]),
      };
      if (s.isFile()) {
        const bytes = await fs.readFile(p);
        row.sha256 = hash(bytes);
        if (path.extname(p) === ".flac") {
          try {
            const inspected = inspectFlac(bytes);
            row.audioSha256 = hash(inspected.audio);
            row.audioBytes = inspected.audio.length;
            const m = await parseFile(p);
            row.metadata = { format: m.format, common: m.common };
          } catch (e) {
            row.parseError = String(e);
          }
          const decoded = spawnSync(
            "/usr/local/bin/ffmpeg",
            ["-v", "warning", "-i", p, "-map", "0:a:0", "-f", "md5", "-"],
            { encoding: "utf8", timeout: 30000, maxBuffer: 100000 },
          );
          row.decode = {
            status: decoded.status,
            signal: decoded.signal,
            error: decoded.error?.message,
            stdout: decoded.stdout,
            stderr: decoded.stderr,
          };
        }
      }
      rows.push(row);
    }
    const data = {
      at: new Date().toISOString(),
      mounts: exec("/sbin/mount", [])
        .split("\n")
        .filter((x) => x.includes(root)),
      rows,
    };
    await fs.writeFile(
      path.join(observations, `${label}.json`),
      JSON.stringify(data, null, 2) + "\n",
    );
    console.log(
      rows.map((x) => ({
        file: x.path,
        inode: x.inode,
        bytes: x.size,
        title: x.metadata?.common.title,
        audioSha256: x.audioSha256,
        decode: x.decode?.status,
      })),
    );
  } else if (command === "watch") {
    assert.match(label, /^[a-zA-Z0-9-]+$/);
    const log = path.join(observations, `${label}.jsonl`),
      last = new Map();
    let busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      try {
        const present = new Set();
        for (const p of await names()) {
          present.add(p);
          let state;
          try {
            const s = await fs.lstat(p, { bigint: true });
            state = {
              inode: String(s.ino),
              size: String(s.size),
              mtimeNs: String(s.mtimeNs),
              ctimeNs: String(s.ctimeNs),
            };
          } catch (e) {
            state = { error: e.code };
          }
          const encoded = JSON.stringify(state);
          if (last.get(p) !== encoded) {
            await fs.appendFile(
              log,
              JSON.stringify({
                at: new Date().toISOString(),
                path: p,
                ...state,
              }) + "\n",
            );
            last.set(p, encoded);
          }
        }
        for (const p of last.keys())
          if (!present.has(p)) {
            await fs.appendFile(
              log,
              JSON.stringify({
                at: new Date().toISOString(),
                path: p,
                removed: true,
              }) + "\n",
            );
            last.delete(p);
          }
      } finally {
        busy = false;
      }
    };
    await poll();
    setInterval(() => void poll(), 10);
    console.log(log);
  } else throw Error("Use setup, snapshot ROOT LABEL or watch ROOT LABEL");
}
