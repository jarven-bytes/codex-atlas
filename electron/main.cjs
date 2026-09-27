"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");

const APP_NAME = "Codex Atlas";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function appleScriptQuote(value) {
  return `"${String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n")}"`;
}

function createCodexSuggestionPrompt({
  projectName,
  projectPath,
  suggestionTitle,
  detail,
  currentValue,
  proposedValue
}) {
  return [
    `Implement the accepted project suggestion for ${projectName}.`,
    `Project path: ${projectPath}.`,
    `Suggestion: ${suggestionTitle}.`,
    `Why: ${detail}.`,
    `Current value: ${currentValue}.`,
    `Proposed value: ${proposedValue}.`,
    "Inspect the actual project files first, then implement the smallest correct change that fulfills the suggestion.",
    "Run focused tests or checks for the change. If the suggestion is ambiguous or unsafe, explain what is missing and ask before making a broad change."
  ].join(" ");
}

function resolveCodexCliPath(environment = process.env) {
  const candidates = [
    environment.CODEX_CLI_PATH,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    environment.HOME ? path.join(environment.HOME, ".local", "bin", "codex") : null
  ].filter(Boolean);

  const installedPath = candidates.find((candidate) => fs.existsSync(candidate));
  return installedPath ?? "codex";
}

function openCodexSuggestion(payload, options = {}) {
  const rawProjectPath = payload?.projectPath;
  const projectPath = typeof rawProjectPath === "string" && path.isAbsolute(rawProjectPath)
    ? path.resolve(rawProjectPath)
    : "";
  let isProjectDirectory = false;
  try {
    isProjectDirectory = Boolean(projectPath) && fs.statSync(projectPath).isDirectory();
  } catch {
    isProjectDirectory = false;
  }
  if (!isProjectDirectory) {
    return {
      opened: false,
      message: "The project folder is unavailable, so Codex could not be opened."
    };
  }

  if (typeof options.spawnProcess !== "function" && process.platform !== "darwin") {
    return {
      opened: false,
      message: "Opening Codex from the desktop app is currently supported on macOS."
    };
  }

  const prompt = createCodexSuggestionPrompt({
    projectName: payload.projectName,
    projectPath,
    suggestionTitle: payload.suggestionTitle,
    detail: payload.detail,
    currentValue: payload.currentValue,
    proposedValue: payload.proposedValue
  });
  const codexCliPath = options.codexCliPath ?? resolveCodexCliPath();
  const command = [codexCliPath, "--cd", projectPath, prompt]
    .map(shellQuote)
    .join(" ");
  const appleScript = [
    "tell application \"Terminal\"",
    "  activate",
    `  do script ${appleScriptQuote(command)}`,
    "end tell"
  ].join("\n");
  const spawnProcess = options.spawnProcess ?? spawn;
  const child = spawnProcess(options.osascriptPath ?? "/usr/bin/osascript", ["-e", appleScript], {
    detached: true,
    stdio: "ignore"
  });
  child.unref?.();

  return {
    opened: true,
    message: "Opened Codex in Terminal for this suggestion."
  };
}

function resolvePackagedDataDir(userDataPath) {
  return path.join(userDataPath, "data");
}

function resolveDesktopDataDir({ userDataPath, isPackaged, dataDirOverride }) {
  if (!isPackaged && typeof dataDirOverride === "string") {
    const trimmedOverride = dataDirOverride.trim();
    if (trimmedOverride) {
      return path.resolve(trimmedOverride);
    }
  }

  return resolvePackagedDataDir(userDataPath);
}

function hasExplicitUserDataDir(argv) {
  return argv.some((argument) => (
    argument === "--user-data-dir"
    || argument.startsWith("--user-data-dir=")
  ));
}

function preserveLegacyData({ legacyUserDataPath, userDataPath }) {
  if (path.resolve(legacyUserDataPath) === path.resolve(userDataPath)) {
    return;
  }

  const legacyDataPath = path.join(legacyUserDataPath, "data");
  const dataPath = path.join(userDataPath, "data");
  if (!fs.existsSync(legacyDataPath) || fs.existsSync(dataPath)) {
    return;
  }

  fs.mkdirSync(userDataPath, { recursive: true });
  fs.cpSync(legacyDataPath, dataPath, {
    recursive: true,
    errorOnExist: true,
    force: false
  });
}

