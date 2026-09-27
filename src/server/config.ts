import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const seedDataDir = path.join(rootDir, "resources", "seed");
const dataDir = process.env.CODEX_PROJECT_DATA_DIR
  ? path.resolve(process.env.CODEX_PROJECT_DATA_DIR)
  : path.join(rootDir, "data");
const workspaceRoots = (process.env.WORKSPACE_SCAN_ROOTS ?? "")
  .split(path.delimiter)
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => path.resolve(entry));
const syncServerUrl = process.env.CODEX_SYNC_SERVER_URL ?? "http://127.0.0.1:3000";

export interface ServerConfig {
  rootDir: string;
  seedDataDir: string;
  dataDir: string;
  historyDir: string;
  registryPath: string;
  workspaceRoots: string[];
  syncServerUrl: string;
}

export function resolveServerDataPaths(selectedDataDir: string): Pick<
  ServerConfig,
  "dataDir" | "historyDir" | "registryPath"
> {
  const resolvedDataDir = path.resolve(selectedDataDir);
  return {
    dataDir: resolvedDataDir,
    historyDir: path.join(resolvedDataDir, "history"),
    registryPath: path.join(resolvedDataDir, "projects.json")
  };
}

const dataPaths = resolveServerDataPaths(dataDir);

export const serverConfig: ServerConfig = {
  rootDir,
  seedDataDir,
  ...dataPaths,
  workspaceRoots,
  syncServerUrl
};
