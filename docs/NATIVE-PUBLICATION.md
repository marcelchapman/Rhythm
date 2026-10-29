# Native publication adapter — Phase 2A.1

This is an isolated filesystem capability, **not** a metadata coordinator. No
Library, database, Track Info, IPC, renderer, playback, relocation, or metadata
writer integration was added. No real music is needed for qualification.

## Contract

`src/domain/publication.ts` owns the interface. `native/publication.cc` implements
its narrow Node-API backend. Callers must be trusted main/domain code and must
already have the authority to operate on the exact managed target.

- `probePublicationSupport(target)` probes filesystem policy, actual exchange,
  occupied-destination no-overwrite behavior, and required barriers using private
  disposable artifacts. It does not open/replace the public target.
- `openPublicationLease({ root, rootIdentity, relative, expected,
originalSha256, candidate })` binds retained handles to the validated root,
  parent and original file; verifies the original digest; creates and verifies
  the private candidate and independent rollback copy.
- `lease.record` is a serializable snapshot of identities, paths and hashes.
  A future coordinator **must durably journal it before exchange**. This module
  does not create a durable journal for the caller.
- `lease.exchangeAndObserve()` independently checks bytes, performs native
  fingerprint checks, exchanges the public target and private slot atomically,
  then checks the displaced/public objects and their SHA-256 hashes.
- `lease.inspectPublication()` observes the anchored target, slot and rollback.
- `lease.syncPublication()` explicitly synchronizes files and affected directory
  entries; exchange alone is not a durability result.
- `lease.cleanupVerifiedArtifacts("abort" | "committed")` checks the required
  layout, exact identities, bytes, workspace boundary and contents before removing
  only the private slot/rollback and the now-empty workspace.
- `lease.close()` releases descriptors without deleting artifacts.
- `inspectInterruptedPublication(record)` reopens verified directory identities
  for inspection after process loss. It cannot resume exchange or cleanup. On
  macOS, inspection can reassert the private workspace's empty ACL as described
  below; it never modifies public audio or namespace entries.

The caller supplies a complete stat fingerprint (decimal strings preserve integer
precision): device, inode, type, link count, size, mode, UID/GID, nanosecond mtime
and ctime, plus a separately verified original SHA-256. Raw bytes—not a candidate
pathname—are supplied for the candidate. Files are bounded to 64 MiB. The native
adapter treats contents as opaque bytes; the Phase 1 writer remains responsible
for FLAC validity, patch semantics, preservation and audio verification.

Snapshot values cannot be changed by mutating the returned record. Native leases
are type-tagged objects with finalizers; explicit close is preferred. The API is
synchronous and must run in a bounded worker/process in a future coordinator.

## States and recovery evidence

Results distinguish `unsupported`, `no-change`, `exchanged-expected`,
`exchanged-conflict`, `recovery-required`, `synced`, and `sync-failed`. Cleanup
returns `cleaned`, `cleanup-refused`, or `cleanup-incomplete`; a later cleanup
failure can follow some successful private removals. No boolean erases these
distinctions. A failed preparation can report a retained workspace for diagnosis;
that information alone never authorizes recursive deletion or orphan adoption.

Let T be the public target, S the private slot, and R the independent rollback.

| Point                       | T                                | S                        | R                                    | Required interpretation                                     |
| --------------------------- | -------------------------------- | ------------------------ | ------------------------------------ | ----------------------------------------------------------- |
| Prepared                    | original A                       | candidate C              | independent copy(A)                  | Caller must persist the record before exchange              |
| Expected exchange           | C                                | displaced A              | copy(A)                              | Verify, synchronize, then let a future coordinator commit   |
| Unexpected substitution     | C                                | unexpected B             | copy(A)                              | Conflict; preserve B; no automatic exchange-back or cleanup |
| Process loss after exchange | inspect actual identities/hashes | inspect                  | inspect                              | A journal phase alone is insufficient                       |
| Committed cleanup           | C                                | removed only if proven A | removed only if proven owned copy(A) | Commit authority belongs to the future coordinator          |

Post-exchange ctime is not compared to pre-exchange ctime because namespace
operations can change it. Device/inode, type, links, size, mode, ownership and
mtime remain checked, and independent digest verification is mandatory. Before
exchange, ctime is included in the full unchanged check.

