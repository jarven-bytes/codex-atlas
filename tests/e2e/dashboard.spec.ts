import { spawn, type ChildProcess } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import path from "node:path";
import { expect, test, type Page } from "playwright/test";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const dataDir = process.env.CODEX_E2E_DATA_DIR!;
const restartDataDir = process.env.CODEX_E2E_RESTART_DATA_DIR!;
const importPath = process.env.CODEX_E2E_IMPORT_PATH!;
const launchLogPath = process.env.CODEX_E2E_LAUNCH_LOG_PATH!;
const overviewViewportScreenshotPath = process.env.CODEX_E2E_OVERVIEW_VIEWPORT_SCREENSHOT_PATH!;
const overviewScreenshotPath = process.env.CODEX_E2E_OVERVIEW_SCREENSHOT_PATH!;
const screenshotPath = process.env.CODEX_E2E_SCREENSHOT_PATH!;

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForProjects(
  port: number,
  child: ChildProcess
): Promise<Array<Record<string, unknown>>> {
  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`Restarted app exited before readiness with code ${child.exitCode}: ${String(lastError)}`);
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/projects`);
      if (response.ok) {
        const body = await response.json() as { projects: Array<Record<string, unknown>> };
        return body.projects;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for restarted app: ${String(lastError)}`);
}

function startApp(port: number, hmrPort: number, appDataDir: string): ChildProcess {
  return spawn(process.execPath, ["--import", "tsx", "src/server/main.ts"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      VITE_HMR_PORT: String(hmrPort),
      CODEX_PROJECT_DATA_DIR: appDataDir,
      CODEX_LAUNCHER_LOG_PATH: launchLogPath,
      ENABLE_CLIENT_WATCHER: "0",
      ENABLE_WORKSPACE_WATCHER: "0"
    },
    stdio: "ignore"
  });
}

async function stopApp(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Timed out waiting for app process to exit after SIGTERM"));
    }, 5_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function waitForCompleteDonut(page: Page): Promise<void> {
  await expect.poll(async () => {
    return page.locator(".status-chart-frame .recharts-pie-sector path").evaluateAll((elements) => {
      const sectors = elements.map((element) => {
        const path = element as SVGPathElement;
        const box = path.getBBox();
        const definition = path.getAttribute("d") ?? "";
        return {
          width: box.width,
          height: box.height,
          hasArc: (definition.match(/A/g) ?? []).length >= 2,
          isClosed: definition.endsWith("Z")
        };
      });

      return sectors.length === 3 && sectors.every((sector) => (
        sector.width > 0 &&
        sector.height > 0 &&
        sector.hasArc &&
        sector.isClosed
      ));
    });
  }, { timeout: 8_000 }).toBe(true);
}

test("runs the six-project dashboard, launcher, and import undo workflow", async ({ page }) => {
  await page.clock.setFixedTime(new Date("2026-08-20T13:00:00Z"));
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));

  await page.goto("/");
  await expect(page).toHaveTitle("Codex Atlas");
  await expect(page.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
  await expect(page.locator(".status-chart-total strong")).toHaveText("6");
  await expect(page.locator(".status-chart-frame svg")).toBeVisible();
  await expect(page.locator(".status-chart-frame .recharts-pie-sector")).toHaveCount(3);
  await waitForCompleteDonut(page);
  await expect(page.getByRole("table", { name: "Projects", exact: true }).getByRole("row")).toHaveCount(7);
  await page.screenshot({ path: overviewViewportScreenshotPath });
  await page.screenshot({ path: overviewScreenshotPath, fullPage: true });

  await page.getByRole("button", { name: "Need slice 2 projects" }).click();
  await expect(page).toHaveURL(/status=Need/u);
  await expect(page.getByRole("button", { name: "Need slice 2 projects" })).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expect(page.getByRole("table", { name: "Projects", exact: true }).getByRole("row")).toHaveCount(3);
  await expect(page.getByRole("row", { name: /ApplyPilot Job Search/u })).toBeVisible();
  await expect(page.getByRole("row", { name: /Sites\/Web Project/u })).toBeVisible();
  await expect(page.getByRole("list", { name: "Attention queue" })).toContainText(
    "Review the example project."
  );

  await page.getByRole("table", { name: "Projects", exact: true })
    .getByRole("row", { name: /ApplyPilot Job Search/u }).click();
  const detail = page.getByRole("complementary", { name: "Project detail" });
  await expect(detail.getByRole("heading", { name: "ApplyPilot Job Search" })).toBeVisible();
  await expect(detail).toContainText("Review example requirements");

  await detail.getByRole("button", { name: "Open Project folder", exact: true }).click();
  await expect(detail.getByText("Opened target.")).toBeVisible();
  await expect.poll(async () => readFile(launchLogPath, "utf8")).toContain(
    path.join(path.dirname(dataDir), "projects", "applypilot-job-search")
  );

  await page.getByRole("button", { name: "Import project data" }).click();
  const importCenter = detail.getByRole("region", { name: "Import center" });
  await importCenter.getByLabel("Import type").selectOption("structured-file");
  await importCenter.getByLabel("Import path").fill(importPath);
  await importCenter.getByLabel("Structured format").selectOption("csv");
  await importCenter.getByRole("button", { name: "Preview import" }).click();
  for (const [column, field] of Object.entries({
    "Project Name": "name",
    "Need Status": "needStatus",
    "User Need": "userNeed",
    "Current State": "currentState",
    "Next Action": "nextAction"
  })) {
    await importCenter.getByLabel(`Map ${column}`, { exact: true }).selectOption(field);
  }
  await importCenter.getByRole("button", { name: "Refresh preview" }).click();
  await expect(importCenter.getByText("create 1")).toBeVisible();
  await expect(importCenter.getByText("Task 10 Imported Project")).toBeVisible();

  await importCenter.getByRole("button", { name: "Commit preview" }).click();
  await expect(importCenter.getByRole("status")).toHaveText("Imported 1 rows.");
  await expect(page.getByRole("table", { name: "Projects", exact: true }).getByRole("row")).toHaveCount(4);
  await importCenter.getByRole("button", { name: "Undo last import" }).click();
  await expect(importCenter.getByRole("status")).toHaveText("Restored the previous registry snapshot.");
  await expect(page.getByRole("table", { name: "Projects", exact: true }).getByRole("row")).toHaveCount(3);
  const drawerWidth = await detail.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth
  }));
  expect(drawerWidth.scrollWidth).toBeLessThanOrEqual(drawerWidth.clientWidth + 1);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  expect(consoleErrors).toEqual([]);
});

