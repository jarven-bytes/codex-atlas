import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { extractFile, listPackage } from "@electron/asar";
import { chromium, expect, test } from "playwright/test";
import {
  resolveDmgCleanupHandle,
  stopProcessesWithEscalation,
  type DmgCleanupHandle
} from "./desktop-smoke-helpers";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const packageMetadata = JSON.parse(
  readFileSync(path.join(projectRoot, "package.json"), "utf8")
) as { productName?: string; version: string };
const productName = packageMetadata.productName ?? "Codex Atlas";
const appPath = path.join(projectRoot, `release/mac/${productName}.app`);
const asarPath = path.join(appPath, "Contents/Resources/app.asar");
const dmgPath = path.join(projectRoot, `release/${productName}-${packageMetadata.version}.dmg`);
const hdiutilPath = "/usr/bin/hdiutil";
const openPath = "/usr/bin/open";

function packageAvailability(): { available: boolean; reason: string } {
  if (process.platform !== "darwin") {
    return { available: false, reason: "SKIP: packaged macOS artifact inspection requires macOS." };
  }

  if (!existsSync(appPath) || !existsSync(asarPath)) {
    return { available: false, reason: "SKIP: run npm run package:mac before the desktop smoke test." };
  }

  return { available: true, reason: "" };
}

function desktopAvailability(packageStatus: { available: boolean; reason: string }): { available: boolean; reason: string } {
  if (!packageStatus.available) {
    return packageStatus;
  }

  if (process.env.CI) {
    return { available: false, reason: "SKIP: desktop smoke requires an interactive macOS GUI session." };
  }

  if (!existsSync(openPath)) {
    return { available: false, reason: "SKIP: macOS open tooling is unavailable." };
  }

  try {
    execFileSync("launchctl", ["print", `gui/${process.getuid?.() ?? ""}`], { stdio: "ignore" });
  } catch {
    return { available: false, reason: "SKIP: macOS GUI launch session is unavailable." };
  }

  return { available: true, reason: "" };
}

function dmgAvailability(): { available: boolean; reason: string } {
  if (process.platform !== "darwin") {
    return { available: false, reason: "SKIP: DMG validation requires macOS." };
  }

  if (!existsSync(dmgPath)) {
    return { available: false, reason: "SKIP: run npm run package:mac before validating the DMG." };
  }

  if (!existsSync(hdiutilPath)) {
    return { available: false, reason: "SKIP: hdiutil is unavailable on this macOS host." };
  }

  return { available: true, reason: "" };
}

async function getAvailablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    throw new Error("Could not determine the temporary remote-debugging port.");
  }
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForPackagedPage(port: number) {
  const endpoint = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${endpoint}/json/list`);
      if (response.ok) {
        const targets = await response.json() as Array<{ type?: string }>;
        if (targets.some((target) => target.type === "page")) {
          const browser = await chromium.connectOverCDP(endpoint);
          const page = browser.contexts()
            .flatMap((context) => context.pages())
            .find((candidate) => candidate.url().startsWith("http://127.0.0.1:"));
          if (page) {
            return { browser, page };
          }
          await browser.close();
        }
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for packaged app window: ${String(lastError)}`);
}

function appProcessIds(userDataDir: string): number[] {
  try {
    const output = execFileSync("/usr/bin/pgrep", ["-f", userDataDir], { encoding: "utf8" });
    return output.split("\n").map((value) => Number(value.trim())).filter((value) => Number.isInteger(value) && value > 0);
  } catch {
    return [];
  }
}

async function stopPackagedApp(userDataDir: string): Promise<void> {
  await stopProcessesWithEscalation(
    () => appProcessIds(userDataDir),
    (pid, signal) => process.kill(pid, signal)
  );
}

async function waitForProcessExit(child: ChildProcess, processError?: () => Error | undefined): Promise<void> {
  const initialError = processError?.();
  if (initialError) {
    throw initialError;
  }
  if (child.exitCode !== null) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for macOS open to report app exit.")), 10_000);
    const onExit = () => {
      clearTimeout(timeout);
      resolve();
    };
    const onError = (error: Error) => {
      clearTimeout(timeout);
      reject(error);
    };
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

async function recordCleanupError(
  errors: unknown[],
  label: string,
  cleanup: () => void | Promise<void>
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    errors.push(new Error(`${label} failed.`, { cause: error }));
  }
}

