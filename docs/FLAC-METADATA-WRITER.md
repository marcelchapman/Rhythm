# FLAC metadata writer: production phase 1

`src/domain/metadata-writer.ts` provides a bytes-only preparation primitive. It
does not read or write an audio file, receive a track ID or path, open a database,
change a receipt, relocate media, or expose an IPC/renderer API. The Phase 2A domain coordinator now calls it in a bounded worker; see
[METADATA-EDITING.md](METADATA-EDITING.md). The committed qualification findings in
`labs/taglib-wasm/REPORT.md` remain authoritative.

## Interface and patch contract

```ts
prepareFlacMetadataEdit(
  original: Uint8Array,
  patch: FlacMetadataPatch,
): Promise<FlacMetadataWriteResult>
```

The caller retains its original bytes. The primitive snapshots input and patch
data before its first asynchronous operation and returns an independently owned
candidate buffer only after verification. Results include effective changed
fields, original/candidate/audio SHA-256 hashes, frame/audio-byte counts, and
preservation counts. `engineVersion` is null for a verified no-op that never
loads the writer. Errors have Rio-owned codes: `invalid-input`,
`unsupported-input`, `invalid-patch`, `unsafe-artwork`, `verification-failed`,
`writer-failed`, and `resource-limit`.

Omitting a field or supplying `{ action: "preserve" }` leaves it unchanged.
`{ action: "set", value }` explicitly replaces that field.
`{ action: "clear" }` removes its native value and must independently read back
as absent. Empty strings and zero are not substitutes for clearing. This API
never accepts a normalized Track snapshot or derives filename/display fallbacks.
The user may explicitly supply a literal string such as `Unknown Artist`.

| Patch field              | Native FLAC field                               | Initial scope                                                     |
| ------------------------ | ----------------------------------------------- | ----------------------------------------------------------------- |
| title                    | TITLE                                           | Scalar UTF-8 string                                               |
| artist                   | ARTIST                                          | Scalar UTF-8 string                                               |
| album                    | ALBUM                                           | Scalar UTF-8 string                                               |
| albumArtist              | ALBUMARTIST                                     | Scalar; reject edits with ALBUM ARTIST alias                      |
| composer                 | COMPOSER                                        | Scalar replacement; retain multiple values when untouched         |
| genre                    | GENRE                                           | Scalar replacement; reject edits with STYLE alias                 |
| year                     | DATE                                            | Integer 1–9999; only absent or single four-digit year DATE        |
| trackNumber / trackTotal | TRACKNUMBER and existing TRACKTOTAL/TOTALTRACKS | Positive integers up to 999999, or explicit clear                 |
| discNumber / discTotal   | DISCNUMBER and existing DISCTOTAL/TOTALDISCS    | Positive integers up to 999999, or explicit clear                 |
| bpm                      | BPM                                             | Integer 1–1000, or explicit clear                                 |
| comments                 | COMMENT                                         | Scalar; reject edits with DESCRIPTION or multiple COMMENT entries |

Track/disc pairs preserve the unedited component, its leading zeros, and an
existing separate total field. Clearing the number while retaining the total is
represented as `/total` for an inline pair; clearing both removes the field.
Multiple/conflicting total aliases and unqualified representations are rejected.
A number cannot exceed its total. Untouched full dates and ambiguous comments
can survive other edits; this does not authorize editing them.

## Engine and preservation

The root production dependency is pinned to `taglib-wasm` **2.4.0**. The private
adapter forces **Emscripten**, serializes access to one lazily initialized engine,
opens full buffers, uses individual Core property operations, copies the output
before disposing the handle, and never calls a path-based save API. It does not
use default WASI selection, the Simple API, or whole-map `setProperties`.

Verification combines a native FLAC inspector and the existing independent
`music-metadata` reader:

- Encoded audio payload SHA-256 must match exactly. STREAMINFO and every other
  non-padding/comment/picture block must retain its type, bytes, and order.
  This includes APPLICATION, SEEKTABLE, and CUESHEET blocks.
- The existing Vorbis vendor bytes must match. Every unedited field retains its
  exact native key spelling, values, multiplicity, and order within that field.
  Global comment ordering and the amount of zero padding may change.
- Requested fields must match native values and independent semantic readback.
  All unedited common metadata must retain its independent readback.
- Untouched PICTURE blocks must match byte-for-byte, including geometry, type,
  MIME, description, and image bytes.

TagLib uppercases some native field names on save. An unrelated lowercase or
mixed-case field therefore can cause a **verification failure**. The candidate
is rejected; no normalization exception silently loses preservation. The tests
exercise this with both custom tags and FFmpeg's lowercase `encoder` field.
There is no universal claim that every FLAC file can be edited.

## Artwork