function configureUserDataPath({ app, argv = process.argv }) {
  const currentUserDataPath = app.getPath("userData");
  if (hasExplicitUserDataDir(argv)) {
    return currentUserDataPath;
  }

  const userDataPath = path.join(app.getPath("appData"), APP_NAME);
  if (path.resolve(currentUserDataPath) !== path.resolve(userDataPath)) {
    app.setPath("userData", userDataPath);
    preserveLegacyData({
      legacyUserDataPath: currentUserDataPath,
      userDataPath
    });
  }

  return userDataPath;
}

function resolvePackagedRuntimePaths(entryDirectory = __dirname) {
  const runtimeRoot = path.resolve(entryDirectory, "..");
  return {
    runtimeRoot,
    clientDistDir: path.join(runtimeRoot, "dist", "client"),
    seedDataDir: path.join(runtimeRoot, "dist", "package-data"),
    serverEntryPath: path.join(runtimeRoot, "dist", "server", "app.js")
  };
}

function resolveDesktopRuntimePaths(entryDirectory = __dirname) {
  const runtimePaths = resolvePackagedRuntimePaths(entryDirectory);
  return {
    ...runtimePaths,
    seedDataDir: path.join(runtimePaths.runtimeRoot, "resources", "seed")
  };
}

function createBrowserWindowOptions(preloadPath) {
  return {
    width: 1440,
    height: 960,
    minWidth: 960,
    minHeight: 640,
    show: false,
    title: APP_NAME,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: preloadPath,
      sandbox: true,
      webSecurity: true
    }
  };
}

function isLoopbackHostname(hostname) {
  const normalizedHostname = hostname.toLowerCase();
  return normalizedHostname === "127.0.0.1"
    || normalizedHostname === "localhost"
    || normalizedHostname === "[::1]";
}

function isAllowedLoopbackNavigation(targetUrl, serverUrl) {
  try {
    const server = new URL(serverUrl);
    const target = new URL(targetUrl);
    return isLoopbackHostname(server.hostname)
      && (server.protocol === "http:" || server.protocol === "https:")
      && target.origin === server.origin
      && target.username === ""
      && target.password === "";
  } catch {
    return false;
  }
}

function installNavigationRestrictions(webContents, serverUrl, childWindowOptions) {
  const blockDisallowedNavigation = (event, targetUrl) => {
    if (!isAllowedLoopbackNavigation(targetUrl, serverUrl)) {
      event.preventDefault();
    }
  };

  webContents.on("will-navigate", blockDisallowedNavigation);
  webContents.on("will-redirect", blockDisallowedNavigation);

  webContents.setWindowOpenHandler(({ url }) => {
    if (!isAllowedLoopbackNavigation(url, serverUrl)) {
      return { action: "deny" };
    }

    return childWindowOptions
      ? {
          action: "allow",
          overrideBrowserWindowOptions: { ...childWindowOptions, show: true }
        }
      : { action: "allow" };
  });

  webContents.on("did-create-window", (childWindow) => {
    installNavigationRestrictions(childWindow.webContents, serverUrl, childWindowOptions);
  });
}

