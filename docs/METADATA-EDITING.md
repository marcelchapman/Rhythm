> Phase 2E.6 raises the former 64 MiB input/candidate ceiling to 128 MiB with
> aggregate admission control. See [Large FLAC support](LARGE-FLAC.md) for the
> current range, resource costs and qualification. Earlier phase results below
> describe their original qualification bounds.

# Metadata editing: production coordinator and Track Info

Phase 2A adds the domain coordinator in `src/domain/metadata-edit.ts`. Phase 2B
connects real decoder ownership; Phase 2C exposes single-track editing in Track
Info through a narrow production IPC boundary. Batch operations, artwork and
file/path organization remain outside this editor. `editManagedFlac(library, trackId, patch, { usage })` calls the
existing qualified FLAC writer; it does not redesign that writer or allow an
external file to become writable.

## Inline Songs editing (Phase 2D.1)

Songs now offers single-cell editing for its existing simple metadata columns.
It reuses Track Info’s shared validation and the same production eligibility and
Save IPC/coordinator. No writer, publication or playback ownership semantics
change. See [INLINE-METADATA.md](INLINE-METADATA.md) for interactions, scope,
regression coverage and qualification results. Track Info remains the interface
for comments, totals, Album Artist and Composer.

## Opt-in isolated playback editing (Phase 2E.4C)

With `RIO_STABLE_PLAYBACK_SOURCES=1`, verified isolated APFS playback can continue
while either editor publishes to the managed original. Keep Organized must remain
OFF and every existing receipt, format, filesystem and journal check still applies.
Original-file playback continues blocking edits; the disabled/default behavior is
unchanged. Existing clone readers retain their verified revision, while new
acquisitions use the committed original. See
[PLAYBACK-COMPATIBLE-METADATA.md](PLAYBACK-COMPATIBLE-METADATA.md) for coordination,
qualification, limitations and manual acceptance instructions.

## Track Info and production IPC (Phase 2C)

Open Track Info from the normal single-track context menu. Eligible managed FLAC
metadata becomes editable within the existing dialog; technical properties and
file location remain read-only. Referenced files, other formats, Keep Organized
ON, unavailable files, invalid managed receipts, conflicting operations and
active/paused original-file decoder ownership remain read-only with a concise reason. Initial
eligibility is advisory, never a grant of write authority. Main/domain capability
selection runs under the idle lease. Qualified ownership-enabled APFS retains the
strong staged publisher; local writable APFS, including `noowners`, can use the
pragmatic in-place publisher. Linux still requires qualified local ext4. Save
repeats qualification independently; the renderer never chooses a strategy.

Supported fields: title, artist, album, album artist, composer, genre, year,
track number/total, disc number/total, BPM and comments. Save sends only changed
fields. Empty changed fields explicitly clear; untouched empty values and display
fallbacks remain untouched. Text is limited to 4,000 valid UTF-8 characters with
no NUL. Numeric values must be whole numbers: year 1–9999, BPM 1–1000, track/disc
numbers and totals 1–999999. Empty means clear; fractions, exponent notation,
negative values and nonnumeric text are rejected rather than coerced.

`metadata:eligibility` and `metadata:edit` are exposed through the context-isolated
preload as `metadataEligibility` and `editTrackMetadata`. Main verifies the actual
current BrowserWindow webContents, its exact top-level frame and
`rio://app/index.html`. A second renderer at that URL has no editing authority.
Requests contain one SHA-256 track ID, an opaque session from the authoritative
snapshot, and a strictly validated field patch. No renderer filesystem path,
artwork, coordinator hook or generic operation is accepted. A new Library object
gets a new session, including reopening the same directory; stale dialogs cannot
authorize edits in another library. Main resolves the active Library and uses
`playbackUse.usageFor(activeLibrary)` on every Save.

The existing library-operation exclusion covers the entire coordinator call;
Save repeats all receipt, root, path, journal, format, organization and playback
checks. No manual idle declaration or automatic decoder stop is used. Active and
paused original-file decoders block Save, including acquisition after the dialog's
eligibility check. Switching to another track releases the old source through the
existing descriptor-closure boundary. Saved queue/current references alone do
not block an edit. Library transitions and quit retain the Phase 2B lease rules.

