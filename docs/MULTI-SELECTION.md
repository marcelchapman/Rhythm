# Rhythm — multi-selection foundation

Baseline: `1ca6360`, following safe removal (`bb28c60`) and Show in Finder. This mission extends the shared Track List and existing action/removal pipeline. It does not introduce album-level commands, schema changes, tag editing, new menus, or a second selection system.

## Selection

The shared `useTrackSelection` hook owns each mounted list's selection with stable track IDs, an anchor ID and a focus ID. Both the main metadata Track List and the compact album/details and playback-queue lists use it; their selections are scoped to the list rather than merging unrelated surfaces. Plain click replaces the selection. Command-click on macOS toggles; Control-click is the convention on Linux/Windows. Platform interpretation stays at the renderer boundary. Shift-click selects the contiguous displayed range from the anchor. Shift-arrow grows/contracts from that anchor using the moving focus, rather than repeatedly starting at the first selected row. Home/End, Enter and keyboard context activation use the same model; keyboard context actions target the focused row.

Right-click inside the selection preserves it and focuses the clicked track. Right-click outside selects/focuses that row and establishes a new anchor. Selection and anchors follow IDs through sorting; unavailable IDs are pruned after filtering/removal without selecting neighbouring tracks. The main table's selection styling, column preferences, layout and virtualization use their existing implementations. Compact rows use the same selected color token, preserve album/queue order and 200-row Show more pagination, and drag the selected IDs in displayed order. Compact End/arrow navigation stays within the currently revealed rows; Show more reveals the next page without discarding the anchor or selection. Plain row/title clicks select, while play buttons, double-click and keyboard activation play. Switching albums or switching between album and queue scopes clears that list's selection; membership changes prune only unavailable IDs.

## Existing command scopes

| Native command | Target |
|---|---|
| Play | Selected tracks in displayed order; starts the first available track |
| Play Next / Add to Queue | Complete selection, retaining existing availability/deduplication rules |
| Add to Playlist / New Playlist | Complete selection |
| Favourite / Remove from Favourites | Complete selection, using existing collective target state |
| Consolidate to Rhythm Media | Complete selection, retaining existing reference-only and ownership rules |
| Remove from Playlist | Complete selection; only memberships in the actual contextual playlist |
| Delete from Library | Complete selection; one native confirmation |
| Locate File | Single missing track only; unavailable for multi-selection |
| Track Info | Clicked/focused context track only |
| Show in Finder (macOS) | Clicked/focused context track only |

The two removal callbacks now dispatch the selection rather than a one-element clicked-track array. Other collection commands already accepted selections and keep their established behavior. Compact album/details and queue native menus now dispatch the selection with an explicit context ID. The redundant hover ellipsis and its Options dialog have been removed; collection commands remain in the native menu, and Track Info exposes the clicked track's file information. The per-row queue remove button still removes only that queue entry, preserving its established behavior. Existing album consolidation is unchanged; no album removal command was added.

## Confirmation and failure contract

Main resolves and classifies every selected identity before showing the confirmation. For multiple tracks, the dialog counts managed copies that will move to Trash and references whose original files remain untouched. A mixed selection quantifies both consequences. Cancel is the default/Escape action and returns without invoking deletion. Existing single-track title/path confirmations remain.

After confirmation, all locations/ownership are checked against the confirmed snapshot before any removal. The existing media-operation lock covers confirmation and the entire batch. Each track is then rechecked immediately before using the existing deletion worker. Managed copies retain every root/device/inode, containment, symlink, completed-receipt and digest check in `validateManagedTrash`; selecting references together with managed tracks grants no authority over references. The managed validation implementation is unchanged.

Execution intentionally uses independent per-track transactions, continuing after an item fails. There is no SQLite transaction spanning asynchronous OS Trash. For each successful track, the original cleanup removes the identity, locations, receipts, all playlist links, favourite/artwork and persisted queue/current references. A failure rolls back that track's database cleanup and leaves its identity/relationships intact. If its file already reached Trash, the result explicitly marks that outcome and preserves the missing identity for Trash restoration or Locate File recovery.

The result contains successful IDs and per-track failure reasons/physical outcomes. The renderer removes only successful IDs from live data, queues and pending targets. It clears decoder/current/media-session state only if the current track was successfully removed. An unaffected current track continues playing. If the current file reached Trash but database cleanup failed, buffered playback pauses while the retained identity remains recoverable. The error banner reports removed/total and retained counts, names/reasons for the first five failures, and an explicit remaining count when needed. It never reports complete success for a partial result.

Playlist multi-remove uses one synchronous SQLite transaction against current memberships. Remaining positions/order, other playlists, library identities, favourites, player and files are preserved. Library deletion from a playlist uses exactly the global deletion pipeline.

