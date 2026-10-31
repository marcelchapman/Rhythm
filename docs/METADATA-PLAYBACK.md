# Metadata editing: production playback ownership (Phase 2B)

Phase 2B supplies `MetadataUsage` from the real playback lifecycle. It adds no
metadata editor, metadata IPC endpoint, automatic decoder quiescing, artwork,
batch operation or path relocation. `MetadataUseGate` and the coordinator's
preflight/publication/recovery semantics are unchanged.

## Existing lifecycle and the ownership boundary

The renderer's `App.tsx` owns one `HTMLAudioElement`. `MediaSource.ensure` prepares
a source and waits for actual canplay/seek readiness; both the source effect and
Play reuse the same pending preparation. The existing effect also preloads a
remembered current track without autoplay. Queue/current IDs in SQLite are only
references, but a resulting preload is real decoder ownership.

The renderer never receives a filesystem path as a playable URL. Main resolves
an indexed ID through `Library.media`; the `rio-media` protocol supplies ranged
bytes from `src/main/media.ts`. Those main-process `ReadStream`s own the file
descriptors. A fully buffered or paused element can still retain its source even
when no stream is currently open, so stream EOF, `paused`, `playing`, `ended`,
`currentId` and queue contents are insufficient release evidence on their own.

## Production adapter

`src/main/playback-use.ts` exports one production `playbackUse` service, bound by
main to the active Library instance. `usageFor(library)` implements the existing
`MetadataUsage` contract. Unknown/unbound/closed libraries, stale scopes and
library-change/shutdown transitions fail closed. Library instance and epoch,
rather than a track ID alone, scope the authority.

Before changing `audio.src`, `MediaSource` obtains a source lease through the
trusted renderer's playback-only preload handshake. Main resolves the ID in the
expected library and calls the same `MetadataUseGate.setInUse(id, true)` used by
`usageFor(library).acquireIdle(id)`. Both operations are synchronous in main.
An edit's idle lease therefore denies a new playback grant before any decoder
source or file request can be opened.

The grant contains a random token in `rio-media://track/<id>?use=<token>`. The
token binds renderer owner, Library instance, ID, path and format. The protocol
accepts track reads only through that active grant; missing, stale, revoked or
wrong-location tokens cannot open a stream. Artwork remains the existing SQLite
cache read and needs no audio-file ownership.

`MediaSource` registers readiness before source assignment, reuses one pending
load, and never assigns a source after a cancelled/late grant. It resets the old
element with pause/remove-src/load, then retires its grant. Replacement waits for
known release acknowledgment before acquiring the next source. An IPC release
failure remains ambiguous and blocks subsequent acquisitions in that loader.

## Release and failure rules

- **Pause:** retains the source lease, including when Chromium has buffered all
  bytes. Editing rejects it. Resume keeps the existing source/readiness behavior.
- **Ended source:** stays acquired while its source remains attached. An ended
  transport is not inferred to be a released decoder.
- **Clear/stop, replacement or unavailable file:** remove the source and reset the
  element, then release the grant. Retaining queue/current references grants no
  ownership by itself and does not prevent an edit of a fully released target.
- **Preparation timeout/error, decoder error, genuine play failure:** clear the
  owning generation's source and release it. Stale failures cannot clear a newer
  generation. Readiness failures retain their original diagnostics; player error
  and saved-position handling continue through the existing recovery flow.
- **Release:** main revokes the token synchronously, preventing late/ranged reads,
  then destroys outstanding read streams and waits for their `close` events.
  Requests still awaiting stat retain a pending-reader reservation and cannot
  open after revocation. Only after every descriptor closes can the gate become
  idle. `end`, a UI acknowledgment or an abort request alone cannot mark it idle.
- **Multiple grants:** all grants/readers for the track must retire before it is
  idle; one stale/duplicate release cannot clear another grant.
- **Renderer navigation, crash or destruction:** revoke the owner's grants and
  drain their streams. A navigation generation prevents an old completion from
  resurrecting a destroyed renderer. New renderer acquisition waits for that
  ownership reset.
- **Library switch/move:** block new edits/acquisitions during the transition,
  revoke and drain the previous library's sources before close/rebind. Existing
  metadata idle leases prevent starting that transition.
