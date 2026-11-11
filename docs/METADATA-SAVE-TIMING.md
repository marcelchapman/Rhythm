# Phase 2D.3 metadata save timing

Rio reproduced a roughly ten-second inline save on the external APFS volume. For the 44,487,516-byte fixture, four saves took 9.64–10.89 seconds. FLAC frame parsing during preparation and post-publication verification took 5.84–6.87 seconds per save, including 5.26–5.46 seconds of worker-thread CPU. The native in-place `fsync` took about 19 ms on the first and median warm run.

The larger fixture also took 15.74–16.37 seconds on internal APFS with ownership enabled. Staged publication adds a separate staged-file verification, including another parse of the original and candidate. The comparison changes both storage and publication strategy, so it cannot isolate the external disk's throughput. The worker-thread CPU measurements identify frame parsing as the dominant cost independently of that comparison.

## Procedure

The benchmark used the source Electron application on the Intel Mac with macOS 15.8.1. It drove normal double-click, input, and Enter events in Songs. Each volume held its own disposable managed copies and SQLite library. Rio used an isolated temporary profile for each run. The external library was on the repository's APFS volume mounted with `noowners`. The internal library was on the ownership-enabled APFS volume backing `/private/tmp`. The benchmark left both mounts as it found them.

The same seeded, stereo, 48 kHz, 24-bit FLAC fixtures were used on both volumes. FFmpeg decoded each complete fixture successfully before import. Each cell changed four times. Run 1 was the first edit after import and advisory eligibility checks. Runs 2–4 were repeated edits in the same process. Import and eligibility already read the file, so run 1 is not a cold disk-cache measurement. The source fixture hashes were unchanged and the benchmark removed the temporary roots after checking their identities.

```sh
npm run build
node scripts/research/metadata-save-timing.mjs > /private/tmp/rio-save-timing.jsonl
```

The benchmark expects Node with TypeScript stripping, Playwright, and FFmpeg on the path. It enables timing for its child process. Each JSONL save record groups renderer, main, worker, and native events for a single submission. The trace records byte counts, timing, and strategy without catalog identifiers, file paths, tag contents, or account details.

## Measured saves

Times are in seconds from the renderer's save handler to the next renderer frame after the reply.

| Storage                         | Strategy | Original fixture bytes |  Run 1 |  Run 2 |  Run 3 |  Run 4 |
| ------------------------------- | -------- | ---------------------: | -----: | -----: | -----: | -----: |
| External APFS `noowners`        | In place |                749,476 |  0.816 |  0.879 |  0.681 |  0.872 |
| External APFS `noowners`        | In place |             44,487,516 | 10.357 |  9.640 |  9.860 | 10.887 |
| Internal ownership-enabled APFS | Staged   |                749,476 |  1.459 |  1.339 |  1.126 |  1.095 |
| Internal ownership-enabled APFS | Staged   |             44,487,516 | 15.830 | 15.821 | 16.369 | 15.736 |

The cells below show run 1 / median of runs 2–4 in milliseconds. Main stages are disjoint intervals. The advisory eligibility call happens before Save and is separate from the total. Rounding and taking the median of each stage independently can make column sums differ from the median total.