function throwOriginalOrCleanupErrors(primaryError: unknown, cleanupErrors: unknown[]): never | void {
  if (primaryError) {
    for (const cleanupError of cleanupErrors) {
      console.error(cleanupError);
    }
    throw primaryError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Desktop smoke cleanup failed.");
  }
}

function hdiutilInfoForDmg(dmgFilePath: string): string {
  try {
    const info = execFileSync(hdiutilPath, ["info"], { encoding: "utf8" });
    return info.split("\n\n").find((block) => block.includes(dmgFilePath)) ?? "";
  } catch {
    return "";
  }
}

function hasDmgCleanupHandle(handle: DmgCleanupHandle): boolean {
  return Boolean(handle.device || handle.mountPoint);
}

function detachDmg(handle: DmgCleanupHandle): void {
  const targets = [...new Set([handle.device, handle.mountPoint].filter((target): target is string => Boolean(target)))];
  if (targets.length === 0) {
    throw new Error("Could not identify the attached DMG device or mount point for cleanup.");
  }

  const errors: unknown[] = [];
  for (const target of targets) {
    try {
      execFileSync(hdiutilPath, ["detach", target, "-force"], { stdio: "ignore" });
      return;
    } catch (error) {
      errors.push(error);
    }
  }
  throw new AggregateError(errors, "Could not detach the mounted DMG.");
}

test("electron-builder configures an unsigned app.asar macOS package", () => {
  const config = readFileSync(path.join(projectRoot, "electron-builder.yml"), "utf8");
  expect(config).toContain("appId: com.codex.atlas");
  expect(config).toContain("productName: Codex Atlas");
  expect(config).toContain("asar: true");
  expect(config).toContain("output: release");
  expect(config).toContain("identity: null");
  expect(config).toContain("entitlements: build/entitlements.mac.plist");
  expect(config).toContain("afterPack: scripts/after-pack.cjs");
  expect(config).toContain("- dist/server/**/*");
  expect(config).toContain("- dist/package-data/**/*");
  expect(config).toContain('"!**/*.map"');
  expect(config).toContain('"!tests{,/**/*}"');
});

test("electron-builder keeps the compiled desktop runtime in app.asar", () => {
  const packagedArtifact = packageAvailability();
  test.skip(!packagedArtifact.available, packagedArtifact.reason);

  const files = listPackage(asarPath).map((file) => file.replace(/^\/+/, ""));
  expect(files).toContain("electron/main.cjs");
  expect(files).toContain("electron/preload.cjs");
  expect(files).toContain("dist/client/index.html");
  expect(files).toContain("dist/server/app.js");
  expect(files).toContain("dist/package-data/projects.json");
  expect(files).toContain("dist/package-data/import-mappings.json");
  const packagedSeed = extractFile(asarPath, "dist/package-data/projects.json").toString("utf8");
  expect(JSON.parse(packagedSeed)).toEqual([]);
  expect(packagedSeed).not.toContain("/Users/");
  expect(files.some((file) => file.endsWith(".map"))).toBe(false);
  expect(files.some((file) => file.startsWith("tests/"))).toBe(false);
  expect(files.some((file) => file.startsWith("src/"))).toBe(false);
  expect(files.some((file) => file.includes("data/history/"))).toBe(false);
  expect(files).not.toContain("data/launch-trust.json");
  expect(files).not.toContain("data/sync-reviews.json");
  const textFilesWithAbsoluteUserPaths: string[] = [];
  for (const file of files) {
    if (!/\.(css|html|js|json|txt)$/u.test(file)) {
      continue;
    }
    try {
      if (extractFile(asarPath, file).toString("utf8").includes("/Users/")) {
        textFilesWithAbsoluteUserPaths.push(file);
      }
    } catch {
      // listPackage also returns directory entries.
    }
  }
  expect(textFilesWithAbsoluteUserPaths).toEqual([]);
  for (const developmentPackage of ["vite", "electron-builder", "playwright", "tsx", "typescript"]) {
    expect(files.some((file) => file.startsWith(`node_modules/${developmentPackage}/`))).toBe(false);
  }

  const electronEntry = extractFile(asarPath, "electron/main.cjs").toString("utf8");
  expect(electronEntry).toContain('path.join(runtimeRoot, "dist", "server", "app.js")');
  expect(electronEntry).not.toContain("src/server/main.ts");
  expect(electronEntry).not.toContain("tsx");
});

