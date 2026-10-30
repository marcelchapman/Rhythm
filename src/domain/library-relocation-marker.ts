import path from "node:path";
import { lstat, readFile, unlink, open } from "node:fs/promises";
export const RETIRED_MARKER = ".rio-library-retired.json";
export const RELOCATION_MARKER = ".rio-library-relocation.json";
/** Incomplete copies are never opened by ordinary library selection. */
export async function assertRelocationOpen(
  directory: string,
  token?: string,
  preparing = false,
) {
  try {
    await lstat(path.join(directory, RETIRED_MARKER));
    throw new Error(
      "This library is a retired recovery copy of a completed move. Open the moved library instead; remove the retirement marker only for deliberate recovery.",
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    const filename = path.join(directory, RELOCATION_MARKER);
    const info = await lstat(filename);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error("Unsafe library relocation marker.");
    const marker = JSON.parse(await readFile(filename, "utf8"));
    if (
      !token ||
      token !== marker.token ||
      (marker.phase !== "ready" && !(preparing && marker.phase === "copying"))
    )
      throw new Error(
        "This is an incomplete library relocation. Reopen the original library; do not use this copy.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** Called only after reading the committed profile pointer on startup. Never deletes payload. */
export async function finishCommittedRelocation(
  directory: string,
  token?: string,
) {
  if (!token) return;
  await assertRelocationOpen(directory, token);
  try {
    await unlink(path.join(directory, RELOCATION_MARKER));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