function createBeforeQuitHandler({ close, quit, onCloseError = console.error }) {
  let closing = false;
  let readyToQuit = false;

  return (event) => {
    if (readyToQuit) {
      return;
    }

    event.preventDefault();
    if (closing) {
      return;
    }

    closing = true;
    let closeResult;
    try {
      closeResult = close();
    } catch (error) {
      closeResult = Promise.reject(error);
    }

    void Promise.resolve(closeResult)
      .catch(onCloseError)
      .finally(() => {
        readyToQuit = true;
        quit();
      });
  };
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function handleStartupFailure({
  close,
  destroyWindow,
  error,
  showStartupDialog
}) {
  let cleanupError = null;
  try {
    await close();
  } catch (closeError) {
    cleanupError = closeError;
  }

  try {
    destroyWindow();
  } catch (windowError) {
    cleanupError ??= windowError;
  }

  const cleanupMessage = cleanupError
    ? `\n\nCleanup also failed: ${errorMessage(cleanupError)}`
    : "";

  const decision = await showStartupDialog({
    title: `${APP_NAME} could not start`,
    message: `${errorMessage(error)}${cleanupMessage}`
  });

  return cleanupError ? "quit" : decision;
}

async function startDesktopApplication({
  app,
  BrowserWindow,
  dialog,
  loadServerFactory,
  preloadPath = path.join(__dirname, "preload.cjs"),
  runtimeRoot,
  clientDistDir,
  seedDataDir
}) {
  let mainWindow = null;
  let server = null;
  let closePromise = null;
  let startupFailurePending = false;

  const closeServerOnce = () => {
    if (!server) {
      return Promise.resolve();
    }

    closePromise ??= server.close();
    return closePromise;
  };
  const beforeQuit = createBeforeQuitHandler({
    close: closeServerOnce,
    quit: () => app.quit(),
    onCloseError: (error) => console.error("[desktop] shutdown failed", error)
  });

  app.on("before-quit", beforeQuit);
  app.on("window-all-closed", () => {
    if (!startupFailurePending) {
      app.quit();
    }
  });

  await app.whenReady();

  while (true) {
    try {
      const createProjectManagementServer = await loadServerFactory();
      const dataDir = resolveDesktopDataDir({
        userDataPath: app.getPath("userData"),
        isPackaged: app.isPackaged === true,
        dataDirOverride: process.env.CODEX_PROJECT_DATA_DIR
      });
      const serverOptions = {
        host: "127.0.0.1",
        port: 0,
        dataDir,
        enableWorkspaceWatcher: true,
        enableClientWatcher: false
      };
      if (runtimeRoot) {
        serverOptions.runtimeRoot = runtimeRoot;
      }
      if (clientDistDir) {
        serverOptions.clientDistDir = clientDistDir;
      }
      if (seedDataDir) {
        serverOptions.seedDataDir = seedDataDir;
      }
      server = await createProjectManagementServer(serverOptions);

      if (!isAllowedLoopbackNavigation(server.url, server.url)) {
        throw new Error(`Server returned an unsafe URL: ${server.url}`);
      }

      const windowOptions = createBrowserWindowOptions(preloadPath);
      mainWindow = new BrowserWindow(windowOptions);
      installNavigationRestrictions(mainWindow.webContents, server.url, windowOptions);
      mainWindow.webContents.session.setPermissionRequestHandler(
        (_webContents, _permission, callback) => callback(false)
      );
      mainWindow.webContents.session.setPermissionCheckHandler(
        () => false
      );
      await mainWindow.loadURL(server.url);
      if (!mainWindow.isDestroyed()) {
        mainWindow.show();
      }

      return { server, window: mainWindow };
    } catch (error) {
      let decision;
      startupFailurePending = true;
      try {
        decision = await handleStartupFailure({
          close: closeServerOnce,
          destroyWindow: () => {
            if (mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.destroy();
            }
          },
          error,
          showStartupDialog: async ({ title, message }) => {
            const result = await dialog.showMessageBox({
              type: "error",
              title,
              message,
              buttons: ["Retry", "Quit"],
              defaultId: 0,
              cancelId: 1,
              noLink: true
            });
            return result.response === 0 ? "retry" : "quit";
          }
        });
      } catch (dialogError) {
        startupFailurePending = false;
        console.error("[desktop] startup failure dialog failed", dialogError);
        app.exit(1);
        return null;
      }
      startupFailurePending = false;

      if (decision !== "retry") {
        app.quit();
        return null;
      }

      mainWindow = null;
      server = null;
      closePromise = null;
    }
  }
}

module.exports = {
  configureUserDataPath,
  createBeforeQuitHandler,
  createBrowserWindowOptions,
  createCodexSuggestionPrompt,
  handleStartupFailure,
  installNavigationRestrictions,
  isAllowedLoopbackNavigation,
  openCodexSuggestion,
  resolveDesktopRuntimePaths,
  resolveDesktopDataDir,
  resolvePackagedDataDir,
  resolvePackagedRuntimePaths,
  resolveCodexCliPath,
  startDesktopApplication
};

if (require.main === module) {
  const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
  const { openFeedback } = require("./feedback.cjs");
  ipcMain.handle("feedback:open", (_event, kind) => openFeedback(kind, (url) => shell.openExternal(url)));
  ipcMain.handle("codex:open-suggestion", (_event, payload) => openCodexSuggestion(payload));
  configureUserDataPath({ app });
  const { serverEntryPath, ...runtimePaths } = app.isPackaged
    ? resolvePackagedRuntimePaths()
    : resolveDesktopRuntimePaths();

  void startDesktopApplication({
    app,
    BrowserWindow,
    dialog,
    loadServerFactory: async () => {
      const serverModule = await import(pathToFileURL(serverEntryPath).href);
      if (typeof serverModule.createProjectManagementServer !== "function") {
        throw new Error("Compiled server factory is unavailable.");
      }
      return serverModule.createProjectManagementServer;
    },
    ...runtimePaths
  }).catch((error) => {
    console.error("[desktop] fatal startup failure", error);
    app.exit(1);
  });
}
