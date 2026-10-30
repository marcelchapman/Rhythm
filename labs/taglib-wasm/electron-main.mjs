// Standalone Electron lab: never imports Rio main/preload or opens a library.
import { app } from "electron";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { generated } from "./lab.mjs";
const profile = path.join(generated, "electron-profile");
mkdirSync(profile, { recursive: true });
app.setName("Rio Writer Qualification Lab");
app.setPath("userData", profile);
app.setPath("sessionData", profile);
app.setAppLogsPath(path.join(profile, "logs"));
app.whenReady().then(async () => {
  try {
    await import("./qualify.mjs");
    app.exit(0);
  } catch (e) {
    console.error(e);
    app.exit(1);
  }
});
