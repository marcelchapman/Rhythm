# Phase 2C.2: APFS noowners adapter qualification stopped at cleanup

## Result

**No production noowners adapter was enabled.** The research gate found a
counterexample to the required unrelated-file cleanup guarantee. Production
publication, coordinator, receipts, journal, editor eligibility, playback and
sender/frame/session behavior remain unchanged. Local APFS mounted `noowners`
continues to be refused.

The counterexample is narrower than the previous ownership-exclusion finding:
a second ordinary UID can substitute an unrelated file **after the final cleanup
check**, and the reused native cleanup returns `cleaned` after unlinking that
file's last directory entry. Both abort and committed layouts reproduced it.

This meets the mission's explicit stop condition:

> If hostile modification creates an undetectable path to silent corruption of unrelated user data, stop and report the blocker rather than shipping the adapter.

The mission also requires that cleanup never delete an unrelated replacement.
Excluding hostile access to staging does not satisfy that separate condition when
cleanup can silently consume an unrelated inode. No attempt was made to relabel
that outcome as a successful baseline adapter.

This is **not** a claim that staged publication on noowners is fundamentally
impossible. APFS atomic exchange, descriptor-bound staging, verification and
journal-based reconciliation remain promising under the requested threat-model
split. Automatic destructive cleanup is the concrete unresolved boundary in the
reuse design tested here.

## Architecture considered

The intended design remains one publication interface with capability selection:

| Storage capability                              | Current selected behavior            | Integrity baseline          | Unrelated-UID exclusion                                                |
| ----------------------------------------------- | ------------------------------------ | --------------------------- | ---------------------------------------------------------------------- |
| Qualified local writable ownership-enabled APFS | Existing strong adapter              | Existing qualified contract | Existing private-namespace property, within its documented assumptions |
| Local writable APFS with noowners               | Refuse; second adapter not qualified | Not advertised as supported | Must not be claimed                                                    |
| Other/unknown macOS filesystem                  | Refuse                               | Not advertised              | Not advertised                                                         |

Linux behavior was not changed or broadened. The new selection interface and
strategy diagnostics were not shipped because the second strategy did not pass
its research gate. Renderer code never selected a strategy; no direct writer
fallback was added.

A hypothetical noowners backend could reuse much of the existing algorithm,
but must not treat the current workspace checks as proof of exclusive namespace
authority. Nor can it simply report `cleaned` while leaving unrecorded artifacts.

## Algorithm audit before production changes

| Existing component                                                  | Ownership dependency / reuse assessment                                                                                                                                                                                          |
| ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anchored root/parent descriptors, ancestry and mount checks         | Useful identity evidence independent of UID privacy. Do not freeze directory topology.                                                                                                                                           |
| `O_NOFOLLOW`, bounded regular files, one-link checks                | Reusable rejection rules. A retained descriptor prevents a later pathname replacement from redirecting writes through that descriptor.                                                                                           |
| Exclusive candidate/rollback file creation and retained descriptors | Produces separate objects; authoritative source is not intentionally mutated. A descriptor identifies its object, not whichever inode later occupies its name.                                                                   |
| UID equality in `regular()`                                         | On noowners it may be caller-projected; cannot establish exclusive ownership. It must not be weakened globally for the strong adapter.                                                                                           |
| Mode 0700/0600 and workspace ACL policy                             | Provides the stronger unrelated-UID exclusion on qualified ownership-enabled storage; no equivalent exclusion on noowners was established.                                                                                       |
| Candidate/source/rollback fingerprints and hashes                   | Detect observed stale or changed evidence. They are point-in-time checks, not atomic preconditions on a later unlink/exchange.                                                                                                   |
| Descriptor-relative `RENAME_SWAP`                                   | Preserves whole namespace objects; postchecks can detect an unexpected displaced object and retain it. Not an expected-inode compare-and-swap.                                                                                   |
| File/directory `fsync` plus `F_FULLFSYNC`                           | Existing APFS mechanics worked in the prior two-mode matrix. Successful calls are not a physical power-loss experiment.                                                                                                          |
| Durable journal and coordinator reconciliation                      | Existing state machine remains valuable. Requires trustworthy recorded evidence within the declared threat model and correct cleanup results.                                                                                    |
| Capability-probe artifact deletion                                  | Also checks names before unlinking them; cannot inherit a private-namespace assumption on noowners.                                                                                                                              |
| Slot/rollback cleanup                                               | Checks identities/bytes, then unlinks names. The measured last-check/unlink interleave silently deleted a different inode.                                                                                                       |
| Coordinator terminal journal state                                  | `cleanup()` in `src/domain/metadata-edit.ts` requires native `cleaned` before marking `done`/`aborted`. Returning a false cleanup success can conceal the loss; this study did not execute a coordinator journal for the attack. |

The production cleanup boundary is in `native/publication.cc`:

```text
privateExpected(slot)
workspaceCheck()
unlinkat(workspaceDescriptor, "slot", 0)
```