Cancel performs no operation. Save disables duplicate submissions, fields and
close/cancel controls while pending. Success closes the dialog and replaces the
renderer snapshot with authoritative Library data, updating Songs, Albums,
Artists, search and other normal projections. Track ID/path and playlist,
favourite, queue/current references remain intact. Known failures explain playback
ownership, organization, invalid/unavailable managed authority, unfinished recovery
or library conflicts. Failure leaves the form open; unknown errors fail closed and
point to the diagnostic log. Main logs underlying exceptions. Save failures also append a private `metadata-edit-errors.log` in Rio’s application
profile, with timestamp, track ID, underlying error/stack and the reference shown
in the dialog. Main chooses that path; renderer input cannot select it. The log
refuses symlinks, non-files and multiply linked targets. On macOS the default
profile is `~/Library/Application Support/Rio`; test profiles remain isolated. Ambiguous journals
still require the existing startup reconciliation or explicit human review; this
phase adds no recovery repair UI or claim that every failed operation rolled back.

`scripts/metadata-ui.mjs` exercises the real Track Info/preload/IPC/coordinator
path with disposable self-contained 30-second FLACs. It covers Save/Cancel,
set/clear/unchanged semantics, numeric errors, duplicate submission, global view
refresh, file/DB/restart persistence, source byte/mtime protection, playback
exclusion/release, stale/malformed requests and a second renderer at the trusted
URL. Its source and packaged modes use the existing `--packaged` and
`RIO_EXECUTABLE` convention. Packaged mode asserts `app.isPackaged`, observes
executed main/preload/renderer/editor/coordinator modules from app resources,
compares served renderer bytes, observes coordinator-created worker URLs/replies,
and verifies the matching packaged native binary against its build manifest.
It never imports production implementation from the checkout in packaged mode.
The harness is part of both desktop suites.

## Initial Phase 2C qualification (before the in-place addition)

Intel macOS x64 qualification passed with Electron 44.9.2 / Node 24.22.0:

| Check                                                          | Result                                                                                                                                                                     |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused metadata editor boundary tests                         | 26 passed, including strict payloads, sender/frame authority, sessions, real coordinator persistence and invalid receipts                                                  |
| Final `npm test`                                               | 466 passed across 22 files, including writer, coordinator, playback-use and decoder lifecycle coverage                                                                     |
| Source UI acceptance                                           | Passed through Track Info, preload, privileged IPC and the existing production coordinator                                                                                 |
| Full `npm run test:desktop`                                    | All 17 harnesses passed, including metadata coordinator, playback ownership, UI editing and updated read-only Track Info expectations                                      |
| Packaged UI acceptance                                         | Passed against the fresh Rio.app; `app.isPackaged === true`, executed app-owned resources, worker preparation/verification and matching native publication binary verified |
| Full `npm run test:packaged`                                   | All 16 harnesses passed                                                                                                                                                    |
| `npm run typecheck`, `npm run build`                           | Passed                                                                                                                                                                     |
| Repository and changed-doc Prettier checks, `git diff --check` | Passed                                                                                                                                                                     |
| `npm run dist:mac -- --x64 --publish never`                    | Passed; fresh unsigned, unnotarized Rio.app, DMG and ZIP                                                                                                                   |

The packaged UI harness observed main, Library, playback-use, coordinator and
metadata-editor execution under `Rio.app/Contents/Resources/app.asar/dist/`,
with the executed preload and served renderer bytes belonging to that same app.
All observed prepare/verify worker replies came from its packaged metadata
worker. TagLib/WASM resolved inside `app.asar/node_modules/taglib-wasm`; the loaded
`app.asar.unpacked/dist/native/publication.node` matched the non-testing darwin/x64
N-API 8 build manifest and SHA-256. The packaged process ran with a disposable
working directory, not the repository. Production coordinator, writer, playback-use,
schema and playback semantics were not changed for the initial Phase 2C UI slice.
The later publication addition is described below.

Fresh manual-test artifacts are `release/mac/Rio.app`, `release/Rio-0.1.0.dmg`
and `release/Rio-0.1.0-mac.zip`. Bundle/app name is Rio, identifier is
`io.github.marcelchapman.rio`, and the executable is x86_64. ZIP Info.plist and
app.asar match Rio.app; DMG checksum verification passed. The app was not installed
or published. Manual DMG acceptance remains for the user. Linux/arm64 and
signed/notarized qualification remain deferred, as do batch/artwork/referenced
editing, automatic decoder quiescing, Keep Organized relocation and ambiguous
journal recovery UX. Existing FLAC structural/tag qualification and the 64 MiB
coordinator limit continue to apply.

