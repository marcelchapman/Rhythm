import { test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createPackage } from "@electron/asar";
import plist from "plist";
import { resolvePublicationPackage } from "../scripts/lib/publication-package.mjs";

async function fixture(run: (f: any) => Promise<void>) {
  const project = await mkdtemp(path.join(tmpdir(), "rio-package-discovery-"));
  const binary = Buffer.from(
    "Disposable package-discovery fixture, not executable native code",
  );
  const metadata = {
    name: "rio-desktop",
    desktopName: "io.github.marcelchapman.rio.desktop",
    build: {
      appId: "io.github.marcelchapman.rio",
      directories: { output: "release" },
      linux: {},
    },
  };
  await writeFile(path.join(project, "package.json"), JSON.stringify(metadata));
  await mkdir(path.join(project, "dist/native"), { recursive: true });
  async function bundle(platform: string, arch: string, directory: string) {
    const resources = path.join(
      project,
      "release",
      directory,
      ...(platform === "darwin"
        ? ["Rio.app", "Contents", "Resources"]
        : ["resources"]),
    );
    const manifest = {
      platform,
      arch,
      napi: 8,
      testing: false,
      fingerprint: `fixture-${platform}-${arch}`,
      sha256: createHash("sha256").update(binary).digest("hex"),
    };
    const source = await mkdtemp(path.join(project, "asar-input-"));
    await mkdir(path.join(source, "dist/native"), { recursive: true });
    await writeFile(
      path.join(source, "package.json"),
      JSON.stringify(metadata),
    );
    await writeFile(
      path.join(source, "dist/native/publication-build.json"),
      JSON.stringify(manifest),
    );
    await writeFile(
      path.join(project, "dist/native/publication-build.json"),
      JSON.stringify(manifest),
    );
    await mkdir(resources, { recursive: true });
    await createPackage(source, path.join(resources, "app.asar"));
    const native = path.join(
      resources,
      "app.asar.unpacked/dist/native/publication.node",
    );
    await mkdir(path.dirname(native), { recursive: true });
    await writeFile(native, binary);
    // Deliberately differ from productName: discovery must read CFBundleExecutable.
    const executable = path.resolve(
      resources,
      platform === "darwin" ? "../MacOS/FixtureRuntime" : "../rio-desktop",
    );
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "fixture", { mode: 0o755 });
    if (platform === "darwin")
      await writeFile(
        path.resolve(resources, "../Info.plist"),
        plist.build({
          CFBundleExecutable: "FixtureRuntime",
          CFBundleIdentifier: metadata.build.appId,
        }),
      );
    return { executable, resources, native, manifest };
  }
  try {
    await run({ project, bundle });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
}

test.each([
  ["darwin", "x64", "mac"],
  ["darwin", "arm64", "mac-arm64"],
  ["linux", "x64", "linux-unpacked"],
  ["linux", "arm64", "linux-arm64-unpacked"],
])(
  "discovers actual %s/%s builder output in %s",
  async (platform, arch, directory) => {
    await fixture(async ({ project, bundle }) => {
      const expected = await bundle(platform, arch, directory);
      const found = await resolvePublicationPackage({
        project,
        platform,
        arch,
      });
      expect(found.executable).toBe(expected.executable);
      expect(found.resources).toBe(expected.resources);
      expect(found.manifest).toEqual(expected.manifest);
    });
  },
);
test("chooses the runtime architecture when Intel and arm64 packages coexist", async () => {
  await fixture(async ({ project, bundle }) => {
    await bundle("darwin", "x64", "mac");
    const expected = await bundle("darwin", "arm64", "mac-arm64");
    expect(
      (
        await resolvePublicationPackage({
          project,
          platform: "darwin",
          arch: "arm64",
        })
      ).executable,
    ).toBe(expected.executable);
  });
});
test("refuses ambiguous matching packages rather than choosing the first", async () => {
  await fixture(async ({ project, bundle }) => {
    await bundle("darwin", "arm64", "mac-arm64");
    await bundle("darwin", "arm64", "another-output");
    await expect(
      resolvePublicationPackage({ project, platform: "darwin", arch: "arm64" }),
    ).rejects.toThrow(/found 2/);
  });
});
test("refuses a stale packaged addon", async () => {
  await fixture(async ({ project, bundle }) => {
    const { manifest } = await bundle("darwin", "x64", "mac");
    await writeFile(
      path.join(project, "dist/native/publication-build.json"),
      JSON.stringify({ ...manifest, fingerprint: "new-build" }),
    );
    await expect(
      resolvePublicationPackage({ project, platform: "darwin", arch: "x64" }),
    ).rejects.toThrow(/stale/);
  });
});
test("refuses missing executable and changed unpacked native binary", async () => {
  await fixture(async ({ project, bundle }) => {
    const { executable, native } = await bundle("darwin", "x64", "mac");
    await unlink(executable);
    await expect(
      resolvePublicationPackage({ project, platform: "darwin", arch: "x64" }),
    ).rejects.toThrow(/ENOENT/);
    await writeFile(executable, "fixture", { mode: 0o755 });
    await writeFile(native, "changed");
    await expect(
      resolvePublicationPackage({ project, platform: "darwin", arch: "x64" }),
    ).rejects.toThrow(/does not match/);
  });
});
test("does not run a different architecture when the requested package is absent", async () => {
  await fixture(async ({ project, bundle }) => {
    await bundle("darwin", "x64", "mac");
    await expect(
      resolvePublicationPackage({ project, platform: "darwin", arch: "arm64" }),
    ).rejects.toThrow(/found 0/);
  });
});

test("refuses an incorrect packaged bundle identifier", async () => {
  await fixture(async ({ project, bundle }) => {
    const { resources } = await bundle("darwin", "x64", "mac");
    await writeFile(
      path.resolve(resources, "../Info.plist"),
      plist.build({
        CFBundleExecutable: "FixtureRuntime",
        CFBundleIdentifier: "invalid.bundle.identity",
      }),
    );
    await expect(
      resolvePublicationPackage({ project, platform: "darwin", arch: "x64" }),
    ).rejects.toThrow(/bundle identifier/);
  });
});

test("current package identity drives Linux desktop metadata", async () => {
  const metadata = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  expect(metadata.build.appId).toBe("io.github.marcelchapman.rio");
  expect(metadata.desktopName).toBe("io.github.marcelchapman.rio.desktop");
  expect(metadata.build.linux.syncDesktopName).toBe(true);
  const { LinuxTargetHelper } =
    await import("app-builder-lib/out/targets/LinuxTargetHelper.js");
  const helper = Object.create(LinuxTargetHelper.prototype);
  helper.packager = {
    info: { metadata },
    config: metadata.build,
    platformSpecificBuildOptions: metadata.build.linux,
    executableName: metadata.name,
    fileAssociations: [],
    appInfo: {
      productName: metadata.build.productName,
      sanitizedProductName: metadata.build.productName,
      description: metadata.description,
    },
  };
  expect(helper.getDesktopFileName() + ".desktop").toBe(metadata.desktopName);
  expect(await helper.computeDesktopEntry(metadata.build.linux)).toContain(
    "StartupWMClass=io.github.marcelchapman.rio\n",
  );
});