| Stage                                                       | External small | External large | Internal small | Internal large |
| ----------------------------------------------------------- | -------------: | -------------: | -------------: | -------------: |
| Advisory eligibility before Save                            |        29 / 26 |      335 / 302 |      179 / 157 |      422 / 439 |
| Renderer initiation, IPC outside handler and reply to frame |         11 / 9 |         12 / 7 |          8 / 7 |          9 / 8 |
| Target, patch validation and all lock acquisition           |      2.3 / 1.3 |      0.8 / 0.7 |      2.8 / 0.9 |      1.0 / 1.3 |
| Managed receipt preflight                                   |        11 / 21 |      306 / 270 |        29 / 12 |      256 / 279 |
| Capability selection                                        |      0.6 / 0.5 |      0.4 / 0.3 |      145 / 128 |      145 / 128 |
| Original read, digest and journal insert                    |         10 / 8 |      272 / 246 |          6 / 6 |      236 / 240 |
| Candidate preparation worker round trip                     |      458 / 402 |  4,438 / 4,273 |      360 / 274 |  4,119 / 4,156 |
| Candidate digest check                                      |          2 / 2 |      104 / 107 |          2 / 2 |      112 / 108 |
| Strong staging and artifact checks                          |              — |              — |      172 / 167 |  1,349 / 1,180 |
| Staged-file read and verification                           |              — |              — |      239 / 183 |  3,650 / 3,738 |
| Revalidation and journal work                               |        13 / 13 |      266 / 259 |         12 / 9 |      243 / 267 |
| Publication and durability                                  |          6 / 5 |      263 / 273 |       157 / 78 |  1,097 / 1,136 |
| Post-publication read and verification                      |      286 / 253 |  4,381 / 4,347 |      237 / 183 |  3,774 / 3,791 |
| SQLite commit and receipt update                            |      2.0 / 1.9 |      2.1 / 2.5 |      1.2 / 1.4 |      1.0 / 1.0 |
| Reconcile                                                   |        11 / 10 |      308 / 266 |          9 / 8 |      246 / 254 |
| Cleanup                                                     |      0.6 / 0.5 |      0.8 / 1.2 |        76 / 72 |      586 / 605 |
| Main snapshot                                               |      0.8 / 0.6 |      0.7 / 0.6 |      0.6 / 0.6 |      0.5 / 0.6 |
| Remaining main time, including release                      |      0.9 / 0.8 |      0.8 / 0.5 |      1.4 / 1.2 |      6.3 / 6.9 |

These nested measurements are already included in the stages above. They must not be added to the total.

| Nested timing, ms                            | External small | External large | Internal small | Internal large |
| -------------------------------------------- | -------------: | -------------: | -------------: | -------------: |
| FLAC frame parsing, wall time                |      133 / 148 |  6,585 / 5,953 |      193 / 154 |  8,377 / 8,333 |
| FLAC frame parsing, worker-thread CPU        |      113 / 118 |  5,460 / 5,285 |      153 / 144 |  7,663 / 7,731 |
| Tag writer candidate rendering               |       174 / 97 |      270 / 292 |       100 / 74 |      265 / 294 |
| Audio and metadata preservation checks       |        28 / 15 |      448 / 492 |        25 / 16 |      664 / 665 |
| Worker proof hashing and copy                |        15 / 17 |      700 / 724 |        22 / 19 |  1,023 / 1,044 |
| Worker round-trip time outside worker stages |      334 / 309 |      638 / 685 |      423 / 316 |      892 / 942 |
| JavaScript async read wait                   |         6 / 12 |      242 / 203 |          8 / 6 |      184 / 213 |
| Main receipt and coordinator digest time     |        22 / 21 |  1,128 / 1,060 |        20 / 20 |  1,154 / 1,157 |
| Instrumented native reads                    |      1.0 / 0.7 |        74 / 77 |      0.4 / 0.1 |        38 / 39 |
| Native writes                                |      0.2 / 0.3 |        56 / 56 |      0.5 / 0.5 |       220 / 43 |
| Native `fsync`                               |      1.8 / 1.9 |    18.6 / 18.7 |      1.1 / 1.4 |      8.1 / 6.8 |
| Native `F_FULLFSYNC`                         |              — |              — |      496 / 400 |      434 / 419 |

For the large external fixture, the coordinator made eight full-file async reads per save, totaling about 356 MB, and the native publisher made two more. Async read wait includes filesystem, cache, and scheduling time. Hashing the repeated reads consumed considerably more time than waiting for them. The frame parser ran four times per in-place save and six times per staged save. The worker round-trip remainder includes worker construction, module startup, scheduling and result delivery. On the large external case about 164–166 ms of the first/median remainder was directly measured in worker construction and dispatch. The rest was not separately attributed. The playlist and playback gates did not queue in these successful runs, and the SQLite lock took less than 0.2 ms on the first and median runs of every case.

The large file still took roughly ten seconds on repeat edits. Storage I/O and durability timings, lock acquisition, SQLite commit and renderer refresh were too small to explain that result. The read-only Spotlight status query reported the server disabled. These trials provide no evidence that Dropbox or indexing caused the delay, and they do not identify what any background process was doing during the earlier manual session. The isolated catalog also cannot characterize snapshot time in a large existing library.

The smallest plausible follow-up is to profile and optimize the FLAC frame parser's bit and residual decoding loops while preserving the exact frame, checksum and audio-payload checks at every existing verification boundary. Validate the parser against malformed input and both publication strategies before measuring the same fixtures again.

