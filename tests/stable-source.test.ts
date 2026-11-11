import { MAX_FLAC_FILE_BYTES } from "../src/shared/flac-limits";
import { test, expect, vi } from "vitest";
import {
  mkdtemp,
  realpath,
  writeFile,
  readFile,
  rm,
  rename,
  symlink,
  chmod,
  readdir,
  mkdir,
  truncate,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import { Library } from "../src/domain/library";
import { PlaybackUse } from "../src/main/playback-use";
import {
  PlaybackCleanupError,
  StableSourceManager,
  type SnapshotBackend,
} from "../src/main/stable-source-manager";
import {
  editManagedFlac,
  MetadataEditInterruption,
} from "../src/domain/metadata-edit";
import { flacFixture } from "./metadata-fixtures";
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function fixture(
  run: (f: any) => Promise<void>,
  options: {
    enabled?: boolean;
    backend?: () => SnapshotBackend;
    concurrentEditing?: boolean;
    drainTimeoutMs?: number;
  } = {
    enabled: true,
  },
) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-stable-test-")),
  );
  const l = await Library.open(path.join(root, "Library"), {
    setupMediaRoot: true,
  });
  const manager = new StableSourceManager(options),
    use = new PlaybackUse(
      manager,
      options.concurrentEditing ?? false,
      options.drainTimeoutMs,
    );
  try {
    l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    const source = path.join(root, "source.flac");
    await writeFile(source, flacFixture());
    await l.add([source]);
    const t = l.tracks()[0];
    use.bindLibrary(l);
    use.allowOwner(1);
    const bytes = await readFile(t.path);
    await run({ root, l, t, manager, use, bytes, source });
  } finally {
    await use.shutdown();
    await manager.shutdown();
    if (l.db.isOpen) l.close();
    await rm(root, { recursive: true, force: true });
  }
}
const native = test.skipIf(process.platform !== "darwin");
const idle = (use: PlaybackUse, l: Library, id: string) => {
  const lease = use.usageFor(l).acquireIdle(id);
  lease.release();
};
const deferred = () => {
  let resolve!: (value?: any) => void;
  const promise = new Promise<any>((r) => (resolve = r));
  return { promise, resolve };
};
function backend(
  options: {
    hold?: ReturnType<typeof deferred>;
    read?: () => Promise<Uint8Array>;
    failure?: string;
  } = {},
) {
  let closed = false;
  return {
    async capture() {
      await options.hold?.promise;
      if (options.failure)
        throw Object.assign(Error(options.failure), { code: options.failure });
      return { size: 100, cloneMs: 0 };
    },
    async check() {
      return 100;
    },
    async read(_at: number, n: number) {
      return options.read ? options.read() : new Uint8Array(n);
    },
    async close() {
      closed = true;
    },
    get closed() {
      return closed;
    },
  };
}
test("disabled by default even when the internal acquisition method is called", () =>
  fixture(
    async ({ use, l, t, manager }) => {
      await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
        /disabled/,
      );
      expect(manager.activeSources).toBe(0);
      idle(use, l, t.id);
      const original = use.acquireForPlayback(1, t.id, l.directory);
      expect(() => idle(use, l, t.id)).toThrow(/in use/);
      await Promise.all([
        use.release(1, original.token),
        use.release(1, original.token),
      ]);
      await use.release(1, original.token);
      idle(use, l, t.id);
    },
    { enabled: false },
  ));
test("ordinary playback never calls the isolated backend, even if armed", () =>
  fixture(
    async ({ use, l, t, manager }) => {
      const s = use.acquire(1, t.id, l.directory);
      expect(manager.activeSources).toBe(0);
      await use.release(1, s.token);
    },
    {
      enabled: true,
      backend: () => {
        throw Error("Must not call");
      },
    },
  ));
for (const code of ["ENOSPC", "EIO", "EROFS", "ENOTSUP", "EXDEV", "ENOENT"])
  test(`failed ${code} acquisition drains its reservation and restores the existing gate`, () => {
    const b = backend({ failure: code });
    return fixture(
      async ({ l, t, use, manager }) => {
        await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
          code,
        );
        expect(b.closed).toBe(true);
        expect(manager.activeSources).toBe(0);
        expect(l.scanning).toBe(false);
        idle(use, l, t.id);
      },
      { enabled: true, backend: () => b },
    );
  });
