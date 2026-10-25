# Iteration 3 — Managed Rhythm Media foundation

Baseline: `0aedfdd` (main), following `399a9f4`. The user confirmed the baseline passed macOS and Ubuntu GitHub Actions. This mission preserves Electron/React/TypeScript/SQLite and develops macOS Phase 1 only. Ubuntu remains the existing portability canary. No commit, push, release publication, tag writing, existing-file reorganization, audio deletion or Trash command is part of this work.

## Ownership and identity

Referenced tracks index their original location without claiming ownership. Managed tracks index a verified independent copy. Ownership is explicit database state, never inferred from folder membership. Rhythm's authority to manage filesystem content ends at the configured Rhythm Media environment. External originals are user-owned: selecting one in Locate File or consolidation grants read/copy access only, never permission to move, rename, delete, reorganize, write tags or otherwise mutate it. The existing file-information dialog shows the relationship and resolved path; Library Settings shows referenced/managed counts.

Schema 3 adds:

| Table | Responsibility |
|---|---|
| `media_roots` | Logical UUID root identity |
| `media_root_locations` | Separate device-local absolute path and filesystem device/inode for each root |
| `track_locations` | One referenced/managed relationship per track; managed rows require root ID and relative path |
| `managed_imports` | Local source/hash receipt, private-stage identity, planned relative path, stable track ID and copying/ready/done journal |

The additive 2→3 migration runs in an explicit transaction. Legacy tracks become referenced, with IDs, favourites, added dates, playlists and player state preserved. The earlier migration to schema 2 remains available. DDL-failure tests prove rollback of the new tables/version. Older applications reject schema 3; close the app and back up the whole library folder before upgrading.

New track IDs are random, path-independent 256-bit identifiers. Existing path-hash IDs remain unchanged. `tracks.path` remains the current device-local indexing/playback path; managed root ID plus relative path records the logical relationship separately. Absolute paths, root mappings, device/inode checks, receipts and player state are local data. These tables do not implement synchronization, cross-device content identity or move reconciliation.

## Settings and import policy

Per-library SQLite settings default to no media folder, copying OFF and organization ON. Copying cannot be enabled before selecting a root through the native folder chooser. No default media location is silently selected or created. Filesystem root, the database folder and an ancestor containing that folder are rejected; a dedicated media subfolder inside the database folder is allowed. Selection records the existing canonical directory and its identity; unavailable/replaced roots fail instead of being silently recreated. Explicitly selecting a replaced root acknowledges its current identity. Changing the selected root never relocates earlier managed tracks.

The renderer can request a native root chooser and change only the two typed booleans. Settings/import guards prevent changing policy during an import. Track List layout remains in its separate profile-global preference file.

| Entry point | Behaviour |
|---|---|
| Add Music, audio/file/folder drop | Reference by default; copy eligible external audio only when copying is enabled |
| Rescan | Index/refresh in place; never initiate copying |
| M3U/M3U8 import, playlist drop/document open | Reference unknown local files; never interpret playlist interchange as permission to copy |
| Known managed file added again | Reuse; never recursively copy itself |
| Unknown file already inside the selected root | Reference in place; no automatic adoption as managed |
| Existing referenced original explicitly added with copying enabled | Copy and update its location/ownership while retaining ID, favourite, added date, playlists and queue links |

Managed imports register the media root for rescanning rather than watching their external source folders for future copies. Previously registered reference roots remain. Completed receipts let rescans and playlists referring to the unchanged original reuse its managed track, after checking the source and managed hashes. Exports reference the actual indexed copy, preserving ordered playlist round trips. No source audio or input playlist is rewritten.

## Acceptance correction: missing-file recovery

The manual finding was reproduced against the initial bundle using generated sacrificial audio: after returning the file and rescanning, SQLite reported `missing: false`, but the audio element retained Chromium media error **4**, `paused: true`, time **0**. The renderer's load effect depended only on track ID/library; restoring a path did not change the stable-ID URL. Same-track Play called `play()` on the errored element without `load()`. A database-only rescan therefore could not reset the decoder failure. Media buffering also means renaming an already loaded file is not immediate evidence of a missing-file access; the regression test deliberately requests fresh media before testing recovery.

Playback/access checks now mark missing state from the known local file. The error notice and single-missing-track native context menu expose **Locate File…**. The native picker accepts a supported audio file; domain validation also parses its audio stream. Cancel does not change the location. Invalid files, directories, unsupported extensions and a path already assigned to another track fail without replacing the identity. No broad filesystem searching or metadata guessing runs.

