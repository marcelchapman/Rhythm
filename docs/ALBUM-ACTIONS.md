> Current behavior is described using the Rio name. Recorded pre-rename artifact paths and CI evidence retain the original working name Rhythm; they are historical records, not current package instructions.

# Album context actions

Baseline: `8bab79f`, following multi-selection and Track Info test stabilization. No schema, grouping, managed-file authority, playback policy or track-selection changes are introduced.

## Identity and surfaces

The scanner already assigns `albumId` from a SHA-256 hash of lowercased Album Artist, lowercased album title and the scanned audio's canonical album directory, separated by NULs. `CD1`, `Disc 2`, `disk-3` and equivalent numbered disc directory names use their parent directory for this grouping. Disc number and track title do not split or merge identities.

Album Artist falls back to performer; the compilation tag selects `Various Artists`. Missing performer becomes `Unknown artist`, missing album becomes the album-directory name. Different Album Artists with the same title remain separate; identical metadata in different source editions/directories also remains separate. Duplicate track titles remain separate track identities. Existing scan/Locate/consolidation can recalculate grouping from the resulting file location; this mission does not add reconciliation or merge albums by title.

`Library.albumTracks` validates the exact album ID and rejects missing/invalid identities. Album cards in every existing `renderAlbums` grid keep their native menu, extended with **Delete Album…** and macOS **Show in Finder**. The opened album's artwork, metadata and focusable heading also expose the album menu; Shift+F10/ContextMenu works on the heading. Compact track rows still expose their own native track menu, including selection-aware collection actions and single-clicked-track Info/Finder. No action strip or popup UI is added.

## Finder rules

`albumLocations` resolves each member through the same `Library.media` location used by playback and track reveal. It checks actual regular-file availability, canonicalizes the file path and groups parent directories by filesystem device/inode. Cached missing flags and Artist/Album folder-name guesses do not determine the result. Ownership grants no special reveal or mutation authority.

- Complete album, one physical directory: `shell.showItemInFolder(directory)` reveals that directory selected in Finder. It does not select an arbitrary representative track.
- Multiple physical directories: one native information dialog lists every available directory in deterministic path order, with its available track count. **Show Folders** reveals each listed directory; Cancel reveals nothing. Multi-disc albums can legitimately follow this rule.
- Partially missing/inaccessible: the same dialog explicitly counts unavailable tracks, lists only available folders and offers Show Folder(s) or Cancel. It never reveals a guessed or missing-file parent folder.
- All unavailable: a user-facing error suggests track-level Locate File, with no Finder handoff.

The operation uses the existing library-operation lock and re-resolves membership/paths/availability after any dialog before handing folders to Finder. A changed location set asks the user to retry. It never changes files, locations, missing flags, ownership or managed receipts. Finder presentation/IPC is macOS-only; the resolver is portable. External filesystem changes can still race a native path-based handoff; this is navigation only and grants no write/delete authority.

## Delete Album

The native album command sends the album ID and its menu membership snapshot. Main resolves current members itself and rejects a stale/mismatched snapshot before confirmation. Under the existing operation lock, one native **Delete Album** dialog names the album, explicitly counts managed and referenced tracks, and states Trash versus original-file-retention consequences. Cancel/default/Escape returns without executing deletion. Single-member albums still get album wording and ownership counts.

After confirmation, main rechecks exact membership and calls the same `Library.deleteTracks` used by track multi-selection. Its existing full location preflight and per-track worker remain authoritative. Every managed item independently needs its registered root, containment, file identity, completed receipt and digest checks; an album ID grants no Trash authority. References are removed from the database only, even when physically inside a managed root. No new filesystem deletion worker or permanent-delete fallback exists.

Successful items receive the existing transactional relationship cleanup: playlists, favourite/artwork, locations, receipts, queue and current state. Failed items remain and later items continue. The existing renderer result reconciler removes only successful IDs, reports removed/total plus retained reasons, clears decoder/media-session state for a successfully removed current track, and leaves unrelated playback running. A post-Trash database failure retains a missing identity with explicit recovery advice and pauses its buffered audio. Restore from Trash or existing track Locate File remains the recovery path. SQLite and OS Trash remain non-atomic, as documented for track removal.

## Managed album directory cleanup

The final acceptance correction enables optional directory cleanup only for **Delete Album…**, after the batch's file/identity processing. Ordinary track-removal commands retain their prior behavior. Successful managed tracks contribute candidates only after both native Trash and their database transaction succeed. References and failed items never confer cleanup authority.