test("owner revocation during capture waits for real closure; no late grant", () => {
  const hold = deferred(),
    b = backend({ hold });
  return fixture(
    async ({ l, t, use, manager }) => {
      const request = use.acquireIsolated(1, t.id, l.directory);
      const rejected = expect(request).rejects.toThrow(
        /released|revoked|unknown/,
      );
      expect(() => idle(use, l, t.id)).toThrow();
      expect(() => use.bindLibrary(null)).toThrow();
      let closed = false;
      const releasing = use.revokeOwner(1).then(() => (closed = true));
      await Promise.resolve();
      expect(closed).toBe(false);
      expect(b.closed).toBe(false);
      hold.resolve();
      await rejected;
      await releasing;
      expect(b.closed).toBe(true);
      expect(manager.activeSources).toBe(0);
      idle(use, l, t.id);
    },
    { enabled: true, backend: () => b },
  );
});
test("application shutdown during capture drains without untracking the library", () => {
  const hold = deferred(),
    b = backend({ hold });
  return fixture(
    async ({ l, t, use, manager }) => {
      const request = use.acquireIsolated(1, t.id, l.directory);
      const rejected = expect(request).rejects.toThrow();
      let done = false;
      const stopping = use.shutdown().then(() => (done = true));
      await Promise.resolve();
      expect(done).toBe(false);
      hold.resolve();
      await rejected;
      await stopping;
      expect(manager.activeSources).toBe(0);
      expect(b.closed).toBe(true);
    },
    { enabled: true, backend: () => b },
  );
});
test("manager shutdown during capture waits and rejects the unissued lease", () => {
  const hold = deferred(),
    b = backend({ hold });
  return fixture(
    async ({ l, t, use, manager }) => {
      const request = use.acquireIsolated(1, t.id, l.directory);
      const rejected = expect(request).rejects.toThrow(/revoked/);
      const stopping = manager.shutdown();
      hold.resolve();
      await rejected;
      await stopping;
      idle(use, l, t.id);
    },
    { enabled: true, backend: () => b },
  );
});
test("outstanding reads finish before the worker closes, including cancelled consumers", () => {
  const held = deferred(),
    entered = deferred(),
    b = backend({
      read: () => {
        entered.resolve();
        return held.promise;
      },
    });
  return fixture(
    async ({ l, t, use }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory),
        r = await use.respond(s.token, t.id, new Request(s.url));
      const body = r.arrayBuffer().catch(() => {});
      await entered.promise;
      const stopping = use.release(1, s.token);
      await Promise.resolve();
      expect(b.closed).toBe(false);
      expect(() => idle(use, l, t.id)).toThrow();
      held.resolve(new Uint8Array(100));
      await stopping;
      await body;
      expect(b.closed).toBe(true);
      idle(use, l, t.id);
    },
    { enabled: true, backend: () => b },
  );
});
test("request awaiting worker validation cannot open after release", () => {
  const check = deferred(),
    b = { ...backend(), check: () => check.promise };
  return fixture(
    async ({ l, t, use }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory),
        response = use.respond(s.token, t.id, new Request(s.url));
      const released = use.release(1, s.token);
      check.resolve(100);
      expect((await response).status).toBe(503);
      await released;
      idle(use, l, t.id);
    },
    { enabled: true, backend: () => b },
  );
});
test("stream I/O failure retires the source and closes the backend", () => {
  const b = backend({
    read: async () => {
      throw Object.assign(Error("Disconnected"), { code: "EIO" });
    },
  });
  return fixture(
    async ({ l, t, use, manager }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory),
        r = await use.respond(s.token, t.id, new Request(s.url));
      await expect(r.arrayBuffer()).rejects.toThrow();
      expect(() => idle(use, l, t.id)).toThrow();
      await use.release(1, s.token);
      expect(b.closed).toBe(true);
      expect(manager.activeSources).toBe(0);
    },
    { enabled: true, backend: () => b },
  );
});
for (const mutation of [
  "referenced",
  "missing",
  "format",
  "no-receipt",
  "pending-journal",
  "scanning",
])
  test(`rejects ${mutation} without consulting a clone backend`, () =>
    fixture(
      async ({ l, t, use }) => {
        if (mutation === "referenced")
          l.db
            .prepare(
              "UPDATE track_locations SET kind='referenced',mediaRootId=NULL,relativePath=NULL WHERE trackId=?",
            )
            .run(t.id);
        if (mutation === "missing")
          l.db.prepare("UPDATE tracks SET missing=1 WHERE id=?").run(t.id);
        if (mutation === "format")
          l.db.prepare("UPDATE tracks SET format='mp3' WHERE id=?").run(t.id);
        if (mutation === "no-receipt")
          l.db
            .prepare("DELETE FROM managed_file_receipts WHERE trackId=?")
            .run(t.id);
        if (mutation === "pending-journal")
          l.db
            .prepare(
              "INSERT INTO metadata_edits VALUES('pending',?,?,?,'preparing','{}',NULL,0)",
            )
            .run(t.id, t.mediaRootId, t.mediaRelativePath);
        if (mutation === "scanning") l.scanning = true;
        try {
          await expect(
            use.acquireIsolated(1, t.id, l.directory),
          ).rejects.toThrow();
        } finally {
          l.scanning = false;
          if (mutation === "pending-journal")
            l.db.prepare("DELETE FROM metadata_edits").run();
        }
      },
      {
        enabled: true,
        backend: () => {
          throw Error("Backend must not be reached");
        },
      },
    ));