The final workspace check verifies directory identity, mode, UID and ACL policy;
it does not atomically bind the following name deletion to the checked slot
inode. A post-unlink check of the retained original slot descriptor could detect
that the intended inode survived, but would be too late to prevent deletion of
the replacement. Another pathname recheck merely moves the boundary.

## Disposable experiment and provenance

Evidence: [apfs-cleanup-boundary-macos-x64.json](qualification/apfs-cleanup-boundary-macos-x64.json).
Reproduction: [research runner](../scripts/research/apfs-cleanup-boundary.mjs)
and [unprivileged actor](../native/qualification/apfs-cleanup-actor.c).

Host: Intel macOS 15.8.1, build 24H32, x64. Two 256 MiB APFS sparse images were
created for this run, attached with ownership on/off:

```text
/dev/disk5s1 on /private/tmp/rio-apfs-boundary-H77DkV/on
(apfs, local, nodev, nosuid, journaled, nobrowse, mounted by marcelchapman)

/dev/disk7s1 on /private/tmp/rio-apfs-boundary-H77DkV/off
(apfs, local, nodev, nosuid, journaled, noowners, nobrowse, mounted by marcelchapman)
```

The runner generated an **unshipped temporary copy** of `native/publication.cc`.
There were three behavioral changes in that copy only:

1. Admit noowners in filesystem classification for the research experiment.
2. Accept a fourth native cleanup argument, a test callback.
3. Invoke that callback after the final slot and workspace checks, immediately
   before the real `unlinkat` call.

The copy also has a build guard requiring `RIO_PUBLICATION_TESTING`. It is built
outside `dist/` and `release/`, never linked into the production addon. All normal
fingerprint, digest, link, workspace, ACL and ancestry checks remain in the
experimental path. `PublicationLease.cleanupVerifiedArtifacts()` is the existing
compiled domain implementation, using this injected research binding. This is a
deterministic interleaving counterexample, not a measured probability of winning
an unsynchronized timing race.

The actor launcher requires macOS administrator authorization solely to launch an
actor that drops supplementary groups and both real/effective UID/GID to the
existing `nobody` identity **before fixture I/O**. The actor verifies the drop;
its recorded real/effective UID is 4294967294. No accounts or real-disk settings
were changed.

Only test-created files were used:

```text
<image>/Media/Track.flac                  opaque native-adapter test bytes
<image>/Media/.rio-publication-UUID/slot  checked candidate or displaced original
<image>/Media/.rio-publication-UUID/rollback
<image>/Unrelated/victim                 unrelated disposable payload
```

`Unrelated` is outside the configured `Media` environment. The suffix `.flac`
is merely the native fixture pathname; no FLAC writer or coordinator edit is
claimed for this counterexample. The adapter treats bytes as opaque. Media and
Unrelated directories were mode 0700; files were mode 0600.

At the selected interleave, the actor renames the valid slot to `Media/parked-slot`
and moves `Unrelated/victim` to the already-checked `slot` name. The victim has
one link. The native cleanup then resumes without another slot identity check.
The victim's retained test descriptor proves which inode lost its last link.
Its bytes remain readable through that descriptor until it closes; `links=0`
means no namespace entry remains, not that storage was securely erased.

The actor's rename already removes the victim's original pathname. In the early
control the file survives at the workspace slot. In the late cases Rio's copied
cleanup performs the subsequent last-link deletion. The report does not
attribute the actor's initial rename to Rio.

The production-source and production-binary SHA-256 were checked unchanged
before/after the run and recorded in the evidence. All images were detached and
all run-owned temporary trees removed in `finally`. No real music, real library,
branding, package configuration or application installation was touched.

## Results

| Mode / interleave                          | Actor result                     | Cleanup result    | Victim result                              | Authority / ambiguity                                                              |
| ------------------------------------------ | -------------------------------- | ----------------- | ------------------------------------------ | ---------------------------------------------------------------------------------- |
| Ownership enabled, after last check, abort | Denied workspace entry, `EACCES` | `cleaned`         | Link count 1; original pathname intact     | Managed original intact; exclusion control passed                                  |
| Noowners, before cleanup inspection, abort | Replacement succeeds             | `cleanup-refused` | Link count 1; retained at workspace `slot` | Changed evidence detected; workspace retained                                      |
| Noowners, after last check, abort          | Replacement succeeds             | **`cleaned`**     | **Link count 0; workspace gone**           | Managed original intact, but unrelated-file deletion not reported                  |
| Noowners, after last check, committed      | Replacement succeeds             | **`cleaned`**     | **Link count 0; workspace gone**           | Verified candidate remains authoritative, but unrelated-file deletion not reported |

The late victim inodes were 28 (abort) and 37 (committed). Both contained the
same 58-byte unrelated payload with SHA-256
`703791c8b9b48c260300f089103d4a7f02ef3246c75a38fe0eb57d94b9a692e2`.
The native return value contained no warning or recovery-required result.
This is the requested hard-stop counterexample, not merely evidence that another
UID can read or alter Rio's own candidate.