test("exports valid seeded formats and proves a stopped app can relaunch without duplicates", async ({ request }) => {
  const expectedExportFields = [
    "id",
    "name",
    "type",
    "needStatus",
    "userNeed",
    "currentState",
    "nextAction",
    "rootPath",
    "repositoryUrl",
    "aliases",
    "importantFiles",
    "launchTargets",
    "sources",
    "missingItems",
    "tags",
    "suggestions",
    "recentActivity",
    "fieldProvenance",
    "attentionFlags",
    "lastActivityAt",
    "lastSyncedAt",
    "syncStatus",
    "pinned",
    "archived",
    "updatedAt"
  ];
  const jsonResponse = await request.get("/api/export/json");
  const json = await jsonResponse.json() as Array<Record<string, unknown>>;
  expect(jsonResponse.headers()["content-type"]).toContain("application/json");
  expect(json).toHaveLength(6);
  expect(new Set(json.map((project) => project.id)).size).toBe(6);
  const requiredExportFields = expectedExportFields.filter((field) => field !== "repositoryUrl");
  for (const project of json) {
    expect(Object.keys(project)).toEqual(expect.arrayContaining(requiredExportFields));
  }

  const markdownResponse = await request.get("/api/export/markdown");
  const markdown = await markdownResponse.text();
  expect(markdownResponse.headers()["content-type"]).toContain("text/markdown");
  expect(markdown.match(/^## /gmu)).toHaveLength(6);
  const markdownProjects = Array.from(
    markdown.matchAll(/```json\n([\s\S]*?)\n```/gmu),
    (match) => JSON.parse(match[1]) as Record<string, unknown>
  );
  expect(markdownProjects).toEqual(json);

  const csvResponse = await request.get("/api/export/csv");
  const csv = await csvResponse.text();
  expect(csvResponse.headers()["content-type"]).toContain("text/csv");
  expect(csv.split("\n", 1)[0].split(",")).toEqual(expectedExportFields);
  const exportedCsvPath = path.join(dataDir, "exported-projects.csv");
  await writeFile(exportedCsvPath, csv, "utf8");
  const csvPreviewResponse = await request.post("/api/import/preview", {
    data: {
      source: {
        kind: "structured-file",
        path: exportedCsvPath,
        format: "csv",
        label: "Export validation"
      }
    }
  });
  expect(csvPreviewResponse.ok()).toBe(true);
  const csvPreview = await csvPreviewResponse.json() as {
    preview: { rows: Array<{ action: string; candidate: Record<string, unknown> | null }> };
  };
  expect(csvPreview.preview.rows).toHaveLength(6);
  expect(csvPreview.preview.rows.every((row) => row.action !== "reject" && row.candidate)).toBe(true);
  expect(csvPreview.preview.rows.map((row) => row.candidate?.name)).toEqual(
    json.map((project) => project.name)
  );

  const restartPort = await getAvailablePort();
  const restartHmrPort = await getAvailablePort();
  const initialRegistry = JSON.parse(
    await readFile(path.join(restartDataDir, "projects.json"), "utf8")
  ) as Array<Record<string, unknown>>;
  let firstApp: ChildProcess | undefined;
  let secondApp: ChildProcess | undefined;

  try {
    firstApp = startApp(restartPort, restartHmrPort, restartDataDir);
    expect(firstApp.pid).toBeTruthy();
    const firstProjects = await waitForProjects(restartPort, firstApp);
    expect(firstProjects).toEqual(initialRegistry);
    await stopApp(firstApp);
    expect(firstApp.exitCode).not.toBeNull();
    firstApp = undefined;

    secondApp = startApp(restartPort, restartHmrPort, restartDataDir);
    expect(secondApp.pid).toBeTruthy();
    const secondProjects = await waitForProjects(restartPort, secondApp);
    expect(secondProjects).toEqual(firstProjects);
    expect(secondProjects).toEqual(json);
  } finally {
    if (secondApp) {
      await stopApp(secondApp);
    }
    if (firstApp) {
      await stopApp(firstApp);
    }
  }
});
