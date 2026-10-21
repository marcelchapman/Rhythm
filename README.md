# Rhythm 0.1

A local personal music library and player for macOS and Linux, built around music you own. The desktop interface follows `artfiles/desktop_prototype.png`.

Rhythm’s long-term scope includes macOS, Windows, Linux, Android, iOS, and cloud synchronization/access across your devices. Version 0.1 implements local desktop functionality. [PRODUCT.md](PRODUCT.md) is the product authority; the promotional landing page is not an implementation specification.

## What works

- First-run library setup with a folder you explicitly choose; no preconfigured music or sample database.
- Recursive, read-only music indexing with metadata and embedded artwork.
- Persistent Albums, Artists, Songs, Genres, Recently Added, Favourites, and Playlists views.
- Search across title, artist, album, album artist, and genre; album sorting and genre filtering.
- Album details and track list; play/pause, previous/next, seeking, time, volume/mute, shuffle, and repeat.
- Queue inspection, play-next, add/remove queue entries, and persistent listening state.
- Create, rename, delete, and add/remove songs from playlists.
- Manual folder rescanning, import reports, missing-file indication, and playback errors.
- Native folder dialogs, application menus, media-session integration, keyboard focus, and desktop window resizing.

## Run from source

Use **Node.js 24 LTS or newer**, npm, and macOS 13+ or a current desktop Linux distribution. The tested host is Intel macOS 15.8.1. On Linux, Electron also needs the usual GTK/NSS/audio/graphics libraries and a graphical session; see the CI workflow for Ubuntu 24.04 dependencies.

```sh
npm ci
npm run dev
```

`dev` makes a production build and launches it. It does not run a hot-reload server. After editing, rerun it. `npm start` launches the last build. Nothing is committed or pushed by these commands.

## First launch

1. Select **Choose library folder**. Create or select an ordinary folder for Rhythm’s database. It can be separate from your music. Select an existing Rhythm folder to reopen that library.
2. Select **Add music folders** and choose one or more music directories. Rhythm indexes them in place.
3. Select an album for its track list, or use its play button. Songs have an options menu for queue, playlist, and file information.
4. Use **Library settings** to add music, rescan folders, or switch libraries. A rescan is required after external file changes.

Rhythm never writes to your source audio files. It does not move, rename, delete, consolidate, or edit embedded tags. Deleting a playlist only deletes its database records.

## Formats and artwork

Indexed extensions: MP3, FLAC, M4A, AAC, Ogg, Opus, WAV, AIF, and AIFF. Files need a recognizable audio stream. Codec support, not the extension alone, determines playback: packaged-app checks on macOS exercised PCM WAV, FLAC, MP3, AAC in M4A, raw AAC, Ogg Vorbis, and Opus. DRM-protected audio is unsupported. AIFF may index but fail playback in Chromium; convert it yourself if needed. Your real-library codec variants still need evaluation on each OS.

Embedded JPEG, PNG, and WebP artwork up to 10 MB is cached. Missing artwork gets a neutral disc placeholder. External `cover.jpg`/folder images are not searched. No commercial album artwork is bundled.

## Data storage and safety

The folder you select contains `rhythm.sqlite` plus SQLite WAL/SHM sidecars while open. It holds tracks, source paths, cached artwork, playlists, favourites, and player settings. Close Rhythm before backing up or copying the library folder. The database contains absolute paths and is not a portable synchronization format.

A `library.json` pointer is stored in Electron’s user-data directory: normally `~/Library/Application Support/Rhythm` on macOS and `$XDG_CONFIG_HOME/Rhythm` (usually `~/.config/Rhythm`) on Linux. `RHYTHM_DATA_DIR` overrides only the pointer/application-data location for isolated development and testing; it does not preconfigure a music library.

An existing unrelated SQLite database is rejected. Disconnected or unreadable roots produce errors rather than erasing library records. Symlinks and hidden entries are skipped. Same canonical paths are indexed once; content-duplicate detection is not implemented. File moves produce a missing old entry and a new path identity. Rhythm does not repair playlists across moves automatically.

No telemetry, streaming service, login, or cloud connection is implemented. The sandboxed UI loads local resources and indexed audio only.

## Test and verify

```sh
npm run typecheck
npm test
npm run test:desktop
# After packaging:
npm run test:packaged
# Optional: FFmpeg-backed checks of five additional codecs
npm run test:codecs
```

Unit tests cover empty/reopened libraries, database ownership, metadata, source safety, indexing, duplicates, malformed files, unavailable/missing paths, album grouping, playlist transactions, state validation, and byte-range audio transport.

