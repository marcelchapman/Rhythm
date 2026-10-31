import { test, expect } from "vitest";
import { mkdtemp, realpath, writeFile, rm, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Library } from "../src/domain/library";
import { PlaybackUse } from "../src/main/playback-use";
import { editManagedFlac } from "../src/domain/metadata-edit";
import { flacFixture } from "./metadata-fixtures";
import { defaultState } from "../src/shared/types";

async function fixture(run: (f: any) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "rio-use-")));
  const l = await Library.open(path.join(root, "Library"), {
    setupMediaRoot: true,
  });
  const use = new PlaybackUse();
  try {
    l.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    const source = path.join(root, "source.flac");
    await writeFile(source, flacFixture());
    await l.add([source]);
    const t = l.tracks()[0];
    use.bindLibrary(l);
    use.allowOwner(1);
    const edit = () =>
      editManagedFlac(
        l,
        t.id,
        { title: { action: "set", value: "Edited" } },
        { usage: use.usageFor(l) },
      );
    await run({ root, l, t, use, edit });
  } finally {
    await use.shutdown();
    if (l.db.isOpen) l.close();
    await rm(root, { recursive: true, force: true });
  }
}
const idle = (use: PlaybackUse, l: Library, id: string) => {
  const lease = use.usageFor(l).acquireIdle(id);
  lease.assertIdle();
  lease.release();
};
test("active source blocks coordinator; release permits same-track edit", () =>
  fixture(async ({ l, t, use, edit }) => {
    const s = use.acquire(1, t.id, l.directory);
    await expect(edit()).rejects.toThrow(/in use/);
    await use.release(1, s.token);
    expect((await edit()).status).toBe("committed");
  }));
test("idle metadata lease rejects new playback before any source exists", () =>
  fixture(async ({ l, t, use }) => {
    const lease = use.usageFor(l).acquireIdle(t.id);
    expect(() => use.acquire(1, t.id, l.directory)).toThrow(/locked/);
    lease.assertIdle();
    lease.release();
    const s = use.acquire(1, t.id, l.directory);
    await use.release(1, s.token);
  }));
test("saved queue/currentId alone is not playback ownership", () =>
  fixture(async ({ l, t, use, edit }) => {
    l.saveState({
      ...defaultState(),
      queue: [t.id],
      currentId: t.id,
      position: 3,
    });
    expect((await edit()).status).toBe("committed");
    expect(l.state().currentId).toBe(t.id);
  }));
test("multiple acquired sources retain use until the last release", () =>
  fixture(async ({ l, t, use }) => {
    const a = use.acquire(1, t.id, l.directory),
      b = use.acquire(1, t.id, l.directory);
    await use.release(1, a.token);
    expect(() => idle(use, l, t.id)).toThrow(/in use/);
    await use.release(1, b.token);
    idle(use, l, t.id);
  }));
test("fully buffered transport is still owned until decoder source release (including pause)", () =>
  fixture(async ({ l, t, use }) => {
    const s = use.acquire(1, t.id, l.directory);
    const r = await use.respond(s.token, t.id, new Request(s.url));
    expect(r.status).toBe(200);
    await r.arrayBuffer();
    expect(() => idle(use, l, t.id)).toThrow(/in use/);
    await use.release(1, s.token);
    idle(use, l, t.id);
  }));
test("revocation cancels a live transport and only then permits editing; stale token cannot reopen", () =>
  fixture(async ({ l, t, use }) => {
    const s = use.acquire(1, t.id, l.directory);
    const r = await use.respond(s.token, t.id, new Request(s.url));
    const consuming = r.arrayBuffer().catch(() => {});
    const released = use.release(1, s.token);
    expect(() => idle(use, l, t.id)).toThrow(/in use/);
    await released;
    await consuming;
    idle(use, l, t.id);
    expect((await use.respond(s.token, t.id, new Request(s.url))).status).toBe(
      403,
    );
  }));