- **Referenced:** relink the existing device-local path, refresh indexed metadata and clear missing state. No copy occurs, even if copy-on-add is ON.
- **Managed:** use the currently selected root and existing organization settings/planner to stage, hash-verify and publish an independent copy, then reconnect the existing ID. Copy-on-add may be OFF: the explicit recovery action authorizes this copy. The selected external source remains in place and unchanged. If the selected file is already restored at its expected managed path in the current root, validate the root/components/file and reindex it in place without a duplicate copy.
- **Failure:** keep the old identity/location recoverable. A published copy whose database update fails stays journaled; retry Locate with its source to reuse it. A completed receipt may be reopened only by explicit managed recovery for the same identity; ordinary Add Music retains the prior conservative changed/missing-copy error policy. Changed or unrelated destinations receive collision suffixes, never overwrites. A receipt belonging to another track is rejected rather than silently merging identities.

Recovery does not delete/reimport the row. IDs, added date, favourites, playlist membership, current/queued IDs and saved listening state survive. The app does not have play counts to migrate. Source paths are device-local; choosing a different root does not relocate other tracks. Previously managed files restored under an older, unselected root are copied into the current configured root through Locate rather than adopted as new ownership outside it.

The decoder now reloads when recovery succeeds, a local path changes or missing state clears. Same-track Play/Resume explicitly reloads an errored element. Existing position is retained across path changes and failed-media state, while recovery does not force autoplay. Tests prove actual decoded timeline advancement after relinking, restore-copy and same-path restoration/rescan. Decoder bookkeeping resets on library load; an integration regression copies a sacrificial library with identical track IDs and verifies that its independent saved position is restored.

## Acceptance correction: consolidation

**Consolidate to Rhythm Media** is available in the existing native track context menu when the selection contains referenced tracks and a media root is configured. Existing right-click selection semantics remain: right-click within a selection targets the group; mixed groups skip managed members. Album cards expose **Consolidate Album to Rhythm Media** through right-click/keyboard context-menu activation, using the same track-ID machinery. A wholly managed selection/album has no actionable consolidation entry. Existing Play/queue/playlist/favourite commands remain.

**File → Consolidate Library…** and the Library Settings button open the existing modal style with referenced/managed counts, the chosen destination, an explicit external-originals-unchanged explanation, partial-failure/retry behaviour and Cancel. A deliberate **Consolidate library** action is required before the UI starts the whole-library copy operation. No root or no remaining referenced tracks disables submission. The copy-on-add toggle is independent of all explicit consolidation commands. Rescan remains reference-only.

`Library.consolidate` takes selected IDs or all library records, partitions referenced/managed ownership, and invokes the common serialized import/indexing pipeline only for referenced sources. Per-track success means verified publication plus a transaction updating the existing row/location/receipt. Referenced files already inside the selected root are independently copied, not adopted. Failures leave that row referenced; earlier successes remain managed. Progress is announced without a per-success dialog. Completion shows consolidated/already-managed/failed counts plus up to 100 detailed issues and next steps.

Idempotency comes from persistent ownership and the journal: the next run excludes successful managed IDs, and a failed database transition reuses its verified publication instead of creating another output. Re-running an all-managed library does no copy work. A missing source can be restored or explicitly located, then consolidation retried. No schema change beyond this iteration's version 3 is needed. Imports, Locate and consolidation share the same staging/hash/collision/publication safeguards; no separate view-specific copy implementation exists.

## Acceptance correction: referenced Locate verification and Track Info

The initially reported direct referenced-Locate duplication could **not** be reproduced in the current source/domain tests or installed build. Read-only comparison showed `/Applications/Rhythm.app` and the retained release bundle contain identical compiled library code. Direct Locate with copy-on-add OFF and ON retained one row and the original ID. A separate experiment reproduced a matching symptom only by rescanning the renamed source before Locate: the path-based scanner indexed a new record, then Locate correctly rejected that already-indexed path. The user explicitly ruled out that sequence, so it is **not** attributed as the cause of the original report. The user subsequently confirmed both the playback-banner and right-click Locate workflows relinked correctly with no duplicate. The historical failure's exact cause remains unconfirmed; no speculative Locate implementation change or automatic identity repair was applied.