Artwork can be omitted/preserved, `{ action: "remove-front" }`, or
`{ action: "replace-front", data, mimeType, description? }`. Addition is supported
when no picture exists. Replacement/removal is permitted only with no picture or
one type-3 front cover. Any extra or non-front picture rejects the artwork edit;
text-only edits can retain multiple pictures without rebuilding them.

New JPEG/PNG bytes must match the MIME and bounded structural checks. PNG is
limited to non-interlaced 8-bit gray/gray-alpha/RGB/RGBA, with chunk CRCs, bounded
inflation, row size, and filter validation. Animated PNG is rejected. JPEG checks
frame/segment/scan structure and 8-bit gray/RGB dimensions, not a complete entropy
decode. These checks are not a general image sanitizer. A selected new cover's
FLAC geometry fields can be unknown (zero) through this engine; existing picture
geometry may never be rewritten as a side effect.

## Input and resource limits

Only native `fLaC` streams with a known nonzero sample count are qualified.
Foreign prefixes/suffixes, Ogg FLAC, unknown/reserved metadata types, duplicate
Vorbis blocks, malformed metadata, invalid UTF-8, frame-header/subframe syntax,
CRC, and sample-sequence errors are rejected. The inspector walks constant,
verbatim, fixed-predictor, and LPC subframe syntax, including residuals, without
reconstructing PCM or encoding audio. It is not a complete lossless decoder and
does not recompute STREAMINFO's PCM MD5 in production. SEEKTABLE/CUESHEET contents
are preserved, not comprehensively semantically validated.

Initial budgets: 64 MiB input/candidate, four pending calls, 256 metadata blocks,
10000 comment entries, 10 MiB per embedded/selected picture, and 16 million pixels
for selected images. Strings are limited to 4000 UTF-16 code units (picture
descriptions: 1000), must round-trip UTF-8, and cannot contain NUL. Resource limits
are safeguards, not a large-library memory/performance qualification.

Serialization is within the current process. There is no cancellation, deadline,
or worker isolation inside this bytes-only primitive. Phase 2A supplies bounded
worker execution and timeout/crash handling at the coordinator boundary.

## Validation

All fixtures are generated synthetic bytes, not user music or an existing
library database. Tests cover every field, clears and pair components, absent
fields/no-ops/fallback avoidance, native preservation, artwork attributes,
malformed input, caller mutations, bounded concurrent requests, and injected
writer/preservation failures. A repaired-CRC malformed subframe verifies that
CRC checks alone cannot qualify invalid syntax.

Every successful edit checks exact encoded audio equality. When FFmpeg is
available, additional tests independently decode generated originals and edited
candidates to the known PCM, and exercise a genuinely compressed fixture.
FFmpeg is a test-only optional decoder, not a production dependency.

Phase-1 validation on Intel macOS: 82 focused tests passed; the complete unit
suite passed 294 tests across 15 files. Typechecking, production build, Prettier,
and diff whitespace checks passed. The compiled primitive also passed title
edit/clear and front-cover add/remove with independent readback under Electron
44.9.2 / Node 24.22.0, using only generated in-memory fixtures. Its reported
backend was `2.4.0 (TagLib 2.3.2)`. This was a runtime compatibility check, not a
new packaged-app distribution or end-user editing test.

## Packaging and licensing release gate

The installed package resolves its own local Emscripten WASM asset; callers
cannot supply a URL. The committed lab established ordinary and ASAR loading on
the current Intel macOS Electron runtime. No packaging configuration changes
are required for this isolated phase. Signed packages, native arm64, Linux,
Windows, large inputs, cancellation, and production coordinator behavior still
require qualification. Adding a production dependency means future
electron-builder packages can include it even before an editor is exposed.

The JS wrapper is MIT; its embedded TagLib/WASM carries **LGPL-2.1-or-later**
obligations. The published package's MIT license file alone does not complete
Rio's distribution obligations. Before distributing a package containing it,
provide the applicable notices/license texts, corresponding source/build
materials and a workable library replacement/relink route, including macOS
signature implications, consistent with the lab findings. This mission does not
complete those release materials. The added transitive `@msgpack/msgpack` 3.1.3
is ISC. npm also reclassified the existing TypeScript optional peer/platform
entries in the lockfile; their versions did not change.

## Next phase boundary

The Phase 2A coordinator now owns worker isolation, crash handling and the
managed-only same-path lifecycle described in METADATA-EDITING.md. Any extension
beyond that slice must still own fresh
location/revision checks, explicit permission to edit a referenced file,
registered-root/receipt authority, private same-filesystem staging, candidate
verification, publication/recovery journaling, a short database commit on the
**same track ID**, current receipt renewal, and UI/cache reconciliation. Original
import provenance must remain distinct from current managed-file authority.

When organization metadata changes and Keep Organized is enabled, the future
coordinator must reuse the existing planner and managed-directory protections
to create/reuse the appropriate destination and clean old directories safely.
Referenced files must never be relocated because their tags changed. Path planning and organized-file relocation are not part of Phase 2A.
