# Context-sensitive library summary

Baseline: `81f30a7` (album actions and managed cleanup). This mission adds passive collection information; it does not change album identity, search/filter semantics, selection, playback, ownership, deletion or the SQLite schema.

## Collections and presentation

The workspace footer sits outside `.main-scroll`, in normal flex layout above the existing player. It uses 11px muted system typography and tabular numerals, with no card, control, border or accent. Scrolling content gives up the footer's real height rather than sliding underneath it. The details pane uses the same component below its existing `.detail-panel` scroller. That scroller, pagination and context targeting remain intact.

The existing rendering branches and their source arrays determine scope:

| Surface | Represented collection | Display |
|---|---|---|
| Songs | Existing filtered `visible` tracks | Songs · duration · storage |
| Individual playlist | Valid IDs in playlist order, through the existing `visible` filter | Songs · duration · storage |
| Selected artist | Existing performer **or** Album Artist match, then current filters | Songs · duration · storage |
| Selected genre | Existing genre membership, then current filters | Songs · duration · storage |
| Favourites | Existing favourite filter, then current filters | Songs · duration · storage |
| Search | Existing global search results across title/artist/album/genre/comments/codec, including search started inside a playlist | Songs · duration · storage |
| Albums/Home/Recently Added grid | Full membership of the existing `visibleAlbums` cards | Albums · storage |
| Home/Recently Added track layout | Existing `visible` tracks | Songs · duration · storage |
| Artist/Genre directories | Complete library represented by the existing directory cards | Songs · duration · storage |
| Playlists directory | Distinct valid member IDs across its playlist cards | Playlists · storage |
| Individual album in details | Full `rightAlbum.tracks`, including tracks beyond the first 200 rendered rows | Songs · duration · storage |
| Queue | Existing valid queue entries, including beyond pagination | Songs · duration · storage |

Home's recent-album strip does not double-count albums also represented in its main grid. Recently Added currently sorts the full collection rather than imposing a new date window. A genre-filtered album card continues to represent its full album, even when only one member caused the card to match. The existing root Artist/Genre directories use all tracks; this mission does not change their filter behavior. Search retains the app's existing global precedence. A track-list layout uses its actual filtered tracks instead of whole-album membership.

Album counts use only the scanner's existing `albumId` values. Same-title identities stay distinct, and the scanner's existing CD/Disc-directory grouping stays intact. There is no second album key. The center footer never follows track selection or the album shown in the right pane; each pane summarizes its own collection. Row selection, local table sorting, column presentation, player time updates and compact-list pagination do not alter represented membership.

## Indexed data

SQLite already persists `tracks.size` (actual `stat.size` bytes) and `tracks.duration`, including in existing schema versions. The only model extension is exposing `size AS fileSize` through `Library.tracks` and the shared `Track` snapshot type. Invalid/non-integer/negative/unsafe stored sizes become `null`; zero bytes is a known value. No migration, startup backfill, bitrate estimate or extra filesystem access was added.

The existing scanner stores size from the resolved indexed audio file. Managed import switches to the published copy before indexing; Locate/recovery and consolidation use that same serialized scanner/upsert. Therefore a replacement's actual size updates under the preserved track ID, and managed copying retains accurate byte totals. Rescans refresh stale indexed metadata. Missing/unmounted files retain their last indexed size and duration until a successful reindex; summaries describe indexed data rather than claiming a live disk inventory. The footer's tooltip explains this.

Sources and fixtures remain read-only during product operations. The metadata tests alter only their disposable SQLite records to simulate unavailable paths/stale caches and generate new replacement sources; they check original bytes and mtimes after every case.

## Formatting and unknown values

All aggregation and formatting lives in `src/shared/collection-summary.ts`, with explicit English number formatting independent of the host locale.

- Counts use singular/plural English nouns and thousands separators.
- Duration sums positive finite indexed durations as integer microseconds before converting back to seconds. This keeps addition order from changing displayed boundary values when sorting fractional durations. Nonpositive/nonfinite/unrepresentable durations count as unknown.
- Empty duration is `0 min`. Positive durations below one second show `<1 sec`; below a minute use whole seconds; below an hour use whole minutes; below a day use whole hours and remaining whole minutes (omit zero minutes). Days round to one decimal, omitting a trailing zero: `1 day`, `3.7 days`, `12,000 days`.
- Storage uses **decimal SI**, consistently: MB = 1,000,000 bytes, GB = 1,000,000,000 bytes, TB = 1,000,000,000,000 bytes. Select GB at 1 GB and TB at 1 TB; otherwise MB. Show at most two fractional digits, with trailing zeros omitted. Zero is `0 MB`; positive totals below 10,000 bytes show `<0.01 MB` instead of a misleading zero.
- Empty track collections show `0 songs · 0 min · 0 MB`; empty album grids show `0 albums · 0 MB`.
- If all durations/sizes are unavailable, show `Duration unknown` / `Size unknown`. If some are known, show the known subtotal plus `+ unknown`, for example `2 songs · 1 min + unknown · 4 MB + unknown`. The tooltip counts affected tracks. Counts still include every represented track. No NaN, undefined or fabricated byte estimates are displayed.

