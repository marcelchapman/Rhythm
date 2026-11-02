// Research only: isolated Picard configuration and disposable FLAC observations.
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { parseFile } from "music-metadata";
import {
  playbackFlacFixture,
  inspectFlac,
} from "../../tests/metadata-fixtures.ts";
const [command, input, label] = process.argv.slice(2);
const root = await fs.realpath(input);
assert.match(root, /^\/private\/tmp\/rio-picard-publication-[A-Za-z0-9]+$/);
const observations = path.join(root, "observations"),
  sha = (b) => createHash("sha256").update(b).digest("hex");
const exec = (p, args) => execFileSync(p, args, { encoding: "utf8" });
await fs.mkdir(observations, { recursive: true });
const entries = [
  ["TITLE", "Rio disposable original"],
  ["ARTIST", "Rio Study Artist"],
  ["ALBUM", "Rio Publication Study"],
  ["COMMENT", "Disposable synthetic FLAC; no user media"],
];
if (command === "setup") {
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
      `Rio Picard Study ${mode}`,
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
  await fs.mkdir(path.join(root, "sessions"));
  await fs.writeFile(
    path.join(root, "picard.ini"),
    `[setting]\nrename_files=false\nmove_files=false\ndelete_empty_dirs=false\nenable_tag_saving=true\npreserve_timestamps=false\nclear_existing_tags=false\nsave_images_to_files=false\ncheck_for_updates=false\ncheck_for_plugin_updates=false\ncheck_rtd_updates=false\nsession_folder_path=${root}/sessions\nsession_autosave_interval_min=0\nsession_backup_on_crash=true\nsession_load_last_on_startup=false\nsession_no_mb_requests_on_load=true\nsession_safe_restore=true\n`,
  );
  await fs.writeFile(
    path.join(root, "study.json"),
    JSON.stringify(
      {
        root,
        fixture: {
          entries,
          bytes: bytes.length,
          sha256: sha(bytes),
          audioSha256: sha(inspectFlac(bytes).audio),
          seconds: 30,
          sampleRate: 48000,
          channels: 2,
          bits: 16,
        },
        production: {
          source: sha(await fs.readFile("native/publication.cc")),
          binary: sha(await fs.readFile("dist/native/publication.node")),
        },
      },
      null,
      2,
    ) + "\n",
  );
  console.log(root);
} else if (command === "snapshot") {
  assert.match(label, /^[\w-]+$/);
  const rows = [];
  for (const mode of ["on", "off"]) {
    const media = path.join(root, mode, "Media");
    for (const name of (await fs.readdir(media)).sort()) {
      const p = path.join(media, name),
        s = await fs.lstat(p, { bigint: true }),
        row = {
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
        const b = await fs.readFile(p);
        row.sha256 = sha(b);
        if (name.endsWith(".flac")) {
          try {
            const f = inspectFlac(b);
            row.audioSha256 = sha(f.audio);
            row.audioBytes = f.audio.length;
            const m = await parseFile(p);
            row.metadata = { format: m.format, common: m.common };
          } catch (e) {
            row.parseError = String(e);
          }
          const d = spawnSync(
            "/usr/local/bin/ffmpeg",
            ["-v", "warning", "-i", p, "-map", "0:a:0", "-f", "md5", "-"],
            { encoding: "utf8", timeout: 30000, maxBuffer: 100000 },
          );
          row.decode = {
            status: d.status,
            signal: d.signal,
            error: d.error?.message,
            stdout: d.stdout,
            stderr: d.stderr,
          };
        }
      }
      rows.push(row);
    }
  }
  await fs.writeFile(
    path.join(observations, label + ".json"),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mounts: exec("/sbin/mount", [])
          .split("\n")
          .filter((x) => x.includes(root)),
        rows,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    rows.map((r) => ({
      path: r.path,
      inode: r.inode,
      bytes: r.size,
      title: r.metadata?.common.title,
      decode: r.decode?.status,
    })),
  );
} else if (command === "watch") {
  assert.match(label, /^[\w-]+$/);
  const previous = new Map(),
    log = path.join(observations, label + ".jsonl");
  let busy = false;
  const poll = async () => {
    if (busy) return;
    busy = true;
    try {
      for (const mode of ["on", "off"]) {
        const dir = path.join(root, mode, "Media"),
          present = new Set();
        for (const name of await fs.readdir(dir)) {
          const p = path.join(dir, name);
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
          const v = JSON.stringify(state);
          if (previous.get(p) !== v) {
            await fs.appendFile(
              log,
              JSON.stringify({
                at: new Date().toISOString(),
                path: p,
                ...state,
              }) + "\n",
            );
            previous.set(p, v);
          }
        }
        for (const p of previous.keys())
          if (p.startsWith(dir + "/") && !present.has(p)) {
            await fs.appendFile(
              log,
              JSON.stringify({
                at: new Date().toISOString(),
                path: p,
                removed: true,
              }) + "\n",
            );
            previous.delete(p);
          }
      }
    } finally {
      busy = false;
    }
  };
  await poll();
  setInterval(() => void poll(), 10);
  console.log(log);
} else throw Error("Use setup, snapshot or watch");
