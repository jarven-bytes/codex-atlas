// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  LaunchProcessError,
  createProcessManager
} from "../../src/server/launch/process-manager";

describe("process manager", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "process-manager-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("starts a development server, waits for the configured local port, and opens it after readiness", async () => {
    const port = 4173;
    const scriptPath = path.join(tempRoot, "server.mjs");
    await writeFile(
      scriptPath,
      [
        "setInterval(() => {",
        "  process.stdout.write('server-heartbeat');",
        "}, 250);"
      ].join("\n")
    );

    const openCommand = vi.fn().mockResolvedValue(undefined);
    const waitForPort = vi.fn().mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150));
    });
    const manager = createProcessManager({
      openCommand,
      waitForPort,
      readinessPollIntervalMs: 25,
      readinessTimeoutMs: 3_000,
      outputLimit: 256
    });

    const startingState = await manager.startProcess({
      executable: process.execPath,
      args: [scriptPath, String(port)],
      cwd: tempRoot,
      port
    });

    expect(startingState.status).toBe("Starting");

    await vi.waitFor(() => {
      expect(manager.getProcessState(startingState.processId)).toMatchObject({
        status: "Running"
      });
    });
    expect(waitForPort).toHaveBeenCalledWith(port);
    expect(openCommand).toHaveBeenCalledWith(["/usr/bin/open", `http://127.0.0.1:${port}`]);

    await manager.stopProcess(startingState.processId);
  });

  test("captures bounded stdout and stderr and records failed exits deterministically", async () => {
    const scriptPath = path.join(tempRoot, "failing.mjs");
    await writeFile(
      scriptPath,
      [
        "process.stdout.write('A'.repeat(1024));",
        "process.stdout.write('stdout-tail');",
        "process.stderr.write('B'.repeat(1024));",
        "process.stderr.write('stderr-tail');",
        "process.exit(7);"
      ].join("\n")
    );

    const manager = createProcessManager({
      outputLimit: 128
    });

    const state = await manager.startProcess({
      executable: process.execPath,
      args: [scriptPath],
      cwd: tempRoot
    });

    await vi.waitFor(() => {
      expect(manager.getProcessState(state.processId).status).toBe("Failed");
    });

    const failedState = manager.getProcessState(state.processId);
    expect(failedState).toMatchObject({
      status: "Failed",
      exitCode: 7
    });
    expect(failedState.stdout.length).toBeLessThanOrEqual(128);
    expect(failedState.stderr.length).toBeLessThanOrEqual(128);
    expect(failedState.stdout).toContain("stdout-tail");
    expect(failedState.stderr).toContain("stderr-tail");
  });

  test("stops the spawned process group, including child processes", async () => {
    const childScriptPath = path.join(tempRoot, "child.mjs");
    const parentScriptPath = path.join(tempRoot, "parent.mjs");
    const childPidPath = path.join(tempRoot, "child.pid");

    await writeFile(
      childScriptPath,
      [
        "setInterval(() => {",
        "  process.stdout.write('child-heartbeat');",
        "}, 250);"
      ].join("\n")
    );
    await writeFile(
      parentScriptPath,
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        `const child = spawn(process.execPath, ['${childScriptPath}'], { stdio: 'ignore' });`,
        `writeFileSync('${childPidPath}', String(child.pid));`,
        "setInterval(() => {",
        "  process.stdout.write('parent-heartbeat');",
        "}, 250);"
      ].join("\n")
    );

    const manager = createProcessManager({
      outputLimit: 256
    });
    const state = await manager.startProcess({
      executable: process.execPath,
      args: [parentScriptPath],
      cwd: tempRoot
    });

    await vi.waitFor(async () => {
      const childPid = Number(await readFile(childPidPath, "utf8"));
      expect(childPid).toBeGreaterThan(0);
    });

    const childPid = Number(await readFile(childPidPath, "utf8"));
    const stopped = await manager.stopProcess(state.processId);
    expect(stopped.status).toBe("Stopped");

    await vi.waitFor(() => {
      expect(() => process.kill(childPid, 0)).toThrow();
    });
  });

  test("throws a deterministic error when stopping an unknown process", async () => {
    const manager = createProcessManager();

    await expect(manager.stopProcess("missing-process")).rejects.toMatchObject({
      code: "PROCESS_NOT_FOUND"
    } satisfies Partial<LaunchProcessError>);
  });

  test("preserves failed status when readiness or app opening fails before a clean exit", async () => {
    const scriptPath = path.join(tempRoot, "clean-exit.mjs");
    await writeFile(
      scriptPath,
      [
        "setTimeout(() => {",
        "  process.exit(0);",
        "}, 100);"
      ].join("\n")
    );

    const manager = createProcessManager({
      waitForPort: vi.fn().mockResolvedValue(undefined),
      openCommand: vi.fn().mockRejectedValue(new Error("Open failed.")),
      outputLimit: 128
    });

    const state = await manager.startProcess({
      executable: process.execPath,
      args: [scriptPath],
      cwd: tempRoot,
      port: 4173
    });

    await vi.waitFor(() => {
      expect(manager.getProcessState(state.processId)).toMatchObject({
        status: "Failed"
      });
    });

    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(manager.getProcessState(state.processId)).toMatchObject({
      status: "Failed",
      exitCode: 0
    });
  });

  test("removes completed processes from the live registry after retaining a final snapshot", async () => {
    const scriptPath = path.join(tempRoot, "complete.mjs");
    await writeFile(scriptPath, "process.exit(0);\n");

    const manager = createProcessManager({
      completedProcessTtlMs: 25
    });

    const state = await manager.startProcess({
      executable: process.execPath,
      args: [scriptPath],
      cwd: tempRoot
    });

    await vi.waitFor(
      () => expect(() => manager.getProcessState(state.processId)).toThrowError(/Unknown process/),
      { timeout: 1_000, interval: 10 }
    );
  });
});
