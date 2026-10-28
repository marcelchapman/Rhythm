import { TagLib } from "taglib-wasm";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import path from "node:path";
import {
  lab,
  generated,
  sha,
  fixture,
  packets,
  pcm,
  independent,
  fields,
  observed,
  generate,
} from "./lab.mjs";

const backend =
  process.argv.find((x) => x.startsWith("--backend="))?.split("=")[1] ?? "wasi";
const label =
  process.argv.find((x) => x.startsWith("--label="))?.split("=")[1] ??
  `node-${backend}`;
const io = process.argv.includes("--io=buffer") ? "buffer" : "path";
const formats = process.argv
  .find((x) => x.startsWith("--formats="))
  ?.split("=")[1]
  .split(",");
if (!/^[a-z0-9-]+$/.test(label)) throw Error("Invalid lab output label");
if (process.argv.includes("--generate")) await generate();
const manifest = JSON.parse(
  await readFile(path.join(generated, "manifest.json"), "utf8"),
);
const t = await TagLib.initialize({ forceWasmType: backend });
const out = path.join(generated, label);
await mkdir(out, { recursive: true });
const assets = Object.fromEntries(
  await Promise.all(
    ["front.png", "back.png", "new.png", "new.jpg"].map(async (n) => [
      n,
      new Uint8Array(await readFile(path.join(generated, "assets", n))),
    ]),
  ),
);
const result = {
  label,
  io,
  runtime: process.versions,
  requestedBackend: backend,
  actualBackend: t.module.isWasi ? "wasi" : "emscripten",
  version: t.version(),
  formats: [],
};
function picture(name, type) {
  return {
    mimeType: name.endsWith(".jpg") ? "image/jpeg" : "image/png",
    data: assets[name],
    type,
    description: type === "FrontCover" ? "Lab front" : "Lab back",
  };
}
async function open(file) {
  await fixture(file);
  return t.open(io === "buffer" ? new Uint8Array(await readFile(file)) : file, {
    partial: false,
  });
}
async function edit(file, fn) {
  const f = await open(file);
  try {
    await fn(f);
    if (io === "buffer") {
      if (!f.save()) throw Error("Buffer save returned false");
      await writeFile(await fixture(file), f.getFileBuffer());
    } else await f.saveToFile();
  } finally {
    f.dispose();
  }
}
async function inspect(file) {
  const f = await open(file);
  try {
    return {
      properties: f.properties(),
      pictures: f.getPictures().map((p) => ({
        type: p.type,
        description: p.description ?? "",
        mimeType: p.mimeType,
        hash: sha(p.data),
      })),
      format: f.getFormat(),
    };
  } finally {
    f.dispose();
  }
}
function equal(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}
function propertyDiff(before, after, omit) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(
      (k) => !omit.includes(k.toLowerCase()) && !equal(before[k], after[k]),
    )
    .map((k) => ({ key: k, before: before[k], after: after[k] }));
}
const cases = [
  { name: "noop", omit: [], apply() {} },
  ...Object.entries(fields).map(([name, [key, , value]]) => ({
    name,
    omit: [key.toLowerCase()],
    apply: (f) => f.setProperty(key, value),
    expected: ["year", "bpm"].includes(name) ? Number(value) : value,
  })),
  {
    name: "integerBpm",
    field: "bpm",
    omit: ["bpm"],
    apply: (f) => f.setProperty("BPM", "124"),
    expected: 124,
  },
  {
    name: "artistAlbum",
    omit: ["artist", "album"],
    apply: (f) => {
      f.setProperty("ARTIST", "Massive Attack");
      f.setProperty("ALBUM", "Blue Lines");
    },
    expected: { artist: "Massive Attack", album: "Blue Lines" },
  },
  {
    name: "trackNumber",
    omit: ["track", "tracknumber"],
    apply: (f) => {
      const old = f.getProperty("TRACKNUMBER")?.[0] ?? "";
      f.setProperty("TRACKNUMBER", `7/${old.split("/")[1] || "12"}`);
    },
    expected: 7,
  },
  {
    name: "trackTotal",
    omit: ["track", "tracknumber", "tracktotal"],
    apply: (f) => {
      const old = f.getProperty("TRACKNUMBER")?.[0] ?? "";
      f.setProperty("TRACKNUMBER", `${old.split("/")[0] || "3"}/17`);
    },
    expected: 17,
  },
  {
    name: "discNumber",
    omit: ["discnumber", "disc"],
    apply: (f) => {
      const old = f.getProperty("DISCNUMBER")?.[0] ?? "";
      f.setProperty("DISCNUMBER", `3/${old.split("/")[1] || "4"}`);
    },
    expected: 3,
  },
  {
    name: "discTotal",
    omit: ["discnumber", "disc", "disctotal"],
    apply: (f) => {
      const old = f.getProperty("DISCNUMBER")?.[0] ?? "";
      f.setProperty("DISCNUMBER", `${old.split("/")[0] || "2"}/9`);
    },
    expected: 9,
  },
  {
    name: "clear-trackTotal",
    field: "trackTotal",
    omit: ["track", "tracknumber", "tracktotal"],
    apply: (f) => f.setProperty("TRACKNUMBER", "3"),
    clear: true,
  },
  {
    name: "clear-discTotal",
    field: "discTotal",
    omit: ["disc", "discnumber", "disctotal"],
    apply: (f) => f.setProperty("DISCNUMBER", "2"),
    clear: true,
  },
  {
    name: "clear-trackNumber-only",
    field: "trackNumber",
    omit: ["track", "tracknumber"],
    apply: (f) => f.setProperty("TRACKNUMBER", "/12"),
    clear: true,
  },
  {
    name: "clear-discNumber-only",
    field: "discNumber",
    omit: ["disc", "discnumber"],
    apply: (f) => f.setProperty("DISCNUMBER", "/4"),
    clear: true,
  },
  ...Object.entries(fields).map(([name, [key]]) => ({
    name: `clear-${name}`,
    field: name,
    omit: [key.toLowerCase()],
    apply: (f) => f.removeProperty(key),
    clear: true,
  })),
  ...["ARTIST", "ALBUM", "TRACKNUMBER", "DISCNUMBER"].map((key) => ({
    name: `clear-${key.toLowerCase()}`,
    field:
      key === "TRACKNUMBER"
        ? "trackNumber"
        : key === "DISCNUMBER"
          ? "discNumber"
          : key.toLowerCase(),
    omit: [
      key.toLowerCase(),
      key === "TRACKNUMBER"
        ? "track"
        : key === "DISCNUMBER"
          ? "disc"
          : key.toLowerCase(),
    ],
    apply: (f) => f.removeProperty(key),
    clear: true,
  })),
  ...["new.jpg", "new.png"].map((name) => ({
    name: `front-${name}`,
    omit: [],
    art: name,
    apply: (f) =>
      f.setPictures([
        ...f.getPictures().filter((p) => p.type !== "FrontCover"),
        picture(name, "FrontCover"),
      ]),
  })),
  {
    name: "remove-front",
    omit: [],
    art: "remove",
    apply: (f) =>
      f.setPictures(f.getPictures().filter((p) => p.type !== "FrontCover")),
  },
];
for (const source of manifest) {
  if (formats && !formats.includes(source.ext)) continue;
  const r = { ext: source.ext, cases: [] };
  result.formats.push(r);
  if (source.error) {
    r.error = source.error;
    continue;
  }
  const base = path.join(out, `base.${source.ext}`);
  await copyFile(source.file, base);
  try {
    r.initialRead = await inspect(base);
    r.initialIndependent = await independent(base);
    // Seed only copies, never generator originals. Extended metadata/pictures are
    // read back independently before serving as preservation sentinels.
    await edit(base, (f) => {
      for (const [k, v] of Object.entries({
        ALBUMARTIST: "Original album owner",
        COMPOSER: "Original composer",
        BPM: "97.5",
        TRACKNUMBER: "03/12",
        DISCNUMBER: "2/4",
        DATE: "1999-12-31",
        COMMENT: "Original notes",
        COPYRIGHT: "Lab copyright",
        REPLAYGAIN_TRACK_GAIN: "-3.25 dB",
      }))
        f.setProperty(k, v);
      if (source.ext === "m4a")
        f.setMP4Item("----:org.rhythm.lab:MiXeD", "Unedited sentinel ü 音楽");
      else f.setProperty("RHYTHM_LAB_UNKNOWN", "Unedited sentinel ü 音楽");
      f.setProperty("LYRICS", "Unedited lyrics ü 音楽");
    });
    try {
      await edit(base, (f) =>
        f.setPictures([
          picture("front.png", "FrontCover"),
          picture("back.png", "BackCover"),
        ]),
      );
    } catch (e) {
      r.pictureSeedError = String(e);
    }
    r.seeded = await inspect(base);
    r.seededIndependent = await independent(base);
    const audioBefore = { packets: packets(base), pcm: pcm(base) };
    r.seedAudioIntegrity = {
      packets: equal(audioBefore.packets, source.packets),
      pcm: audioBefore.pcm === source.pcm,
    };
    for (const c of cases) {
      const file = path.join(out, `${c.name}.${source.ext}`);
      await copyFile(base, file);
      const check = { name: c.name };
      r.cases.push(check);
      try {
        await edit(file, c.apply);
        const after = await inspect(file),
          m = await independent(file);
        check.propertyChangesOutsidePatch = propertyDiff(
          r.seeded.properties,
          after.properties,
          c.omit,
        );
        check.pictures = after.pictures;
        check.independentPictures = m.pictures;
        if (c.expected !== undefined) {
          check.observed =
            c.name === "artistAlbum"
              ? { artist: m.common.artist, album: m.common.album }
              : observed(m.common, c.field ?? c.name);
          check.fieldPassed = equal(check.observed, c.expected);
          check.writerValue = after.properties[c.field ?? c.name];
        } else if (c.clear) {
          check.observed = observed(m.common, c.field);
          check.fieldPassed =
            check.observed === undefined ||
            check.observed === null ||
            check.observed === "";
          check.writerPropertiesAfterClear = after.properties;
        }
        check.uneditedPicturesPreserved = c.art
          ? after.pictures
              .filter((p) => p.type !== "FrontCover")
              .every((p) => r.seeded.pictures.some((x) => equal(p, x))) &&
            after.pictures.filter((p) => p.type !== "FrontCover").length ===
              r.seeded.pictures.filter((p) => p.type !== "FrontCover").length
          : equal(after.pictures, r.seeded.pictures);
        if (c.art) {
          check.frontPassed =
            c.art === "remove"
              ? !m.pictures.some((p) => p.type?.toLowerCase().includes("front"))
              : m.pictures.some((p) => p.hash === sha(assets[c.art]));
          check.backBytesPreserved = m.pictures.some(
            (p) => p.hash === sha(assets["back.png"]),
          );
        }
        check.audioPacketsUnchanged = equal(packets(file), audioBefore.packets);
        check.decodedPcmUnchanged = pcm(file) === audioBefore.pcm;
        check.independentCommon = Object.fromEntries(
          Object.keys(fields).map((k) => [k, observed(m.common, k)]),
        );
        check.native = m.native;
        check.passed =
          check.fieldPassed !== false &&
          check.frontPassed !== false &&
          check.backBytesPreserved !== false &&
          check.audioPacketsUnchanged &&
          check.decodedPcmUnchanged &&
          check.uneditedPicturesPreserved &&
          check.propertyChangesOutsidePatch.length === 0;
      } catch (e) {
        check.error = String(e);
        check.passed = false;
      }
    }
    // Absent fields stay absent: do not seed from Rhythm's display fallbacks.
    const missing = path.join(out, `missing-fields.${source.ext}`);
    await copyFile(base, missing);
    await edit(missing, (f) => {
      for (const key of ["ARTIST", "ALBUM", "ALBUMARTIST", "GENRE", "COMPOSER"])
        f.removeProperty(key);
    });
    const beforeMissing = await independent(missing);
    await edit(missing, (f) =>
      f.setProperty("TITLE", "Only a real title edit"),
    );
    const afterMissing = await independent(missing);
    const missingKeys = ["artist", "album", "albumartist", "genre", "composer"];
    r.missingBefore = Object.fromEntries(
      missingKeys.map((k) => [k, beforeMissing.common[k]]),
    );
    r.missingAfter = Object.fromEntries(
      missingKeys.map((k) => [k, afterMissing.common[k]]),
    );
    const empty = (v) =>
      v == null || v === "" || (Array.isArray(v) && v.every((x) => x === ""));
    r.noFallbackPollution = missingKeys.every(
      (k) =>
        equal(beforeMissing.common[k], afterMissing.common[k]) &&
        empty(afterMissing.common[k]),
    );
    // Mutating through default partial path exercises a different save strategy.
    const partial = path.join(out, `default-partial.${source.ext}`);
    await copyFile(base, partial);
    const f = await t.open(await fixture(partial));
    try {
      f.setProperty("TITLE", "Partial title");
      await f.saveToFile();
    } finally {
      f.dispose();
    }
    const partialAfter = await inspect(partial);
    r.defaultPartial = {
      titlePassed:
        (await independent(partial)).common.title === "Partial title",
      propertyChangesOutsidePatch: propertyDiff(
        r.seeded.properties,
        partialAfter.properties,
        ["title"],
      ),
      picturesPreserved: equal(partialAfter.pictures, r.seeded.pictures),
      audioPacketsUnchanged: equal(packets(partial), audioBefore.packets),
      decodedPcmUnchanged: pcm(partial) === audioBefore.pcm,
    };
    console.log(
      label,
      source.ext,
      r.cases.filter((c) => c.passed).length + "/" + r.cases.length,
      "fallback-safe=" + r.noFallbackPollution,
    );
  } catch (e) {
    r.error = String(e);
    console.log(label, source.ext, r.error);
  }
  await writeFile(
    path.join(generated, `${label}.json`),
    JSON.stringify(result, null, 2) + "\n",
  );
}
for (const source of manifest.filter((x) => !x.error))
  assert.equal(
    sha(await readFile(source.file)),
    source.hash,
    "Generated originals must stay unchanged",
  );
await writeFile(
  path.join(generated, `${label}.json`),
  JSON.stringify(result, null, 2) + "\n",
);
console.log("LAB_RESULT", path.join(generated, `${label}.json`));
