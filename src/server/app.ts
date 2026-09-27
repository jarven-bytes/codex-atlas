import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { createApiHandler } from "./api";
import { serverConfig } from "./config";
import { createAppRequestHandler } from "./http-handler";
import { createImportService } from "./imports/import-service";
import { createLauncherService } from "./launch/launcher";
import { createProcessManager } from "./launch/process-manager";
import { createGracefulShutdown } from "./shutdown";
import { createProjectStore } from "./store/project-store";
import { createSyncService, type SyncService } from "./sync/sync-service";

export interface CreateProjectManagementServerOptions {
  host?: string;
  port?: number;
  dataDir?: string;
  clientDistDir?: string;
  runtimeRoot?: string;
  seedDataDir?: string;
  enableWorkspaceWatcher?: boolean;
  enableClientWatcher?: boolean;
  hmrPort?: number;
  openCommand?: (command: string[]) => Promise<void>;
  syncService?: SyncService;
}

export interface ProjectManagementServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function copySeedFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await copyFile(sourcePath, destinationPath, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

async function copyTokenizedSeedFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    const contents = await readFile(sourcePath, "utf8");
    await writeFile(
      destinationPath,
      contents.replaceAll("__CODEX_HOME__", homedir()),
      { encoding: "utf8", flag: "wx" }
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }
}

async function seedDataDirectory(dataDir: string, seedDataDir: string): Promise<void> {
  const registryPath = path.join(dataDir, "projects.json");
  if (await fileExists(registryPath)) {
    return;
  }

  await mkdir(dataDir, { recursive: true });
  await copySeedFile(
    path.join(seedDataDir, "import-mappings.json"),
    path.join(dataDir, "import-mappings.json")
  );
  await copyTokenizedSeedFile(
    path.join(seedDataDir, "projects.json"),
    registryPath
  );
}

async function createDevelopmentViteServer(host: string, hmrPort: number) {
  const { createServer: createViteServer } = await import("vite");
  return createViteServer({
    appType: "custom",
    server: {
      host,
      hmr: {
        host,
        port: hmrPort
      },
      middlewareMode: true
    }
  });
}

async function listen(server: Server, port: number, host: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    server.once("error", onError);
    server.listen(port, host, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeHttpServer(server: Server): Promise<void> {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export async function createProjectManagementServer(
  options: CreateProjectManagementServerOptions = {}
): Promise<ProjectManagementServer> {
  const host = options.host ?? "127.0.0.1";
  const requestedPort = options.port ?? 3000;
  const dataDir = path.resolve(options.dataDir ?? serverConfig.dataDir);
  const runtimeRoot = path.resolve(options.runtimeRoot ?? serverConfig.rootDir);
  const clientDistDir = path.resolve(
    options.clientDistDir ?? path.join(runtimeRoot, "dist/client")
  );
  const seedDataDir = path.resolve(
    options.seedDataDir ?? path.join(runtimeRoot, "resources", "seed")
  );

  await seedDataDirectory(dataDir, seedDataDir);

  const projectStore = createProjectStore({ dataDir });
  const processManager = createProcessManager();
  const launcher = createLauncherService({
    store: projectStore,
    processManager,
    trustFilePath: path.join(dataDir, "launch-trust.json"),
    ...(options.openCommand ? { openCommand: options.openCommand } : {})
  });
  const syncService = options.syncService ?? createSyncService({
    store: projectStore,
    dataDir,
    workspaceRoots: serverConfig.workspaceRoots,
    enableWatcher: options.enableWorkspaceWatcher ?? false,
    log: (message) => console.log(`[workspace-sync] ${message}`)
  });
  const importService = createImportService({ store: projectStore, dataDir });
  const vite = options.enableClientWatcher
    ? await createDevelopmentViteServer(host, options.hmrPort ?? 24_678)
    : null;
  const apiHandler = createApiHandler({
    store: projectStore,
    launcher,
    processManager,
    syncService,
    importService
  });
  const requestHandler = createAppRequestHandler({
    apiHandler,
    clientDistDir,
    indexHtmlPath: path.join(
      options.enableClientWatcher ? runtimeRoot : clientDistDir,
      "index.html"
    ),
    vite,
    transformIndexHtml: vite
      ? async (url, template) => vite.transformIndexHtml(url, template)
      : undefined
  });
  const server = createServer((request, response) => {
    void requestHandler(request, response);
  });

  let closeWorkspaceWatcher: null | (() => Promise<void>) = null;
  let startupScanPromise = Promise.resolve();
  let watcherStartPromise = Promise.resolve();
  const close = createGracefulShutdown({
    processManager,
    closeWatcher: async () => {
      await startupScanPromise;
      await watcherStartPromise;
      await closeWorkspaceWatcher?.();
    },
    closeVite: async () => {
      await vite?.close();
    },
    closeServer: () => closeHttpServer(server),
    logError: (error) => console.error("[server] graceful shutdown failed", error)
  });

  try {
    await listen(server, requestedPort, host);
  } catch (error) {
    await close();
    throw error;
  }

  const address = server.address() as AddressInfo | null;
  if (!address) {
    await close();
    throw new Error("HTTP server did not expose a listening address.");
  }

  console.log(`Project management server listening at http://${host}:${address.port}`);
  startupScanPromise = syncService.scanRoots()
    .then((outcome) => console.log(
      `[workspace-sync] startup scan: ${outcome.scannedRoots.length} roots, ${outcome.reviewIds.length} reviews`
    ))
    .catch((error) => console.error("[workspace-sync] startup scan failed", error));
  watcherStartPromise = syncService.startWatcher()
    .then((watcherClose) => {
      closeWorkspaceWatcher = watcherClose;
    })
    .catch((error) => console.error("[workspace-sync] watcher failed to start", error));

  return {
    url: `http://${host}:${address.port}`,
    port: address.port,
    close
  };
}
