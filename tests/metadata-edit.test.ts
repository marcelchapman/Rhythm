import { test, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  lstat,
  rename,
  mkdir,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import {
  editManagedFlac,
  MetadataUseGate,
  MetadataEditInterruption,
} from "../src/domain/metadata-edit";
import { flacFixture, inspectFlac } from "./metadata-fixtures";
import {
  validateManagedTrash,
  type MediaRoot,
} from "../src/domain/managed-copy";
import { defaultState } from "../src/shared/types";

async function fixture(run: (f: any) => Promise<void>, bytes = flacFixture()) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-metadata-edit-")),
  );
  const libraries: Library[] = [];
  try {
    const external = path.join(root, "External.flac");
    await writeFile(external, bytes);
    const l = await Library.open(path.join(root, "Library"), {
      setupMediaRoot: true,
    });
    libraries.push(l);
    l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    const added = await l.add([external]);
    expect(added.errors).toEqual([]);
    const t = l.tracks()[0],
      use = new MetadataUseGate();
    use.setInUse(t.id, false);
    const before = await readFile(t.path),
      externalStat = await lstat(external);
    const open = async () => {
      const next = await Library.open(l.directory, { setupMediaRoot: true });
      libraries.push(next);
      return next;
    };
    await run({ root, l, t, use, before, external, open, libraries });
    expect(await readFile(external)).toEqual(bytes);
    expect((await lstat(external)).mtimeMs).toBe(externalStat.mtimeMs);
  } finally {
    for (const l of libraries) if (l.db.isOpen) l.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("managed FLAC title edit preserves identity/path/relationships/audio and updates current receipt without altering import provenance", async () => {
  await fixture(async ({ l, t, use, before, open }: any) => {
    l.favorite(t.id);
    const playlist = l.createPlaylist("Preserve", [t.id]);
    const state = {
      ...defaultState(),
      queue: [t.id],
      currentId: t.id,
      position: 3.5,
    };
    l.saveState(state);
    const provenance = l.db.prepare("SELECT * FROM managed_imports").all();
    const old = l.db
      .prepare("SELECT * FROM managed_file_receipts WHERE trackId=?")
      .get(t.id);
    const result = await editManagedFlac(
      l,
      t.id,
      { title: { action: "set", value: "Edited title" } },
      { usage: use },
    );
    expect(result.status).toBe("committed");
    expect(l.tracks(t.id)[0]).toMatchObject({
      id: t.id,
      path: t.path,
      title: "Edited title",
      favorite: true,
      mediaRootId: t.mediaRootId,
      mediaRelativePath: t.mediaRelativePath,
    });
    expect(l.playlists()[0]).toEqual(playlist);
    expect(l.state()).toEqual(state);
    expect(l.db.prepare("SELECT * FROM managed_imports").all()).toEqual(
      provenance,
    );
    const current = l.db
      .prepare("SELECT * FROM managed_file_receipts WHERE trackId=?")
      .get(t.id);
    expect(current.digest).not.toBe(old.digest);
    expect(current.inode).not.toBe(old.inode);
    expect(inspectFlac(await readFile(t.path)).audio).toEqual(
      inspectFlac(before).audio,
    );
    const root = l.db
      .prepare(
        "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
      )
      .get(t.mediaRootId) as unknown as MediaRoot;
    await validateManagedTrash(l.db, root, t.id, t.path, t.mediaRelativePath);
    const phase = l.db.prepare("SELECT phase FROM metadata_edits").get().phase;
    expect(phase).toBe("done");
    l.close();
    const reopened = await open();
    expect(reopened.tracks(t.id)[0].title).toBe("Edited title");
    expect(reopened.state()).toEqual(state);
  });
});

test.each(["journal", "staged", "published", "committed"] as const)(
  "interrupted %s edit recovers on Library.open",
  async (phase) => {
    await fixture(async ({ l, t, use, before, open }: any) => {
      await expect(
        editManagedFlac(
          l,
          t.id,
          { title: { action: "set", value: "Recovered title" } },
          {
            usage: use,
            hooks: {
              at: async (at) => {
                if (at === phase)
                  throw new MetadataEditInterruption(
                    "Simulated process interruption",
                  );
              },
            },
          },
        ),
      ).rejects.toThrow("Simulated");
      l.close();
      const reopened = await open();
      const edited = ["published", "committed"].includes(phase);
      expect(reopened.tracks(t.id)[0].title).toBe(
        edited ? "Recovered title" : t.title,
      );
      expect(
        reopened.db.prepare("SELECT phase FROM metadata_edits").get().phase,
      ).toBe(edited ? "done" : "aborted");
      if (!edited) expect(await readFile(t.path)).toEqual(before);
      const root = reopened.db
        .prepare(
          "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
        )
        .get(t.mediaRootId) as unknown as MediaRoot;
      await validateManagedTrash(
        reopened.db,
        root,
        t.id,
        t.path,
        t.mediaRelativePath,
      );
    });
  },
);

const titlePatch = { title: { action: "set" as const, value: "New title" } };
const receipt = (l: Library, id: string) =>
  l.db.prepare("SELECT * FROM managed_file_receipts WHERE trackId=?").get(id)!;
const journal = (l: Library) =>
  l.db.prepare("SELECT * FROM metadata_edits ORDER BY createdAt DESC").get()!;
const workspace = (l: Library) => {
  const j = JSON.parse(String(journal(l).journal));
  return path.join(path.dirname(j.filename), j.record.workspace);
};

test("multiple supported fields use qualified set semantics and are visible after reopen", async () => {
  await fixture(async ({ l, t, use, open }: any) => {
    const patch: any = {};
    for (const [field, value] of Object.entries({
      title: "Title ü",
      artist: "Artist",
      album: "Album",
      albumArtist: "Owner",
      composer: "Composer",
      genre: "Jazz",
      year: 2025,
      trackNumber: 4,
      trackTotal: 15,
      discNumber: 3,
      discTotal: 5,
      bpm: 123,
      comments: "Notes\nLine 2",
    }))
      patch[field] = { action: "set", value };
    await editManagedFlac(l, t.id, patch, { usage: use });
    l.close();
    const reopened = await open();
    expect(reopened.tracks(t.id)[0]).toMatchObject({
      title: "Title ü",
      artist: "Artist",
      album: "Album",
      albumArtist: "Owner",
      composer: "Composer",
      genre: "Jazz",
      year: 2025,
      track: 4,
      trackTotal: 15,
      disc: 3,
      discTotal: 5,
      bpm: 123,
      comments: "Notes\nLine 2",
    });
  });
});

test("clear and preserve retain the existing writer semantics and display fallbacks", async () => {
  await fixture(async ({ l, t, use }: any) => {
    await editManagedFlac(
      l,
      t.id,
      {
        comments: { action: "clear" },
        composer: { action: "clear" },
        genre: { action: "preserve" },
        trackTotal: { action: "clear" },
      },
      { usage: use },
    );
    expect(l.tracks(t.id)[0]).toMatchObject({
      comments: "",
      composer: "",
      genre: t.genre,
      trackTotal: null,
      track: t.track,
    });
  });
});

test("preserve-only edit is a no-op with unchanged inode, bytes and receipts", async () => {
  await fixture(async ({ l, t, use, before }: any) => {
    const old = receipt(l, t.id);
    expect((await editManagedFlac(l, t.id, {}, { usage: use })).status).toBe(
      "no-change",
    );
    expect(receipt(l, t.id)).toEqual(old);
    expect(await readFile(t.path)).toEqual(before);
    expect(journal(l).phase).toBe("aborted");
  });
});

test("old import receipt cannot grant authority over edited bytes; reimport of original reuses edited track", async () => {
  await fixture(async ({ l, t, use, external }: any) => {
    const old = receipt(l, t.id);
    await editManagedFlac(l, t.id, titlePatch, { usage: use });
    const edited = receipt(l, t.id);
    expect((await l.add([external])).errors).toEqual([]);
    expect(l.tracks()).toHaveLength(1);
    expect(receipt(l, t.id)).toEqual(edited);
    l.db
      .prepare(
        "UPDATE managed_file_receipts SET digest=?,device=?,inode=? WHERE trackId=?",
      )
      .run(old.digest, old.device, old.inode, t.id);
    const root = l.db
      .prepare(
        "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
      )
      .get(t.mediaRootId) as unknown as MediaRoot;
    await expect(
      validateManagedTrash(l.db, root, t.id, t.path, t.mediaRelativePath),
    ).rejects.toThrow(/receipt/);
  });
});

test.each([
  "referenced",
  "non-FLAC",
  "organized",
  "no receipt",
  "wrong inode",
  "wrong digest",
  "missing",
  "changed",
  "in-use",
  "unknown use",
  "no adapter",
  "pending import",
  "publication conflict",
  "artwork",
  "invalid patch",
  "unknown track",
  "invalid root",
] as const)(
  "rejects %s before publication without modifying any source",
  async (scenario) => {
    await fixture(async ({ l, t, use, before, root }: any) => {
      let patch: any = titlePatch,
        usage: any = use,
        id = t.id;
      switch (scenario) {
        case "referenced":
          l.db
            .prepare(
              "UPDATE track_locations SET kind='referenced',mediaRootId=NULL,relativePath=NULL WHERE trackId=?",
            )
            .run(t.id);
          break;
        case "non-FLAC":
          l.db.prepare("UPDATE tracks SET format='WAV' WHERE id=?").run(t.id);
          break;
        case "organized":
          l.saveMediaSettings({ keepOrganized: true });
          break;
        case "no receipt":
          l.db
            .prepare("DELETE FROM managed_file_receipts WHERE trackId=?")
            .run(t.id);
          break;
        case "wrong inode":
          l.db
            .prepare(
              "UPDATE managed_file_receipts SET inode='0' WHERE trackId=?",
            )
            .run(t.id);
          break;
        case "wrong digest":
          l.db
            .prepare(
              "UPDATE managed_file_receipts SET digest='bad' WHERE trackId=?",
            )
            .run(t.id);
          break;
        case "missing":
          await rename(t.path, path.join(root, "saved.flac"));
          break;
        case "changed":
          await writeFile(
            t.path,
            Buffer.concat([before, Buffer.from("external change")]),
          );
          break;
        case "in-use":
          use.setInUse(t.id, true);
          break;
        case "unknown use":
          usage = new MetadataUseGate();
          break;
        case "no adapter":
          usage = undefined;
          break;
        case "pending import":
          l.db
            .prepare(
              "UPDATE managed_imports SET status='ready' WHERE trackId=?",
            )
            .run(t.id);
          break;
        case "publication conflict":
          await mkdir(
            path.join(path.dirname(t.path), ".rio-publication-conflict"),
          );
          break;
        case "artwork":
          patch = { artwork: { action: "clear" } };
          break;
        case "invalid patch":
          patch = { title: { action: "set", value: 123 } };
          break;
        case "unknown track":
          id = "does-not-exist";
          use.setInUse(id, false);
          break;
        case "invalid root":
          l.db.prepare("UPDATE media_root_locations SET inode='0'").run();
          break;
      }
      const currentBytes =
        scenario === "missing" ? undefined : await readFile(t.path);
      await expect(editManagedFlac(l, id, patch, { usage })).rejects.toThrow();
      if (currentBytes) expect(await readFile(t.path)).toEqual(currentBytes);
      else
        expect(await readFile(path.join(root, "saved.flac"))).toEqual(before);
      expect(l.tracks(t.id)[0].title).toBe(t.title);
      if (["artwork", "in-use", "unknown use", "no adapter"].includes(scenario))
        expect(l.db.prepare("SELECT * FROM metadata_edits").all()).toEqual([]);
    });
  },
);

test("native staging refusal retains authoritative original", async () => {
  await fixture(async ({ l, t, use, before }: any) => {
    const parent = t.path,
      mode = (await lstat(parent)).mode & 0o777;
    try {
      await expect(
        editManagedFlac(l, t.id, titlePatch, {
          usage: use,
          hooks: {
            at: async (at) => {
              if (at === "journal") await chmod(parent, mode ^ 0o100);
            },
          },
        }),
      ).rejects.toThrow(/staging/);
    } finally {
      await chmod(parent, mode);
    }
    expect(await readFile(t.path)).toEqual(before);
    expect(journal(l).phase).toBe("aborted");
  });
});

test("tampered staged candidate fails verification, preserving original and owned recovery artifacts", async () => {
  await fixture(async ({ l, t, use, before, open }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "candidate-staged")
              await writeFile(
                path.join(workspace(l), "slot"),
                "broken candidate",
              );
          },
        },
      }),
    ).rejects.toThrow();
    expect(await readFile(t.path)).toEqual(before);
    expect(journal(l).phase).toBe("recovery-required");
    const backup = path.join(workspace(l), "rollback");
    expect(await readFile(backup)).toEqual(before);
    expect(l.media(t.id)).toBeUndefined();
    l.close();
    const reopened = await open();
    expect(journal(reopened).phase).toBe("recovery-required");
    expect(await readFile(backup)).toEqual(before);
  });
});