- **Quit:** deny new acquisitions, revoke streams and invalidate idle assertions.
  Await active coordinator lease release before closing the database, so its
  normal safe failure/reconciliation can finish. Teardown never fabricates idle
  state while a descriptor remains unconfirmed.

Cached decoded audio lives in Chromium memory; it does not have independent
filesystem access. Resetting the controlled element plus revoking its protocol
capability and confirming main's descriptor closure establishes Rio's file-use
release boundary. The adapter never guesses from appearance, sound output or a
timer. All normal playback source assignments use this path.

## Regression coverage

`tests/playback-use.test.ts` exercises real disposable Libraries and file streams:
active edit rejection, release/edit success, edit-vs-acquisition exclusion,
queue/current references, multiple grants, buffered/pause retention, descriptor
closure, revocation while stat is pending, renderer ownership, missing transport,
unknown/stale/closed scopes, spoofed release/library, library transitions and
shutdown during an idle edit lease.

`tests/media-source.test.ts` retains readiness/seek/recovery coverage and adds
pre-assignment authorization, cancellation with a late grant, ordered source
replacement, retained pause ownership, post-readiness decoder error cleanup and
ambiguous release failure.

`scripts/metadata-playback.mjs` runs the actual renderer/preload/main/protocol path
with generated FLAC in disposable managed libraries. Main-process test calls
invoke the existing coordinator with the production singleton's usage capability;
no metadata IPC is added. It checks advancing playback, pause, switching,
successful released-file edits, a deliberately held edit lease denying real Play
and unleased/stale protocol requests, real decode failure, library change, quit,
restored paused preload and renderer crash. External source bytes/mtimes and
same-path track identity remain protected. The script is in `test:desktop` and
`test:packaged`, with `--packaged` and `RIO_EXECUTABLE` support.

Existing desktop URL assertions now compare the track pathname and retain their
playback/readiness/time checks. The source token is intentional protocol authority,
not part of track identity. Tests that force a fresh access preserve the token.

## Validation and next boundary

Source and packaged Intel macOS playback-ownership qualification passed using
the same Phase 2B production implementation. Fresh unsigned, unnotarized x64
Rio.app, DMG and ZIP artifacts were built with
`npm run dist:mac -- --x64 --publish never`. The application was launched directly
from the build output; it was not installed or published. Linux/arm64 and
signed/notarized distribution qualification remain deferred.

A future metadata editing entry point must pass `playbackUse.usageFor` for the
same active Library to `editManagedFlac`. No manual idle declaration is required
for that path. UI/IPC still needs its own explicit mission, user intent and
recovery/error presentation. Automatic active-decoder release, ambiguous metadata
journal recovery UX, batch/artwork/referenced editing and Keep Organized
relocation remain deferred.

## Local validation results

| Check                                                                        | Result                                                                                                                                                        |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Focused `tests/playback-use.test.ts` and `tests/media-source.test.ts`        | **26 passed**: 14 main ownership cases and 12 decoder/readiness cases                                                                                         |
| Final `npm test`                                                             | **439 passed**, 21 files                                                                                                                                      |
| Standalone `node scripts/metadata-playback.mjs`                              | **Passed** all real playback, edit exclusion, error, scope and teardown assertions                                                                            |
| Final `npm run test:desktop`                                                 | **Passed all 16 scripts** on the final build, including metadata/playback ownership, Track Info, playback recovery, removal, relocation and album cleanup     |
| `node scripts/metadata-playback.mjs --packaged`                              | **Passed** all real-path acceptance with executed main/preload/renderer and app-owned adapter/coordinator provenance                                          |
| `npm run test:packaged`                                                      | **Passed all 15 scripts**, including packaged ownership, coordinator/worker/WASM/native publication, playback recovery, relocation, removal and album cleanup |
| `RIO_EXECUTABLE=… node scripts/metadata-playback.mjs` (without `--packaged`) | **Passed** the same packaged lifecycle through the executable override                                                                                        |
| `npm run dist:mac -- --x64 --publish never`                                  | **Passed**; fresh unsigned, unnotarized Rio.app, DMG and ZIP                                                                                                  |
| `npm run typecheck`                                                          | **Passed**                                                                                                                                                    |
| `npm run build`                                                              | **Passed**; native compilation, main/preload TypeScript and renderer production build                                                                         |
| `npm run format:check`, changed-doc Prettier checks, `git diff --check`      | **Passed**                                                                                                                                                    |

