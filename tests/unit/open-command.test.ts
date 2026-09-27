import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createRecordedOpenCommand } from "../../src/server/launch/open-command";

let temporaryDirectory: string | undefined;

afterEach(async () => {
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

describe("recorded open command", () => {
  test("records the complete launcher invocation without opening a local application", async () => {
    temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "recorded-open-"));
    const logPath = path.join(temporaryDirectory, "launcher.jsonl");
    const openCommand = createRecordedOpenCommand(logPath);

    await openCommand([
      "/usr/bin/open",
      "/Users/example/Documents/sample-workflow"
    ]);

    const entries = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(entries).toEqual([
      ["/usr/bin/open", "/Users/example/Documents/sample-workflow"]
    ]);
  });
});
