// Disposable APFS image: never changes flags on a user's volume.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir } from "node:fs/promises";
import path from "node:path";
const exec = promisify(execFile);
export async function localMetadataVolume(root) {
  const image = path.join(root, "Local metadata.sparseimage");
  const directory = path.join(root, "Local metadata volume");
  await mkdir(directory);
  await exec("/usr/bin/hdiutil", [
    "create",
    "-quiet",
    "-size",
    "128m",
    "-fs",
    "APFS",
    "-type",
    "SPARSE",
    "-volname",
    "Rio Disposable Local Metadata",
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
    close: () => exec("/usr/bin/hdiutil", ["detach", "-quiet", directory]),
  };
}
