# Phase 2A packaged coordinator qualification

The metadata coordinator harness now supports `--packaged` and `RIO_EXECUTABLE`.
`test:packaged` includes it before the existing packaged desktop harnesses.
There are no production coordinator, worker, writer, native, UI or IPC changes.

## Launch and resource evidence

With `--packaged`, the harness reuses `resolvePublicationPackage` from the native
publication qualification tooling. This discovers the builder output and checks
its identity, architecture and production addon manifest. `RIO_EXECUTABLE`
overrides executable discovery, matching the desktop harness convention; an
override also requires a packaged runtime.

Inside the running app, `app.isPackaged` must match the requested mode. Packaged
`app.getAppPath()` must equal `process.resourcesPath/app.asar`. Library and
coordinator paths are derived there, not passed in from the checkout. The app
runs with a disposable working directory and profile. Only generated fixture
bytes and test orchestration come from the checkout.

A test-only observer forwards each original Worker URL/options unchanged and
records its replies. Every worker launch must point to this application's
`dist/domain/metadata-edit-worker.js`. The observer restores the original builtin
export afterward; it does not substitute a worker module, alter worker arguments,
change its execution budget or expose an edit API.

The harness resolves TagLib from that worker's module location and requires its
JS and local WASM assets to belong to this app. Actual preparation replies must
report the Emscripten backend and an engine version. Library, coordinator and
native addon must actually appear loaded in the runtime's module cache. The
physical unpacked addon hash must match the bundled production manifest and the
running platform/architecture (Node-API 8, `testing: false`). Paths and SHA-256
proofs are printed in the harness JSON output.

For the qualified Intel macOS build, paths below are relative to
`release/mac/Rio.app/Contents/Resources/`:

| Resource           | Packaged path                                            | SHA-256                                                            |
| ------------------ | -------------------------------------------------------- | ------------------------------------------------------------------ |
| Library            | `app.asar/dist/domain/library.js`                        | `f30476d8b7fbf37baa1499d326b3ccd739ccb32e3b03e9d10aa69a3eff469f16` |
| Coordinator        | `app.asar/dist/domain/metadata-edit.js`                  | `30c39a283c288ad1ff131b021e566c1bb4b3365f1a63fb1cf98c90a274f64642` |
| Worker             | `app.asar/dist/domain/metadata-edit-worker.js`           | `813b5ff0700fe929e0dbd577043eaffb2804dcd84f21294fd7e75125ec34d5e4` |
| TagLib JS          | `app.asar/node_modules/taglib-wasm/dist/index.js`        | `c997f00ca67b6e8fabeab82b88d798f90808ad754f88fa9edce3439f836def13` |
| Emscripten WASM    | `app.asar/node_modules/taglib-wasm/dist/taglib-web.wasm` | `615c3d5153b45d188fd05173b4e6d35562e8ef4ca6e36c518ad5ba2705c1f309` |
| Native publication | `app.asar.unpacked/dist/native/publication.node`         | `fe5f066ccf46b33415142e8969fb28495c46f123f5371821aadf51b43a0f0406` |

Source and packaged Library/coordinator/worker hashes match. An additional archive
comparison confirmed those three packaged files equal the current compiled
files byte-for-byte; this comparison reads bytes and does not load checkout
implementation into the packaged application. All six observed worker operations
used the ASAR worker: two prepares, three ordinary verifies and one startup
recovery verify. Preparation reported `2.4.0 (TagLib 2.3.2)`.

## Acceptance and build

The fixture is a disposable managed FLAC with Keep Organized OFF. It verifies a
same-path edit, preserved track ID and unchanged external source bytes/mtime.
The second edit interrupts specifically in `published` state while the DB still
has the old comments. Reopening the library exercises its actual startup recovery:
the candidate reconciles forward, both edits remain visible and no pending
metadata journal remains.

The previous package lacked Phase 2A. A fresh package was built with
`npm run dist:mac -- --x64 --publish never`, using the existing unsigned,
unnotarized configuration. Artifacts:

- `release/mac/Rio.app`
- `release/Rio-0.1.0.dmg`
- `release/Rio-0.1.0-mac.zip`

Bundle identity was verified as Rio / `io.github.marcelchapman.rio`. The application
was launched directly from the build output; it was not installed or published.

## Validation

| Check                                                                      | Result                                                        |
| -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `node scripts/metadata-edit.mjs`                                           | Passed; all acceptance/resource assertions                    |
| `node scripts/metadata-edit.mjs --packaged`                                | Passed; ASAR coordinator/worker/WASM and bundled native addon |
| `RIO_EXECUTABLE=… node scripts/metadata-edit.mjs` (without `--packaged`)   | Passed; override selects and verifies packaged resources      |
| `npm run test:packaged`                                                    | Passed all 14 scripts, including metadata editing             |
| `npm run dist:mac -- --x64 --publish never`                                | Passed; unsigned DMG, ZIP and Rio.app                         |
| `npm run format:check`, explicit report Prettier check, `git diff --check` | Passed                                                        |

This qualification is local Intel macOS / Electron 44.9.2 / Node 24.22.0. Linux, arm64,
signed/notarized distribution and broader metadata features remain outside this
follow-up. No packaged-only product defect has been found.

## Follow-up files

- `scripts/metadata-edit.mjs`: packaged launch/resource assertions and retained acceptance.
- `package.json`: coordinator harness added to `test:packaged`.
- `docs/METADATA-EDITING-PACKAGED.md`: qualification method, resource fingerprints and results.
