> Phase 2E.6 raises the former 64 MiB input/candidate ceiling to 128 MiB with
> aggregate admission control. See [Large FLAC support](LARGE-FLAC.md) for the
> current range, resource costs and qualification. Earlier phase results below
> describe their original qualification bounds.

# Inline FLAC metadata editing — Phase 2D.1

Songs supports single-cell metadata editing for managed FLAC tracks through the
same production metadata eligibility and Save IPC as Track Info. Main resolves
the track ID in the active library; the renderer supplies neither a path nor a
publication strategy. It reuses the coordinator and its playback ownership,
native publication, receipt validation and recovery safeguards.

## Interaction

Double-click Title, Artist, Album, Genre, Year, Track, Disc or BPM to request
editing. These are the simple metadata columns already present in the table.
Column order and visibility determine Tab navigation. Album Artist and Composer
are not table columns and remain in Track Info, along with comments and totals. Artwork editing remains outside this phase. No columns or format-writing support are added.

- Enter submits a valid change asynchronously and exits the input immediately.
  The application keeps the pending proposal protected until main confirms the
  result. Escape cancels an unsent proposal, including during eligibility checks.
- Tab and Shift+Tab submit a valid changed value and immediately move focus in
  displayed column and row order. The destination stays read-only until Save completes and main confirms its eligibility. Further
  Tab presses can move focus while the single save is pending. Non-metadata
  columns and visibly ineligible rows are skipped locally. Main can refuse a
  provisional destination when it checks it. At either end focus returns to the
  table. Unchanged values move without a Save request.
- Clicking outside commits a valid edit. That first gesture is consumed, so an
  asynchronous refresh cannot play/select a different row beneath the pointer.
  Click again to activate the other control. Invalid input stays open and focused.
- Eligibility checks and pending saves provide screen-reader feedback. A cell
  opened during a pending save stays read-only. Routine editing has no visible
  saving, success or instruction message.
  Duplicate submissions are prevented. While Save is pending, unrelated controls
  and playback remain available where the library already allows them. If the
  user moves focus or selection, completion leaves it there.
- Failed saves keep the proposal and diagnostic reference, where available.
  Review edit returns to the source field with the proposed value. Discard edit
  clears the proposal explicitly. A failed Tab save leaves focus on the current
  cell and pauses further submissions until the proposal is resolved.

A managed-FLAC metadata double-click never falls through to playback when main
refuses eligibility. Use the existing Play control to listen. Existing double-click
playback for other formats/referenced rows and non-editable columns is retained.
Typing, arrows, Space and editor Enter/Tab/Escape do not trigger table selection
or playback shortcuts. Input-method composition is left to the text input.

The editor is scoped to Songs, including its filtered/search results. Other
Track List presentations retain their existing interactions. Navigating away or
changing library closes the old editor; late responses cannot activate a new
editor in another library. A completed same-library Save still refreshes the
catalog if the user left the table while it was pending.
The application holds one pending or failed inline proposal across Songs table
remounts. Reopen the same cell or use Review edit to recover it after a fresh
eligibility check. A failed proposal from an earlier library session remains
available to copy or discard. It cannot be submitted to the new library.

## Shared authority and validation

The existing Phase 2C eligibility call is advisory. Save repeats all main-side
sender/frame/session, managed receipt, format, root/path, operation-conflict,
Keep Organized OFF, publication and reliable idle original-file checks. Active and
paused original-file decoders remain blocked. The opt-in Phase 2E.4C isolated APFS
source exception is described in
[PLAYBACK-COMPATIBLE-METADATA.md](PLAYBACK-COMPATIBLE-METADATA.md). A saved queue/current reference alone
is not decoder ownership. Referenced files and other formats are never written.

`inlinePatch` uses Track Info's `metadataDraft` / `metadataChanges` helpers and
strict shared validation. Empty changed values clear explicitly. Untouched values
and equivalent numeric spellings produce no Save IPC or rewrite. Each changed
cell submits exactly one field patch. Comments and unrelated metadata are left
untouched.

