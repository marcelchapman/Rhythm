# Large managed FLAC support — Phase 2E.6

Rio's supported input and verified candidate ceiling is **128 MiB (134,217,728
bytes)**. Managed FLAC, Keep Organized OFF, valid receipts, qualified filesystem
publication and reliable playback ownership remain mandatory. With
`RIO_STABLE_PLAYBACK_SOURCES=1`, verified APFS sources allow active/paused editing.
Original-file playback continues to exclude metadata editing. Referenced files and
other formats remain read-only.

## Why the former track failed

The 72,274,079-byte (68.93 MiB), 607.827-second track was structurally valid,
independently decodable and correctly receipted. The former experimental 64 MiB
budget selected original-file playback. The playback gate then correctly blocked
editing; the publisher/writer also refused the file after playback released it.
The original was opened read-only. All mutations in qualification use independent
copies with new managed-library receipts, profiles and libraries.

## Limit audit and rationale

| Boundary                                                        | Current limit / rationale                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Main playback selection, manager, clone worker and native clone | 128 MiB per file; resource policy, not an APFS/FLAC format constraint. Known oversize tracks retain original-file playback. An attempted capture that fails never falls back silently. Physical size is checked again in the worker/native descriptor path.                                                                                                                                        |
| Source lifetime                                                 | Two sources, at most 256 MiB logical source bytes. Eight readers per source and 256 KiB reads/backpressure remain unchanged. Clones are same-volume, unlinked while retained by descriptors, and drained/released on revocation. Logical bytes are not unique physical APFS allocation.                                                                                                            |
| Metadata coordinator                                            | Actual descriptor size is bounded before allocating a full-file buffer. Aggregate admitted original bytes are at most 256 MiB per main process, reserved for the entire edit lifetime, including publication/reconciliation. Busy admission is refused, not queued. This preserves the former four-times-64-MiB aggregate input envelope while admitting larger individual edits.                  |
| Writer                                                          | Input/candidate at most 128 MiB; aggregate pending original bytes at most 256 MiB in each writer process; at most four calls. TagLib remains serialized. Candidate growth past the ceiling fails before authoritative publication.                                                                                                                                                                 |
| Worker                                                          | Four-worker ceiling, 384 MiB old-generation/32 MiB young-generation V8 heaps and 30-second worker timeout remain unchanged. ArrayBuffer, WASM and native memory are additional to V8 heap limits; these are not hard RSS limits. Live coordinator admission bounds concurrent input exposure.                                                                                                      |
| Native publication                                              | 128 MiB original/candidate bounds before native full-file allocations; retained descriptor, exact identities, single-link regular-file checks, root/parent bindings and all durability/recovery checks remain. Native compiler flags import the same TypeScript byte policy and participate in build fingerprints. Unconfigured historical research builds retain the former 64 MiB fallback.      |
| Parser and metadata                                             | No independent whole-file 64 MiB parser restriction existed. Structural parsing, complete encoded-audio comparison, CRC checks, malformed/truncated rejection and independent metadata reread remain unchanged. Existing 256-block, 10,000-comment, 10 MiB picture, image-pixel, string and format/integer bounds remain. These prevent pathological metadata/resource use or enforce FLAC syntax. |
| Independent reader                                              | Its maximum allocation policy follows the 128 MiB file policy.                                                                                                                                                                                                                                                                                                                                     |
| IPC/renderer                                                    | Only validated metadata patches and catalog snapshots cross editing IPC. No audio file buffers, publication strategy or renderer-provided target paths are accepted. Large source bytes remain in main/workers/native code.                                                                                                                                                                        |
| Filesystem/native integers                                      | 128 MiB is well below supported typed-array/WASM/native size/offset ranges. APFS clone/publication APIs do not impose the former 64 MiB ceiling. Writable local supported storage, no symlink traversal, valid ownership/receipt authority and sufficient space remain operating requirements.                                                                                                     |
| Disk space                                                      | The existing clone free-space check reserves one file size plus 16 MiB. Publication can require candidate/rollback storage in addition to the target and retained clone; ENOSPC remains a visible failure with journal/authority handling. No new automatic cleanup of unknown files or permanent cache is introduced.                                                                             |

Remaining numeric references to 64 MiB in backpressure/admission tests are
explicit sample sizes (including the former four-input envelope), not ceilings.
Historical research scripts retain their original fixture budgets; current
player/inline fixture admission uses the shared 128 MiB policy. The parser's
`67108864` UTF-8 minimum is a canonical frame-number encoding boundary, not a
file-size restriction. Native in-place 64 KiB writes and receipt-hash 1 MiB reads
remain bounded I/O chunk sizes.

The ceiling is 128 MiB because the experimental 256 MiB configuration did
not preserve transport at 250 MiB on staged publication. Although an external
`noowners` 250 MiB case verified repeated edits and forward recovery, the
packaged staged run recorded decoder `waiting`/`stalled` events, approximately
six seconds of main-process blocking, and near 3 GiB peak RSS. Audio bytes,
revision authority and verified saves were preserved; this was a transport and
resource limitation. Exact 128 MiB probes avoided those decoder events on both
strategies. Their peak RSS was roughly 1.3–1.5 GiB. Neither a cap nor an allocation
budget guarantees sufficient RAM or uninterrupted acoustics on every machine.

