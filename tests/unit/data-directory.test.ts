// @vitest-environment node

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  createProjectManagementServer,
  type ProjectManagementServer
} from "../../src/server/app";
import { createProjectStore } from "../../src/server/store/project-store";
import type { SyncService } from "../../src/server/sync/sync-service";
import type { Project } from "../../src/shared/domain";

const projectRoot = path.resolve(".");
const seedDataDir = path.join(projectRoot, "tests", "fixtures", "seed");
const temporaryDirectories: string[] = [];
const openServers: ProjectManagementServer[] = [];

function createIdleSyncService(): SyncService {
  return {
    async scanRoots() {
      return { scannedRoots: [], updatedProjectIds: [], reviewIds: [] };
    },
    async syncCodexEvent() {
      throw new Error("Codex sync is not used in data-directory acceptance tests.");
    },
    async syncWorkspaceCandidate() {
      throw new Error("Workspace sync is not used in data-directory acceptance tests.");
    },
    async listReviews() {
      return [];
    },
    async startWatcher() {
      return null;
    }
  };
}

async function createTemporaryUserData(): Promise<string> {
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), "project-user-data-"));
  temporaryDirectories.push(userDataDir);
  return userDataDir;
}

async function startDesktopServer(dataDir: string, selectedSeedDataDir = seedDataDir): Promise<ProjectManagementServer> {
  const server = await createProjectManagementServer({
    host: "127.0.0.1",
    port: 0,
    dataDir,
    runtimeRoot: projectRoot,
    seedDataDir: selectedSeedDataDir,
    enableWorkspaceWatcher: false,
    enableClientWatcher: false,
    openCommand: async () => undefined,
    syncService: createIdleSyncService()
  });
  openServers.push(server);
  return server;
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    ))
  );
});

describe("desktop application data directory", () => {
  test("seeds userData/data from the canonical registry on first launch", async () => {
    const userDataDir = await createTemporaryUserData();
    const dataDir = path.join(userDataDir, "data");
    const server = await startDesktopServer(dataDir);

    await server.close();

    await expect(
      readFile(path.join(dataDir, "projects.json"), "utf8")
    ).resolves.toBe(await readFile(path.join(seedDataDir, "projects.json"), "utf8"));
    await expect(
      readFile(path.join(dataDir, "import-mappings.json"), "utf8")
    ).resolves.toBe(await readFile(path.join(seedDataDir, "import-mappings.json"), "utf8"));
  });

  test("preserves a modified registry when the desktop server launches again", async () => {
    const userDataDir = await createTemporaryUserData();
    const dataDir = path.join(userDataDir, "data");
    const firstServer = await startDesktopServer(dataDir);
    const seededRegistry = JSON.parse(
      await readFile(path.join(dataDir, "projects.json"), "utf8")
    ) as Project[];
    await firstServer.close();

    const modifiedRegistry = seededRegistry.map((project, index) => (
      index === 0
        ? { ...project, name: "Local desktop edit" }
        : project
    ));
    await writeFile(
      path.join(dataDir, "projects.json"),
      `${JSON.stringify(modifiedRegistry, null, 2)}\n`,
      "utf8"
    );

    const secondServer = await startDesktopServer(dataDir);
    const response = await fetch(`${secondServer.url}/api/projects`);
    const body = await response.json() as { projects: Project[] };

    expect(response.status).toBe(200);
    expect(body.projects).toEqual(modifiedRegistry);
    await secondServer.close();
  });

  test("accepts a restored data-directory backup through a fresh project store", async () => {
    const userDataDir = await createTemporaryUserData();
    const dataDir = path.join(userDataDir, "data");
    const server = await startDesktopServer(dataDir);
    await server.close();

    const backupRoot = await mkdtemp(path.join(os.tmpdir(), "project-data-backup-"));
    temporaryDirectories.push(backupRoot);
    const backupDataDir = path.join(backupRoot, "data");
    await cp(dataDir, backupDataDir, { recursive: true });

    const store = createProjectStore({ dataDir });
    const originalRegistry = await store.list();
    await store.applyMutation({
      kind: "upsert",
      project: { ...originalRegistry[0], name: "Modified before restore" }
    });
    expect((await store.list())[0].name).toBe("Modified before restore");

    await rm(dataDir, { recursive: true, force: true });
    await cp(backupDataDir, dataDir, { recursive: true });

    await expect(createProjectStore({ dataDir }).list()).resolves.toEqual(originalRegistry);
  });

  test("materializes the packaged home token only when seeding a new registry", async () => {
    const userDataDir = await createTemporaryUserData();
    const packagedSeedDir = await mkdtemp(path.join(os.tmpdir(), "project-packaged-seed-"));
    temporaryDirectories.push(packagedSeedDir);
    const projects = JSON.parse(await readFile(path.join(seedDataDir, "projects.json"), "utf8")) as Project[];
    projects[0] = { ...projects[0], rootPath: "__CODEX_HOME__/Documents/example-project" };
    await writeFile(path.join(packagedSeedDir, "projects.json"), `${JSON.stringify(projects, null, 2)}\n`, "utf8");
    await cp(
      path.join(seedDataDir, "import-mappings.json"),
      path.join(packagedSeedDir, "import-mappings.json")
    );

    const server = await startDesktopServer(path.join(userDataDir, "data"), packagedSeedDir);
    const response = await fetch(`${server.url}/api/projects`);
    const body = await response.json() as { projects: Project[] };

    expect(response.status).toBe(200);
    expect(body.projects[0].rootPath).toBe(path.join(os.homedir(), "Documents/example-project"));
    await server.close();
  });
});
