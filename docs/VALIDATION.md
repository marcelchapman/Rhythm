# Rhythm 0.1 — implementation and validation

Historical initial-checkpoint record. Current feature-iteration results are in [ITERATION-2.md](ITERATION-2.md); schema-2 migration notes are in [ITERATION-1.md](ITERATION-1.md). The user subsequently confirmed the checkpoint's macOS and Ubuntu GitHub Actions jobs passed after the CI fixes.

The current Iteration 2 acceptance correction adds one shared Track List and application-level `view-preferences.json`, plus playlist drops and queued macOS document-open handling. All four packaged integration suites pass locally; actual Finder/LaunchServices dispatch and the new target-OS CI run remain to be verified. See the current report for exact tests, artifacts, and manual acceptance items; the historical counts and limitations below describe the initial checkpoint only.

Validated on 2026-10-20, on Intel macOS 15.8.1. Runtime: Electron 44.9.2. Development host: Node.js 26.12.0.

## Delivered application

A working local music library/player matching the approved desktop composition: persistent navigation, artwork library, album/queue panel, and bottom player. Includes explicit first-run library selection, folder import/rescan, metadata, embedded artwork, albums/artists/songs/genres/recent/favourites, global search, sorting/filtering, playlists, queue editing, playback, seek, volume, shuffle/repeat, and saved library/listening state.

Electron/React/TypeScript were selected to implement the prototype precisely with consistent desktop playback. SQLite owns the persistent library. The renderer is sandboxed behind a narrow IPC bridge; the source collection is read only. Domain/library work is separate from the desktop shell. Mobile needs additional adapters; no mobile or cloud functionality is claimed. See [ARCHITECTURE.md](ARCHITECTURE.md).

## Actual checks

| Check | Result |
|---|---|
| `npm run typecheck` | Passed for renderer and desktop/domain code |
| `npm test` | 9 tests passed |
| `npm run format:check` | Passed |
| `npm run build` | Passed |
| `npm run test:desktop` | Passed with isolated 20-track library; source launch |
| `npm run test:packaged` | Passed against the actual bundled `Rhythm.app`, including restart |
| `npm run test:codecs` | Packaged app indexed, decoded, and sought MP3, AAC/M4A, raw AAC, Ogg Vorbis, and Opus |
| PCM WAV and FLAC playback/seek | Passed in the desktop suite; FLAC included embedded artwork |
| Source-file safety | SHA-256 hashes unchanged across desktop operations and restart |
| Dependency audit | 0 vulnerabilities after final dependency resolution, including formatter |
| Clean install resolution | `npm ci --dry-run --ignore-scripts --offline` passed against lockfile |
| UI detector | `impeccable detect --json src/renderer` returned `[]` |
| Independent Impeccable visual review | `ship`, no material fixes; seven required captures inspected |
| Distribution contents | No music fixtures, test directories, original reference artwork, or library databases in macOS app archive |
| Packaged runtime freshness | macOS and Linux unpacked archives match compiled main, library, and renderer entry files |
| macOS DMG integrity | `hdiutil verify` passed |

The unit suite covers library creation/reopen, rejecting unrelated databases, RIFF metadata, source bytes/timestamps, incremental indexing, duplicate paths, malformed audio, symlink loops, unavailable/missing/restored files, disc-folder grouping, playlist transaction rollback, state normalization, and byte-range/HEAD transport.

The desktop suite covers first-run and empty-library states, folder-selection wiring, import/artwork, playback and seeking, volume, global search (including from a playlist), playlists, favourites, queue, artist/genre grouping, rescans, compact-window horizontal overflow, restart persistence, and source-file safety. Folder dialogs return automated temporary selections; interacting with the actual native folder picker remains a manual check.

All test music is generated silence. Decoding, timeline advancement, and seeking are verified; audible fidelity, speakers/headphones, Bluetooth, and system media-key delivery need manual evaluation. AIFF playback is not verified. No tests touched the user's music.

## Artifacts actually produced

All builds below are **x86-64** and live in the ignored `release/` directory:

- `release/mac/Rhythm.app` — macOS application bundle; launched and tested.
- `release/Rhythm-0.1.0.dmg` — macOS installer image; checksum verified.
- `release/Rhythm-0.1.0-mac.zip` — macOS application archive.
- `release/Rhythm-0.1.0.AppImage` — Linux AppImage, cross-built on macOS.
- `release/rhythm-desktop_0.1.0_amd64.deb` — Linux Debian package, cross-built on macOS.

The Linux executable and AppImage identify as x86-64 ELF; the DEB identifies as a Debian binary package. **Linux installation and runtime were not tested**, and the target-OS CI workflow has not been run. Cross-packaging success is not a Linux runtime verdict. Apple Silicon builds are configured through electron-builder but were not produced or tested here.

macOS artifacts are unsigned and unnotarized. Credentials were not supplied. No system security settings were changed.

## Install and run

### macOS

Open `release/Rhythm-0.1.0.dmg`, drag Rhythm into Applications, and launch it. macOS 13 or newer is required by the bundled runtime. For a trusted local unsigned build, use Finder's Open action or the Open Anyway option in System Settings → Privacy & Security if prompted. Alternatively copy `release/mac/Rhythm.app` into Applications.

From source:

```sh
npm ci
npm run dev
```

### Linux

Copy the generated AppImage to a Linux x64 machine, then:

```sh
chmod +x Rhythm-0.1.0.AppImage
./Rhythm-0.1.0.AppImage
```

Or on a compatible Debian/Ubuntu system:

```sh
sudo apt install ./rhythm-desktop_0.1.0_amd64.deb
rhythm-desktop
```

To rebuild and verify natively:

```sh
npm ci
npm run typecheck
npm test
# Use xvfb-run on a headless CI machine; normal desktops need no wrapper.
npm run test:desktop
npm run dist:linux
npm run test:packaged
```

The GitHub workflow supplies a target-OS build/check recipe without publishing releases. See the README for Linux dependencies and AppImage/FUSE notes.

## Files and retained work

Added `src/{domain,shared,main,renderer}`, isolated `tests/`, build/test/icon scripts, package manifests and lockfile, TypeScript/Vite configuration, app icons, target-OS CI, architecture/validation documentation, and design-system records (`DESIGN.md`, `.impeccable/design.json`). Updated README, PRODUCT.md's implementation stack, and ignore rules. The original discovery README is retained in `docs/ORIGINAL_SPECIFICATION.md`. Original `artfiles/` assets are unchanged. Existing untracked skill/hook files were preserved. No commit or push was made.

## Known limits and recommended evaluation

There is no cloud/mobile implementation, tag editing, filesystem watcher, external-cover lookup, content deduplication, path-move reconciliation, playlist ordering/import/export, audio-device selector, gapless playback, crossfade, or ReplayGain. Symlinks and hidden files are skipped. Source paths are absolute. State checkpoints can lose the last few seconds on forced termination. Database artwork caching and synchronous snapshots have not been benchmarked on very large collections; scanning has no cancel control and reports at most 100 issues. Full limitations are in README.

Start with a small real folder. Evaluate audible playback through your usual output, codecs and seeking, embedded artwork and long tags, compilation/multidisc grouping, search from different views, playlist edits, queue/shuffle/repeat, restart, disconnected/remounted drives, and import performance before indexing a large collection. Linux installation, sandbox behavior, desktop association, codecs, and audio output are the highest-priority platform checks still outstanding.

Screenshots in `.impeccable/review/` are development evidence using an isolated synthetic library, not bundled demo content.
