# Apple Music metadata publication on APFS `noowners`

Study date: 1 November 2026. Research only; no Rio production publication,
metadata, playback, eligibility or filesystem-policy changes.

## Conclusion

Apple Music 1.5.6 successfully edited the disposable MP3 and AIFF files on local
APFS mounted `noowners`. In the observed paths it opened the authoritative media
file read/write and modified it **in place**, including moving MP3 audio data
when growing its tag area. Successful writes ended with a file `fsync` and
close. This was not a verified-candidate/atomic-exchange publication protocol.

One controlled process interruption during the MP3 growth rewrite left damaged
audio. Music reopened the disposable library without a recovery prompt and did
not repair the file. Independent decoding produced a different PCM hash and an
invalid-packet warning. This is a counterexample for this specific path, not a
claim about every Music format, filesystem or save implementation.

Music's ability to edit on `noowners` therefore does **not** establish that Rio
can retain its existing publication guarantees by removing the ownership check,
or that Rio should copy Music's in-place writer. It does show that useful desktop
editing and Rio's unrelated-UID staging-exclusion requirement are different
product decisions.

Recommendation: preserve Rio's staged, verified, journaled integrity design.
Consider **Option C**, with Option B's explicitly scoped integrity contract as
the common baseline and additional exclusive-staging protection where storage
can establish it. Treat hostile unrelated-UID exclusion as a separate security
property. This is an architectural recommendation, not an implemented policy
change or a qualification of Rio editing on `noowners`.

## Evidence and provenance

- **E1 — measurements:** [environment, snapshots and results](evidence/apple-music-noowners-macos-x64.json).
  Each snapshot contains device/inode, size, link count, mode, UID/GID,
  atime/mtime/ctime/birthtime in nanoseconds, SHA-256, ACL, xattrs and parsed tags.
- **E2 — ordinary saves:** [Music filesystem trace](evidence/apple-music-saves.fs-usage.txt.gz),
  6,520 Music-labelled rows. Decompress to inspect the operation sequence.
- **E3 — interruption:** [Music crash trace](evidence/apple-music-crash.fs-usage.txt),
  266 Music-labelled rows, including the target open, truncation, writes and exit.
- **E4 — prior analysis:** the original
  `/Volumes/External Disk/Dropbox/Ghidra/AppleMusicReference.gpr`, program
  `/Music/x86-64-cpu0x3`. A temporary copy was read with Ghidra 12.1.4 using
  `-readOnly -noanalysis`; the original project was not opened for modification.
  The bounded findings and addresses are retained in E1's `staticReuse` record.
- **E5 — Rio authority comparison:** [the prior APFS ownership study](../APFS-NOOWNERS.md)
  and [its native matrix](../qualification/apfs-ownership-macos-x64.json).
  Those experiments were reused, not rerun or reinterpreted as Music tests.

E1–E3 are direct runtime observations. E4 is static analysis, not proof of
execution. Conclusions about the product's apparent threat model are inferences.
Unobserved mechanisms remain unknown.

The retained traces exclude unrelated-process asynchronous disk-I/O rows and
redact absolute pathname operands outside the disposable study root. Raw
`fs_usage -f filesys` also emitted asynchronous I/O from other processes despite
its process filter; that material is not included in the repository. No lost-event
or overflow warning appeared in the captures. The records remain bounded
observations, not an exhaustive trace of every helper process or framework API.

## Isolation and environment

Intel macOS **15.8.1**, build **24H32**, Darwin **24.6.0**, x86_64.
Music **1.5.6**, executable:
`/System/Applications/Music.app/Contents/MacOS/Music`.

- Whole-binary MD5: `aa4329f3232b0eded2216241ceea0499`.
- Whole-binary SHA-256: `963dff0026e75f819e795df05ab8014f3ad0b612a8c61dcf8343717eb7f91165`.
- Prior Ghidra x64-slice MD5: `9939e87d034e9fda72cc1f4c807af176`.

The whole-binary MD5 matched the earlier project's import locator exactly.
No generic reanalysis, executable modification, debugger injection, installation
or SIP/security change was performed. REA had no retained active session/evidence;
its open/snapshot interfaces did not accept the existing `.gpr`. The existing
Ghidra project was consequently reused directly through headless read-only access.

The user selected a disposable library before any import or edit. Open-file
inspection confirmed its database path:

