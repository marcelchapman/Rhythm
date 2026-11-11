# FLAC metadata-only fast path — Phase 2E.2

## Decision

Padding-compatible edits can avoid rewriting compressed audio. The disposable
prototype reduced a padded large file's authoritative write from **44,545,101
bytes to 65,888 bytes**, about 676 times fewer bytes. Exact encoded audio,
independent decoder output and Rio's existing verification/recovery behavior were
preserved in the tested cases.

This does **not** establish near-instant Rio saves or a sub-100 ms playback
interruption. With all existing checks retained, the large-file prototype took
3.61–4.00 seconds end to end; its prospective publication tail took 1.76–2.12
seconds. Baseline end-to-end times overlapped it. The physical prefix write and
fsync were below 1 ms, but whole-file reads, hashes, copies and structural
verification remained. Staged publication continued to write full private files.

No production implementation or dependency was changed. The new files are three
isolated research scripts, this report and
[`METADATA-ONLY-FAST-PATH-RESULTS.json`](METADATA-ONLY-FAST-PATH-RESULTS.json).
The JSON contains the 48 measurements, native write counters, worker timings,
fault results and additional qualification results.

## Reference findings

[EasyTAG's FLAC writer](https://github.com/GNOME/easytag/blob/master/src/tags/flac_tag.c)
uses libFLAC's level-2 metadata chain with GIO callbacks. It retains the vendor
string, replaces comment/picture blocks, reconstructs their contents, and sorts
padding. It then checks whether a temporary file is needed. The fitting branch
writes through callbacks to the existing stream; the other branch creates a
temporary GIO stream, asks libFLAC to write it and moves it over the destination
with overwrite enabled. That code does not by itself establish Rio's inode/path
authority, durable journal, atomic exchange or recovery guarantees. It is a
behavioral reference, not a publisher Rio can adopt unchanged.

The [libFLAC chain API](https://xiph.org/flac/api/group__flac__metadata__level2.html)
reads metadata into a manipulable chain. Its write policy can consume or enlarge
trailing padding so that metadata retains its original total size. A new padding
block needs its header as well as any payload. If metadata cannot fit, a complete
rewrite is required. Callback users must use the matching read/write interfaces,
check whether a temporary stream is required and arrange its final publication
themselves. The API explicitly assumes the file is not externally changed
between reading and writing. It supplies neither Rio's concurrency admission nor
its managed-file authority. The
[reference implementation](https://github.com/xiph/flac/blob/master/src/libFLAC/metadata_iterators.c)
separates chain sizing, in-place metadata writing and rewriting through a work
file; audio movement is a fallback cost, not necessary for every tag edit.

The official format page points to [RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html).
Native FLAC starts with its signature and metadata chain, followed by audio
frames. Metadata headers are four bytes, with a last-block flag, block type and
24-bit payload length. STREAMINFO is first and has a 34-byte payload. Padding is
zero-filled and can reserve space for later edits. Vorbis comments have
little-endian string lengths; at most one comment block is permitted. Preserving
the full metadata-region length preserves the first frame's absolute offset.
Seek-table offsets are relative to the first audio frame, not the file start.

No EasyTAG implementation code was copied. Its source header identifies
GPL-2.0-or-later. The [libFLAC library license](https://github.com/xiph/flac/blob/master/COPYING.Xiph)
is BSD-style, requiring notices/disclaimers and restricting endorsement. The
[project licensing page](https://xiph.org/flac/license.html) distinguishes the
libraries from GPL utilities. Bundling a utility is not equivalent to linking
the library. A libFLAC integration would require a separate dependency/build,
notice and platform-qualification decision, including a validated-descriptor
callback adapter; its filename convenience writer would not replace Rio's
authority checks. No libFLAC/EasyTAG binaries or headers were installed. Their
native runtime behavior was not benchmarked: the metadata prototype is a clean
implementation of the documented format, checked with existing Rio validators
and the already installed FFmpeg decoder.

## Current Rio pipeline audit

The request still travels through renderer/preload, main sender/frame/session
and target validation, `saveTrackMetadata`, `playbackUse.usageFor(activeLibrary)`
and `editManagedFlac`. The benchmark begins at the domain coordinator, as Rio's
existing internal qualification harnesses do. It does not measure UI/advisory
eligibility or IPC latency and is not a replacement UI acceptance test.

Representative baseline A: large padded external file, repeat run. Times below
are measured envelopes or explicitly nested worker stages, not additive totals.

| Step                           | Work and scope                                                                                                                 | Exclusive requirement                                                | Measured evidence / guarantee                                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Main eligibility/authority     | ID/session/sender/frame, managed FLAC, settings, operation conflict; advisory eligibility also reads receipt data              | Validation itself can precede quiescence; must be current at handoff | Main/IPC unchanged, not timed in this benchmark                                                                 |
| Managed receipt and identity   | Root/parent/leaf checks, full-file digests twice through the current helper, final path/stat checks                            | Original read-only checks can prepare; repeat at publication         | 251 ms preflight envelope; binds managed-copy authority, not just filename                                      |
| Capability selection           | Native local writable APFS qualification; staged mode additionally probes private publication capabilities                     | No authoritative mutation                                            | 0.29 ms on in-place path; strong probes include durable private workspace activity                              |
| Source image and journal proof | Bounded no-follow read, before/after identity, full-image SHA and another source journal SHA                                   | Read-only; current coordinator nevertheless already holds idle       | Source read/hash 168 ms, journal hash 113 ms                                                                    |
| FLAC parsing                   | Full original frame/metadata validation                                                                                        | Read-only preparation                                                | Worker source parse 268 ms; rejects bad/truncated structure and CRCs                                            |
| Candidate construction         | Qualified TagLib/WASM engine receives complete buffers and returns a complete image                                            | Can prepare while playing under the Phase 2E.1 design                | 399 ms candidate-render stage; includes full-buffer engine work                                                 |
| Candidate integrity            | Full candidate frame parse, exact encoded-audio comparison, protected blocks, independent metadata reader, proof hashes/copies | Preparation; no authoritative write                                  | Candidate parse 416 ms, audio comparison 14 ms, proof-hash/copy stage 509 ms; entire prepare round trip 1988 ms |
| Journal insert                 | Durable original identity/digest, intended patch and phase                                                                     | Before mutation; operation must remain lifecycle-tracked             | 0.69 ms; full journal retained                                                                                  |
| Native publication             | Whole-image in-place write plus fsync/full reread, or qualified private staging/exchange/durability                            | Requires reserved admission, drained sources and idle use            | In-place JS/native envelope 238 ms; native own write 65 ms and fsync 19 ms in this run                          |
| Post-write proof               | Full authoritative reread/hash and a worker repeating frame/metadata/audio verification                                        | Remains exclusive in existing contract                               | 1203 ms; worker frame parse 440 ms and proof hashes 303 ms are nested                                           |
| DB and reconciliation          | Transaction updates metadata/receipt; full-file receipt checks run again                                                       | Remains exclusive until verified readable catalog/receipt            | DB commit 1.92 ms, reconciliation 229 ms                                                                        |
| Admission release              | Close publication lease, unlock operation, release idle lease                                                                  | Last step                                                            | 0.087 ms; actual idle lease covered nearly the entire 4561 ms save                                              |

Several expenses enforce different boundaries. Source receipt hashing authorizes
the managed file; candidate checks certify the proposed image; native comparisons
bind the write to the opened object; post-readback checks independently establish
what reached the authoritative path. A cheap metadata parser cannot substitute
for all of them. The staged path additionally constructs, verifies and later
cleans independently identified candidate/rollback files. Those costs remain even
when metadata construction itself is fast.

Potential consolidation deserves proof, not deletion of checks: the current
managed-location helper computes a digest that the receipt helper recomputes;
structural parsing is repeated after an already validated candidate is established
as the exact published image. Neither was removed in this study.

## Strategies and experimental boundaries

- **A — baseline:** byte-identical copies of the compiled coordinator and writer.
  The native copy only adds successful write-byte counters. Mutation, verification,
  durability, journal, receipt and gate behavior are unchanged.
- **B — metadata candidate:** a temporary writer copy substitutes metadata-region
  assembly for the WASM rendering call. Existing patch planning/validation,
  source/candidate frame parsing, exact audio equality, independent metadata
  readback, protected-block checks and hashes remain unchanged. The pure planner
  reads no audio. Integration still materializes a full candidate for the existing
  API, so it still copies the audio in memory.
- **C — prefix publication:** B plus a disposable native copy. For equal file
  size and identical first-frame offset, it requires exact audio-suffix equality,
  then limits pwrite to the metadata prefix and avoids a no-op truncation. The
  original source comparison, ancestry/path/identity checks, local-APFS policy,
  fsync, full authoritative reread and complete candidate comparison remain.
  Native changes are confined to temporary files compiled into temporary addons.
- **D — insufficient-space fallback:** B creates a full candidate with reserve
  padding when growth cannot fit. C falls back to the original full-image writer.
  On ownership-enabled APFS, publication always uses the existing private
  staged/exchange path, including for fitting edits. It is never converted into
  direct in-place mutation. On external `noowners`, an unqualified temporary-file
  overwrite/rename is not introduced; fallback retains the existing pragmatic
  full-image in-place strategy and its crash limitations.

The planner modifies only comments and trailing padding. It preserves vendor,
STREAMINFO, existing picture bodies, opaque APPLICATION bodies, unknown comment
fields and all other supported block bodies/order. It uses only trailing padding;
it does not consolidate distributed padding or support a missing comment block.
Reserved block types remain unsupported, matching current Rio. Such cases need
the existing writer/fallback, not automatic broadening of support.

## Benchmark setup and results

Four original fixtures combine small/large audio with zero or 65,536 bytes of
trailing padding. All include existing PNG artwork, an unrecognized APPLICATION
payload and a Unicode custom comment. Small input sizes are 189,458 / 254,998
bytes; large sizes are 44,479,561 / 44,545,101 bytes. Large audio is the existing
independently generated 180-second Phase 2D comparison fixture. The timed edit
grows Genre from `Original` to 400 characters. All accepted outputs retained exact
encoded audio and matched independent FFmpeg decoded-PCM hashes.

The 48-run matrix uses identical fresh managed copies for each variant and each
first/repeat pair, in one source Electron runtime. There is no OS cache flush.
“First/repeat” is not a claim of cold disk caches or a repeat on an already
modified/padded file. Variant ordering is fixed; two samples do not establish a
statistically robust end-to-end improvement. Sequential edits are tested
separately. Import/setup and independent decoder auditing are outside save timing.
True cold-storage/cache measurements were not obtained: validation/import already
reads the fixtures, and no system-wide cache flushing was performed. Every Save
still creates its normal fresh worker; worker startup is included in its timing.

Padded fixtures, milliseconds; each entry is first / repeat:

| Storage / fixture         | Variant | Full coordinator save / actual idle interval | Prospective publication tail |
| ------------------------- | ------- | -------------------------------------------: | ---------------------------: |
| Staged / small            | A       |                                    858 / 786 |                    245 / 241 |
|                           | B       |                                    787 / 763 |                    270 / 254 |
|                           | C       |                                    892 / 842 |                    382 / 337 |
| External in-place / small | A       |                                    268 / 268 |                    108 / 108 |
|                           | B       |                                    234 / 227 |                    115 / 111 |
|                           | C       |                                    248 / 224 |                    117 / 111 |
| Staged / large            | A       |                                  8980 / 7967 |                  3915 / 3593 |
|                           | B       |                                  8383 / 8646 |                  3394 / 3766 |
|                           | C       |                                  8307 / 7397 |                  3898 / 3248 |
| External in-place / large | A       |                                  3836 / 4561 |                  1880 / 1926 |
|                           | B       |                                  4150 / 4044 |                  2106 / 2025 |
|                           | C       |                                  3997 / 3605 |                  2124 / 1763 |

The coordinator's idle lease was **not moved** in this experiment. Actual
exclusivity therefore covers essentially the full save. The prospective tail is
revalidation-start through lease release: a measured component estimate for a
future Phase 2E.1-style handoff, not newly measured playback interruption. It
excludes decoder release/reopening and must not be labeled an achieved pause time.

Insufficient-padding growth falls back; full save milliseconds first / repeat:

| Storage / fixture         |           A |           B |           C | Successful native file-write bytes, all variants |
| ------------------------- | ----------: | ----------: | ----------: | -----------------------------------------------: |
| Staged / small            |  1033 / 886 |  983 / 1476 |   766 / 752 |                                          383,408 |
| External in-place / small |   261 / 281 |   226 / 220 |   225 / 220 |                                          193,950 |
| Staged / large            | 7552 / 7551 | 8626 / 8038 | 7953 / 8250 |                                       88,963,614 |
| External in-place / large | 4282 / 4102 | 4850 / 4320 | 3643 / 3882 |                                       44,484,053 |

Padded large external comparison:

| Metric                                               |                               A |               B |                C |
| ---------------------------------------------------- | ------------------------------: | --------------: | ---------------: |
| Metadata-only read / plan, typical                   | 1.4–2.3 / 1.4–1.6 ms diagnostic | same diagnostic |  same diagnostic |
| Candidate-render worker stage                        |                    233 / 399 ms |     91 / 112 ms |      123 / 97 ms |
| Combined frame parsing across save                   |                   949 / 1124 ms |   978 / 1136 ms |    1093 / 968 ms |
| Native file bytes actually written                   |                      44,545,101 |      44,545,101 |           65,888 |
| Native pwrite duration                               |                  64.6 / 64.6 ms |  62.4 / 63.2 ms | 0.029 / 0.031 ms |
| Native fsync                                         |                  18.3 / 18.9 ms |  18.3 / 18.9 ms |   0.69 / 0.40 ms |
| Native callback envelope, including full comparisons |                    188 / 187 ms |    240 / 190 ms |      114 / 88 ms |
| Complete JS/native publication envelope              |                    241 / 238 ms |    309 / 248 ms |     192 / 140 ms |
| Post-write reread/verification                       |                  1179 / 1203 ms |  1193 / 1323 ms |   1425 / 1164 ms |

These are nested stages, not numbers to add. The pure metadata planner processes
zero frame bytes, but B/C's retained verification still parses/hashes/copies
frames. Native counters count successful POSIX write/pwrite byte returns, not
physical APFS/device write amplification. They exclude SQLite journal writes,
whose measured transaction/reconciliation timing is separately recorded.

Staged padded-large A/B/C all wrote **89,090,202 bytes** to candidate and rollback
files. C obtains no prefix-write benefit there. Small padded A reduced its
candidate metadata region, producing 448,948 staged write bytes versus B/C's
509,996. Different resulting padding is recorded, not disguised as identical
physical work. The original writer's geometry check found that its padded-large
candidate is prefix-eligible, while the measured small padded candidate moves the
audio start from 65,924 to 4,876. A future prefix publisher must check actual
candidate geometry, never merely the presence of input padding.

### External-storage qualification limitation

Initial runs inside the project tree on the real external volume sometimes
failed before publication. Captured fingerprints differed only in `ctimeNs`;
content, device/inode, size, links, mode, uid/gid and mtime remained unchanged.
Four refusals occurred in one 12-case exploratory run across A/B/C. They were
not successful saves and were not retried or included in timing averages.
No responsible process was identified; this does not prove Dropbox, indexing or
APFS itself caused the changes.

The controlled 48-run matrix used a disposable directory at the root of the
**same physical external APFS volume**, outside the project tree. It had zero
refusals. No ownership/mount flags or synchronization settings were changed.
The check must remain fail-closed in production; this study does not repair or
relax it.

## Integrity and crash/recovery findings

Bounds establish what **this writer is allowed to modify**. They do not
independently establish that some other actor, storage failure or erroneous code
did not change audio bytes. Same inode/size and a valid metadata prefix are not
audio-integrity proof. The native prototype therefore retains full source and
result comparisons, and the coordinator retains its independent full-file
hashing/FLAC checks. Existing whole-file receipt digests remain unchanged in
meaning; no metadata-only receipt replaces destructive managed-file authority.

Four malformed/truncated metadata inputs were refused; four 1–4-byte padding
header boundary cases were checked. The candidate prototype passed all 13
existing fields with explicit clearing through Rio's **original** verifier, and
the retained parser rejected truncated/corrupted frame inputs. Both storage
strategies passed five serial growth/shrink/clear/repeat edits with stable audio
offset and exact audio, plus a no-op preserving file bytes and mtime.

Nine fault scenarios used disposable data and the original coordinator/writer
for reopening/recovery:

| Boundary                                                     | Observed result                                                                                                                                                                        |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Before publication, both strategies                          | Original retained; staged private artifacts cleaned through existing recovery; no pending journal afterward                                                                            |
| During prefix writing                                        | Audio suffix unchanged; torn metadata detected; existing in-place recovery marks the track missing and requires Locate File; no automatic unsafe rollback                              |
| After prefix write, before native reread verification        | Write failure surfaced; exact complete candidate reconciled forward using retained full verification                                                                                   |
| Immediately after staged atomic exchange, before observation | Existing journal/layout inspection reconciled the complete candidate forward                                                                                                           |
| After publication, before reconciliation, both strategies    | Original startup recovery adopted only the verified candidate; pending journal cleared                                                                                                 |
| Source changes at publication boundary, both strategies      | Receipt validation refused publication; injected disposable change retained. Staged recovery preserved unresolved evidence; in-place recovery marked missing under its existing policy |

The last case changed a byte in a disposable audio suffix, modeling a concurrent
modification. No timestamp restoration, unrelated-UID activity or adversarial
technique was used. A native prefix write did not bypass the receipt check.
These are process/error-boundary tests, not physical power-loss qualification.
In-place writes remain non-atomic. Limiting damage to metadata does not guarantee
that a partially rewritten FLAC header is playable or automatically repairable.

A separate real source-app playback test committed C's output, injected a
playback-acquisition failure, confirmed source release and retained published
metadata, then successfully retried through the real renderer/preload/main/
protocol/decoder. It did not change token authorization or permit active decoder
reads during mutation. Continuous playback handoff and a new interruption time
for C were **not** qualified; Phase 2E.1 remains the measured transport reference.

## Smallest justified next step

A separately qualified **prefix-limited native publication optimization** can
reuse an already qualified original-writer candidate when size, audio offset and
exact suffix equality permit it. This needs no new metadata engine or dependency.
All other candidates retain existing publication. It is justified as reduced
write amplification; this dataset does not establish a consistent end-to-end
latency improvement, and the disposable native extension is not production-ready.
Existing native path/identity qualification must be rerun before integration.

Achieving the latency target requires a further verification decision, not just
padding. An explicit equivalence candidate is: a fully validated candidate C and
an independently read authoritative image R with exact byte/hash equality imply
that parsing R again yields C's already certified structure/metadata. Reusing a
certificate could avoid duplicate structural parsing while **retaining independent
post-publication whole-image verification**, file identity, admission and journal
checks. Ownership of the immutable bytes, proof binding, failures and recovery
would need separate implementation and qualification. No parser or integrity
check was skipped to benchmark that hypothesis here; its performance is unmeasured.

A prefix-only reread with inode/mtime checks would instead narrow the threat
model and lose the existing independent audio-integrity evidence. That is not
recommended as a drop-in replacement. Nor can an old whole-file SHA alone
establish the new file's full digest after changing its prefix.

For playback, retain Phase 2E.1's reservation-before-await, real reader drainage,
idle lease, handoff revalidation and command-revision/session checks. Unchanged
audio offset does not make a live decoder's metadata/seek reads safe during a
prefix rewrite. With the tested complete verification pipeline, the under-100 ms
interruption objective is **not met**, including for the small publication tail.
Defer publication until natural source release if a multi-second large-file
interruption is unacceptable.

## Reproduction and checks

Set `RIO_DISPOSABLE_FLAC` to an existing disposable FLAC and `RIO_EXTERNAL_PARENT`
to a writable test directory on the external APFS volume.

```sh
node scripts/research/metadata-only-fast-path.mjs --large "$RIO_DISPOSABLE_FLAC" --external-parent "$RIO_EXTERNAL_PARENT"
node scripts/research/metadata-only-fast-path.mjs --qualification-only --large "$RIO_DISPOSABLE_FLAC" --external-parent "$RIO_EXTERNAL_PARENT"
```

Without `--large`, the script generates self-contained small FLACs. Independent
decoder auditing uses the already installed FFmpeg; the script does not install
it. `--quick` runs one matrix sample rather than a first/repeat pair. The supplied
large file is only read, then copied into synthetic fixtures. Existing Node-API
headers/compiler build temporary addons; existing npm packages are referenced by
temporary links, without modifying dependencies or the production build.

The 48-save matrix, 13-field compatibility/clearing, repeated-edit/no-op checks,
nine recovery faults and real reacquisition failure/retry passed. **168 existing
focused tests** covering FLAC parsing, metadata writer/coordinator and playback
source/use passed. Syntax, Prettier and whitespace checks passed. No production
package was created. Existing Phase 2D/2E.1 files were preserved; test-created
libraries/profiles/native copies were removed.