test("late receipt change fails closed before exchange", async () => {
  await fixture(async ({ l, t, use, before }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "before-publish")
              l.db
                .prepare(
                  "UPDATE managed_file_receipts SET digest='changed' WHERE trackId=?",
                )
                .run(t.id);
          },
        },
      }),
    ).rejects.toThrow(/receipt/);
    expect(await readFile(t.path)).toEqual(before);
    expect(journal(l).phase).toBe("recovery-required");
  });
});

test("publication refusal preserves original plus independent rollback", async () => {
  await fixture(async ({ l, t, use, before }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "before-publish")
              await chmod(path.join(workspace(l), "slot"), 0o777);
          },
        },
      }),
    ).rejects.toThrow(/Publication/);
    expect(await readFile(t.path)).toEqual(before);
    expect(journal(l).phase).toBe("aborted");
    await expect(lstat(workspace(l))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

test("DB commit failure retains published candidate and rollback; restart completes atomic commit", async () => {
  await fixture(async ({ l, t, use, before, open }: any) => {
    const old = receipt(l, t.id);
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "published")
              l.db.exec(
                "CREATE TRIGGER fail_edit BEFORE UPDATE ON tracks BEGIN SELECT RAISE(ABORT,'injected commit failure'); END",
              );
          },
        },
      }),
    ).rejects.toThrow(/injected/);
    expect(l.tracks(t.id)[0].title).toBe(t.title);
    expect(receipt(l, t.id)).toEqual(old);
    expect(await readFile(path.join(workspace(l), "rollback"))).toEqual(before);
    expect(await readFile(t.path)).not.toEqual(before);
    expect(journal(l).phase).toBe("recovery-required");
    l.db.exec("DROP TRIGGER fail_edit");
    l.close();
    const reopened = await open();
    expect(reopened.tracks(t.id)[0].title).toBe("New title");
    expect(journal(reopened).phase).toBe("done");
  });
});

