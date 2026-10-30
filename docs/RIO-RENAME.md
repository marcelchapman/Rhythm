# Rio pre-release identity migration

The active application/project identity is Rio. Baseline: `c4802e7`.
This is a clean pre-release rename, without aliases or migration of data from the
former working-name application. Repository directory, remote and Git history
remain unchanged. No stage, commit, push, GitHub administration or installation
is part of this mission.

## Identity changes

Historical-to-current mapping (old names here are explanatory history only):

| Previous working-name identity | Active identity |
| --- | --- |
| Rhythm / rhythm-desktop | Rio / rio-desktop |
| org.rhythm.desktop | io.github.marcelchapman.rio |
| RhythmAPI / window.rhythm | RioAPI / window.rio |
| rhythm:// / rhythm-media:// | rio:// / rio-media:// |
| RHYTHM_* | RIO_* |
| rhythm.sqlite / SQLite application ID 0x5248544d | rio.sqlite / application ID 0x52494f00 (ASCII RIO + NUL) |
| .rhythm-imports / .rhythm-publication-* / .rhythm-playlist-* | .rio-imports / .rio-publication-* / .rio-playlist-* |
| application/x-rhythm-track-ids / application/x-rhythm-song-column | application/x-rio-track-ids / application/x-rio-song-column |
| Rhythm Media | Rio Media |

App/menu/window labels, native messages, profiles, preload/types, CSP/protocol
allowlists, managed staging names, publication test macro, test globals/temporary
fixtures, lab scripts, package/lock metadata, icons, CI artifact labels and current
documentation use Rio. The native workspace-name length is derived from its new
prefix plus the unchanged UUID length. SQLite's application marker changes, but
schema versions, track/playlist/state semantics and ownership rules do not.
Metadata writer implementation, publication operations/barriers, symlink/root/
identity protections, production sandboxing and test assertions remain intact.

## Artwork and UI

Original owner-supplied white/black logos, desktop/mobile prototypes and GitHub
banner remain byte-for-byte unchanged. Their SHA-256 values were recorded before
editing and rechecked afterward. The two prototype deletions and five added owner
assets were already present at mission start and are retained as provided.

- `artfiles/rio-logo-white.png`: original handwritten logo, never replaced by type.
- `assets/rio-wordmark.png`: separate transparent UI derivative; sidebar,
  first-run screen and promotional page use the artwork.
- `build/rio.png`: 1024px PNG application icon, original handwriting on the
  established dark navy tile.
- `build/rio.icns`: regenerated macOS icon with all existing iconset sizes.
- `assets/rio-github-banner.png`: README presentation banner.
- `artfiles/rio-desktop-prototype.png` and `artfiles/rio-mobile-prototype.png`:
  current references; no broader UI/prototype redesign was implemented.

`npm run icons` regenerates derivatives without modifying sources. The PNG helper
uses Node's existing standard library and only accepts the supplied RGBA PNG
profile. No dependency was added. Independent FFmpeg decoding agreed pixel-for-
pixel for the original logo and both PNG derivatives. ICNS is regenerated each
time, avoiding the old pipeline's stale-file behavior. A restricted iconutil run
failed; native macOS execution outside the sandbox succeeded.

## Historical-name audit

No old identity remains in active source, native code, scripts, tests, package
metadata, workflow or promotional HTML. Deliberate exceptions:

- `PRODUCT.md` names the separate third-party application Rhythmbox; this is not
  the product's former identity and must not be renamed.
- `docs/ORIGINAL_SPECIFICATION.md`, `docs/VALIDATION.md`, and `docs/ITERATION-1.md`
  are explicitly archived pre-rename records. Their claims, original artifact
  names and commands are retained rather than rewritten as Rio validations.
- `docs/ITERATION-2.md`, `docs/ITERATION-3.md`, `docs/ALBUM-ACTIONS.md`,
  `docs/LIBRARY-SUMMARY.md`, `docs/MULTI-SELECTION.md`, and
  `docs/PLAYLIST-CONTEXT-MENU.md` use Rio for current contracts/instructions while
  retaining clearly labeled historical artifact paths, installation observations,
  the captured old drag MIME diagnostic, and a valid old repository CI link.
- This rename report records the historical-to-current mapping and exceptions.
- The local repository directory and GitHub repository name remain unchanged as
  requested. Absolute workspace paths in diagnostics/caches still contain that
  directory name.
