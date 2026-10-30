> Current behavior is described using the Rio name. Recorded pre-rename artifact paths and CI evidence retain the original working name Rhythm; they are historical records, not current package instructions.

# Sidebar playlist context menu

Baseline: `a57be64` (context-sensitive library summaries, including the accepted compact centred footer). No schema, audio-file, sidebar styling, summary or playback changes are introduced.

## Native menu and target

Each user-playlist sidebar button sends its own stable playlist ID through `showPlaylistMenu`. Right-click does not invoke the normal left-click navigation handler. Shift+F10/ContextMenu on the focused playlist uses the same path. Built-in destinations have no playlist-menu handlers.

Main validates that the ID exists in the current library, builds an Electron `Menu` and calls its native `popup` for the Rio window. There are exactly three items:

1. **Export Playlist…**
2. **Duplicate Playlist**
3. **Delete Playlist…**

The menu callback captures that validated ID and emits a typed `playlist:action`, separate from track menus and desktop playlist-import notifications. The renderer routes the action using that ID, never `activePlaylist` as an inferred target. Operations revalidate the ID in main. Menu items are disabled during import/export/scanning/library selection; the existing `playlistOperation` guard serializes export, duplication and deletion/confirmation. Stale IDs fail without modifying another playlist. Track context-menu listeners, selection, drag payloads, sidebar drop handlers and normal left-click navigation remain unchanged.

## Reused operations

**Export** opens the native Save dialog directly, without an in-app preparatory prompt. It calls the existing renderer `exportPlaylist(id)`, existing `playlist:export-file` IPC/save dialog and `exportPlaylistFile` domain writer. File-menu export uses exactly the same path. UTF-8 M3U8, existing relative/absolute path behavior, extension handling, Unicode, playlist order, unavailable-reference reporting, atomic output and source-overwrite protections are retained. Cancelling creates no output and changes no playlist/membership/audio records. No second serializer or export worker exists.

**Duplicate** adds `Library.duplicatePlaylist(id)`, which looks up current source membership and calls the existing atomic `createPlaylist(name, trackIds)`. That function assigns a fresh UUID and inserts ordered memberships transactionally. Source and copy can subsequently change independently. No track, receipt or audio copy is created. Empty playlists are supported. The renderer refreshes sidebar data and reports the new name while leaving view, filters and browsing context intact; it does not navigate to the copy.

Names use `Original Name copy`, then `Original Name copy 2`, `Original Name copy 3`, etc., choosing the first available candidate. Collision comparison is case-insensitive using the same locale-lowercase convention as existing playlist import. The existing trimmed 1–120 UTF-16-unit constraint remains authoritative. A long source name is truncated only enough to fit each suffix, with trailing whitespace removed and no split surrogate pair; the resulting name is still validated by `createPlaylist`. This does not add a global uniqueness constraint to manual playlist creation/rename.

**Delete** reuses the existing `Library.deletePlaylist(id)` SQL deletion and its foreign-key membership cascade. Main now wraps the existing `playlist:delete` IPC in the established native warning-dialog pattern: the message names the target, the detail explicitly preserves songs/audio, and Cancel is both the default and cancellation button. The operation lock remains held across confirmation; a removed or renamed target is rejected after the dialog. The existing toolbar delete action shares this exact confirmation and renderer reconciliation path. Its former HTML confirmation modal is removed, so there is one deletion flow.

Cancel returns `false` with no playlist, membership, track or audio mutation. Confirmed deletion returns `true`; only then does the renderer refresh. If the removed ID is currently open, it navigates to the existing **Playlists** view. Otherwise it preserves the current view. Deleted-ID entries in the current Back/Forward history are replaced with Playlists, retaining history indices and preventing stale routes. Current decoder, track identity, queue, favourites and unrelated playlists are untouched. Ongoing normal playback-position persistence may continue while a dialog is pending; cancellation does not stop playback.

## Persistence and safety

Duplicate membership and deletion commit immediately through existing SQLite operations and survive restart. No migration or new storage mechanism is introduced. The existing player-view save/before-unload path persists the valid fallback view after open-playlist deletion. Export is a file-writing operation only at the chosen playlist destination; duplication/deletion perform no audio filesystem operation. There is no OS Trash call in either playlist operation.

