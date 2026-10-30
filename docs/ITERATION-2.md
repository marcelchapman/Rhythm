> Current behavior is described using the Rio name. Recorded pre-rename artifact paths and CI evidence retain the original working name Rhythm; they are historical records, not current package instructions.

# Iteration 2 — shared Track List and desktop playlist interchange

Developed from clean `main` at **5373ab1 — Add songs view and library interactions**. Local validation date: **2026-10-22**, Intel macOS, Electron 44.9.2. macOS is the active Phase 1 product target; Ubuntu CI remains a portability canary. Work continues in the current uncommitted worktree. No prior implementation was reverted, and no commit or push was made.

## Implementation

### Acceptance failure and correction

Manual testing of the first Iteration 2 package exposed missing desktop integration: an M3U8 dropped into Rio went through the audio-only scanner and was skipped, while Finder Open With had neither an Electron file-open handler nor a document association. The existing parser/import/export domain logic was correct and is preserved. All three entry paths now reach that same importer: File → Import Playlist, direct M3U/M3U8 drops (including mixed audio/folder drops), and macOS file-open delivery.

Playlist documents are never indexed as audio. Multi-file drops process playlists sequentially, keep each playlist's order, index unknown referenced audio safely, and show combined import reports. Audio/folder drops continue using the existing read-only scanner; an explicitly dropped folder is scanned for audio, not recursively for playlist documents.

The main process registers `open-file` before Electron readiness. A bounded inbox retains requests until initialization, a loaded renderer, and a selected library are ready. With no remembered library, first-run setup explains that playlists are waiting; choosing a library resumes processing. Existing windows are shown/restored/focused; opening a file after the last macOS window closes recreates it. File requests arriving during window close wait for the replacement window. Canonical paths coalesce duplicate argv/OS delivery while pending/processing and for two seconds after completion; later deliberate reopening remains possible. Command-line/second-instance paths also feed the inbox without placing macOS assumptions into shared product logic.

Packaging declares only `m3u` and `m3u8`, with role **Viewer** and rank **Alternate**. No default-handler registration or system-default changes are made. Actual Finder/LaunchServices delivery remains an explicit manual acceptance check; automated tests exercise startup arguments, real Electron `open-file` callbacks, readiness deferral, aliases, duplicate delivery, and window reopening.

### Shared Track List

`SongsTable.tsx` became **`TrackList.tsx`**; `song-columns.ts` became **`track-columns.ts`**. There is one table implementation, not per-view copies. Songs, playlist contents, selected Artist/Genre tracks, Favourites, search results, and existing library list-mode results use it. Artist/Genre group navigation and album browsing remain intact. Compact album/queue side-panel lists retain their contextual transport presentation.

Track List keeps virtualization, multi-selection, keyboard navigation/activation, context menus, row drops, and independent column sorting. Headers and cells use the same ordered definitions. Reorder drag targets are header buttons; resize handles are their siblings, so native header dragging cannot intercept resize gestures. Pointer capture drives live sizing with clamped minimums and a 1,200px maximum; release coordinates determine the saved final width even if pointer moves are coalesced. Resize handles also accept Left/Right arrows. The first displayed column stays sticky when it fits the viewport; oversized first columns scroll normally so other columns remain reachable.

### Final manual-acceptance correction — 2026-10-24

Removed the shared Track List's trailing ellipsis/action column at the user's request. The Actions header, per-row action cell/button, hover rules, unused callback/icon, and fixed 42px grid track are gone. Both visual width and announced column count now include only visible metadata. This applies to every view using the same component; the table ends at the final visible metadata column.

Right-click remains the standard contextual-action mechanism, using the unchanged native menu and selection handler. A right-click on a selected row targets the selected group; on an unselected row it replaces selection with that track. Play, Play Next, Add to Queue, Add to Playlist (including New Playlist), and Favourites remain available. The existing keyboard context-menu shortcut is preserved. The empty-playlist hint now directs users to right-click. No replacement popup or metadata editing was added; existing controls outside Track List remain unchanged.

