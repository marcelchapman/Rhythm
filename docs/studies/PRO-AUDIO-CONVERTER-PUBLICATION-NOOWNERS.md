# Pro Audio Converter: FLAC metadata publication on APFS noowners

## Result

**Pro Audio Converter 1.11.1 (307) edited the authoritative FLAC in place**, on
both ownership-enabled APFS and APFS mounted `noowners`. Small tag changes and
metadata growth preserved the inode. Growth shifted existing bytes through the
same read/write descriptor; no separate media candidate or atomic replacement
was observed.

One controlled process termination during a larger metadata expansion damaged
the authoritative file's audio. Restart did not repair it. The app also wrote
cached metadata to an ordinary replacement inode and overwrote external tag
changes without a conflict prompt in the observed UI.

**No new same-path publication strategy was discovered.** This comparator does
not change the Phase 2C architecture conclusion or qualify Rio `noowners`
support. Pro Audio Converter and the previously studied Apple Music paths can
work on `noowners` while accepting weaker integrity properties than Rio requires.
Their behavior is not a recommendation to copy that design.

## Evidence and scope

- **E1:** [environment, full stat/tag observations, assertions, interruption and REA records](evidence/pro-audio-converter-noowners-macos-x64.json).
- **E2:** [save-worker and study-path filesystem trace](evidence/pro-audio-converter-saves.fs-usage.txt.gz).
- Reproduction/observation helper: [pro-audio-publication.mjs](../../scripts/research/pro-audio-publication.mjs).

The study used the normal **Metadata Editor → Actions → Write Metadata** path.
No Encode action or audio conversion was performed in Pro Audio Converter.
Before the first Write Metadata command, the edited queue fields left the file's
SHA-256 unchanged. Successful commands removed their entries from the queue.

Only generated disposable FLACs were edited. The study did not alter Rio
production code, app binaries, security settings, real disk mount configuration,
user music or the Apple Music library. No cross-UID or adversarial experiments
were performed. No Rio build or package was made.

`fs_usage -w -f filesys 66664` passively observed the original app process. The
user authenticated and stopped that trace in Terminal. A 10 ms poller recorded
sibling directory entries and stat changes. `lsof` sampled idle media handles.
These are observations within declared scopes, not exhaustive tracing of every
helper, kernel activity or future app version. No lost-event marker was observed;
that does not establish universal trace completeness.

E2 retains every selected save-worker line, including descriptor-only reads and
writes, plus all lines naming the study root. Unrelated app resource/UI accesses
are omitted. E1 records the selection, raw/retained hashes, operation counts and
all original-PID namespace/barrier matches. Trace clock strings and UTC polling
timestamps are different observations; no exact cross-clock kill latency is
claimed.

## Environment and fixtures

Host: Intel x64 macOS **15.8.1, build 24H32**. Installed app:
`/Applications/Pro Audio Converter.app`, bundle identifier
`com.markvapps.proaudioconverter`, version **1.11.1**, build **307**. REA bound the
installed universal Mach-O; its SHA-256 was
`571978863cd80d6147d4ecab6e6de1d3e4119d16f430302e487e3939ed83ebdc`.
No decompilation or private API investigation was needed.

Two new 512 MiB APFS sparse images were attached beneath
`/private/tmp/rio-pac-publication-xe4Cek`, using `-owners on` and `-owners off`:

| Control / treatment | Device ID | Recorded mount                                 |
| ------------------- | --------- | ---------------------------------------------- |
| Ownership enabled   | 16777235  | `/dev/disk5s1`, local APFS, no `noowners` flag |
| `noowners`          | 16777239  | `/dev/disk7s1`, local APFS, `noowners` present |

Ordinary fixtures came from the existing repository-owned
`playbackFlacFixture`: **30 seconds, 48 kHz, stereo, 16 bit**, constant-subframe
silence with real frame CRCs, STREAMINFO and deterministic tags. Each original
file was **189,364 bytes**, including **189,074 encoded audio bytes**. Initial
Title/Artist/Album/Comment were `Rio disposable original`, `Rio Study Artist`,
`Rio Publication Study`, and `Disposable synthetic FLAC; no user media`.

For the single interruption case, the already-installed FFmpeg **9.0.2** generated
600 seconds of deterministic seeded white noise into a **64,613,876-byte** stereo
16-bit FLAC. This was fixture generation, not conversion through the app or a new
Rio runtime dependency. E1 records the generation parameters and initial hashes.

Snapshots record device/inode, size, mode, UID/GID as presented, links, birthtime,
nanosecond mtime/ctime, ACL/attribute listing, xattrs, parsed tags, encoded-audio
SHA-256 and independently decoded PCM MD5. Long comments are represented exactly
by repetition token/count plus length/hash, rather than repeated large strings.

## Save sequence and file identity

