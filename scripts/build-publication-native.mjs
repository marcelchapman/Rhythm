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

// Raw Node-API v8: no V8/Electron ABI or node-gyp dependency. Official Node binary
// distributions and supported development installs provide these C headers.
const output = path.resolve("dist/native");
mkdirSync(output, { recursive: true });
if (!["darwin", "linux"].includes(process.platform)) {
  console.log("Native publication is unsupported on this platform.");
  process.exit(0);
}
const header = [
  path.resolve(path.dirname(process.execPath), "../include/node"),
  "/usr/local/include/node",
  "/usr/include/node",
].find((p) => existsSync(path.join(p, "node_api.h")));
if (!header)
  throw Error(
    "Native publication requires the installed Node development headers (node_api.h).",
  );
const source = path.resolve("native/publication.cc");
const compiler = process.env.CXX || "c++";
const version = execFileSync(compiler, ["--version"], {
  encoding: "utf8",
}).split("\n")[0];
const flags = [
  "-std=c++17",
  "-O2",
  "-Wall",
  "-Wextra",
  "-Werror",
  "-DNAPI_VERSION=8",
  `-I${header}`,
  ...(process.platform === "darwin"
    ? [
        "-bundle",
        "-undefined",
        "dynamic_lookup",
        "-mmacosx-version-min=13.0",
        "-arch",
        process.arch === "x64" ? "x86_64" : process.arch,
      ]
    : ["-shared", "-fPIC", "-D_GNU_SOURCE"]),
];
for (const testing of process.argv.includes("--test")
  ? [false, true]
  : [false]) {
  const directory = testing ? path.join(output, "testing") : output;
  mkdirSync(directory, { recursive: true });
  const binary = path.join(directory, "publication.node");
  const manifest = path.join(directory, "publication-build.json");
  const fingerprint = createHash("sha256")
    .update(readFileSync(source))
    .update(readFileSync(import.meta.filename))
    .update(readFileSync(path.join(header, "node_api.h")))
    .update(readFileSync(path.join(header, "js_native_api.h")))
    .update(readFileSync(path.join(header, "js_native_api_types.h")))
    .update(JSON.stringify({ flags, version, testing, arch: process.arch }))
    .digest("hex");
  if (
    existsSync(binary) &&
    existsSync(manifest) &&
    JSON.parse(readFileSync(manifest)).fingerprint === fingerprint &&
    JSON.parse(readFileSync(manifest)).sha256 ===
      createHash("sha256").update(readFileSync(binary)).digest("hex")
  )
    continue;
  const temporary = `${binary}.${process.pid}.node`;
  try {
    execFileSync(
      compiler,
      [
        ...flags,
        ...(testing ? ["-DRHYTHM_PUBLICATION_TESTING"] : []),
        source,
        "-o",
        temporary,
      ],
      { stdio: "inherit" },
    );
    // Load through Node-API before publication: catches a wrong CPU/ABI binary.
    createRequire(import.meta.url)(temporary);
    renameSync(temporary, binary);
  } finally {
    rmSync(temporary, { force: true });
  }
  const temporaryManifest = `${manifest}.${process.pid}.tmp`;
  writeFileSync(
    temporaryManifest,
    JSON.stringify(
      {
        fingerprint,
        platform: process.platform,
        arch: process.arch,
        napi: 8,
        testing,
        compiler: version,
        sha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
      },
      null,
      2,
    ) + "\n",
  );
  renameSync(temporaryManifest, manifest);
  console.log(`Built ${path.relative(process.cwd(), binary)} (Node-API 8).`);
}