## Local APFS in-place publication (Phase 2C finalization)

Earlier manual acceptance exposed the strong publisher's deliberate refusal of
APFS mounted `noowners`: `Require local writable APFS with ownership enabled`.
That remains the policy of the strong publisher. Phase 2C finalization adds a
separate pragmatic in-place capability rather than weakening its private staging,
exchange, durability or cleanup rules. Historical research and its stronger
threat model remain recorded in the APFS study reports.

Main selects the strategy using anchored native filesystem evidence. Local APFS
must be writable, and the target must be a bounded, regular, single-link,
non-symlink, non-immutable, non-dataless file. Native opening checks actual write
access. On ownership-enabled APFS, successful strong qualification selects the
existing staged publisher. On `noowners`, selection uses the in-place path without
creating a private workspace. Ownership-enabled local writable APFS may also use
in-place publication if strong qualification is unavailable and no unfinished
publication artifacts remain. Other filesystems do not gain support. Mounted
network filesystems are refused; this is not qualification of concurrent cloud
provider operations or arbitrary live writers.

The coordinator retains managed receipt/root/path/settings validation, one-track
FLAC scope, Keep Organized OFF, the library-operation exclusion and Phase 2B idle
lease. The existing bounded TagLib/WASM writer prepares and verifies a candidate
in memory, including encoded-audio preservation. Before any physical mutation,
the coordinator journals the candidate digest, audio proof and write intent,
revalidates the receipt and checks playback ownership again. Native code walks
parents without following symlinks, checks the full expected fingerprint and
original bytes, and writes only through its retained writable descriptor. It
checks named/held identity during writes, truncates to the verified candidate's
length, performs normal `fsync`/close and rereads the result. No authoritative
pathname is replaced, no backup is accumulated, and there is no pathname cleanup.

The coordinator independently rereads the authoritative path, verifies the exact
candidate, requested tags and unchanged encoded audio, then commits metadata and
the current receipt. The same track ID/path, playlist/favourite/queue references
and original import provenance survive. Main returns a global authoritative
snapshot, refreshing Songs, Albums, Artists and search. Referenced media stays
read-only. Playback is never automatically stopped; active or paused attached
decoders still block, while a fully released source may be edited despite saved
queue/current references.

This path is intentionally **not crash atomic**. A normal successful write is
verified afterward. A physical rewrite interrupted by process/OS failure can
leave a file needing recovery, consistent with the practical in-place model used
by desktop music editors. Startup accepts only the original bytes or the exact
previously verified candidate on the original inode. It aborts an untouched
operation or verifies and reconciles the complete candidate forward. Partial,
missing or substituted results are not adopted: the file and existing receipt are
preserved, the track is marked unavailable, and a terminal journal error permits
the existing Locate File recovery path. No rollback is promised. Normal errors
remain visible with concise guidance and a diagnostic reference, even if a fully
written candidate can subsequently be reconciled.

The UI harness supports `--noowners` for a disposable APFS image and
`RIO_METADATA_EXTERNAL_PARENT` for an isolated disposable folder on an existing
local APFS volume. Every edit still goes through the actual Track Info Save,
preload and production IPC. Neither mode changes real volume flags or uses real
music. Unsupported-volume coverage now uses HFS+ on macOS and tmpfs on Linux,
including stale advisory eligibility followed by a refused Save and diagnostic.

Intel macOS x64 finalization qualification:

| Check                                              | Result                                                                                                                             |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Focused coordinator and strategy tests             | 48 passed, including real native in-place writes, stale targets, pre-write interruption, partial writes and forward reconciliation |
| Full `npm test`                                    | 473 passed across 23 files                                                                                                         |
| Native strong publication qualification            | Passed production and instrumented boundary/crash cases; strong noowners refusal retained                                          |
| Real source UI on disposable noowners APFS image   | Passed                                                                                                                             |
| Real packaged UI on disposable noowners APFS image | Passed; native ownership capability false and strategy in-place                                                                    |
| Real packaged UI on external APFS noowners         | Passed using only a disposable generated-media folder on the external APFS test volume; real volume flags unchanged                |
| Full source desktop suite                          | All 17 harnesses passed, including coordinator, metadata playback, UI and setup/recovery tests                                     |
| `npm run typecheck`, `npm run build`               | Passed                                                                                                                             |
| Fresh x64 app/DMG/ZIP                              | Built with `--publish never`, unsigned/unnotarized; Rio identity, x86_64 executable, ZIP/app equality and DMG checksum verified    |
| Full `npm run test:packaged`                       | All 16 harnesses passed, including metadata coordinator, playback ownership and real Track Info                                    |
| Formatting and whitespace                          | Repository Prettier, all three changed metadata/publication docs and `git diff --check` passed                                     |