The editor and Tab destinations use track IDs and column keys. A destination
selected before the save stays attached to that track when the table reorders.
Virtualization retains the active editor row. A confirmed Save applies the
returned metadata for the edited track while retaining later selection, drafts,
favourites, playlists and preferences. A reply for an older library session or
a superseded track record cannot overwrite the active catalog.

## Quiet editing — Phase 2D.6

Routine successful operations are visually silent. Inline editing has no
top-level saving or keyboard instruction line and no double-click/Play hint.
A persistent, visually hidden live region supplies eligibility, keyboard and
pending-save feedback to assistive technology. Validation failures and save
failures remain visible,
with the existing proposed value, Review edit and Discard edit controls.

Phase 2D.6 qualification passed 37 focused unit tests, the source and packaged
inline editing and playback harnesses, typecheck, build, format and whitespace
checks. The desktop harness checks that the routine status area has zero layout
height and retains its accessible live region. It also checks visible failed-save
controls. Rendered pending and failure states were reviewed. Fresh unsigned
x86_64 Rio.app, DMG and ZIP artifacts passed bundle identity and archive integrity
checks.

### Final Enter responsiveness correction

Enter previously left the input mounted in a read-only saving phase until the
Save reply arrived. It now closes the input immediately while the existing
application-level controller retains the pending operation. Save completion
updates confirmed metadata without selecting or refocusing the old cell.
Failure retains the proposed value and exposes Review edit and Discard edit.
The visible inline Saving label has also been removed. A failed-edit marker is
still visible.

The desktop regression holds the publication worker, verifies that Enter removes
the input and restores table focus before release, and checks quiet UI, duplicate
and conflicting input, selection, sorting and unrelated playback while pending.
Dependent test steps wait for the confirmed result rather than interpreting
editor removal as successful publication.

Final correction qualification passed the 37 focused unit tests, source and
packaged inline editing and playback harnesses, typecheck, build, format and
whitespace checks. With publication held, Enter removed the editor in 3.3 ms in
the final source run and 2.7 ms in the packaged run. Tab/Shift+Tab remained
immediate. Rendered Enter-pending UI was reviewed with no visible saving text.
Fresh unsigned x86_64 artifacts passed bundle identity and archive checks.

### First-save investigation — Phase 2D.7

The installed Rio app and the release bundle were different.
The installed renderer was `index-DsC60LVT.js` (SHA-256
`a540844afb624b9160b0dfc67694600754cb1e3885cd925ebe2b9ffab8cfd019`).
It still contained the earlier Enter `saving` phase and a routine cell marker.
An isolated installed-app run reproduced a visible blue Saving label after Tab
and a retained read-only editor after Enter while publication was held. Its
main/preload and CSS matched the current build; its renderer and HTML did not.
This is evidence of a stale installed bundle, not proof of which executable a
previous manual session used. A first-save-only label was not reproduced in the
current release.

The corrected release renderer is `index-DEjJ67ZV.js` (SHA-256
`8b9142507da7951fabfadc9c46910ef41ba747ee863ba6d5634cdc1718314cdc`).
Its only literal Saving… is Track Info's Save button, not a Songs cell. Songs has
an error-only cell marker and a clipped accessibility live region. There is no
separate initialization branch that renders a routine cell status.

The harness now measures the first changed Save after launch, subsequent saves,
and the first changed Save after restarting with the same profile/library.
Enter, Tab and Shift+Tab run with the actual publication worker reply held.
It measures input removal, focus, the next real arrow key, pointer selection,
real unrelated playback acquisition/source attachment, browser script/layout/style
costs and renderer long tasks. A mutation observer checks for transient routine
labels throughout these interactions. Save completion and fresh eligibility are
still required before conflicting editing resumes. The existing failure,
Review/Discard, duplicate, sorting, Track Info and playback cases remain intact.

Every launch verifies `app.isPackaged` and hashes the executing application's
renderer, CSS, HTML, main and preload against the current build. The renderer's
actual script and stylesheet URLs and fetched hashes must match those resources.
A stale `RIO_EXECUTABLE` cannot silently pass qualification.

