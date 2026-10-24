import path from "node:path";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import {
  normalizeViewPreferences,
  patchTrackListPreferences,
  type TrackListPatch,
  type ViewPreferences,
} from "../shared/preferences.js";

/** Application-scoped preferences; serialized atomic writes cannot lose concurrent patches. */
export class ViewPreferenceStore {
  private value = normalizeViewPreferences();
  private initialized = false;
  private pending: Promise<unknown> = Promise.resolve();
  private constructor(private readonly filename: string) {}
  static async open(directory: string) {
    const store = new ViewPreferenceStore(
      path.join(directory, "view-preferences.json"),
    );
    try {
      const text = await readFile(store.filename, "utf8");
      store.initialized = true;
      try {
        store.value = normalizeViewPreferences(JSON.parse(text));
      } catch {
        /* Corrupt preferences use safe defaults. */
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    return store;
  }
  get(): ViewPreferences {
    return structuredClone(this.value);
  }
  private enqueue(operation: () => Promise<ViewPreferences>) {
    const next = this.pending.then(operation);
    this.pending = next.catch(() => {});
    return next;
  }
  private async persist(value: ViewPreferences) {
    await mkdir(path.dirname(this.filename), { recursive: true });
    await writeFile(`${this.filename}.tmp`, JSON.stringify(value), {
      mode: 0o600,
    });
    await rename(`${this.filename}.tmp`, this.filename);
    this.value = value;
    this.initialized = true;
    return this.get();
  }
  migrateLegacy(value: unknown) {
    return this.enqueue(() =>
      this.initialized
        ? Promise.resolve(this.get())
        : this.persist(normalizeViewPreferences(value)),
    );
  }
  update(patch: TrackListPatch) {
    return this.enqueue(() =>
      this.persist(patchTrackListPreferences(this.value, patch)),
    );
  }
  flush() {
    return this.pending;
  }
}