## Opt-in capture

A build containing this diagnostic diff emits timing only when launched with `RIO_METADATA_TIMING=1`. Launch that build's executable directly from Terminal with a separate `RIO_DATA_DIR` and use a disposable library and managed copy. Filter stdout to capture just the timing events. This works for Songs and Track Info. Leave the environment variable unset for normal use.

```sh
profile="$(mktemp -d /private/tmp/rio-timing-profile.XXXXXX)"
RIO_DATA_DIR="$profile" RIO_METADATA_TIMING=1 "/path/to/Rio.app/Contents/MacOS/Rio" 2>/dev/null |
  awk '/^RIO_METADATA_(MAIN|NATIVE|RENDERER) /' > /private/tmp/rio-manual-save-timing.jsonl
```

## Phase 2D.4 parser profile and repeat

Before changing the parser, the Electron runtime's CPU sampler captured four parses of the same 180-second compressed audio payload. The standalone fixture omitted the benchmark's synthetic tags. It contained 8,438 frames and 8,640,000 samples per channel. Of 7,901 samples, 4,238 (54%) were directly in the bit reader, 2,979 (38%) were attributed to the subframe loop, and 661 (8%) were in skip and unary helpers. The hot Rice loop read every remainder bit individually, checked the cursor for each unary bit, and recomputed the quotient bound and radix for each sample. Metadata parsing and frame-header handling accounted for very few samples.

The reader now consumes bit fields in byte chunks and counts a unary prefix in each byte. A partition computes its Rice quotient bound once. When the quotient is below that bound, all possible remainder values are valid and the reader advances across the remainder after checking that all its bits are present. At the bound it reads the remainder and rejects the reserved all-ones value. The CRC loop uses four lookups per four bytes with the same polynomial and verifies the same header, body, padding and footer bytes. Encoded-audio comparison checks every byte directly, including the length. The digest proofs and each structural verification pass still run.

Standalone timing used the same Electron Node runtime (v24.22.0) and an in-memory input for both versions. The first parse and median of four later parses are in milliseconds.

| Parser-only metric | Before, first | After, first | Before, repeat median | After, repeat median |
| ------------------ | ------------: | -----------: | --------------------: | -------------------: |
| Elapsed            |         1,222 |          246 |                 1,211 |                  219 |
| Thread CPU         |         1,216 |          242 |                 1,205 |                  217 |

The existing save benchmark was then repeated with the original fixture sizes, volumes and four edits per case. Times are in seconds. The parser figures are the sum across the four verification parses in an in-place save.

| External 44,487,516-byte FLAC | Before, first | After, first | Before, repeat median | After, repeat median |
| ----------------------------- | ------------: | -----------: | --------------------: | -------------------: |
| Renderer save to next frame   |        10.357 |        4.263 |                 9.860 |                3.754 |
| Frame parsing elapsed         |         6.585 |        1.020 |                 5.953 |                0.956 |
| Frame parsing thread CPU      |         5.460 |        0.975 |                 5.285 |                0.950 |

| Case                                | After, first | After, repeat range |
| ----------------------------------- | -----------: | ------------------: |
| External 749,476 bytes, in place    |        0.363 |         0.320–0.546 |
| External 44,487,516 bytes, in place |        4.263 |         3.727–3.859 |
| Internal 749,476 bytes, staged      |        0.912 |         0.884–0.920 |
| Internal 44,487,516 bytes, staged   |        7.304 |         7.285–7.667 |

The external warm median fell by 62%. It still exceeds the two-second target. On that case the median repeat consumed about 1.02 seconds in main receipt and coordinator digests, 0.64 seconds in worker proof hashing and copying, and 0.48 seconds in worker round-trip overhead outside instrumented worker stages. The direct preservation checks, which include the exact audio comparison, fell from 491 ms to 16 ms. These nested timings are already part of the save total.

The fresh unsigned Intel package ran the same 16 saves using its bundled implementation. On the large external fixture it took 3.981 seconds for the first edit and 3.695, 3.698 and 3.903 seconds for the repeats. The large internal staged fixture took 7.276 seconds for the first edit and 7.326, 7.287 and 7.290 seconds for the repeats. The source and packaged runs both verified unchanged source fixture hashes and removed their temporary libraries.