native(
  "real native clone is anonymous, token-only, ranged and still blocks metadata editing",
  () =>
    fixture(async ({ l, t, use, manager, bytes }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      expect(Object.keys(s).sort()).toEqual(["token", "url"]);
      expect(
        (await readdir(l.mediaSettings().root.path)).some((n: string) =>
          n.startsWith(".rio-playback-"),
        ),
      ).toBe(false);
      expect(() => idle(use, l, t.id)).toThrow(/in use/);
      await expect(
        editManagedFlac(
          l,
          t.id,
          { title: { action: "set", value: "Blocked" } },
          { usage: use.usageFor(l) },
        ),
      ).rejects.toThrow(/in use/);
      expect(
        (await use.respond("unknown", t.id, new Request(s.url))).status,
      ).toBe(403);
      expect(
        (await use.respond(s.token, "wrong", new Request(s.url))).status,
      ).toBe(403);
      expect(() => use.acquire(2, t.id, l.directory)).toThrow();
      await expect(use.release(2, s.token)).rejects.toThrow(/another/);
      const r = await use.respond(
        s.token,
        t.id,
        new Request(s.url, { headers: { range: "bytes=2-17" } }),
      );
      expect(r.status).toBe(206);
      expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes.subarray(2, 18));
      await use.release(1, s.token);
      expect(manager.activeSources).toBe(0);
      expect(
        (await use.respond(s.token, t.id, new Request(s.url))).status,
      ).toBe(403);
      idle(use, l, t.id);
    }),
);
native(
  "two snapshots and concurrent readers remain independent until final lease closes",
  () =>
    fixture(async ({ l, t, use, manager, bytes }) => {
      const a = await use.acquireIsolated(1, t.id, l.directory),
        b = await use.acquireIsolated(1, t.id, l.directory);
      await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
        /budget/,
      );
      const responses = await Promise.all([
        use.respond(a.token, t.id, new Request(a.url)),
        use.respond(b.token, t.id, new Request(b.url)),
      ]);
      for (const r of responses)
        expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes);
      await use.release(1, a.token);
      expect(manager.activeSources).toBe(1);
      expect(() => idle(use, l, t.id)).toThrow();
      await use.release(1, b.token);
      idle(use, l, t.id);
    }),
);
native(
  "source switching, owner destruction and library teardown clean up real snapshots",
  () =>
    fixture(async ({ root, l, t, use, manager }) => {
      const other = path.join(root, "other.flac");
      await writeFile(other, flacFixture({ entries: [["TITLE", "Other"]] }));
      await l.add([other]);
      const t2 = l.tracks().find((x: any) => x.id !== t.id)!;
      const a = await use.acquireIsolated(1, t.id, l.directory);
      await use.release(1, a.token);
      const b = await use.acquireIsolated(1, t2.id, l.directory);
      await use.revokeOwner(1);
      expect(
        (await use.respond(b.token, t2.id, new Request(b.url))).status,
      ).toBe(403);
      expect(manager.activeSources).toBe(0);
      use.bindLibrary(null);
      expect(() => idle(use, l, t.id)).toThrow();
    }),
);
native(
  "clone preserves its entire image across a real staged edit and interruption recovery",
  () =>
    fixture(async ({ l, t, use, manager, bytes }) => {
      const snapshot = await manager.acquire(l, t.id, () => {
        if (!l.db.isOpen) throw Error("Closed");
      });
      try {
        await expect(
          editManagedFlac(
            l,
            t.id,
            { genre: { action: "set", value: "Edited" } },
            {
              usage: use.usageFor(l),
              hooks: {
                at: async (phase) => {
                  if (phase === "published")
                    throw new MetadataEditInterruption("After publication");
                },
              },
            },
          ),
        ).rejects.toThrow("After publication");
        const core = await import("../src/domain/metadata-edit");
        await core.recoverMetadataEdits(l);
        const parts: Buffer[] = [];
        for await (const chunk of snapshot.stream(0, snapshot.metrics.size - 1))
          parts.push(Buffer.from(chunk));
        expect(sha(Buffer.concat(parts))).toBe(sha(bytes));
        expect(sha(await readFile(t.path))).not.toBe(sha(bytes));
      } finally {
        await snapshot.release();
      }
    }),
);
native(
  "changed receipts, symlinks and missing files fail without named scratch residue",
  async () => {
    for (const kind of ["bytes", "symlink", "missing", "root", "parent"]) {
      await fixture(async ({ root, l, t, use, manager }) => {
        if (kind === "bytes")
          await writeFile(
            t.path,
            flacFixture({ entries: [["TITLE", "Changed"]] }),
          );
        else if (kind === "missing")
          await rename(t.path, path.join(root, "parked"));
        else if (kind === "symlink") {
          await rename(t.path, path.join(root, "parked"));
          await symlink(path.join(root, "parked"), t.path);
        } else if (kind === "root") {
          await rename(
            l.mediaSettings().root.path,
            path.join(root, "parked-root"),
          );
        } else {
          await chmod(t.path, 0o444);
          await rename(t.path, path.join(root, "parked"));
          await symlink(path.join(root, "parked"), t.path);
        }
        await expect(
          use.acquireIsolated(1, t.id, l.directory),
        ).rejects.toThrow();
        expect(manager.activeSources).toBe(0);
        idle(use, l, t.id);
      });
    }
  },
);
native(
  "unknown scratch entries are retained and reject new capture; no recursive cleanup",
  () =>
    fixture(async ({ l, t, use, manager }) => {
      const orphan = path.join(
        l.mediaSettings().root.path,
        ".rio-playback-unknown",
      );
      await mkdir(orphan);
      await writeFile(path.join(orphan, "keep"), "Unknown");
      await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
        /requires review/,
      );
      expect(await readFile(path.join(orphan, "keep"), "utf8")).toBe("Unknown");
      expect(manager.activeSources).toBe(0);
    }),
);
native(
  "repeated acquisition and release stays bounded and leaves no cache files",
  () =>
    fixture(async ({ l, t, use, manager }) => {
      for (let n = 0; n < 8; n++) {
        const s = await use.acquireIsolated(1, t.id, l.directory);
        await use.release(1, s.token);
        expect(manager.activeSources).toBe(0);
      }
      expect(
        (await readdir(l.mediaSettings().root.path)).some((n: string) =>
          n.startsWith(".rio-playback-"),
        ),
      ).toBe(false);
    }),
);
test("reader admission stays bounded while eight real reservations await I/O", () => {
  const hold = deferred();
  let reads = 0;
  const b = backend({
    read: () => {
      reads++;
      return hold.promise;
    },
  });
  return fixture(
    async ({ l, t, use, manager }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory),
        responses = [];
      for (let i = 0; i < 8; i++)
        responses.push(await use.respond(s.token, t.id, new Request(s.url)));
      await vi.waitFor(() => expect(reads).toBe(8));
      expect(
        (await use.respond(s.token, t.id, new Request(s.url))).status,
      ).toBe(503);
      const stopping = use.release(1, s.token);
      hold.resolve(new Uint8Array(100));
      await stopping;
      await Promise.all(responses.map((r) => r.arrayBuffer().catch(() => {})));
      expect(manager.activeSources).toBe(0);
    },
    { enabled: true, backend: () => b },
  );
});
native(
  "unexpected worker exit reclaims its native descriptors and remains fail closed",
  () =>
    fixture(async ({ l, t, use, manager }) => {
      const count = async () => (await readdir("/dev/fd")).length;
      const before = await count();
      for (let i = 0; i < 4; i++) {
        const s = await use.acquireIsolated(1, t.id, l.directory);
        const entry = [...(manager as any).entries][0];
        await entry.backend.worker.terminate();
        expect(
          (await use.respond(s.token, t.id, new Request(s.url))).status,
        ).toBe(503);
        expect(() => idle(use, l, t.id)).toThrow();
        await use.release(1, s.token);
        expect(manager.activeSources).toBe(0);
      }
      expect(await count()).toBeLessThanOrEqual(before + 2);
    }),
);
test.skipIf(process.platform === "darwin")(
  "armed infrastructure rejects unsupported host platforms",
  () =>
    fixture(async ({ l, t, use }) => {
      await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
        /APFS/,
      );
      idle(use, l, t.id);
    }),
);
test("a receipt revision changed during capture is refused before any grant", () => {
  const hold = deferred(),
    b = backend({ hold });
  return fixture(
    async ({ l, t, use, manager }) => {
      const acquiring = use.acquireIsolated(1, t.id, l.directory),
        refused = expect(acquiring).rejects.toThrow(/changed during capture/);
      l.db
        .prepare("UPDATE managed_file_receipts SET digest=? WHERE trackId=?")
        .run("0".repeat(64), t.id);
      hold.resolve();
      await refused;
      expect(b.closed).toBe(true);
      expect(manager.activeSources).toBe(0);
      idle(use, l, t.id);
    },
    { enabled: true, backend: () => b },
  );
});
native("append-only originals are refused before creating scratch state", () =>
  fixture(async ({ l, t, use }) => {
    execFileSync("/usr/bin/chflags", ["uappnd", t.path]);
    try {
      await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
        /empty or immutable/,
      );
      expect(
        (await readdir(l.mediaSettings().root.path)).some((n: string) =>
          n.startsWith(".rio-playback-"),
        ),
      ).toBe(false);
    } finally {
      execFileSync("/usr/bin/chflags", ["nouappnd", t.path]);
    }
  }),
);
test("the internal environment flag is opt-in; an unset flag performs no I/O", async () => {
  const saved = process.env.RIO_STABLE_PLAYBACK_SOURCES;
  try {
    delete process.env.RIO_STABLE_PLAYBACK_SOURCES;
    const manager = new StableSourceManager();
    await expect(manager.acquire(null as any, "id", () => {})).rejects.toThrow(
      /disabled/,
    );
    expect(manager.activeSources).toBe(0);
    await manager.shutdown();
  } finally {
    if (saved === undefined) delete process.env.RIO_STABLE_PLAYBACK_SOURCES;
    else process.env.RIO_STABLE_PLAYBACK_SOURCES = saved;
  }
});
test("changed managed-root authority invalidates a retained source without clearing its logical lease", () =>
  fixture(
    async ({ root, l, t, use, manager }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      const next = path.join(root, "Next Media");
      await mkdir(next);
      await l.chooseMediaRoot(next);
      expect(
        (await use.respond(s.token, t.id, new Request(s.url))).status,
      ).toBe(503);
      expect(() => idle(use, l, t.id)).toThrow();
      await use.release(1, s.token);
      expect(manager.activeSources).toBe(0);
    },
    { enabled: true, backend: () => backend() },
  ));