The **actual production probe** continued to accept the ownership-enabled image
and refuse noowners in every case. The existing 35 native qualification cases
also passed on the ownership-enabled image, including production-binding checks,
stale/substitution conflicts, symlink/hard-link cases, sync failures, cleanup
refusals and SIGKILL recovery layouts. Those passes are not qualification of a
new noowners adapter.

## Candidate primitives and the remaining invariant

Retained descriptors prove object identity for reads/writes through those handles.
They do not turn a later name-based deletion into “unlink this recorded inode”.
The SDK/API and Apple's matching XNU
[`unlinkat` implementation](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/vfs/vfs_syscalls.c#L6127)
provide a directory descriptor, pathname and flags; there is no caller-supplied
expected inode/digest operand. Kernel-internal lookup serialization does not
join a previous user-space fingerprint check to the deletion.

A cooperative lock, extra hash, generation check or random name does not by
itself supply that missing atomic relationship. The prior study's ACL attempt
was revocable on noowners. User immutable flags are not a qualified replacement
and would conflict with current native eligibility.

Darwin `F_SETLEASE` was investigated as a possible stronger primitive. Apple's
matching XNU source gates `vnode_setlease` through the private entitlement
`com.apple.private.vfs.file-leases` in
[`allow_setlease`](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/vfs/vfs_subr.c#L11911).
It is not an available, qualified replacement capability for this unsigned Rio
application. No entitlement/security bypass was attempted, and no runtime lease
success is claimed. That source finding is not a qualification of lease behavior.

**No ownership-independent invariant was proved for automatic destructive
cleanup under the required unrelated-replacement guarantee.** This leaves the
research gate closed even though most staged-publication mechanics can remain.
No global owner check, strong-adapter policy or coordinator check was relaxed.

## Next architectural proof

A future second backend needs a different cleanup design, not another check in
front of `unlinkat`. Two concrete directions remain to investigate:

- A genuinely conditional object-identity deletion/retirement capability available
  to ordinary Rio processes, qualified on the supported macOS/APFS versions.
- A non-destructive artifact-retirement protocol that never unlinks entries in
  the untrusted namespace, durably records retained evidence, preserves unexpected
  objects and has explicit capacity/reclamation rules. It needs an honest journal
  terminal/retained state rather than treating leftover material as `cleaned`.

The second direction could retain a trustworthy recovery copy separately, but a
private backup alone does not prevent the shared-name cleanup race. Neither
direction has been implemented or qualified here. This is not a request to restore
unrelated-UID exclusion as the baseline: it identifies the narrower destructive
operation that still needs an independent invariant.

If that boundary is solved, continue the requested noowners crash/fault matrix,
ordinary-concurrency and hostile-candidate tests, coordinator/journal recovery,
real Track Info/IPC acceptance, playback checks, full desktop suites and fresh
unsigned x64 packaging. Do not substitute Apple Music's observed direct writer:
its successful local edits and the interrupted-growth result do not provide
Rio's staged-publication guarantees.

## Validation and qualification boundary

| Check                                                         | Result                                                                                                |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Strict C/C++ compilation of research actor/copy               | Passed with `-Wall -Wextra -Werror`                                                                   |
| Four deterministic cleanup-boundary cases                     | Reproduced the two late noowners deletion failures; early and owners-on controls behaved as specified |
| Existing ownership-enabled native qualification               | 35 passed, including process-crash recovery cases                                                     |
| Full `npm test`                                               | 466 passed across 22 files, including metadata coordinator/recovery/editor coverage                   |
| `npm run typecheck`, `npm run build`                          | Passed                                                                                                |
| Research JS syntax, targeted Prettier and `git diff --check`  | Passed                                                                                                |
| Production source/binary preservation                         | Hash assertions passed; no production code changed                                                    |
| Noowners production publication                               | Still refused; never enabled                                                                          |
| Full noowners transition/fault matrix                         | Not run after the hard stop; no qualification claimed                                                 |
| Source/packaged metadata UI, playback and full desktop suites | Not rerun after the research stop; unchanged production behavior is not a new adapter qualification   |
| Fresh DMG/ZIP and noowners packaged manual acceptance         | Not built/run: the conditional production-support gate did not pass                                   |

Phase 2C **cannot yet be manually accepted for metadata publication on external
noowners APFS** with the current production adapter. Existing ownership-enabled
behavior is retained. Broader filesystem/platform/format support remains outside
this mission.

To reproduce the research (administrator-authorized actor; disposable images only):

```sh
npm run build:native -- --test
npx tsc -p tsconfig.main.json
node scripts/research/apfs-cleanup-boundary.mjs --cross-uid
```

The runner overwrites its research result JSON with the new run. It builds only research artifacts and never installs or packages an adapter.
