# Rhythm — track removal

Baseline: `7b007aa` (main), after Iteration 3 and the Settings/startup work. The original mission added single-track native context actions; the multi-selection foundation described in [MULTI-SELECTION.md](MULTI-SELECTION.md) now extends their scope without changing the Settings menu, schema, managed-copy/recovery policy, metadata, table styling or column preferences. No stage, commit, push, installation or release publication is part of this work.

## Interaction and ownership

- In an actual playlist Track List: **Remove from Playlist**, and **Delete from Library…**.
- In Songs, Albums list mode, Artist/Genre track views, Favourites, global search (including search opened from a playlist), and compact track contexts: **Delete from Library…**. No playlist relationship is inferred from navigation alone.
- Both removal commands act on the selected tracks. Right-click inside a selection preserves it; outside it selects only that row. Track Info and Show in Finder still target the clicked/focused row only.
- Remove from Playlist deletes only the selected memberships using the current database state. Other playlists, favourite, library identity, audio and playback stay unchanged; remaining playlist order is preserved.
- Delete from Library opens a native confirmation in the main process. Cancel is the default and Escape/cancel action. A single-track dialog includes its title and location. A multi-track dialog counts all tracks and explicitly states both managed and referenced consequences for mixed selections. Referenced audio uses **Cancel / Remove from Library** and says it stays at the original location. Managed audio uses **Cancel / Move to Trash** and states that the managed file moves to Trash.

The renderer supplies track identities, never filesystem deletion paths. Main-process IPC retains trusted-frame checking. Existing media-operation serialization covers confirmation and execution, preventing imports, recovery, root changes or library switches from invalidating the operation. The confirmed ownership/location is rechecked before execution. No permanent audio-delete API is implemented.

## Managed authority

A managed database path alone is insufficient. Trash requires all of:

1. Explicit managed ownership and a registered media-root ID/location. Previously configured roots remain valid for their existing tracks if their registered identity is unchanged; selecting a new default does not turn older managed copies into references.
2. The root's recorded device/inode and directory identity, safe relative components, canonical containment and no symlink parents or leaf.
3. A completed import receipt for this track/root/relative path whose file device/inode and SHA-256 digest match the existing file.
4. Agreement with the track's canonical path, followed by a fresh root/parent/leaf identity check before the shell handoff.

Unknown files merely placed inside Media remain referenced. External paths, traversal, absolute relative paths, symlinks, replacements (including external hard links), missing/changed copies and absent/incomplete/mismatched receipts do not gain Trash authority. Failure retains the identity and presents an error. Referenced removal never calls the Trash adapter, including for user-placed references inside Media. External originals remain byte-for-byte unchanged.

## Ordering and failure

1. Classify the entire selection and show one native confirmation; cancellation returns without mutation. Recheck all confirmed locations before the first removal.
2. For each track, revalidate ownership and managed authority; preflight SQLite writability.
3. For managed audio only, await Electron `shell.trashItem` on the validated copy. Referenced audio has no filesystem mutation step.
4. In one synchronous SQLite transaction, delete the track, cascading its locations and all playlist memberships; delete associated import receipts and exact single-file scan roots; normalize persisted queue/current state and position. Favourite and artwork live on the deleted track. Retain folder scan roots and playlist objects/order.
5. Immediately reconcile the renderer's identity, queue, pending playlist targets and selection; clear Track Info/recovery for that track; refresh every derived view from the snapshot. A deleted current track invalidates pending Play, pauses/clears the decoder, clears current ID/position and media-session metadata/handlers. Removing another queued track preserves current playback. Stale saved IDs cannot resurrect a deleted track.

No SQLite transaction spans asynchronous shell work, so a player save cannot accidentally join a transaction later rolled back by Trash. A Trash rejection removes no records or relationships and reports no success. A per-track failure is retained and reported while other selected tracks continue. Untouched playback continues; buffered playback pauses if its current file reached Trash but the identity could not be removed.

SQLite and OS Trash are not atomic together. If Trash succeeds but subsequent database cleanup fails, rollback retains the identity, receipts, favourites, playlist links and player references. Rhythm reports that the file **was moved to Trash**, marks it missing when writes remain possible, pauses buffered playback and refreshes the retained entry. Restore from Trash or use Locate File to copy the original back into Media, then retry after resolving the database problem. That recovery/retry, including restart and real playback, is automated.