test("unconsumed transport keeps read-ahead bounded instead of loading a whole source", () => {
  let reads = 0;
  const b = {
    ...backend(),
    capture: async () => ({ size: 64 * 1024 * 1024, cloneMs: 0 }),
    check: async () => 64 * 1024 * 1024,
    read: async (_at: number, n: number) => {
      reads++;
      return new Uint8Array(n);
    },
  };
  return fixture(
    async ({ l, t, use }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory),
        r = await use.respond(s.token, t.id, new Request(s.url));
      for (let n = 0; n < 5; n++)
        await new Promise<void>((resolve) => setImmediate(resolve));
      expect(reads).toBeGreaterThan(0);
      expect(reads).toBeLessThanOrEqual(4);
      await r.body?.cancel();
      await use.release(1, s.token);
    },
    { enabled: true, backend: () => b },
  );
});
test("background I/O cleanup retains an unconfirmed entry for a later close attempt", () => {
  let canClose = false;
  const b = {
    ...backend(),
    check: async () => {
      throw Error("Read failed");
    },
    close: async () => {
      if (!canClose) throw Error("Close acknowledgement failed");
    },
  };
  return fixture(
    async ({ l, t, manager }) => {
      const lease = await manager.acquire(l, t.id, () => {});
      await expect(lease.size()).rejects.toThrow("Read failed");
      await expect(lease.release()).rejects.toMatchObject({
        cause: expect.objectContaining({
          message: "Close acknowledgement failed",
        }),
      });
      expect(manager.activeSources).toBe(1);
      canClose = true;
      await lease.release();
      expect(manager.activeSources).toBe(0);
    },
    { enabled: true, backend: () => b },
  );
});

