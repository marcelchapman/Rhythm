const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
// Fail rather than ship a host-architecture addon inside a different-arch app.
module.exports = async function (context) {
  if (!["darwin", "linux"].includes(context.electronPlatformName)) return;
  const build = JSON.parse(
    fs.readFileSync(
      path.join(
        context.packager.info.appDir,
        "dist/native/publication-build.json",
      ),
      "utf8",
    ),
  );
  const arch = { 0: "ia32", 1: "x64", 2: "arm", 3: "arm64", 4: "universal" }[
    context.arch
  ];
  if (
    build.platform !== context.electronPlatformName ||
    build.arch !== arch ||
    build.testing ||
    build.napi !== 8
  )
    throw Error(
      "Build the publication addon on/for the exact package platform and architecture; cross/universal packaging is not qualified.",
    );
  const bytes = fs.readFileSync(
    path.join(context.packager.info.appDir, "dist/native/publication.node"),
  );
  if (createHash("sha256").update(bytes).digest("hex") !== build.sha256)
    throw Error("Publication binary does not match its build manifest.");
};