Existing limits remain: OS Trash and SQLite cannot be atomic together; a crash after Trash can leave a recoverable missing entry. Explicit rescanning can rediscover removed references; removal is not an import exclusion. The path-based native Trash API retains its documented concurrent external replacement limits. No permanent deletion fallback exists.

## Manual-acceptance correction: compact lists

Manual acceptance exposed a missing presentation: the original implementation covered `TrackList.tsx`, while `App.tsx` had a separate `renderTracks` closure for the album/details column and playback queue. That closure had no selection state and hard-coded `[track.id]` for context menus and dragging. The prior scope claim was incomplete.

The correction extracts the existing selection lifecycle into `useTrackSelection`, consumed by both presentations, without adding a second model. Album cards remain album navigation/consolidation controls; there is no new album-level action. The two compact lists are the only additional normal interactive track-list render paths found. File-info dialogs, library settings, playlist cards and the player are controls/details rather than selectable track lists.

Compact lists expose listbox/option selection semantics and retain focusable playback controls and the queue's direct remove control. Single clicks on row/title now select rather than implicitly starting playback, so modifier selection never starts audio. Play buttons, double-click, Enter and keyboard button activation remain available. The final cleanup removes the redundant Options dialog rather than leaving an unreachable second action interface; no replacement popup was introduced. Detail-menu invocations do not infer a playlist from whichever main view is open.

## Final compact ellipsis cleanup

The album/details renderer no longer creates an Options button or reserves its width/gap. The only caller of the old track Options modal was that button, so the modal, `trackActions`, its selection/playlist state, its modal variant and `.track-menu` styles are removed. Track Info state remains for native single-track inspection. Native Play/Play Next/queue, playlist/new playlist, favourites, Locate, consolidation, Info/Finder and safe library deletion retain their established scope and handlers; playlist membership removal remains available from its actual playlist context.

Show Queue already used a direct `Remove [title] from queue` × button in place of the ellipsis. It remains unchanged functionally. Compact hover/size CSS is now explicitly scoped to this queue-remove control rather than generic icon buttons. Album rows end with duration, letting the flexible title reclaim the removed button's width and gap.

Regression tests inspect hovered album rows for exactly Play/title/duration, assert duration ends at row padding with no reserved trailing strip, assert no Options control on either compact surface, and retain queue-remove behavior. Obsolete Options-dialog/picker tests were replaced by native menu playlist-add and duplicate-prevention checks. Multi-selection, scoped contextual actions, playback, paging and scrolling coverage remains.

Final cleanup validation passed: renderer/main typechecking, all 114 unit tests, all 10 source desktop suites, all 9 freshly rebuilt packaged suites, five packaged codec indexing/decoding/seek checks, formatting and diff checks. The Intel DMG/ZIP were rebuilt with `--publish never`; all 15 compiled files match ASAR, ZIP matches the tested app, DMG/ZIP checksums/integrity and plist checks pass, and the binary is x86_64. The latest album/details screenshot was inspected. Source bytes/hashes and mtimes remained unchanged, no installed app was replaced, and the complete current worktree remains unstaged/uncommitted/unpushed.

## Coverage and validation

- Six pure selection cases exercise the model actually used by Track List: replace/toggle, range growth/contraction, right-click/anchor, sort/filter/removal retention, empty/invalid targets and OS modifier conventions.
- Ten additional domain removal cases cover playlist multi-remove/order/restart; reference, managed and mixed batches; queue/current cleanup; invalid receipt/path within a larger batch; Trash rejection/retry; post-Trash SQLite failure with continuation; and complete preflight rejection after a confirmed location changes. All prior single-track authority tests remain.
- The source/packaged removal suite uses real renderer/preload/main callbacks and real OS Trash restricted to generated temporary managed copies. It checks pointer/keyboard selection, right-click targets, all shared list views/search, double-click audio advancing, counted confirmations and cancellation, unrelated playback continuation, current decoder/media-session cleanup, partial outcomes, restart and Locate/retry. Original bytes/hashes and modification times are checked.
- Track Info/Finder coverage retains their single clicked target inside a multi-selection; keyboard context now follows the focused row.
- `scripts/features.mjs` now browses actual album cards and tests compact normal/Command/Shift selection, toggling, no accidental playback, right-click preserve/replace, keyboard range/context, selected drag payloads, native playlist actions, single Info/Finder targets, real double-click playback, album/queue scope reset, queue ordering and single-entry removal. Its large-library fixture also checks 200→230 compact paging, scrolling and a range spanning the page boundary.
- `scripts/removal.mjs` now performs managed multi-deletion/cancellation from album details and mixed/partial post-Trash failure deletion from the playback queue, using the same confirmation/safety assertions and real sacrificial Trash adapter.
- Existing desktop suites retain column resizing/reordering/visibility/persistence, drag/drop, playlist order, 10,014-track virtualization, playback/seek/EOF/recovery, source startup and managed safety coverage.