test("concurrent and repeated release recover after confirmed close with a cleanup error", () => {
  const held = deferred(),
    entered = deferred();
  const b = backend({
    read: async () => {
      entered.resolve();
      return held.promise;
    },
  });
  const close = vi.fn(async () => {
    await b.close();
    throw new PlaybackCleanupError(Error("post-close cleanup failed"));
  });
  return fixture(
    async ({ l, t, use, manager }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      const response = await use.respond(s.token, t.id, new Request(s.url));
      const consuming = response.arrayBuffer().catch(() => {});
      await entered.promise;
      const first = use.release(1, s.token);
      const second = use.release(1, s.token);
      try {
        expect(close).not.toHaveBeenCalled();
        expect(
          (await use.respond(s.token, t.id, new Request(s.url))).status,
        ).toBe(403);
        expect(() => idle(use, l, t.id)).toThrow(/could not be confirmed/);
      } finally {
        held.resolve(new Uint8Array(100));
        await Promise.all([first, second, consuming]);
      }
      expect(close).toHaveBeenCalledTimes(1);
      expect(b.closed).toBe(true);
      expect(manager.activeSources).toBe(0);
      await use.release(1, s.token);
      expect(close).toHaveBeenCalledTimes(1);
      idle(use, l, t.id);
      await use.releaseLibrary();
      use.bindLibrary(l);
      const next = await use.acquireIsolated(1, t.id, l.directory);
      expect(next.token).not.toBe(s.token);
      await use.release(1, next.token);
    },
    {
      enabled: true,
      backend: () => ({ ...b, close }),
      concurrentEditing: true,
    },
  );
});

test("unconfirmed closure blocks admission and an issued edit lease until release is retried", () => {
  let canClose = false;
  const b = backend();
  const close = vi.fn(async () => {
    if (!canClose) throw Error("Backend closure is unknown");
    await b.close();
  });
  return fixture(
    async ({ l, t, use, manager }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      try {
        const edit = use.usageFor(l).acquireIdle(t.id);
        try {
          await expect(use.revokeOwner(1)).rejects.toThrow(
            /confirm playback source closure/,
          );
          expect(() => edit.assertIdle()).toThrow(/could not be confirmed/);
        } finally {
          edit.release();
        }
        expect(manager.activeSources).toBe(1);
        expect(b.closed).toBe(false);
        expect(
          (await use.respond(s.token, t.id, new Request(s.url))).status,
        ).toBe(403);
        expect(() => idle(use, l, t.id)).toThrow(/could not be confirmed/);
        await expect(
          editManagedFlac(
            l,
            t.id,
            { title: { action: "set", value: "Blocked" } },
            {
              usage: use.usageFor(l),
            },
          ),
        ).rejects.toThrow(/could not be confirmed/);
        expect(l.db.prepare("SELECT id FROM metadata_edits").all()).toEqual([]);
        use.allowOwner(2);
        expect(() => use.acquire(2, t.id, l.directory)).toThrow(
          /could not be confirmed/,
        );
        await expect(use.releaseLibrary()).rejects.toThrow(
          /confirm playback source closure/,
        );
        expect(() => use.bindLibrary(null)).toThrow(/must be released/);
      } finally {
        canClose = true;
      }
      await use.releaseLibrary();
      expect(b.closed).toBe(true);
      expect(close).toHaveBeenCalledTimes(3);
      expect(manager.activeSources).toBe(0);
      idle(use, l, t.id);
    },
    {
      enabled: true,
      backend: () => ({ ...b, close }),
      concurrentEditing: true,
    },
  );
});