```text
/private/tmp/rio-music-publication-Ex4irY/off.sparseimage/Music Library.musiclibrary
```

Here `off.sparseimage` is a **directory**, not the mounted test volume. During
manual library creation that pathname replaced the initial disposable backing
image. The still-mounted old image was detached and recreated as
`noowners-backing.sparseimage` before the authoritative `baseline` snapshot.
Earlier setup measurements are excluded from the qualification data. The Music
database stayed on the host volume; only synthetic media was placed on the test
mounts. Thus the study qualifies the media-write behavior, not a `noowners`
library-database recovery design.

Final media mounts were:

```text
/dev/disk5s1 on /private/tmp/rio-music-publication-Ex4irY/on
(apfs, local, nodev, nosuid, journaled, nobrowse, mounted by marcelchapman)

/dev/disk7s1 on /private/tmp/rio-music-publication-Ex4irY/off
(apfs, local, nodev, nosuid, journaled, noowners, nobrowse, mounted by marcelchapman)
```

Both were disposable 512 MiB APFS sparse images, attached with `-owners on` or
`-owners off`. The real external volume's configuration was not changed. No real
music was imported, edited, renamed or used as a fixture. Music automatically
showed existing account purchase references in the disposable library; they were
not selected, downloaded or edited.

Copying on import and automatic media organization were disabled in the
**disposable library's** Files settings. Import left the synthetic media bytes,
paths, inodes and modification times unchanged. The user subsequently restored
the original Music library. A final read-only open-file check confirmed the
original database and no study paths; no further Music UI action or tracing
followed. Both disposable images were detached. Temporary controls and images
remain under the study root for inspection, outside the repository; none is the
active Music library.

Instrumentation: native Song Info UI, `lsof`, `stat` through Node, `ls -led@`,
`xattr -lx`, `music-metadata`, and bounded `fs_usage`. Administrator authorization
was needed for macOS kernel filesystem tracing. A second process used ordinary
same-user `flock`; the interruption observer used `kqueue` `NOTE_WRITE` and
SIGKILL against the verified disposable-library Music PID. No privilege or
platform-protection bypass was used.

## Formats and before/after measurements

The synthetic controls were 12-second, mono 44.1 kHz MP3 and 16-bit PCM AIFF,
generated locally with the already-installed FFmpeg. Both initially carried
ID3v2.4 tags. A separate, valid one-hour MP3 was generated for interruption.
No FLAC, WAV or M4A was used as a Music editing fixture.

Initial ordinary fixtures had mode **0640**, UID **501**, GID **20**, one link,
a named-user read/write/attribute ACL and `com.rio.study=disposable-sentinel-v1`.
Successful ordinary saves preserved those modes, ACL entries and xattr bytes.
Birthtime and device/inode stayed unchanged; mtime, ctime and content hash changed.
Atime is recorded but was also affected by the study's own reads.

| Fixture / operation               | Device   | Inode before → after | Size before → after     | Persisted result                                |
| --------------------------------- | -------- | -------------------- | ----------------------- | ----------------------------------------------- |
| `noowners` MP3 Title              | 16777239 | 17 → 17              | 96,654 → 96,654         | `Edited noowners MP3`                           |
| `noowners` MP3 comment growth     | 16777239 | 17 → 17              | 96,654 → 107,163        | `Expanded noowners MP3`, 255-character comment  |
| `noowners` AIFF Title/Artist      | 16777239 | 18 → 18              | 1,058,618 → 1,058,618   | `Edited noowners AIFF` / `Study Artist Changed` |
| owners-on MP3 Title               | 16777235 | 17 → 17              | 96,653 → 96,653         | `Edited owners MP3`                             |
| owners-on AIFF Title/Artist       | 16777235 | 18 → 18              | 1,058,618 → 1,058,618   | `Edited owners AIFF` / `Study Artist Changed`   |
| `noowners` MP3 interrupted growth | 16777239 | 20 → 20              | 28,800,655 → 28,811,156 | Old title readable; audio damaged               |

For example, noowners MP3 mtime changed from `1793505687485241029` to
`1793505857705940411` ns on its first Save; AIFF changed from
`1793505687540641927` to `1793505943576700224` ns. Full before/after timestamps,
ACL text, xattr hex and hashes are in E1; this table does not substitute rounded
seconds for identity evidence.

