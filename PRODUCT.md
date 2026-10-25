# Rhythm

<!-- impeccable:product-schema 1 -->

## Platform

Desktop for Rhythm 0.1: macOS and Linux.

Current development phase: macOS desktop. Ubuntu checks/builds remain a portability canary; this phase does not begin Linux, Windows, or mobile product work.

Mandatory long-term platforms: macOS, Windows, Linux, Android, and iOS. Windows is a required desktop target but need not ship in 0.1. Android and iOS are outside 0.1 implementation scope.

The design-context platform vocabulary (`web`, `ios`, `android`, `adaptive`) does not accurately describe the current desktop scope. Whether each platform adopts its own native design language remains undecided; cross-platform support alone does not settle that choice.

## Stack

The 0.1 desktop implementation uses Electron, TypeScript, React, SQLite, Chromium's local audio playback, and electron-builder packaging. This decision was made at implementation time against the requirements and approved prototype; earlier experiments did not mandate it. Rationale and reuse boundaries are documented in `docs/ARCHITECTURE.md`.

Mobile implementation technology remains undecided. Electron is a desktop choice; the mandatory Android and iOS targets will need platform adapters and may use a different shell.

## Users

People who own digital music files and want to browse, organize, inspect, edit metadata, play music, and manage playlists as a coherent personal library. They value control over their files and library data, including eventual access across their devices.

## Product Purpose

Rhythm is an open-source personal music library and player built around the user's own music files. The library is central; playback is an essential part of the experience.

### Long-Term Product Scope

A cross-platform personal music library with synchronization and access across the user's devices. Support for macOS, Windows, Linux, Android, and iOS is a core requirement. Cloud synchronization/access is an authoritative part of the long-term vision, not an optional possibility.

The intended direction favors user-controlled storage or services users already subscribe to. Specific providers, storage responsibilities, synchronization mechanisms, and architecture remain undecided.

### Rhythm 0.1 Implementation Scope

A local personal music library and player for macOS and Linux, using the user's own music files. No cloud or mobile implementation is required for 0.1. Cross-platform and cloud requirements inform future decisions without making cloud the immediate implementation priority.

## Positioning

Personal-library-first: organize a collection the user owns while preserving control over files, metadata, playlists, and library information. Rhythm is not a streaming service or a feature-for-feature clone of an existing music application.

## Operating Context

The initial workflow centers on selecting local music locations, discovering music files, browsing a persistent library, selecting and playing tracks, and creating basic playlists. Metadata inspection and editing belong to the product direction; precise 0.1 behavior remains to be specified.

Music may be distributed across folders, disks, and devices. Handling external storage, missing files, moves, duplicates, and inconsistent metadata requires explicit requirements rather than assumptions.

## Capabilities and Constraints

Iteration 3 introduces an opt-in Managed Rhythm Media foundation: referenced tracks remain in place; managed additions copy into an explicitly selected media folder and index the copy. Ownership is recorded explicitly. Folder selection and copy/organization settings are per library; organization affects new copies only. Playlist interchange and rescans remain non-copying. Locate File preserves identity: referenced files relink in place; managed files restore through copying. Explicit track/album/library consolidation copies referenced files with per-track retry and skips already-managed tracks. Read-only Track Info exposes stored metadata and ownership through the native track context menu, without a trailing action column. Source originals remain untouched. Metadata/tag writing, existing-file reorganization, Remove from Library, Move to Trash, CD import and equalizer are deferred. See `docs/ITERATION-3.md` for the implemented rules and acceptance procedure.

The safety contract is: Rhythm never mutates, moves or deletes source media unless the user explicitly invokes a feature whose documented purpose requires it. Destructive operations must be scoped, confirmed where appropriate, tested and recoverable where reasonably possible. Rhythm's management authority ends at its configured media environment; external files remain user-owned. This foundation authorizes copying through the opted-in add policy or explicit recovery/consolidation commands; it introduces no audio mutation, move or deletion command.

- Rhythm 0.1 prioritizes the smallest useful local desktop library and playback experience.
- Implemented formats, identity, persistence, playlist interchange and playback are documented in the README and architecture report. Metadata writing, synchronization identity reconciliation and future destructive-operation behavior remain undecided.
- Cloud implementation, synchronization, mobile clients, accounts, social features, recommendations, and elaborate infrastructure are outside the initial implementation scope.
- Keep music files, embedded metadata, library records, playlists, configuration, and eventual synchronization state conceptually distinct.
- Do not claim that cloud functionality or cross-device access already exists.
- Licensing remains undecided; open-source development is a product commitment.

## Brand Commitments

The product name is Rhythm. Rhythmbox is a source of ideas, not a requirement to reproduce its interface or functionality.

The authoritative desktop visual reference is `artfiles/desktop_prototype.png`. Preserve its authority when evaluating future desktop UX work; init does not establish additional visual rules.

## Evidence on Hand

- `artfiles/desktop_prototype.png`: user-confirmed authoritative desktop visual reference and approved UX prototype.
- `README.md`: early product specification and discovery questions. Statements treating cross-platform, mobile, and cloud scope as optional are outdated and superseded by this record.
- `artfiles/index.html`: promotional material with older or broader messaging. It does not define Rhythm 0.1 implementation or UX. Claims implying that cloud functionality already exists or is the immediate implementation priority are inaccurate.
- `artfiles/mobile_prototype.png`: existing artifact; its presence does not bring mobile implementation into 0.1 or establish approved mobile UX.

## Product Principles

1. Put the user's personal music library and ownership at the center.
2. Deliver a useful local desktop core before implementing cloud or mobile functionality.
3. Treat all five long-term platforms and cross-device library access as requirements while keeping the first release focused.
4. Prefer understandable architecture and explain important decisions using requirements and evidence.
5. Distinguish confirmed product direction, implemented functionality, and open decisions in documentation and product claims.
