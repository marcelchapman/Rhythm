import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { resolvePublicationPackage } from "./lib/publication-package.mjs";
const packaged = process.argv.includes("--packaged");
const bundle = packaged ? await resolvePublicationPackage() : undefined;
const executable =
  bundle?.executable || createRequire(import.meta.url)("electron");
if (bundle) console.log("Publication package:", JSON.stringify(bundle));
const result = spawnSync(
  executable,
  [
    path.resolve("scripts/publication.mjs"),
    ...(bundle ? ["--packaged", "--resources", bundle.resources] : []),
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