Candidates come from the actual validated managed pathname and receipt-relative location under that copy's registered media root (including unchanged historical roots allowed by the existing Trash authority). Cleanup captures the complete real ancestor chain below that root and processes children first, through disc/album and artist levels. A final album removes its empty artist; another album, any unknown file or any unknown subdirectory keeps the artist in place. Flat files directly under a root contribute no directory candidate. No metadata names are used to reconstruct paths, and unrelated empty descendants are never adopted. All registered roots are protected by path and filesystem identity, including nested/historical roots. Their ancestors are also excluded so cleanup cannot cross a registered boundary, even if that root disappears externally during Trash. The current organizer stores disc numbers in filenames; the disc tests model existing registered disc directories with genuine generated managed copies and matching receipts.

Before Trash, cleanup captures root/ancestor/directory device/inode identities and canonical paths. Existing file receipt/digest validation still runs immediately afterward before native Trash. After successful deletion, cleanup reuses the existing root and symlink-component checks, verifies every captured ancestor and directory identity, reads the real directory contents, rechecks authority immediately before `rmdir`, and uses **non-recursive `rmdir` only**. The OS must still find it empty at the removal boundary. Unknown files, unknown subdirectories (even empty ones), retained tracks and concurrently arriving content preserve the directory and naturally stop upward cleanup. The narrowly authorized Finder-metadata exception is described below. Registered roots are never removed. Cancellation does not invoke cleanup.

Missing directories and directories that become non-empty are safe no-ops. Other cleanup failures return separate `cleanupWarnings`, displayed after the truthful removed/retained track summary. They never convert successfully removed IDs into failures or undo decoder/relationship cleanup. If registered-root boundaries cannot be queried, all folder cleanup is skipped and reported separately as well. A post-Trash database failure alone supplies no candidate, leaving that entry recoverable. Partial album success may remove a safely empty successful member's disc while retaining its non-empty album parent. The existing limitation of native path-based operations under hostile concurrent external replacement remains; identities and symlinks are rechecked at the handoff boundary, with no recursive fallback.

## macOS manual-failure diagnosis and Finder-metadata policy

Read-only diagnosis established that the installed and release ASARs were byte-identical (SHA-256 `58f1f2bcea067d93b3c0ccd8e7e6f198dcb40af331d1b81a55ccc2c94baef152`), both contained the full upward cleanup code, and the running executable was `/Applications/Rhythm.app/Contents/MacOS/Rhythm`. The retained `Lorraine Cato` artist contained a hidden `.DS_Store` (6,148 bytes, regular file, one hard link), so it was not actually empty. The read-only library root registry contained only the expected canonical `Music` root with its matching filesystem identity; the artist was not a registered boundary. No stale build, missing parent candidate or post-`rmdir` realpath failure caused this case.

A disposable reproduction launched the **installed application** with an isolated profile, imported generated managed audio, wrote a non-personal Finder-header fixture in the artist folder and invoked the actual renderer → preload → `album:delete` → counted confirmation → `Library.deleteTracks` → native Trash path. It removed the audio and album but retained precisely `[".DS_Store"]` in the artist; the new artist-removal assertion failed. Earlier automated tests created genuinely empty artists and deliberately treated all unknown files as retention reasons. They did not model a Finder-created file at the final artist level; the old policy also explicitly retained `.DS_Store`. The user then authorized a separate Finder-metadata exception.

The exception remains within Delete Album's existing successful-managed-deletion lifecycle:

- Every candidate still derives from a successfully trashed **and database-committed** managed track's actual location. The complete registered-root, canonical-path, symlink and directory-identity checks remain in force; protected roots are filtered before even inspecting metadata.
- Only the exact `.DS_Store` name, as the **sole remaining entry**, is eligible. It must be a regular, non-symlink file with exactly one hard link and a recognizable version-1 `Bud1` allocation header (matching repeated offset and an allocation extent contained within the file). This is conservative header recognition, not a complete Finder database parser. Other versions/formats, unknown files and other dotfiles are retained.
- Reading uses `O_NOFOLLOW`; handle/path device, inode, size, modification/change time, canonical location and link count are checked. The captured directory lineage and sole-entry condition are rechecked before handoff, as is the metadata identity. Metadata is sent to the **same native Trash adapter**, with no permanent-unlink fallback.
- After Trash, directory authority and real filesystem contents are checked again. Only non-recursive `rmdir` may remove the now-empty folder, then the existing child-first process considers its parent. Another album, unknown file or unknown directory prevents metadata cleanup at that level. Recreated Finder metadata or concurrently arriving entries preserve the directory.
- References, registered roots (including nested/historical roots) and ordinary track removal receive no metadata-cleanup authority. Cancel invokes neither audio nor metadata Trash. A metadata Trash failure remains a separate folder-cleanup warning; track deletion remains truthfully successful.

