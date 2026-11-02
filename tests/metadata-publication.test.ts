import { test, expect, vi } from "vitest";
import * as publication from "../src/domain/publication";
import { selectMetadataPublication } from "../src/domain/metadata-publication";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, existsSync, rmSync } from "node:fs";
import path from "node:path";
const target = {
  root: tmpdir(),
  relative: "test.flac",
  rootIdentity: { device: "1", inode: "2", type: "directory" as const },
};

test.skipIf(process.platform !== "darwin")(
  "qualified APFS retains strong publisher; local noowners avoids private workspaces",
  () => {
    const support = vi.fn().mockReturnValue({
      status: "supported",
      filesystem: "apfs",
      ownershipEnabled: true,
    });
    const binding = vi
      .spyOn(publication, "publicationNativeBinding")
      .mockReturnValue({ metadataSupport: support } as any);
    const strong = vi
      .spyOn(publication, "probePublicationSupport")
      .mockReturnValue({ status: "supported", filesystem: "apfs" });
    try {
      expect(selectMetadataPublication(target)).toBe("staged");
      expect(strong).toHaveBeenCalledOnce();
      strong.mockClear();
      support.mockReturnValue({
        status: "supported",
        filesystem: "apfs",
        ownershipEnabled: false,
      });
      expect(selectMetadataPublication(target)).toBe("in-place");
      expect(strong).not.toHaveBeenCalled();
      support.mockImplementation(() => {
        throw new Error("Require local writable APFS");
      });
      expect(() => selectMetadataPublication(target)).toThrow(
        /local writable APFS/,
      );
      expect(strong).not.toHaveBeenCalled();
    } finally {
      binding.mockRestore();
      strong.mockRestore();
    }
  },
);

test.skipIf(process.platform !== "darwin")(
  "local APFS may fall back only after validating writable target and no unfinished workspace",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "rio-capability-"));
    const fixtureTarget = { ...target, root };
    const support = vi.fn().mockReturnValue({
      status: "supported",
      filesystem: "apfs",
      ownershipEnabled: true,
    });
    const binding = vi
      .spyOn(publication, "publicationNativeBinding")
      .mockReturnValue({ metadataSupport: support } as any);
    const strong = vi
      .spyOn(publication, "probePublicationSupport")
      .mockReturnValue({
        status: "unsupported",
        reason: "fullfsync unavailable",
      });
    try {
      expect(selectMetadataPublication(fixtureTarget)).toBe("in-place");
      expect(support).toHaveBeenCalledTimes(2);
      const workspace = path.join(root, ".rio-publication-incomplete");
      mkdirSync(workspace);
      expect(() => selectMetadataPublication(fixtureTarget)).toThrow(
        /unfinished publication/,
      );
      expect(existsSync(workspace)).toBe(true);
    } finally {
      binding.mockRestore();
      strong.mockRestore();
      rmSync(root, { recursive: true, force: true });
    }
  },
);