test("shutdown reports a stalled reader and keeps the library bound until the same drain completes", () => {
  const held = deferred(),
    entered = deferred();
  const b = backend({
    read: async () => {
      entered.resolve();
      return held.promise;
    },
  });
  return fixture(
    async ({ l, t, use, manager }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      const response = await use.respond(s.token, t.id, new Request(s.url));
      const consuming = response.arrayBuffer().catch(() => {});
      await entered.promise;
      try {
        await expect(use.shutdown()).rejects.toThrow(
          /confirm playback drainage/,
        );
        expect(use.currentLibrary).toBe(l);
        expect(manager.activeSources).toBe(1);
        expect(b.closed).toBe(false);
        expect(() => idle(use, l, t.id)).toThrow(/unknown/);
      } finally {
        held.resolve(new Uint8Array(100));
        await consuming;
      }
      await use.shutdown();
      expect(use.currentLibrary).toBeNull();
      expect(manager.activeSources).toBe(0);
      expect(b.closed).toBe(true);
    },
    {
      enabled: true,
      backend: () => b,
      concurrentEditing: true,
      drainTimeoutMs: 50,
    },
  );
});

test("failed capture retains its original reservation when backend closure is unknown", () => {
  let canClose = false;
  const b = backend({ failure: "Capture failed" });
  return fixture(
    async ({ l, t, use, manager }) => {
      try {
        await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
          /confirm playback source closure/,
        );
        expect(manager.activeSources).toBe(1);
        expect(() => idle(use, l, t.id)).toThrow(/could not be confirmed/);
        expect(() => use.acquire(1, t.id, l.directory)).toThrow(
          /could not be confirmed/,
        );
      } finally {
        canClose = true;
      }
      await use.releaseLibrary();
      expect(manager.activeSources).toBe(0);
      idle(use, l, t.id);
    },
    {
      enabled: true,
      backend: () => ({
        ...b,
        async close() {
          if (!canClose) throw Error("Capture cleanup not confirmed");
          await b.close();
        },
      }),
      concurrentEditing: true,
    },
  );
});

native(
  "an actual playback worker exit drains its native source and permits reacquisition after release",
  () =>
    fixture(
      async ({ l, t, use, manager }) => {
        let worker: Worker | undefined;
        const postMessage = Worker.prototype.postMessage;
        const spy = vi
          .spyOn(Worker.prototype, "postMessage")
          .mockImplementation(function (this: Worker, message, transferList) {
            if (message.method === "capture") worker = this;
            return postMessage.call(this, message, transferList);
          });
        try {
          const s = await use.acquireIsolated(1, t.id, l.directory);
          expect(worker).toBeDefined();
          await worker!.terminate();
          expect(() => idle(use, l, t.id)).toThrow(/worker exited/);
          await use.release(1, s.token);
          expect(manager.activeSources).toBe(0);
          idle(use, l, t.id);
          const next = await use.acquireIsolated(1, t.id, l.directory);
          const response = await use.respond(
            next.token,
            t.id,
            new Request(next.url),
          );
          expect(response.status).toBe(200);
          await response.arrayBuffer();
          await use.release(1, next.token);
        } finally {
          spy.mockRestore();
        }
      },
      { enabled: true, concurrentEditing: true },
    ),
);
native("a stale indexed size cannot permit an oversized physical target", () =>
  fixture(async ({ l, t, use, manager }) => {
    await truncate(t.path, MAX_FLAC_FILE_BYTES + 1);
    await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
      /128 MiB/,
    );
    expect(manager.activeSources).toBe(0);
    idle(use, l, t.id);
  }),
);
test("flagged selection uses isolated managed FLAC and keeps the metadata gate held", () =>
  fixture(
    async ({ l, t, use, manager }) => {
      const s = await use.acquireForPlayback(1, t.id, l.directory);
      expect(manager.activeSources).toBe(process.platform === "darwin" ? 1 : 0);
      expect(() => idle(use, l, t.id)).toThrow();
      await use.release(1, s.token);
    },
    { enabled: true, backend: () => backend() },
  ));
test("classified unsupported storage closes its probe and explicitly uses the original path", () => {
  const b = {
    ...backend(),
    capture: async () => ({ unsupported: true as const }),
  };
  return fixture(
    async ({ l, t, use, manager, bytes }) => {
      const s = await use.acquireForPlayback(1, t.id, l.directory);
      expect(manager.activeSources).toBe(0);
      expect(
        Buffer.from(
          await (
            await use.respond(s.token, t.id, new Request(s.url))
          ).arrayBuffer(),
        ),
      ).toEqual(bytes);
      expect(() => idle(use, l, t.id)).toThrow();
      await use.release(1, s.token);
    },
    { enabled: true, backend: () => b },
  );
});
for (const code of ["ENOSPC", "EIO", "EACCES"])
  test.skipIf(process.platform !== "darwin")(
    `flagged capture ${code} cannot fall back to an original grant`,
    () =>
      fixture(
        async ({ l, t, use, manager }) => {
          await expect(
            use.acquireForPlayback(1, t.id, l.directory),
          ).rejects.toThrow(code);
          expect(manager.activeSources).toBe(0);
          idle(use, l, t.id);
        },
        { enabled: true, backend: () => backend({ failure: code }) },
      ),
  );