Existing referenced recovery passes its `targetId` to the serialized scanner; lookup and upsert use that ID, irrespective of copy-on-add. It updates the original location/metadata and clears missing state without copying or changing identity. New tests now assert **exactly one record**, the same ID/path/referenced ownership, favourite/playlist/queue/current identity, unchanged source bytes and mtime, restart persistence and actual playback. The unit case is parameterized with copying OFF/ON. A separate genuine pre-existing collision test and real-app picker test assert that neither record/state changes and no third record is created.

Collision policy remains rejection: if the selected canonical path is already linked to a different track ID, show “This file is already linked to another track. Choose a different file.” Preserve both identities and all application state. Do not silently merge, delete, overwrite or guess at an earlier duplicate's origin. A separate explicit repair policy would be needed for already-existing conflicting records.

**Track Info…** is now in the existing native track context menu, without a new row button or action column. It uses a separate read-only state of Rhythm's existing Modal. Right-click within a multi-selection preserves the group and opens information for the **clicked row**; bulk commands still target the selected group. Keyboard context activation targets the selected row chosen by the existing keyboard model (first selected item in current presentation order). The optional context-track ID crosses the narrow preload API and is checked to belong to the selected IDs. Album-card aggregate menus do not pretend to offer single-track information; their individual track rows use the normal track menu.

Track Info reads the latest library snapshot and checks known-file availability. Exposed stored fields: Title, Artist, Album, Album Artist, Genre, Year, Track number, Disc number, BPM, Comments, Duration, Format, Codec, Bit rate, Ownership, Availability and File location. Missing stored values display an em dash. Composer, track/disc totals and play count are not stored in the current Track model and are omitted. Text remains selectable, long paths/comments wrap and comments preserve line breaks. There are no editable inputs, Save command, tag-writing IPC or schema changes. Close/Done/Escape use the existing focus-managed dialog behaviour.

`scripts/track-info.mjs` adds exact single-track banner/native Locate and restart/playback verification, genuine collision validation, read-only field/omission checks, clicked-row and keyboard multi-selection, and Track Info in Songs, playlists, Artist/Genre track views, Favourites, search and library list mode. Referenced, missing and managed states plus normal/compact focus and scrolled file information are captured. It is included as the seventh source/packaged integration suite. Existing managed recovery, consolidation, transport and Track List tests remain intact.

## Destination planner

`src/domain/media-plan.ts` is a pure planner, separate from Electron and filesystem copying.

With organization enabled, destinations are `Album Artist/Album/NN Title.ext`. Album Artist falls back to track Artist, then `Unknown Artist`. Compilation tags force `Various Artists`, in both planning and indexed Album Artist. Missing album uses `Unknown Album`; missing title uses the original filename stem, then `Untitled`; missing/invalid track number uses `00`. Multi-disc tags (`total > 1` or disc number > 1) produce `D-NN Title.ext`, using disc 1 if the total is known but the number is absent. Single-disc files have no disc prefix. Positive numeric components are bounded to 999999.

Embedded Album Artist remains authoritative unless an explicit compilation tag triggers Various Artists. A website-like or otherwise dirty value is not guessed away. Correcting/writing tags and reorganizing existing managed files after correction remain future work.

With organization disabled, new copies use the sanitized original filename stem directly in the root. Changing either setting affects future copies only. Existing files never move to match new settings or tags.

Names undergo NFKC normalization. Slashes, backslashes, colon, asterisk, question mark, double quote, angle brackets, pipe, control characters, DEL and Unicode format controls become hyphens. Whitespace collapses; leading dots and trailing dots/spaces are removed. Windows reserved device names receive an underscore prefix. Metadata segments are bounded to 80 UTF-8 bytes; flat original stems to 100. Extensions are validated and lowercased. Relative components and resolved containment are checked before use. Excessive total path length still produces an ordinary filesystem error rather than truncating a user-selected root.

## Collisions and repeated import

Publication is exclusive: an existing unrelated destination is never overwritten or adopted, even if its bytes match. Collisions try ` (2)`, ` (3)` etc. before the extension, bounded to 10,000 candidates. Case-insensitive aliases resolve to a canonical destination, avoiding duplicate track paths on the tested macOS volume.

A completed receipt matches canonical source path plus SHA-256 and root. Re-adding unchanged source bytes reuses the managed ID; source-alias lookup also reuses it after selecting another root, without relocation. A different source path is a separate import even when its bytes match. Changed source bytes can create another copy/record. This is deliberate source-repeat handling, not global content deduplication. A modified or unavailable previous managed copy is reported rather than overwritten with the original.

