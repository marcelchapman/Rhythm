# APFS ownership investigation — Phase 2C.1

## Decision

Do not enable metadata publication on `noowners` with the current native design.
The counterexample is loss of exclusive staging/recovery namespace authority,
not lack of atomic APFS rename or successful durability syscalls. Production
policy, coordinator, writer, playback and renderer behavior remain unchanged.

The same ordinary second UID that was denied access to the ownership-enabled
image could open the mode-0700 workspace and mode-0600 staged file read/write on
the `noowners` image. A named-user allow plus everyone-deny ACL initially blocked
that UID, but it could remove the ACL and then open the staged file read/write.
Those actors did not use root privileges for fixture access: the privileged launcher
forked children, removed supplementary groups and set both real/effective UID
and GID to the existing `nobody` identity before fixture I/O. No accounts or real
volume settings were changed.

This establishes a concrete failure of the existing privacy invariant. It does
not claim that every conceivable future APFS architecture is impossible.

## Exact rejecting check and original rationale

`filesystem()` in `native/publication.cc` refuses APFS if it is non-local,
read-only, or has `MNT_IGNORE_OWNERSHIP`. The specific rejected condition here is
`s.f_flags & MNT_IGNORE_OWNERSHIP`. Its error is:

`Require local writable APFS with ownership enabled`

The original publication design also depends on:

- `regular()`: bounded regular target/artifacts, exactly one link, effective-UID
  ownership, no immutable/dataless flags.
- `workspaceCheck()`: anchored device/inode/type/parent relationship, mode 0700,
  effective UID and an empty extended ACL for the exclusively created workspace.
- `unchanged()` / full fingerprints: device/inode/type, link count, size, mode,
  UID/GID and nanosecond timestamps.
- Cleanup: revalidate particular private entries, then unlink those names and
  remove only the empty known workspace. No recursive or public-target unlink.

The initial safety report explicitly excludes malicious same-UID processes and
administrators from a claim of race-free private cleanup. Ownership-enabled
0700/0600 plus the ACL policy supplies the exclusion of **other** ordinary UIDs.
`noowners` breaks that distinction. A successful `st_uid == geteuid()` check can
be satisfied for different callers against the same namespace, so that equality
does not establish a unique trusted owner there.

## Primary-source research