Validated on Intel macOS 15.8.1, Node 26.12.0 and Electron 44.9.2:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 114 tests in 9 files passed (35 removal and 6 selection cases) |
| `npm run test:features` | Focused album/details and queue selection run passed; final paging coverage passed in both complete suites |
| `npm run test:removal` | Original expanded focused source run passed; compact correction passed in the complete source and packaged suites |
| `npm run test:desktop` | All 10 source suites passed |
| `npm run dist:mac -- --x64 --publish never` | Intel application, DMG and ZIP built successfully, without publication |
| `npm run test:packaged` | All 9 suites passed against the freshly built application |
| `npm run test:codecs` | MP3, M4A, raw AAC, Ogg Vorbis and Opus indexing, real decoding and seeking passed (synthetic silence; audible output not assessed) |
| Package freshness | All 15 compiled files match ASAR; ZIP's ASAR matches the tested application; no test audio, scripts or databases bundled |
| Package integrity | `hdiutil verify`, `unzip -tq` and `plutil -lint` passed; executable is Mach-O x86_64 |
| `npm run format:check` / `git diff --check` | Passed |

The compact-list correction was included in a fresh run of all 10 source suites, all 9 packaged suites, the 114 unit tests, typechecking, formatting and five packaged codec checks. The Intel packages were rebuilt with `--publish never` and their freshness/integrity verified again. Album/details, selection and partial-outcome screenshots were inspected; the existing blue selection styling and error banner remain readable. Packages are unsigned/unnotarized as established and were not installed over `/Applications/Rhythm.app`. Native Linux behavior still requires the Ubuntu CI rerun; platform-modifier unit coverage passes locally. No production sandbox or workflow changes were made.

During test development, a direct API playlist setup did not refresh the renderer snapshot; setup now uses the existing native Add to Playlist action. An Electron test evaluate callback also bound its argument to Electron's first parameter instead of the supplied second parameter; correcting it restored meaningful confirmation polling and the exact Trash-call delta assertion. These were test-harness failures; no playback, safety or column assertions were weakened.

Final cleanup files: `src/renderer/App.tsx`, `src/renderer/style.css`, `scripts/features.mjs`, and this report.

Compact selection correction-specific files: `src/renderer/use-track-selection.ts`, `src/renderer/TrackList.tsx`, `src/renderer/App.tsx`, `src/renderer/style.css`, `scripts/features.mjs`, `scripts/removal.mjs`, `scripts/smoke.mjs`, `README.md`, and this report. All other earlier mission changes were preserved.

## Files changed

- `src/renderer/TrackList.tsx`, `src/renderer/track-selection.ts`, `src/renderer/use-track-selection.ts`: one selection/anchor/focus model, shared lifecycle hook and platform modifier boundary.
- `src/renderer/App.tsx`, `src/renderer/style.css`: collection removal dispatch, successful-ID cleanup, partial-result reporting, compact list selection/actions and shared selected styling.
- `src/main/main.ts`, `src/main/preload.cts`, `src/shared/types.ts`: native menu target scope, one counted confirmation and structured IPC result.
- `src/domain/library.ts`: selection preflight, batch orchestration around the original guarded deletion worker, transactional playlist multi-remove.
- `tests/track-selection.test.ts`, `tests/removal.test.ts`: selection and batch safety cases.
- `scripts/removal.mjs`, `scripts/track-info.mjs`, `scripts/features.mjs`, `scripts/smoke.mjs`: source/packaged acceptance expansion, compact list regressions, queue listbox selector and focused keyboard-context expectation.
- `README.md`, `PRODUCT.md`, `docs/TRACK-REMOVAL.md`, `docs/MULTI-SELECTION.md`: current selection/removal contract, command scope, safety limits and validation report.

Final diff/status review: all 19 changed files are unstaged, and the index is empty. No commit, push, application installation or real-library operation occurred. Only generated disposable media reached OS Trash; original test hashes/bytes and mtimes remained unchanged. Sacrificial managed copies can remain in macOS Trash; tests never empty it.

Intel acceptance artifacts:

- `release/Rhythm-0.1.0.dmg`
- `release/Rhythm-0.1.0-mac.zip`
- `release/mac/Rhythm.app`

## Manual acceptance

Use a disposable library with sacrificial reference originals and opted-in managed copies. Browse an album and repeat selection acceptance in the right-hand details column; repeat it in Show queue, including a right-click collection action and single queue-entry removal. Confirm plain title clicks select without starting playback and double-click/Play still play. Check Command-click toggling, Shift-click ranges, repeated Shift-arrows and right-click inside/outside a selection. Confirm Track Info and Show in Finder still target only the clicked row. Test multi-remove in a playlist and one confirmation for reference-only, managed-only and mixed deletions (including cancellation). Check counts, macOS Trash selection, retained original files, successful queue cleanup and uninterrupted unrelated playback. Never begin destructive manual acceptance in the real music library.
