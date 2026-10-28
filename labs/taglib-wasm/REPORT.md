# TagLib-Wasm writer qualification

Date: 2026-10-28. Host: Intel macOS. Experiment only; production code, root manifests, existing libraries and managed-media behavior were not changed. No real music was read or edited. No UI, IPC or database was implemented. No commit was made.

## Decision

**Accepted with format/API restrictions for future integration, not approved as an unrestricted production writer.**

The engine is usable, but its convenience APIs and automatic backend selection do not provide the preservation guarantees Rhythm needs. A successful save is insufficient evidence. In particular, MP3 comments, FLAC picture geometry and MP4 mdta metadata exhibit concrete preservation failures.

**Recommended initial production format scope: native FLAC only, using the forced Emscripten full-buffer Core API, with independent preservation verification before publication.** Other extensions remain read-only initially. For FLAC: initially expose integer BPM through Rhythm's present reader; permit comment editing only for an unambiguous COMMENT-only profile; do not enable artwork replacement/removal when another picture must be retained until full picture-attribute preservation is available. Metadata-only edits can preserve existing additional pictures with Emscripten. Files containing foreign ID3 tags or other unqualified profiles should be refused rather than normalized silently. Treat full-date year edits as an explicit adapter policy: preserving month/day is not supplied by the tested DATE replacement.

This is a proposed future scope, not a production capability added by the lab. MP3 and ordinary iTunes-style AAC/M4A are the next candidates after their preservation rules and failures are addressed. The reported format-specific restrictions must not be hidden behind a single “supports MP3/FLAC/M4A” label.

## 1. Runtime and Electron compatibility

- Rhythm: Electron 44.9.2; the actual embedded runtime reports Node 24.22.0 and V8 15.2.124.43-electron.0.
- Host tooling: Node 26.12.0, npm 11.20.0. CI selects Node 24; runtime consumers use Electron's embedded Node, not the build host's Node.
- Candidate: npm taglib-wasm **2.4.0**, embedding **TagLib 2.3.2**, requiring Node >=24.0.0. Published gitHead: `1ef771c91a81c81ecdd22e92b334fab4b27a5bb4`.
- Both forced WASI and Emscripten initialized without flags in Electron's runtime. Both completed all eight format matrices in a standalone, windowless Electron main process. No Rhythm entry point was imported.
- Five final matrix runs: host Node/WASI, host Node/Emscripten, Electron/WASI, Electron/Emscripten, and Electron/Emscripten buffer mode for the three priority formats. Results agreed across host/Electron for matching backends.
- Node 24's generic documentation mentions an exnref flag/fallback. Electron's newer V8 accepted the artifacts without it; no production flags were added. This does not establish that every standalone Node 24 build behaves identically.

## 2. Packaging

Rhythm uses npm/package-lock, NodeNext ESM TypeScript for main/domain code, Vite for the renderer, and electron-builder 26.15.3 with ASAR. Current artifacts are macOS DMG/ZIP and Linux AppImage/deb; Windows packaging is future work.

A lab-only ASAR loaded JS and both WASM engines and edited a generated FLAC successfully in four configurations: WASI/Emscripten with assets inside ASAR, and WASI/Emscripten with explicit external WASM paths. music-metadata, packet hashes and decoded PCM independently verified all four outputs. Thus ASAR unpacking is **not a demonstrated functional requirement** on this macOS runtime.

For production, prefer the JS package as a main/worker dependency, with the selected local WASM artifact in a known resource location and explicit loading. Keep it out of Vite/renderer code; no renderer CSP or Node-integration change is needed. External resources simplify asset inventory and a documented replacement/rebuild procedure. No CDN/network fallback should be allowed. Pin engine version/backend and test the same artifact in signed/packaged builds.

WASM avoids an architecture-specific Node addon rebuild, but macOS arm64, Linux and Windows execution were not tested here. Their packaged resource paths, signatures, filesystem semantics and backend behavior still require native canaries. The ASAR experiment is not a signed DMG/ZIP qualification or a Linux/Windows result.

The default WASI loader preopens `/` on Unix and detected drives on Windows. Do not mistake it for Rhythm's managed-authority boundary. A buffer-only writer avoids handing arbitrary filesystem paths to the engine; the domain coordinator must retain filesystem authority.

## 3. Licensing/distribution

The installed npm manifest labels the package MIT, but its README distinguishes MIT JS/TS from LGPL-2.1-or-later WASM. The published 2.4.0 archive contains only `LICENSE`; it does **not** include LGPL text, a NOTICE file or corresponding TagLib sources/build inputs. Newer online documentation is not proof that those materials are present in this npm artifact.