test("a request awaiting stat cannot open after source release", () =>
  fixture(async ({ l, t, use }) => {
    const s = use.acquire(1, t.id, l.directory);
    const response = use.respond(s.token, t.id, new Request(s.url));
    const released = use.release(1, s.token);
    expect(() => idle(use, l, t.id)).toThrow();
    expect((await response).status).toBe(503);
    await released;
    idle(use, l, t.id);
  }));
test("renderer teardown releases sources, disallows reacquisition and preserves other owners", () =>
  fixture(async ({ l, t, use }) => {
    use.allowOwner(2);
    const a = use.acquire(1, t.id, l.directory),
      b = use.acquire(2, t.id, l.directory);
    await use.revokeOwner(1);
    expect(() => use.acquire(1, t.id, l.directory)).toThrow(/not active/);
    expect((await use.respond(a.token, t.id, new Request(a.url))).status).toBe(
      403,
    );
    expect(() => idle(use, l, t.id)).toThrow();
    await use.release(2, b.token);
    idle(use, l, t.id);
  }));
test("unknown, stale library scope and closed DB fail closed", () =>
  fixture(async ({ l, t, use }) => {
    const unknown = new PlaybackUse();
    expect(() => unknown.usageFor(l).acquireIdle(t.id)).toThrow(/unknown/);
    const previous = use.usageFor(l);
    await use.shutdown();
    expect(() => previous.acquireIdle(t.id)).toThrow();
    use.bindLibrary(l);
    expect(() => previous.acquireIdle(t.id)).toThrow(/scope/);
    l.close();
    expect(() => use.usageFor(l).acquireIdle(t.id)).toThrow(/unknown/);
  }));
test("transport missing/error cleanup retains no descriptor authority after explicit release", () =>
  fixture(async ({ root, l, t, use }) => {
    const s = use.acquire(1, t.id, l.directory);
    await rename(t.path, path.join(root, "parked.flac"));
    expect((await use.respond(s.token, t.id, new Request(s.url))).status).toBe(
      404,
    );
    await use.release(1, s.token);
    idle(use, l, t.id);
  }));
test("shutdown revokes sources and rejects all further acquisitions and idle leases", () =>
  fixture(async ({ l, t, use }) => {
    const s = use.acquire(1, t.id, l.directory);
    await use.shutdown();
    expect((await use.respond(s.token, t.id, new Request(s.url))).status).toBe(
      403,
    );
    expect(() => use.acquire(1, t.id, l.directory)).toThrow(/unknown/);
    expect(() => idle(use, l, t.id)).toThrow(/unknown/);
  }));
test("a renderer cannot release another owner's source or spoof a library", () =>
  fixture(async ({ l, t, use }) => {
    const s = use.acquire(1, t.id, l.directory);
    await expect(use.release(2, s.token)).rejects.toThrow(/another/);
    expect(() => use.acquire(1, t.id, "wrong library")).toThrow();
    expect(() => idle(use, l, t.id)).toThrow();
    await use.release(1, s.token);
    idle(use, l, t.id);
  }));

test("library transition cannot discard an idle edit lease, and transition state is fail closed", () =>
  fixture(async ({ l, t, use }) => {
    const idleLease = use.usageFor(l).acquireIdle(t.id);
    expect(() => use.bindLibrary(l)).toThrow(/released/);
    expect(() => use.blockNewUse()).toThrow(/Finish/);
    idleLease.release();
    const restore = use.blockNewUse();
    expect(() => idle(use, l, t.id)).toThrow(/unknown/);
    expect(() => use.acquire(1, t.id, l.directory)).toThrow();
    restore();
    idle(use, l, t.id);
  }));
test("shutdown invalidates an idle lease and waits for coordinator release before unbinding", () =>
  fixture(async ({ l, t, use }) => {
    const lease = use.usageFor(l).acquireIdle(t.id);
    let done = false;
    const stopping = use.shutdown().then(() => {
      done = true;
    });
    expect(() => lease.assertIdle()).toThrow(/unknown/);
    expect(() => use.acquire(1, t.id, l.directory)).toThrow();
    await Promise.resolve();
    expect(done).toBe(false);
    lease.release();
    await stopping;
    expect(done).toBe(true);
  }));
