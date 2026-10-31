// Exercise actual app resources without renderer/IPC edits or replacing worker code.
import { _electron as electron } from "playwright";
import assert from "node:assert/strict";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePublicationPackage } from "./lib/publication-package.mjs";
import { flacFixture } from "../tests/metadata-fixtures.ts";
const packaged =
  !!process.env.RIO_EXECUTABLE || process.argv.includes("--packaged");
const bundle =
  packaged && !process.env.RIO_EXECUTABLE
    ? await resolvePublicationPackage()
    : undefined;
const executable = process.env.RIO_EXECUTABLE || bundle?.executable;
const root = await realpath(
  await mkdtemp(path.join(tmpdir(), "rio-edit-electron-")),
);
let app;
try {
  const source = path.join(root, "External.flac"),
    original = flacFixture();
  await writeFile(source, original);
  const originalStat = await stat(source);
  app = await electron.launch({
    ...(executable
      ? { executablePath: executable, args: [] }
      : { args: ["."] }),
    ...(packaged ? { cwd: root } : {}),
    env: { ...process.env, RIO_DATA_DIR: path.join(root, "Profile") },
    timeout: 30000,
  });
  await (await app.firstWindow()).waitForSelector("h1");
  const result = await app.evaluate(
    async ({ app }, { root, source, packaged }) => {
      const nodeModule = process.getBuiltinModule("module"),
        path = process.getBuiltinModule("path"),
        fs = process.getBuiltinModule("fs"),
        { fileURLToPath } = process.getBuiltinModule("url"),
        { createHash } = process.getBuiltinModule("crypto"),
        assert = process.getBuiltinModule("assert/strict");
      assert.equal(
        app.isPackaged,
        packaged,
        "Must run the requested source/packaged application",
      );
      const appPath = app.getAppPath();
      if (packaged)
        assert.equal(appPath, path.join(process.resourcesPath, "app.asar"));
      const entry = path.join(appPath, "dist/domain/library.js"),
        coordinator = path.join(appPath, "dist/domain/metadata-edit.js"),
        workerPath = path.join(appPath, "dist/domain/metadata-edit-worker.js");
      const require = nodeModule.createRequire(entry),
        taglib = nodeModule.createRequire(workerPath).resolve("taglib-wasm"),
        wasm = path.join(path.dirname(taglib), "taglib-web.wasm"),
        native = require.resolve(
          path.join(appPath, "dist/native/publication.node"),
        ),
        binary = packaged
          ? path.join(
              process.resourcesPath,
              "app.asar.unpacked/dist/native/publication.node",
            )
          : native,
        manifest = require(
          path.join(appPath, "dist/native/publication-build.json"),
        );
      const proof = (filename) => ({
        path: filename,
        sha256: createHash("sha256")
          .update(fs.readFileSync(filename))
          .digest("hex"),
      });
      for (const filename of [
        entry,
        coordinator,
        workerPath,
        taglib,
        wasm,
        native,
      ])
        assert(
          filename.startsWith(appPath + path.sep),
          `Implementation must resolve from this app: ${filename}`,
        );
      assert.equal(manifest.testing, false);
      assert.equal(manifest.platform, process.platform);
      assert.equal(manifest.arch, process.arch);
      assert.equal(manifest.napi, 8);
      assert.equal(proof(binary).sha256, manifest.sha256);
      // Observe the exact coordinator-created Worker URL and reply, forwarding its
      // URL/options unchanged. syncBuiltinESMExports also covers a cached coordinator.
      const threads = process.getBuiltinModule("worker_threads"),
        OriginalWorker = threads.Worker,
        workers = [];
      threads.Worker = class extends OriginalWorker {
        constructor(url, options) {
          const filename =
            typeof url === "string" ? url : fileURLToPath(url.href);
          assert.equal(
            filename,
            workerPath,
            "Coordinator must launch its own app's worker",
          );
          super(url, options);
          const observed = { path: filename, mode: options.workerData.mode };
          workers.push(observed);
          this.once("message", (reply) => {
            observed.ok = reply.ok;
            if (reply.value?.verification)
              observed.verification = reply.value.verification;
          });
        }
      };
      nodeModule.syncBuiltinESMExports();
      try {
        const { Library } = require(entry);
        const {
          editManagedFlac,
          MetadataUseGate,
          MetadataEditInterruption,
        } = require(coordinator);
        let library = await Library.open(`${root}/Library`, {
          setupMediaRoot: true,
        });
        try {
          library.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
          const added = await library.add([source]);
          if (added.errors.length) throw Error(JSON.stringify(added.errors));
          const t = library.tracks()[0],
            use = new MetadataUseGate();
          use.setInUse(t.id, false);
          const edited = await editManagedFlac(
            library,
            t.id,
            { title: { action: "set", value: "Electron edited" } },
            { usage: use },
          );
          const samePath = edited.track.path === t.path;
          try {
            await editManagedFlac(
              library,
              t.id,
              {
                comments: { action: "set", value: "Recovered inside Electron" },
              },
              {
                usage: use,
                hooks: {
                  at: async (at) => {
                    if (at === "published")
                      throw new MetadataEditInterruption("crash barrier");
                  },
                },
              },
            );
            throw Error("Interruption barrier did not fire");
          } catch (error) {
            if (!(error instanceof MetadataEditInterruption)) throw error;
          }
          assert.equal(
            library.tracks(t.id)[0].comments,
            t.comments,
            "Interrupted candidate must not already be committed to the DB",
          );
          assert.equal(
            library.db
              .prepare(
                "SELECT phase FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
              )
              .get()?.phase,
            "published",
            "Interruption must occur after publication and before DB commit",
          );
          const directory = library.directory;
          library.close();
          library = await Library.open(directory, { setupMediaRoot: true });
          const after = library.tracks(t.id)[0];
          assert(
            require.cache[entry]?.loaded,
            "App Library module must actually be loaded",
          );
          assert(
            require.cache[coordinator]?.loaded,
            "App coordinator module must actually be loaded",
          );
          assert(
            require.cache[native]?.loaded,
            "App native publication addon must actually be loaded",
          );
          assert(
            workers.length >= 6,
            "Both edits and recovery must use the actual worker",
          );
          assert(
            workers.every((w) => w.ok),
            "All coordinator worker operations must succeed",
          );
          const preparations = workers.filter((w) => w.mode === "prepare");
          assert.equal(preparations.length, 2);
          for (const w of preparations) {
            assert.equal(w.verification.backend, "emscripten");
            assert(w.verification.engineVersion);
          }
          return {
            resources: {
              packaged: app.isPackaged,
              appPath,
              resourcesPath: process.resourcesPath,
              executable: process.execPath,
              library: proof(entry),
              coordinator: proof(coordinator),
              worker: proof(workerPath),
              taglib: proof(taglib),
              wasm: proof(wasm),
              native: proof(binary),
              manifest,
              workers,
            },
            status: edited.status,
            samePath,
            title: after.title,
            comments: after.comments,
            idPreserved: after.id === t.id,
            pending: library.db
              .prepare(
                "SELECT count(*) AS n FROM metadata_edits WHERE phase NOT IN ('done','aborted')",
              )
              .get().n,
            runtime: {
              electron: process.versions.electron,
              node: process.versions.node,
            },
          };
        } finally {
          library.close();
        }
      } finally {
        threads.Worker = OriginalWorker;
        nodeModule.syncBuiltinESMExports();
      }
    },
    {
      root,
      source,
      packaged,
    },
  );
  assert.equal(result.status, "committed");
  assert(result.samePath);
  assert(result.idPreserved);
  assert.equal(result.title, "Electron edited");
  assert.equal(result.comments, "Recovered inside Electron");
  assert.equal(result.pending, 0);
  assert.deepEqual(await readFile(source), original);
  assert.equal((await stat(source)).mtimeMs, originalStat.mtimeMs);
  console.log(JSON.stringify({ passed: true, ...result }, null, 2));
} finally {
  if (app) await app.close();
  await rm(root, { recursive: true, force: true });
}