Initial unchanged-product measurements with publication held:

| Case                                                  | Input removal / focus | Arrow response | Pointer selection | Play click to source / main acquisition |
| ----------------------------------------------------- | --------------------- | -------------- | ----------------- | --------------------------------------- |
| Source, first Enter, small fixture                    | 9.4 / 9.1 ms          | 1.3 ms         | 1.0 ms            | 20.0 / 0.65 ms                          |
| Existing release, first Enter, small fixture          | 10.8 / 10.5 ms        | 1.2 ms         | 0.9 ms            | 27.9 / 0.41 ms                          |
| Source, first Enter, 44,487,604-byte external fixture | 15.3 / 15.0 ms        | 1.3 ms         | 0.9 ms            | 24.3 / 0.54 ms                          |

Fresh package measurements with the same held-save conditions:

| Case                                | Input removal / focus | Arrow response | Pointer selection | Play click to source / main acquisition |
| ----------------------------------- | --------------------- | -------------- | ----------------- | --------------------------------------- |
| First Enter, small fixture          | 8.5 / 8.2 ms          | 1.5 ms         | 1.1 ms            | 18.8 / 0.39 ms                          |
| First Enter, external large fixture | 15.3 / 15.0 ms        | 1.3 ms         | 1.1 ms            | 12.2 / 0.57 ms                          |

The larger fixture was generated independently with FFmpeg, decoded successfully,
and copied into a disposable library on the local external APFS `noowners`
volume. The same held-save test measured subsequent Tab focus in 3.9 ms,
Shift+Tab in 2.8 ms and first-after-reopen Tab in 6.8 ms. No renderer long task
or visible saving label was observed. Across the whole first-Enter interaction
sequence, browser script time was 51.9 ms, layout 3.4 ms and style 8.4 ms. These
are cumulative browser costs, not a measurement of React render time alone.
Key-to-next-action totals include test-driver delivery time; event-to-response
measurements isolate application response. The next arrow response was observed
35.8 ms after the first Enter, with no readiness poll before sending that key.

No additional product correction was justified by these measurements, so this
phase changes only regression/diagnostic coverage and this report. It does not
claim a new speed improvement or change physical Save latency. Another cell
remains read-only and the edited track's playback remains protected while Save
is pending; unrelated selection and playback respond independently.

Main-process responsiveness is a separate limitation. A 5 ms sampling timer in
the test wrapper observed gaps of about 157–173 ms before worker release during
large-file saves, on both Enter and Tab. One first-after-reopen Tab sample reached
504 ms. Existing opt-in stage diagnostics measured synchronous source-journal
SHA-256 at about 101–114 ms and worker dispatch/copy at 56–63 ms. These operations
can delay main commands despite prompt renderer feedback. They are shared
backend work, not an Enter-only saving state; the 504 ms outlier was not
specifically attributed. Native publication had not yet happened in this held
interval. This phase does not optimize that work or claim whole-application
response within one frame.

Qualification passed all 497 unit tests, the full source and full packaged
desktop suites, focused source inline editing, repeated external large-file
initial-state diagnostics in source and package, typecheck, build, formatting
and whitespace checks. The fresh unsigned x86_64 Rio.app, DMG and ZIP use the
Rio name and `io.github.marcelchapman.rio` identity. DMG checksum and ZIP integrity
checks passed; their application ASAR hashes match the release app. The installed
application was not replaced.

Exploratory limitations: one optional large-file full-harness run exceeded its
existing 5-second physical-save readiness expectation; that expectation remains
unchanged. Another large-file attempt refused eligibility before submission with
the generic error. Subsequent source and packaged initial-state runs passed,
including confirmation of disk metadata and catalog ID/path after release.
The isolated eligibility refusal remains unexplained; it is not evidence of an
Enter response delay and no eligibility check was weakened to bypass it.

