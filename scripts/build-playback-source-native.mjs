import { MAX_FLAC_FILE_BYTES } from "../src/shared/flac-limits.ts";
// Separate from metadata publication; unsupported hosts never build/load APFS APIs.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  rmSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
if (process.platform === "darwin") {
  const directory = path.resolve("dist/native");
  mkdirSync(directory, { recursive: true });
  const header = [
    path.resolve(path.dirname(process.execPath), "../include/node"),
    "/usr/local/include/node",
  ].find((p) => existsSync(path.join(p, "node_api.h")));
  if (!header)
    throw Error("Playback source build requires existing Node headers.");
  const source = path.resolve("native/playback-source.cc"),
    compiler = process.env.CXX || "c++";
  const flags = [
    "-std=c++17",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    "-DNAPI_VERSION=8",
    `-DRIO_MAX_FLAC_BYTES=${MAX_FLAC_FILE_BYTES}`,
    `-I${header}`,
    "-bundle",
    "-undefined",
    "dynamic_lookup",
    "-mmacosx-version-min=13.0",
    "-arch",
    process.arch === "x64" ? "x86_64" : process.arch,
  ];
  const version = execFileSync(compiler, ["--version"], {
    encoding: "utf8",
  }).split("\n")[0];
  const fingerprint = createHash("sha256")
    .update(readFileSync(source))
    .update(readFileSync(import.meta.filename))
    .update(readFileSync(path.join(header, "node_api.h")))
    .update(readFileSync(path.join(header, "js_native_api.h")))
    .update(readFileSync(path.join(header, "js_native_api_types.h")))
    .update(JSON.stringify({ flags, version }))
    .digest("hex");
  const binary = path.join(directory, "playback-source.node"),
    manifest = path.join(directory, "playback-source-build.json");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  if (
    !existsSync(binary) ||
    !existsSync(manifest) ||
    JSON.parse(readFileSync(manifest)).fingerprint !== fingerprint ||
    JSON.parse(readFileSync(manifest)).sha256 !== sha(readFileSync(binary))
  ) {
    const temporary = binary + `.${process.pid}.node`;
    try {
      execFileSync(compiler, [...flags, source, "-o", temporary], {
        stdio: "inherit",
      });
      createRequire(import.meta.url)(temporary);
      renameSync(temporary, binary);
    } finally {
      rmSync(temporary, { force: true });
    }
    const temp = manifest + `.${process.pid}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({
        fingerprint,
        sha256: sha(readFileSync(binary)),
        platform: process.platform,
        arch: process.arch,
        napi: 8,
      }) + "\n",
    );
    renameSync(temp, manifest);
    console.log("Built APFS playback source capability (Node-API 8).");
  }
}