Source and packaged runtime: Intel macOS x64, Electron 44.9.2 / Node 24.22.0.
All libraries/media/profiles were disposable. No Phase 2B production semantics,
coordinator, writer, native publication, schema or artwork changes were needed
for packaged qualification.

## Packaged implementation provenance

Packaged launch reuses `resolvePublicationPackage` from the existing publication
qualification tooling; `RIO_EXECUTABLE` overrides discovery. Every launch,
including the restart/preload/crash case, asserts `app.isPackaged === true` and
`app.getAppPath() === process.resourcesPath/app.asar` in packaged mode. The
packaged process uses a disposable working directory and profile.

Library fixture setup and all internal coordinator/ownership calls load modules
relative to the running app's own path. The harness does not import production
implementation from the checkout's `dist` tree in packaged mode. The production
singleton must own an instance of that app's Library class, and its playback and
coordinator modules must be loaded in the runtime module cache.

DevTools script-parsed observations prove the executed main, preload and renderer
origins. The HTML and renderer JavaScript actually served by `rio://app` must hash
to the matching files in the running application's resources. The harness prints
these paths, hashes and runtime architecture for both launches. A separate archive
comparison confirmed main/preload/adapter/coordinator/renderer bytes match the
current compiled build; that comparison reads bytes without loading checkout
implementation into Rio.app.

For this qualified build, paths below are relative to
`release/mac/Rio.app/Contents/Resources/`:

| Resource                   | Packaged path                                     | SHA-256                                                            |
| -------------------------- | ------------------------------------------------- | ------------------------------------------------------------------ |
| Main entry                 | `app.asar/dist/main/main.js`                      | `7e60e113e361fea9a148f27eb3ba9a5b408c8f08a25f7040759b59537d91c542` |
| Preload                    | `app.asar/dist/main/preload.cjs`                  | `34d061e64d28fb6599058214ff22c25ba78e101b3b85ff1ab8349aa98cafd9c5` |
| Playback ownership adapter | `app.asar/dist/main/playback-use.js`              | `13e3e22ee84e3d5d4228a794c0e72297baa471d48fd6997ecb2fc6ef373753d8` |
| Metadata coordinator       | `app.asar/dist/domain/metadata-edit.js`           | `30c39a283c288ad1ff131b021e566c1bb4b3365f1a63fb1cf98c90a274f64642` |
| Renderer entry             | `app.asar/dist/renderer/index.html`               | `acf3d5764b8cb5c98ca58535ac4e5fb008cc08206bb700c8ddd02cd8fb89dcd3` |
| Renderer application       | `app.asar/dist/renderer/assets/index-CdFzTdxT.js` | `65bbc40f6cb28b39e5831586c4d7e3c113cba8a8a64b263f8269218ed89b29e9` |

The packaged ownership harness retains all source acceptance assertions: queue/
current references alone, active and paused decoder exclusion, release on switch,
same-path edits with stable track IDs, edit leases denying real Play and invalid
protocol reads, decode error cleanup, library authority revocation, quit, actual
restored preload ownership, renderer crash cleanup and unchanged external source
bytes/mtime. No packaged-only product defect was found.

Fresh artifacts (Rio / `io.github.marcelchapman.rio`):

- `release/mac/Rio.app`
- `release/Rio-0.1.0.dmg`
- `release/Rio-0.1.0-mac.zip`

## Files changed

- `docs/ARCHITECTURE.md`
- `docs/METADATA-EDITING.md`
- `docs/METADATA-PLAYBACK.md`
- `package.json`
- `scripts/albums.mjs`
- `scripts/codecs.mjs`
- `scripts/features.mjs`
- `scripts/managed.mjs`
- `scripts/metadata-playback.mjs`
- `scripts/playback-recovery.mjs`
- `scripts/playlist-menus.mjs`
- `scripts/recovery.mjs`
- `scripts/removal.mjs`
- `scripts/smoke.mjs`
- `scripts/track-info.mjs`
- `src/main/main.ts`
- `src/main/media.ts`
- `src/main/playback-use.ts`
- `src/main/preload.cts`
- `src/renderer/App.tsx`
- `src/renderer/media-source.ts`
- `src/shared/types.ts`
- `tests/media-source.test.ts`
- `tests/playback-use.test.ts`