## Performance

Aggregation is one in-memory pass, O(N) time and O(distinct album IDs) space. Represented membership and each component's totals are memoized. Selection, player time and unrelated dialog renders do not rerun aggregation when the input array is unchanged. Sorting the parent collection may recompute its totals, but integer byte/microsecond sums leave the result invariant. There are no renderer filesystem calls, additional IPC requests or per-row DOM requirements.

A 50-run local measurement over 10,000 synthetic tracks gave a median of **0.218 ms**, p95 **0.959 ms** and maximum **4.036 ms** for aggregation on the development host. This is an observed sanity measurement, not a brittle CI timing threshold. The existing native 10,014-track scenario now verifies the full collection's summary while fewer than 80 rows are rendered, after column dragging/scrolling and after compact multi-selection. Its 230-track album summary includes the 30 rows not yet paginated into the DOM. Synthetic entries are explicitly benchmark data with indexed metadata and unavailable locations, never user-library records or estimated real media sizes.

## Coverage and validation

`tests/collection-summary.test.ts` covers exact count/duration/size formatting, empty/partial/unknown metadata, established album IDs, fractional-duration sort invariance and 10,000-track aggregation. `tests/summary-metadata.test.ts` covers existing persisted sizes, mixed ownership, unchanged schema version, unavailable paths, stale-size rescan, reference and managed Locate replacement, consolidation, restart and original byte/mtime preservation.

`scripts/summary.mjs` exercises the actual source/packaged renderer with a disposable mixed-ownership library: every view in the table, global search from a playlist, genre filters and whole-album card membership, same-title separate identities and real multi-disc grouping, multi-selection and sorting, playlist order preservation, an empty playlist/search, offline known metadata, partial/wholly unknown metadata after restart, queue scope and footer/content/player boundaries at 1464/1250/1050/980px. It captures native-app screenshots in `.impeccable/review/summary-*.png`. Originals remain byte/mtime-identical. The summary suite is included in both complete desktop commands; `npm run test:summary` runs it alone. Existing playback, removal, Finder, managed safety, column and codec suites remain in place.

Validated on Intel macOS 15.8.1 with Node 26.12.0 / Electron 44.9.2:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | All 205 tests in 13 files passed, including 36 new summary/metadata cases |
| `npm run test:desktop` | All 12 source suites passed |
| Final focused `npm run test:summary` | Passed after refining metric wrapping; strict text and geometry assertions preserved |
| `npm run dist:mac -- --x64 --publish never` | Final Intel app, DMG and ZIP built without publishing |
| `npm run test:packaged` | All 11 suites passed against the final packaged app |
| `npm run test:codecs` | MP3, M4A, raw AAC, Ogg Vorbis and Opus indexed, decoded and sought successfully |
| Large renderer collection | 10,014 tracks summarized with 26 rendered table rows in both source and packaged runs; 230-track album pagination/selection preserved |
| Visual/layout | Rendered inspection at 1464px and 980px, plus automatic bounds checks at 1464/1250/1050/980px; unknown metrics wrap together without covering content/player |
| Package freshness | All 16 compiled files match ASAR; ZIP ASAR equals tested app (`b27f316167064c10c66c0b74ad8d4269c7f80a37b9d52d8b032718ec549bbc2e`); no tests, source audio fixtures or databases bundled |
| Package integrity | DMG checksum verification, ZIP test and plist lint passed; executable is Mach-O x86_64 |
| Formatting/syntax/diff | `npm run format:check`, `node --check` for both changed integration scripts, and `git diff --check` passed |
| Media safety | Original fixture bytes/hashes and mtimes unchanged across the relevant suites; no production library or source media was opened for modification |

Final artifacts are `release/mac/Rhythm.app`, `release/Rhythm-0.1.0.dmg` and `release/Rhythm-0.1.0-mac.zip`. They remain unsigned/unnotarized under the existing configuration. Nothing was installed over `/Applications/Rhythm.app`; the Git index remains empty, with no stage/commit/push. Codec fixtures contain generated silence, so audible output was not assessed. Ubuntu runtime validation requires its hosted CI canary; no Linux runtime was available locally.

## Manual macOS acceptance

Quit the older installed/source app before launching a newly built application. Confirm that the understated center footer follows Songs, playlist, artist, genre, favourites, search and album-grid membership; select several rows and sort/reorder without changing totals. Select a multi-disc album and confirm the separate right footer covers its complete list, including tracks beyond Show More. Scroll both panes independently and resize to the minimum desktop width; neither footer may overlap rows, cards or playback. Check mixed ownership and last-indexed totals for unavailable media, then relink a disposable track to a different-size file and confirm its summary refreshes. Audible playback and real-library visual acceptance remain manual. No app is installed automatically; no stage, commit or push is performed.

## Files

`src/shared/types.ts`, `src/shared/collection-summary.ts`, `src/domain/library.ts`, `src/renderer/CollectionSummary.tsx`, `src/renderer/App.tsx`, `src/renderer/style.css`, `tests/collection-summary.test.ts`, `tests/summary-metadata.test.ts`, `scripts/summary.mjs`, `scripts/features.mjs`, `package.json`, `README.md` and this report.