## Copy, publication and failure semantics

1. Check root identity and each destination directory; refuse symlink parents and path escapes.
2. Hash the read-only source, parse metadata, and check its digest again before copying.
3. Journal the operation and exclusively create a private 0600 `.rhythm-imports/<UUID>.partial` file. Record its device/inode immediately after creation.
4. Stream source bytes through a read-only, no-follow handle into that independent staging file. Check size/timestamps during reading, synchronize the file/directories, and verify source/stage SHA-256 equality.
5. Mark the journal ready and publish with an atomic no-overwrite hard link from the complete staging inode to the final name. **The original is never hard-linked.** Verify canonical containment, inode identity and digest.
6. Parse/index the published copy and commit metadata, ownership, rescan root and completed receipt together in SQLite. Only then remove the receipt-owned private staging link.

The ordinary scanner skips hidden staging files and pending publications, including device/inode aliases on case-insensitive filesystems. Failed copies do not become managed tracks. A database failure after publication leaves the complete copy plus pending journal/stage for explicit retry, rather than deleting an audio destination or claiming success. An existing referenced row survives a failed conversion.

Retry means adding the original again with copying enabled, retrying explicit consolidation for a referenced row, or using Locate for a managed recovery. A verified published file is reused. A copying-phase retry may remove only its receipt-identified private partial and create another exclusive stage. If a ready stage is missing, the receipt can prove/reuse its publication; otherwise the original is copied again with the collision policy intact. Changed staging identities/data are retained and reported, not blindly removed. There is no automatic startup recovery or general orphan-cleanup job.

A crash between stage creation and receipt identity persistence can leave an unowned hidden partial. A crash after database commit and before cleanup can leave an extra private hard link. These are intentionally not auto-deleted. Empty new directories can also remain after failure. Pending imports are counted in Settings, with a retry hint. This is recoverable journaling across two stores, not an atomic SQLite-plus-filesystem transaction.

The media filesystem must support hard links and directory synchronization. The tested local macOS volume supports both. exFAT and some network/removable filesystems may reject publication safely; no overwrite-based fallback is supplied. Disk-full, unplug/power-loss and ACL combinations need broader physical-volume fault testing. The copy helper checks paths/identities repeatedly, but does not claim protection from hostile concurrent parent-directory replacement through kernel descriptor-anchored operations.

## Final recovery/playback lifecycle correction

Manual acceptance established that Track Info and both ownership models already work. This continuation leaves their domain/IPC implementation intact and corrects only Play availability checks, recovery feedback and decoder readiness.

The pre-fix reproduction used a generated WAV and an isolated Electron profile. Moving a paused, buffered file and requesting Play once produced no recovery offer and left `missing=false`: the renderer depended on a later media error rather than checking the recorded file. The recovered track's success DOM commit had `readyState=0` and stale media error code 4. Clicking Play at that commit produced Play → second load → native `AbortError` → eventual canplay. The rejection text was passed directly to the generic error banner. This explains the raw Chromium URL and the impression that another track had to be played before recovery would work; the copy/identity transaction had already succeeded.

Corrections:

- Every explicit Play/resume/track advance checks the existing read-only `checkTrack` endpoint first. A missing file stops playback and immediately offers a Rhythm-owned **Track unavailable** notice with **Locate File…** and **Cancel**, including when the decoder still has buffered audio. There is no watcher, search or repeated media-failure prerequisite.
- `src/renderer/media-source.ts` owns source preparation. The React source effect and transport share one pending load and one readiness promise. Recovery deliberately resets the decoder once, restores its position and waits for `canplay`/completed seeking (`readyState >= HAVE_FUTURE_DATA`) before claiming the active track is ready. Noncurrent relinks use a neutral completion message rather than claiming an unprepared decoder is ready.
- Play requests and decoder loads have separate generations. A superseded load/Play rejection cannot replace a newer track's feedback or start obsolete playback. Expected superseded aborts are debug diagnostics; genuine current failures are logged and translated into actionable Rhythm messages. Unexpected current AbortErrors offer retry; unsupported/damaged media errors are not silently swallowed. Starting another Play clears stale recovery-success feedback.
- Locate still relinks references and safely copies managed recovery sources through the accepted implementation. Track IDs, paths, favourites, playlists, queues, collision rules, journals and original-file safety are unchanged. Track Info and the shared Track List are unchanged by this continuation.