For a larger independently generated disposable FLAC, use
`RIO_INLINE_AUDIO_FIXTURE=/path/to/disposable.flac` and optionally
`RIO_INLINE_TEST_PARENT=/path/to/test/parent` with
`node scripts/inline-metadata.mjs --initial-only` (add `--packaged` for the
package). The harness creates and removes its own library/profile/source copies;
it does not edit the supplied fixture. Default CI fixtures require no external
encoder. The full harness includes these initial-state checks without flags.
`RIO_INLINE_DIAGNOSTICS=1` additionally captures main stderr for these disposable
tests; `RIO_METADATA_TIMING=1` retains the existing structured stage diagnostics.

## Responsive Tab navigation — Phase 2D.5

Tab previously awaited the Save IPC and then awaited eligibility for its next
destination. The editor now separates focus from submission. A single
application-owned slot holds the original proposal until confirmed success or
explicit failure resolution. Destination cells are provisional and read-only
during a save. Fresh main-process eligibility is required before typing resumes.
Rapid navigation coalesces advisory requests. There is no background save queue.

A title Save that reorders the table retains the focused track ID and column.
Failure leaves focus in place and exposes Review edit and Discard edit in the
table status. Invalid input stays at its source. Escape explicitly cancels an
unsent proposal or discards a reviewed failure. Proposed values remain in memory
across table remounts during the running application.

The source harness holds the real worker reply while the coordinator owns its
lease, drives forward/backward Tab and Enter, and checks that only one Save was
submitted. The final focused source run measured 1.6–2.9 ms from Tab keydown to
focus on the destination while publication was still held. This is navigation
latency, separate from physical publication latency. The fresh packaged Intel
app measured 1.4–3.9 ms in the same held-save test. The source suite also covers
failed Tab, review/retry, no-op Tab, validation, delayed-reply favourite
preservation, sorting, unrelated playback and the existing Track Info path.

Final Phase 2D.5 Intel macOS qualification passed all 497 unit tests, the full
source desktop suite, the full packaged desktop suite, typecheck, build,
formatting and whitespace checks. The fresh Rio.app is x86_64 with the Rio
product name and `io.github.marcelchapman.rio` bundle identifier. Signing is
disabled. Both the DMG checksum and ZIP integrity checks passed.

## Qualification

`scripts/inline-metadata.mjs` exercises actual DOM double-clicks, key input and
Save through production preload/IPC/coordinator with disposable self-contained
FLACs and isolated profiles. It supports the established `--packaged` and
`RIO_EXECUTABLE` conventions and derives Library modules from the running app's
resources. `--noowners` uses a disposable APFS image without changing a real
volume's flags. Both desktop suites include the harness.

Coverage includes all eight columns, cancellation, no-ops, invalid numbers,
Enter/Escape/Tab/Shift+Tab, outside clicks, sorting and cross-row ID navigation,
duplicate-submit prevention, a genuine permission failure and explicit retry,
active/paused eligibility, unrelated/released targets, referenced/other-format
and Keep Organized refusal, global refresh, Track Info, restart and unchanged
external source bytes/mtime. Unit coverage checks column restrictions, shared
patch/clear/validation rules, numeric no-ops and ID-based navigation.

Phase 2D.2 adds a real playback check while a save holds the coordinator's edit
lease. The harness also checks that a failed save retains its proposal when
the user navigates away before the reply. `RIO_METADATA_TIMING=1` enables
structured elapsed-time samples on disposable fixtures. The samples separate
coordinator stages, IPC elapsed time and the next renderer frame. The frame
sample includes scheduling and is not an isolated React render benchmark.

On Intel macOS, the first three matching edits on a disposable two-minute
`noowners` FLAC took 518–586 ms through IPC with the former verification pass
and 331–379 ms after removing it. The redundant pass itself took 137–157 ms.
These are small fixture samples, and I/O and scheduling varied between runs.
With a real save held pending, unrelated playback did not start during a
one-second baseline observation. It progressed in about 0.75 seconds after the
interaction change, before the save was released. The edited track stayed
blocked throughout.

