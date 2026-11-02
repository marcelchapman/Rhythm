# Phase 2C.3: publication without destructive pathname cleanup

## Decision

**No replacement for Rio's current same-path publication contract is qualified.**
APFS mounted `noowners` remains unsupported by the production metadata editor.
No production code, filesystem policy, playback ownership or metadata-writing
semantics changed in this study.

The strongest architecture candidate is **a new, exclusively created media
generation, followed by an atomic reference change in a trusted database, with
no automatic media deletion or rename**. Disposable experiments demonstrate its
basic publication and process-crash recovery behavior in both APFS ownership
modes. This changes the authoritative pathname and is not a drop-in adapter.
It also has unresolved control-store, integration and qualification requirements.
It must not be described as a complete safe production model or silently enabled
under the existing same-path API.

Research is limited to documented macOS filesystem APIs, existing Rio results,
and benign experiments on disposable files. No new cross-UID, privileged-actor,
offensive or adversarial-security tests were performed. Questions requiring
those techniques remain unresolved. The original mission's broader substitution
matrix was superseded by that limit.

## Starting invariant and existing evidence

Phase 2C.2 established this failure in an experimental copy of the adapter:

```text
validate slot and workspace -> namespace changes -> unlinkat(workspace, slot)
```

The deletion consumed a different file's last link and returned `cleaned`, in
both abort and committed layouts. Repeating the validation cannot bind a later
pathname operation to the previously checked object. The required rule is that
Rio must never delete, overwrite or move an unrelated object because a name
changed after validation. The prior evidence is retained in
[APFS-NOOWNERS-ADAPTER.md](APFS-NOOWNERS-ADAPTER.md); it was not rerun here.

The earlier [ownership matrix](APFS-NOOWNERS.md) separately established working
APFS exchange/barrier mechanics in both modes, but no equivalent private staging
namespace on `noowners`. Its existing 35-case ownership-enabled native regression
result is prior evidence, not a new run in this phase.

The completed [Apple Music study](studies/APPLE-MUSIC-PUBLICATION-NOOWNERS.md)
provides a behavioral comparison only. Its observed in-place writes and
interrupted-save damage do not provide Rio's no-partial-authoritative-write
guarantee. No new Music session or real library operation was needed here.

## Documented API findings

The installed Command Line Tools SDK is **26.2**; the runtime tested is Intel
macOS **15.8.1, build 24H32**. Documentation in that SDK can describe capabilities
newer than Rio's deployment target. Header presence alone is not runtime support.

Apple's retired [APFS Tools and APIs guide](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/ToolsandAPIs/ToolsandAPIs.html)
identifies the public copy, clone and safe-save API families. Exact binding and
limitations below come from the installed SDK manuals and the disposable tests,
rather than an inference from the term “safe save.”