## Failure classification

Size, nonregular file type and unexpected hard links now have distinct native
failures. The metadata boundary reports the supported size limit instead of
misclassifying it as a broken managed receipt. Receipt/path identity failures,
playback-use conflicts and source-acquisition failures retain their separate
handling; insufficient clone space retains its free-space guidance. Successful
saves remain quiet. No publication, receipt, playback or sender validation was
removed.

## Qualification and measurements

See `LARGE-FLAC-RESULTS.json` for final cases and measurements. The resource paths in its provenance records are relative to `<repo>`, the checkout used for the run. Fixtures cover both
sides of the former ceiling, approximately 70/100 MiB, the exact 128 MiB boundary, experimental 250 MiB data, the independently copied
affected track, and an over-limit file. Synthetic fixtures use stereo 96 kHz/24-bit
FLAC, including a roughly 7.5-minute file. The input and edited output are checked
with an independent decoder. No original music is modified.

The opt-in generator `node scripts/research/large-flac-fixtures.mjs` creates a
bounded set of seeded disposable fixtures and records actual sizes. It requires
an existing FFmpeg reference utility (optionally `RIO_LARGE_FIXTURE_FFMPEG`),
installs nothing, and is not part of either ordinary desktop suite. Its generated
directory is printed for explicit cleanup after the lab run.

Set `RIO_DISPOSABLE_FLAC` to a file in the generator's printed fixture directory.
Run `node scripts/large-flac.mjs --fixture "$RIO_DISPOSABLE_FLAC" --repeat` to
qualify the production manager/coordinator with streamed test hashes. Add
`--external-parent .` for a disposable library on the repository's external APFS
volume, `--recover` for a post-publication interruption/reconciliation test, or
`--disabled` to prove original-file playback still excludes edits until released.
The script refuses inputs outside known disposable temporary roots.

The real player harness supports `--large-fixture` (bounded by the same policy).
`--metadata-fixture-only --metadata --preserve-fixture-tags` supplements the full
standard suite for an exact disposable copy: real tags need not have synthetic
A/B queue order. It reuses the existing UI/IPC/transport/recovery assertions.
Large-fixture physical-save completion waits allow 90 seconds (a 250 MiB staged
save exceeded 30 seconds); decoder readiness, immediate
editor exit, source authorization and ownership assertions are unchanged.

Transport position, decoder readiness/events and authorized protocol-byte
verification are evidence of real Electron playback/source continuity. They do
not establish PCM or acoustic continuity. Native publication/hashing can still
stall the main process; this mission does not change those algorithms.

The product target remains verified, durable saves in **one second or less for
ordinary tracks lasting five minutes or less**. Large-file admission does not
claim that target is achieved. Size support and save-latency optimization are
separate work.

## Measured resource envelope

These sequential coordinator cases used independent managed copies on Intel macOS
with 36 GiB RAM. Each row started a fresh process and test library. The second
save is a repeat on that library; filesystem caches were not flushed. Workers
and native allocations share the measured process RSS. Worker CPU sums disjoint
worker stages, and is included in the total save duration. The publication
window is final revalidation through the publication/durability return.

| Strategy |    MiB | Acquisition (ms) | First / repeat save (s) | Peak RSS (MiB) | Largest main gap (ms) | Largest publication window (ms) | First-save worker CPU (ms) |
| -------- | -----: | ---------------: | ----------------------: | -------------: | --------------------: | ------------------------------: | -------------------------: |
| staged   |  63.76 |              511 |             7.93 / 7.91 |           1088 |                  1520 |                            1116 |                       2494 |
| staged   |  64.25 |              537 |             8.39 / 8.42 |            942 |                  1555 |                            1142 |                       2564 |
| staged   |  70.00 |              550 |             8.64 / 8.47 |           1025 |                  1526 |                            1163 |                       2753 |
| staged   | 100.01 |              756 |           11.88 / 11.95 |           1413 |                  2127 |                            1785 |                       3835 |
| staged   | 128.00 |              957 |           16.58 / 15.60 |           1754 |                  2550 |                            2124 |                       6864 |
| in-place |  63.76 |              773 |             4.16 / 4.06 |            927 |                   285 |                             275 |                       1801 |
| in-place |  64.25 |              555 |             4.15 / 3.86 |            884 |                   288 |                             284 |                       1813 |
| in-place |  70.00 |              710 |             4.74 / 4.25 |            954 |                   327 |                             317 |                       1966 |
| in-place | 100.01 |              974 |             6.73 / 6.02 |           1201 |                   654 |                             651 |                       2758 |
| in-place | 128.00 |             1145 |             9.51 / 8.18 |           1465 |                   751 |                             744 |                       4824 |

