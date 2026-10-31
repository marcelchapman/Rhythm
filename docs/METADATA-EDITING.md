# Metadata editing: production Phase 2A

This slice adds a domain coordinator in `src/domain/metadata-edit.ts`. There is
no renderer editor, IPC endpoint, batch operation, artwork edit, or file/path
organization. `editManagedFlac(library, trackId, patch, { usage })` calls the
existing qualified FLAC writer; it does not redesign that writer or allow an
external file to become writable.

## Eligibility and exclusion

The target must exist, be a managed native FLAC with a `.flac` path, belong to
the selected valid media root, and match the current file's exact root, relative
path, device/inode and SHA-256 receipt. Keep Rio Media organized must be OFF.
There must be no scan, unfinished managed import, unfinished metadata edit, or
conflicting publication workspace. Existing root/path/symlink/ownership checks
and the native publication filesystem policy still apply. The pathname cannot
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

The existing native filesystem restrictions remain: writable local APFS with
ownership on macOS, qualified ext4 semantics on Linux, and fail-closed behavior
elsewhere. The existing exchange and durability guarantees are unchanged.

Preparation and verification run in bounded workers (four concurrent workers,
30-second deadline, 384 MiB old-generation/32 MiB young-generation limits).
Timeout/crash is a coordinator failure, never permission to write the original.
Encoded audio equality and structural checks follow the existing writer contract;
this is not a new complete PCM decoder or large-file performance qualification.

## Recovery

`Library.open` runs recovery before exposing the instance to playback/import
callers, when the library is still idle. Journal intent alone never proves that
publication happened: recovery inspects recorded native identities and hashes.

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
of `test:desktop` and `test:packaged`; no edit hook is exposed through IPC.
Internal barriers are domain test options only.

Local validation results and the changed-file manifest follow below. Intel macOS
packaged qualification passed using a fresh unsigned, unnotarized x64 DMG and
ZIP build; see [METADATA-EDITING-PACKAGED.md](METADATA-EDITING-PACKAGED.md) for
resource evidence and results. Phase 2B adds the production playback-use adapter;
see [METADATA-PLAYBACK.md](METADATA-PLAYBACK.md). Next steps include a separately
scoped UI/IPC integration, explicit recovery UX for ambiguous states, and
Linux/arm64 and signed/notarized distribution qualification. Batch, artwork,
referenced-file writing and Keep Organized relocation remain outside this API.

Abort cleanup can also finish just before a journal-finalization interruption.
Startup confirms the absent workspace, unchanged parent and exact original file
and current receipt before resolving that journal to `aborted`. A changed receipt
never authorizes this shortcut.

## Local validation results

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

## Files changed

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