test("reference and other-format selections never start the isolated factory", () =>
  fixture(
    async ({ l, t, use }) => {
      l.db
        .prepare(
          "UPDATE track_locations SET kind='referenced',mediaRootId=NULL,relativePath=NULL WHERE trackId=?",
        )
        .run(t.id);
      let s = await use.acquireForPlayback(1, t.id, l.directory);
      await use.release(1, s.token);
      l.db
        .prepare(
          "UPDATE track_locations SET kind='managed',mediaRootId=?,relativePath=? WHERE trackId=?",
        )
        .run(t.mediaRootId, t.mediaRelativePath, t.id);
      l.db.prepare("UPDATE tracks SET format='wav' WHERE id=?").run(t.id);
      s = await use.acquireForPlayback(1, t.id, l.directory);
      await use.release(1, s.token);
    },
    {
      enabled: true,
      backend: () => {
        throw Error("Should not create snapshot");
      },
    },
  ));
test("cancelling a protocol range reader keeps the shared clone and logical lease alive", () => {
  const size = 1024 * 1024;
  const b = {
    ...backend(),
    capture: async () => ({ size, cloneMs: 0 }),
    check: async () => size,
    read: async (_at: number, n: number) => {
      await new Promise<void>((r) => setImmediate(r));
      return new Uint8Array(n).fill(58);
    },
  };
  return fixture(
    async ({ l, t, use, manager }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      const first = await use.respond(s.token, t.id, new Request(s.url));
      const reader = first.body!.getReader();
      expect((await reader.read()).value?.length).toBeGreaterThan(0);
      await reader.cancel(new DOMException("Range superseded", "AbortError"));
      for (let n = 0; n < 3; n++)
        await new Promise<void>((r) => setImmediate(r));
      expect(manager.activeSources).toBe(1);
      expect(() => idle(use, l, t.id)).toThrow();
      const next = await use.respond(
        s.token,
        t.id,
        new Request(s.url, { headers: { Range: "bytes=61-72" } }),
      );
      expect(next.status).toBe(206);
      expect(new Uint8Array(await next.arrayBuffer())).toEqual(
        new Uint8Array(12).fill(58),
      );
      await use.release(1, s.token);
      expect(manager.activeSources).toBe(0);
    },
    { enabled: true, backend: () => b },
  );
});

test("verified isolated use permits metadata while original readers and capture remain excluded", () =>
  fixture(
    async ({ l, t, use }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      const lease = use.usageFor(l).acquireIdle(t.id);
      lease.assertIdle();
      expect(() => use.acquire(1, t.id, l.directory)).toThrow(/locked/);
      await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
        /locked/,
      );
      // Drain an isolated token during publication without changing the locked original gate.
      await use.release(1, s.token);
      lease.assertIdle();
      lease.release();
      const original = use.acquire(1, t.id, l.directory);
      expect(() => idle(use, l, t.id)).toThrow();
      await use.release(1, original.token);
    },
    { enabled: true, backend: () => backend(), concurrentEditing: true },
  ));

test("preparing isolation still reserves original-file use", () => {
  const h = deferred();
  return fixture(
    async ({ l, t, use }) => {
      const pending = use.acquireIsolated(1, t.id, l.directory);
      expect(() => idle(use, l, t.id)).toThrow();
      h.resolve();
      const s = await pending;
      idle(use, l, t.id);
      await use.release(1, s.token);
    },
    {
      enabled: true,
      backend: () => backend({ hold: h }),
      concurrentEditing: true,
    },
  );
});

test("an original token blocks editing even when another token is isolated", () =>
  fixture(
    async ({ l, t, use }) => {
      const old = use.acquire(1, t.id, l.directory);
      const isolated = await use.acquireIsolated(1, t.id, l.directory);
      expect(() => idle(use, l, t.id)).toThrow();
      await use.release(1, old.token);
      idle(use, l, t.id);
      await use.release(1, isolated.token);
    },
    { enabled: true, backend: () => backend(), concurrentEditing: true },
  ));

test("unexpected receipt changes and lost isolated authority fail closed", () =>
  fixture(
    async ({ l, t, use }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      l.db
        .prepare("UPDATE managed_file_receipts SET digest=? WHERE trackId=?")
        .run("f".repeat(64), t.id);
      expect(() => idle(use, l, t.id)).toThrow(/revision/);
      await use.release(1, s.token);
    },
    { enabled: true, backend: () => backend(), concurrentEditing: true },
  ));

