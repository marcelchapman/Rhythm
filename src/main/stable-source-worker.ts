import {
  MAX_FLAC_FILE_BYTES,
  FLAC_SIZE_MESSAGE,
} from "../shared/flac-limits.js";
/** Owns all native descriptors, hashing and filesystem I/O for one ephemeral source. */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { validateCurrentManagedReceipt } from "../domain/managed-copy.js";

const port = parentPort!;
let binding: {
  support(config: object): boolean;
  capture(config: object): { handle: object; size: number; cloneMs: number };
  check(handle: object, original: boolean): number;
  read(handle: object, offset: number, length: number): Buffer;
  close(handle: object): void;
};
let handle: object | undefined;
let queue = Promise.resolve();
let closing = false;
port.on("message", ({ id, method, offset, length }) => {
  queue = queue.then(async () => {
    try {
      let value: unknown;
      if (method === "capture") {
        if (process.platform !== "darwin" || handle || closing)
          throw Error("APFS playback sources unavailable.");
        const binary = new URL(
          "../native/playback-source.node",
          import.meta.url,
        );
        const manifest = JSON.parse(
          readFileSync(
            new URL("../native/playback-source-build.json", import.meta.url),
            "utf8",
          ),
        );
        if (
          manifest.platform !== process.platform ||
          manifest.arch !== process.arch ||
          manifest.napi !== 8 ||
          manifest.sha256 !==
            createHash("sha256").update(readFileSync(binary)).digest("hex")
        )
          throw Error(
            "Playback source native build does not match this application.",
          );
        binding = createRequire(import.meta.url)(fileURLToPath(binary));
        const c = workerData;
        if (
          c.select &&
          !binding.support({
            root: c.root.path,
            rootDevice: c.root.device,
            rootInode: c.root.inode,
          })
        ) {
          port.postMessage({ id, ok: true, value: { unsupported: true } });
          return;
        }
        // Refuse obvious stale/oversize targets before the existing receipt hasher.
        // The native descriptor checks repeat the authoritative size/link checks.
        const input = await lstat(c.filename);
        if (input.size > MAX_FLAC_FILE_BYTES) throw Error(FLAC_SIZE_MESSAGE);
        if (!input.isFile() || input.isSymbolicLink())
          throw Error("Playback target is not a regular file.");
        if (input.nlink !== 1)
          throw Error("Playback target has unexpected hard links.");
        if (input.size <= 0) throw Error("Playback target is empty.");
        const db = new DatabaseSync(c.database, { readOnly: true });
        try {
          await validateCurrentManagedReceipt(
            db,
            c.root,
            c.id,
            c.filename,
            c.relative,
          );
        } finally {
          db.close();
        }
        const opened = binding.capture({
          root: c.root.path,
          rootDevice: c.root.device,
          rootInode: c.root.inode,
          relative: c.relative,
          device: c.receipt.device,
          inode: c.receipt.inode,
          workspace: c.workspace,
        });
        handle = opened.handle;
        const digest = createHash("sha256");
        for (let at = 0; at < opened.size; at += 256 * 1024)
          digest.update(
            binding.read(handle, at, Math.min(256 * 1024, opened.size - at)),
          );
        if (digest.digest("hex") !== c.receipt.digest)
          throw Error("Playback clone does not match the managed receipt.");
        binding.check(handle, true);
        value = { size: opened.size, cloneMs: opened.cloneMs };
      } else if (method === "close") {
        closing = true;
        if (handle) {
          binding.close(handle);
          handle = undefined;
        }
      } else {
        if (!handle || closing) throw Error("Playback source is closed.");
        value =
          method === "check"
            ? binding.check(handle, false)
            : method === "read"
              ? binding.read(handle, offset, length)
              : undefined;
        if (value === undefined) throw Error("Unknown playback operation.");
      }
      port.postMessage({ id, ok: true, value });
    } catch (error) {
      if (method === "capture" && handle) {
        binding.close(handle);
        handle = undefined;
      }
      port.postMessage({
        id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        code: (error as NodeJS.ErrnoException).code,
      });
    } finally {
      if (method === "close") port.close();
    }
  });
});