The removed column was never a metadata preference, so no migration, preference reset, database change, or settings change is needed. Metadata order, widths, and visibility use exactly the existing model and persistence.

Exact files touched by this final correction (distinct from the larger retained Iteration 2 inventory below):

- `src/renderer/TrackList.tsx`
- `src/renderer/App.tsx`
- `src/renderer/style.css`
- `scripts/smoke.mjs`
- `scripts/features.mjs`
- `scripts/acceptance.mjs`
- `docs/ITERATION-2.md`

Validation adds rendered header/cell counts, announced column count, exact metadata-only width/grid tracks, aligned final cell edge, absence of ellipsis controls even during hover, and absence of an Actions settings checkbox. Checks cover Songs, playlists, Artist/Genre tracks, Favourites, search, hide/show, horizontal scrolling, and restart. Native context-menu callbacks exercise Add to Playlist and group/unselected-row selection; keyboard menu access, playback/queue/favourite commands, all existing column interactions, large-library virtualization, playlist ordering and source hashes remain covered.

Final correction results: type checking, all 30 unit tests, formatting, production build, and all four source desktop suites passed. All four suites then passed against the newly rebuilt macOS bundle, including the updated empty-playlist hint and Favourites/search checks. The 10,014-track benchmark still rendered only 26 rows. Audio and input playlist hashes remained unchanged. `dist:mac -- --publish never`, DMG verification, ZIP integrity and bundled-output freshness/exclusion checks passed. Built Info.plist still declares M3U/M3U8 Viewer/Alternate. Independent Impeccable visual review returned **ship** for this bounded correction; its documenter confirmed no durable design-system change, leaving DESIGN.md and its sidecar untouched.

### Global presentation preferences

One application/profile-level `view-preferences.json` in Electron user data stores:

```json
{ "version": 2, "trackList": { "columns": { "order": ["title", "duration", "artist", "album", "genre", "bpm", "bitRate", "codec", "disc", "track", "comments", "year"], "widths": {}, "hidden": [] } } }
```

`src/shared/preferences.ts` normalizes order/widths/visibility and applies partial updates. `src/domain/view-preferences.ts` serializes atomic file replacements, merging concurrent width/visibility/order changes without overwriting each other. Normal quit waits for queued preference writes. On the first run without a global preference file, the remembered/first selected library's legacy `settings.views.songs.columns.order` migrates once. Later library switches use the existing global layout; they cannot replace it. The legacy database record is retained. No SQLite schema change/reset is required; schema 2 and its prior migration remain intact.

Unknown/duplicate IDs are removed, newly supported columns append, invalid widths clamp, and corrupt settings use sensible defaults. Hidden columns retain their full stored order and width. **Title is always visible.** Library Settings exposes readable checkboxes for actual supported columns, including the already indexed Year field; no unsupported Composer metadata is invented.

Only presentation is shared. Each mounted content view owns its sort, selection and scroll state; these are not global preferences or new persisted state. Returning to a view starts its normal local defaults. Playlists start in stored playlist order, regardless of Songs sorting or the album-level “newest added” selection. Explicit header sorting changes only that playlist's displayed order, with a **Playlist order** control to restore it; it never rewrites stored membership. Search retains the existing global-search semantics.

### Playlist commands

**File → Import Playlist…** opens a native M3U/M3U8 picker. The imported playlist becomes current, with a count/report and expandable issues. Its name comes from the filename; collisions receive `(2)`, `(3)`, etc.

**File → Export Playlist…** exports the current playlist. From another view, a small existing-style dialog asks which playlist to export, then opens the native save dialog. The output extension is `.m3u8`. Cancelling either native dialog leaves playlists unchanged. Operation guards prevent overlapping playlist operations and library switching/imports from invalidating their database reference.

### Parsing and path handling

`src/domain/m3u.ts` contains Electron-independent UTF-8 parsing and serialization. `src/domain/playlist-files.ts` owns filesystem resolution, safe indexing, and atomic output. The main process only integrates menus/dialogs and narrow IPC; the renderer cannot request arbitrary filesystem writes.