A process crash after Trash and before database completion can likewise leave a retained missing entry; there is no automatic deletion completion or durable deletion-intent migration. Existing first-Play checking/rescan and Locate provide recovery. The path-based Electron Trash interface does not provide kernel descriptor-anchored protection against hostile concurrent directory replacement; checks are repeated at the handoff boundary. No permanent deletion fallback is used when Trash is unavailable.

Explicitly rescanning a retained source folder can discover referenced audio previously removed from Rhythm. This mission implements identity removal, not import exclusion rules. Missing/unverifiable managed copies cannot be silently forgotten through this command. Ordinary track removal leaves empty Media subdirectories alone. The subsequent [album-actions mission](ALBUM-ACTIONS.md) reuses this engine and, only for Delete Album, cleans the resulting genuinely empty managed directory chain through album/disc and artist levels using non-recursive removal. Registered roots, including nested/historical roots, stop cleanup and are never removed; referenced/external trees remain untouched. Only a sole, recognized, unlinked regular Finder `.DS_Store` may also reach native Trash during album cleanup, under the same canonical-directory authority checks. Unknown entries, malformed/linked metadata and directories containing anything else remain untouched; Finder-metadata cleanup failures are separate warnings after successful track deletion. Metadata editing and reorganization remain out of scope.

## Automated coverage

The original `tests/removal.test.ts` mission added 25 unit cases; the multi-selection mission adds 10 more (see its report). It uses sacrificial temporary audio and a test Trash adapter, checking playlist-only semantics/order, multiple playlists, favourites, queue/current cleanup, stale saves, restart, receipt cleanup/reimport, Trash rejection, database failure after Trash, source bytes/mtimes, identity validation, old registered roots, preserving scan sources shared with another identity, concurrent-operation serialization and independent player saves. Its authority matrix includes external paths, traversal, absolute paths, no/wrong/pending receipt, changed bytes, leaf/parent symlinks, an external hard-link replacement, replaced roots and missing files. Existing 73 unit cases remain intact.

`scripts/removal.mjs` runs in both source and packaged suites. It intercepts the existing native menu model/dialog options and invokes real callbacks through the renderer/preload/main boundary. Pending confirmation and cancellation preserve snapshots, memberships and playback. It checks all shared Track List contexts, global search from a playlist, selection-based deletion and playlist multi-remove, immediate row/selection refresh, unrelated real playback, deleted-current decoder/media-session cleanup, restart, actual Electron OS Trash, injected Trash rejection, a forged external path, post-Trash database failure and Locate/retry. All original fixture hashes and mtimes must remain unchanged.

The Trash wrapper lives only in the test process: it refuses any path outside that test's generated Media folder, can inject a rejection, and otherwise delegates to the real `shell.trashItem`. Production has no test flag or bypass. Linux tests use a temporary `XDG_DATA_HOME` for disposable trash data and the existing Playwright Electron launcher. The Ubuntu workflow explicitly installs `libglib2.0-bin`, providing the `gio trash` backend used by Electron in a headless/default Linux environment ([Electron implementation](https://github.com/electron/electron/blob/main/shell/common/platform_util_linux.cc)). No test opens Marcel's library/media or changes `/Applications/Rhythm.app`. Tests do not empty the macOS Trash; sacrificial copies may remain there.

## Original single-track mission validation

The table below records the original mission. Current multi-selection results are recorded in [MULTI-SELECTION.md](MULTI-SELECTION.md).

Validated locally on 2026-10-25: Intel macOS 15.8.1, Node 26.12.0, Electron 44.9.2.

| Check | Final result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 98 tests in 8 files passed: 25 removal cases plus the existing 73 |
| `npm run test:removal` | Focused source run passed; final version also passed in both complete suites |
| `npm run test:desktop` | All 10 source suites passed, including real `npm start`, smoke, features, interchange, acceptance, managed, recovery, Track Info, playback recovery and removal |
| `npm run test:packaged` | All 9 suites passed against the final fresh Intel application bundle |
| `npm run test:codecs` | Packaged MP3, M4A, raw AAC, Ogg Vorbis and Opus indexing, real decoding and seeking passed |
| `npm run dist:mac -- --x64 --publish never` | App, DMG and ZIP built successfully without publication; unsigned/unnotarized as before |
| Packaged freshness/contents | All 15 compiled files match ASAR; ZIP's ASAR equals the tested app; no test media, fixtures, reference art or databases bundled |
| Package integrity | `hdiutil verify`, `unzip -tq`, `plutil -lint` passed; executable identifies as Mach-O x86_64 |
| Workflow | YAML parsed; explicit `gio` prerequisite and unchanged read-only repository permission verified |
| `npm run format:check`, `git diff --check` | Passed; final diff/status inspected; all 16 changed files remain unstaged |
| Source audio safety | All generated original bytes/SHA-256 and mtimes survived the operations; no real user music or managed collection opened |