The tests use disposable libraries and generated audio, including both managed and referenced tracks. Original and managed fixture bytes and mtimes are checked. Native playlist tests replace `shell.trashItem` with a failing safety wrapper and assert it is never called. They do not open the production library or install an app.

## Coverage

`tests/playlist-actions.test.ts` adds seven cases: fresh independent UUID and ordered membership; source/copy edit independence; unchanged track/receipt/file inventory; restart; case-insensitive `copy`/number collisions and empty copies; maximum-length/Unicode naming; missing source and transactional rollback on injected membership failure; and deletion cascade/persistence with intact library, locations, player and files.

`scripts/playlist-menus.mjs` exercises actual sidebar events, preload IPC, Electron Menu instances and native-dialog callbacks in isolated source and packaged apps. Coverage includes exact labels/window/target; right-click and keyboard targeting while another playlist remains open; shared native-context/File-menu M3U8 export order and cancellation; three independent named copies; existing track menu separation and shared drag/drop payloads; duplicate and deletion restart persistence; pending and cancelled deletion with unchanged records; library-switch rejection during confirmation; background/current/empty playlist deletion; toolbar/context confirmation reuse; Back/Forward fallback; built-in exclusion; stale IDs; real advancing playback retained across actions; and unchanged referenced/managed audio. Dialog responses are controlled and Menu popup capture is test-only. Native menu/dialog appearance still needs manual acceptance.

Both complete desktop commands include the new suite. `npm run test:playlist-menus` builds and runs it alone.

## Validation

The following full-suite results record the initial functional implementation, before the narrow quiet-operation correction below.

Validated locally on Intel macOS with the current Node/Electron toolchain:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | All 212 tests in 14 files passed, including seven new playlist-action cases |
| Focused `npm run test:playlist-menus` | Passed, including native target/cancel, shared export/delete, history fallback and restart checks |
| `npm run test:desktop` | All 13 source desktop suites passed |
| `npm run dist:mac -- --x64 --publish never` | Intel app, DMG and ZIP built without publishing |
| `npm run test:packaged` | All 12 packaged desktop suites passed against the rebuilt app |
| `npm run test:codecs` | MP3, M4A, raw AAC, Ogg Vorbis and Opus indexed, decoded and sought successfully |
| Package freshness | All 16 compiled files match ASAR; ZIP and read-only mounted DMG payloads match the tested app byte-for-byte; ASAR SHA-256 `59b97f53ab7e8900afed40773f745a7e10b97f2231c81d34d0b8911f8e237b35` |
| Package integrity | DMG checksum verification, ZIP compression test and plist lint passed; executable is Mach-O x86_64; no fixture audio, tests or databases bundled |
| Accepted regressions | Track/compact multi-selection, native Settings/startup, 10,014-track virtualization, columns, interchange, recovery, managed cleanup, playback and 25.6px centred summary footer remained green |
| Formatting/syntax/diff | `npm run format:check`, `node --check scripts/playlist-menus.mjs` and `git diff --check` passed |
| Media safety | Playlist fixtures (references, original recovery/copy sources and managed copies) retained bytes/mtimes; playlist actions made zero Trash calls |

Fresh artifacts: `release/mac/Rhythm.app`, `release/Rhythm-0.1.0.dmg`, `release/Rhythm-0.1.0-mac.zip`. The DMG was mounted read-only for payload comparison and detached; nothing was installed. Packages remain unsigned/unnotarized under the existing configuration. No production library was opened for modification and no stage/commit/push occurred. Codec fixtures contain generated silence, so audible output remains a manual check. Native menu/dialog appearance and real-library acceptance remain manual; Ubuntu runtime behavior still needs its hosted portability canary run (no Linux runtime available locally).

## Quiet-operation acceptance correction

The export instruction used `setProgress` and the shared busy/progress banner; the same mechanism still serves actual scanning, copying, recovery and removal work. Only export's preparatory text and its paired progress cleanup were removed. The banner now requires both `busy` and nonempty `progress`, so busy flags alone do not create an empty spinner during Export, Duplicate or native Delete confirmation. Existing operation guards, completion messages (`Exported…`, `Created…`), native confirmation, errors and failure reporting remain intact. No notification system or playlist semantics changed.

