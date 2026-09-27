// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { rewriteServerFile } from "../../scripts/build-server.mjs";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    ))
  );
});

describe("server build import rewriting", () => {
  test("adds .js only for extensionless relative imports and validates targets", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "build-server-test-"));
    temporaryDirectories.push(directory);
    const entryPath = path.join(directory, "entry.js");
    await writeFile(path.join(directory, "dependency.js"), "export const value = 1;\n", "utf8");
    await writeFile(path.join(directory, "defaults.json"), "{}\n", "utf8");
    await writeFile(
      entryPath,
      'import { value } from "./dependency";\nimport defaults from "./defaults.json" with { type: "json" };\n',
      "utf8"
    );

    await rewriteServerFile(entryPath);

    const rewritten = await readFile(entryPath, "utf8");
    expect(rewritten).toContain('from "./dependency.js"');
    expect(rewritten).toContain('from "./defaults.json"');

    await writeFile(entryPath, 'import "./missing";\n', "utf8");
    await expect(rewriteServerFile(entryPath)).rejects.toThrow(/missing/);
  });
});
