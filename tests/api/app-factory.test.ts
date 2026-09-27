// @vitest-environment node

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createProjectManagementServer,
  type ProjectManagementServer
} from "../../src/server/app";
import type { SyncService } from "../../src/server/sync/sync-service";

const temporaryDirectories: string[] = [];
const openServers: ProjectManagementServer[] = [];

async function createTemporaryDataDir(): Promise<string> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "project-app-factory-"));
  temporaryDirectories.push(dataDir);
  return dataDir;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    ))
  );
});

describe("project management server factory", () => {
  test("starts on an ephemeral loopback port, seeds first-run data, and closes idempotently", async () => {
    const dataDir = await createTemporaryDataDir();
    const server = await createProjectManagementServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      seedDataDir: path.resolve(import.meta.dirname, "../fixtures/seed"),
      enableWorkspaceWatcher: false,
      enableClientWatcher: false,
      openCommand: async () => undefined
    });
    openServers.push(server);

    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);
    expect(server.port).toBeGreaterThan(0);

    const response = await fetch(`${server.url}/api/projects`);
    expect(response.status).toBe(200);
    const body = await response.json() as { projects: Array<{ id: string }> };
    expect(body.projects).toHaveLength(6);
    expect(body.projects.map((project) => project.id).sort()).toEqual([
      "ai-daily-planner",
      "applypilot-job-search",
      "flight-price-tracker",
      "linear-activity-summary",
      "sites-web-project",
      "weekday-morning-brief"
    ]);
    expect(JSON.parse(await readFile(path.join(dataDir, "import-mappings.json"), "utf8"))).toBeTruthy();

    const firstClose = server.close();
    const secondClose = server.close();
    expect(secondClose).toBe(firstClose);
    await expect(Promise.all([firstClose, secondClose])).resolves.toEqual([undefined, undefined]);
  });

  test("does not overwrite an existing registry in the selected data directory", async () => {
    const dataDir = await createTemporaryDataDir();
    const existingRegistry = [{ id: "existing-project", name: "Existing Project" }];
    await writeFile(
      path.join(dataDir, "projects.json"),
      `${JSON.stringify(existingRegistry, null, 2)}\n`,
      "utf8"
    );

    const server = await createProjectManagementServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      enableWorkspaceWatcher: false,
      enableClientWatcher: false,
      openCommand: async () => undefined
    });
    openServers.push(server);

    const response = await fetch(`${server.url}/api/projects`);
    const body = await response.json() as { projects: Array<{ id: string }> };
    expect(body.projects).toEqual(existingRegistry);
    expect(JSON.parse(await readFile(path.join(dataDir, "projects.json"), "utf8"))).toEqual(existingRegistry);
  });

  test("waits for an in-flight startup sync callback before close resolves", async () => {
    const dataDir = await createTemporaryDataDir();
    let releaseScan!: () => void;
    let scanSettled = false;
    const delayedScan = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    const syncService: SyncService = {
      async scanRoots() {
        await delayedScan;
        scanSettled = true;
        return { scannedRoots: [], updatedProjectIds: [], reviewIds: [] };
      },
      async syncCodexEvent() {
        throw new Error("Not used in this lifecycle test.");
      },
      async syncWorkspaceCandidate() {
        throw new Error("Not used in this lifecycle test.");
      },
      async listReviews() {
        return [];
      },
      async startWatcher() {
        return null;
      }
    };
    const server = await createProjectManagementServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      enableWorkspaceWatcher: false,
      enableClientWatcher: false,
      openCommand: async () => undefined,
      syncService
    });
    openServers.push(server);

    let closeSettled = false;
    const closePromise = server.close().then(() => {
      closeSettled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(scanSettled).toBe(false);
    expect(closeSettled).toBe(false);

    releaseScan();
    await closePromise;
    expect(scanSettled).toBe(true);
    expect(closeSettled).toBe(true);
  });
});
