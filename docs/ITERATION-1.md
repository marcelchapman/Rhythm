# First feature iteration after Rhythm 0.1

Validated locally on 2026-10-21 on Intel macOS with Electron 44.9.2. This extends the existing desktop architecture and approved visual direction. No commit or push was made. The original checkpoint's CI was green on macOS and Ubuntu according to the user; this iteration has not been run in GitHub Actions.

## Behaviour and causes

The Add to Playlist selector lost focus because the shared modal effect depended on an inline `close` callback. Every parent render removed/reinstalled the trap, restored the previous focus, and focused the Close button again. This also affected typing in playlist forms. The effect now belongs to the modal's mounted lifetime, reads the latest callback through a ref, and initially focuses the input or selector. Integration tests verify that playlist selection retains focus and that sequential playlist-name typing works.

Playlist additions now append against current database contents in one transaction. Previously the renderer sent a replacement list assembled from its snapshot. The shared append operation preserves order, rejects unknown tracks, rolls back failures, and avoids duplicates across the picker, context menu, and internal drop. Existing create/rename/delete/remove behaviour remains available; File → New Playlist and its Command/Ctrl+N shortcut open the same creation form. A new playlist can also be created with the context-menu selection already added.

Track right-click uses native Electron menus: Play, Play Next, Add to Queue, Add to Playlist, and Favourite/Remove from Favourites. A typed command event joins the existing transport/state logic. Menus validate indexed IDs and disable playback actions when all selected files are unavailable. No source-file modification or deletion commands exist.

Songs now has selectable, sortable columns for title, time, artist, album, genre, BPM, bit rate, kind/format, disc, track, and comments. Missing values are explicit; numbers sort numerically and unknown values stay last in both directions. Long tags truncate with full-value tooltips. Headers/title stay visible while scrolling horizontally. Click, Shift-click, and Command/Ctrl-click select tracks; double-click or Enter plays; arrow/Home/End keys navigate and Shift+F10 opens actions. Search includes comments/codec alongside the existing fields.

Visible table rows plus overscan are rendered instead of the whole collection. Sorting/filtering is memoized separately from playback updates. A benchmark initially exposed that the right-side album/queue list could still create thousands of controls; it now starts with 200 tracks and offers Show more. This does not limit which tracks can play or appear in the queue.

External drops pass actual disk-backed File objects to Electron's preload `webUtils.getPathForFile`, then to the existing read-only scanner. Both individual audio files and recursive folders are retained for rescanning. Internal drops carry validated track IDs to sidebar playlists. Blue target outlines and a file-import cue show the intended action. Audio stays in place: no copy, rename, move, tag write, or deletion is implemented.

## Database upgrade

Schema 1 migrates to **schema 2** with additive ALTER statements and the version change in a single transaction:

- `bpm REAL` and `bitRate REAL`: nullable, bit rate stored in bits/second.
- `comments TEXT NOT NULL DEFAULT ''` and `codec TEXT NOT NULL DEFAULT ''`.
- `metadataVersion INTEGER NOT NULL DEFAULT 0`: invalidates the old metadata cache once.

IDs, paths, added dates, favourites, artwork, playlists, and player state are preserved. New metadata comes from `music-metadata`, never invented values. Previously indexed tracks populate the new fields on the next **Rescan folders**, even if their size/mtime is unchanged; subsequent scans skip unchanged current-version metadata. Missing fields stay empty/null and the UI displays an em dash. Comments retain the existing 4,000-character metadata normalization limit.

Close Rhythm and back up the library folder before upgrading. The prior schema-1 app safely rejects an upgraded library as needing a newer application; there is no downgrade migration.