test("packaged resource files are non-writable", () => {
  const packagedArtifact = packageAvailability();
  test.skip(!packagedArtifact.available, packagedArtifact.reason);

  for (const resourcePath of [
    asarPath,
    path.join(appPath, "Contents/Resources/icon.icns")
  ]) {
    expect(statSync(resourcePath).mode & 0o222, resourcePath).toBe(0);
  }
});

test("packaged desktop app opens through the .app bundle without a dev server", async () => {
  const desktop = desktopAvailability(packageAvailability());
  test.skip(!desktop.available, desktop.reason);

  const userDataDir = mkdtempSync(path.join(tmpdir(), "codex-project-command-center-"));
  let openProcess: ChildProcess | undefined;
  let openProcessError: Error | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connectOverCDP>> | undefined;
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];

  try {
    const remoteDebuggingPort = await getAvailablePort();
    openProcess = spawn(openPath, [
      "-n",
      "-W",
      appPath,
      "--args",
      `--user-data-dir=${userDataDir}`,
      `--remote-debugging-port=${remoteDebuggingPort}`
    ], { stdio: "ignore" });
    openProcess.once("error", (error) => {
      openProcessError = error;
    });
    const connected = await waitForPackagedPage(remoteDebuggingPort);
    browser = connected.browser;
    const window = connected.page;

    await expect(window).toHaveTitle("Codex Atlas");
    expect(await window.evaluate(() => typeof window.codexAtlas?.openFeedback)).toBe("function");
    await expect(window.getByRole("heading", { name: "Dashboard", exact: true })).toBeVisible();
    await expect(window.getByText("No active projects yet.")).toBeVisible();
    expect(new URL(window.url()).hostname).toBe("127.0.0.1");
    const projects = await window.evaluate(async () => {
      const response = await fetch("/api/projects");
      return response.json() as Promise<{ projects: Array<Record<string, unknown>> }>;
    });
    expect(projects.projects).toHaveLength(0);
  } catch (error) {
    primaryError = error;
  }

  await recordCleanupError(cleanupErrors, "Browser disconnect", async () => {
    await browser?.close();
  });
  await recordCleanupError(cleanupErrors, "Packaged app termination", async () => {
    await stopPackagedApp(userDataDir);
  });
  await recordCleanupError(cleanupErrors, "macOS open process exit", async () => {
    if (!openProcess) {
      return;
    }
    await waitForProcessExit(openProcess, () => openProcessError);
    if (openProcess.exitCode !== 0) {
      throw new Error(`macOS open exited with code ${openProcess.exitCode ?? "unknown"}.`);
    }
  });
  await recordCleanupError(cleanupErrors, "Temporary user-data cleanup", () => {
    rmSync(userDataDir, { recursive: true, force: true });
  });
  throwOriginalOrCleanupErrors(primaryError, cleanupErrors);
});

test("DMG exists, verifies, and contains the packaged app", async () => {
  const dmg = dmgAvailability();
  test.skip(!dmg.available, dmg.reason);

  expect(() => execFileSync(hdiutilPath, ["verify", dmgPath], { stdio: "pipe" })).not.toThrow();

  let cleanupHandle: DmgCleanupHandle = {};
  let primaryError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    let attachOutput = "";
    try {
      attachOutput = execFileSync(hdiutilPath, ["attach", "-readonly", "-nobrowse", dmgPath], { encoding: "utf8" });
    } catch (error) {
      const stdout = (error as { stdout?: Buffer | string }).stdout;
      attachOutput = stdout?.toString() ?? "";
      throw error;
    } finally {
      cleanupHandle = resolveDmgCleanupHandle(attachOutput, hdiutilInfoForDmg(dmgPath));
    }
    if (!hasDmgCleanupHandle(cleanupHandle)) {
      cleanupHandle = resolveDmgCleanupHandle(attachOutput, hdiutilInfoForDmg(dmgPath));
    }
    expect(cleanupHandle.mountPoint).toBeTruthy();
    expect(existsSync(path.join(cleanupHandle.mountPoint ?? "", `${productName}.app`))).toBe(true);
  } catch (error) {
    primaryError = error;
  }

  await recordCleanupError(cleanupErrors, "DMG detach", () => {
    if (!hasDmgCleanupHandle(cleanupHandle)) {
      cleanupHandle = resolveDmgCleanupHandle("", hdiutilInfoForDmg(dmgPath));
    }
    detachDmg(cleanupHandle);
  });
  throwOriginalOrCleanupErrors(primaryError, cleanupErrors);
});