The packaged external-volume run used the actual Track Info Save UI for Title,
Artist, Album, Year, Track number, Comments set/clear and the remaining supported
fields. Reopening the dialog and parsing disk metadata confirmed the writes;
Songs/Albums/Artists/search updated, cancellation left bytes/mtime unchanged,
active/paused playback blocked, switching/releasing permitted editing, and restart
retained ID/path, metadata and playlist/favourite/queue references. A save-time
permission change failed visibly without mutation and its displayed reference
matched the underlying main-process diagnostic. The unchanged external import
sources retained their exact bytes and mtimes. The packaged runtime used its
executed main/preload/renderer, strategy module, coordinator, worker and matching
native addon, with TagLib/WASM inside its own resources. Disposable images were
detached and fixture folders removed.

This automates the requested manual acceptance scenario through the real UI;
interactive acceptance of the DMG by the user remains available. Linux/arm64,
signed/notarized builds, power-loss/hardware durability and arbitrary concurrent
writers are not qualified by these local Intel runs. The 64 MiB bound and existing
FLAC preservation qualification remain; batch/artwork/referenced editing, Keep
Organized relocation and dedicated recovery UX remain deferred.

## Eligibility and exclusion

The target must exist, be a managed native FLAC with a `.flac` path, belong to
the selected valid media root, and match the current file's exact root, relative
path, device/inode and SHA-256 receipt. Keep Rio Media organized must be OFF.
There must be no scan, unfinished managed import, unfinished metadata edit, or
conflicting publication workspace. Existing root/path/symlink/ownership checks
and the selected publisher’s filesystem policy still apply. The pathname cannot
change. Unsupported fields, artwork patches, ambiguous tags, unsupported FLAC
structures and inputs/candidates above 64 MiB fail closed.

A reliable idle-use capability is mandatory. `MetadataUseGate` starts with unknown
state, which rejects editing; an explicitly in-use target also rejects. A host
using this gate must route every playback/decoder acquisition through it. Its
exclusive idle lease blocks acquisition until the coordinator releases it. There
is now a production playback-use adapter in Phase 2B; see
[METADATA-PLAYBACK.md](METADATA-PLAYBACK.md). It tracks real source grants and file
stream closure without automatic active-decoder release. Omitting the capability
rejects the operation. A saved queue/current ID is retained as a reference, not
treated as proof of decoder idleness.

The coordinator holds the existing library-operation gate plus SQLite exclusive
connection locking across durable transactions. Imports, root/settings changes,
removal and relocation cannot race it. An unfinished edit blocks subsequent
filesystem operations and playback resolution of that target. Other playlist,
favourite and saved-state references are preserved.

## Schema and current authority

Schema **4** adds:

- `managed_file_receipts`: one current file proof per track, with root ID,
  relative path, SHA-256, device and inode. Upgrade derives it only from an
  existing completed import proof for the exact managed location; it never
  blesses filesystem bytes found during migration.
- `metadata_edits`: edit ID, track/root/location, phase, serialized versioned
  journal, error and creation time. A partial unique index permits one unfinished
  edit per track. Terminal rows remain an audit trail.
- `tracks.composer`, `trackTotal`, `discTotal`: independently read values for
  fields the writer already supports. Extraction version 3 backfills them on
  ordinary rescan, retaining established display fallbacks and identity.

Import provenance remains in `managed_imports`: editing does not rewrite the
original source digest or published-import identity. Fresh/recovered managed
imports create a current receipt in the same transaction as track ownership.
Re-adding the unchanged original source can reuse its edited managed identity
without resetting the current receipt. Trash and library relocation validate
current receipts. Relocation rebinds copied file identities in that table rather
than disguising edited bytes as the original import. Ordinary rescanning cannot
renew destructive authority for externally replaced bytes.

SQLite uses WAL with `synchronous=FULL`. Track projection, current receipt and
journal commit are one SQLite transaction. Track ID, path, root ID, relative
path, favourite, added date, artwork cache, playlist membership and queue/current
references survive a successful edit.

## Lifecycle and publication

1. **Lock/preflight:** acquire the reliable idle lease and library lock; validate
   ownership, current receipt, settings, path and original bytes.