native(
  "concurrent coordinator edits preserve the old clone, journal-time ranges and future revisions",
  () =>
    fixture(
      async ({ l, t, use, bytes }) => {
        const s = await use.acquireIsolated(1, t.id, l.directory);
        for (const title of ["Concurrent one", "Concurrent two"]) {
          const result = await editManagedFlac(
            l,
            t.id,
            { title: { action: "set", value: title } },
            {
              usage: use.usageFor(l),
              hooks: {
                at: async (phase) => {
                  if (phase !== "staged" && phase !== "published") return;
                  expect(l.media(t.id)).toBeUndefined();
                  const r = await use.respond(
                    s.token,
                    t.id,
                    new Request(s.url),
                  );
                  expect(r.status).toBe(200);
                  expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes);
                  expect(() => use.acquire(1, t.id, l.directory)).toThrow();
                },
              },
            },
          );
          expect(result.status).toBe("committed");
          expect(l.tracks(t.id)[0].title).toBe(title);
          idle(use, l, t.id);
        }
        expect(
          Buffer.from(
            await (
              await use.respond(s.token, t.id, new Request(s.url))
            ).arrayBuffer(),
          ),
        ).toEqual(bytes);
        const next = await use.acquireIsolated(1, t.id, l.directory);
        const latest = await readFile(t.path);
        expect(
          Buffer.from(
            await (
              await use.respond(next.token, t.id, new Request(next.url))
            ).arrayBuffer(),
          ),
        ).toEqual(latest);
        expect(latest.equals(bytes)).toBe(false);
        await use.release(1, s.token);
        await use.release(1, next.token);
      },
      { enabled: true, concurrentEditing: true },
    ),
);

native(
  "metadata failure before publication retains isolated playback and retry eligibility",
  () =>
    fixture(
      async ({ l, t, use, bytes }) => {
        const s = await use.acquireIsolated(1, t.id, l.directory);
        await expect(
          editManagedFlac(
            l,
            t.id,
            { title: { action: "set", value: "Fail" } },
            {
              usage: use.usageFor(l),
              hooks: {
                at: async (phase) => {
                  if (phase === "before-publish")
                    throw Error("Disposable pre-publication failure");
                },
              },
            },
          ),
        ).rejects.toThrow(/Disposable/);
        expect(
          Buffer.from(
            await (
              await use.respond(s.token, t.id, new Request(s.url))
            ).arrayBuffer(),
          ),
        ).toEqual(bytes);
        idle(use, l, t.id);
        await use.release(1, s.token);
      },
      { enabled: true, concurrentEditing: true },
    ),
);

test("original revision is revalidated while the publication lease is held", () =>
  fixture(
    async ({ l, t, use }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      const lease = use.usageFor(l).acquireIdle(t.id);
      l.db
        .prepare("UPDATE managed_file_receipts SET digest=? WHERE trackId=?")
        .run("f".repeat(64), t.id);
      expect(() => lease.assertIdle()).toThrow(/revision/);
      lease.release();
      await use.release(1, s.token);
    },
    { enabled: true, backend: () => backend(), concurrentEditing: true },
  ));

test("known worker failure prevents publication eligibility instead of reverting to original use", () => {
  let failed = false;
  const b = {
    ...backend(),
    assertAvailable: () => {
      if (failed) throw Error("Worker lost");
    },
  };
  return fixture(
    async ({ l, t, use }) => {
      const s = await use.acquireIsolated(1, t.id, l.directory);
      failed = true;
      expect(() => idle(use, l, t.id)).toThrow(/Worker lost/);
      expect(
        (await use.respond(s.token, t.id, new Request(s.url))).status,
      ).not.toBe(200);
      await use.release(1, s.token);
    },
    { enabled: true, backend: () => b, concurrentEditing: true },
  );
});

native(
  "unrecoverable original availability does not turn a verified clone into an original reader",
  () =>
    fixture(
      async ({ l, t, use, bytes }) => {
        const s = await use.acquireIsolated(1, t.id, l.directory);
        // Existing in-place recovery marks an unverified original missing for Locate.
        l.db.prepare("UPDATE tracks SET missing=1 WHERE id=?").run(t.id);
        const r = await use.respond(s.token, t.id, new Request(s.url));
        expect(r.status).toBe(200);
        expect(Buffer.from(await r.arrayBuffer())).toEqual(bytes);
        await use.release(1, s.token);
        await expect(use.acquireIsolated(1, t.id, l.directory)).rejects.toThrow(
          /available/,
        );
      },
      { enabled: true, concurrentEditing: true },
    ),
);

test("flagged selection admits a formerly oversized managed FLAC and retains disabled-mode exclusion", async () => {
  const size = 70 * 1024 * 1024;
  for (const enabled of [true, false]) {
    await fixture(
      async ({ l, t, use, manager }) => {
        l.db.prepare("UPDATE tracks SET size=? WHERE id=?").run(size, t.id);
        const grant = await use.acquireForPlayback(1, t.id, l.directory);
        const isolated = enabled && process.platform === "darwin";
        expect(manager.activeSources).toBe(isolated ? 1 : 0);
        if (isolated) idle(use, l, t.id);
        else expect(() => idle(use, l, t.id)).toThrow(/in use/);
        await use.release(1, grant.token);
        expect(manager.activeSources).toBe(0);
        idle(use, l, t.id);
      },
      {
        enabled,
        concurrentEditing: true,
        backend: () => ({
          ...backend(),
          capture: async () => ({ size, cloneMs: 0 }),
          check: async () => size,
        }),
      },
    );
  }
});
