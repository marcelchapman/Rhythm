import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

// Exercise the user's actual npm start entry point, not a direct Electron launch.
// All profile data is disposable; an installed/user instance is never stopped.
const root = await realpath(await mkdtemp(path.join(tmpdir(), "rio-startup-")));
const cwd = process.cwd();
const env = { ...process.env, RIO_DATA_DIR: path.join(root, "Profile") };
let app;
try {
  const launcher = path.join(root, "npm-start.sh");
  await writeFile(launcher, '#!/bin/sh\nexec npm start -- "$@"\n', {
    mode: 0o700,
  });
  app = await electron.launch({
    executablePath: launcher,
    args: [],
    cwd,
    env,
    timeout: 30000,
  });
  const page = await app.firstWindow();
  await page.waitForSelector("h1");
  const running = await app.evaluate(({ app, Menu }) => ({
    pid: process.pid,
    executable: process.execPath,
    path: app.getAppPath(),
    profile: app.getPath("userData"),
    packaged: app.isPackaged,
    name: app.getName(),
    menu: Menu.getApplicationMenu().items[0].submenu.items.map((item) => ({
      id: item.id,
      label: item.label,
      type: item.type,
      role: item.role?.toLowerCase(),
      accelerator: item.accelerator,
    })),
  }));
  assert.equal(await realpath(running.path), await realpath(cwd));
  assert.equal(running.profile, env.RIO_DATA_DIR);
  assert.equal(running.packaged, false);
  assert.equal(running.name, "Rio");
  assert.equal(await page.title(), "Rio");
  await page
    .getByRole("img", { name: "Rio", exact: true })
    .first()
    .evaluate(async (image) => {
      await image.decode();
      if (!image.naturalWidth) throw Error("Rio wordmark did not load");
    });
  if (process.platform === "darwin") {
    assert.deepEqual(
      running.menu.map((i) =>
        i.type === "separator" ? i.type : i.role || i.id,
      ),
      [
        "about",
        "app-settings",
        "separator",
        "hide",
        "hideothers",
        "unhide",
        "separator",
        "quit",
      ],
    );
    const settings = running.menu.find((i) => i.id === "app-settings");
    assert.equal(settings.label, "Settings…");
    assert.equal(settings.accelerator, "Cmd+,");
  }
  // A second npm start cannot replace the menu of the process owning this profile.
  // It must explicitly fail instead of claiming to have started the current build.
  const blocked = await new Promise((resolve, reject) => {
    // Playwright adds --no-sandbox to its Linux Electron launches above and in
    // the other desktop suites. Match that test-only strategy for this raw child
    // so runner sandbox setup cannot abort Electron before Rio's lock check.
    const args =
      process.platform === "linux"
        ? ["start", "--", "--no-sandbox"]
        : ["start"];
    const child = spawn("npm", args, { cwd, env, detached: true });
    let output = "";
    const timeout = setTimeout(() => {
      process.kill(-child.pid, "SIGTERM");
      reject(new Error(`Blocked npm start did not exit: ${output}`));
    }, 15000);
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, output });
    });
  });
  assert.equal(blocked.code, 1, blocked.output);
  assert.match(blocked.output, /Rio source build did not start/);
  assert.match(blocked.output, /Quit the running Rio application/);
  assert(blocked.output.includes(env.RIO_DATA_DIR));
  assert.equal(await app.evaluate(() => process.pid), running.pid);
  assert.equal(
    await app.evaluate(
      ({ Menu }) =>
        Menu.getApplicationMenu().getMenuItemById("app-settings")?.label,
    ),
    process.platform === "darwin" ? "Settings…" : undefined,
  );
  console.log(
    JSON.stringify(
      {
        passed: true,
        entryPoint: "npm start",
        pid: running.pid,
        executable: running.executable,
        menu:
          process.platform === "darwin"
            ? running.menu.map((i) =>
                i.type === "separator" ? "separator" : i.label,
              )
            : undefined,
        checks: [
          "actual source process and isolated profile",
          process.platform === "darwin"
            ? "running macOS application menu"
            : "macOS-only Settings command absent",
          "shared-profile source launch fails clearly",
          "existing owner remains alive with its menu",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}
