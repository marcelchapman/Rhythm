// Targeted follow-ups to observed failures, not a production adapter.
import { TagLib } from "taglib-wasm";
import { copyFile, readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { generated, fixture, independent, packets, pcm } from "./lab.mjs";
const results = [];
for (const backend of ["wasi", "emscripten"]) {
  const t = await TagLib.initialize({ forceWasmType: backend });
  const dir = path.join(generated, "refinements-" + backend);
  await mkdir(dir, { recursive: true });
  async function edit(file, fn) {
    const f = await t.open(await fixture(file), { partial: false });
    try {
      fn(f);
      await f.saveToFile();
    } finally {
      f.dispose();
    }
  }
  async function read(file) {
    const f = await t.open(await fixture(file), { partial: false });
    try {
      return { properties: f.properties(), pictures: f.getPictures() };
    } finally {
      f.dispose();
    }
  }
  for (const ext of ["flac", "m4a"]) {
    const master = path.join(dir, "clean." + ext);
    await copyFile(
      path.join(generated, "node-" + backend, "base." + ext),
      master,
    );
    // DESCRIPTION is deliberately absent for the unambiguous COMMENT-only profile.
    if (ext === "flac")
      await edit(master, (f) => {
        f.removeProperty("DESCRIPTION");
        f.setProperty("COMMENT", "Single comment");
      });
    const audio = packets(master),
      decoded = pcm(master);
    for (const kind of [
      "change-comment",
      "clear-comment",
      "multivalue-title",
      "clear-bpm-native",
    ]) {
      const file = path.join(dir, kind + "." + ext);
      await copyFile(master, file);
      const before = await read(file),
        original = await independent(file);
      const r = { backend, ext, kind };
      results.push(r);
      try {
        await edit(file, (f) => {
          if (kind === "change-comment")
            f.setProperty("COMMENT", "Exactly one edited comment");
          if (kind === "clear-comment") f.removeProperty("COMMENT");
          if (kind === "multivalue-title") {
            f.setProperties({
              ...f.properties(),
              genre: ["Ambient", "Electronic"],
              composer: ["Composer A", "Composer B"],
            });
          }
          if (kind === "clear-bpm-native") {
            if (ext === "m4a") f.removeMP4Item("tmpo");
            else f.removeProperty("BPM");
          }
        });
        const m = await independent(file),
          after = await read(file);
        r.beforeComment = original.common.comment;
        r.afterComment = m.common.comment;
        r.afterBpm = m.common.bpm;
        r.afterProperties = after.properties;
        r.nativeBpm = Object.values(m.native)
          .flat()
          .filter((x) => /BPM|tmpo/.test(x.id));
        if (kind === "multivalue-title") {
          const seeded = await read(file);
          await edit(file, (f) =>
            f.setProperty("TITLE", "Only title after multiple values"),
          );
          const updated = await read(file),
            independentUpdated = await independent(file);
          r.multivaluePreserved =
            JSON.stringify(seeded.properties.genre) ===
              JSON.stringify(updated.properties.genre) &&
            JSON.stringify(seeded.properties.composer) ===
              JSON.stringify(updated.properties.composer);
          r.multivalueIndependent = {
            genres: independentUpdated.common.genre,
            composers: independentUpdated.common.composer,
          };
        }
        r.audioPacketsUnchanged =
          JSON.stringify(packets(file)) === JSON.stringify(audio);
        r.pcmUnchanged = pcm(file) === decoded;
        r.picturesPreserved =
          JSON.stringify(before.pictures) === JSON.stringify(after.pictures);
      } catch (e) {
        r.error = String(e);
      }
    }
  }
}
await writeFile(
  path.join(generated, "refinements.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(
  JSON.stringify(
    results.map((r) => ({
      backend: r.backend,
      ext: r.ext,
      kind: r.kind,
      comment: r.afterComment,
      bpm: r.afterBpm,
      nativeBpm: r.nativeBpm,
      multi: r.multivaluePreserved,
      packets: r.audioPacketsUnchanged,
      error: r.error,
    })),
    null,
    2,
  ),
);