Before distribution, Rhythm must preserve wrapper/transitive notices; supply the applicable LGPL notice/text; provide corresponding library source, wrapper/build inputs and modifications through an appropriate compliant distribution route; and provide a practical modified-library replacement/relink/rebuild mechanism. Terms must permit the library-modification/debugging rights required by LGPL. Record exact source revisions, toolchains and WASM hashes. A replacement procedure must account for macOS code-signing behavior, not merely say that a WASM file exists. Do not assume an alternative MPL option covers this prebuilt WASM just because upstream TagLib is dual-licensed. Resolve the distribution compliance plan before release; this lab does not settle Rhythm's own undecided license.

Primary references: [upstream installation](https://charleswiltgen.github.io/TagLib-Wasm/guide/installation.html), [upstream project/license](https://github.com/CharlesWiltgen/taglib-wasm#license), and [TagLib 2.3.2 LGPL text](https://raw.githubusercontent.com/taglib/taglib/v2.3.2/COPYING.LGPL). Actual installed artifact contents and runtime measurements take precedence over changing website claims.

## 4. Experimental method and evidence

Generated two-second stereo sine fixtures: MP3/libmp3lame, FLAC, AAC/M4A, Ogg/native Vorbis, Opus/libopus, PCM WAV, PCM AIFF, and ADTS/raw AAC. The local FFmpeg lacks libvorbis, so the available native Vorbis encoder was selected explicitly. Solid-color PNG/JPEG artwork is generated locally.

Each operation uses a fresh copy. Generated originals remain hashed and untouched after generation. Each format exercises initial reading, no-op save, title, artist/album, album artist, composer, genre, DATE/year, integer/fractional BPM, comments, track/disc number and total changes, separate number/total clears, other explicit clears, JPEG/PNG front replacement and front removal. A separate test checks absent fields stay absent/empty without writing display fallbacks. Default partial-path saving is checked separately.

Every matrix output is parsed independently by Rhythm's installed music-metadata 12.2.3. Every output is demuxed with FFprobe and decoded with FFmpeg. Encoded packet byte-hash sequences and decoded PCM hashes must match the pre-edit fixture. The writer's own media checksum is not used as independent proof.

Final evidence: **1,120 matrix operations, 46 preservation edge cases, 16 targeted refinements, four ASAR checks**, plus the pure organization planner check. All matrix encoded-packet and PCM comparisons passed, and every generated original retained its recorded hash. Edge/refinement/ASAR audio checks also passed. Metadata-preservation failures remain recorded as failures, not waived.

| Matrix run                 |  MP3 |  FLAC |   M4A |   Ogg |  Opus |   WAV |  AIFF |   AAC |
| -------------------------- | ---: | ----: | ----: | ----: | ----: | ----: | ----: | ----: |
| Node WASI                  | 2/32 | 29/32 | 28/32 | 29/32 | 29/32 | 31/32 | 29/32 | 31/32 |
| Node Emscripten            | 6/32 | 29/32 | 27/32 | 29/32 | 26/32 | 27/32 | 26/32 | 30/32 |
| Electron WASI              | 2/32 | 29/32 | 28/32 | 29/32 | 29/32 | 31/32 | 29/32 | 31/32 |
| Electron Emscripten        | 6/32 | 29/32 | 27/32 | 29/32 | 26/32 | 27/32 | 26/32 | 30/32 |
| Electron Emscripten buffer | 6/32 | 29/32 | 27/32 |     — |     — |     — |     — |     — |

These are **strict case counts, not format support scores**. A case fails for collateral metadata changes, artwork loss or reader disagreement even when the requested field changes correctly. The deeper geometry/mdta/raw-frame tests reveal restrictions not represented by the basic counts. In particular, a high WASI/FLAC count must not conceal the picture-geometry failure.

## 5. Per-field findings for priority formats

“Written/read” below means the explicitly requested value was independently observed. It does not negate the collateral-preservation failures documented afterward.

| Field/operation    | MP3                                                            | FLAC                                                         | AAC/M4A                                                                                        |
| ------------------ | -------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| Read existing tags | Both readers read generated ID3 tags                           | Both read Vorbis comments                                    | Both read ordinary iTunes metadata                                                             |
| Title              | Written/read; generic setter can duplicate comments            | Written/read                                                 | Written/read; mdta profile loses unrelated values                                              |
| Artist + Album     | Written/read                                                   | Written/read                                                 | Written/read                                                                                   |
| Album Artist       | Written/read                                                   | Written/read                                                 | Written/read                                                                                   |
| Composer           | Written/read                                                   | Written/read; multi-values preserved in follow-up            | Written/read; multi-values preserved in follow-up                                              |
| Genre              | Written/read                                                   | Written/read; multi-values preserved                         | Written/read                                                                                   |
| Year               | DATE year replacement read correctly                           | Same                                                         | Same                                                                                           |
| Track number/total | Pair updates and separate clears read correctly                | Same                                                         | Same; numeric pair formatting does not retain textual leading zeroes                           |
| Disc number/total  | Pair updates and separate clears read correctly                | Same                                                         | Same                                                                                           |
| Integer BPM        | Written/read                                                   | Written/read                                                 | Written/read                                                                                   |
| Fractional BPM     | Writer retains 123.5; music-metadata reports 123               | Same reader truncation                                       | Writer itself stores 123 in integer tmpo; reader reports 123                                   |
| Comments           | Requested text read, but aliases/multiple comments need care   | COMMENT + DESCRIPTION causes duplication or incomplete clear | Ordinary comment property works; typed empty setter does not reliably remove the native atom   |
| Explicit clears    | Many clear correctly; Emscripten can retain empty numeric tags | Unambiguous COMMENT-only change/clear passes                 | Empty values can remain; Emscripten BPM clear leaves tmpo=0 unless native atom removal is used |

Rhythm's installed reader explicitly uses `Number.parseInt` for BPM. Do not blame every fractional-BPM mismatch on the writer. Raw stored BPM/native values are retained in the evidence. Likewise, setting DATE to `2001` intentionally replaces the previous full date; the engine does not infer a policy for preserving month/day during a year-only editor operation. Unedited full dates and track/disc totals survived title-only edits in the tested profiles.

## 6. Artwork

- MP3 and FLAC: JPEG/PNG replacement and front removal can retain a back image's **bytes, type and description**. This alone is not full preservation.
- Independently populated FLAC picture geometry was 32×32, depth 24. A WASI title-only save rewrote existing front/back geometry to zero. Emscripten title-only saved those attributes unchanged. Rebuilding the picture list through `setPictures(getPictures()...)` reset the retained back picture's geometry to zero on **both** engines: the JS Picture representation omits these native attributes.
- M4A supports multiple covr images but does not encode distinct front/back types/descriptions through this API. Both come back as FrontCover with empty descriptions. A naïve type-based replacement/removal therefore drops the second image. An explicit **replace/remove first image while retaining remaining image indices** experiment preserved the other image bytes and vendor metadata. That is an application policy, not a discovered front-cover identity.
- WASI persisted artwork on the generated Opus/WAV/AIFF fixtures. Emscripten did not persist pictures on those fixtures despite the calls returning without an exception. Ogg Vorbis persisted the images. Raw AAC accepted embedded ID3 images in the generated sample; that is not broad AAC ecosystem qualification.
- No commercial artwork, external folder-cover lookup or production cache change was introduced.

## 7. Unchanged/unknown metadata and patch semantics

- Generic MP3 property updates on the mixed-comment fixture created additional TXXX:COMMENT entries. WASI reproduced growth even on a no-op save. A typed Emscripten title setter preserved that fixture's comments, demonstrating that API/backend choice matters.
- Independently injected multilingual/described COMM frames were preserved by Emscripten Core path/buffer title patches. WASI Core path/buffer and the default-WASI Simple API overwrote an unedited comment with another existing comment value. The “Simple” cases use its automatic backend, not the forced backend of the neighboring Core tests.
- ID3v2.3 became v2.4 on save. Unknown XZZZ frame payloads survived, but nonzero frame-header flags became zero. No blanket byte/semantic preservation claim is justified for arbitrary ID3 frames.
- Tested copyright, ReplayGain, lyrics, Unicode custom text, multi-value genres/composers, and mixed-case/vendor-specific MP4 freeform atoms survived appropriate Core title edits. The native MP4 item API was needed to seed the arbitrary vendor atom; the generic property API silently failed to create a new arbitrary MP4 freeform item in a separate test.
- Independently inserted FLAC APPLICATION block bytes survived title edits on both engines.
- Independently generated MP4 **mdta** metadata was present before editing; a title-only save removed its unrelated marker on both engines. Ordinary iTunes/freeform success does not qualify all M4A metadata profiles.
- `setProperties` is unsafe as a generic patch mechanism: the tested Emscripten replacement dropped omitted properties; WASI merged them. Never reconstruct an editing document from a normalized Track or overwrite a complete property map with only form fields.
- Omitted/unchanged fields, explicit nonempty changes and explicit clears were tested separately. Missing artist/album/album artist/genre/composer fields stayed absent or empty after a title-only change on all fixtures. No Rhythm “Unknown artist/album/genre” fallback was supplied to the writer.
- FLAC/Ogg COMMENT and DESCRIPTION aliases require policy. Clearing COMMENT alone can leave DESCRIPTION visible. Emscripten retained DESCRIPTION during COMMENT changes; WASI changed it as well in the mixed fixture. With DESCRIPTION deliberately absent, isolated FLAC COMMENT change and clear passed both engines.
- AIFF NAME/ANNO can survive after deleting an ID3 title/comment, causing the old native value to reappear. Keep AIFF read-only until cross-tag semantics are qualified.

Preservation is only established for the tested structures. Encrypted/compressed ID3 frames, arbitrary MP4 atom types, chapters, nonzero Opus gain, chained Ogg, large artwork/files and unusual tag encodings are not comprehensively qualified. The appropriate response is a capability restriction or failed verification, not silent normalization.

## 8. Organization example

The unchanged production `mediaDestination` planner calculated, for each priority extension:

`Unknown Artist/Unknown Album/track.ext` → `Massive Attack/Blue Lines/00 track.ext`

The `00` prefix is the existing planner's behavior when track number is absent; it is not a new naming rule. Artist/Album were supplied as fresh raw edits, with album artist absent, rather than inherited display fallbacks. Repeating the same plan returns the same directory/destination candidate.

This was pure calculation. No media directory was created, file moved, ID stored or cleanup performed. The planner itself has no ownership/ID checks. The future coordinator must preserve the original track ID, organize managed files only when enabled, safely create/reuse directories, update path/relative location and the current managed receipt, and apply existing registered-root/symlink/identity/empty-directory protections. It must never reorganize a reference. Do not silently broaden the album-delete-only Finder-metadata exception to editing cleanup or migrate historical roots to a newly selected root.

## 9. Exact first production primitive recommendation

Implement later, not in this lab: a pure **prepare-patched-audio** operation in a serialized worker. Inputs: independently read original bytes, detected/qualified format profile, explicit patch states, and a selected-artwork operation. Outputs: candidate bytes, parsed before/after metadata, audio-integrity proof and a preservation diff. It receives no arbitrary filesystem destination, writes no original, opens no database and changes no track identity.

Use the pinned Emscripten engine with explicit local WASM bytes and full-buffer Core handles. Omission means unchanged; clear is explicit and format-aware; a new scalar/array means changed. Preserve untouched numeric pair components, full dates, multiple values, native structures and pictures. Do not use the Simple bulk merge or whole-property replacement. Do not use default backend selection: WASI and Emscripten have materially different behavior.

The worker must have bounded input/memory/job limits, deterministic disposal and timeout/crash handling. Large-file limits need measurement before enabling those files; two-second fixture success is not a memory qualification.

Before publishing, independently parse the candidate with music-metadata and native preservation checks; compare encoded audio payload, unedited tags, native unknown blocks and unedited picture attributes. A mismatch returns an unsupported/unsafe outcome and leaves the real original untouched. The existing reader's integer BPM normalization must not be mistaken for a failed write or permit a misleading fractional editor.

A separate future domain coordinator owns fresh location/revision checks, explicit referenced-file permission, managed receipt/root validation, private same-filesystem staging, recovery journal, verified publication, short SQLite updates on the **same ID**, safe optional managed relocation, and truthful partial-failure results. Original import provenance and current managed-file authority must remain distinct. Referenced files keep their path and kind. No add/rescan/recovery command should be repurposed into an edit that accidentally copies or reidentifies a track. No asynchronous filesystem work should span an open SQLite transaction.

## 10. Validation and changed files

`validate.mjs` passed after collecting all final observations. It asserts successful requested-field readbacks, all audio checks, no fallback pollution, expected preservation failures, original hashes and a zero tracked production diff. It deliberately does not call expected candidate failures “passing tag support”. Root manifests/lockfile, source, workflows, existing library databases and production packages are unchanged. The repository shows only the new `labs/` directory; nothing was staged or committed.

Added only this lab's manifests/lockfile, ignore rules, generators, qualification/edge/refinement/runtime/ASAR/planner/report/validation scripts, README, this report and RESULTS.json. Dependencies, cache, synthetic audio/images, profiles and test ASAR are ignored under the lab. No application was installed. Remaining acceptance: licensing/materials/replacement workflow; rich-format fixes and requalification; actual signed package and native arm64/Linux/Windows tests; large-file/memory/cancellation and the future coordinator's crash/receipt/relocation tests.