Apple documents that ignoring ownership makes files appear owned by the current
user. [Apple Support](https://support.apple.com/en-om/guide/mac-help/mchlp1204/mac)

In Apple's published XNU `xnu-11417.140.69`,
`vnode_attr_handle_uid_and_gid()` applies mount owner/group overrides and maps
the special UID/GID 99 to caller credentials when applicable. It is used during
attribute retrieval and authorization.
[kpi_vfs.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/vfs/kpi_vfs.c)

`vnode_authorize_simple()` grants an owner `WRITE_SECURITY` before evaluating
ACL restrictions; ACL removal requires that right. The published POSIX
authorization path selects owner permission bits for an owner.
[vfs_subr.c](https://github.com/apple-oss-distributions/xnu/blob/xnu-11417.140.69/bsd/vfs/vfs_subr.c)

These sources explain the observed credential-dependent owner projection and
ACL-removal result. They are not assumptions that every `noowners` mount has an
identical configuration; the disposable-image counterexample alone prevents
blanket support under the existing safety contract.

## Qualification matrix

Host: Intel macOS 15.8.1, build 24H32, Darwin 24.6.0. Both volumes were separately
created local writable APFS sparse images, attached with `-owners on` and
`-owners off`. Fixture files, journals, crash manifests and foreign-device tests
were confined to those images. The user's external disk and music were not used.

Machine-readable evidence:
[apfs-ownership-macos-x64.json](qualification/apfs-ownership-macos-x64.json).

| Property / test                                                   | Ownership enabled | `noowners`                            |
| ----------------------------------------------------------------- | ----------------- | ------------------------------------- |
| Raw `RENAME_SWAP`, observed identities                            | Passed            | Passed                                |
| Occupied `RENAME_EXCL` leaves destination intact                  | Passed            | Passed                                |
| Device/inode identity and stale-inode distinction                 | Passed            | Passed                                |
| `O_NOFOLLOW` symlink refusal; hard-link count visible             | Passed            | Passed                                |
| File/directory `fsync` and `F_FULLFSYNC`                          | Returned success  | Returned success                      |
| Mode 0700 and 0600 representation                                 | Retained          | Retained, insufficient for isolation  |
| Other UID enters plain private directory                          | Denied            | Allowed                               |
| Other UID opens staged file read/write                            | Denied            | Allowed                               |
| Other UID creates workspace entry / chmod                         | Denied            | Allowed                               |
| Named-user allow + everyone-deny ACL initially excludes other UID | Yes               | Yes                                   |
| Other UID can remove that ACL and gain read/write access          | No                | Yes                                   |
| Actual native probe / lease acquisition                           | Supported         | Unsupported before workspace creation |
| Native publication/fault/crash suite                              | 35 passed         | Not bypassed or enabled               |
| Coordinator same-ID/path commit                                   | Passed            | Refused; original file/DB unchanged   |
| Coordinator staged/published interruption and startup recovery    | Passed            | No publication; journal aborted       |

The 35 enabled-image cases consist of three production-binding checks and 32
existing mixed production/instrumented cases. They include stale targets,
symlink/hard-link/parent substitution, unknown entries, workspace permissions and
ACL changes, foreign-device refusal, synchronization failure, and actual SIGKILL
at prepared/before-exchange/after-exchange/synced boundaries. Instrumented hooks
remain in the testing addon; they are not production exports. The coordinator
additionally passed same-path publication and startup recovery from staged and
published journals. External generated sources stayed unchanged.

The raw research executable calls the APFS syscalls directly on its own synthetic
files, without changing or bypassing the publication adapter. Those successful
mechanics tests do **not** qualify `noowners` for production publication.

## Consequences for each invariant

Atomic exchange, no-overwrite behavior, observed inode identities and link
reporting worked in both tested modes. `noowners` did not grant symlink-following
authority to `O_NOFOLLOW`. Successful sync return values were also observed in
both modes; no physical power-loss guarantee was experimentally established.

UID/GID and mode values cease to prove exclusive access on the tested `noowners`
mount. Rio observed UID 501 and group 20, while the second UID 4294967294 could
observe itself as workspace owner and obtain read/write access. The restrictive
ACL alternative failed as an independent boundary because the second identity
could remove it without first entering the directory.

That other UID can interfere with verified candidates, displaced originals and
independent rollback copies. Hashes can detect many modifications; they cannot
exclude an uncooperative writer between the final check and a name-based
exchange/unlink. Random names, retained descriptors, link counts and receipts
identify objects but do not make this now-shared directory private. APFS exchange
and unlink do not accept Rio's expected inode/digest as an atomic precondition.

Recovery can therefore detect ambiguity but cannot ensure that trustworthy
original/rollback bytes survived interference. If a durable journal/receipt DB
is itself on such a volume, its access boundary also needs separate protection.
The workspace counterexample remains sufficient even with a journal stored on
an ownership-enabled volume. Playback quiescence only excludes Rio's decoder
uses, not an unrelated local UID.

## Replacement evidence and next safest option

Equivalent support would require a kernel-enforced, persistent exclusion of
unrelated writers for candidate, displaced original, rollback and cleanup names,
including across crash/restart. It must not be revocable by those writers. A
trusted durable journal and authoritative managed-file receipt are still needed.
No replacement establishing all of that was found in this design. XNU also has
explicit mount-owner overrides, so this result is not an assertion that every
possible override configuration behaves identically. A narrower policy would
need a reliable runtime proof of stable, exclusive authorization rather than
Rio merely observing its own projected UID. No such production proof was
established here:

- Empty ACL / 0700 and per-caller UID equality failed the cross-UID test.
- A restrictive named-user ACL was removable by the excluded identity.
- Advisory locks / cooperative file coordination do not exclude a malicious or
  uncooperative writer.
- More hashes or rechecks do not create a conditional rename/unlink operation.
- Staging on a separate private filesystem loses same-filesystem exchange and
  does not make final publication into the shared namespace conditional.
- Immutable flags are not an implemented replacement; the adapter currently
  refuses such targets. Root/same-UID interference remains outside the original
  exclusion claim in any event.

The safest supported option is managed media on ownership-enabled local APFS,
using the existing native authority and publication lifecycle. A future product
option could offer a Rio-owned dedicated APFS volume with ownership enabled,
while leaving other storage unchanged. That would require explicit provisioning,
mount/device identity and recovery design; it is a separate architecture mission,
not a flag removal or direct-write fallback. An image stored as an ordinary file
on `noowners` storage is not automatically a private boundary: interference with
its container must also be excluded. A new kernel-enforced namespace or
conditional-publication mechanism would likewise need its own proof.

Network filesystems, exFAT, NTFS, FAT, SMB/NFS, FUSE/provider-backed storage and
other filesystem types are not newly supported. Existing Linux qualification is
unchanged. This study does not establish arm64, other macOS versions or physical
power-failure qualification. No new packaged editing qualification or build was
performed because `noowners` support was not enabled.

## Reproduction

Run `npm run build:native -- --test` and compile the existing domain output with
`npx tsc -p tsconfig.main.json` if needed, then:

```sh
node scripts/apfs-ownership.mjs --cross-uid
```

The command builds the separate strict-warning research C executable, mounts
both disposable images, runs native/coordinator checks, and requests macOS
administrator authorization solely to fork the existing `nobody` actors. Each
actor drops supplementary groups and real/effective UID/GID before fixture I/O.
Images are detached and removed in `finally`. Without `--cross-uid`, it runs the
unprivileged matrix and explicitly reports that the cross-UID test was skipped;
that mode alone is not the complete isolation qualification.
