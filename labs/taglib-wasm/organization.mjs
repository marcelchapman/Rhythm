// Pure planner only: never creates directories, moves files, or opens a database.
import { mediaDestination } from "../../src/domain/media-plan.ts";
import { writeFile, access } from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { generated } from "./lab.mjs";
const root = path.join(generated, "conceptual-media-root");
await assert.rejects(access(root));
const results = [];
for (const ext of [".mp3", ".flac", ".m4a"]) {
  const id = "unchanged-lab-track-id";
  const before = {
    id,
    path: path.join(root, "Unknown Artist", "Unknown Album", "track" + ext),
  };
  const planned = mediaDestination(
    root,
    { artist: "Massive Attack", album: "Blue Lines" },
    ext,
    true,
    "track",
  );
  const existingDirectoryCandidate = mediaDestination(
    root,
    { artist: "Massive Attack", album: "Blue Lines" },
    ext,
    true,
    "track",
  );
  assert.equal(planned.relative, "Massive Attack/Blue Lines/00 track" + ext);
  assert.deepEqual(planned, existingDirectoryCandidate);
  const reference = { ...before, kind: "referenced" };
  results.push({
    before,
    planned,
    id,
    referencedPathUnchanged: reference.path === before.path,
    limitations:
      "Pure planning only: identity retention, directory creation/reuse, relocation and validated cleanup still require the future coordinator.",
  });
}
await assert.rejects(access(root));
await writeFile(
  path.join(generated, "organization.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify(results));
