# Rhythm 0.1 implementation decisions

## Desktop stack

Electron 44, React 19, TypeScript, and Vite implement the approved desktop prototype. Electron's bundled Chromium gives macOS and Linux the same layout and audio API instead of relying on different system WebView codec support. The cost is a larger download and memory footprint. This is a desktop decision: Electron does not target Android or iOS.

Tauri was considered for its smaller runtime and mobile targets. For this milestone, its system-WebView differences and platform-dependent audio support add risk to the central playback requirement. Qt would require another UI implementation approach to match the supplied composition. Native Swift alone would not serve Linux. These trade-offs favor a working, consistent desktop core now.

The renderer and shared DTOs contain no filesystem or SQLite access. `src/domain/library.ts` owns indexing, normalization, persistence, and playlists independently of Electron. A future mobile client can share TypeScript models and domain rules, but needs filesystem, database, and playback adapters; this is a credible reuse boundary, not a claim that the desktop implementation runs unchanged on mobile.

## Data and music safety

The user chooses a directory for `rhythm.sqlite`. Source music directories are chosen separately. A small pointer in Electron's application-data directory remembers the library. No library or source directory is supplied by the distribution. Tests override only application data using `RHYTHM_DATA_DIR` and use temporary libraries.

SQLite uses WAL, foreign keys, an application ID, and schema version 2. Unrelated databases and newer schema versions are rejected. The version-1 migration adds nullable BPM/bit rate, comments, codec, and an extraction-version marker in one transaction. No existing rows are replaced. A rescan reparses older extraction versions even when source size/mtime is unchanged, preserving favourites, added dates, IDs, and playlist links. Absent numeric tags remain null and absent strings remain empty. The main process owns the database. Scanning asynchronously walks directories and reads metadata using `music-metadata`; database statements are synchronous, so very large libraries can still cause UI latency during snapshot generation. Scans are serialized. Read failures are bounded to 100 reported issues per scan.

Source files are never written, copied, renamed, or deleted. Symlinks and hidden entries are skipped. Canonical paths prevent duplicate indexing of the same path. File size and modification time avoid repeated metadata parsing. Track identity is the canonical path hash, so a moved file becomes a new record; missing records and playlist references are retained, not silently discarded. Matching files by content after moves is deferred.

External file/folder drops use Electron's `webUtils.getPathForFile` inside the sandboxed preload. Only a bounded list of absolute disk paths reaches the existing scanner; unsupported files are skipped. Individual files and folders are retained as rescan sources. Internal drags carry validated track IDs, not arbitrary file-operation instructions. Playlist append checks current database contents in a transaction, preserves order, and deduplicates additions; it never overwrites a playlist from a stale renderer snapshot.

Albums group by album artist, title, and album directory. Compilation tags use Various Artists when no album artist is present. `CD1`/`Disc 1` folders normalize to their parent. Different directory editions with identical metadata remain distinct. Artwork is cached in SQLite only for supported raster formats up to 10 MB per track. External cover files are not currently searched.

## Playback and state

HTMLAudioElement performs local decoding. `rhythm-media://track/<id>` resolves only indexed IDs, never renderer-supplied filesystem paths. Explicit byte-range responses support seeking without loading entire files into memory. Missing files return 404; decoding failures show an actionable error. AIFF metadata can be indexed but Chromium may not play AIFF. DRM content is unsupported.

The persistent player records queue, current track, position, volume, shuffle, repeat mode, and navigation. State is debounced and checkpointed every four seconds; a forced termination can lose the last few seconds. Reopening restores selection and position but does not start playback automatically. Queue edits and shuffle/repeat are local to the listening session and persist with that session. Playlist edits use a SQLite transaction.

## Desktop boundary

The renderer is sandboxed, uses context isolation, and has no Node integration. A narrow preload bridge exposes library actions. IPC checks the requesting frame URL. Custom protocols serve bundled files and indexed media; networking, popups, navigation away from the app, and runtime permission requests are denied. All fonts and UI assets are local. Music metadata renders as React text, not HTML. No telemetry, cloud requests, or source-artifact reuse is implemented.

Track context menus are native Electron menus built in the main process from indexed IDs. A typed action event dispatches existing renderer transport and playlist commands; no filesystem mutation commands are present. File → New Playlist uses the same creation form as the sidebar. The shared modal installs its focus trap once per mount and reads the current close callback through a ref, avoiding focus resets while typing or selecting a playlist.

The Songs table renders only its visible rows plus overscan, with stable row height, a sticky title column/header, and horizontal metadata scrolling. Sorting/filtering is memoized separately from playback progress. Album/queue detail lists initially render 200 entries and extend on demand. This bounds DOM work but does not make snapshot transfer or in-memory sorting independent of total library size.

## Packaging

`electron-builder` produces macOS app bundles, DMG and ZIP distributions, and Linux AppImage/DEB packages. The lockfile pins dependency resolution. An override updates the packager's proxy dependency to remove a vulnerable transitive dependency. Revisit it when upstream no longer needs the override.

Local macOS artifacts are unsigned and unnotarized because no signing identity or credentials were supplied. Linux packages can be cross-built here, but must be runtime-tested on Linux; `.github/workflows/build.yml` provides target-OS checks and packaging without publishing releases. No workflow has been run remotely as part of this implementation.

Official references consulted: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security/), [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/), and [Tauri WebView versions](https://v2.tauri.app/reference/webview-versions/), and [electron-builder Linux window association](https://www.electron.build/v26/docs/linux/).