| Save                          | Inode before → after | Bytes before → after | Writes in save worker | Audio result                         |
| ----------------------------- | -------------------- | -------------------- | --------------------- | ------------------------------------ |
| Small edit, ownership enabled | 17 → 17              | 189,364 → 189,364    | 2                     | Encoded and decoded hashes unchanged |
| Small edit, `noowners`        | 17 → 17              | 189,364 → 189,364    | 2                     | Encoded and decoded hashes unchanged |
| Growth, ownership enabled     | 18 → 18              | 189,364 → 197,390    | 28                    | Encoded and decoded hashes unchanged |
| Growth, `noowners`            | 18 → 18              | 189,364 → 202,243    | 33                    | Encoded and decoded hashes unchanged |

Inodes are scoped to their separate devices. The growth comments actually saved
were `PAC-GROWTH-` repeated 359 times on the control and 800 times on `noowners`
(3,949 and 8,800 characters respectively). The observed control text entry was
shorter than initially requested; both exceeded the initial padding. The report
uses actual saved values, not the intended input length.

The small `noowners` save worker, thread **1337793**, performed:

```text
stat64(original pathname)
open(original pathname, read/write) -> fd 3
fstat64; seek/read metadata and file end
lseek(fd 3, 4, SEEK_SET)
write(fd 3, 0x11e bytes)
... seek ...
lseek(fd 3, 4, SEEK_SET)
write(fd 3, 0x11e bytes)
close(fd 3)
```

The ownership-enabled small save showed the same pattern. Growth workers
**1340850** and **1342165** opened the existing path once, read following data,
wrote the larger metadata near offset 4, then repeatedly sought/read/wrote
following regions through that same descriptor. They subsequently rewrote the
metadata region and closed it. There were multiple reads/writes and header
passes, not a single atomic content transition. E2 preserves their exact offsets
and lengths; no internal algorithm or verification guarantee is inferred from
those sequences.

No media temp/staging creation, rename, exchange, unlink, explicit `fsync` or
`F_FULLFSYNC` was observed in the captured save workers. The whole original-PID
trace contained no rename/unlink/exchange/clone/fsync match either; its four
`fcntl` matches were GETPATH/RDADVISE. No sibling recovery/backup artifact appeared
in polling or final directory snapshots. Staging by an unobserved helper or an
uncaptured path cannot be universally excluded, but these saves directly mutated
the authoritative descriptor regardless.

Normal saves retained mode **0644**, presented UID/GID **501/20**, one link and
birthtime; mtime/ctime changed. Loading a file added `com.apple.quarantine`
without changing its audio/tag bytes; the loaded baseline snapshot separates
that xattr/ctime change from the later save. No extended ACL was listed. Presented
ownership on `noowners` is not evidence of exclusive filesystem authority.

The successful normal edits retained encoded-audio SHA-256
`a6e9ca235eaadd57a9ba4794a84291907b666dc7a4c7aa9667a37165f8a57e46`
and decoded PCM `MD5=1b080927679d0b43dbdc8f3e11ec1f8a`. The app also added an
encoded-by tag identifying FLAC/Pro Audio Converter; this tag did not represent
observed audio re-encoding.

Idle `lsof` snapshots found no matching media descriptors while the metadata
editor was open, including after ordinary rename. During Save, the trace shows
the descriptor's acquisition and, for completed saves, close. These finite idle
samples do not exclude short-lived handles. REA evidence IDs in E1 are:
`ev_19408a99958774717650095670f8a6046d5356888bb400d10ec30f3a28a7071a`
(initial mapped files, including bundled TagLib),
`ev_519efe3b4517cbae7b0541aad6e900a4db4207523d99aee35b2c174803b14385`
(idle editor), and
`ev_ab31a4cc381818f083808fc152696af2ce45d27a3da87df02665b49c727cd716`
(renamed idle file). Initial rendered terminal delivery was truncated; its raw
`lsof` frames were complete. A mapped TagLib binary alone does not prove which
save implementation executed.

## Ordinary changes before Write Metadata

Each case loaded its own disposable `noowners` FLAC, prepared a new title in the
editor, changed the file using a benign same-user process, then invoked Write
Metadata. Other source files were not used.

| Change                                                           | Observed result                                                                                                                                                                                  |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rename `Rename.flac` → `Renamed.flac`                            | Save tried the old path; `stat64` returned ENOENT. No new old-path file appeared. Renamed inode 19 retained its original whole-file hash and tags. The app did not follow it.                    |
| Park original inode 20 and create another FLAC at `Replace.flac` | Save opened replacement inode 23 and changed it in place. Its Title became `PAC replacement save`; cached Artist/Album/Comment replaced the external values. Parked original remained unchanged. |
| Rewrite tags externally, retaining inode 21                      | Save did not preserve the ordinary external fields: Title became `PAC cached tags save`; Artist/Album/Comment reverted to cached original values. Audio remained unchanged.                      |
| Remove `Remove.flac`                                             | Save tried the missing path and received ENOENT. The path remained absent; no replacement was created.                                                                                           |

No conflict prompt or persistent error dialog appeared in the captured UI. Each
command cleared its queue entry. Brief notification behavior was not exhaustively
captured; queue removal is not treated as proof of a successful file write.

## One interruption and restart

The larger fixture made a write interval observable without altering the app or
using debugger/instrumentation hooks. A helper checked the exact app command and
process start time, polled the disposable file, rechecked process identity and
sent **one SIGKILL** after its first mtime change. Earlier helper identity checks
refused because `ps` truncated a column; those attempts did not arm or signal.
There was only one interrupted save, with no repeated crash search.

