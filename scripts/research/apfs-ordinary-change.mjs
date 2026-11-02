// A separate ordinary application changing only its own disposable case files.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const [configPath, name] = process.argv.slice(2);
assert(configPath?.startsWith("/private/tmp/rio-apfs-design-"));
assert(name && !name.includes("/") && name !== "." && name !== "..");
const c = JSON.parse(fs.readFileSync(configPath, "utf8")),
  p = path.join(c.media, name);
const move = () => fs.renameSync(p, path.join(c.media, "external-saved.flac"));
switch (c.change) {
  case "rename":
    move();
    break;
  case "replace":
    move();
    fs.copyFileSync(c.candidateInput, p);
    break;
  case "remove-recreate":
    fs.unlinkSync(p);
    fs.copyFileSync(c.candidateInput, p);
    break;
  case "modify":
    fs.writeFileSync(p, fs.readFileSync(c.candidateInput));
    break;
  case "symlink":
    move();
    fs.symlinkSync(c.otherInput, p);
    break;
  case "hardlink":
    fs.linkSync(p, path.join(c.media, "external-hardlink.flac"));
    break;
  case "directory":
    fs.renameSync(c.media, c.media + "-moved");
    fs.mkdirSync(c.media);
    fs.copyFileSync(c.otherInput, path.join(c.media, "ordinary-file.flac"));
    break;
  default:
    throw Error("Unknown ordinary change");
}
// Record these ordinary files after the other application's operation. The
// parent later proves that publisher/recovery did not remove or rewrite them.
const preserved = [];
for (const directory of [c.media, c.media + "-moved"]) {
  if (!fs.existsSync(directory)) continue;
  for (const entry of fs.readdirSync(directory)) {
    const file = path.join(directory, entry),
      s = fs.lstatSync(file, { bigint: true });
    assert(s.isFile() || s.isSymbolicLink());
    preserved.push({
      file,
      device: String(s.dev),
      inode: String(s.ino),
      links: String(s.nlink),
      symlink: s.isSymbolicLink(),
      value: s.isSymbolicLink()
        ? fs.readlinkSync(file)
        : createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
    });
  }
}
console.log(JSON.stringify({ change: c.change, name, preserved }));