Six decoder unit cases cover shared pending loads, forced reset/supersession, slow readiness, seek completion, real failure/retry, clearing and timeout. `scripts/playback-recovery.mjs` runs in both full suites. It plays and pauses an Ogg reference and a managed WAV, renames each disposable recorded file, clicks real Play once without a rescan/source mutation/switch, verifies the direct recovery UI, and invokes the existing native Locate picker. A MutationObserver records the actual decoder state and clicks Play in the first success DOM commit. It requires real subsequent timeline advancement without another track, verifies same ID/count/state and managed copy contents, and checks restart plus external SHA-256/mtimes. Controlled current and superseded native Play rejections verify owned errors and diagnostic logging. On hosts without FFmpeg only, the same lifecycle assertions use generated WAV; the separate codec suite remains the explicit Ogg/codec gate. Local source and package runs used real Ogg.

The initial broad validation attempt stopped at an existing column-drag preference assertion. The unchanged acceptance test passed on the subsequent complete runs; no table/drag workaround or weaker assertion was introduced.

The integration test observes real decoder state; it does not fake `readyState` or synthesize canplay. Attempts to delay the custom protocol through request interception did not control Electron's media loading, so those harness hooks were removed. Deterministic delayed-load/seek/cancellation coverage belongs to the unit suite; the native integration checks the exact success/Play boundary and real time advancement.

## Automated coverage and validation

All filesystem tests use generated audio in isolated temporary directories/application profiles. The 23 new managed unit cases include parameterized planner examples, missing metadata, Album Artist/compilations/discs, Unicode/path safety, settings and restart, default references, identity-preserving conversion, collisions, repeats, already-managed/root-contained files, playlist aliases/round trips, migration/DDL rollback, interrupted staging, publication followed by database failure, unavailable roots, unsafe symlink parents, unusable staging, changed managed bytes, nested input/root trees, concurrent guards, case aliases and missing-stage recovery. Each generated source is checked for unchanged SHA-256 and modification time after its test.

`scripts/managed.mjs` exercises the real source and packaged app: chooser wiring/cancel/error recovery, initial prerequisites, opt-in copies, metadata destinations, actual managed-track playback with timeline advancement, audio/folder drops, repeat deduplication, flat/new-copy-only organization, playlist reference semantics, restart persistence, compact Settings keyboard focus/Escape and input/source hashes. Native picker selections and menu delivery use isolated test interception; actual OS gesture/picker appearance remains manual. The suite is included in both desktop and packaged commands without changing prior smoke assertions.

Validated on Intel x64 macOS 15.8.1 with Node 26.12.0 and Electron 44.9.2:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | 73 tests passed in 7 files, including 23 managed, 14 recovery/consolidation and 6 decoder-lifecycle cases |
| `npm run format:check`, `git diff --check` | Passed |
| `npm run test:desktop` | All eight source-app suites passed |
| `npm run dist:mac -- --publish never` | Final x64 DMG/ZIP built; unsigned/unnotarized |
| `npm run test:packaged` | All eight suites passed against the final refreshed recovery/playback bundle |
| `npm run test:codecs` | Packaged MP3, M4A, AAC, Ogg and Opus indexing/decoding/seeking passed |
| Virtualization regression | 10,014 tracks, 26 rendered rows |
| Source integrity | Generated originals/input playlists retained their hashes; managed/recovery sources retained mtimes |
| Bundle freshness/exclusions | All 15 compiled files match current `dist`; no project test music, databases, tests/scripts or reference art in ASAR |
| Artifact integrity | `hdiutil verify` and `unzip -tq` passed |
| macOS document associations | M3U/M3U8 Viewer/Alternate preserved in Info.plist |
| Dependency audit | Earlier foundation check: 0 vulnerabilities; dependencies unchanged by this correction |
| Lockfile resolution | Earlier foundation check: `npm ci --dry-run --ignore-scripts --offline` passed; lockfile unchanged |

No test uses the user's music or library. No Linux runtime/build was exercised for this iteration locally; the unchanged macOS/Ubuntu workflow must be rerun with these changes. It already runs the full desktop command, now including managed imports, recovery/consolidation, Track Info and first-Play playback recovery, and packages with publishing disabled. Remote CI has not been triggered here. Apple Silicon is not locally verified.

Final ignored artifacts: `release/mac/Rhythm.app`, `release/Rhythm-0.1.0.dmg`, `release/Rhythm-0.1.0-mac.zip`. Generated silence proves decoding, seeking and time advancement; audible quality/output devices need manual acceptance. Real native picker appearance and Finder delivery are not replaced by intercepted automated callbacks.

