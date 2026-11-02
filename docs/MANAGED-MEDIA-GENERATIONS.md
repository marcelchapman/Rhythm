# Managed media generations: architecture decision study

Status: **design only, 2026-11-01**. No schema migration, production change,
metadata implementation, filesystem experiment or package is part of this study.

## 1. Recommendation and decision boundary

**Keep architecture A for the current release: qualified same-path publication
on supported ownership-enabled storage, with `noowners` editing refused. Do not
make generations a mandatory core storage format yet.**

If Rio proceeds beyond research, the preferred candidate is architecture C with
layout B: stable tracks, explicit media generations, an authoritative object
store, trusted transactional catalog state, and separately qualified reclamation.
Drop a universal same-path requirement for that candidate, explicitly and with a
new product contract. Do not quietly change the accepted editor's behavior.

The candidate has broader value than filesystem compatibility: explicit media
lineage, atomic logical publication, stable identity during physical changes,
and transferable verified objects. However, it currently has three material
adoption blockers:

1. **Bounded repeated editing without unsafe deletion.** Retention alone is safe
   for publication but not a satisfactory unlimited storage policy.
2. **Trusted authority and accounting.** Rio's existing database can be inside
   the external library folder. Calling that database “trusted” does not make
   its namespace, journals, restoration or allocation ledger trustworthy.
3. **Whole-product integration.** Album grouping, readable paths, exports,
   receipts, playback, backup and Move Library currently assume more than stable
   track IDs. Large-file writing also needs separate work.

Thus generations are a **conditional future domain concept**, not an approved
implementation or a newly supported filesystem. Do not choose C merely because
the one-edit research model passed. In particular, a usable solution must either
prove safe reclamation, or explicitly accept a hard edit budget that eventually
blocks further edits on storage where reclamation is unavailable.

## 2. Problem, established evidence and scope

The publication invariant is that Rio must not overwrite, delete or move an
unrelated object because a mutable pathname changed after validation. Rio also
must not introduce a partially written authoritative audio file.

| Established result                                                                                                                        | What it establishes / does not establish                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Current native publication](NATIVE-PUBLICATION.md)                                                                                       | Separately prepared/verified files, exchange, journal reconciliation and private cleanup within its qualified ownership-enabled envelope and documented residual assumptions. Not universal race exclusion or power-loss qualification.                                                |
| [APFS ownership study](APFS-NOOWNERS.md) and [cleanup boundary](APFS-NOOWNERS-ADAPTER.md)                                                 | APFS operations work on `noowners`, but final-check-then-unlink can consume an unrelated replacement. UID/mode checks, digests and directory FDs do not atomically authorize a later entry deletion.                                                                                   |
| [Apple Music](studies/APPLE-MUSIC-PUBLICATION-NOOWNERS.md) and [Pro Audio Converter](studies/PRO-AUDIO-CONVERTER-PUBLICATION-NOOWNERS.md) | Observed supported metadata paths mutate authoritative files in place; one interrupted save in each study damaged audio. Compatibility is not Rio's integrity guarantee. Music's study was MP3/AIFF; the converter study was FLAC.                                                     |
| [Phase 2C.3](APFS-NOOWNERS-ARCHITECTURE.md)                                                                                               | Two API suites and 54 disposable one-edit cases support the new-object/reference approach. The model assumed a separate ownership-enabled control DB and retained media. It did not qualify production catalog authority, multi-generation recovery, general budgeting or reclamation. |

Goals: preserve logical identity and referenced ownership boundaries; separate
verified publication from reclamation; define deterministic authority under
process crash; retain fail-closed behavior; bound Rio-created storage; keep later
organization, relocation and sync possible.

Non-goals: weaker in-place writing, editing referenced originals, artwork/batch
features, a full sync protocol, a new playback policy, transparent cloud-folder
support, permanent undo history, or implementation in this mission.

The source audit found these existing constraints:

- [Library](../src/domain/library.ts) schema 4 stores stable track IDs, a unique
  `tracks.path`, track locations, logical roots, device-local root mappings,
  imports and settings. New track IDs are random path-independent hash strings;
  existing IDs, including old path-derived IDs, are preserved.
- [Current receipts/journal](../src/domain/metadata-edit-schema.ts) separate
  current managed-file evidence from import provenance, but the current receipt
  is keyed by **track**, not generation.
- [Coordinator](../src/domain/metadata-edit.ts) requires managed FLAC, a reliable
  idle lease, Keep Organized OFF and the current root. Reads/candidates are
  bounded to **64 MiB**. This study does not enable 1 GB edits.
- [PlaybackUse](../src/main/playback-use.ts) binds Library/session, track, source
  token, path and format. Its actual-use gate must remain intact.
- [Metadata projection](../src/domain/track-metadata.ts) derives album identity
  and some display fallbacks from directories/filenames. Moving to opaque paths
  without changing that projection would split/regroup albums or display object
  IDs as missing tag fallbacks.
- [Move Library](LIBRARY-RELOCATION.md) copies the exact selected destination
  envelope, verifies/reopens before switching authority, retains the original,
  and leaves external custom roots/referenced sources in place.

## 3. Identity model

```mermaid
flowchart LR
  T[Stable track ID] -->|current generation pointer| G[Generation ID]
  G --> O[Object ID and verified byte digest]
  O --> I[Device-local physical instance and receipt]
  I --> P[Root mapping and relative pathname]
```