- UTF-8 BOM, LF/CRLF/CR, ordinary path entries, and local `file:` URLs are accepted. Invalid UTF-8 is rejected before playlist creation.
- `#EXTM3U`, `#EXTINF`, and other comments/directives do not become tracks. Actual indexed audio supplies metadata.
- Relative entries resolve beside the input playlist; absolute entries remain absolute. Spaces, Unicode, literal percent signs, and `#` inside paths are not URL-decoded accidentally. Unsupported remote protocols are reported, never fetched.
- Available supported audio is matched by canonical path. The existing read-only scanner indexes unknown files. Missing, unsupported, or unindexable entries are reported and skipped; available entries keep their first-occurrence order.
- Rio's existing unique-membership rule applies: repeated references collapse to one entry. New playlist creation and ordered membership commit together, with rollback on failure.
- Export is UTF-8 `#EXTM3U`, followed by useful `#EXTINF` artist/title/duration and path entries in playlist order. Labels cannot inject new lines. Audio inside the export folder's tree gets `./` relative references; external locations use absolute references. The destination folder is canonicalized so symlinked folders do not produce incorrect relative references.
- Known unavailable tracks retain their stored path on export and are counted in the completion notice. A later import reports/skips files still unavailable; otherwise round trips preserve order and membership.
- Newline/NUL or ambiguous trailing-whitespace track paths fail export explicitly instead of producing a corrupt playlist. Legacy non-UTF-8 M3U encodings require conversion to UTF-8.
- Input limits: 10 MiB and 50,000 entries; issue details are bounded to 100. There is no streaming-URL or remote-playlist support.

### Source safety

Audio is never moved, renamed, copied, deleted, or tag-edited. Imports write only Rio's database. Export writes an exclusive temporary `.tmp` file beside the destination, flushes/closes it, then renames it over the chosen playlist file. Direct audio destinations, symlink destinations, and hard links to indexed audio are rejected. Existing ordinary playlist files may be replaced after the native save dialog. Test music/libraries are isolated temporary fixtures; no real collection is used.

## Files changed

| Area | Files |
|---|---|
| Shared contracts/preferences | `src/shared/preferences.ts` (new), `src/shared/types.ts` |
| Domain/persistence | `src/domain/m3u.ts`, `src/domain/playlist-files.ts`, `src/domain/playlist-open.ts`, `src/domain/view-preferences.ts` (new), `src/domain/library.ts` |
| Native boundary | `src/main/main.ts`, `src/main/preload.cts` |
| Interface | `src/renderer/TrackList.tsx` and `src/renderer/track-columns.ts` (renamed from SongsTable/song-columns), `src/renderer/App.tsx`, `src/renderer/style.css` |
| Tests and commands | `tests/interchange.test.ts`, `tests/tracklist.test.ts`, `scripts/interchange.mjs`, `scripts/acceptance.mjs` (new), `tests/fixtures.ts`, `tests/iteration.test.ts`, `scripts/features.mjs`, `scripts/smoke.mjs`, `package.json` |
| Documentation | `README.md`, `docs/ARCHITECTURE.md`, `docs/VALIDATION.md`, `docs/ITERATION-1.md`, this report |

No dependency/lockfile, prototype assets, product/design-system records, or CI workflow changes. The deterministic seek test in `scripts/smoke.mjs` remains unchanged. Two search-row selectors now target shared Track List rows, preserving their count assertions; the final correction exercises Add to Playlist and Add to Queue through native context-menu callbacks instead of the removed row button. The separate detail-panel playlist-picker focus regression remains covered. `test:desktop` and `test:packaged` now include the interchange and acceptance suites, so the existing CI commands pick it up automatically. No publishing token/permission changes were introduced.

## Validation

### macOS CI queue-transition correction after 399a9f4

The worktree was clean at `399a9f4 — Add shared track list and playlist interchange` before this correction. CI failed at the immediate `assert(await page.getByRole("heading", { name: "Queue", exact: true }).isVisible())` in `scripts/smoke.mjs` (original line 347), after the native Add to Queue callback. This was a Queue-panel assertion, not a playback assertion.