test("crash between cleanup and journal finalization resolves from committed receipt", async () => {
  await fixture(async ({ l, t, use, open }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "artifacts-cleaned")
              throw new MetadataEditInterruption("cleanup crash");
          },
        },
      }),
    ).rejects.toThrow(/cleanup crash/);
    expect(journal(l).phase).toBe("committed");
    l.close();
    const reopened = await open();
    expect(journal(reopened).phase).toBe("done");
    expect(reopened.tracks(t.id)[0].title).toBe("New title");
  });
});

test("staged/backup artifacts are excluded from explicit and ordinary import", async () => {
  await fixture(async ({ l, t, use, open }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "staged") throw new MetadataEditInterruption("pause");
          },
        },
      }),
    ).rejects.toThrow();
    await expect(l.add([t.path])).rejects.toThrow(/import/);
    l.close();
    const reopened = await open();
    const reserved = path.join(path.dirname(t.path), ".rio-metadata-backup");
    await mkdir(reserved);
    const file = path.join(reserved, "backup.flac");
    await writeFile(file, flacFixture());
    expect((await reopened.add([file])).added).toBe(0);
    await reopened.scan([path.dirname(t.path)]);
    expect(reopened.tracks()).toHaveLength(1);
  });
});

test("idle lease blocks playback acquisition and releases on failure", async () => {
  await fixture(async ({ l, t, use }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "journal") use.setInUse(t.id, true);
          },
        },
      }),
    ).rejects.toThrow(/locked/);
    use.setInUse(t.id, true);
    await expect(
      editManagedFlac(l, t.id, titlePatch, { usage: use }),
    ).rejects.toThrow(/in use/);
  });
});