The four SIGKILL cases qualify prepared, pre-syscall, post-syscall/pre-observation,
and synchronized layouts under an application-process crash. They are **not**
power-cut tests. Recovery inspection has no authority to delete an unfamiliar
file, restore over a newer target, or decide a database commit.

## macOS implementation

The backend walks canonical absolute root components and managed relative parent
components using `openat` with `O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC`, retains
descriptors, and checks their parent-entry relationships before operations.
Target reads use retained file handles. Publication uses descriptor-relative
`renameatx_np(..., RENAME_SWAP)`. The occupied-name probe uses `RENAME_EXCL`.

No newer optional rename flags are assumed. The build targets macOS 13, but only
the actual runtime/filesystem qualification below is established. Runtime probes
fail closed rather than replacing unsupported behavior with ordinary rename.

Files and directories require `fsync` **and successful `F_FULLFSYNC`**. The adapter
does not silently fall back to a weaker barrier. Success reports `fullfsync`,
which means the requests succeeded, not that faulty hardware cannot lose data.

## Linux implementation

The backend uses `openat2` with `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_MAGICLINKS`; managed traversal additionally requires `RESOLVE_NO_XDEV`.
It retains directory descriptors and checks mount IDs from `/proc/self/fdinfo`,
filesystem classification from `/proc/self/mountinfo`, and device identities.
Missing resolution/mount evidence is unsupported, not a reason to drop flags.

`renameat2(..., RENAME_EXCHANGE)` performs exchange. `RENAME_NOREPLACE` is tested
against an occupied private destination. Required `fsync` calls cover file
contents and affected directories. The backend reports `fsync` only if all calls
succeed. Linux is implemented against these primary syscall semantics and must
pass the Ubuntu CI qualification; it was not runtime-executed on the macOS host.

## Workspace and target policy

The private workspace is created exclusively under the retained target parent
as `.rhythm-publication-<UUID>`, mode 0700, with mode-0600 files. It is checked by
device/inode, type, effective UID, mode, parent relationship and ACL policy.
Candidate and rollback are separate regular inodes. Unexpected files/subfolders
in the workspace prevent cleanup; no recursive removal exists in the adapter.

macOS ACL retrieval can return ENOENT on a new directory. The adapter does not
infer ACL absence from that result: for its identity-checked **owned workspace
only**, it explicitly establishes an empty ACL with `acl_set_fd_np` and requires
success. A retrieved populated ACL or any other retrieval/set failure is refused.
Linux refuses extended access/default workspace ACLs. Target ACLs are never
changed by these workspace checks.

Mode 0700, exclusive creation and ACL checks are not a security boundary against
another process running as the same user. An administrator or same-UID process
can interfere with retained objects and private entries. Unchecked changes in
that namespace are outside a claim of race-free cleanup.

Targets must be bounded regular files owned by the effective UID, with exactly
one link. Root/parent substitution, symlink traversal, unexpected hard links,
immutable/dataless macOS files and device/mount transitions are refused. A raced
symlink/directory appearing at the exchange boundary can still be displaced;
post-observation reports conflict and retains it without following/deleting it.

The initial filesystem policy accepts only local writable APFS with ownership
enabled, or writable ext4 classified from Linux mount evidence. Both also need
successful actual operation/barrier probes. Node-only pathname/device equality
is not treated as proof: Linux bind mounts can share a device while being
different mounts. There is no EXDEV copy/delete fallback.

Network, FUSE, overlay and other filesystem types fail policy. Hydrated
provider/sync-managed files can resemble ordinary local files and are not thereby
qualified; reliable identification and live-writer exclusion remain integration
requirements. A successful probe is a capability result, not managed ownership.

## Residual race

Neither platform supplies an expected-inode/digest operand to exchange. If B
replaces A after precheck, exchange can put C at T and B at S. B's object survives,
but its name has changed. The adapter reports conflict and never blindly reverses
the exchange. An open directory can also be moved after validation; retained
descriptors prevent redirection into the replacement parent, while postchecks
report the changed ancestry. They do not freeze directory topology.