The callback sends `track:action` IPC and returns before the renderer handler and React update necessarily finish. The test raced the Queue render. A test-process-only experiment delayed that delivery by 250ms: the original immediate check returned false, then Queue appeared with Blue hour, while media remained paused at 2.13 seconds throughout. This reproduces the CI symptom without changing application code or audio behavior. CI's exact scheduling delay was not measured.

Paused playback is intentional here: after proving resumed playback advances beyond 2.1 seconds, the smoke test explicitly clicks Pause and waits for `audio.paused` (original lines 280–281). Add to Queue does not start playback. The diagnostic's settled, error-free paused media is therefore expected, not evidence of an audio-device or decoder failure.

The fix waits up to ten seconds for the visible Queue heading, retains the visibility assertion, and additionally requires the requested Blue hour track to appear in the Playback queue list. No sleep, retry of the command, playback workaround, or production-code change was added. Earlier real-playback, paused-seek, deliberate EOF-avoidance and resumed-playback checks are byte-for-byte unchanged. Only `scripts/smoke.mjs` and this report change; workflow, publishing settings, source media and Iteration 2 functionality are untouched.

Post-fix validation: type checking, all 30 unit tests, formatting and whitespace checks passed. `npm run test:desktop` and `npm run test:packaged` each passed all four suites (smoke, features, interchange, acceptance), with unchanged source audio/input playlist hashes. The existing macOS app's main/domain/preferences/renderer outputs were verified identical to the current production build before packaged validation. The fixed smoke also passed with the same injected 250ms queue-command latency; suppressing that command instead correctly timed out at the Queue wait. These fault injections ran only in disposable test processes, not production source. Hosted macOS/Ubuntu Actions still need rerunning; local reproduction establishes the scheduling race but does not measure the hosted runner's exact event timing.

### Iteration validation record

| Check | Result |
|---|---|
| Type checking / production build | Passed |
| Unit tests | **30 passed**, across four suites, including global preference and file-open queue coverage |
| Formatting / whitespace | `npm run format:check` and `git diff --check` passed |
| Dependency audit | **0 vulnerabilities**; no dependencies added |
| Lockfile resolution | `npm ci --dry-run --ignore-scripts --offline` passed |
| Source desktop suites | All four suites passed: smoke, feature, interchange, acceptance; includes removal of the action column and native context-menu regressions |
| `npm run test:packaged` | **All four suites passed against the final rebuilt app**: smoke, feature, interchange, acceptance; includes quitting immediately after a visibility edit and restoring it on restart |
| Playlist parsing | UTF-8/BOM/CRLF, directives, local URLs, relative/absolute paths, Unicode/spaces, invalid encoding, input bounds, unsupported URLs, missing files |
| Playlist persistence | Mixed indexed/new tracks, collision-safe names, duplicate membership, atomic creation rollback, export/import order, real restart |
| Export safety | Audio extension, symbolic link, and source hard-link destinations rejected; source bytes preserved |
| Column interaction | Actual reorder and resize without sorting, exact saved width, visibility/title guard, hidden restoration, cross-view shared presentation, independent playlist order, restart |
| Metadata-only table | No action header/cells/control/grid track; exact metadata-only width and aligned right edge across shared views, hover, hidden columns and restart |
| Right-click selection | Selected group retained and added together; unselected row replaces selection and receives the action; keyboard context-menu access retained |
| Large-library regression | Reordered headers with 10,014 test records; 26 rows rendered after scrolling to the end |
| Desktop file opening | Mixed M3U/M3U8/audio/folder drops; startup queue, running event/alias deduplication, macOS window reopening, and deferred first-run import |
| Source hashes | Generated audio and input playlist SHA-256 hashes unchanged after desktop operations, playlist import/export, and restart |
| Workflow YAML | Parsed; Ubuntu Xvfb canary, read-only permissions, artifact uploads, and explicit `--publish never` preserved |
| macOS packaging | `npm run dist:mac -- --publish never` passed; DMG checksum and ZIP compressed-data integrity valid |
| Packaged document metadata | Built Info.plist verified: M3U/M3U8, Viewer role, Alternate rank |
| Bundle contents/freshness | Compiled main/preload/domain/preferences and renderer assets match; no fixtures, databases, test scripts, or reference artwork bundled |

