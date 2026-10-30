# Library and media-folder setup

Desktop library creation/opening uses `Library.open(directory, { setupMediaRoot: true })`.
The existing SQLite media settings and media-root location/identity tables remain
the only persisted media configuration. There is no second profile-level media path.
Programmatic library opens retain their existing behavior unless desktop setup is
requested.

For a new database, Rio creates/configures `Rio Media` in the canonical library
folder itself. An existing dedicated directory at that path can be reused;
symlinks, files, filesystem roots and locations containing the library are not
adopted automatically. Read/write/traversal access is checked. The root is recorded
through the existing settings selection method. Copying remains off by default;
configuring a root does not claim existing files as managed.

For an existing database, Rio reads the saved root and checks its directory type,
recorded device/inode, canonical path, library separation and access. Successful
opens require no media-folder selection and preserve copy/organization policies.
The validation shares the existing managed-operation root-identity check; operation-
time safety checks and publication/ownership receipts are unchanged.

Missing, replaced, inaccessible or unsafe roots, absent configuration and failed
default setup open Library settings with a recovery message. Existing locations
and identities remain recorded; Rio does not recreate missing roots, search for
alternatives or silently assign a default to an existing library. Reconnect the
volume and reopen the library, or explicitly choose a folder using the existing
Settings control. Explicit reselection can update location identity as before.
Changing the root does not move existing files or convert referenced tracks into
managed tracks. Cancelling selection leaves configuration unchanged.

The optional `MediaSettings.setupError` is transient validation feedback, never
persisted configuration. Successful explicit folder selection clears it. Settings
remain available later for changing the root and copy/organization policies.

## Library isolation correction — 2026-10-30

The former default used the library directory's parent, so two new libraries in
that parent selected the same physical media folder. This was a default-path bug,
not profile-level media state or a cached renderer root. Defaults now derive only
from the newly opened library's canonical directory: `<library>/Rio Media`.
Existing saved locations (including older external/sibling roots) are not migrated
or replaced. Libraries already configured with a shared path can be changed
explicitly in Settings; Rio cannot infer whether that choice was intentional.
A missing or unsafe saved root enters recovery even if an internal
or sibling default directory exists.

## Validation — 2026-10-30

- Typecheck, production build, correction-file formatting and whitespace checks passed.
- Unit regression: 352 tests across 18 files passed, including ten library-setup
  tests (default creation/persistence, custom root/policy reuse and later changes,
  missing/replaced/symlinked roots, missing configuration, unsafe defaults and
  permission failure, and A/B/C isolation with a custom external A root).
- Source startup, managed setup (including A/B/C switching through one profile
  and renderer), smoke and recovery desktop checks all passed.
- Managed setup desktop coverage includes automatic folder creation without a
  second chooser, restart without a setup prompt, missing-root recovery without
  recreating the path, explicit Settings reselection, source hashes, managed vs
  referenced imports, and compact Settings keyboard/layout checks.

No packaging or installation is part of this correction. Physical external-volume
unmount/remount and platform-specific ACL/network-volume behavior still merit manual
review. Local execution covers macOS x64; Linux and native arm64 are not claimed.
