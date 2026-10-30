import { test, expect } from "vitest";
import {
  mkdtemp,
  realpath,
  mkdir,
  rm,
  rename,
  symlink,
  writeFile,
  access,
  chmod,
} from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { Library } from "../src/domain/library";

async function fixture(
  run: (f: {
    root: string;
    directory: string;
    open: () => Promise<Library>;
  }) => Promise<void>,
) {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-library-setup-")),
  );
  const libraries: Library[] = [];
  const directory = path.join(root, "Library");
  const open = async () => {
    const library = await Library.open(directory, { setupMediaRoot: true });
    libraries.push(library);
    return library;
  };
  try {
    await run({ root, directory, open });
  } finally {
    for (const library of libraries) library.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("new desktop library creates and persists internal Rio Media without enabling copying", async () => {
  await fixture(async ({ root, open }) => {
    const library = await open();
    const settings = library.mediaSettings();
    expect(settings.root?.path).toBe(path.join(root, "Library", "Rio Media"));
    expect(settings.copyOnAdd).toBe(false);
    expect(settings.setupError).toBeUndefined();
    await access(settings.root!.path);
    expect((await open()).mediaSettings()).toEqual(settings);
  });
});

test("existing library reuses custom root and policies; Settings can still change it", async () => {
  await fixture(async ({ root, open }) => {
    const library = await open();
    const custom = path.join(root, "Custom music");
    await mkdir(custom);
    await library.chooseMediaRoot(custom);
    library.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    const settings = library.mediaSettings();
    const reopened = await open();
    expect(reopened.mediaSettings()).toEqual(settings);
    const changed = await reopened.chooseMediaRoot(
      path.join(root, "Library", "Rio Media"),
    );
    expect(changed.root?.path).toBe(path.join(root, "Library", "Rio Media"));
    expect(changed.copyOnAdd).toBe(true);
    expect((await open()).mediaSettings()).toEqual(changed);
  });
});

test.each(["missing", "replacement", "symlink"])(
  "unavailable stored root (%s) retains its recorded identity and requests recovery",
  async (kind) => {
    await fixture(async ({ root, open }) => {
      const library = await open();
      const before = library.mediaSettings();
      const media = before.root!.path;
      const identity = library.db
        .prepare("SELECT device,inode FROM media_root_locations")
        .get();
      await rename(media, path.join(root, "Disconnected media"));
      if (kind === "replacement") await mkdir(media);
      if (kind === "symlink")
        await symlink(path.join(root, "Disconnected media"), media);
      const reopened = await open();
      expect(reopened.mediaSettings().setupError).toMatch(
        /saved Rio Media folder/,
      );
      expect(reopened.mediaSettings().root).toEqual(before.root);
      expect(
        reopened.db
          .prepare("SELECT device,inode FROM media_root_locations")
          .get(),
      ).toEqual(identity);
      if (kind === "missing") await expect(access(media)).rejects.toThrow();
      await reopened.chooseMediaRoot(path.join(root, "Disconnected media"));
      expect(reopened.mediaSettings().setupError).toBeUndefined();
    });
  },
);

test("existing library lacking a root never gets an invented default", async () => {
  await fixture(async ({ root, directory, open }) => {
    const existing = await Library.open(directory);
    existing.close();
    const reopened = await open();
    expect(reopened.mediaSettings().root).toBeNull();
    expect(reopened.mediaSettings().setupError).toBeTruthy();
    await expect(
      access(path.join(root, "Library", "Rio Media")),
    ).rejects.toThrow();
  });
});

test.each(["file", "symlink"])(
  "unsafe default (%s) falls back to Settings without adopting it",
  async (kind) => {
    await fixture(async ({ root, open }) => {
      const media = path.join(root, "Library", "Rio Media");
      await mkdir(path.dirname(media));
      if (kind === "file") await writeFile(media, "untouched");
      else await symlink(root, media);
      const library = await open();
      expect(library.mediaSettings().root).toBeNull();
      expect(library.mediaSettings().setupError).toMatch(/couldn't configure/);
    });
  },
);

test.skipIf(process.getuid?.() === 0)(
  "inaccessible stored root requests recovery without replacing configuration",
  async () => {
    await fixture(async ({ open }) => {
      const library = await open();
      const before = library.mediaSettings().root!;
      await chmod(before.path, 0o500);
      try {
        const reopened = await open();
        expect(reopened.mediaSettings().root).toEqual(before);
        expect(reopened.mediaSettings().setupError).toBeTruthy();
      } finally {
        await chmod(before.path, 0o700);
      }
    });
  },
);

test("A/B/C libraries isolate defaults and preserve each library's custom media root", async () => {
  const root = await realpath(
    await mkdtemp(path.join(tmpdir(), "rio-independent-libraries-")),
  );
  const open = (name: string) =>
    Library.open(path.join(root, name), { setupMediaRoot: true });
  let active: Library | undefined;
  try {
    active = await open("A");
    const a = active.mediaSettings();
    expect(a.root?.path).toBe(path.join(root, "A", "Rio Media"));
    active.close();
    active = undefined;
    active = await open("Rhythm 2");
    const b = active.mediaSettings();
    expect(b.root?.path).toBe(path.join(root, "Rhythm 2", "Rio Media"));
    expect(b.root?.id).not.toBe(a.root?.id);
    active.close();
    active = undefined;
    active = await open("A");
    expect(active.mediaSettings()).toEqual(a);
    const custom = path.join(root, "External custom media");
    await mkdir(custom);
    await active.chooseMediaRoot(custom);
    active.saveMediaSettings({ copyOnAdd: true, keepOrganized: false });
    const customized = active.mediaSettings();
    active.close();
    active = undefined;
    active = await open("A");
    expect(active.mediaSettings()).toEqual(customized);
    active.close();
    active = undefined;
    active = await open("C");
    expect(active.mediaSettings().root?.path).toBe(
      path.join(root, "C", "Rio Media"),
    );
    expect(active.mediaSettings().copyOnAdd).toBe(false);
    expect(active.mediaSettings().keepOrganized).toBe(true);
    active.close();
    active = undefined;
    // Even an available default must not replace an unavailable custom root.
    await rename(custom, custom + " disconnected");
    active = await open("A");
    expect(active.mediaSettings().root).toEqual(customized.root);
    expect(active.mediaSettings().setupError).toBeTruthy();
    active.close();
    active = undefined;
    active = await open("Rhythm 2");
    expect(active.mediaSettings()).toEqual(b);
  } finally {
    active?.close();
    await rm(root, { recursive: true, force: true });
  }
});