- Git history, ignored previous release/build/lab evidence, installed external
  applications and external dependency/skill text were not rewritten. Generated
  outputs are not source for the identity audit; current Rio outputs are rebuilt.

## Application identifier correction — 2026-10-29

The active bundle/application identifier is `io.github.marcelchapman.rio`.
Linux `desktopName` is `io.github.marcelchapman.rio.desktop`; the existing
`syncDesktopName: true` makes the desktop filename and StartupWMClass agree.
Only package identity, package-validation assertions/tests and this report changed
in this correction. No aliases, feature changes, artwork edits or installation.

Correction validation (separate from the original migration checks below):

- Typecheck, production build and formatting of correction files passed.
- Complete unit regression: 342 tests / 17 files passed, including rejection of an
  incorrect packaged CFBundleIdentifier and actual electron-builder Linux desktop
  generation checks for the filename and StartupWMClass.
- macOS x64 Rio.app, DMG and ZIP rebuilt with `--publish never` and
  `npmRebuild=false`; existing icon assets reused unchanged. The initial sandbox
  packaging attempt failed on GitHub DNS; the network-enabled rerun passed.
- Real bundle plist and packaged ASAR desktopName match the corrected identity;
  package discovery validates bundle identity and desktop metadata as well as
  the existing native manifest/hash checks.
- ZIP CRC, embedded bundle identifier and ASAR equality with the tested bundle:
  passed. DMG checksum: passed. Packaged smoke test: passed (20 tracks; fresh
  setup, playback/seeking, library operations and restart persistence).
- Exhaustive text audit outside Git internals and external dependencies found no
  remaining superseded identifier in source/current docs, dist or rebuilt Rio
  outputs. Ignored previous releases remain historical evidence; Linux runtime
  and full Linux packaging still require native Ubuntu validation.
- Working tree remains unstaged; no commit, push or GitHub administration.

## Original migration validation

| Check | Result |
| --- | --- |
| Typecheck / build | Passed |
| Complete unit regression | 340 tests / 17 files passed, including publication and metadata writer coverage |
| Node publication qualification | 3 production-only + 32 existing mixed scenarios passed |
| Source Electron publication qualification | 3 production-only + 32 mixed scenarios passed |
| Native warning checks | Production and test builds pass Clang -Wall -Wextra -Werror and explicit misleading-indentation checks |
| Artwork preservation / independent decoding | Passed |
| Source desktop regression | All 13 suites passed |
| macOS Intel packaging | Rio.app + DMG + ZIP built with --x64 --publish never; no installation |
| Packaged desktop / publication / codecs | All 12 desktop suites, 3 production-only + 32 mixed publication checks, and 5 codec playback/seek checks passed |
| Package integrity / provenance | Correct x64 Rio bundle/plist/icon; all 24 compiled files match ASAR; native addon unpacked and hooks excluded; ZIP CRC + DMG checksum valid; ZIP and read-only mounted DMG payloads match tested bundle |
| Workflow YAML / lockfile names | Passed; read-only permissions and --publish never retained |
| Formatting / final diff / identity audit | Passed; no unexplained active old-name occurrences and Git index remains empty |

Startup coverage additionally checks the real `npm start` process name, document
title, decoded Rio wordmark and source-instance lock. Library tests additionally
check the persisted Rio application identifier and reopening.

Linux builds/runtime cannot be qualified on this macOS host: the existing Ubuntu
workflow remains the native portability check, with Rio artifact labels. Cross-
OS native packaging remains rejected by the existing publication build guard.
Native arm64 and Ubuntu validation require GitHub Actions after human review.

## Fresh local artifacts and review

- `release/mac/Rio.app`
- `release/Rio-0.1.0.dmg`
- `release/Rio-0.1.0-mac.zip`

The DMG was attached read-only only for payload comparison and detached. Nothing
was installed. Bundle display/name/executable are Rio, identifier is
`io.github.marcelchapman.rio`, and package name is `rio-desktop`. Packages retain the existing
unsigned/unnotarized configuration. The tested ASAR SHA-256 is
`5c2840aa9831f1170662d688dec4980dfa777f21b3dd01df0e975da419e2b452`; production native addon SHA-256 is
`82cc73bccec0a9f5de477f7990fab17786c92c7db53d3f3eb9ca01481dbcc695`.

