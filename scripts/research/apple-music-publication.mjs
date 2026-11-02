// Research only: observe synthetic files on the study's disposable APFS images.
import assert from "node:assert/strict";
import {
  readFile,
  writeFile,
  readdir,
  lstat,
  realpath,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseFile } from "music-metadata";
const [command, suppliedRoot, label] = process.argv.slice(2);
const root = await realpath(suppliedRoot);
assert.match(root, /^\/private\/tmp\/rio-music-publication-[A-Za-z0-9]+$/);
const result = path.join(root, "observations");
const { mkdir } = await import("node:fs/promises");
await mkdir(result, { recursive: true });
async function file(p) {
  const s = await lstat(p, { bigint: true });
  const info = {
    path: p,
    dev: String(s.dev),
    ino: String(s.ino),
    size: String(s.size),
    nlink: String(s.nlink),
    mode: (Number(s.mode) & 0o7777).toString(8),
    uid: Number(s.uid),
    gid: Number(s.gid),
    atimeNs: String(s.atimeNs),
    mtimeNs: String(s.mtimeNs),
    ctimeNs: String(s.ctimeNs),
    birthtimeNs: String(s.birthtimeNs),
  };
  if (s.isFile()) {
    info.sha256 = createHash("sha256")
      .update(await readFile(p))
      .digest("hex");
    info.aclAndAttributes = execFileSync("/bin/ls", ["-led@", p], {
      encoding: "utf8",
    });
    info.xattrs = execFileSync("/usr/bin/xattr", ["-lx", p], {
      encoding: "utf8",
    });
    try {
      const m = await parseFile(p);
      info.metadata = { format: m.format, common: m.common };
    } catch (e) {
      info.parseError = e.message;
    }
  }
  return info;
}
if (command === "snapshot") {
  assert.match(label, /^[a-zA-Z0-9-]+$/);
  const rows = [];
  for (const mode of ["on", "off"]) {
    const dir = path.join(root, mode, "Media");
    for (const name of (await readdir(dir)).sort())
      rows.push(await file(path.join(dir, name)));
  }
  const data = {
    at: new Date().toISOString(),
    mounts: execFileSync("/sbin/mount", { encoding: "utf8" })
      .split("\n")
      .filter((x) => x.includes(root)),
    rows,
  };
  await writeFile(
    path.join(result, `${label}.json`),
    JSON.stringify(data, null, 2) + "\n",
  );
  console.log(
    rows.map((x) => ({
      path: x.path,
      ino: x.ino,
      size: x.size,
      title: x.metadata?.common.title,
      artist: x.metadata?.common.artist,
      mtimeNs: x.mtimeNs,
    })),
  );
} else if (command === "watch") {
  assert.match(label, /^[a-zA-Z0-9-]+$/);
  const log = path.join(result, `${label}.jsonl`),
    previous = new Map();
  const { appendFile } = await import("node:fs/promises");
  let polling = false;
  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      for (const mode of ["on", "off"]) {
        const dir = path.join(root, mode, "Media"),
          present = new Set();
        for (const name of await readdir(dir)) {
          const key = `${mode}/${name}`;
          present.add(key);
          let state;
          try {
            const s = await lstat(path.join(dir, name), { bigint: true });
            state = {
              ino: String(s.ino),
              size: String(s.size),
              mtimeNs: String(s.mtimeNs),
              mode: (Number(s.mode) & 0o7777).toString(8),
              uid: Number(s.uid),
              gid: Number(s.gid),
            };
          } catch (e) {
            state = { error: e.code };
          }
          const encoded = JSON.stringify(state);
          if (previous.get(key) !== encoded) {
            await appendFile(
              log,
              JSON.stringify({
                at: new Date().toISOString(),
                volume: mode,
                name,
                ...state,
              }) + "\n",
            );
            previous.set(key, encoded);
          }
        }
        for (const key of previous.keys())
          if (key.startsWith(mode + "/") && !present.has(key)) {
            await appendFile(
              log,
              JSON.stringify({
                at: new Date().toISOString(),
                volume: mode,
                name: key.slice(mode.length + 1),
                removed: true,
              }) + "\n",
            );
            previous.delete(key);
          }
      }
    } finally {
      polling = false;
    }
  };
  await poll();
  setInterval(() => void poll(), 10);
  console.log(`Polling disposable Media directories every 10ms; ${log}`);
} else throw Error("Use snapshot ROOT LABEL or watch ROOT LABEL");