The UI typing attempt supplied more comment text than Music persisted. The
measured stored comment was **255 characters**; the 10,509-byte growth includes
writer padding. An earlier accessibility-only comment assignment did not persist
and is not counted as a growth result.

## Observed publication sequence

The first noowners MP3 Save is directly visible in E2:

```text
01:04:17.705252  open        F=33 (RW...)  .../off/Media/Study-off.mp3
01:04:17.706450  ftruncate   F=33 O=0x0001798e
01:04:17.706477  write       F=33 B=0x85
01:04:17.706659  fsync       F=33
01:04:17.706670  close       F=33
```

Metadata reads/seeks and file checks precede these operations; Music subsequently
reopens the file read-only. The descriptor remains open across the actual media
rewrite. A separate `lsof` sample while Song Info was merely open found no Music
handle to either fixture, so the dialog lifetime is not a demonstrated continuous
file-use lease.

MP3 growth extended the same file and shifted audio within it. AIFF writes also
opened the authoritative path read/write and wrote/truncated that same object.
No media candidate, media rename, `renamex_np`, exchange, or unlink/create
replacement was observed in these Save intervals. This conclusion uses both
syscalls and identity evidence, not inode equality alone.

File `fsync` was observed on successful media writes. No parent-directory sync or
`F_FULLFSYNC` was identified for those media Save intervals. That is bounded
negative evidence, not a proof that Music never uses these APIs elsewhere.
No physical power-loss test was performed.

### Temporary files and backup material

Music created `Temp File.tmp` and `Temp File 1.tmp` inside the disposable
`Music Library.musiclibrary` package, then unlinked temporary database files.
Those paths are separate from media publication. Their transient modes were not
captured; the post-quit database-package inventory in E1 cannot establish the
modes of already-removed temporary files.

No media staging file or recoverable audio backup was observed in the fixture
media directories, inspected package inventory or relevant Music trace. The
study's `crash-original.mp3` control was copied **by the experiment**, not created
by Music. An app-wide absence of backups outside these observations is unknown.

## Concurrency and failure observations

| Probe                                                          | Direct observation                                                                                             | Limit / interpretation                                                                                                                             |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Other process holds MP3 open read/write and `LOCK_EX\|LOCK_NB` | UI Save succeeds; the held descriptor sees a changed SHA-256 on inode 17                                       | Music did not cooperate with this BSD advisory lock; this does not establish absence of other locking                                              |
| External AIFF edit while Song Info is open                     | External Title/Artist/Album are present before Save; Save writes the UI Title and restores cached Artist/Album | No stale-snapshot conflict was presented in this test; another writer's metadata was overwritten                                                   |
| External AIFF rename before Save                               | `Study-off.aiff` becomes `Renamed-off.aiff`; Save writes the renamed path on inode 18                          | Consistent with persistent-location resolution; exact internal resolution mechanism is not proved                                                  |
| Different MP3 replaces the pathname                            | External replacement changes inode 17 → 19 and audio to 660 Hz; Save edits inode 19 at that path               | No strict rejection based on the originally opened inode was observed; not equivalent to Rio receipt authority                                     |
| Immutable `uchg` AIFF                                          | Repeated read/write `open` calls return `EPERM`; file bytes/mtime remain unchanged                             | Song Info closes and library displays `Blocked write attempt` without an observed error dialog; displayed metadata is not proof of tag publication |
| Process killed during MP3 growth                               | Original inode extended and partially rewritten; no target `fsync`/close before exit                           | Audio damage survives restart; no recovery prompt or automatic repair observed                                                                     |

E2/E3 contain `fcntl` **OFD_SETLK** activity on other descriptor numbers, as well
as cache-control calls. No record-lock acquisition was observed on the opened
media descriptor during the inspected saves. The mapping and purpose of every
pre-existing descriptor were not established. BSD `flock`, POSIX/OFD locks and
Foundation coordination must not be conflated.

### Interruption evidence

The one-shot observer verified Music's executable, held a read-only descriptor to
`Crash-off.mp3`, armed `NOTE_WRITE`, and sent SIGKILL when writing began. The
original Music PID had changed during the intervening user session; the stale PID
was refused before arming. PID **61335**, still using the disposable database,
was verified and used for the actual experiment.

E3 shows:

