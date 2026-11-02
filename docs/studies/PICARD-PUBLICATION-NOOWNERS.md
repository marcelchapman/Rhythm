# MusicBrainz Picard FLAC publication study

Research-only result, 2026-11-01. The final instruction narrowed the mission to
finishing the source/runtime investigation and stopping once the question of a
new publication strategy was answered. No Rio production code or package changed.

## Conclusion

**Picard exposes no new publication or audio-recovery strategy in the audited
FLAC Save path.** It delegates to Mutagen, which rewrites the existing file in
place. It does not first prepare a complete verified audio candidate, preserve
an independent audio backup, or perform an atomic replacement/exchange.

**Source audit is complete; runtime Save qualification is blocked.** Both the
installed Picard 3.0.2 and the official current 3.0.4 exited with SIGSEGV during
accessibility-driven metadata editing, before the Save action was reached.
All twelve disposable FLACs retained their original bytes, encoded-audio hashes
and decoded PCM checksums. These were UI crashes, not interrupted metadata-save
tests. Do not interpret unchanged files as evidence of crash-safe publication.

The supported command interface was checked for a narrow alternative. Its
save-matched/save-modified handlers concern album/matched items; it supplies no
general tag-edit/save command for this unmatched-file test. No matching/network
work, custom plugin, direct-writer substitute or further crash attempts were
added. The latest instruction's stop boundary was respected.

Evidence: [machine-readable source, version, crash and file observations](evidence/picard-noowners-macos-x64.json).
Observation helper: [picard-publication.mjs](../../scripts/research/picard-publication.mjs).

## Versions and provenance

| Component                | Audited / observed identity                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Installed app            | Picard 3.0.2, Python 3.14.7, Mutagen 1.48.1; installed executable SHA-256 `4c2d8a0cbf743e26ac25756594f271b9d16d9a86bed8908e6c201587e408ff47` |
| Current official release | Picard 3.0.4, released 2026-11-01; source revision `b4cfdb02dbe808e7ac73a34760aaf382e8d837f6`                                                |
| Runtime 3.0.4            | Official Intel DMG, Python 3.14.10, Mutagen 1.48.1; executable SHA-256 `88113c85e519ed031b0e076f0afee2759003d898c4a924a9edb85aff66ebcb83`    |
| Matching 3.0.2 source    | Revision `02fece92db40acf236722f76e4a9234d5562f9d4`                                                                                          |
| Decisive dependency      | Mutagen 1.48.1, source revision `452190d42ab2092577c77342d49157f8768d796f`                                                                   |

Source came from the projects' official release archives. Evidence records their
SHA-256, archive commit identifiers and audited file hashes. Picard 3.0.2 and
3.0.4 have identical source text for `File.save`, `File._save_and_rename` and
`VCommentFile._save`; the dependency version matches both runtime version probes.
This is source/version correlation, not byte-for-byte reconstruction of the
frozen Python modules.

