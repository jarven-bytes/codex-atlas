import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "playwright/test";

const projectRoot = import.meta.dirname;
const runtimeRoot = path.join(projectRoot, "test-results", "task-10-runtime");
const dataDir = path.join(runtimeRoot, "data");
const restartDataDir = path.join(runtimeRoot, "restart-data");
const importPath = path.join(runtimeRoot, "project-import.csv");
const launchLogPath = path.join(runtimeRoot, "launcher.jsonl");
const overviewViewportScreenshotPath = path.join(projectRoot, "test-results", "task-10-dashboard-overview-viewport.png");
const overviewScreenshotPath = path.join(projectRoot, "test-results", "task-10-dashboard-overview.png");
const screenshotPath = path.join(projectRoot, "test-results", "task-10-dashboard.png");
const port = Number(process.env.CODEX_E2E_PORT ?? 51400);
const baseURL = `http://127.0.0.1:${port}`;

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(dataDir, { recursive: true });
mkdirSync(restartDataDir, { recursive: true });
cpSync(path.join(projectRoot, "tests/fixtures/seed/projects.json"), path.join(dataDir, "projects.json"));
cpSync(path.join(projectRoot, "tests/fixtures/seed/import-mappings.json"), path.join(dataDir, "import-mappings.json"));
cpSync(path.join(projectRoot, "tests/fixtures/seed/projects.json"), path.join(restartDataDir, "projects.json"));
cpSync(path.join(projectRoot, "tests/fixtures/seed/import-mappings.json"), path.join(restartDataDir, "import-mappings.json"));
const fixtureProjects = JSON.parse(readFileSync(path.join(dataDir, "projects.json"), "utf8"));
for (const project of fixtureProjects) {
  project.rootPath = path.join(runtimeRoot, "projects", project.id);
  mkdirSync(project.rootPath, { recursive: true });
  for (const target of project.launchTargets) {
    if (target.kind === "folder") target.path = project.rootPath;
  }
}
for (const directory of [dataDir, restartDataDir]) {
  writeFileSync(path.join(directory, "projects.json"), JSON.stringify(fixtureProjects));
}
writeFileSync(
  importPath,
  [
    "Project Name,Need Status,User Need,Current State,Next Action",
    "Task 10 Imported Project,Need,Verify local import lifecycle,Preview is source-backed,Review the imported record"
  ].join("\n") + "\n",
  "utf8"
);

process.env.CODEX_E2E_DATA_DIR = dataDir;
process.env.CODEX_E2E_RESTART_DATA_DIR = restartDataDir;
process.env.CODEX_E2E_IMPORT_PATH = importPath;
process.env.CODEX_E2E_LAUNCH_LOG_PATH = launchLogPath;
process.env.CODEX_E2E_OVERVIEW_VIEWPORT_SCREENSHOT_PATH = overviewViewportScreenshotPath;
process.env.CODEX_E2E_OVERVIEW_SCREENSHOT_PATH = overviewScreenshotPath;
process.env.CODEX_E2E_SCREENSHOT_PATH = screenshotPath;

export default defineConfig({
  testDir: "./tests/e2e",
  testIgnore: /desktop-smoke\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 8_000 },
  reporter: "list",
  outputDir: "test-results/playwright",
  webServer: {
    command: "npm run dev",
    url: `${baseURL}/api/projects`,
    timeout: 30_000,
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: String(port),
      VITE_HMR_PORT: "31097",
      VITE_E2E_DETERMINISTIC_CHART: "1",
      CODEX_PROJECT_DATA_DIR: dataDir,
      CODEX_LAUNCHER_LOG_PATH: launchLogPath,
      ENABLE_CLIENT_WATCHER: "0",
      ENABLE_WORKSPACE_WATCHER: "0"
    }
  },
  use: {
    baseURL,
    viewport: { width: 1440, height: 1000 },
    trace: "retain-on-failure"
  }
});