```text
11:50:54.132582  open       F=5 (RW...)  .../off/Media/Crash-off.mp3
11:50:54.135168  ftruncate  F=5 O=0x01b79f94
11:50:54.137493  write      F=5 B=0xf4240
11:50:54.139224  write      F=5 B=0xf4240
11:50:54.140842  write      F=5 B=0xf4240
11:50:54.142285  write      F=5 B=0xf4240
```

The trace then records process exit without completion of the media rewrite.
The attempted edit changed Comments; Title was intentionally unchanged, so its
continued readability is not evidence of rollback or recovery.
Independent full decoding of the one-hour control and interrupted file produced:

- Control PCM MD5: `f2de8252d6eb7a52de90cbe87c88f703`, no decoder warning.
- Interrupted PCM MD5: `43aa0e4363a45676b0fe16a3938b7175`, with `Header missing`
  and `Invalid data found when processing input` warnings.

FFmpeg returned zero in both cases; that exit code is **not** a clean-decode
claim. The warnings and different audio hashes are the damage evidence. Music
reopened the same disposable library without a recovery prompt. The damaged
file's hash and timestamps stayed unchanged across the recorded restart.
One kill point does not map every possible crash boundary or establish
power-loss behavior.

## Previous RE findings reused

The prior Ghidra database already contained the exact installed binary's x64
analysis. Narrow cross-reference/decompilation reads established:

| Address                              | Static observation                                                                               | What it does not prove                                               |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `0x100741238`, call at `0x100741622` | Constructs QuickTime metadata/user-data dictionaries and calls `_AVCFRewriteMetadata`            | Not a runtime identification of the tested MP3/AIFF writer           |
| `0x100304da3`                        | Capability-dependent helper chooses `_exchangedata(...,1)` or `_renamex_np(...,2)`               | Presence does not mean Song Info used exchange in these saves        |
| `0x100305f3f`                        | Descriptor `_fsync` wrapper with errno handling                                                  | Not a complete durability protocol                                   |
| `0x1009f151a`                        | Coordinated-read preparation referenced from `ITNSDropHostingAdapterView::performDragOperation:` | Not evidence of coordinated tag Save                                 |
| `0x100af6b6b`                        | Similar coordinated-read preparation referenced from `ITNSWindow::performDragOperation:`         | Same limitation                                                      |
| `0x1005b3f74`                        | `ITFileDataHoldingURL` / `artworkDataHoldingURL` path uses coordinated writing                   | Artwork-data URL coordination is not proof of media-tag coordination |