One intermediate source rerun timed out at the existing `scripts/features.mjs:526` benchmark header-reorder wait. Its capture showed the header unchanged. The unchanged focused feature rerun, final full source run, and final full packaged run all passed that drag and 10,014-track virtualization check. No existing assertion was weakened, retried inside the test or skipped; no persistent product cause for that one timeout was established. Keep native header drag in manual acceptance and monitor CI.

Artifacts (ignored `release/` output): `release/mac/Rhythm.app`, `release/Rhythm-0.1.0.dmg`, `release/Rhythm-0.1.0-mac.zip`. `/Applications/Rhythm.app` was not installed over. No stage, commit, push or release publishing was performed. Native Ubuntu and Apple Silicon execution require CI/target-host verification; this run does not claim Linux runtime acceptance.

## Files changed

- `src/domain/library.ts` — membership removal, complete identity transaction, player normalization and failure recovery.
- `src/domain/managed-copy.ts` — receipt-based Trash authority validation.
- `src/main/main.ts` — native confirmations/context commands and guarded OS Trash adapter.
- `src/main/preload.cts`, `src/shared/types.ts` — narrow identity-based IPC contract and playlist context.
- `src/renderer/App.tsx` — contextual routing, immediate snapshot/state/decoder cleanup and feedback.
- `src/renderer/TrackList.tsx` — prune removed selections and bound the keyboard anchor.
- `tests/removal.test.ts`, `scripts/removal.mjs` — unit and source/packaged integration coverage.
- `package.json` — focused removal command and addition to both complete desktop suites.
- `.github/workflows/build.yml` — explicit Linux `gio` prerequisite.
- `PRODUCT.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/VALIDATION.md`, `docs/TRACK-REMOVAL.md` — current contract, architecture, validation and sacrificial acceptance procedure. The Iteration 3 report remains historical.

## Manual acceptance (sacrificial media only)

1. Use an isolated `RHYTHM_DATA_DIR`, a new library folder, and generated/throwaway audio outside any real collection. Keep originals separate from the dedicated Media folder. Run source with `npm run build` then `npm start`, or test the freshly generated Intel package without automatically replacing the installed app.
2. Put a referenced favourite in two playlists and the queue; play it. In one playlist choose Remove from Playlist. Confirm only that membership disappears, the other playlist/favourite remain, audio continues, and the original remains unchanged.
3. Review Delete from Library in that playlist and in Songs/Favourites/search. Confirm only the playlist view offers Remove from Playlist. Check native dialog copy, Cancel default, Escape, focus restoration and long titles/paths. Cancel and verify no library or file change.
4. Confirm referenced removal. Verify every playlist/favourite/queue/view loses the track; current playback stops and the player clears; original bytes remain in place. Quit/relaunch and verify persistence.
5. Enable managed copying into the sacrificial Media folder. Add a throwaway original, put its managed identity into multiple playlists/favourites/queue, and play it. Cancel managed deletion once, then confirm Move to Trash. Verify the managed copy is recoverable in OS Trash, its external original survives, all relationships disappear, playback stops and restart stays clean. Do not empty Trash as part of this test.
6. Using only throwaway media, restore a removed managed copy from Trash if desired. Do not assume restoring a file recreates a successfully deleted library identity; explicitly add it again. For an operation error that retained an identity, use existing Locate File instead to preserve that identity.
7. Confirm the accepted Settings menu/Command-comma, Track Info, Locate, playback, playlist interchange, column controls and drag/drop still behave normally. Run the Ubuntu workflow to verify real platform Trash behavior and the Linux actual-start test; local macOS success is not native Linux evidence.

The native menu/dialog pixels, keyboard default/Escape/focus, Finder Trash recovery and installed-package interaction remain manual checks. Automated dialogs use captured native options and callbacks. All decoding tests use generated audio; sound quality/output devices are outside this mission.