## Validation

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 15 tests passed across two suites |
| `npm run format:check` | Passed |
| `git diff --check` | Passed |
| `npm ci --dry-run --ignore-scripts --offline` | Passed; no dependency or lockfile changes |
| `npm audit --json` | 0 vulnerabilities |
| `npm run test:desktop` | Existing smoke suite and new feature suite passed |
| `npm run test:packaged` | Both suites passed against rebuilt macOS Rhythm.app |
| `npm run test:codecs` | Packaged macOS app indexed, decoded, and sought MP3, M4A/AAC, raw AAC, Ogg Vorbis, and Opus |
| Source safety | Generated audio SHA-256 hashes unchanged after import, playlist/queue/favourite operations, drops, and restart; unit tests also verify metadata reads preserve mtime |
| Migration | Populated schema-1 database upgraded, reparsed, and reopened with IDs, favourites, playlist order, state, and added dates preserved |
| Playlist transaction failures | Unknown track/deleted playlist rejected; partial additions roll back |
| Large Songs rendering | 10,014 test records, 26 rendered rows after scrolling to the end; launch plus navigation/scroll approximately 1.5s source / 2.2s packaged in the local run |
| Sort behaviour | Natural title ordering, numeric metadata, absent values last in either direction; 20,000-record unit fixture |
| Workflow YAML | Parsed; read-only repository permissions, Ubuntu Xvfb test command, artifact uploads, and explicit `--publish never` retained |
| macOS DMG | Rebuilt; `hdiutil verify` valid |
| macOS archive | Current compiled main/preload/domain/renderer verified; no test music, test scripts, library databases, or original reference assets bundled |
| `npm run dist:linux -- --publish never` | x64 AppImage and DEB cross-build passed; no Linux runtime claim |

The new feature suite runs actual native menu callbacks with popup display intercepted only in the isolated test process. It verifies Play, Play Next, Add to Queue, playlist submenu additions, favourites, File-menu creation, multi-selection, sorting, picker focus, duplicate-safe multi-track playlist drops, disk-file and directory drops through the real preload, and restart persistence. The rendering benchmark inserts explicit synthetic records into its temporary database; it is not a 10,000-audio-file import benchmark. All real test audio is generated silence in temporary folders, never the user's music.

The previous Ubuntu deterministic seek regression check in `scripts/smoke.mjs` and the CI workflow remain unchanged. The workflow now exercises the new suite through `test:desktop`; normal CI packaging still passes `--publish never` for both platforms. No GH_TOKEN, publishing permissions, or release automation was added.

## Visual review

Inspected the real rendered desktop table, horizontally scrolled metadata, 1050px window, and focused playlist picker. A fresh independent Impeccable reviewer returned **ship**, with no material fixes: the navy three-column shell, system type, blue state treatment, persistent player, and existing dialog language remain consistent. Native menu appearance is outside the screenshot evidence. The detector reported advisories, no primary findings. The documenter compared the extension to the incumbent system and preserved DESIGN.md and its sidecar; unrecorded local values were not canonized or repaired as an unrelated design-system change.

Development captures live in ignored `.impeccable/review/`: `songs-desktop.png`, `songs-metadata.png`, `songs-1050.png`, and `playlist-picker.png`.

## Packages and follow-up checks

The rebuilt Intel macOS outputs are `release/mac/Rhythm.app`, `release/Rhythm-0.1.0.dmg`, and `release/Rhythm-0.1.0-mac.zip`. They remain unsigned and unnotarized; no installed application or system security setting was changed.

Linux x64 outputs were also rebuilt: `release/Rhythm-0.1.0.AppImage` and `release/rhythm-desktop_0.1.0_amd64.deb`. Packaged entry files in both macOS and Linux archives match the current compiled application. These Linux artifacts were not installed or launched on this macOS host.

Before relying on a large collection, manually check native right-click/submenu presentation and Command/Ctrl+N, Finder/Linux file-manager gestures for files and folders, scrolling/multi-selection, real tagged BPM/comments, audible output on the chosen device, and reopening a backed-up existing library followed by a rescan. Rerun macOS/Ubuntu GitHub Actions for this iteration; Linux native runtime and Apple Silicon packaging were not exercised locally.

No cloud/mobile implementation, metadata writing, managed-media organisation, playlist-file import/export, or playlist reorder UI was added. Snapshot transfer and sorting still work on the full collection; very large import/database performance and accessibility with platform screen readers need real-world evaluation. Existing codec/audio limitations in README still apply.