The pre-existing limitation of path-based native handoffs under hostile concurrent external replacement remains; the exception does not introduce recursive deletion or relax any existing authority check. No production library file was changed during diagnosis or validation.

## Automated coverage

`tests/albums.test.ts` adds nine cases for exact artist/edition membership with duplicate titles; Album Artist and compilation fallbacks; multi-disc identity and split directories; untagged fallback identities; actual availability versus cached flags; managed/mixed physical locations and relationship/restart cleanup; invalid receipt protection within an album; and invalid/absent IDs. All generated source bytes and mtimes are checked after every case.

`scripts/albums.mjs` runs through real renderer/preload/main native-menu callbacks in isolated source and packaged applications. It covers album card/details artwork/heading targeting, intact track-row menus, stale membership rejection, single/split/partial/all-missing Finder behavior, split-dialog cancellation, all-reference/all-managed/mixed counted deletion and cancellation, same-title artist isolation, multi-disc membership, real advancing audio, current decoder/media-session cleanup, unrelated playback continuity, receipt rejection with partial completion, post-Trash SQLite failure, restart, track Locate/retry, relationship cleanup and unchanged original hashes/mtimes. Native Finder handoffs/dialogs are captured; real OS Trash is restricted to disposable managed paths (audio and eligible generated Finder metadata) and explicitly refuses all original fixture paths. Tests never inspect or mutate the real library and never empty OS Trash.

Both complete desktop commands include this suite; `npm run test:albums` runs it alone. Existing selection, track Finder/Info, managed authority, removal, playback recovery, source launch, column persistence, virtualization, playlist interchange and codec suites remain intact.

`tests/managed-album-cleanup.test.ts` adds 46 cases covering final-album/artist cleanup and restart, other albums retaining an artist, unknown files/subdirectories at album and artist levels, unchanged ordinary track removal, external and in-media reference trees with sole Finder metadata, late content, partial receipt failure, complete/partial disc cleanup, unknown empty disc retention, flat-root preservation and arbitrary actual managed ancestor chains, nested/historical roots (including an externally moved root stopping upward cleanup), post-Trash database failure, separate cleanup-boundary query failure, album/artist/root symlink substitution, inode replacement and traversal/sibling-prefix boundaries. All original source bytes/mtimes are checked. Additional Finder cases cover the exact artist-level failure after album removal; metadata at disc/album/artist levels; sibling retention; unknown entries alongside metadata; malformed headers, symlinks, hard links and directories named `.DS_Store`; partial audio deletion; metadata Trash failure; arriving content and directory substitution after metadata Trash; and untouched root/reference metadata. The source/packaged album script additionally checks actual native confirmation/cancellation directory snapshots, real Trash followed by empty album/artist removal, another album retaining an artist until its own deletion, artist-level unknown content retention, partial failure/retry, nested-root preservation and a separate truthful cleanup-warning banner after directory replacement.

## Validation

Validated on Intel macOS 15.8.1 with Node 26.12.0 / Electron 44.9.2:

| Check | Result |
|---|---|
| `npm run typecheck` | Passed |
| `npm test` | All 169 tests in 11 files passed, including nine album cases and 46 managed directory-cleanup cases |
| Focused `node scripts/albums.mjs` | Passed, including the formerly failing sole-Finder-metadata artist case |
| `npm run test:desktop` | All 11 source suites passed |
| `npm run dist:mac -- --x64 --publish never` | Intel app, DMG and ZIP built without publishing |
| `npm run test:packaged` | All 10 packaged suites passed |
| `npm run test:codecs` | MP3, M4A, raw AAC, Ogg Vorbis and Opus indexing/real decoding/seeking passed |
| Package freshness | All 15 compiled files match ASAR; ZIP ASAR matches the tested app (`75391051019788d9481d77899129e534073d6647b88b186d70556953d23a9a1a`); no fixture audio, tests or databases bundled |
| Package integrity | `hdiutil verify`, `unzip -tq`, `plutil -lint` passed; Mach-O executable is x86_64 |
| Formatting / script syntax / diff | `npm run format:check`, `node --check scripts/albums.mjs`, `git diff --check` passed |
| Original-media safety | Source bytes/hashes and mtimes unchanged; only disposable managed audio and eligible generated Finder metadata reached real OS Trash |