`test:desktop` launches real Electron windows against temporary synthetic audio and temporary application data. It tests setup, indexing, playback/seek, search, playlist/favourites/queue, genre/artist views, rescan, and restart persistence. Folder-dialog responses are automated with temporary paths; native picker interaction remains a manual check. It produces screenshots in `.impeccable/review/` and removes its temporary library afterward. FFmpeg is optional: when available, it generates FLAC with embedded synthetic artwork; otherwise the test uses WAV. On headless Linux, use `xvfb-run -a npm run test:desktop`.

The test audio is silence, so automated playback verifies decoding, transport, time advancement, and seeking, not audible output quality. Evaluate sound and your audio device manually.

## Build and install on macOS

```sh
npm ci
npm run dist:mac
```

On Intel macOS this produces `release/mac/Rhythm.app`, `release/Rhythm-0.1.0.dmg`, and `release/Rhythm-0.1.0-mac.zip`. Apple Silicon hosts build their native architecture; filenames gain architecture suffixes where required by the packager. You can also request a specific architecture with the packager CLI after building.

Open the DMG and drag Rhythm into Applications, then launch it. Alternatively copy `release/mac/Rhythm.app` to Applications. Development packages are **unsigned and unnotarized**. On your own trusted build, macOS may require the Finder **Open** action or **System Settings → Privacy & Security → Open Anyway**. No signing identity was provided. The installer does not alter security settings.

`npm run pack` creates a directory bundle without distribution archives. The app bundles Electron; users do not need Node.js or FFmpeg installed.

## Build and install on Linux

AppImage and DEB artifacts were cross-built on macOS, but were not run on Linux. To rebuild and test natively on Linux:

```sh
npm ci
npm run typecheck
npm test
npm run dist:linux
```

On an x64 Linux host, install with either:

```sh
chmod +x release/Rhythm-0.1.0.AppImage
./release/Rhythm-0.1.0.AppImage
```

or:

```sh
sudo apt install ./release/rhythm-desktop_0.1.0_amd64.deb
rhythm-desktop
```

AppImage requires FUSE on some distributions; with a compatible runtime, `--appimage-extract-and-run` is an alternative. Do not run Rhythm as root or disable Chromium’s sandbox. Electron’s sandbox may require appropriate distribution user-namespace settings. `.github/workflows/build.yml` runs checks and packaging natively on macOS and Ubuntu when triggered; it does not publish releases.

Linux packaging and runtime must be verified on Linux. The current implementation was developed and run on macOS; see [VALIDATION.md](docs/VALIDATION.md) for actual results.

## Current limitations

- No cloud sync, mobile clients, Windows release, metadata editing, or automatic filesystem watching in 0.1.
- No gapless/crossfade, ReplayGain, equalizer, audio-device picker, or bit-perfect output guarantee. Volume uses the operating system’s default output device.
- No drag/drop or playlist reordering/import/export. A queue contains unique tracks and supports basic next/add/remove operations.
- Metadata is cached by file size and modification time; unchanged files are not reparsed on rescan. Only embedded artwork is used.
- SQLite artwork caching can grow the database for large collections. No cache-size UI or automated pruning yet.
- Very large collections are not benchmarked. Snapshot transfer and synchronous SQLite writes can cause latency; scans have no cancel control.
- Import issues show at most the first 100 failures. Source permission errors are reported, not repaired.
- State checkpoints every four seconds; abrupt termination may lose a few seconds. Restart restores selection/position without autoplay.
- Licensing is still undecided. Runtime dependencies retain their own licenses.

## Project layout

- `src/domain/` — library persistence, indexing, metadata normalization, playlist rules.
- `src/shared/` — shared types and player-state defaults.
- `src/main/` — desktop shell, preload bridge, local protocols, dialogs, and menus.
- `src/renderer/` — React interface and prototype-derived styles.
- `tests/` — isolated library and transport tests and synthetic WAV generator.
- `scripts/` — desktop smoke/codec checks and reproducible app-icon generator.
- `build/` — original generated application icon.
- `docs/ARCHITECTURE.md` — decisions, security boundary, and trade-offs.
- `docs/ORIGINAL_SPECIFICATION.md` — preserved early discovery document; superseded where PRODUCT.md differs.
- `artfiles/` — original design assets, preserved.

## Useful real-world evaluation

Try a small folder first, with tagged and untagged files, compilations, multiple discs, different codecs, and embedded artwork. Check audible output, seek/next behavior, long titles, search, playlists and restart. Disconnect an external drive and rescan, then reconnect and rescan. For very large libraries, evaluate import time, responsiveness, and database size before indexing the whole collection.