Both sides of the former threshold passed complete verification and independent
post-edit decoding. The exact 128 MiB case passed repeated edits and forward
recovery on both strategies, including expected native inode behavior (exchange
changes the inode; in-place preserves it), matching updated receipts and no
pending journal. At 128 MiB plus one byte, and at 250 and 273.60 MiB, the final
build selected original-file playback and refused metadata editing with the size
message. Disabled-mode original use blocked the 70 MiB edit until release.

## Manual acceptance

Quit any running Rio. Run the following command from the repository root to
launch the fresh build with a disposable profile.

```sh
rio_lab_profile="$(mktemp -d /private/tmp/rio-2e6-manual.XXXXXX)"
RIO_DATA_DIR="$rio_lab_profile" RIO_STABLE_PLAYBACK_SOURCES=1 \
  "./release/mac/Rio.app/Contents/MacOS/Rio"
```

Use a disposable library and independent managed FLAC copies. Keep Organized must
be OFF. Play/pause a large track, save a single inline or Track Info field, seek
and switch tracks, and reopen the library to confirm the saved value. Successful
saves remain silent; errors retain drafts/recovery controls. Without the flag,
active/paused original-file playback must continue blocking editing.

Qualification is local Intel macOS/APFS only. Linux large-file publication,
macOS arm64, signed/notarized distribution, other filesystems and acoustic
continuity are not established by these runs. The staged publisher's stronger
contract and the APFS `noowners` in-place interruption limitation are unchanged.

## Final packaged player and storage results

| Case        | First decoded data | Natural save | Publication window | Main-process gap | Peak RSS |
| ----------- | -----------------: | -----------: | -----------------: | ---------------: | -------: |
| affected    |             712 ms |       6.40 s |             367 ms |           372 ms |  940 MiB |
| 128-staged  |            1154 ms |      19.22 s |            2803 ms |          3098 ms | 1499 MiB |
| 128-inplace |            1202 ms |      11.11 s |            1675 ms |          1682 ms | 1293 MiB |

Natural boundary and affected-copy saves retained the authorized source without
decoder wait/stall/emptied/error events in these runs. This is transport evidence.
The exact affected copy also passed active and paused Track Info/inline saves,
seek/pause/resume, switching, repeated edits, reacquisition, cancellation, failed
draft recovery and quit/restart checks. The original SHA-256, inode, size, mtime
and permissions matched the read-only baseline.

On a dedicated 512 MiB `noowners` image, a 70.00 MiB fixture changed
whole-volume available space by +0.00 MiB at capture and
-70.14 MiB after editing while the old clone was retained.
Final release recovered 70.01 MiB in that sample,
and the subsequent lease released in 8.0 ms. These are coarse
volume counters including filesystem/catalog bookkeeping; they do not measure
unique clone blocks or peak temporary staged allocation. No scratch names or
active sources remained.

A separate 128 MiB image with the same large managed copy returned native
ENOSPC before granting a clone. No fallback token was issued, the lease drained,
and the managed bytes stayed unchanged. Detaching a separate disposable
`noowners` image during a 70 MiB packaged save stopped before write intent,
kept the receipt unchanged and retained the proposed edit. Native volume checks
also covered both ownership modes, read-only mounts, EIO and cross-volume refusal.

## Validation and files

The final build passed typecheck, build, 562 unit tests (one existing skip), five
source metadata/playback harnesses, four base packaged metadata harnesses, and
the five packaged large-file cases above and in the JSON record. Both full
desktop suites (20 source and 19 packaged) also passed during the exploratory
256 MiB run; the final 128 MiB build was qualified with the focused suites and
boundary/storage matrix. Formatting and whitespace checks passed.

The unsigned x86_64 Rio.app, DMG and ZIP were built with `--publish never`.
The bundle identifier is `io.github.marcelchapman.rio`. All 41 production files
match the fresh ASAR/unpacked resources. DMG checksum, read-only mounted app
comparison and ZIP consistency passed.

Files changed by this phase, relative to the repository root:

```text
docs/FLAC-METADATA-WRITER.md
docs/INLINE-METADATA.md
docs/LARGE-FLAC-RESULTS.json
docs/LARGE-FLAC.md
docs/METADATA-EDITING.md
docs/STABLE-PLAYBACK-PLAYER.md
docs/STABLE-PLAYBACK-SOURCE-MANAGER.md
native/playback-source.cc
native/publication.cc
scripts/build-playback-source-native.mjs
scripts/build-publication-native.mjs
scripts/inline-metadata.mjs
scripts/large-flac.mjs
scripts/lib/local-metadata-volume.mjs
scripts/lib/stable-metadata.mjs
scripts/player-stable.mjs
scripts/publication-crash.mjs
scripts/research/large-flac-fixtures.mjs
src/domain/metadata-budget.ts
src/domain/metadata-edit-worker.ts
src/domain/metadata-edit.ts
src/domain/metadata-writer.ts
src/domain/publication.ts
src/main/metadata-editor.ts
src/main/playback-use.ts
src/main/stable-source-manager.ts
src/main/stable-source-worker.ts
src/shared/flac-limits.ts
tests/metadata-budget.test.ts
tests/metadata-edit.test.ts
tests/metadata-writer.test.ts
tests/stable-source.test.ts
```