The interrupted worker **1350977** opened the authoritative path read/write,
wrote expanded metadata near the beginning, then partially shifted subsequent
data. Its captured sequence contains **401 writes** and no explicit close before
termination. It had not completed the file rewrite.

| Observation                  | Before                             | After interruption                                                    |
| ---------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Inode / size                 | 24 / 64,613,876 bytes              | Same                                                                  |
| Title                        | `Rio disposable interruption`      | `PAC interruption save`                                               |
| Decoded PCM MD5              | `97067a78eae80a5c05235da8a64c8e4b` | `c67462dc69ce01783ad9448e80c4add6`                                    |
| Decode diagnostics           | None                               | Illegal residual coding method; `decode_frame() failed`; invalid data |
| Encoded-audio SHA-256        | Original recorded in E1            | Different                                                             |
| Sibling backup/recovery file | None observed                      | None observed                                                         |

FFmpeg returned exit status 0 despite the decode diagnostics. The changed PCM
checksum and invalid-frame report, rather than exit status alone or an expected
tag/hash change, establish audio damage.

On normal app restart, the queue was empty and no recovery prompt appeared.
Reopening the disposable file displayed its new title/comment, without repair.
After closing that editor and clearing the queue without Save, its whole-file
SHA-256 was still
`b952ca08588bc7e758862f9e6d4a393dacaf3655f330356d686ee13772a203d3`,
identical to the damaged post-termination file. This is an observed recovery
failure for this case, not proof about every possible recovery mechanism.

## Comparison and interpretation for Rio

| Model / observed path                 | In-place vs staged; inode                             | Candidate verified before authority change?      | Crash / recovery evidence                                                      | Ordinary change detection                                                            | Same path?            | Destructive cleanup                                                 | noowners                                                   |
| ------------------------------------- | ----------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ | --------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------- |
| Pro Audio Converter FLAC              | In-place; inode retained                              | No separate on-disk candidate observed           | One interrupted save damaged audio; restart did not repair                     | Missing path skipped; replacement/cached external tags accepted/overwritten          | Yes for existing path | No media cleanup observed; authoritative bytes overwritten directly | Works in tested cases, weaker integrity                    |
| Apple Music MP3/AIFF study            | In-place; inode retained                              | No separate media candidate observed             | Interrupted MP3 growth damaged audio; no restart repair observed               | Followed rename; accepted replacement and cached-tag overwrite                       | Yes / followed rename | No media cleanup observed; direct mutation                          | Works for tested supported formats; not FLAC qualification |
| Rio ownership-enabled publication     | Separate verified candidate/rollback; exchanged inode | Yes, within qualified contract                   | Existing journal/process-crash qualification; not physical power loss          | Receipts, identity/digest checks and conflict retention under documented assumptions | Yes                   | Private cleanup under ownership-enabled namespace assumptions       | Refused                                                    |
| Rio rejected same-path noowners reuse | Staged exchange plus mutable-name cleanup             | Verification does not bind later cleanup         | Prior abort/commit cleanup counterexample                                      | Final pathname validation insufficient                                               | Intended              | Could unlink an unrelated replacement after final check             | Not qualified; refused                                     |
| Rio Phase 2C.3 new-object model       | New exclusively created generation; new path/inode    | FLAC verified before trusted DB-reference commit | Limited one-edit process-crash model passed; complete architecture unqualified | Tested stale evidence refuses; late external changes remain possible                 | No                    | No automatic media rename/unlink/replacement; retained generations  | Promising research only                                    |

See the [Apple Music evidence](APPLE-MUSIC-PUBLICATION-NOOWNERS.md),
[Rio strong adapter](../NATIVE-PUBLICATION.md),
[failed noowners cleanup gate](../APFS-NOOWNERS-ADAPTER.md), and
[Phase 2C.3 architecture report](../APFS-NOOWNERS-ARCHITECTURE.md).

This study exposes no kernel operation that binds a destructive same-path
publication/cleanup action to an expected previously verified object. It instead
shows direct writes to the currently opened pathname, including a replacement
inode, and provides an interruption counterexample to no-partial-authoritative
write. There is no newly observed staged lifecycle to send to separate Rio
qualification.

The Phase 2C.3 recommendation therefore stands: keep the current `noowners`
refusal; separately consider new media generations plus trusted reference
publication if changed paths and retention are acceptable. Those generations
are not magically immutable on shared writable storage, and the research model
is not a completed production proof. A database/sidecar-only metadata fallback
remains a distinct product choice, not embedded file-tag editing.

All four normal saves, four ordinary-change cases and the one interruption case
passed the report generator's evidence assertions. Production native source and
addon hashes matched the pre-study values. Script syntax, Prettier and whitespace
checks cover the research additions; no production unit/desktop rerun is implied.
The study app was left quit, tracing stopped, and disposable images were detached
and removed after retaining evidence. Results do not establish power-loss safety,
all timing interleavings, hidden helper behavior or other app/platform versions.