The native playlist test holds Save and Delete confirmation pending and asserts that no preparatory status banner is added. It also refuses an invalid export destination and verifies the existing actionable error remains visible, with no playlist/track/source mutation. Interchange completion waits use the re-enabled existing controls rather than assuming a spinner must appear for export.

This correction changes only `src/renderer/App.tsx`, `scripts/playlist-menus.mjs`, `scripts/interchange.mjs` and this report. Targeted validation passed: typechecking, formatting/syntax/diff checks; all 17 playlist-action/interchange unit tests; source playlist-menu, interchange, managed-media and recovery suites; and packaged playlist-menu/interchange suites. The first source interchange attempt timed out at the unchanged initial pointer-header-drag check (`scripts/interchange.mjs:105`), before reaching export; the same check and the remaining suite passed unchanged on retry. No column/drag behavior or assertion was altered.

The Intel app/DMG/ZIP were rebuilt with `npm run dist:mac -- --x64 --publish never`. DMG checksum verification, ZIP compression testing, plist lint and x86_64 executable checks passed. All 16 compiled files match the packaged ASAR, and ZIP plus read-only mounted DMG payloads match the tested app byte-for-byte. Current acceptance ASAR SHA-256: `c81151fba786ba23bcbaad7d0badd05dd087abdb69c1306e6ed185949785db45`. Fresh paths remain `release/Rhythm-0.1.0.dmg` and `release/Rhythm-0.1.0-mac.zip`. No application was installed and no stage/commit/push occurred.

## macOS CI history-test correction

The macOS failure at the former `scripts/playlist-menus.mjs:443` waited for an unresolved accessible Back button, rather than a resolved but disabled button. The test assumed that native window creation exposed the history controls. Existing responsive CSS hides `.history-controls` at widths of 1050px or less; the suite did not establish its viewport. A disposable macOS reproduction at the exact post-deletion point showed Back present and enabled in the DOM, but its container had `display: none` and the role locator matched zero buttons at 1024px. At 1464px the same valid history control was visible. The original hosted failure did not log its viewport, so its precise initial width is unavailable.

The test now explicitly sizes every launched window to 1464px and waits for that width and the visible Back control, using the existing native-window sizing approach from the summary suite. It logs the initial and established widths for hosted diagnostics. After restart it explicitly visits Songs and the open playlist: navigation history itself is not persisted. Following deletion, Back must expose the sanitized Playlists history entry, then the known Songs entry; Forward must traverse both valid Playlists entries and end disabled. Forward enablement synchronizes the first Back transition even though that transition leaves the heading unchanged. Background deletion, playback, cancellation, persistence and media-safety assertions remain intact. No production code, responsive styling, timeout or playback assertion changed.

Validation on Intel macOS passed: the focused source suite normally; the focused suite with every initial window forced to 1024px before the corrected launch setup; and all 13 suites in `npm run test:desktop`, including a third successful playlist-menu run. Typechecking, all 212 unit tests, formatting, script syntax and diff checks also passed. The original hidden-control condition was reproduced deliberately before applying the correction; the disposable instrumentation was not retained in the repository. Hosted macOS and Ubuntu reruns remain the final portability check. No package rebuild is required for this test-only correction.

## Manual macOS acceptance

Quit an older running Rio before launching the new build. Keep playlist A or a library view open; right-click playlist B and verify exactly the three native menu items. Cancel export and deletion once. Export B and check ordered references; duplicate B repeatedly and check naming, independent edits and sidebar visibility while A remains open. Delete B and confirm the other view and playback stay intact. Delete the open playlist and verify the Playlists fallback, including Back/Forward and restart. Check that songs, favourites, queue and managed/referenced audio remain present. Confirm normal track menus and drag-to-playlist behavior, and compare the shared toolbar delete confirmation. Use only sacrificial data when testing deletion.

## Files changed

`src/domain/library.ts`, `src/main/main.ts`, `src/main/preload.cts`, `src/shared/types.ts`, `src/renderer/App.tsx`, `tests/playlist-actions.test.ts`, `scripts/playlist-menus.mjs`, `package.json`, `README.md` and this report. No CSS or unrelated accepted behavior changes.