| API / primitive                                       | Documented binding and consequence                                                                                                                           | Observation / assessment                                                                                                                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openat` and a retained directory FD                  | The FD anchors the directory object; the component is still resolved within that directory. An open file FD refers to its object after its old name changes. | Retained source FD read original A after its name was moved and occupied by B. Retaining a directory does not freeze its location or children.                                               |
| `unlinkat`                                            | Removes the directory entry named relative to a directory FD. No expected-target FD, inode or digest argument.                                               | Not used by the model publisher or recovery. No new deletion-race experiment was necessary.                                                                                                  |
| Documented `unlinkat` flags                           | No-follow/beneath constrain traversal; `AT_UNIQUE` rejects multiple links; `AT_NODELETEBUSY` rejects open targets. None selects a particular expected inode. | Documentation review only; availability was not qualified. A different single-link, unopened file still does not become the expected object. Closing the expected FD does not solve binding. |
| `renameat` / `renameatx_np(RENAME_SWAP)`              | Atomically operates on the current named entries. Neither accepts an expected source/target inode.                                                           | Swap preserved both objects but swapped B, the current entry, rather than retained A. This can still move an unrelated object's name.                                                        |
| `RENAME_EXCL`                                         | Refuses an occupied destination; cannot be combined with swap. Source is still a pathname.                                                                   | `EEXIST` left the destination intact. Moving to an empty name moved current B, not retained A.                                                                                               |
| `fclonefileat`                                        | Source is an open FD; destination must not exist. It creates a distinct copy-on-write object, not a replacement of an existing target.                       | Cloned A from its retained FD; a pathname clone instead cloned current C. Occupied destination was refused with `EEXIST`.                                                                    |
| `fcopyfile`                                           | Reads/writes the specified FDs. It does not reset either seek position. It is not an atomic replacement of all authoritative file contents.                  | EOF source position copied zero data; explicit rewind copied A. Useful for copying into an exclusively created object, not for overwriting an authoritative file.                            |
| `fileport_makeport` / `fileport_makefd`               | Transfers/duplicates an open-file reference, not namespace authority.                                                                                        | Duplicate retained A's inode/content. No conditional unlink or rename is supplied.                                                                                                           |
| `exchangedata`                                        | The current manual says APFS does not support it; deprecated since macOS 10.13.                                                                              | Returned `ENOTSUP` (45) on both images. No fallback was attempted.                                                                                                                           |
| `fcntl(F_TRANSFEREXTENTS)`                            | Documented transfer concerns preallocated space beyond logical EOF between same-volume regular-file FDs.                                                     | Not documented as atomic replacement of complete file contents; not used or experimentally extended beyond its contract.                                                                     |
| FileManager replacement / legacy File Manager objects | A URL or legacy object reference does not by itself document an expected-inode precondition for the final replacement.                                       | No qualifying primitive established. No claim about every internal implementation; no private implementation was investigated.                                                               |
| `fsync` / `F_FULLFSYNC`                               | Durability requests, not namespace locks or content ownership.                                                                                               | File and directory calls succeeded in both modes. No physical power-loss claim.                                                                                                              |
| Cross-volume rename/clone                             | Cannot provide the desired same-volume atomic publication across filesystems.                                                                                | Both returned `EXDEV` (18), preserving the source.                                                                                                                                           |

Local primary documentation consulted, relative to
`/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/share/man/`:
`man2/open.2`, `unlink.2`, `rename.2`, `clonefile.2`, `fileport_makeport.2`,
`exchangedata.2`, `fcntl.2`, and `man3/copyfile.3`.

**No documented primitive examined here provides an atomic expected-inode
precondition for deleting or replacing the existing target entry.** This is a
bounded research result, not a proof that no possible macOS architecture exists.
Undocumented flags, private entitlements and undocumented inode paths were not
pursued. Any capability depending on them is unresolved within this mission.

## Architecture options A–H

| Option                                               | Result                                            | Reason / consequence                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Abandon artifacts; never clean them destructively | Useful component, insufficient alone              | Removes abort/commit/orphan deletion hazards. Existing same-path exchange still operates on current names and may move an unrelated entry. Storage and discovery need explicit retained-state policy.                                                                                                                                                         |
| B. Object-bound replacement/cleanup                  | No qualifying same-path primitive found           | File FDs bind reads/writes; directory FDs bind parents. The examined namespace operations lack an expected-object operand. Copying directly through the authoritative FD avoids name redirection but introduces partial authoritative writes, so is rejected.                                                                                                 |
| C. Publication independent of cleanup                | Demonstrated in the limited reference model       | Database authority can select a verified new object while all old/orphan objects remain. Same-path exchange plus “skip unlink” still does not satisfy the stronger no-unrelated-rename rule.                                                                                                                                                                  |
| D. Trusted ownership-enabled staging                 | Insufficient for same-path publication            | Private preparation does not bind the final external target. Cross-volume rename/clone failed with `EXDEV`; direct copy over the authoritative file is rejected. Can feed G by copying to a fresh external object instead.                                                                                                                                    |
| E. Rio-controlled external directory/container       | Not established                                   | Prior ownership results already defeat treating 0700/ACLs as equivalent private authority on `noowners`. Retained directory FDs prevent redirection to a replacement parent, but do not freeze directory placement. A disk image/container backed by mutable external storage is not proven to solve the authority problem. No repartitioning recommendation. |
| F. Unique tokens, exclusive names, monotonic journal | Useful component, insufficient alone              | An unpredictable never-reused name plus exclusive creation prevents collision overwrite. It does not authorize a later unlink or rename of that name. Unknown artifacts cannot be adopted or deleted merely because their names match a pattern.                                                                                                              |
| G. New authoritative media generation + DB reference | Promising major architecture; research model only | Creates/writes a new object through its original FD, verifies it, then commits a logical track reference in trusted storage. Removes destructive media namespace operations entirely. Changes pathname and requires new receipt, recovery, retention and integration design.                                                                                  |
| H. Rio database/sidecar metadata                     | Separate product fallback                         | Embedded media tags remain untouched. A private DB could hold library-specific overrides, but other players/exporters would not see them. Mutable external sidecar replacement has the same binding issue; private DB or versioned sidecars plus a trusted reference would still be needed. Not implemented or represented as file-tag editing.               |

## Disposable model and authority protocol

The evidence runner is [apfs-design.mjs](../scripts/research/apfs-design.mjs).
Its native [binding experiment](../native/qualification/apfs-binding.c) and
[descriptor helpers](../native/qualification/apfs-object-model.cc) are compiled
into a disposable temporary directory, never Rio's native output or package.

The [model publisher/recovery](../scripts/research/apfs-versioned-model.mjs)
uses Rio's existing built `metadata-writer` and TagLib/WASM to prepare and verify
a generated managed-style FLAC. It does **not** run Library, the coordinator,
managed receipts, playback ownership, IPC or Track Info. This is deliberately
an architecture experiment, not evidence of production integration.

Each independent case has one source and one edit. Media is on either the
ownership-enabled or `noowners` image. The SQLite control store is on the
ownership-enabled control image, beneath the private study directory. The
model assumes this control namespace is trustworthy; it does not prove a
production control-store capability.

1. Open the media directory and source without following the final symlink.
   Check directory identity, bounded regular source, one link, full recorded
   fingerprint and SHA-256. Read source bytes without writing the source.
2. Prepare and verify the FLAC patch using the existing writer. Durably record an
   intent, random token and never-reused candidate name in the control DB.
3. Create the candidate with `openat(O_CREAT | O_EXCL | O_NOFOLLOW)`. Write only
   through the FD returned by that creation. Never reopen a media name writable.
   Flush the candidate and containing directory; verify tags, preserved audio,
   digest and identity.
4. Revalidate source, candidate and directory; change the logical track's
   reference and journal phase in one SQLite transaction. Use FULL synchronous
   mode/fullfsync and explicit DB/directory flushes. The old and new references
   retain the same logical track ID.
5. Reconcile observed identities/digests. Report success only after that check.
   On mismatch report unresolved, retaining all media evidence. No automatic
   rollback overwrites a newer object.
6. On restart, use the committed DB reference plus observed object evidence.
   Before reference commit, a usable original remains authoritative; after
   commit, a matching new generation is selected. Missing/changed evidence
   refuses recovery. Filename existence and journal intent alone never establish
   authority. Reconciliation records retained artifacts, never `cleaned`.

The native model helper exposes only directory-open, exclusive-create,
read-only-open, flush and close. Its publisher/recovery contains **no media
unlink, rename, exchange, replacement, recursive removal or writable reopen**.
That absence eliminates this model's unrelated-file destructive-cleanup race;
it is not another final-stat-before-unlink variation. Fixture setup/teardown and
the separate ordinary-file-change helper are outside the model publication
protocol and operate only on disposable study trees.

An ordinary edit immediately before reconciliation exposed a misplaced check in
the initial model: restart detected the change, but the running process had
checked too early. The model now checks after that event and reports unresolved.
This does not make validation a lock. Another writer can still modify or remove
a generation after verification or a success response; future consumers must
validate/bind their own reads and fail closed on stale evidence. No media
destructive operation follows these checks.

## Qualification and interpretation

Machine-readable results:
[apfs-design-macos-x64.json](qualification/apfs-design-macos-x64.json).
Two new 256 MiB disposable APFS sparse images provide ownership-on and
`noowners` control/treatment. The runner records actual mount flags and hashes
the production native source/binary before and after. Images are detached and
temporary fixtures removed after the run.

| Cases per ownership mode                  | Expected result                                                                                               | Scope                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Documented-API binding suite              | Retained-FD vs pathname distinction; exclusive collision refusal; APFS/cross-volume limitations above         | One suite on each image                                                                                        |
| 1 normal model edit                       | New generation selected; original bytes unchanged; title/year edited, comments cleared, logical ID unchanged  | Actual FLAC writer/verifier and parsed output                                                                  |
| 6 process crashes before reference commit | Original selected on recovery                                                                                 | After intent, create, partial write, verification, revalidation, and inside the uncommitted SQLite transaction |
| 4 process crashes after reference commit  | Verified new generation selected                                                                              | After commit, before/after reconciliation, retention record                                                    |
| 6 ordinary source changes                 | Fail closed                                                                                                   | Rename, replace, remove/recreate, modify, symlink, additional hard link                                        |
| 8 ordinary candidate changes              | Fail closed during publication; recovery selects original when uncommitted and still valid, otherwise refuses | Same six changes plus replacement after commit and modification before reconciliation                          |
| 2 ordinary directory changes              | Fail closed                                                                                                   | Move directory and create replacement after intent or revalidation; retained FD does not redirect writes       |

**Both API suites and all 54 model cases passed**, including the per-mode
file-preservation and second-attempt refusal assertions. The ordinary changes are performed by
a separate same-user process on its own disposable files. These observations do
not qualify exclusion of other writers or all possible interleavings.

After each ordinary change, the helper records the remaining files' identities,
link counts, link destinations or content hashes. The driver asserts those
objects still exist unchanged after publication and recovery. Each mode also
checks that a second edit attempt is refused without creating another media
artifact, while the first committed reference still recovers.

Missing original evidence refuses recovery while the original is authoritative
or cutover reconciliation is pending. A completed new-generation reference does
not require the superseded original to remain available forever. An altered
uncommitted candidate need not prevent recovery of a still-valid original. If the DB has already
committed but candidate evidence changes, recovery stops rather than guessing or
silently switching the reference back. Thus “fail closed” can mean a blocked
committed reference requiring further resolution, not an automatic rollback.

The production source and addon hashes must remain unchanged for the runner to
write a successful report. Research C/C++ builds use `-Wall -Wextra -Werror`.
JavaScript syntax, research/document formatting and whitespace are checked
separately. No new package, unit/desktop suite or native production qualification
is implied by this matrix; existing Rio results are reused as historical facts.

## Storage, identity and integration costs

Retaining everything means no automatic media reclamation, including failed
candidates. Discoverability must come from trusted journal records with exact
identities, hashes and terminal retained/unresolved states; a random name is not
ownership evidence. An orphan scan may report an unknown file, but cannot adopt,
overwrite or remove it automatically. “Maintenance” must not reintroduce the
same unchecked pathname deletion.

Without an enforced budget, retained storage grows with attempts. The model
allows only one attempt per fresh DB and checks refusal of a second attempt.
It bounds the source and prepared candidate to 64 MiB before candidate creation,
then durably reserves the single intent. This bounds newly written candidate
data to 64 MiB per case, excluding filesystem/control-store overhead. It does
not qualify multi-generation recovery or a usable production retention budget.
A production design must reserve a maximum candidate allocation durably
**before creation**, including metadata growth, count interrupted attempts, and
reject edits when a persistent quota is reached.
It cannot reset a quota simply by forgetting old journals. Cloning may reduce
physical allocation but cannot be the logical storage-bound argument. Free-space
exhaustion, flush errors and physical power loss need separate qualification.

G preserves logical IDs, so playlist membership need not change, but physical
path and inode necessarily change. Receipts, indexing/watchers, crash recovery,
backup/export, external tools, future sync and managed organization must learn
the generation/reference model. Keep Organized cannot silently rename or delete
superseded paths on `noowners`. Existing same-path metadata-edit acceptance
would need an explicit product-contract change.

A trusted DB outside the external filesystem also changes portability and
backup/restore. It must remain library-specific, with durable association and
clear behavior when either volume is unavailable. This experiment is not a
proposal to reuse profile-level state across libraries. Putting the authority DB
back on an unprotected mutable namespace does not inherit this model's assumed
control-store guarantees.

## Unresolved work and recommendation

The new-object model demonstrates no direct authoritative media write, separate
verified candidates, original retention, logical-ID preservation, atomic DB
reference selection under process crash, and refusal of the tested stale
evidence. It does not establish hostile-writer exclusion, tamper-proof journal
storage, perpetual media availability, rollback over external changes, automatic
storage reclamation, or physical power-failure durability.

Still unresolved within the revised mission:

- A complete production proof of the control DB/journal namespace, bootstrap,
  library association, recovery lookup and multi-generation reference lifecycle.
- Every relevant write/read interleaving, I/O/flush/ENOSPC faults, loss of either
  volume, and all supported macOS/APFS versions. API probes on this host are not
  deployment-target or hardware qualification.
- End-to-end Library/receipt/coordinator/playback binding, renderer and packaged
  behavior for changed physical paths. Phase 2B playback checks are untouched,
  but are not exercised by this model.
- Any broader substitution/exclusion questions that cannot be answered using
  documented APIs and benign disposable experiments. No inference of a pass is
  made from those tests being out of scope.

The principles of exclusive new-object creation, descriptor writes, durable
reference commit and non-destructive retention could be evaluated on Linux
native filesystems and Windows NTFS. Each needs its own documented handle/path
semantics, crash/flush evidence and reference-store qualification. No Windows
adapter or expanded Linux filesystem support follows from the APFS result.

**Recommendation:** retain the production `noowners` refusal under the current
same-path integrity contract. If changed paths and permanent retention are
acceptable, choose G for a separate architecture/proof mission before any
implementation; H is a separate library-metadata product choice. External APFS
file-tag editing appears technically plausible through G without destructive
media namespace operations, but it is not yet qualified against Rio's integrity
baseline. No complete safe same-path solution was found in the documented APIs
examined here.
