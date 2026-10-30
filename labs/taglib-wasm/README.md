# Metadata writer qualification lab

Experiment only. No production integration, UI, IPC, managed behavior change or library database access. All audio is generated sine-wave data; images are generated solid-color JPEG/PNG files. No user music is used.

The compatibility assessment was reported before installation. `taglib-wasm` is pinned to **2.4.0** here only, with its own npm manifest/lockfile/cache. Its embedded engine reports **TagLib 2.3.2**. Root manifests and production code remain unchanged. See [REPORT.md](REPORT.md) for the recommendation and [RESULTS.json](RESULTS.json) for measured results.

## Reproduce

Requires Rio's existing dependencies and local FFmpeg/FFprobe. From the repository root:

```sh
npm ci --prefix labs/taglib-wasm --ignore-scripts --no-audit --no-fund --cache ./labs/taglib-wasm/.npm-cache
node labs/taglib-wasm/qualify.mjs --generate --backend=wasi --label=node-wasi
node labs/taglib-wasm/qualify.mjs --backend=emscripten --label=node-emscripten
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron labs/taglib-wasm/electron-main.mjs --backend=wasi --label=electron-wasi
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron labs/taglib-wasm/electron-main.mjs --backend=emscripten --label=electron-emscripten
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron labs/taglib-wasm/electron-main.mjs --backend=emscripten --label=electron-emscripten-buffer --io=buffer --formats=mp3,flac,m4a
node labs/taglib-wasm/edges.mjs --backend=emscripten
node labs/taglib-wasm/edges.mjs --backend=wasi
node labs/taglib-wasm/refinements.mjs
node labs/taglib-wasm/organization.mjs
node labs/taglib-wasm/asar-probe.mjs
node_modules/electron/dist/Electron.app/Contents/MacOS/Electron labs/taglib-wasm/generated/writer-lab.asar
node labs/taglib-wasm/report.mjs
node labs/taglib-wasm/validate.mjs
```

Run serially: generator and result files are intentionally reused. Paths shown for Electron are macOS-specific; Linux/Windows runtime execution is not claimed. The Electron entry is a standalone windowless lab, not Rio's application entry. It uses a lab-local profile and no IPC handlers or BrowserWindows. The ASAR contains only this lab's test entry and dependencies; it is not a rebuilt Rio package.

`qualify.mjs` records each failure and continues, so a zero exit code means the experiment completed, not that every writer operation qualified. `validate.mjs` asserts the observed successes **and expected failures**. It must fail if observations change and require reassessment. Only generated fixture paths may reach the writer helper. Generated original hashes are checked after qualification and reporting.

## Evidence

- `qualify.mjs`: 32 fresh-copy operations per format, independent reads, property preservation, artwork, explicit clears, missing-tag/fallback checks, audio integrity, and default partial-path follow-up.
- `edges.mjs`: independently injected ID3 frames/flags/comments, native FLAC application/picture-geometry blocks, MP4 mdta metadata, vendor freeform atoms, and preservation-aware image-index experiments.
- `refinements.mjs`: unambiguous comments, native numeric-atom removal and multi-value preservation.
- `asar-probe.mjs`: WASI/Emscripten inside ASAR and with explicit external WASM paths; no distribution archives or installation.
- `organization.mjs`: calls the existing pure production planner; creates no music directory and moves no file.
- `RESULTS.json`: compact retained evidence, versions, WASM hashes, native edge snapshots and test matrix. Detailed per-operation native dumps and generated outputs remain under ignored `generated/`.

The lab writes no database. Full Rio source/package regression suites were not run because production was unchanged and those suites create fixtures outside this dedicated lab. The optional FFmpeg executables are test instruments, not a proposed shipping dependency.
