// @vitest-environment node

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createApiHandler } from "../../src/server/api";
import { createLauncherService } from "../../src/server/launch/launcher";
import { createProcessManager } from "../../src/server/launch/process-manager";
import { createProjectStore } from "../../src/server/store/project-store";
import type { Project } from "../../src/shared/domain";

async function invoke(handler: ReturnType<typeof createApiHandler>, method: string, pathname: string, body = "{}") {
  const request = Object.assign(Readable.from([body]), {
    method,
    url: pathname,
    headers: { host: "127.0.0.1", "content-type": "application/json" }
  });
  let text = "";
  const headers = new Map<string, string>();
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) { headers.set(name.toLowerCase(), value); },
    end(chunk?: string | Buffer) { text = chunk?.toString() ?? ""; }
  };
  await handler(request as never, response as never);
  return { status: response.statusCode, json: text ? JSON.parse(text) as Record<string, any> : null };
}

function buildProject(rootPath: string, commandPath: string): Project {
  return {
    id: "process-project",
    name: "Process Composition Project",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Verify the real launcher composition.",
    currentState: "The process API is under test.",
    nextAction: "Stop the launched process.",
    rootPath,
    sources: [],
    launchTargets: [{
      kind: "command",
      id: "start-server",
      label: "Start test server",
      origin: "manual",
      executable: process.execPath,
      args: [commandPath],
      cwd: rootPath
    }],
    lastActivityAt: "2026-08-20T12:00:00.000Z",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    syncStatus: "success",
    updatedAt: "2026-08-20T12:00:00.000Z",
    pinned: false,
    archived: false
  };
}

describe("real API process composition", () => {
  let tempRoot: string | undefined;
  let manager: ReturnType<typeof createProcessManager> | undefined;

  afterEach(async () => {
    await manager?.shutdown();
    manager = undefined;
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  test("launches, polls, and stops through the injected shared manager", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "process-composition-"));
    const commandPath = path.join(tempRoot, "server.mjs");
    await writeFile(commandPath, [
      "setInterval(() => undefined, 1000);",
      "process.on('SIGTERM', () => process.exit(0));"
    ].join("\n"));
    const store = createProjectStore({ dataDir: path.join(tempRoot, "data") });
    await store.applyMutation({ kind: "upsert", project: buildProject(tempRoot, commandPath) });
    manager = createProcessManager({ readinessPollIntervalMs: 20, readinessTimeoutMs: 2_000 });
    const launcher = createLauncherService({
      store,
      processManager: manager,
      trustFilePath: path.join(tempRoot, "launch-trust.json"),
      openCommand: async () => undefined
    });
    const handler = createApiHandler({ store, processManager: manager, launcher });

    const approval = await invoke(handler, "POST", "/api/projects/process-project/launch/start-server");
    expect(approval.json?.result).toMatchObject({ status: "approval-required" });
    const started = await invoke(
      handler,
      "POST",
      "/api/projects/process-project/launch/start-server",
      JSON.stringify({ fingerprint: approval.json?.result.fingerprint })
    );
    expect(started.status).toBe(200);
    const processId = started.json?.result.processId as string;

    let process = (await invoke(handler, "GET", `/api/processes/${processId}`)).json?.process;
    const deadline = Date.now() + 2_000;
    while (process?.status !== "Running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 30));
      process = (await invoke(handler, "GET", `/api/processes/${processId}`)).json?.process;
    }
    expect(process).toMatchObject({ processId, status: "Running" });

    const stopped = await invoke(handler, "POST", `/api/processes/${processId}/stop`);
    expect(stopped).toMatchObject({ status: 200, json: { process: { processId, status: "Stopped" } } });
  });
});