## Focused UI/UX reviews

Used the available UI/UX Pro Max skill as a bounded reviewer of the new Library Settings section. Resources consulted: local `ux-guidelines.csv` entries **Input Labels**, **Focus States**, **Focus Not Obscured Enhanced**, **Disabled States**, **Error Recovery**, plus the skill Quick Reference §8 (forms/helper text). The initial broad search returned an unrelated Alt Text entry; it was discarded and the search narrowed to labels/focus. No palette/font/style generator was used to redesign Rhythm.

Viewed initial, enabled, referenced, friendly-error and 1050px keyboard-focus captures. The fresh finish reviewer returned **ship**, with no material fixes: the section uses the existing navy surfaces, cool text, muted helpers, blue native controls, quiet folder buttons, readable labels and rose error state. Copy prerequisites, source preservation, new-copy-only organization and playlist references are clear. Failed settings changes roll back and show an inline alert. Actual native picker/VoiceOver evaluation remains manual. A documenter confirmed this is an ordinary extension of the existing design; `DESIGN.md`, `.impeccable/design.json` and prototype assets were preserved.

The acceptance-correction review uses UI/UX Pro Max `ux-guidelines.csv` **Error Recovery**, **Error Messages**, **Confirmation Dialogs**, **Confirmation Messages**, **Disabled States**, **Loading States/Indicators**, and Quick Reference keyboard focus/escape routes. The destructive-action confirmation rule is applied here because the user explicitly requires confirmation of a potentially large copy, not because consolidation deletes anything. Recovery/consolidation captures cover missing/invalid selection, restored playback, full/1050px confirmation with actual keyboard focus and expanded partial-failure results. Native command labels, enabled states and callbacks are tested through the real menu model; native menu/picker pixels remain manual evidence. The fresh focused finish reviewer returned **ship**, with no material fixes. It additionally applied consistency, system controls, state clarity, primary action, keyboard navigation/escape routes, focus visibility, loading feedback, actionable errors, progressive disclosure, success feedback, live error announcements and long-token wrapping guidance. A fresh documenter verified this ordinary extension requires no durable design-system change; the incumbent system files remain unchanged.

The focused Track Info finish review returned **ship**, with no material fixes. Resources used: UI/UX Pro Max Quick Reference read-only/keyboard/escape/native-control guidance and local `ux-guidelines.csv` **Long Token Wrapping**, **Focus States**, **Focus Not Obscured**; the reviewer also applied contrast, consistency and meaningful naming. Six valid captures cover short/missing metadata, long comments, scrolled file location/Done, 1050px keyboard focus, missing and managed ownership. The reviewer measured approximately 14.18:1 primary-text and 7.95:1 label contrast on the incumbent navy dialog. Native popup pixels remain manual; model labels, callbacks, selected-target membership and cross-view integration are automated. The fresh documenter verified this ordinary extension needs no durable system change; DESIGN.md and .impeccable/design.json remain preserved.

The focused recovery-feedback finish review returned **ship**, with no material fixes. Five current captures cover referenced/managed unavailability, 1050px keyboard focus and immediate recovered playback. The review verified the existing notice palette, compact wrapping, direct Locate/Cancel actions and truthful ready boundary. The fresh documenter checked the incumbent system and found no durable system change; DESIGN.md and `.impeccable/design.json` remain untouched. No new detector/audit or visual-world generation was run.

## Manual acceptance — sacrificial media only