The 3.0.4 DMG's SHA-256 matched the official release API's asset digest:
`3ead7559abaf78b4a3f10205de0f1b0f497d307ccb99cc32b6e136016ebfa809`.
It was mounted read-only and launched in place, without replacing the installed
app. A separate `codesign --verify --deep --strict` check reported an invalid
signature. That limitation is retained; the app launched normally, and no
resigning, quarantine removal or security bypass was performed. The release
notes list a macOS focus-switch crash fix; they do not establish the cause of
either observed accessibility crash. See the [official 3.0.4 release](https://github.com/metabrainz/picard/releases/tag/release-3.0.4).

REA version-probe evidence, retained in the JSON:
`ev_e736ddb727586c1f6962c4da534ec51221b193e7bda0feda296cbe5370097ada`
(3.0.2), and
`ev_4cf76cbc6504590c966ed2fc46215ee6c00dee2250e7b09f793672aadf8e7d0a`
(3.0.4). Both version commands exited successfully. No binary patching or private
runtime instrumentation was used.

## Exact source call chain

Links are pinned to the audited commits; line numbers refer to those files.

| Boundary               | File / function                                                                                                                                                                  | Effect                                                                                                                                    |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| User-visible Save      | [`ui/mainwindow/actions.py:184`](https://github.com/metabrainz/picard/blob/b4cfdb02dbe808e7ac73a34760aaf382e8d837f6/picard/ui/mainwindow/actions.py#L184), `_create_save_action` | Connects the action to the window's Save handler                                                                                          |
| Selection/confirmation | [`ui/mainwindow/__init__.py:1447`](https://github.com/metabrainz/picard/blob/b4cfdb02dbe808e7ac73a34760aaf382e8d837f6/picard/ui/mainwindow/__init__.py#L1447), `MainWindow.save` | Optional save-warning dialog, then passes selected objects to the tagger                                                                  |
| Dispatch               | [`tagger.py:1174`](https://github.com/metabrainz/picard/blob/b4cfdb02dbe808e7ac73a34760aaf382e8d837f6/picard/tagger.py#L1174), `Tagger.save`                                     | Iterates selected files and invokes their Save method                                                                                     |
| Work scheduling        | [`file.py:474`](https://github.com/metabrainz/picard/blob/b4cfdb02dbe808e7ac73a34760aaf382e8d837f6/picard/file.py#L474), `File.save`                                             | Marks pending, copies metadata, runs pre-save processors and schedules `_save_and_rename` in the save thread pool                         |
| File operation         | [`file.py:547`](https://github.com/metabrainz/picard/blob/b4cfdb02dbe808e7ac73a34760aaf382e8d837f6/picard/file.py#L547), `File._save_and_rename`                                 | Diagnostic file-change check, format save, then optional rename/move/extra-file operations                                                |
| FLAC handler           | [`formats/vorbis.py:459`](https://github.com/metabrainz/picard/blob/b4cfdb02dbe808e7ac73a34760aaf382e8d837f6/picard/formats/vorbis.py#L459), `FLACFile(VCommentFile)`            | Chooses `mutagen.flac.FLAC`                                                                                                               |
| Tag construction       | [`formats/vorbis.py:282`](https://github.com/metabrainz/picard/blob/b4cfdb02dbe808e7ac73a34760aaf382e8d837f6/picard/formats/vorbis.py#L282), `VCommentFile._save`                | Loads the current pathname with Mutagen, updates mapped tags/deletions and calls `file.save`; optional FLAC/ID3 settings apply here       |
| Writable open          | [Mutagen `_util.py:203`](https://github.com/quodlibet/mutagen/blob/452190d42ab2092577c77342d49157f8768d796f/mutagen/_util.py#L203), `_openfile` via `loadfile(writable=True)`    | Opens the remembered pathname read/write using `rb+`; holds that file object for the save context                                         |
| FLAC serialization     | [Mutagen `flac.py:839`](https://github.com/quodlibet/mutagen/blob/452190d42ab2092577c77342d49157f8768d796f/mutagen/flac.py#L839), `FLAC.save` → `_save`                          | Renders metadata/padding, resizes the metadata region, writes marker and blocks into the same file                                        |
| Completion/error       | Picard `file.py:620`, `File._saving_finished`                                                                                                                                    | Updates displayed/original metadata and diagnostic identity on success; marks errors on failure. It does not restore original audio bytes |

Loading the Mutagen object and saving it are separate pathname opens. There is
no retained descriptor from Picard's initial UI load through eventual Save.
Within the Mutagen save, region resizing and metadata writes use the same opened
file object. The name is not deliberately replaced to preserve identity; inode
preservation follows from the in-place write algorithm when rename/move is OFF.

## Decisive writer and filesystem semantics

Mutagen's `_save` finds the audio offset, calculates the existing metadata space,
serializes new blocks/padding in memory, then calls `resize_bytes` on the original
writable object. It writes the FLAC marker and serialized blocks afterward. This
is metadata preparation in memory, not a separately verified whole-file
publication candidate. See [the exact implementation](https://github.com/quodlibet/mutagen/blob/452190d42ab2092577c77342d49157f8768d796f/mutagen/flac.py#L861).

The [region helpers](https://github.com/quodlibet/mutagen/blob/452190d42ab2092577c77342d49157f8768d796f/mutagen/_util.py#L686)
grow the same file with zero bytes and shift following data backward when making
space. Shrinking shifts data forward before truncating. Movement uses repeated
reads/writes in bounded buffers. If no resize is needed, the metadata write still
targets the original object. Ordinary buffering flushes are present; no explicit
`fsync`, `F_FULLFSYNC`, APFS clone or exchange occurs in this audited path.

There is no independent original-audio copy or durable audio rollback journal.
An ENOSPC handler during expansion attempts to truncate to the old size, but does
not provide rollback for arbitrary failures after byte movement. Optional ID3
removal can also truncate the same file. These details do not establish atomic
whole-file mutation or crash recovery.

The inspected source provides no APFS-specific publication branch. Windows adds
player-release and permission-error retry handling in Picard. An unsupported
read/write-open fallback in Mutagen can buffer a file and write it back by
pathname on some other filesystems; it is not a safe staged replacement and was
not exercised here. No additional filesystem support follows from this study.

Picard's optional naming/moving operations happen **after** tag writing. Its
case-handling move helper can use an intermediate pathname; that is organization,
not an audio backup prepared before mutation. Timestamp preservation stores and
restores stat times, not content. The session-backup option saves workspace and
metadata state, not an independent copy of the old FLAC audio. Plugins can change
behavior; they were disabled and are outside this core-path conclusion.

## Ordinary external changes: source expectations only

`FileIdentity` records inode/size/mtime and a diagnostic hash of the first 8 KiB.
`_save_and_rename` logs changed/missing identity but continues. An identity-check
error is explicitly nonfatal. This is not a mandatory expected-object capability.

| Change before Save                 | Consequence of audited path; not runtime-qualified here                                                                                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Rename away                        | The old pathname remains the Save argument. Missing-open error is expected; no rename-following guarantee established                                                                      |
| Replacement inode at the same name | Diagnostic warning can be logged, but the replacement is opened for tag writing rather than refused                                                                                        |
| External tag change                | Picard's cached mapped fields can overwrite externally changed fields when applied to the freshly loaded Mutagen object; exact preservation depends on clear/preserve/deleted-tag settings |
| Remove target                      | Missing path is logged; ordinary FLAC Save does not request file creation, so a load/open error is expected                                                                                |

No before-Save concurrent-change experiments were run after the runtime blocker.
No unrelated data was substituted or changed to test these expectations.

## Disposable runtime evidence and limitation

The existing study images were reused: local APFS with ownership enabled and
local APFS with `noowners`, under `/private/tmp/rio-picard-publication-MEZDB2`.
Both had six repository-generated 30-second, 48 kHz stereo 16-bit FLACs, each
189,364 bytes. The configuration disabled renaming/moving, directory cleanup,
external image writing, update checks, plugins and playback. No lookup, matching,
fingerprinting or network identification action was invoked.

Picard 3.0.2 and 3.0.4 each loaded the disposable `off/Media/Baseline.flac` and
failed during GUI editing before Save. Their observed exit status was 139;
retained OS crash excerpts show SIGSEGV/EXC_BAD_ACCESS with accessibility frames.
The precise UI-crash cause was not investigated further. This is not evidence
that the filesystem writer itself failed, nor a reason to alter Rio.

Cleanup found a bare process from the temporary 3.0.4 executable after the UI
failure, consistent with an automatic UI-tool relaunch. It had no study-config
arguments and was stopped without requesting Save. Full isolation of that
relaunch is not claimed; no real music was deliberately loaded or edited.

Machine-readable before/after measurements include all requested stat fields,
ACL/xattrs, tags and both audio digests. All twelve files matched their original
whole-file SHA-256, encoded audio and decoded PCM afterward. The silence fixture's
decoded MD5 was `1b080927679d0b43dbdc8f3e11ec1f8a`; no decode warnings occurred.
The before/after inode values therefore describe **unwritten fixtures**, not a
successful Save result.

No successful save, during-write interruption, restart repair or concurrent-change
result is claimed. Privileged syscall tracing was not obtained. Picard's public
`--audit` logging was enabled for 3.0.4, but logging configuration does not replace
execution of the missing Save. Absence of a temp file in these unchanged fixtures
cannot qualify the writer's runtime behavior.

## Comparison

| Subject                          | Publication / inode                                          | Verified candidate / same path                                   | Crash / recovery                                                                                             | Concurrent changes / cleanup                                                                 | noowners / portability                                               |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Picard source-intended FLAC Save | In-place; no replacement inode intended with naming OFF      | Memory-rendered metadata, no complete media candidate; same path | No audio rollback mechanism in audited path; partial-write exposure follows from multiple in-place mutations | Diagnostic checks do not abort; no media cleanup needed in tag-only path                     | No APFS-specific branch; Windows release/retry differences           |
| Picard observed 3.0.4            | Loaded fixture; **Save not reached**                         | Unqualified                                                      | GUI crash before Save; not a write-interruption test                                                         | Not executed                                                                                 | Disposable APFS setup recorded; save compatibility not qualified     |
| Apple Music MP3/AIFF             | Observed in-place; inode retained                            | No media candidate observed; same path                           | Interrupted MP3 save damaged audio; no restart repair observed                                               | Followed rename; accepted replacement/cached overwrite; direct mutation                      | Tested noowners compatibility for supported formats, not FLAC        |
| Pro Audio Converter FLAC         | Observed in-place; inode retained                            | No media candidate observed; same path                           | One interrupted save damaged audio; no restart repair                                                        | Missing old paths skipped; replacement/cached fields overwritten; no media cleanup observed  | Tested both APFS modes                                               |
| Rio current qualified publisher  | Verified staging/rollback, exchange; new authoritative inode | Separate verified candidate; same path                           | Existing journal/process-crash qualification within declared envelope                                        | Identity/digest/receipt checks and conflict retention; qualified private cleanup assumptions | Ownership-enabled APFS; separate Linux adapter, no new Windows claim |
| Rio rejected noowners reuse      | Staged same-path exchange plus cleanup                       | Candidate verification did not authorize later unlink            | Abort/commit cleanup counterexample                                                                          | Mutable-name cleanup could delete unrelated replacement                                      | Not qualified; remains refused                                       |
| Rio generation research          | New object plus trusted catalog reference                    | Verified FLAC before logical switch; changed path                | Limited one-edit crash model passed; complete architecture/GC unqualified                                    | Retains artifacts; no destructive media cleanup                                              | Promising logical model, with storage/control-state/platform gates   |

The earlier [Music](APPLE-MUSIC-PUBLICATION-NOOWNERS.md),
[converter](PRO-AUDIO-CONVERTER-PUBLICATION-NOOWNERS.md),
[native](../NATIVE-PUBLICATION.md), [cleanup](../APFS-NOOWNERS-ADAPTER.md) and
[generation](../MANAGED-MEDIA-GENERATIONS.md) reports remain the evidence for
those rows. Picard's source is further evidence of an in-place design choice,
not an additional observed damaged-save result.

## Decision for Rio and possible Phase 2C.4

No new primitive, safe replacement lifecycle, audio backup-before-mutation or
recovery method was found. **Phase 2C conclusions remain unchanged.** Rio must
not adopt in-place writing on the strength of this audit, and `noowners` support
is not newly qualified.

Clone-backed research remains worth a **separate bounded investigation** if its
question is whether independently durable old bytes, explicit authority and
recovery can meet Rio's baseline at lower copying cost. Picard provides no
clone-backed precedent or proof. A clone alone does not authorize destructive
pathname rollback/cleanup, exclude external changes, or prevent partial writes
to an authoritative object. If the proposed design is only “backup, then mutate
the current authority,” it fails Rio's existing requirement and should stop at
that gate. No Phase 2C.4 experiment was started here.

Research validation: all twelve fixture byte/audio preservation checks passed;
three critical source-function comparisons matched; the official DMG digest
matched; Rio native source and binary hashes remained unchanged. Formatting and
whitespace checks cover the added report, evidence and helper. Runtime Save
qualification remains explicitly blocked. Disposable mounts/fixtures were removed
after preserving evidence; the installed Picard app was not replaced.