2. **Journal:** persist `preparing`, recording original identity/digest, current
   receipt, target/root/path and a snapshot of the requested patch.
3. **Stage:** prepare bytes with the qualified writer in a bounded Node worker,
   then use the existing native publication lease to exclusively create private
   `slot` and independent `rollback` copies in a same-filesystem, Rio-owned
   `.rio-publication-*` workspace. Record its identity/layout as `staged`.
4. **Verify:** re-read the actual staged inode and verify its digest, requested
   tags, all preservation rules and identical encoded audio against the original.
5. **Quiesce/revalidate:** validate root, track/path, unchanged current receipt,
   authoritative bytes, idle lease and journal. The native lease also verifies
   root/parent/workspace/leaf identity and candidate/rollback bytes before exchange.
6. **Publish/verify:** exchange at the same pathname through the existing native
   adapter, record `published`, complete its durability barrier, re-read the
   authoritative candidate, and independently verify tags/audio again.
7. **Commit/reconcile:** atomically update metadata/current receipt and mark
   `committed`; re-read SQL and validate the current file proof.
8. **Cleanup:** sync and remove only the exact verified private entries, then
   the empty owned workspace; mark `done`. No recursive media deletion occurs.

These are the strong staged publisher’s restrictions: writable local APFS with
ownership on macOS and qualified ext4 semantics on Linux. Its exchange and
durability guarantees are unchanged. Local APFS in-place publication follows the
separate contract above; other filesystems fail closed.

Preparation and verification run in bounded workers (four concurrent workers,
30-second deadline, 384 MiB old-generation/32 MiB young-generation limits).
Preparation timeout/crash never authorizes a write. An interruption during an
in-place physical rewrite follows the practical recovery contract above.
Encoded audio equality and structural checks follow the existing writer contract;
this is not a new complete PCM decoder or large-file performance qualification.

## Recovery

`Library.open` runs recovery before exposing the instance to playback/import
callers, when the library is still idle. Journal intent alone never proves that
publication happened: recovery inspects recorded native identities and hashes.
The following workspace table describes the strong staged path; in-place
reconciliation is described above.

| Evidence                                                                  | Resolution                                                                                                          |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Journal before staging, unchanged original, no unknown workspace          | Mark `aborted`; original remains authoritative                                                                      |
| Recorded staged layout, original still authoritative                      | Safely clean verified candidate/rollback and mark `aborted`                                                         |
| Exact candidate authoritative, original slot and rollback valid           | Re-verify FLAC/audio, finish atomic DB/current receipt commit, reconcile and clean; never blindly exchange back     |
| DB committed, exact file/current receipt/metadata agree                   | Complete cleanup and mark `done`                                                                                    |
| Cleanup finished but final journal update interrupted                     | Confirm absent workspace, unchanged parent and exact committed candidate/SQL/receipt; mark `done`                   |
| Missing, substituted, modified, malformed or otherwise ambiguous evidence | Preserve recoverable artifacts, record `recovery-required`, block conflicting operations; do not guess or roll back |

A new **cleanup-only recovery capability** in the native adapter resumes an exact
recorded before/after layout. It cannot exchange again. JS verifies all recorded
hashes, native code verifies anchored identities/privacy and exact contents, and
cleanup still refuses unknown entries. Ordinary interrupted-publication inspection
remains read-only. Partial cleanup failures retain recovery-required state.

There is a deliberately conservative crash window inside native preparation,
before its full workspace record can be persisted. A preparing journal plus an
unrecorded workspace cannot establish ownership for cleanup: the unchanged
original remains usable on disk, artifacts are preserved, and the edit requires
recovery. No name-only adoption/deletion is attempted. There is no recovery UI in
this slice. External tampering/unknown layouts likewise require later explicit
recovery tooling or human inspection of disposable copies.

Publication/metadata staging paths are excluded from recursive and explicitly
requested imports, including canonical aliases. Pending edit targets cannot be
resolved for playback or removed through the normal destructive path.

## Validation and next boundary

`tests/metadata-edit.test.ts` covers all requested field/identity/audio/reference
cases, no-op, provenance/current authority, eligibility and in-use rejection,
staging/verification/publication/commit failures, each main interruption barrier,
cleanup-finalization interruption, ambiguous/malformed journals, migration,
rescan/import exclusion, deletion and relocation after editing. Every fixture is
disposable and checks external source bytes/mtime. Native publication tests add
cleanup-only recovery qualification for both layouts and rejection of changed
bytes/identity, unknown entries and the wrong disposition.