1. Close other Rhythm instances. Create a new temporary acceptance directory with separate `UserData`, `Library`, `Incoming` and `Media` subfolders. Put only disposable/generated music in Incoming; include tagged, untagged, compilation and multidisc samples, two identical-metadata files and a pre-existing destination. Keep a SHA-256 manifest outside Incoming.
2. Launch the rebuilt bundle with `RHYTHM_DATA_DIR` set to that new UserData path. This isolates the application pointer/global preferences; explicitly choose the new Library folder at first launch. Do not select the real library or collection.
3. With default settings, add a disposable track. In file information confirm referenced and its original path. Choose Media in Library Settings; copying must remain opt-in. Cancel/reopen the native picker and test keyboard access to the settings.
4. Enable copying/organization. Add disposable external files/folders through Add Music and drag/drop. Verify originals still exist with unchanged hashes, managed paths/relationships are shown, naming follows Album Artist/Various Artists/disc rules, and audible playback/seek/next works from the copies.
5. Add the same original and its managed copy again: no additional managed output. Add the conflicting metadata sample: a numbered destination appears and the pre-existing file remains unchanged. Add an unknown file already under Media: it stays referenced.
6. Turn organization OFF, add a new sample and verify flat naming; earlier copies must remain in place. Turn copying OFF and add another external sample: it stays referenced. Close/reopen and verify both toggles, folder, playlists and playback restoration.
7. Import/drop a disposable M3U referencing one new external file and one previously copied original. No new copies should appear; membership/order and managed-track reuse should be correct. Exercise existing Track List context actions, column layout, playlists and queue.
8. Right-click one referenced track, a mixed selection and an album to consolidate. Keep copy-on-add OFF to verify these explicit commands are independent. Confirm only referenced members become managed, their IDs/favourites/playlist/queue links survive, and external source hashes/locations stay unchanged. Repeating the operation must add no copies.
9. Play a disposable referenced Ogg track, pause it and rename its source manually within the sacrificial tree. Click Play once, without rescanning, switching tracks, restarting or forcing a media reload. Promptly expect **Track unavailable**, **Locate File…** and **Cancel**. Cancel once, then request Play again and use Locate: reject an invalid file, then select the relocated source. Immediately after the ready-success message click Play, without visiting another track. Confirm audible playback/timeline advancement, reference-only relink, the same ID/state/count and restart persistence. No media-folder copy or raw Chromium error should appear.
10. Play and pause a disposable managed track, manually move its managed copy to a sacrificial external folder and click Play once. Expect the same direct recovery offer immediately, without repeated attempts, a rescan, switch or restart. Use Locate File on the external survivor. While preparing, no ready-success claim should appear; immediately when it does, click Play and confirm sound/time advancement without first playing another track. Verify Rhythm COPY-restores into Media, retains the existing ID/state and leaves the external survivor with its hash/mtime unchanged. Repeat by manually returning the expected file and using Rescan/Locate; playback must recover without a duplicate copy. No raw Chromium URL or automatic search should appear.
11. Leave several disposable referenced tracks, temporarily rename one source, and invoke Consolidate Library. Cancel first and check no work occurred; then confirm. Verify successes stay managed and the one failure stays referenced with a useful report. Restore/Locate its source and retry: only remaining references copy. Repeat again: no duplicates. Check all source hashes and reopen the app.
12. Only in this sacrificial tree, temporarily rename/disconnect Media, attempt an add with copying enabled, and confirm a clear failure without a falsely managed record. Restore the folder and retry the original. Compare all source/pre-existing-destination hashes again. Do not simulate failures by altering real media or using tag/delete tools.

13. For the exact referenced regression, start with one referenced disposable file and record its ID/favourite/playlist/queue state. Enable copy-on-add, move/rename the file in the sacrificial tree, click Play once without a rescan/switch/restart, then invoke Locate from the missing notice. Verify count remains exactly one, the original ID points to the new reference, no managed copy appears, state survives and playback works. Repeat via native right-click Locate, then restart and verify the same one record/playback. Separately add a genuine second track first and select its indexed file for the missing first track: the collision must be rejected without changing either record or creating a third. Do not rescan/import the replacement between move and Locate in this exact test.
14. Right-click a track → Track Info. Verify stored metadata, path, ownership and availability; no fields should be editable. Check an empty BPM/comment/disc value, long multiline comments/path, compact window, keyboard context menu, Tab/Escape/Done. In a multi-selection, right-click the second selected row and confirm its information opens while both remain selected. Repeat in playlist, Artist/Genre, Favourites, search and list views. Confirm the table still has no trailing ellipsis/action strip. Compare source hashes/mtimes again.

Physical removable-volume behaviour, native Finder/LaunchServices delivery, output-device sound, VoiceOver, Apple Silicon and target-OS Actions remain explicit manual/CI acceptance items. Never disable macOS security settings to test this unsigned development build.

## Deferred work and gates before mutation

Deferred: metadata/tag writing; automatic reorganization of existing files after metadata changes; Remove from Library semantics; Move to Trash; CD import; equalizer; synchronization; root relocation/reconciliation; generic content deduplication; automatic orphan cleanup/recovery; cancellation/progress optimization for very large copies. No media deletion capability is exposed. Internal cleanup only unlinks identified private staging links.