| Identity          | Proposed definition                                                                                                                                                                                                                                              |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Library           | A durable random `libraryId`, distinct from SQLite's format/application ID. Never inferred from folder name or profile preferences. A copied/restored writer incarnation must be distinguished from the logical library.                                         |
| Track             | Preserve the exact existing `tracks.id`. Portable identity is `(libraryId, trackId)`; path-derived legacy strings stay opaque IDs. No path recomputation, content-based track merge or re-ID during migration.                                                   |
| Generation        | A random globally unique ID minted once for a track revision, never reused, with an explicit predecessor and operation ID. Suitable for offline creation; timestamp/sequence number alone is not identity or conflict order.                                     |
| Media object      | An independently named object ID bound to exact verified full-file bytes, byte length and digest algorithm/version. Initially one object per generation; no sharing/deduplication across tracks. Object ID is not an ownership capability or a filesystem inode. |
| Physical instance | A local instance ID for a replica/copy of an object, plus validated root/mount/file identity and receipt. Copying/restoring/relocating establishes a new instance/receipt; portable generation/object IDs remain unchanged.                                      |

Use cryptographically random UUIDs for new library/generation/object/instance IDs;
record full-file SHA-256 and the existing FLAC audio-preservation digest separately.
Do not derive generation identity solely from audio: different tags can describe
the same audio. Globally unique names reduce collisions; exclusive creation must
still refuse a collision. Neither random IDs nor hashes prove deletion authority.

“Immutable” means **Rio never writes a published object's bytes again**. It does
not mean `noowners` storage prevents other processes or users from modifying it.
Observed divergence invalidates the local instance; it does not silently create
an accepted generation.

## 4. Physical layouts

Examples are relative to the configured `Rio Media` root, not a new sibling root:

```text
A  Artist/Album/01 Title--<track-id>--<generation-id>.flac
B  Objects/ab/<object-id>.flac
C  Objects/ab/<object-id>.flac          [authoritative]
   Organized/Artist/Album/01 Title.flac [optional presentation copy]
```

| Concern                | A: readable versioned paths                                            | B: object store                                                       | C: hybrid                                                       |
| ---------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------- |
| Debugging / inspection | Names help; many nearly identical files obscure current authority      | Requires catalog/diagnostic manifest to identify current object       | Readable view plus two kinds of media to explain                |
| Backup / portability   | Ordinary files, but rename/growth churn and stale paths                | Stable object names and explicit manifest; catalog essential          | Must distinguish authoritative objects from rebuildable copies  |
| External tools         | Can open files, but “latest” cannot be inferred reliably from names    | Use revealed current file or explicit readable export                 | Convenient copies may become stale or be mistaken for authority |
| Keep Organized         | Artist/Album edits create new directories/paths and leave predecessors | Logical metadata independent of placement                             | Separate publication, refresh, conflict and cleanup lifecycle   |
| Sync                   | Unique objects possible, but metadata-driven directory conflicts       | Best separation of identity, payload and local mapping                | Extra payload unless presentation is explicitly local-only      |
| Cleanup / growth       | Both old files and directories accumulate                              | No publication-time rename; stale objects remain separately accounted | Duplicate bytes and another mutable cleanup namespace           |
| Accidental edits       | Familiar paths encourage direct retagging/reorganization               | Clearly internal storage; still physically writable by external tools | Users may edit the wrong copy; divergence policy needed         |

**Prefer B if C is adopted.** Treat readable export as an explicit snapshot, not
a mandatory live second tree. Do not use symlinks or hard links as presentation:
symlinks complicate authority and portability, and hard links make external edits
affect authoritative bytes and violate existing one-link receipt assumptions.
An actual duplicate presentation tree doubles relevant storage and needs its own
publication/reclamation proof. It is not free cosmetic indirection.

Create a fresh candidate directly at its unique object name through a native
exclusive-create capability. “Unpublished” is catalog state, not a rename from a
temporary slot. Rio's ordinary indexing must exclude the object-store namespace
and resolve only registered current objects, not index every `.flac` found there.
An incomplete or unknown object is never promoted by folder membership.

## 5. Trusted catalog prerequisite

The source catalog uses `rio.sqlite` inside the selected library directory. A
library on external `noowners` storage therefore does **not** automatically meet
the research model's separate trusted-control-store assumption. SQLite atomicity
does not protect an arbitrarily replaceable database, WAL or journal namespace.

The smallest candidate topology to qualify is a library/catalog on suitable
ownership-enabled local storage with its explicitly configured media root on
`noowners`. Catalog access, sidecars, root association and single-writer authority
still require a concrete proof; ownership mode alone is not that proof.

Keeping the entire library folder on `noowners` would need another design: for
example a separately trusted, **per-library** control store plus portable
snapshots/association/recovery. That changes backup and Move Library semantics
and is not approved here. Do not silently move `rio.sqlite` into profile state,
duplicate two writable authorities, inherit another library's settings, or claim
the profile's existing remembered-library pointer supplies this capability.

