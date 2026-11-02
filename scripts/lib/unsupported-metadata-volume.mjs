// Real, disposable filesystem-policy regression. Never changes a real volume's flags.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
export async function unsupportedMetadataVolume(root) {
  if (process.platform === "linux") {
    // GitHub Ubuntu provides tmpfs here; it is deliberately outside qualified ext4.
    const directory = await realpath(await mkdtemp("/dev/shm/rio-metadata-"));
    return {
      directory,
      reason: "Require writable local ext4",
      close: () => rm(directory, { recursive: true, force: true }),
    };
  }
  if (process.platform !== "darwin")
    throw new Error(
      "Metadata filesystem qualification supports macOS/Linux only.",
    );
  const image = path.join(root, "Unsupported.sparseimage"),
    directory = path.join(root, "Unsupported volume");
  await mkdir(directory);
  await exec("/usr/bin/hdiutil", [
    "create",
    "-quiet",
    "-size",
    "128m",
    "-fs",
    "HFS+",
    "-type",
    "SPARSE",
    "-volname",
    "Rio Disposable Metadata Test",
    image,
  ]);
  await exec("/usr/bin/hdiutil", [
    "attach",
    "-nobrowse",
    "-owners",
    "off",
    "-mountpoint",
    directory,
    image,
  ]);
  return {
    directory,
    reason: "Require local writable APFS for in-place metadata editing",
    close: () => exec("/usr/bin/hdiutil", ["detach", "-quiet", directory]),
  };
}