Manual review should confirm Finder/Dock icon legibility at small sizes, native
Rio menu/dialog labels, and expected first-run behavior with a fresh Rio library.
Audible output was not assessed: codec fixtures contain generated silence. Do not
expect the old application profile/library to be adopted; this is intentionally
a clean pre-release identity. The old installed app remains untouched. Ubuntu and
native arm64 qualification require hosted CI. A Linux package is not claimed from
this macOS build.

## Exact working-tree manifest

94 paths: 79 modified, 5 deleted, 10 added/untracked (including the seven
pre-existing owner input changes).

Git status notation: M = modified, D = deleted, ?? = added/untracked. This includes
user-provided inputs. No files are staged. Ignored package outputs are separate.

```text
 M .github/workflows/build.yml
 M .impeccable/design.json
 M DESIGN.md
 M PRODUCT.md
 M README.md
 D artfiles/desktop_prototype.png
 M artfiles/index.html
 D artfiles/mobile_prototype.png
?? artfiles/rio-desktop-prototype.png
?? artfiles/rio-logo-black.png
?? artfiles/rio-logo-white.png
?? artfiles/rio-mobile-prototype.png
 D assets/rhythm-github-banner.png
?? assets/rio-github-banner.png
?? assets/rio-wordmark.png
 D build/rhythm.icns
 D build/rhythm.png
?? build/rio.icns
?? build/rio.png
 M docs/ALBUM-ACTIONS.md
 M docs/ARCHITECTURE.md
 M docs/FLAC-METADATA-WRITER.md
 M docs/ITERATION-1.md
 M docs/ITERATION-2.md
 M docs/ITERATION-3.md
 M docs/LIBRARY-SUMMARY.md
 M docs/MULTI-SELECTION.md
 M docs/NATIVE-PUBLICATION.md
 M docs/ORIGINAL_SPECIFICATION.md
 M docs/PLAYLIST-CONTEXT-MENU.md
?? docs/RIO-RENAME.md
 M docs/TRACK-REMOVAL.md
 M docs/VALIDATION.md
 M labs/taglib-wasm/README.md
 M labs/taglib-wasm/REPORT.md
 M labs/taglib-wasm/asar-probe.mjs
 M labs/taglib-wasm/edges.mjs
 M labs/taglib-wasm/electron-main.mjs
 M labs/taglib-wasm/lab.mjs
 M labs/taglib-wasm/package-lock.json
 M labs/taglib-wasm/package.json
 M labs/taglib-wasm/qualify.mjs
 M labs/taglib-wasm/report.mjs
 M native/publication.cc
 M package-lock.json
 M package.json
 M scripts/acceptance.mjs
 M scripts/albums.mjs
 M scripts/build-publication-native.mjs
 M scripts/codecs.mjs
 M scripts/create-icon.mjs
 M scripts/features.mjs
 M scripts/interchange.mjs
?? scripts/lib/brand-image.mjs
 M scripts/lib/publication-package.mjs
 M scripts/lib/publication-qualification.mjs
 M scripts/managed.mjs
 M scripts/playback-recovery.mjs
 M scripts/playlist-menus.mjs
 M scripts/recovery.mjs
 M scripts/removal.mjs
 M scripts/smoke.mjs
 M scripts/startup.mjs
 M scripts/summary.mjs
 M scripts/track-info.mjs
 M src/domain/library.ts
 M src/domain/managed-copy.ts
 M src/domain/media-plan.ts
 M src/domain/playlist-files.ts
 M src/domain/publication.ts
 M src/main/main.ts
 M src/main/preload.cts
 M src/renderer/App.tsx
 M src/renderer/TrackList.tsx
 M src/renderer/env.d.ts
 M src/renderer/index.html
 M src/renderer/style.css
 M src/renderer/track-columns.ts
 M src/shared/types.ts
 M tests/albums.test.ts
 M tests/interchange.test.ts
 M tests/iteration.test.ts
 M tests/library.test.ts
 M tests/managed-album-cleanup.test.ts
 M tests/managed.test.ts
 M tests/media-source.test.ts
 M tests/metadata-fixtures.ts
 M tests/metadata-writer.test.ts
 M tests/playlist-actions.test.ts
 M tests/publication-package.test.ts
 M tests/recovery.test.ts
 M tests/removal.test.ts
 M tests/summary-metadata.test.ts
 M tests/tracklist.test.ts
```
