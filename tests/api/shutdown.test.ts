// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { createProcessManager } from "../../src/server/launch/process-manager";
import { createGracefulShutdown } from "../../src/server/shutdown";

describe("graceful server shutdown", () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  test("awaits managed child termination before closing the server and exiting", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "shutdown-"));
    const scriptPath = path.join(tempRoot, "long-running.mjs");
    await writeFile(scriptPath, "setInterval(() => undefined, 1000);\nprocess.on('SIGTERM', () => process.exit(0));\n");
    const manager = createProcessManager();
    const state = await manager.startProcess({
      executable: process.execPath,
      args: [scriptPath],
      cwd: tempRoot
    });
    const order: string[] = [];
    const exit = vi.fn((code: number) => order.push(`exit:${code}`));
    const shutdown = createGracefulShutdown({
      processManager: manager,
      closeServer: async () => {
        expect(manager.getProcessState(state.processId).status).toBe("Stopped");
        order.push("server-closed");
      },
      exit
    });

    await shutdown();

    expect(order).toEqual(["server-closed", "exit:0"]);
    expect(exit).toHaveBeenCalledOnce();
  });

  test("continues cleanup when watcher cleanup rejects", async () => {
    const processShutdown = vi.fn().mockResolvedValue(undefined);
    const closeServer = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const exit = vi.fn();
    const shutdown = createGracefulShutdown({
      processManager: { shutdown: processShutdown },
      closeWatcher: vi.fn().mockRejectedValue(new Error("watcher closed badly")),
      closeServer,
      logError,
      exit,
      shutdownDeadlineMs: 100
    });

    await shutdown();

    expect(processShutdown).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
  });

  test("continues cleanup and exits at the deadline when watcher cleanup hangs", async () => {
    const processShutdown = vi.fn().mockResolvedValue(undefined);
    const closeVite = vi.fn().mockResolvedValue(undefined);
    const closeServer = vi.fn().mockResolvedValue(undefined);
    const logError = vi.fn();
    const exit = vi.fn();
    const startedAt = Date.now();
    const shutdown = createGracefulShutdown({
      processManager: { shutdown: processShutdown },
      closeWatcher: () => new Promise<void>(() => undefined),
      closeVite,
      closeServer,
      logError,
      exit,
      shutdownDeadlineMs: 25
    });

    await shutdown();

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(processShutdown).toHaveBeenCalledOnce();
    expect(closeVite).toHaveBeenCalledOnce();
    expect(closeServer).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith(expect.objectContaining({ message: "Graceful shutdown exceeded 25ms." }));
    expect(exit).toHaveBeenCalledWith(0);
  });
});