test("schema-3 upgrade derives current authority only from existing completed import proofs", async () => {
  await fixture(async ({ l, t, open }: any) => {
    const old = receipt(l, t.id),
      provenance = l.db.prepare("SELECT * FROM managed_imports").all();
    l.db.exec(
      "DROP TABLE metadata_edits; DROP TABLE managed_file_receipts; ALTER TABLE tracks DROP COLUMN composer; ALTER TABLE tracks DROP COLUMN trackTotal; ALTER TABLE tracks DROP COLUMN discTotal; PRAGMA user_version=3;",
    );
    l.close();
    const next = await open();
    expect(next.db.prepare("PRAGMA user_version").get()!.user_version).toBe(4);
    expect(receipt(next, t.id)).toEqual(old);
    expect(next.db.prepare("SELECT * FROM managed_imports").all()).toEqual(
      provenance,
    );
  });
});

test("edited current receipt retains guarded deletion authority", async () => {
  await fixture(async ({ l, t, use, root }: any) => {
    await editManagedFlac(l, t.id, titlePatch, { usage: use });
    const removed = await l.deleteTracks(
      [l.tracks(t.id)[0]],
      async (filename: string) => {
        expect(filename).toBe(t.path);
        await rename(filename, path.join(root, "Disposable trash.flac"));
      },
    );
    expect(removed.failures).toEqual([]);
    expect(removed.removedIds).toEqual([t.id]);
    expect(l.db.prepare("SELECT * FROM managed_file_receipts").all()).toEqual(
      [],
    );
  });
});

