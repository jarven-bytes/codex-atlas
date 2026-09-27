// @vitest-environment node

import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const projectRoot = path.resolve(import.meta.dirname, "../..");

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        return;
      }
    } catch {
      // The child is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

describe("CLI/server sync process boundary", () => {
  let tempRoot: string | undefined;
  let serverProcess: ChildProcess | undefined;

  afterEach(async () => {
    if (serverProcess) {
      await stopChild(serverProcess);
      serverProcess = undefined;
    }
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  test("CLI posts to the real canonical /api/sync route", async (context) => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "cli-sync-process-"));
    let port: number;
    try {
      port = await availablePort();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") {
        console.warn("CLI/server process test skipped: sandbox forbids local port binding (EPERM).");
        context.skip();
        return;
      }
      throw error;
    }
    serverProcess = spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: "production",
        PORT: String(port),
        CODEX_PROJECT_DATA_DIR: path.join(tempRoot, "data"),
        WORKSPACE_SCAN_ROOTS: ""
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    await waitForServer(`http://127.0.0.1:${port}/api/projects`);

    const cli = spawn(process.execPath, [
      "--import",
      "tsx",
      "bin/codex-project-sync.ts",
      "--task-id",
      "task-process-cli",
      "--working-directory",
      "/workspace/unmatched-cli-project",
      "--summary",
      "CLI process boundary event",
      "--changed-path",
      "src/server/main.ts"
    ], {
      cwd: projectRoot,
      env: {
        ...process.env,
        CODEX_SYNC_SERVER_URL: `http://127.0.0.1:${port}`
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    cli.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const exitCode = await new Promise<number>((resolve) => cli.once("exit", (code) => resolve(code ?? 1)));

    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({ result: { mutation: "none", match: { kind: "needs-review" } } });
    const reviews = JSON.parse(await readFile(path.join(tempRoot, "data", "sync-reviews.json"), "utf8")) as Array<Record<string, unknown>>;
    expect(reviews).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: "task-process-cli", status: "open", evidence: expect.any(Array) })
    ]));
  });
});
