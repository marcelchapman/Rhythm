# Move Library

Library Settings → **Move Library…** is separate from changing the media folder.
Choose the **exact empty destination directory**. If the selected directory is
`/target/Rhythm 4`, its direct contents become `rio.sqlite`, `Rio Media/` and the
copied library-owned state. Rio never appends the old library name. A missing
exact destination can also be created by the service. Existing nonempty directories
are refused, including another library. Confirmation shows the exact source and
destination. Picker/confirmation cancellation leaves locations and files unchanged;
playback is restored on cancellation/failure.

## Movable environment and ownership

The selected library directory is the relocation envelope. Rio copies its regular
files and directories, including `rio.sqlite`, internal registered media roots,
and ancillary playlist/state files placed in that envelope. Current Rio playlists,
favourites, queue, listening state and media settings live in SQLite. Application
view preferences stay in the profile; only its library pointer changes.

Exceptions and boundaries:

- Parent-directory siblings and external referenced music are not visited/moved.
- External custom media roots (including historical registered roots) retain their
  paths and device/inode identities; this is not a media-root migration feature.
- Indexed referenced audio inside the library directory but outside all registered
  internal media roots is excluded from the copy and retains its original path.
- Other regular ancillary files are copied byte-for-byte. Arbitrary exported M3U
  files/third-party sidecars are not parsed or rewritten; their absolute links
  may require manual adjustment. Rio's database playlist memberships remain intact.
- Ownership is not inferred from copied files. Unknown files remain unknown;
  referenced files inside a moved media root stay referenced. Only previously
  validated managed-copy receipts are rebound to new leaf device/inode identities.
- Symlinks (including symlink ancestors), multiply linked files, special files,
  pending managed imports, invalid managed receipts and unfinished publication
  workspaces refuse the move rather than expanding filesystem authority.

## Coordinator and commit

`src/domain/library-relocation.ts` implements the operation. Both same-volume and
cross-volume moves use bounded-memory copy + SHA-256 verification, never a
cross-volume rename. The main process serializes the operation against all mutating
IPC/imports/switching, holds an exclusive SQLite relocation lock and a stable read snapshot, temporarily blocks media
requests and defers normal Quit until the operation completes. The renderer saves
current state, releases playback and suppresses background state saves.

1. Validate source identities/receipts and destination separation. Reserve the
   exact destination contents with an exclusive scoped relocation marker. A user-
   selected empty directory is retained on failure; only Rio-created contents are
   cleaned up.
2. Checkpoint SQLite, inventory the source, copy regular payload with no-follow,
   exclusive file creation, and verify hashes plus unchanged source inventory.
3. Rebind internal track/root/import-source paths in the copied database, preserving
   IDs and metadata. Rebind receipts only after checking the original receipt's
   identity and digest. Check database integrity/foreign keys and validate new
   managed roots/receipts. Close/checkpoint and reopen the destination.
4. Sync copied files/directories. Recheck destination inventory. Write/fsync a unique
   profile pointer temporary, atomically replace `library.json`, then sync its
   directory. This pointer publication is the authority/commit boundary.
5. Retire the old library **in place**, using `.rio-library-retired.json`. Rio refuses
   ordinary opening of that retired copy. No original payload is recursively
   deleted or moved. This protects loose referenced files that must retain their
   paths and provides a complete recovery copy. Remove the ready marker at the
   active destination after successful cleanup.

## Failure, crash and recovery

Before pointer publication, the original remains authoritative. A copy/verification
failure never selects the destination. Cleanup unlinks only newly created entries
with matching identities and removes only empty owned directories. Unexpected
content/replaced entries are retained, along with the incomplete marker; no broad
recursive deletion is used. Error messages include source/destination paths.

An abrupt exit before commit can leave a marked incomplete destination; reopen the
original and remove that incomplete copy only after inspection. Rio never adopts
it through ordinary folder selection. After commit, the profile's token permits
reopening the validated destination even if marker cleanup was interrupted. Startup
completes only that destination-marker cleanup; it never deletes original data.
A post-commit cleanup failure returns success with a warning and retains the source.

**Recovery copies use disk space until deliberately removed outside Rio.** Do not
remove an old folder containing referenced source music still used by the moved
library. To recover the old database deliberately, first close Rio and remove its
retirement marker; its original internal paths still point to the retained files.
This mission does not add automatic backup deletion or automatic replay of copying.

## Destination and status correction — 2026-10-30

The original implementation treated the picker result as a parent and appended
its old directory name. That behavior is removed from both UI and coordinator.

The reported recovery wording came from using `validateManagedTrash` as source
relocation preflight. Its strict recorded/canonical spelling equality can reject a
same-inode case-only spelling alias on a case-insensitive filesystem. This was
reproduced using disposable `Rhythm 3`/`Rhythm 4` folders, yielding the exact error
and an empty selected directory before any copy began. The real user library was
not accessed; its particular mismatch was not inspected.

Source preflight now uses relocation-specific, read-only verification. It accepts
canonical spelling aliases only after checking every path component for symlinks,
root/leaf recorded identities, root containment and content digest. The copied
DB receives canonical internal paths and receipt-relative paths. Destination
verification still uses the unchanged strict managed Trash validator; metadata
writing, recovery and destructive-action rules are not relaxed.

Relocation outcomes are explicit and separate from media-folder errors:

- **MOVE FAILED** before commit: original remains unchanged/authoritative, no
  library location switched. The message states whether incomplete owned artifacts
  remain. It does not imply success or request an unrelated media recovery source.
- **Library moved to [exact destination]**: emitted only after destination
  verification/reopen, durable pointer publication and successful final cleanup.
- **RELOCATION RECOVERY REQUIRED** after pointer publication: validated destination
  is active in the current session; final durability/cleanup was interrupted.
  Keep both copies and restart Rio before another move. This is not Locate File.

## Validation

- Focused relocation cases cover same-volume copying, real cross-volume
  copying where a second writable filesystem is available, staged failure barriers,
  copy corruption, conflicts/nesting, cleanup ownership, internal/external roots,
  receipt validity, state/identity persistence, restart, interrupted commit, concurrent-writer refusal and
  internal referenced sources that must stay in place.
- `scripts/relocation.mjs` covers the Settings/native-picker flow, both cancellation
  paths, destination conflict, successful move, unchanged external original and
  restart without a recovery prompt. It is included in `test:desktop` and available
  through `npm run test:relocation`.
- Correction validation: 20 focused cases passed, including the reproduced
  case-only alias, exact selected root, preflight/copy failures and distinct
  committed recovery status. All 372 unit tests / 19 files, typecheck, formatting,
  whitespace and all 14 source desktop suites passed. Desktop assertions cover
  empty-destination preflight failure without recovery/success wording, a valid
  direct move, native cancellation, commit-gated success and exact-path restart.
- The real user library was not read or changed. Fixtures alone were used.
- The interchange pointer harness now waits for the table's existing dragging and
  drop-before feedback during real mouse input. This resolved an intermittent
  drag timing failure exposed by the full run without changing table behavior.

Local qualification is macOS x64. Ubuntu and native arm64 require hosted CI.
Future Windows support must qualify directory fsync/open behavior and file-sharing
semantics: unsupported durability operations fail safely before publication.
Actual process/power interruption and removable/network-volume durability need
manual platform review; unit barriers exercise interruption boundaries without
claiming hardware power-loss qualification. Free space must accommodate the copy
and retained original. No installation, packaging or metadata editing is included.
