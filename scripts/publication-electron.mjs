import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
const packaged = process.argv.includes("--packaged");
const executable = packaged
  ? path.resolve(
      process.platform === "darwin"
        ? "release/mac/Rhythm.app/Contents/MacOS/Rhythm"
        : "release/linux-unpacked/rhythm-desktop",
    )
  : createRequire(import.meta.url)("electron");
const result = spawnSync(
  executable,
  [
    path.resolve("scripts/publication.mjs"),
    ...(packaged ? ["--packaged"] : []),
  ],
  {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
    timeout: 120000,
  },
);
if (result.error) throw result.error;
if (result.status !== 0)
  throw Error(
    `Electron publication qualification failed: ${result.status ?? result.signal}`,
  );