Do **not** enable tag writing or deletion on the strength of these copy tests alone. First specify which referenced/managed relationships authorize each command; validate current file identity and hash before mutation; account for external hard links, replacements and moves; use descriptor-anchored filesystem operations against parent/symlink races; design scoped confirmation, backup/undo/Trash recovery and durable operation intents spanning SQLite/filesystem steps. Add fault injection for partial writes, permissions, disk full, unplugging, process termination and power loss on supported real volumes. Tag writes must not accidentally modify the user's external original through shared inode relationships. Destructive commands need their own review and sacrificial acceptance gate.

## Acceptance-correction changed files

This continuation changes 14 files relative to the initial uncommitted foundation: `PRODUCT.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/VALIDATION.md`, `docs/ITERATION-3.md`, `package.json`, `src/domain/library.ts`, `src/domain/managed-copy.ts`, `src/main/main.ts`, `src/main/preload.cts`, `src/renderer/App.tsx`, `src/shared/types.ts`, plus new `tests/recovery.test.ts` and `scripts/recovery.mjs`. The retained foundation and this correction formed a 21-file uncommitted worktree before the Track Info correction. No files were staged.

## Track Info correction changed files

This final continuation changes 14 files relative to the preceding uncommitted correction: `PRODUCT.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/VALIDATION.md`, `docs/ITERATION-3.md`, `package.json`, `src/main/main.ts`, `src/main/preload.cts`, `src/renderer/App.tsx`, `src/renderer/TrackList.tsx`, `src/renderer/style.css`, `src/shared/types.ts`, `tests/recovery.test.ts`, and new `scripts/track-info.mjs`. Domain Locate/copy/journal implementation is unchanged by this continuation. At that checkpoint the Iteration 3 worktree contained 23 changed/new files, including retained earlier work.

## Exact changed-file inventory

- `PRODUCT.md`, `README.md`, `docs/ARCHITECTURE.md`, `docs/VALIDATION.md`, `docs/ITERATION-3.md`: current policy, ownership, architecture, safety/validation and acceptance documentation.
- `src/domain/library.ts`: schema 3, settings, identities, ownership, explicit-add, Locate and shared consolidation orchestration.
- `src/domain/media-plan.ts` (new): pure sanitized destination planning.
- `src/domain/managed-copy.ts` (new): verified staging, publication, journal retry and explicit same-identity recovery.
- `src/domain/playlist-files.ts`: receipt-aware source-to-managed resolution, while retaining reference-only playlist scanning.
- `src/shared/types.ts`: ownership/settings DTOs and narrow API types.
- `src/main/main.ts`, `src/main/preload.cts`: native chooser/settings IPC and explicit-add wiring.
- `src/renderer/App.tsx`, `src/renderer/style.css`: existing Settings extension, ownership/report UI, Locate/consolidation and read-only Track Info.
- `src/renderer/TrackList.tsx`: pass the clicked context-track ID while preserving bulk selection and metadata-only columns.
- `tests/fixtures.ts`, `tests/iteration.test.ts`, `tests/managed.test.ts` (new): optional tags, updated legacy fixture and isolated managed coverage.
- `scripts/managed.mjs` (new), `scripts/recovery.mjs` (new), `scripts/track-info.mjs` (new), `package.json`: managed/recovery/consolidation/Track Info integration and inclusion in both full suites.
- `tests/recovery.test.ts` (new): referenced/managed recovery and consolidation safety/identity/idempotency/failure coverage.
- `src/renderer/media-source.ts` (new), `tests/media-source.test.ts` (new): shared decoder preparation/readiness and generation/cancellation/seek/error tests.
- `scripts/playback-recovery.mjs` (new): actual first-Play missing detection, direct recovery, first-success-commit playback, owned diagnostics, restart and external byte/mtime protection.

No dependencies, lockfile, workflow, Track List metadata columns/preferences, existing smoke script, design-system record, prototype asset or source music changed. Generated captures/builds/packages are ignored artifacts, not tracked content.

## Playback-lifecycle correction changed files

This narrow continuation changes only `src/renderer/App.tsx`, new `src/renderer/media-source.ts`, new `tests/media-source.test.ts`, new `scripts/playback-recovery.mjs`, `package.json`, `docs/ITERATION-3.md` and `docs/VALIDATION.md`. The other Iteration 3 changes predate this mission and are retained. The existing smoke assertions, domain Locate/copy/consolidation implementation, Track Info, Track List, CSS, dependencies, lockfile and workflow remain unchanged by this continuation. Nothing is staged, committed or pushed.