test("relocating an edited library rebinds current receipt independently from original provenance", async () => {
  await fixture(async ({ l, t, use, root, libraries }: any) => {
    const { relocateLibrary } =
      await import("../src/domain/library-relocation");
    await editManagedFlac(l, t.id, titlePatch, { usage: use });
    const provenance = l.db.prepare("SELECT * FROM managed_imports").all();
    const destination = path.join(root, "Moved library"),
      pointer = path.join(root, "library.json");
    await mkdir(destination);
    await writeFile(pointer, JSON.stringify({ libraryPath: l.directory }));
    const result = await relocateLibrary(l, destination, pointer);
    libraries.push(result.library);
    expect(result.library.tracks(t.id)[0].title).toBe("New title");
    expect(
      result.library.db.prepare("SELECT * FROM managed_imports").all(),
    ).toEqual(provenance);
    const moved = result.library.tracks(t.id)[0],
      r = result.library.db
        .prepare(
          "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
        )
        .get(t.mediaRootId) as unknown as MediaRoot;
    await validateManagedTrash(
      result.library.db,
      r,
      t.id,
      moved.path,
      moved.mediaRelativePath!,
    );
  });
});

test("malformed startup journal preserves original and blocks ambiguous target use", async () => {
  await fixture(async ({ l, t, use, before, open }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "journal") throw new MetadataEditInterruption("crash");
          },
        },
      }),
    ).rejects.toThrow();
    l.db.exec("UPDATE metadata_edits SET journal='{broken'");
    l.close();
    const next = await open();
    expect(journal(next).phase).toBe("recovery-required");
    expect(await readFile(t.path)).toEqual(before);
    expect(next.media(t.id)).toBeUndefined();
  });
});

test("qualified writer preservation failure leaves authoritative file untouched", async () => {
  await fixture(
    async ({ l, t, use, before }: any) => {
      await expect(
        editManagedFlac(l, t.id, titlePatch, { usage: use }),
      ).rejects.toThrow(/preserv|field|comment/i);
      expect(await readFile(t.path)).toEqual(before);
      expect(l.tracks(t.id)[0].title).toBe(t.title);
      expect(journal(l).phase).toBe("aborted");
    },
    flacFixture({
      entries: [
        ["TITLE", "Original title"],
        ["lower_custom", "must retain exact spelling"],
      ],
    }),
  );
});

test("crash after abort cleanup but before terminal journal safely resolves original", async () => {
  await fixture(async ({ l, t, use, before, open }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "staged") throw new MetadataEditInterruption("crash");
          },
        },
      }),
    ).rejects.toThrow();
    const { resumePublicationCleanup } =
      await import("../src/domain/publication");
    const record = JSON.parse(String(journal(l).journal)).record;
    const resumed = resumePublicationCleanup(record, "abort");
    if (!("lease" in resumed)) throw Error("Cannot resume abort fixture");
    try {
      expect(resumed.lease.syncPublication().status).toBe("synced");
      expect(resumed.lease.cleanupVerifiedArtifacts("abort").status).toBe(
        "cleaned",
      );
    } finally {
      resumed.lease.close();
    }
    l.close();
    const next = await open();
    expect(journal(next).phase).toBe("aborted");
    expect(await readFile(t.path)).toEqual(before);
    expect(next.media(t.id)?.path).toBe(t.path);
  });
});

test("recordless recovery never resolves over a changed current receipt", async () => {
  await fixture(async ({ l, t, use, before, open }: any) => {
    await expect(
      editManagedFlac(l, t.id, titlePatch, {
        usage: use,
        hooks: {
          at: async (at) => {
            if (at === "journal") throw new MetadataEditInterruption("crash");
          },
        },
      }),
    ).rejects.toThrow();
    l.db
      .prepare(
        "UPDATE managed_file_receipts SET inode='changed' WHERE trackId=?",
      )
      .run(t.id);
    l.close();
    const next = await open();
    expect(journal(next).phase).toBe("recovery-required");
    expect(await readFile(t.path)).toEqual(before);
  });
});
