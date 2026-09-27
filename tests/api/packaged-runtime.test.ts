// @vitest-environment node

import { cp, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const repositoryRoot = path.resolve(import.meta.dirname, "../..");
const compiledServerSource = path.join(repositoryRoot, "dist/server");
const seedDataSource = path.join(repositoryRoot, "tests", "fixtures", "seed");
const temporaryDirectories: string[] = [];
const openServers: Array<{ close: () => Promise<void> }> = [];

async function createPackageLayout(packageRoot: string): Promise<{
  clientDistDir: string;
  packagedServerDir: string;
  seedDataDir: string;
}> {
  const clientDistDir = path.join(packageRoot, "dist/client");
  const packagedServerDir = path.join(packageRoot, "dist/server");
  const seedDataDir = path.join(packageRoot, "resources", "seed");
  await mkdir(clientDistDir, { recursive: true });
  await cp(compiledServerSource, packagedServerDir, {
    recursive: true,
    filter: (source) => !source.endsWith(".map")
  });
  await removeSourceMapComments(packagedServerDir);
  await cp(seedDataSource, seedDataDir, { recursive: true });
  await writeFile(
    path.join(clientDistDir, "index.html"),
    "<!doctype html><title>Packaged dashboard</title><main>packaged dashboard</main>\n",
    "utf8"
  );

  return { clientDistDir, packagedServerDir, seedDataDir };
}

async function importCompiledFactory(packagedServerDir: string) {
  const serverModule = await import(pathToFileURL(path.join(packagedServerDir, "app.js")).href);
  return serverModule.createProjectManagementServer as (options: Record<string, unknown>) => Promise<{
    close: () => Promise<void>;
    url: string;
  }>;
}

async function removeSourceMapComments(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await removeSourceMapComments(filePath);
      continue;
    }

    if (entry.name.endsWith(".js")) {
      const source = await readFile(filePath, "utf8");
      await writeFile(filePath, source.replace(/\n\/\/# sourceMappingURL=.*$/u, ""), "utf8");
    }
  }
}

afterEach(async () => {
  await Promise.all(openServers.splice(0).map((server) => server.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => (
      rm(directory, { recursive: true, force: true })
    ))
  );
});

describe("packaged server runtime", () => {
  test("serves the dashboard and API from an isolated compiled runtime", async () => {
    const packageRoot = await mkdtemp(path.join(os.tmpdir(), "project-packaged-runtime-"));
    temporaryDirectories.push(packageRoot);

    const clientDistDir = path.join(packageRoot, "dist/client");
    const packagedServerDir = path.join(packageRoot, "dist/server");
    const seedDataDir = path.join(packageRoot, "resources", "seed");
    const dataDir = path.join(packageRoot, "user-data");
    await createPackageLayout(packageRoot);

    const createProjectManagementServer = await importCompiledFactory(packagedServerDir);
    const server = await createProjectManagementServer({
      host: "127.0.0.1",
      port: 0,
      dataDir,
      clientDistDir,
      runtimeRoot: packageRoot,
      seedDataDir,
      enableWorkspaceWatcher: false,
      enableClientWatcher: false,
      openCommand: async () => undefined
    });
    openServers.push(server);

    const dashboardResponse = await fetch(server.url);
    expect(dashboardResponse.status).toBe(200);
    expect(await dashboardResponse.text()).toContain("packaged dashboard");

    const apiResponse = await fetch(`${server.url}/api/projects`);
    expect(apiResponse.status).toBe(200);
    const body = await apiResponse.json() as { projects: Array<{ id: string }> };
    expect(body.projects).toHaveLength(6);
  });

  test("derives defaults from an app.asar-shaped compiled package", async () => {
    const resourcesRoot = await mkdtemp(path.join(os.tmpdir(), "project-packaged-resources-"));
    temporaryDirectories.push(resourcesRoot);
    const packageRoot = path.join(resourcesRoot, "app.asar");
    await mkdir(packageRoot, { recursive: true });
    const { packagedServerDir } = await createPackageLayout(packageRoot);
    const dataDir = path.join(resourcesRoot, "user-data");
    const originalResourcesPath = Object.getOwnPropertyDescriptor(process, "resourcesPath");
    const originalDefaultApp = Object.getOwnPropertyDescriptor(process, "defaultApp");
    Object.defineProperty(process, "resourcesPath", {
      configurable: true,
      value: resourcesRoot
    });
    Object.defineProperty(process, "defaultApp", {
      configurable: true,
      value: false
    });

    try {
      const createProjectManagementServer = await importCompiledFactory(packagedServerDir);
      const server = await createProjectManagementServer({
        host: "127.0.0.1",
        port: 0,
        dataDir,
        enableWorkspaceWatcher: false,
        enableClientWatcher: false,
        openCommand: async () => undefined
      });
      openServers.push(server);

      const dashboardResponse = await fetch(server.url);
      expect(dashboardResponse.status).toBe(200);
      expect(await dashboardResponse.text()).toContain("packaged dashboard");

      const apiResponse = await fetch(`${server.url}/api/projects`);
      expect(apiResponse.status).toBe(200);
      const body = await apiResponse.json() as { projects: Array<{ id: string }> };
      expect(body.projects).toHaveLength(6);
    } finally {
      if (originalResourcesPath) {
        Object.defineProperty(process, "resourcesPath", originalResourcesPath);
      } else {
        delete (process as unknown as Record<string, unknown>).resourcesPath;
      }
      if (originalDefaultApp) {
        Object.defineProperty(process, "defaultApp", originalDefaultApp);
      } else {
        delete (process as unknown as Record<string, unknown>).defaultApp;
      }
    }
  });
});