If catalog authority cannot be established, generation publication is refused.
An untrusted or ambiguous catalog never selects an authoritative file by scanning
for a recent filename. SQLite's transaction/durability assumptions must also be
qualified independently of media-file barriers. See
[SQLite atomic commit](https://www.sqlite.org/atomiccommit.html).

## 6. One-edit lifecycle and authority boundary

The following is a proposed protocol, not the existing coordinator's new behavior.
Use the existing library-operation serialization and Phase 2B track idle lease
through reconciliation. Unknown use, stale session, imports, relocation or
unresolved relevant journals refuse admission.

The operation state machine is:

```text
intent-reserved -> creating -> writing -> verified-ready
  -> [atomic reference transaction] -> committed -> reconciled-retained

pre-commit failure -> aborted-retained, or recovery-required if ambiguous
post-commit mismatch -> recovery-required; committed pointer stays selected
```

Generation publication state is `planned -> allocated -> verified -> committed`,
or `abandoned` if never committed. “Current” and “superseded” are derived from
the current pointer and lineage, not competing publication states. Instance
availability (`valid`, `missing`, `stale`, `unknown`) is separate. Retention state
can advance from `pinned` to `retained`/`eligible`, then to
`reclamation-pending -> reclaimed` only through a qualified collector;
`unresolved-retained` never implies deletion. An operation may finish successfully
with retained storage and no reclaimed object.

1. **Validate/admit.** Resolve the exact current generation and local instance.
   Verify root/path/identity/link/type/size/digest and the managed receipt. Save
   the expected current generation and track revision. Validate the patch.
2. **Reserve and journal intent before creation.** In trusted state, durably
   reserve an attempt, unique object name and maximum candidate bytes, recording
   expected predecessor, source receipt, patch and root binding. A crash must not
   erase the storage charge for an unrecorded artifact. No media write occurs
   before that intent is durable.
3. **Create/write a new object.** Exclusive, no-follow, anchored create; refuse
   occupied names. Retain its created descriptor and record instance evidence.
   Write only through that created writable capability. Never reopen an existing
   media name writable, write the predecessor, or rename/replace a target.
4. **Flush and verify.** Finish candidate writes within the reservation, request
   required file/directory durability, verify the exact FLAC patch, unchanged
   encoded audio and preserved metadata, full digest and instance identity.
   Retire Rio's writable capability; never issue another write to this object.
5. **Journal verified readiness.** Durably store candidate digest, audio proof,
   size, parsed projection, instance receipt and verifier/schema versions.
   Revalidate original, candidate binding, idle lease and library/root scope.
   This is a second durable milestone, not a substitute for the earlier intent.
6. **Commit authority in one catalog transaction.** Compare-and-swap the track's
   expected current-generation ID/revision; update current pointer, metadata and
   search/album projection, current receipt/location cache, predecessor status,
   operation commit state and allocation accounting together. If comparison
   fails, keep the old pointer and retain the candidate as uncommitted evidence.
7. **Reconcile and acknowledge.** Recheck committed reference and physical
   evidence. Only then report success and refresh readers. Mark the journal
   reconciled, retain predecessor/candidate history as appropriate, release
   locks and the idle lease. No media cleanup is needed to report success.
8. **Later retention/reclamation.** Eligibility and deletion are separate jobs;
   failure to reclaim never rolls back a valid current generation.

**The durable catalog transaction in step 6 is the authority switch.** Neither
creating a `.flac`, verification, an intent, a filesystem timestamp nor a journal
word such as “ready” switches authority. If acknowledgement is lost, the operation
ID makes retry return the committed outcome rather than allocate another object.

This is data-before-reference ordering across stores, not filesystem/SQLite
atomicity. A commit error with uncertain durability requires reopening/recovery,
not a second publication or a success response. A committed but subsequently
changed/missing object remains the catalog-selected generation **but unavailable**;
post-commit failure must say so and retain both objects. Never silently reset the
pointer to make an error disappear.

Outside writers can still change bytes or namespace after validation. Readers
must bind/validate their own access; a hash is not a lock. Parent/root motion and
creation through retained descriptors also need precise authority-boundary
qualification. Detecting a changed root cancels publication; this design grants
no authority to write existing files outside the configured media environment.

## 7. Candidate database model

This is a schema sketch; no SQL or migration is being applied. “Portable” fields
describe logical identities; device-local evidence must not be synchronized.

Planned objects can have unknown digest/length evidence until verification;
verified/committed objects require it and never change that byte identity.
Allocation estimates are kept separately from verified actual length.

| Entity                   | Candidate columns / relationships                                                                                                                                                                                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library_identity`       | `libraryId`, schema version, writer incarnation/checkpoint identity; trusted association to this library, not its directory name                                                                                                                                                                      |
| `tracks`                 | Existing `id` and user state; nullable `currentGenerationId`, `mediaRevision`. Managed rows resolve the generation; referenced rows retain reference-only location. Metadata columns remain the current projection, updated in the same transaction as the pointer                                    |
| `media_generations`      | `generationId` PK, `trackId` FK, nullable same-track `predecessorId`, `objectId` FK, `operationId`, `createdAt`, `verifiedAt`, `committedAt`, verification/projection version and metadata snapshot, `publicationState`, `retentionState`, `supersededAt`, `recoveryCheckpointId`                     |
| `media_objects`          | `objectId` PK, immutable-intended full digest + algorithm/version, `byteLength`, `format`, `audioDigest` + algorithm/version, origin/provenance link; no deduplication initially                                                                                                                      |
| `media_object_instances` | Local `instanceId` PK, `objectId` FK, root ID, relative path, local availability, placement version. Unique local root/path while assigned; never use path alone as identity                                                                                                                          |
| `managed_file_receipts`  | Re-key to generation/object instance, with root identity/mount evidence, file fingerprint, digest, byte length, verification time/version and creation/copy/restore provenance. The current receipt is a join through `tracks.currentGenerationId`, not another independently writable pointer        |
| `metadata_edits`         | `operationId` PK, track ID, expected base generation/revision, proposed generation/object/instance IDs, bounded patch, intent/evidence, phase/error, reservation ID, journal version, start/verify/commit/reconcile times. One active edit per track; existing global serialization remains initially |
| `generation_pins`        | Generation/object reference with reason and owner: recovery, export/backup snapshot, migration, future sync conflict/transfer. Reference lifecycle is transactional; playback leases remain runtime capabilities                                                                                      |
| `storage_reservations`   | Root/storage-instance scope, operation/object ID, maximum and actual charged bytes, allocation phase, unresolved/orphan charge, release evidence/checkpoint. Durable before create; crash/restore cannot silently reset it                                                                            |
| Existing roots/imports   | Preserve logical `media_roots`, local mappings, library-specific settings and immutable import/source provenance. Original source identity/digest remain provenance, separate from the current generation receipt                                                                                     |

Each instance also needs a physical root-binding ID: logical root ID plus a
recorded local mapping incarnation, path/mount/root identity and placement epoch.
Extend/version the existing root mappings accordingly. A historical receipt must
not resolve through a newly rebound root merely because its logical root ID is
the same. The edit intent records the source instance and its complete expected
receipt/fingerprint/digest, not just the base generation ID.

`generation_references` need not be a second current-pointer table: the track
pointer plus `generation_pins` suffice initially. Current generation must belong
to the same track, be verified and reference an eligible object; enforce those
relationships transactionally and, where possible, with database constraints.
Timestamps are diagnostic, not causal order. Predecessor links are immutable;
“current” is a pointer, not a timestamp or a competing status flag.

During compatibility transition, `tracks.path` and `track_locations` can be
derived caches/views updated in that same transaction. They must not be competing
authorities. Current receipts cannot stay keyed only by track if old generations
remain recoverable. Terminal generation/operation records must not cascade away
merely because a track is removed: preserve tombstones, charges and necessary
recovery evidence until reclamation/retention resolves them.

## 8. Crash and recovery model

Assume a recoverable, authoritative catalog. Startup reconciles before granting
media/edits. Inspect the transaction's current pointer and recorded evidence;
never run a generic “find newest FLAC” repair.

| Crash point                                                   | Authority / recovery                                                                                                                                                                                      |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before intent or new object creation                          | Old pointer. A durable reservation with no object can be resolved only with sufficient allocation evidence; do not free a charge just because a name is absent                                            |
| During creation/write                                         | Old pointer. Candidate is incomplete/unverified; keep and charge it. Crash between create and receipt capture leaves an unresolved artifact, not deletable ownership inferred from its name               |
| After write, before verification                              | Old pointer. Retain candidate; explicit re-verification may establish readiness but never auto-promotes it                                                                                                |
| After verification, before verified journal milestone         | Old pointer. Use only durable evidence; repeat verification on explicit retry or retain unresolved. No cleanup prerequisite                                                                               |
| After verified journal                                        | Old pointer until transaction commits. Candidate remains ready/non-authoritative                                                                                                                          |
| Immediately before or during reference transaction            | Reopen/recover SQLite first. Rolled-back transaction selects old pointer; committed transaction selects new. No decision from partially observed in-memory state                                          |
| Immediately after durable reference commit                    | New pointer, even if the UI never received success. Revalidate and reconcile forward using the operation ID                                                                                               |
| Before/during reconciliation                                  | New pointer if committed. Missing/stale new instance blocks use and reports recovery required; keep predecessor. An explicit verified rollback is another catalog transaction, not a pathname restoration |
| During retention bookkeeping                                  | Committed pointer unchanged. Recompute eligible pins/status transactionally; no authority depends on a cleanup flag                                                                                       |
| During qualified deferred deletion                            | Pointer unchanged because current/pinned objects are ineligible. Recovery uses backend deletion evidence; ambiguous results remain charged/unresolved rather than retrying a name deletion blindly        |
| Catalog missing, corrupt, restored ambiguously or conflicting | Authority is **unknown**. Stop playback/editing and require catalog recovery. Filename/hash/timestamp order cannot resolve the authority conflict                                                         |

There is always one authoritative pointer in a valid catalog, though its object
may be unavailable. With invalid catalog authority the honest answer is unknown,
not a guessed generation. Process-crash qualification does not establish physical
power-loss durability; media-before-catalog barriers and error paths need tests.

## 9. Filesystem authority and separate reclamation

Rio may write only newly created managed candidate objects through the capability
that created them. Referenced files and published generations receive no writable
capability. Names, extensions, root membership and recognizable prefixes are
not ownership grants.

**No automatic destructive media reclamation is authorized by this design.**
A later backend must separately prove that its operation affects the expected
owned object and cannot consume an unrelated rebound entry. Publication and
reclamation capabilities must be distinct. A user confirmation does not supply
the missing kernel/object binding.

| Evidence / technique                                                                                                      | Useful for                                                            | Sufficient for a later destructive pathname operation?                                        |
| ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Object/generation ID                                                                                                      | Logical references, collision avoidance                               | No                                                                                            |
| Exclusive creation + provenance                                                                                           | Shows the object Rio originally created                               | No; its name may later identify something else                                                |
| Trusted DB ownership record                                                                                               | Eligibility and recorded authority                                    | No; the filesystem binding can change independently                                           |
| Digest / fingerprint                                                                                                      | Observed content and local identity validation                        | No; a later stat-to-unlink gap remains                                                        |
| Retained file FD                                                                                                          | Reads/writes to that object                                           | Not with an API that still deletes a supplied pathname                                        |
| Directory FD                                                                                                              | Anchors parent object, prevents redirection into a replacement parent | Does not bind the named child or freeze directory placement                                   |
| Retention/quarantine directory                                                                                            | Organization of retained evidence                                     | Moving there is itself a namespace operation; no automatic safety upgrade on `noowners`       |
| Qualified expected-object operation, or separately proven non-rebindable namespace within the declared integrity contract | Potential deletion capability                                         | Only after platform-specific qualification; none is established here for noowners reclamation |

Reclamation pipeline, if later qualified:

1. Compute live references: current pointers, active operations, playback/read
   leases, required predecessor pins, migration/relocation and explicit backup or
   sync pins. A count alone is insufficient if a reference type is omitted.
2. Under serialization, mark an unpinned superseded object eligible; deny new
   acquisitions while a backend deletion capability is active. Check instance
   receipt and declared root authority.
3. Invoke only that qualified capability. Unknown backend, changed evidence,
   conflicting links or uncertain operation outcome means retain and diagnose.
4. Record confirmed reclamation and release storage charge durably. Preserve a
   small lineage/tombstone record for audit/idempotency. Do not auto-remove now
   empty directories using another unqualified pathname cleanup.

On `noowners` without such a capability, step 3 is unavailable. Keep
`superseded`, `orphan-retained` or `reclamation-unresolved`, retain the charge and
surface storage diagnostics. The old file is not falsely reported as “cleaned.”
Existing path-based Trash, relocation cleanup or the current private publication
cleanup must not be reused as a generation collector without a separate proof.

## 10. Storage policy: the non-negotiable trade-off

Let `S` be a full generation's size allowance including bounded tag growth.
Fifty successful full-copy edits with no reclamation require approximately
`51 × S`: original plus fifty successors. For a 1 GB track, that is about **51 GB**.
The candidate is not acceptable if it promises ordinary repeated editing while
quietly retaining all of those full objects forever.

| Policy                       | What it actually provides                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Last N / X days              | Selects optional history eligible for reclamation; never proves deletion safety                                                                   |
| Last known-good predecessor  | Recovery pin until durable reconciliation/checkpoint. A replacement candidate must still be verified; old bytes cannot be reused as scratch space |
| Restart checkpoint           | Can release a recovery dependency after validation; cannot authorize filesystem deletion                                                          |
| Hard byte/attempt budget     | Bounds admitted Rio allocations even when reclamation is impossible; further edits must stop                                                      |
| Manual review                | Allows diagnosis, export or deliberate storage maintenance outside Rio. Confirmation/Trash is not an automatic safe collector                     |
| APFS clones / shared extents | Possible physical-space optimization, not the correctness or worst-case storage bound                                                             |

Proposed conservative policy for a future pilot: retain current plus one
known-good predecessor as the normal recovery set, offer **no optional undo
history initially**, and reserve one full candidate allowance before each edit.
Reconciled older generations become eligible, not automatically deleted. Add a
per-track allowance and a root-wide byte/attempt cap, counting interrupted and
orphan allocations and bounded filesystem/control-store overhead. Changing roots,
forgetting journals or reopening Rio must not reset charges. Free-space checks
are additional admission evidence, not a guarantee against ENOSPC.

Correctness-required pins protect the selected object and the base/candidate
evidence needed to settle an unfinished operation, readers, migration/relocation
or explicit snapshot. Once the commit and recovery checkpoint are verified,
keeping an otherwise unreferenced predecessor is an **optional bounded rollback
cushion**, not a requirement to retain all edit history. The proposed one-
predecessor policy keeps that cushion; it does not advertise permanent undo.
Releasing its pin only changes eligibility and never proves safe deletion.

With a working qualified collector, fifty sequential edits could occupy roughly
`2 × S` at rest and `3 × S` while preparing the next object, plus bounded
overhead. **Without one**, a three-object allowance permits approximately two
successors from a one-object starting state; it then refuses the next allocation.
It does **not** provide fifty successful edits for 3 GB. Diagnostics must explain
the retained storage, the blocked edit and available export/recovery options.

Apple documents APFS cloning/COW, but that does not bound the blocks dirtied by a
full-file tag writer, metadata expansion, backups or another filesystem. Do not
budget 50 full-object edits as “only tags” until a byte-range/clone writer and its
worst-case allocation are separately proven. A chunked audio + metadata manifest
could change the space model, but would also change how Rio supplies a normal
FLAC to playback/export and is a different architecture, not a hidden assumption
of this design. See [APFS features](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/APFS_Guide/Features/Features.html)
(retired guide; empirical qualification still required).

Budgets constrain Rio-created allocations under a valid accounting epoch, not
all space used by arbitrary external processes or backup snapshots. Restoring an
older DB must suspend allocation until storage/accounting is reconciled; otherwise
rollback of reservation history defeats the cap. Unknown artifacts may be charged
conservatively without being adopted or granted deletion authority. If a bound
cannot be re-established, stay read-only for edits.

The **1 GB example is architecture sizing, not supported current behavior**.
The current 64 MiB bounded writer/coordinator cannot process it. Streaming,
bounded-memory verification, temporary-space limits and worker time budgets for
larger files are an independent implementation gate.

## 11. Keep Organized and album semantics

With B, Artist/Album edits change verified file tags and the logical catalog
projection. They create a new object name, but do not create an Artist/Album
directory as part of the metadata transaction. Path prettiness must not gate
metadata correctness.

Keep Organized OFF would mean no human-readable organization operation, **not**
same-path editing: a new generation still changes the physical object path.
Keep Organized ON cannot silently keep its current promise of organizing the
authoritative files by metadata if the authoritative layout becomes opaque.
Adoption requires an explicit product decision to replace/retire that toggle for
generation roots or provide a separately qualified readable export/presentation
feature. No such UI/feature change is authorized by this document. The accepted
editor's existing OFF-only restriction remains unchanged now.

A current generation may eventually acquire a new local placement without
changing track/generation/object ID, provided bytes are unchanged and placement
and receipts are safely committed. That is a separate operation; `noowners`
does not thereby gain safe rename/delete. Prefer verified copy to a fresh
instance and reference update, retaining the old instance where necessary.

Album edition identity must become logical before an object-store switch.
Preserve existing album groupings on migration; store explicit edition/grouping
context instead of deriving it from an object shard. Changes to Artist/Album may
regroup the current display projection, but an unrelated generation/path change
must not merge editions. Missing-title/album fallbacks must preserve useful
logical/source display context rather than UUID filenames or `Objects/ab`.

## 12. Existing references, playback and user expectations

| Surface                            | Required behavior / change                                                                                                                                                                                                      |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Playlists, favourites, added dates | Remain keyed by the exact existing track ID; no generation history memberships                                                                                                                                                  |
| Queue/current ID/saved position    | Remain track references. No silent replay or new ownership inferred from those values                                                                                                                                           |
| Search, Albums/Artists             | Atomically project current generation's verified metadata; fix directory-derived album/fallback assumptions above                                                                                                               |
| Receipts                           | Resolve generation + local instance; old provenance remains immutable and cannot authorize another object's deletion                                                                                                            |
| Track context menus / Info         | Resolve the current pointer in main; never trust a stale renderer path. Preserve sender/frame/session validation                                                                                                                |
| Show in Finder                     | Reveal the current verified local object; unavailable/stale instance enters recovery. It does not reveal an arbitrary predecessor or a fake stable alias                                                                        |
| Album reveal                       | An object store has no authoritative album folder. Current folder-based album reveal semantics need explicit redesign, not a misleading directory handoff                                                                       |
| M3U / external path references     | Exported paths are snapshots and can become stale after edits/reclamation. Offer an explicit self-contained readable copy/export if durable external paths are required; do not claim track IDs fix third-party path references |
| Managed deletion                   | Remove logical track with explicit policy for all generations/pins. Retained objects still consume space; do not cascade away GC/accounting evidence or blindly Trash all matching names                                        |
| Library relocation / root change   | See section 14; local paths/receipts change, logical IDs do not. Historical roots remain associated; no global media-root inheritance                                                                                           |

Preserve Phase 2B's **track-level idle gate**. Active, paused, buffered or ended
but attached sources still block edits. All grants/readers for that track must
retire and close before editing. A fully released source with queue/current ID
remaining does not block; an unrelated playing track does not block this target.
Unknown release/session state fails closed. New generations are not permission
to edit a loaded track.

Extend the source capability's binding to Library/session + track + generation +
object/local instance + validated read descriptor/path/format. Check the expected
current generation when granting/ranging, so stale tokens cannot read a different
generation at a reused path. Hold the existing idle lease across the reference
commit/reconciliation; playback cannot acquire during it. Refresh/invalidate
transport state only after the current projection changes. Library switch, move,
error, renderer crash and quit retain the existing revocation/drain rules.

Users may inspect managed files, but external retagging/renaming/moving must not
be silently accepted as owned generation publication. Identity/digest divergence
marks an instance unavailable/stale; offer the existing explicit recovery/copy
boundary. Do not search-and-adopt a similar filename or digest. An intentional
future “import external changes” feature would need a separate contract. Readable
export is the suitable handoff for external tools; filesystem permissions do not
make the internal store unmodifiable.

## 13. Backup, restore and future sync

Ordinary backup must capture a consistent catalog plus every object it selects
and the recovery/pin/accounting state needed for that checkpoint. During capture,
pin those objects. Use a qualified SQLite snapshot/backup or clean quiesced
checkpoint; copying only a live DB file is not an application backup protocol.
[SQLite's Backup API](https://www.sqlite.org/backup.html) provides a consistent
database snapshot; the corresponding media closure still belongs to Rio.

Time Machine may provide useful file history, but Rio must not promise a
transactionally matched catalog/media set across separate volumes without
qualification. Clones/deduplication in backup software are not part of Rio's
storage guarantee. Independent old DB backups do not pin every live media version
forever; a supported export/backup must include its own selected objects.

| Restore situation                            | Required interpretation                                                                                                                                                       |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Older DB + additional newer objects          | Follow the older DB's pointer if that object validates. Newer objects are non-authoritative retained/unknown data, not automatically “latest”                                 |
| Newer DB + missing selected generation       | Report that selected generation as unavailable. Never silently choose an older file. Explicit verified rollback/recovery must commit compatible metadata and pointer together |
| Restored files with new device/inode         | Establish fresh local receipts through an explicit validated restore/copy workflow; a matching digest alone does not restore destructive authority                            |
| Restored/duplicated accounting epoch         | Block new allocations until ownership, writer incarnation, pins and conservative charges are reconciled. An old DB cannot reset the edit budget                               |
| Catalog and media from conflicting libraries | Fail closed on library/root/instance association; do not merge by names or equal audio                                                                                        |

Dropbox-style folder replication is not an authoritative transaction or Book III
sync protocol. Treat live DB/WAL copying, concurrent writers, placeholders,
eviction and partial object transfer as unqualified. Do not broaden current
provider/network filesystem support. SQLite also warns against assuming network
filesystem access supplies correct database locking/durability; see
[SQLite over a network](https://www.sqlite.org/useovernet.html). A local sync
folder is a distinct case and needs its own evidence, not automatic acceptance or
an assertion that it is identical to a network mount.

For future Book III, generations help by separating stable track identity,
offline-created revisions, exact transferable byte objects and device-local
mapping. Resumable transfer can finish and verify a new instance before making
it usable; digests assist integrity/deduplication without merging logical tracks.
Predecessor/base-generation evidence exposes divergent offline edits instead of
silently using modification time as last-writer-wins.

This does not define merge policy, transport, accounts, deletion propagation,
global GC or shared-object refcounts. Unresolved branches/transfers would add
pins and storage costs. Local inode/root paths are never synchronized as portable
authority. Deduplication and hard-linked sharing remain deferred; whole-file tags
can differ even for identical audio. Stable IDs already benefit playlist sync
without requiring generations, so sync is a benefit to weigh, not sufficient
reason alone to migrate all storage.

## 14. Move Library and cross-platform adapters

Move Library must continue to use the **exact selected destination**, verified
copying/reopen, a commit-gated authority switch and a retained original. It must
not become an implicit generation collector or a way to reset accounting.

For internal managed roots, copy current generations, retained predecessors,
unresolved charged candidates, necessary journals/pins, the catalog and generation
metadata. Validate known object digests, re-establish destination instance receipts
and rebase local mappings in the destination catalog. Do not preserve device/inode
values as though they survive copying. Block moves during active operations and
resolve pending recovery before normal relocation; a dedicated recovery-copy mode
would need separate approval/qualification.

Preserve existing treatment of ancillary/unknown entries: copy only within the
validated envelope and existing safety rules, without adopting them as managed
objects. External custom media roots remain external; referenced sources remain
user-owned. Do not optimize a normal move to “current files only”: that would lose
retention/recovery evidence and conflict with its complete-copy contract. A
separate compact export could copy a selected verified closure but would not
erase the old source or magically reclaim its storage.

An internal catalog moved onto `noowners`, or a separate trusted catalog outside
the selected envelope, introduces a new authority topology. Preserve the original
and refuse unsupported destinations until that topology is separately qualified;
do not claim the current Move Library proof covers it.

The logical model can map to Linux native filesystems and Windows NTFS. Portable
IDs/digests/lineage and catalog transactions need no APFS dependency. Native
adapters must separately qualify exclusive creation, traversal/link refusal,
object/read binding, durable file and directory publication, open-handle behavior,
case rules and reclamation. APFS cloning is optional, not required. No Linux
unlink-by-name or Windows delete/share flag is assumed safe merely from its API
name. The existing Linux publication path is not new generation/GC qualification;
Windows production support is not established by this document.

## 15. Referenced boundary and migration

**Referenced media stays user-owned.** Rio may read, index and play it, and copy
it when explicitly requested through existing add/consolidate/recovery policy.
It must not silently version, retag, rename or delete a referenced file, even if
that file happens to be inside `Rio Media` or shares a digest with a generation.
Consolidation creates an independent managed copy and preserves the track ID; it
does not turn the external source into generation 1 of a writable lineage.

Proposed opt-in migration, only after the gates below:

1. Quiesce playback and library writes; finish existing imports/metadata recovery.
   Validate catalog authority and take a consistent schema-4 backup plus a
   manifest of its media dependencies. Existing version checks must reject newer
   schema in old binaries; no two writable catalog versions may coexist.
2. Validate each existing managed receipt/root/file read-only. Preserve every
   track ID, membership, favourite, added date, player reference and media setting.
   Missing/ambiguous managed receipts stop migration until explicitly resolved;
   keep the old-format library intact. Do not adopt by path, silently demote
   ownership or leave a partly writable migrated library.
3. In an atomic, versioned schema transaction, assign generation/object/instance
   IDs and bind the **existing physical file** as the initial generation. Its
   human-readable legacy location is allowed as a recorded instance; no media
   rewrite/move is required solely to fit `Objects/`. Keep import provenance and
   establish equivalent generation receipts. Referenced tracks get no generation.
4. Preserve existing album edition/fallback context and charges. Commit new
   pointer/projection/receipt relationships consistently; validate integrity and
   reopening before declaring migration complete. Partial schema backfill must
   never create a partially writable mixed-authority library.
5. Subsequent admitted metadata edits may create the first object-store successor.
   The legacy file is then retained under the same policy, with no unsafe rename
   or cleanup to force uniform layout.

Before any generation publication, rollback can restore the old catalog against
unchanged original files after verifying the snapshot. After a generation has
committed, replacing the DB with an old schema-4 copy would select stale media and
lose accounting/pins. Downgrade then requires an explicit verified export/restore
plan, retaining the original new-format library; it is not an automatic file
rename or a promised lossless schema downgrade. No migration runs here.

## 16. Proposed user-facing contract

> Rio manages copies inside your chosen Rio Media storage. Your songs keep their
> identity, playlists and favourites when you edit their details. Rio prepares
> and checks a new copy before using it, so an interrupted edit does not require
> writing over the copy currently in use. The internal file location may change;
> Show in Finder reveals the copy Rio currently uses. Use Export when you want
> readable files to organize or edit with another app.
>
> Rio may retain older copies for recovery. These are not a permanent undo
> history. If Rio cannot safely free retained storage and its storage allowance
> is full, it pauses further edits and explains the available options. Music
> referenced outside Rio's managed copies remains yours and is not retagged,
> moved or deleted by this feature.

This is a proposed contract conditional on qualified implementation, not a new
claim about the shipping application. Storage diagnostics must distinguish
current, recovery-pinned, optional history, incomplete/orphan and unknown bytes;
they must not promise that a “clean” button can safely reclaim all of them.

## 17. Decision matrix

A = current supported same-path model; B = weaker in-place `noowners` writes;
C = generations/new objects; D = DB/sidecar-only library metadata;
E = separate ownership-enabled managed volume/container.

| Criterion                | A                                                      | B                                                | C                                                                            | D                                                        | E                                                                              |
| ------------------------ | ------------------------------------------------------ | ------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Integrity                | Existing qualified envelope/assumptions                | Fails Rio no-partial-authoritative-write goal    | Promising separation; catalog and GC not qualified                           | Leaves audio intact; overlay authority still needs proof | Depends on actual protected namespace and publication qualification            |
| External APFS `noowners` | Editing refused                                        | Observed compatible in comparators               | Conditional fresh-object publication; reclamation/trusted catalog unresolved | Can leave external tags untouched; not embedded editing  | Changes storage topology; external backing image not automatically trustworthy |
| Same path                | Yes                                                    | Yes                                              | No for new generations                                                       | Yes, because file tags are unchanged                     | Possible inside qualified storage; external visible paths may differ           |
| Complexity               | Lowest incremental cost                                | Superficially low, unacceptable integrity        | High schema/storage/product integration                                      | Medium overlay/export/conflict semantics                 | High provisioning, mounting, recovery and support burden                       |
| Storage cost             | Bounded staging/rollback within supported contract     | Low temporary cost                               | Full successors; needs collector or blocking cap                             | Small overlay plus DB history                            | Volume overhead, reserve capacity, backup constraints                          |
| User transparency        | Accepted behavior; explicit unsupported volume         | Easy-looking saves conceal interruption exposure | Must explain internal paths, retained bytes and blocked edits                | Must explain other players do not see Rio-only edits     | Must explain special storage/mount lifecycle                                   |
| Recovery                 | Existing journal qualification                         | Damaged authoritative audio observed             | Explicit pointer/evidence; multi-generation proof needed                     | Overlay DB recovery, original tags intact                | Container and publication recovery both needed                                 |
| Keep Organized           | Current accepted OFF-only edit policy                  | Could rewrite paths, adds more risk              | Separate logical grouping/presentation contract                              | Overlay may diverge from file tags/paths                 | Human-readable layout possible within qualified namespace                      |
| Backup                   | Current library envelope and media rules               | Can capture partially rewritten file             | Catalog/object closure and restored accounting required                      | Must back up overlay or edits disappear                  | Consistent container/catalog capture and mount restore                         |
| Future sync              | Stable IDs already help; mutable payload conflicts     | Mutable whole-file conflicts                     | Strongest revision/transfer foundation; GC/conflicts cost more               | Overlay merge/export needed                              | Device/platform-specific container hinders portability                         |
| Linux / Windows          | Existing Linux backend; Windows separate qualification | No integrity justification on any platform       | Portable logical model; native adapters need proof                           | Portable logical overlay, not file-tag interoperability  | Volume/container mechanisms differ; not a universal adapter                    |
| Decision                 | **Keep for current release**                           | **Reject**                                       | **Preferred conditional future candidate, not adopt now**                    | Separate explicit product alternative                    | Do not require by default; qualify only if chosen                              |

E is not solved by putting a writable disk-image file on the same unprotected
external storage and assuming its backing object cannot change. It requires a
concrete mount/backing-file authority proof. Repartitioning or special-volume
requirements are substantial usability costs, not an automatic solution.

## 18. Unresolved risks and implementation gates

Before an implementation mission can adopt C, require explicit decisions and
proof for all of the following:

1. **Product gate:** accept changing managed physical paths, opaque internal
   storage, Finder/M3U/album-reveal consequences, organization policy and the
   behavior when storage prevents another edit. Decide whether a blocking cap is
   acceptable; if fifty successful 1 GB edits at bounded storage are required,
   prove reclamation or a separately bounded storage representation first.
2. **Authority gate:** specify and qualify catalog/root association, journals/WAL,
   single writer, restored/duplicated libraries, accounting epochs and startup
   recovery. State exactly which external-library topologies are supported. No
   profile-global media configuration or silent second writable DB.
3. **Publication gate:** multi-generation process-crash and I/O/flush/ENOSPC
   matrix, durable intent before create, CAS conflicts, source/candidate/root
   changes, commit uncertainty, idempotent retries, unknown artifacts and all
   recovery states. Use documented APIs and benign disposable experiments;
   questions outside those limits remain unresolved rather than passed.
4. **Reclamation/budget gate:** an independently qualified destructive capability
   or explicit retention-only support with enforced persistent caps. Prove pins,
   absent/changed paths, uncertain deletion, allocation accounting, restarts,
   restored older DBs and failure without any unsafe cleanup fallback.
5. **Integration gate:** generation receipts and current-pointer atomicity,
   scanner exclusion, logical album/fallback projection, the real Phase 2B idle
   gate, stale protocol tokens, source release, renderer/main session validation,
   exports and user recovery. No editing-active-generation exception.
6. **Lifecycle gate:** no-rewrite migration, pre/post-migration rollback limits,
   consistent backup/restore, all retained objects in exact-destination relocation,
   external-root preservation and unsupported destination refusal.
7. **Platform/performance gate:** source and packaged qualification on each
   supported platform/filesystem, tested durability envelope and resource limits.
   Larger-than-64-MiB FLACs, clone efficiency, signed distribution and sync are not
   implied by the existing x64 one-edit research result.

The design is viable as a direction for separating logical identity from byte
objects. It is **not yet a satisfactory universal replacement** for Rio's current
managed storage: current evidence cannot simultaneously promise unlimited
full-file edits, bounded retained storage and unconditional refusal of unsafe
pathname deletion on `noowners`. Preserve that distinction before committing to
core adoption or implementation.