The album test waits for real advancing audio plus the persisted current ID, and playback cleanup waits for both cleared decoder/media-session state and persisted null current ID. The directory-cleanup correction adds native fault injection for a replaced empty directory, using Electron's builtin filesystem access because dynamic imports are unsupported in the test evaluate VM. The root-protection unit case removes only the already-empty temporary staging directory during setup so it proves a genuinely empty Media root survives. No product playback assertion or existing test was weakened. The first full source run timed out in the existing pointer header-drag persistence check in `scripts/interchange.mjs:105`; that suite passed unchanged in isolation and in the full rerun. No unrelated drag test or product behavior was changed.

Artifacts: `release/mac/Rhythm.app`, `release/Rhythm-0.1.0.dmg`, `release/Rhythm-0.1.0-mac.zip`. Packages remain unsigned/unnotarized under the established configuration. No application was installed over `/Applications/Rhythm.app`, the production library was inspected only through read-only diagnostics (never opened for write), and no stage/commit/push occurred. Sacrificial managed files and generated Finder metadata may remain in OS Trash; tests never empty it. Native Finder/menu/dialog appearance and audible output still require manual acceptance. Ubuntu requires its hosted CI run; Linux album-menu presentation is guarded and portable domain coverage passed locally, but no Linux runtime was available here.

## Files changed

- `src/domain/library.ts`: exact album membership and read-only physical folder resolution through playback locations.
- `src/domain/managed-copy.ts`: bounded managed directory snapshots and canonical/identity/symlink checks around non-recursive empty-directory removal. `library.ts` collects candidates only from successful managed deletions and keeps cleanup warnings separate from track outcomes.
- `src/main/main.ts`: album native menu actions, Finder dialogs/handoff, shared counted confirmation and guarded exact-membership deletion entry point.
- `src/main/preload.cts`, `src/shared/types.ts`: typed album IPC/action routing.
- `src/renderer/App.tsx`: album action dispatch through existing removal reconciliation and details-header/artwork contexts.
- `tests/albums.test.ts`, `tests/managed-album-cleanup.test.ts`, `scripts/albums.mjs`, `package.json`: unit/source/packaged album coverage and suite commands.
- `README.md`, `PRODUCT.md`, `docs/ARCHITECTURE.md`, `docs/TRACK-REMOVAL.md`, `docs/ALBUM-ACTIONS.md`: current album behavior, safety contract, validation and manual acceptance.

The empty-directory acceptance correction specifically changes `src/domain/managed-copy.ts`, `src/domain/library.ts`, `src/main/main.ts`, `src/shared/types.ts`, `src/renderer/App.tsx`, `tests/managed-album-cleanup.test.ts`, `scripts/albums.mjs`, `README.md`, `docs/TRACK-REMOVAL.md` and this report. Earlier uncommitted album-action changes are preserved.

The final artist-chain refinement changes only `src/domain/managed-copy.ts`, `src/domain/library.ts`, `tests/managed-album-cleanup.test.ts`, `scripts/albums.mjs`, `README.md`, `docs/TRACK-REMOVAL.md` and this report. It supersedes the earlier intentional artist-directory retention.

The Finder-metadata correction changes only `src/domain/managed-copy.ts`, `src/domain/library.ts`, `tests/fixtures.ts`, `tests/managed-album-cleanup.test.ts`, `scripts/albums.mjs`, `README.md`, `docs/TRACK-REMOVAL.md` and this report. Earlier uncommitted changes remain intact.

## Manual macOS acceptance

Use a disposable library and sacrificial media. Right-click album cards, details artwork and heading; compare with a right-click on a selected track row. Check existing album collection commands, both new labels and keyboard context activation. Confirm Finder actually selects the folder for reference, managed and mixed albums; test multi-disc/split and partial/all-missing cases, including Cancel. Confirm the album-named ownership counts for all three ownership mixes, cancel without mutation, and accept only sacrificial deletion. Verify Trash contains the managed copies and, where applicable, recognized sole Finder metadata; reference originals remain intact, unrelated albums/playback remain available, current-player cleanup and restart persistence. Delete an artist's final album after browsing its artist folder in Finder (so it can contain `.DS_Store`); verify the album and artist disappear while the media root stays. Use Finder’s Show Hidden Files (⌘⇧.) to distinguish actual contents. Confirm generated metadata is recoverable in Trash. A pre-existing orphan artist folder is not adopted retroactively; test a newly deleted final album. Repeat with another album, an artist-level unknown file and an unknown subdirectory: only the empty album should disappear. Confirm nested/historical roots remain intact. Test recovery of a retained failed member through Locate. No installed application is replaced automatically.
