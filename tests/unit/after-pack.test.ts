// @vitest-environment node

import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { afterPack } = require("../../scripts/after-pack.cjs") as {
  afterPack: (context: {
    appOutDir: string;
    electronPlatformName: string;
    packager: { appInfo: { productFilename: string } };
  }) => Promise<void>;
};
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("macOS afterPack resource permissions", () => {
  test("removes write bits from packaged resource files", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "after-pack-test-"));
    temporaryDirectories.push(root);
    const appOutDir = path.join(root, "release");
    const resourcesDir = path.join(appOutDir, "Codex Atlas.app", "Contents", "Resources");
    await mkdir(resourcesDir, { recursive: true });
    const appAsarPath = path.join(resourcesDir, "app.asar");
    const iconPath = path.join(resourcesDir, "icon.icns");
    await writeFile(appAsarPath, "asar", "utf8");
    await writeFile(iconPath, "icon", "utf8");
    await chmod(appAsarPath, 0o664);
    await chmod(iconPath, 0o644);

    await afterPack({
      appOutDir,
      electronPlatformName: "darwin",
      packager: { appInfo: { productFilename: "Codex Atlas" } }
    });

    expect((await stat(appAsarPath)).mode & 0o222).toBe(0);
    expect((await stat(iconPath)).mode & 0o222).toBe(0);
  });
});