The UI suite exercises real native File-menu callbacks and preload/IPC, with open/save dialog responses stubbed only inside the isolated test process. It also checks cancellation and export selection from outside a playlist. Test audio is generated silence: decoding/timeline/transport are tested, audible fidelity is not.

## Visual review

The original interchange review covered header dragging, export selection, and import reports. For this acceptance correction, directly inspected eight fresh captures: active column resizing, Library Settings, playlist contents, Songs, Artist tracks, Genre tracks, a mixed-drop report, and the 1050px window. A fresh independent Impeccable finish reviewer returned **ship**, with all five review sections and no material fixes. The navy palette, system typography, compact track rows, and restrained blue resize/insertion feedback remain coherent with the approved product. Native menus/system-dialog appearance and actual Finder dispatch are outside the screenshot review.

The detector returned **31 advisory findings, 0 primary findings**, representing incumbent local styling drift. The documenter compared the prototype, code, and captures and preserved DESIGN.md/sidecar without inventing new durable rules.

Latest evidence is in ignored `.impeccable/review/`: `tracklist-resizing.png`, `tracklist-settings.png`, `tracklist-playlist.png`, `tracklist-songs.png`, `tracklist-artist.png`, `tracklist-genre.png`, `playlist-drop-report.png`, `tracklist-1050.png`.

For the final action-column removal, inspected fresh `tracklist-right-edge.png` (scrolled to the final Year column), `tracklist-playlist.png`, and `tracklist-1050.png`. A fresh independent reviewer returned **ship**, no material fixes, scoped to this removal and preservation of the incumbent desktop design. The documenter reported no system changes; the existing documentation difference between artwork-led full rows and dense table rows remains outside this correction. Native context-menu appearance still requires manual verification; callback behavior is covered by integration tests.

## Artifacts and remaining verification

Rebuilt Intel x64 outputs:

- `release/mac/Rhythm.app`
- `release/Rhythm-0.1.0.dmg`
- `release/Rhythm-0.1.0-mac.zip`

They remain unsigned and unnotarized. The built Info.plist confirms M3U/M3U8 Viewer/Alternate document metadata. No installed app, default handler, or system security setting was changed. Linux was not rebuilt or launched locally for this macOS-focused iteration; any pre-existing local Linux artifacts belong to an earlier build. Rerun the unchanged macOS/Ubuntu GitHub Actions workflow before accepting this iteration's CI status. Apple Silicon packaging/runtime was not exercised locally.

Manual macOS acceptance with the **newly rebuilt app** (replace/select the intended app copy if several Rio bundles exist):

1. File → Import Playlist and export/save/cancel/round trip.
2. Drag one or multiple M3U8/M3U files into Rio, including a mixed audio/folder drop.
3. Finder Open With → Rio while the app is fully quit.
4. Finder Open With → Rio while running, minimized, or with its last window closed.
5. Drag headers to reorder, including distant/off-screen columns.
6. Drag resize boundaries on the normal mouse/trackpad; confirm no accidental sort/reorder.
7. Toggle Track List columns in Library Settings; Title stays visible.
8. Quit/reopen immediately after layout edits and verify persistence.
9. Compare the same presentation in Songs and playlist contents.
10. Check Artist/Genre group navigation and their shared Track Lists.
11. Confirm playlist ordering remains intentional after changing Songs/Albums sorts.
12. Scroll to the final visible metadata column: no action header, cell, hover ellipsis, or extra strip. Right-click a single track and a selected group; verify native Play/Play Next/queue/Add to Playlist/Favourites commands and the keyboard context-menu shortcut.

Actual OS document dispatch/LaunchServices registration, native menu/dialog appearance, audible output, and screen-reader use remain manual checks. Linux runtime and Apple Silicon were not exercised locally; rerun the unchanged target-OS workflow. No managed-media work, metadata writing, file reorganization/deletion, CD importing, synchronization, equalizer, or unrelated features were added.
