// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildPackageData, CODEX_HOME_TOKEN } from "../../scripts/build-package-data.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("packaged seed data", () => {
  test("ships an empty registry instead of the developer's personal projects", async () => {
    const outputDir = await mkdtemp(path.join(os.tmpdir(), "package-default-seed-"));
    temporaryDirectories.push(outputDir);
    await buildPackageData({ outputDir });
    expect(JSON.parse(await readFile(path.join(outputDir, "projects.json"), "utf8"))).toEqual([]);
    expect(JSON.parse(await readFile(path.join(outputDir, "import-mappings.json"), "utf8"))).toEqual({});
  });
  test("replaces absolute macOS home prefixes with a portable token", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "package-data-test-"));
    temporaryDirectories.push(root);
    const sourceDir = path.join(root, "source");
    const outputDir = path.join(root, "output");
    await mkdir(sourceDir, { recursive: true });
    await writeFile(
      path.join(sourceDir, "projects.json"),
      JSON.stringify([
        {
          rootPath: "/Users/example/Documents/sample-project",
          sourceId: "workspace:/Users/other/Documents/source",
          nested: { path: "/Users/other/Documents/example" }
        }
      ]),
      "utf8"
    );
    await writeFile(path.join(sourceDir, "import-mappings.json"), "{\"mappings\":[]}", "utf8");

    await buildPackageData({ sourceDir, outputDir });

    const projects = await readFile(path.join(outputDir, "projects.json"), "utf8");
    expect(projects).toContain(`${CODEX_HOME_TOKEN}/Documents/sample-project`);
    expect(projects).toContain(`${CODEX_HOME_TOKEN}/Documents/example`);
    expect(projects).toContain(`workspace:${CODEX_HOME_TOKEN}/Documents/source`);
    expect(projects).not.toContain("/Users/");
    await expect(readFile(path.join(outputDir, "import-mappings.json"), "utf8"))
      .resolves.toBe("{\"mappings\":[]}");
  });
});