The apparent audio-tag Save's use of `NSFileCoordinator` remains **unestablished**.
Passive filesystem tracing cannot directly prove Objective-C method dispatch,
and no invasive attach or platform-protection bypass was attempted. Apple
[describes file coordination](https://developer.apple.com/library/archive/documentation/FileManagement/Conceptual/FileSystemProgrammingGuide/FileCoordinators/FileCoordinators.html)
as notifications and ordering among participating presenters/accessors. It is
not evidence of mandatory exclusion against arbitrary writers. Apple also
[documents BSD flock as advisory](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/flock.2.html).

## Apple Music versus Rio

Rio's column describes the existing qualified design and its stated threat model,
not newly tested support on `noowners`.

| Property                                                  | Apple Music evidence from this study                                                      | Rio's current contract                                                                           |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Local APFS `noowners` editing                             | Works for tested MP3/AIFF writes                                                          | Publication refused                                                                              |
| No direct authoritative write                             | Not satisfied by tested paths: direct RW/truncate/write                                   | Required; verified candidate first                                                               |
| Crash-safe media publication                              | Tested MP3 growth interruption damages audio                                              | Staged publication, journal, preserved recovery evidence                                         |
| Originally observed file identity remains authoritative   | Same-path replacement accepted in tested dialog                                           | Receipt, path/root/identity revalidation                                                         |
| Same-path behavior                                        | Ordinary saves preserve path; external rename followed                                    | Same-path publication within configured managed environment                                      |
| Symlink/hardlink/substitution resistance                  | Not qualified here                                                                        | Existing native checks; not relaxed                                                              |
| Candidate verification before publication                 | No separate candidate observed                                                            | Required                                                                                         |
| Post-publication verification                             | Reads occur after writes; semantic verification scope unknown                             | Required before DB reconciliation                                                                |
| Durable metadata recovery journal                         | No analogous media-edit journal established; no recovery observed after this interruption | Required                                                                                         |
| Exclusive candidate/rollback authority against other UIDs | No private media stage observed; noowners accepted                                        | Required through ownership-enabled private namespace                                             |
| Permissions/ACL/xattrs                                    | Seeded attributes preserved in successful normal writes                                   | Native eligibility and attribute policy apply independently                                      |
| Coordination/locks                                        | External flock ignored; other fcntl locks exist; audio NSFileCoordinator use unknown      | Rio operation/playback gates plus native checks; hostile same-UID/admin exclusion is not claimed |

## Threat-model distinction and product recommendation

**A — desktop integrity** covers crashes, known stale files, accidental concurrent
changes, incomplete writes, path substitution and recoverable interrupted
publication. **B — unrelated-UID exclusion** prevents a hostile ordinary Unix user
from modifying private candidate/original/rollback material during publication.
A's non-adversarial concurrency assumptions must be explicit: no pathname API can
promise race-free behavior against every uncooperative writer merely by adding
hash checks.

E5 established that APFS exchange, no-overwrite, identity checks and durability
calls worked in both owner modes, while another UID could enter 0700 staging,
open 0600 artifacts and remove an exclusion ACL on `noowners`. Ownership values
there can be caller-projected. The 501/20 values in this study therefore do not
prove exclusive ownership.

Music's apparent practical model is writable user-selected files, cached library
metadata and location resolution, with format-dependent direct updates. This is
an inference from the tested operations, not Apple's published security contract.
It does not supply Rio's stronger integrity guarantees. Calling it universally
“unsafe” would discard that distinction and exceed the evidence.

For a personal desktop music manager, **B should be a separately declared security
property rather than an implicit universal storage requirement**. A hostile
same-account process can already attack user-writable originals and was excluded
by Rio's original model; the prior cross-UID result identifies an additional trust
assumption on noowners storage, not failure of APFS atomic rename itself. This is
a product recommendation requiring explicit acceptance. It does not make hostile
other-user access harmless, does not remove filesystem safeguards, and does not
justify a hidden downgrade for shared or hostile storage.

The common baseline should still reject unknown authority, changed identities,
unsafe paths, symlinks/hardlinks outside policy, ambiguous journals and failed
verification. An uncooperative writer racing final publication must be scoped
honestly; detection/recovery is not an atomic expected-inode compare-and-swap.
Dropbox/provider coordination is a separate unqualified integration question:
these plain local disk-image tests do not qualify concurrent cloud synchronization.

## Architectural options — proposals only

| Option                                                               | Guarantees / losses                                                                                                                                                                                                                                                                                            | Compatibility                                                                                                                                                  | Complexity and recovery                                                                                                                                                                                                          | Linux / Windows consequences                                                                                                                                                                            |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **A. Keep current exclusive staging**                                | Retains current integrity design and unrelated-UID exclusion within its existing assumptions. Loses no current guarantee; leaves common noowners storage uneditable.                                                                                                                                           | Existing qualified ownership-enabled APFS and local ext4 only.                                                                                                 | Lowest change cost; existing journal/rollback model retained.                                                                                                                                                                    | Linux stays on its qualified backend. Windows still needs its own native publication, access-control and durability qualification.                                                                      |
| **B. Staged integrity on trusted noowners storage**                  | Keep verified candidates, same-filesystem atomic publication, identity checks, journal, post-verify and fail-closed ambiguity. Explicitly exclude hostile same-UID **and** unrelated-UID interference; no promise of private stages or trusted rollback under such attack. Do not adopt Music's direct writer. | Potential local writable APFS noowners support only after a new proof; no implied network/exFAT/NTFS/FAT/provider support.                                     | Medium/high: audit every owner/mode/ACL, receipt, journal, cleanup and recovery assumption; qualify the complete state machine. Recovery retains data under the declared trusted-storage model, not arbitrary hostile tampering. | Linux would need equally explicit trust/capability semantics, not a blanket filesystem flag removal. Windows requires an independently proven adapter; this policy does not qualify FAT-family storage. |
| **C. Capability-specific backends, one integrity baseline**          | B's explicitly bounded integrity contract on every supported backend; A's stronger namespace exclusion where it can be established. No silent weakening of crash/identity/recovery behavior.                                                                                                                   | Potential owners-on/off APFS profiles; each must qualify actual mechanics and authority independently.                                                         | Highest policy/testing burden: one coordinator state model, typed capabilities and consistent failure/recovery rules. Report extra exclusion as a separate property, not a different meaning of “saved”.                         | Most useful long-term shape for differing Linux/Windows capabilities; each platform still needs native and packaged qualification. **Recommended direction.**                                           |
| **D. Trusted private recovery vault plus target-volume publication** | Preserve a durable original and journal in independently private storage, then use a verified target-volume candidate and atomic publish. Improves survival of trusted backup evidence; still cannot guarantee exclusive access or race-free cleanup in the shared final namespace.                            | Potential noowners media with a separately trustworthy host/private store. A disk-image file on hostile noowners storage is not automatically such a boundary. | High: cross-volume copying, capacity, library portability, vault availability and recovery mapping. Never use cross-device rename/copy-delete as an atomic-publication substitute.                                               | Requires platform-specific private-store and identity/durability qualification. Linux permissions and Windows access control need separate proofs; private backup is not a portable final-name CAS.     |

## Required proofs before any Rio production change

1. Accept and document the integrity baseline and exact hostile-writer exclusions;
   audit receipt/library DB, staging, rollback, journal and cleanup trust together.
2. Implement a separate experimental capability profile, not a removed mount flag.
   Prove the whole stage → verify → quiesce/revalidate → publish → verify → commit
   → reconcile → cleanup state machine on both owner modes.
3. Run fault/SIGKILL and restart matrices at every journal/publication boundary,
   plus same- and cross-directory identity substitutions, symlink/hardlink attacks,
   unexpected entries, permission changes, stale bytes and missing-volume recovery.
   Unsupported hostile interference must preserve evidence and fail closed.
4. Prove trusted, durable recovery evidence and safe ambiguous cleanup under the
   declared model. Repeated hashes and advisory locks are not replacement evidence
   for the old unrelated-UID exclusion guarantee.
5. Preserve Phase 2B decoder leases and real Phase 2C Track Info/IPC safety. Then
   qualify the packaged coordinator/worker/WASM/native path on disposable noowners
   media, including active/paused playback rejection, ID/path persistence and
   external-source protection.
6. Qualify macOS versions/architectures and distribution separately. Linux/Windows
   designs, M4A/other Music writer paths, physical power loss, mandatory-lock claims,
   helper-process coordination and cloud-provider interoperability remain unknown
   or deferred. Do not extend these findings to them.

## Reproduction and limits

Apple documents the supported
[Option-launch library chooser](https://support.apple.com/en-ca/guide/music/mus7663a920a/mac).
Verify the disposable database with `lsof` **before** importing or editing. Do not
rely on an alternate `HOME` or a library name alone to isolate Music. Use exact
paths and verify the save-panel destination; autocomplete can select a similarly
named backing image.

The research-only [snapshot/poll helper](../../scripts/research/apple-music-publication.mjs)
accepts a root matching `/private/tmp/rio-music-publication-*`:

```sh
node scripts/research/apple-music-publication.mjs snapshot /private/tmp/rio-music-publication-Ex4irY baseline
node scripts/research/apple-music-publication.mjs watch /private/tmp/rio-music-publication-Ex4irY events
```

The auxiliary directory monitor uses 10 ms polling after macOS `fs.watch`
returned `EMFILE`; polling alone cannot rule out shorter-lived files. It is not
a production harness or part of CI. For the 12-second controls the generation parameters were
`-f lavfi -i sine=frequency=440:sample_rate=44100:duration=12`, with
`-c:a libmp3lame` for MP3 or `-c:a pcm_s16be -write_id3v2 1` for AIFF,
plus the Title/Artist/Album recorded in E1. The interruption control used
`duration=3600 -c:a libmp3lame -b:a 64k`. Decoded-audio comparison used
`ffmpeg -v warning -i <fixture> -map 0:a -f md5 -`.

Synthetic file generation used FFmpeg only
as an already-installed local study tool, not a new Rio/CI dependency. E1
records the tested mount paths and all authoritative snapshot labels.

This study made no claim of exhaustive reverse engineering, mandatory exclusion,
physical power-loss safety, all-format Music behavior, or Rio noowners support.
The runtime observations are complete for the cases reported above; further
architectural proof remains a separate mission.