In-place writers and new post-publication changes cannot be excluded by these
primitives. The application must serialize its own media operations, release
affected playback handles and handle external conflicts through a durable
coordinator. Ordinary Node rename is prohibited as fallback because it can
remove unexpected B's final pathname instead of retaining it for inspection.

## Build, package and harness

No npm/native framework dependency was added. `scripts/build-publication-native.mjs`
uses a C++17 compiler and installed official Node C headers, restricting itself to
Node-API 8. No V8 APIs, Electron ABI-specific rebuild, or node-gyp download is
needed. macOS requires Command Line Tools; Ubuntu CI explicitly installs
`build-essential`. Compiler/source/header fingerprints and binary SHA-256 are
recorded, cached binaries are verified, and output is published atomically.

`npm run build` compiles the production addon. `npm test` also builds an isolated
instrumented variant. The production binding has no interleave/failure hooks.
`dist/native/testing/` is excluded from packages and the production `.node` file
is unpacked from ASAR. A beforePack hook rejects wrong platform/architecture or
binary/manifest mismatches. Cross/universal packaging is intentionally rejected.

Commands:

```sh
npm test -- tests/publication.test.ts
npm run test:publication
node scripts/publication-electron.mjs
npm run dist:mac -- --publish never
node scripts/publication-electron.mjs --packaged
```

The standalone harness uses temporary libraries of generated FLAC byte fixtures,
not an actual library/database. Deterministic native-only test hooks substitute
objects precisely after precheck. The foreign-device guard is exercised when a
second volume is available (macOS workspace volume, Linux `/dev/shm`, or
`RHYTHM_PUBLICATION_OTHER_VOLUME`). The workspace-volume policy is probed
separately. Test cleanup recursively removes only the harness's disposable tree;
that is deliberately distinct from the production adapter's cleanup behavior.

CI runs unit, Node, embedded-Electron and packaged-Electron qualifications on
macOS/Ubuntu with bounded steps. Existing artifact uploads and `--publish never`
remain in place.

## Qualified envelope and next gate

Current local qualification: Intel macOS 15.8.1, internal APFS with ownership
enabled, Node 26.12.0 and Electron 44.9.2 / Node 24.22.0. The external APFS workspace
volume is separately detected as `noowners` and reports unsupported. These results
do not qualify every APFS mount, macOS 13, native arm64, Linux, storage hardware,
file-provider behavior or actual power loss.

Local validation completed:

| Check                                              | Result                                                                                                              |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Focused native/build unit coverage                 | 34 tests passed                                                                                                     |
| Complete unit regression                           | 328 tests passed across 16 files, including all original 294                                                        |
| Source Electron qualification                      | All 32 scenarios passed                                                                                             |
| Packaged Intel Electron qualification              | All 32 scenarios passed from the actual ASAR/unpacked addon                                                         |
| Existing `npm run test:desktop`                    | Passed completely, including playback, managed/recovery/deletion, selection, layout and playlist suites             |
| Typecheck, Prettier, workflow YAML and diff checks | Passed                                                                                                              |
| `npm run dist:mac -- --publish never`              | DMG and ZIP generated; no install/publish                                                                           |
| ASAR/package integrity                             | Correct x64/Node-API-8 binary, matching manifest/source freshness, native file unpacked, test binary/hooks excluded |
| Archive integrity                                  | ZIP CRC test and DMG `hdiutil verify` passed                                                                        |

Local artifacts: `release/Rhythm-0.1.0.dmg`,
`release/Rhythm-0.1.0-mac.zip`, and `release/mac/Rhythm.app`. They use the existing
unsigned/unnotarized package configuration and were not installed. An initial
packaging-hook context error was corrected against electron-builder's installed
types and is covered by the new matching/wrong-architecture hook test. Packaging
also required network-enabled execution to fetch Electron resources. No product
code was changed to accommodate qualification.

Before coordinator integration: pass Ubuntu CI and platform matrix qualification;
add worker/process bounds; approve the durable journal/recovery policy and
current-receipt lifecycle; qualify file permission/ACL/xattr preservation (the
adapter's new candidate is mode 0600 and does not clone original attributes);
provide playback-release and external-conflict handling. Restart inspection is
intentionally not a mutating recovery capability. Signed/notarized distribution
and the already-documented TagLib/WASM license work remain separate release gates.