`scripts/metadata-edit.mjs` exercises the compiled coordinator, WASM worker,
native publication, same-path edit and published-before-commit startup recovery
inside source Electron and the packaged Intel macOS Rio application. It is part
of `test:desktop` and `test:packaged`; coordinator test hooks are never exposed through IPC.
Internal barriers are domain test options only.

Local validation results and the changed-file manifest follow below. Intel macOS
packaged qualification passed using a fresh unsigned, unnotarized x64 DMG and
ZIP build; see [METADATA-EDITING-PACKAGED.md](METADATA-EDITING-PACKAGED.md) for
resource evidence and results. Phase 2B adds the production playback-use adapter;
see [METADATA-PLAYBACK.md](METADATA-PLAYBACK.md). Phase 2C supplies the single-track UI/IPC integration described above. Deferred
work includes explicit recovery UX for ambiguous states, and
Linux/arm64 and signed/notarized distribution qualification. Batch, artwork,
referenced-file writing and Keep Organized relocation remain outside this API.

Abort cleanup can also finish just before a journal-finalization interruption.
Startup confirms the absent workspace, unchanged parent and exact original file
and current receipt before resolving that journal to `aborted`. A changed receipt
never authorizes this shortcut.

## Phase 2A qualification results

Intel macOS source and packaged validation:

| Check                                                                           | Result                                                                                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Final `npm test`                                                                | **419 passed**, 20 files; includes **41 coordinator cases**, existing FLAC writer, managed-media, native publication and relocation suites                                  |
| Focused coordinator/writer/managed/publication run                              | **187 passed** before the final two abort-recovery cases; both additions passed in the final full suite                                                                     |
| `npm run test:desktop`                                                          | **Passed all 15 scripts**, including the new coordinator runtime check, startup/setup, acceptance, managed media, relocation, recovery, playback, removal and album cleanup |
| Final `node scripts/metadata-edit.mjs`                                          | **Passed** after the final recovery adjustment: compiled worker/WASM/native publication and startup reconciliation under Electron 44.9.2 / Node 24.22.0                     |
| `node scripts/metadata-edit.mjs --packaged`                                     | **Passed**; packaged coordinator, worker, TagLib/WASM and matching native addon; forward startup recovery with no pending journal                                           |
| `npm run test:packaged`                                                         | **Passed all 14 scripts**, including metadata editing                                                                                                                       |
| `npm run dist:mac -- --x64 --publish never`                                     | **Passed**; unsigned, unnotarized Intel macOS DMG, ZIP and Rio.app                                                                                                          |
| `npm run typecheck`                                                             | **Passed**                                                                                                                                                                  |
| `npm run build`                                                                 | **Passed**, including strict native compilation and renderer build                                                                                                          |
| `npm run format:check`, explicit changed-doc Prettier check, `git diff --check` | **Passed**                                                                                                                                                                  |

An earlier full unit run encountered a cross-volume relocation “file changed
while reading” failure. Its standalone rerun and subsequent full runs passed;
no relaxation or unrelated relocation fix was made. Intel macOS packaged
coordinator execution and the full packaged desktop suite passed. Linux/arm64
and signed/notarized distribution qualification remain deferred. The packaged
application was not installed or published.

## Phase 2A changed-file record

- `docs/ARCHITECTURE.md`
- `docs/FLAC-METADATA-WRITER.md`
- `docs/METADATA-EDITING.md`
- `native/publication.cc`
- `package.json`
- `scripts/albums.mjs`
- `scripts/metadata-edit.mjs`
- `scripts/relocation.mjs`
- `src/domain/library-relocation-validation.ts`
- `src/domain/library-relocation.ts`
- `src/domain/library.ts`
- `src/domain/managed-copy.ts`
- `src/domain/metadata-edit-schema.ts`
- `src/domain/metadata-edit-worker.ts`
- `src/domain/metadata-edit.ts`
- `src/domain/metadata-writer.ts`
- `src/domain/publication.ts`
- `src/domain/track-metadata.ts`
- `src/shared/types.ts`
- `tests/iteration.test.ts`
- `tests/library-relocation.test.ts`
- `tests/managed-album-cleanup.test.ts`
- `tests/managed.test.ts`
- `tests/metadata-edit.test.ts`
- `tests/publication.test.ts`
- `tests/removal.test.ts`
- `tests/summary-metadata.test.ts`
