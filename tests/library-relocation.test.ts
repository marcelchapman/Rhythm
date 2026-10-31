import { DatabaseSync } from "node:sqlite";
import { test, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  realpath,
  rm,
  readdir,
  stat,
  symlink,
  rename,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";
import {
  relocateLibrary,
  RelocationFailure,
} from "../src/domain/library-relocation";
import { RELOCATION_MARKER } from "../src/domain/library-relocation-marker";
import {
  validateManagedTrash,
  type MediaRoot,
} from "../src/domain/managed-copy";
import { defaultState } from "../src/shared/types";
import { wavFixture } from "./fixtures";

async function fixture(run: (f: any) => Promise<void>) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-relocate-")),
  );
  let source: Library | undefined;
  const libraries: Library[] = [];
  try {
    source = await Library.open(path.join(root, "Rhythm 3"), {
      setupMediaRoot: true,
    });
    libraries.push(source);
    const parent = path.join(root, "Rhythm 4");
    await mkdir(parent);
    const pointer = path.join(root, "Profile", "library.json");
    await mkdir(path.dirname(pointer));
    await writeFile(pointer, JSON.stringify({ libraryPath: source.directory }));
    const original = path.join(root, "original.wav");
    const bytes = wavFixture({ title: "Preserve me" });
    await writeFile(original, bytes);
    const before = await stat(original);
    const reference = path.join(root, "reference.wav");
    await writeFile(reference, wavFixture({ title: "Referenced source" }));
    await source.add([reference]);
    source.saveMediaSettings({ copyOnAdd: true });
    await source.add([original]);
    const tracks = source.tracks();
    const managed = tracks.find((t) => t.locationKind === "managed")!;
    source.favorite(managed.id);
    const playlist = source.createPlaylist(
      "Keep playlist",
      tracks.map((t) => t.id),
    );
    const state = {
      ...defaultState(),
      queue: tracks.map((t) => t.id),
      currentId: managed.id,
      position: 4.5,
    };
    source.saveState(state);
    await mkdir(path.join(source.directory, "Saved state"));
    await writeFile(
      path.join(source.directory, "Saved state", "notes.json"),
      '{"preserve":true}',
    );
    await run({
      root,
      source,
      parent,
      pointer,
      original,
      reference,
      bytes,
      managed,
      playlist,
      state,
      libraries,
    });
    expect(await readFile(original)).toEqual(bytes);
    expect((await stat(original)).mtimeMs).toBe(before.mtimeMs);
  } finally {
    for (const library of libraries) if (library.db.isOpen) library.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("same-volume copy verifies, rebinds managed receipts, preserves identities/state, retires whole source and restarts", async () => {
  await fixture(
    async ({
      source,
      parent,
      pointer,
      managed,
      playlist,
      state,
      reference,
      libraries,
    }: any) => {
      const result = await relocateLibrary(source, parent, pointer);
      libraries.push(result.library);
      const next = result.library;
      expect(result.status).toBe("moved");
      expect(next.directory).toBe(parent);
      expect(await readdir(parent)).toContain("rio.sqlite");
      expect(await readdir(parent)).not.toContain("Rhythm 3");
      expect(next.mediaSettings().root!.path).toBe(
        path.join(next.directory, "Rio Media"),
      );
      expect(next.mediaSettings().setupError).toBeUndefined();
      expect(next.state()).toEqual(state);
      expect(next.playlists().find((p: any) => p.id === playlist.id)).toEqual(
        playlist,
      );
      expect(next.tracks(managed.id)[0].favorite).toBe(true);
      expect(
        next
          .tracks()
          .some(
            (t: any) => t.path === reference && t.locationKind === "referenced",
          ),
      ).toBe(true);
      const moved = next.tracks(managed.id)[0];
      const root = next.db
        .prepare(
          "SELECT rootId AS id,path,device,inode FROM media_root_locations",
        )
        .get() as unknown as MediaRoot;
      await validateManagedTrash(
        next.db,
        root,
        moved.id,
        moved.path,
        moved.mediaRelativePath!,
      );
      expect(
        await readFile(
          path.join(next.directory, "Saved state", "notes.json"),
          "utf8",
        ),
      ).toContain("preserve");
      expect(await readdir(result.retainedSource)).toContain("rio.sqlite");
      const published = JSON.parse(await readFile(pointer, "utf8"));
      next.close();
      const restarted = await Library.open(published.libraryPath, {
        setupMediaRoot: true,
        relocationToken: published.relocationToken,
      });
      libraries.push(restarted);
      expect(restarted.state()).toEqual(state);
      expect(restarted.mediaSettings().setupError).toBeUndefined();
    },
  );
});

test("copy+verify strategy keeps original authoritative through copying (also used across volumes)", async () => {
  await fixture(async ({ source, parent, pointer, libraries }: any) => {
    const old = source.directory;
    const result = await relocateLibrary(source, parent, pointer, {
      at: async (phase, destination) => {
        if (phase === "verified") {
          expect(JSON.parse(await readFile(pointer, "utf8")).libraryPath).toBe(
            old,
          );
          expect(
            (await stat(path.join(destination, "rio.sqlite"))).ino,
          ).not.toBe((await stat(path.join(old, "rio.sqlite"))).ino);
          await expect(Library.open(destination)).rejects.toThrow(/incomplete/);
        }
      },
    });
    libraries.push(result.library);
  });
});

test.each([
  "copy-entry",
  "copied",
  "verified",
  "rebound",
  "before-commit",
] as const)(
  "failure at %s preserves original pointer/library and cleans only owned destination",
  async (failPhase) => {
    await fixture(async ({ source, parent, pointer }: any) => {
      const state = source.state();
      const failure = await relocateLibrary(source, parent, pointer, {
        at: async (phase) => {
          if (phase === failPhase)
            throw new Error("Injected relocation failure");
        },
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(RelocationFailure);
      expect(failure.message).toMatch(/^MOVE FAILED/);
      expect(failure.message).toContain(
        "original library remains unchanged and authoritative",
      );
      expect(failure.message).not.toMatch(
        /Managed file location changed|Choose its recovery source|Library moved|RELOCATION RECOVERY REQUIRED/,
      );
      expect(failure.incompleteDestination).toBe(false);
      expect(source.state()).toEqual(state);
      expect(JSON.parse(await readFile(pointer, "utf8")).libraryPath).toBe(
        source.directory,
      );
      expect(await readdir(parent)).toEqual([]);
    });
  },
);

test("verification refuses corrupted copied bytes without switching authority", async () => {
  await fixture(async ({ source, parent, pointer }: any) => {
    await expect(
      relocateLibrary(source, parent, pointer, {
        at: async (phase, destination) => {
          if (phase === "copied")
            await writeFile(
              path.join(destination, "Saved state", "notes.json"),
              "corrupt",
            );
        },
      }),
    ).rejects.toThrow(/verification/);
    expect(JSON.parse(await readFile(pointer, "utf8")).libraryPath).toBe(
      source.directory,
    );
    expect(
      await readFile(
        path.join(source.directory, "Saved state", "notes.json"),
        "utf8",
      ),
    ).toContain("preserve");
  });
});

test("unexpected content added during failed copy is retained, never recursively erased", async () => {
  await fixture(async ({ source, parent, pointer }: any) => {
    const failure = await relocateLibrary(source, parent, pointer, {
      at: async (phase, destination) => {
        if (phase === "copied") {
          await writeFile(path.join(destination, "unrelated.txt"), "keep");
          throw new Error("Injected");
        }
      },
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(RelocationFailure);
    expect(failure.incompleteDestination).toBe(true);
    expect(failure.message).toMatch(/^MOVE FAILED/);
    expect(failure.message).toContain(
      "original library remains unchanged and authoritative",
    );
    expect(await readFile(path.join(parent, "unrelated.txt"), "utf8")).toBe(
      "keep",
    );
    await expect(Library.open(parent)).rejects.toThrow(/incomplete/);
    expect(JSON.parse(await readFile(pointer, "utf8")).libraryPath).toBe(
      source.directory,
    );
  });
});

test("destination conflict and nested destination refuse without touching either library", async () => {
  await fixture(async ({ source, parent, pointer }: any) => {
    const conflict = parent;
    await writeFile(path.join(conflict, "unrelated"), "keep");
    await expect(relocateLibrary(source, parent, pointer)).rejects.toThrow();
    expect(await readFile(path.join(conflict, "unrelated"), "utf8")).toBe(
      "keep",
    );
    await expect(
      relocateLibrary(source, source.directory, pointer),
    ).rejects.toThrow(/outside/);
  });
});

test("external custom root remains in place with its original identities and receipts", async () => {
  await fixture(
    async ({ root, source, parent, pointer, original, libraries }: any) => {
      const external = path.join(root, "External media");
      await mkdir(external);
      await source.chooseMediaRoot(external);
      const extra = path.join(root, "external-source.wav");
      await writeFile(extra, wavFixture({ title: "External managed copy" }));
      await source.add([extra]);
      const settings = structuredClone(source.mediaSettings());
      const identity = await stat(external);
      const result = await relocateLibrary(source, parent, pointer);
      libraries.push(result.library);
      expect(structuredClone(result.library.mediaSettings())).toEqual(settings);
      expect((await stat(external)).ino).toBe(identity.ino);
      expect(
        result.library
          .tracks()
          .some((t: any) => t.path.startsWith(external + path.sep)),
      ).toBe(true);
    },
  );
});

test("symlinked payload and changed managed receipts cannot be blessed by relocation", async () => {
  await fixture(async ({ source, parent, pointer, original, managed }: any) => {
    await symlink(original, path.join(source.directory, "alias"));
    await expect(relocateLibrary(source, parent, pointer)).rejects.toThrow(
      /symlink/,
    );
    await rm(path.join(source.directory, "alias"));
    await writeFile(managed.path, "changed managed bytes");
    await expect(relocateLibrary(source, parent, pointer)).rejects.toThrow(
      /receipt/,
    );
  });
});

test("commit interruption leaves a fully validated destination restartable with committed token", async () => {
  await fixture(async ({ source, parent, pointer, state, libraries }: any) => {
    const result = await relocateLibrary(source, parent, pointer, {
      at: async (phase) => {
        if (phase === "committed") throw new Error("Interrupted cleanup");
      },
    });
    libraries.push(result.library);
    expect(result.status).toBe("recovery-required");
    expect(result.warning).toContain("RELOCATION RECOVERY REQUIRED");
    expect(result.warning).toContain("retained");
    const published = JSON.parse(await readFile(pointer, "utf8"));
    result.library.close();
    await expect(Library.open(published.libraryPath)).rejects.toThrow(
      /incomplete/,
    );
    const next = await Library.open(published.libraryPath, {
      setupMediaRoot: true,
      relocationToken: published.relocationToken,
    });
    libraries.push(next);
    expect(next.state()).toEqual(state);
    expect(next.mediaSettings().setupError).toBeUndefined();
  });
});

test("real cross-volume relocation when the host provides a second writable filesystem", async ({
  skip,
}) => {
  const tmp = await stat(tmpdir()),
    workspace = await stat(process.cwd());
  if (tmp.dev === workspace.dev) {
    skip();
    return;
  }
  await fixture(async ({ source, pointer, libraries }: any) => {
    const parent = await realpath(
      await mkdtemp(path.join(process.cwd(), ".rio-cross-volume-test-")),
    );
    try {
      const result = await relocateLibrary(source, parent, pointer);
      libraries.push(result.library);
      expect((await stat(result.library.directory)).dev).not.toBe(tmp.dev);
      expect(result.library.mediaSettings().setupError).toBeUndefined();
    } finally {
      for (const l of libraries)
        if (l.directory.startsWith(parent) && l.db.isOpen) l.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});

test("referenced audio inside library but outside managed roots stays at its original path", async () => {
  await fixture(async ({ source, parent, pointer, libraries }: any) => {
    const loose = path.join(source.directory, "Loose source.wav");
    const bytes = wavFixture({ title: "User owned internal reference" });
    await writeFile(loose, bytes);
    source.saveMediaSettings({ copyOnAdd: false });
    await source.add([loose]);
    const track = source.tracks().find((t: any) => t.path === loose);
    const result = await relocateLibrary(source, parent, pointer);
    libraries.push(result.library);
    expect(result.library.tracks(track.id)[0].path).toBe(loose);
    expect(result.library.tracks(track.id)[0].locationKind).toBe("referenced");
    expect(await readFile(loose)).toEqual(bytes);
    await expect(
      stat(path.join(result.library.directory, "Loose source.wav")),
    ).rejects.toThrow();
    await expect(Library.open(source.directory)).rejects.toThrow(
      /retired recovery copy/,
    );
  });
});

test("a second connection cannot write the original during relocation", async () => {
  await fixture(async ({ source, parent, pointer, libraries }: any) => {
    const result = await relocateLibrary(source, parent, pointer, {
      at: async (phase) => {
        if (phase === "copied") {
          expect(() => {
            const other = new DatabaseSync(
              path.join(source.directory, "rio.sqlite"),
            );
            try {
              other.exec(
                "PRAGMA busy_timeout=1; INSERT INTO settings VALUES('foreign-write','unsafe')",
              );
            } finally {
              other.close();
            }
          }).toThrow(/locked/);
        }
      },
    });
    libraries.push(result.library);
  });
});

test("case-only managed spelling change reproduces the manual preflight issue and now relocates safely to exact Rhythm 4", async ({
  skip,
}) => {
  await fixture(
    async ({ source, parent, pointer, managed, libraries }: any) => {
      const originalPath = managed.path;
      const canonicalPath = path.join(
        path.dirname(originalPath),
        path.basename(originalPath).toUpperCase(),
      );
      await rename(originalPath, canonicalPath);
      const stillResolves = await realpath(originalPath).catch(() => undefined);
      if (!stillResolves) {
        await rename(canonicalPath, originalPath);
        skip();
        return;
      }
      expect(stillResolves).not.toBe(originalPath);
      const oldSettings = structuredClone(source.mediaSettings());
      const result = await relocateLibrary(source, parent, pointer, {
        at: async (phase) => {
          if (phase === "before-commit")
            expect(
              JSON.parse(await readFile(pointer, "utf8")).libraryPath,
            ).toBe(source.directory);
        },
      });
      libraries.push(result.library);
      expect(result.status).toBe("moved");
      expect(result.library.directory).toBe(parent);
      expect(await readdir(parent)).toContain("rio.sqlite");
      expect(await readdir(parent)).not.toContain("Rhythm 3");
      expect(result.library.mediaSettings().root?.id).toBe(
        oldSettings.root?.id,
      );
      expect(result.library.mediaSettings().setupError).toBeUndefined();
      const track = result.library.tracks(managed.id)[0];
      expect(track.path).toBe(
        path.join(parent, path.relative(source.directory, canonicalPath)),
      );
      const root = result.library.db
        .prepare(
          "SELECT rootId AS id,path,device,inode FROM media_root_locations WHERE rootId=?",
        )
        .get(track.mediaRootId) as unknown as MediaRoot;
      await validateManagedTrash(
        result.library.db,
        root,
        track.id,
        track.path,
        track.mediaRelativePath!,
      );
    },
  );
});

test("preflight receipt failure leaves selected directory empty and reports move failure, not media recovery", async () => {
  await fixture(async ({ source, parent, pointer }: any) => {
    source.db.exec("UPDATE managed_file_receipts SET inode='invalid-receipt'");
    const settings = structuredClone(source.mediaSettings());
    const state = source.state();
    const failure = await relocateLibrary(source, parent, pointer).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(RelocationFailure);
    expect(failure.phase).toBe("preflight");
    expect(failure.message).toMatch(/^MOVE FAILED/);
    expect(failure.message).not.toMatch(
      /Choose its recovery source|Managed file location changed|Library moved|RELOCATION RECOVERY REQUIRED/,
    );
    expect(failure.incompleteDestination).toBe(false);
    expect(await readdir(parent)).toEqual([]);
    expect(structuredClone(source.mediaSettings())).toEqual(settings);
    expect(source.state()).toEqual(state);
    expect(JSON.parse(await readFile(pointer, "utf8")).libraryPath).toBe(
      source.directory,
    );
  });
});

test("nonexistent exact destination is created directly and no old-name child is appended", async () => {
  await fixture(async ({ source, parent, pointer, libraries }: any) => {
    await rm(parent, { recursive: true });
    const result = await relocateLibrary(source, parent, pointer);
    libraries.push(result.library);
    expect(result.status).toBe("moved");
    expect(result.library.directory).toBe(parent);
    expect(await readdir(parent)).toContain("rio.sqlite");
    expect(await readdir(parent)).not.toContain("Rhythm 3");
  });
});

test("relocation does not turn non-normalized managed-root paths into trusted aliases", async () => {
  await fixture(async ({ source, parent, pointer }: any) => {
    const stored = source.mediaSettings().root!;
    await mkdir(path.join(stored.path, "Intermediate"));
    source.db
      .prepare("UPDATE media_root_locations SET path=? WHERE rootId=?")
      .run(stored.path + "/Intermediate/..", stored.id);
    const failure = await relocateLibrary(source, parent, pointer).catch(
      (error) => error,
    );
    expect(failure).toBeInstanceOf(RelocationFailure);
    expect(failure.phase).toBe("preflight");
    expect(await readdir(parent)).toEqual([]);
    expect(JSON.parse(await readFile(pointer, "utf8")).libraryPath).toBe(
      source.directory,
    );
  });
});
