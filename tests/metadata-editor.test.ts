import { test, expect, vi } from "vitest";
import * as publication from "../src/domain/metadata-publication";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import { PlaybackUse } from "../src/main/playback-use";
import {
  assertMetadataSender,
  metadataSession,
  validateMetadataTarget,
  metadataEligibility,
  saveTrackMetadata,
  metadataError,
  recordMetadataFailure,
} from "../src/main/metadata-editor";
import {
  metadataDraft,
  metadataChanges,
  validateMetadataPatch,
} from "../src/shared/metadata-editor";
import { flacFixture } from "./metadata-fixtures";

test("privileged metadata boundary requires the exact owner and top frame, including trusted URL", () => {
  const frame = { url: "rio://app/index.html" },
    owner = { mainFrame: frame };
  expect(() =>
    assertMetadataSender({ sender: owner, senderFrame: frame }, owner),
  ).not.toThrow();
  for (const event of [
    { sender: {}, senderFrame: frame },
    { sender: owner, senderFrame: { url: frame.url } },
    { sender: owner },
  ])
    expect(() => assertMetadataSender(event, owner)).toThrow(/Untrusted/);
  frame.url = "https://example.com";
  expect(() =>
    assertMetadataSender({ sender: owner, senderFrame: frame }, owner),
  ).toThrow(/Untrusted/);
  expect(() =>
    assertMetadataSender({ sender: owner, senderFrame: frame }, null),
  ).toThrow(/Untrusted/);
});
test.each([
  null,
  [],
  "title",
  { path: { action: "set", value: "/tmp/x" } },
  { artwork: { action: "preserve" } },
  { title: { action: "set" } },
  { title: { action: "clear", value: "x" } },
  { title: { action: ["clear"] } },
  { title: { action: "set", value: "" } },
  { title: { action: "set", value: "\0" } },
  { title: { action: "set", value: "\ud800" } },
  { title: { action: "set", value: "x".repeat(4001) } },
  ...[0, -1, 1.5, "3", NaN, Infinity, 10000].map((value) => ({
    year: { action: "set", value },
  })),
  { bpm: { action: "set", value: 1001 } },
  { trackTotal: { action: "set", value: 1000000 } },
])("malformed metadata IPC changes fail closed (%#)", (patch) => {
  expect(() => validateMetadataPatch(patch)).toThrow();
});
test("only actual changes are sent; untouched blanks and numeric fields remain preserved", () => {
  const original = metadataDraft({
    title: "Before",
    artist: "Artist",
    year: 2026,
    track: 3,
    comments: "",
    bpm: null,
  } as any);
  expect(metadataChanges(original, { ...original })).toEqual({});
  expect(
    metadataChanges(original, {
      ...original,
      title: "After",
      year: "",
      comments: "New comment",
      trackTotal: "12",
    }),
  ).toEqual({
    title: { action: "set", value: "After" },
    year: { action: "clear" },
    comments: { action: "set", value: "New comment" },
    trackTotal: { action: "set", value: 12 },
  });
  for (const value of ["1.5", "1e2", "-1", "hello", " ", "0", "10000"])
    expect(() =>
      metadataChanges(original, { ...original, year: value }),
    ).toThrow();
});
test("production metadata adapter keeps identity/state/source bytes; rejects stale, conflicting, busy and invalid-receipt edits", async () => {
  const root = await realpath(
      await mkdtemp(path.join(tmpdir(), "rio-editor-")),
    ),
    source = path.join(root, "source.flac");
  const bytes = flacFixture();
  await writeFile(source, bytes);
  const sourceMtime = (await stat(source)).mtimeMs;
  const library = await Library.open(path.join(root, "Library"), {
      setupMediaRoot: true,
    }),
    use = new PlaybackUse();
  try {
    library.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    await library.add([source]);
    const track = library.tracks()[0],
      session = metadataSession(library)!;
    use.bindLibrary(library);
    use.allowOwner(1);
    const usage = use.usageFor(library);
    const save = (patch: unknown) =>
      saveTrackMetadata(library, track.id, session, patch, usage);
    expect(() => validateMetadataTarget("invalid", session, library)).toThrow(
      /valid track/,
    );
    expect(() =>
      validateMetadataTarget("a".repeat(64), session, library),
    ).toThrow(/no longer/);
    expect(() =>
      validateMetadataTarget(track.id, "stale-session", library),
    ).toThrow(/library changed/);
    library.favorite(track.id);
    const playlist = library.createPlaylist("Keep", [track.id]);
    library.saveState({
      ...library.state(),
      queue: [track.id],
      currentId: track.id,
    });
    await metadataEligibility(library, track.id, usage);
    const probe = vi
      .spyOn(publication, "selectMetadataPublication")
      .mockImplementation(() => {
        throw new Error("Require local writable APFS");
      });
    try {
      await expect(
        metadataEligibility(library, track.id, usage),
      ).rejects.toThrow(/APFS/);
    } finally {
      probe.mockRestore();
    }
    // Failure must release the temporary idle lease, rather than poisoning use.
    await metadataEligibility(library, track.id, usage);
    const before = metadataDraft(track);
    const result = await save(
      metadataChanges(before, {
        ...before,
        title: "Edited",
        artist: "New artist",
        album: "New album",
        albumArtist: "New album artist",
        composer: "Composer",
        genre: "Jazz",
        year: "2026",
        trackNumber: "2",
        trackTotal: "12",
        discNumber: "1",
        discTotal: "2",
        bpm: "120",
        comments: "",
      }),
    );
    expect(result.track).toMatchObject({
      id: track.id,
      path: track.path,
      title: "Edited",
      artist: "New artist",
      album: "New album",
      albumArtist: "New album artist",
      composer: "Composer",
      genre: "Jazz",
      year: 2026,
      track: 2,
      trackTotal: 12,
      disc: 1,
      discTotal: 2,
      bpm: 120,
      comments: "",
      favorite: true,
    });
    expect(library.playlists()[0]).toEqual(playlist);
    expect(library.state()).toMatchObject({
      queue: [track.id],
      currentId: track.id,
    });
    const authoritative = await readFile(track.path),
      active = use.acquire(1, track.id, library.directory);
    await expect(
      save({ title: { action: "set", value: "Blocked" } }),
    ).rejects.toThrow(/in use/);
    await use.release(1, active.token);
    library.saveMediaSettings({ keepOrganized: true });
    await expect(metadataEligibility(library, track.id, usage)).rejects.toThrow(
      /organized/,
    );
    await expect(
      save({ title: { action: "set", value: "Blocked" } }),
    ).rejects.toThrow(/organized/);
    library.saveMediaSettings({ keepOrganized: false });
    library.scanning = true;
    await expect(metadataEligibility(library, track.id, usage)).rejects.toThrow(
      /operation/,
    );
    library.scanning = false;
    await expect(
      save({ year: { action: "set", value: "2026" } }),
    ).rejects.toThrow();
    expect(await readFile(track.path)).toEqual(authoritative);
    library.db
      .prepare(
        "UPDATE managed_file_receipts SET digest='invalid' WHERE trackId=?",
      )
      .run(track.id);
    await expect(metadataEligibility(library, track.id, usage)).rejects.toThrow(
      /receipt/,
    );
    await expect(
      save({ title: { action: "set", value: "Blocked" } }),
    ).rejects.toThrow(/receipt/);
    expect(await readFile(track.path)).toEqual(authoritative);
    expect(await readFile(source)).toEqual(bytes);
    expect((await stat(source)).mtimeMs).toBe(sourceMtime);
  } finally {
    await use.shutdown();
    library.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("metadata errors retain useful distinctions without presenting raw filesystem authority", () => {
  expect(
    metadataError(
      new Error("Publication staging failed: Require local writable APFS"),
    ),
  ).toMatch(/unavailable on this volume.*APFS/);
  expect(
    metadataError(
      new Error("Target is in use or its playback-use state is unknown."),
    ),
  ).toMatch(/loaded for playback/);
  expect(
    metadataError(new Error("Resolve unfinished metadata edits first.")),
  ).toMatch(/recovery/);
  expect(metadataError(new Error("unknown backend error"))).toMatch(
    /diagnostic log/,
  );
  expect(
    metadataError(new Error("unclassified publication failure"), true),
  ).toMatch(/needs recovery/);
});

test("aborted Save diagnostics retain the exact underlying error and a UI reference in the main-owned profile", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "rio-diagnostic-"));
  try {
    const error = new Error(
      "Publication staging failed: Require local writable APFS",
    );
    const reference = await recordMetadataFailure(
      directory,
      "a".repeat(64),
      error,
    );
    const record = JSON.parse(
      await readFile(path.join(directory, "metadata-edit-errors.log"), "utf8"),
    );
    expect(record).toMatchObject({
      reference,
      trackId: "a".repeat(64),
      error: error.message,
      stack: error.stack,
    });
    expect(reference).toMatch(/^[a-f0-9]{8}$/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
