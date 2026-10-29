import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, readdir } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { extractFile } from "@electron/asar";
import plist from "plist";

// Discover builder's actual unpacked output, not an assumed architecture suffix.
// These parsers are already supplied by the installed electron-builder toolchain.
export async function resolvePublicationPackage({
  project = process.cwd(),
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const metadata = JSON.parse(
    await readFile(path.join(project, "package.json")),
  );
  const output = path.resolve(project, metadata.build.directories.output);
  const candidates = [];
  for (const dir of await readdir(output, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const base = path.join(output, dir.name);
    if (platform === "darwin") {
      for (const bundle of await readdir(base, { withFileTypes: true })) {
        if (bundle.isDirectory() && bundle.name.endsWith(".app"))
          candidates.push(
            path.join(base, bundle.name, "Contents", "Resources"),
          );
      }
    } else if (platform === "linux") {
      candidates.push(path.join(base, "resources"));
    } else throw Error(`Unsupported publication package platform: ${platform}`);
  }
  const matches = [];
  for (const resources of candidates) {
    const archive = path.join(resources, "app.asar");
    try {
      await access(archive);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    const bundled = JSON.parse(extractFile(archive, "package.json"));
    if (bundled.name !== metadata.name) continue;
    const manifest = JSON.parse(
      extractFile(archive, "dist/native/publication-build.json"),
    );
    if (manifest.platform !== platform || manifest.arch !== arch) continue;
    assert.equal(manifest.testing, false, "Package contains a testing addon");
    assert.equal(manifest.napi, 8);
    const binary = path.join(
      resources,
      "app.asar.unpacked/dist/native/publication.node",
    );
    assert.equal(
      createHash("sha256")
        .update(await readFile(binary))
        .digest("hex"),
      manifest.sha256,
      "Packaged native addon does not match its manifest",
    );
    const current = JSON.parse(
      await readFile(path.join(project, "dist/native/publication-build.json")),
    );
    assert.deepEqual(
      manifest,
      current,
      "Package is stale relative to this build",
    );
    let executable;
    if (platform === "darwin") {
      const info = plist.parse(
        await readFile(path.join(resources, "../Info.plist"), "utf8"),
      );
      executable = path.resolve(resources, "../MacOS", info.CFBundleExecutable);
    } else {
      executable = path.join(
        resources,
        "..",
        metadata.build.linux?.executableName || metadata.name,
      );
    }
    await access(executable, constants.X_OK);
    matches.push({ executable, resources, binary, manifest });
  }
  assert.equal(
    matches.length,
    1,
    `Expected one current ${platform}/${arch} publication package in ${output}; found ${matches.length}`,
  );
  return matches[0];
}
