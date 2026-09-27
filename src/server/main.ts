import path from "node:path";
import { createProjectManagementServer } from "./app";
import { createRecordedOpenCommand } from "./launch/open-command";
const recordedOpenCommand = process.env.CODEX_LAUNCHER_LOG_PATH
  ? createRecordedOpenCommand(path.resolve(process.env.CODEX_LAUNCHER_LOG_PATH))
  : undefined;
const server = await createProjectManagementServer({
  host: "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  enableWorkspaceWatcher: process.env.ENABLE_WORKSPACE_WATCHER === "1",
  enableClientWatcher: process.env.NODE_ENV !== "production",
  hmrPort: Number(process.env.VITE_HMR_PORT ?? 24_678),
  ...(recordedOpenCommand ? { openCommand: recordedOpenCommand } : {})
});

let signalShutdown: Promise<void> | null = null;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    signalShutdown ??= server.close().finally(() => process.exit(0));
  });
}