The historical observation used `RIO_METADATA_TIMING_BASELINE=1`. The current
harness ignores that environment variable and reports that full acceptance is
running. To request the historical diagnostic on a compatible older build,
invoke `node scripts/inline-metadata.mjs --historical-timing-baseline` with
disposable test data. The option expects unrelated playback to time out during
the one-second held-save observation and omits the detached-draft and
unrelated-selection assertions. The harness labels this run
`historical-timing-baseline`. The standard inline, source desktop and packaged
desktop commands run full acceptance without this option.

For in-place publication, the worker projects catalog metadata from the
candidate it just verified. The coordinator checks the candidate digest before
writing and still independently rereads and verifies the published file. The
strong staged strategy retains its separate staged-file verification and
durability checks. Track Info remains modal and conflicting library operations
remain serialized.

Final Intel macOS qualification:

| Check                                                      | Result                                                                                                                                        |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused inline/metadata-editor/selection unit run          | 42 passed                                                                                                                                     |
| Final full `npm test`                                      | 483 passed across 24 files                                                                                                                    |
| Final full source `test:desktop`                           | All 18 harnesses passed, including metadata editor, real playback ownership, Track Info, inline editing and existing table/column regressions |
| Full packaged `test:packaged`                              | All 17 harnesses passed, including existing metadata/playback and Track Info regression coverage                                              |
| Source inline harness                                      | Passed; production UI/IPC path, including cancellation while eligibility is pending                                                           |
| Packaged inline harness                                    | Passed against the fresh x64 Rio.app, `app.isPackaged === true`                                                                               |
| Packaged inline on disposable APFS `noowners`              | Passed through the same UI/IPC/coordinator path                                                                                               |
| Typecheck, build, repository/doc formatting and whitespace | Passed                                                                                                                                        |

One earlier full-unit repeat hit the existing cross-volume relocation stale-read
guard (`File changed while reading`). The unchanged relocation test file then
passed all 20 tests in isolation, and the final full unit run passed all 483.
No relocation or filesystem guard was changed. The initial desktop header-selector
collision was corrected by keeping `data-column-id` on headers and using the
distinct `data-cell-column` on body cells; existing regression assertions remain
intact.

Fresh unsigned/unnotarized Intel artifacts were built with
`npm run dist:mac -- --x64 --publish never`:

- `release/mac/Rio.app`
- `release/Rio-0.1.0.dmg`
- `release/Rio-0.1.0-mac.zip`

Product name and bundle identity remain Rio / `io.github.marcelchapman.rio`; the
executable is x86_64. ZIP/app metadata and ASAR contents match, and the DMG checksum
is valid. Read-mount comparison also confirmed DMG/app Info.plist and ASAR equality;
the image was detached afterward. Packaged renderer JS/CSS match the current compiled renderer bytes.
The app was launched from build output with disposable profiles, without being
installed or published.

The Phase 2C limits still apply: managed FLAC only, Keep Organized OFF, the
existing 64 MiB bound and filesystem capability policy. Local APFS in-place
publication is not crash atomic. There is no batch editing, new writing engine,
new publication strategy or new playback ownership contract in this phase.

## Implementation files

- `src/renderer/App.tsx`: Songs/session wiring and authoritative snapshot refresh.
- `src/renderer/TrackList.tsx`: editable cells, ID selection, virtualized editor retention and distinct body-cell selectors.
- `src/renderer/use-inline-metadata.tsx`: editor navigation, advisory eligibility, keyboard/outside gestures and focus.
- `src/renderer/inline-save.ts`: application-owned single Save slot and session-bound metadata updates.
- `src/renderer/inline-metadata.ts`: existing-column mapping, shared patch validation/no-ops and ID-based Tab destinations.
- `src/renderer/style.css`: compact input, pending and validation states using the existing palette.
- `tests/inline-metadata.test.ts`: shared validation, lazy ID navigation and stale-reply catalog preservation.
- `scripts/inline-metadata.mjs`: real source/packaged UI integration and disposable noowners qualification.
- `package.json`: dedicated inline command and inclusion in both desktop suites.
- `docs/INLINE-METADATA.md` and `docs/METADATA-EDITING.md`: interaction, scope and qualification contracts.
