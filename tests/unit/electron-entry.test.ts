// @vitest-environment node

import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, test, vi } from "vitest";

interface NavigationEvent {
  preventDefault: () => void;
}

interface ElectronEntry {
  createBeforeQuitHandler: (options: {
    close: () => Promise<void>;
    quit: () => void;
    onCloseError?: (error: unknown) => void;
  }) => (event: NavigationEvent) => void;
  createBrowserWindowOptions: (preloadPath: string) => {
    webPreferences: Record<string, unknown>;
  };
  createCodexSuggestionPrompt: (payload: {
    projectName: string;
    projectPath: string;
    suggestionTitle: string;
    detail: string;
    currentValue: string;
    proposedValue: string;
  }) => string;
  configureUserDataPath: (options: {
    app: {
      getPath: (name: string) => string;
      setPath: (name: string, value: string) => void;
    };
    argv?: string[];
  }) => string;
  installNavigationRestrictions: (
    webContents: {
      on: (event: string, handler: (...args: unknown[]) => void) => void;
      setWindowOpenHandler: (
        handler: (details: { url: string }) => { action: "allow" | "deny" }
      ) => void;
    },
    serverUrl: string
  ) => void;
  handleStartupFailure: (options: {
    close: () => Promise<void>;
    destroyWindow: () => void;
    error: unknown;
    showStartupDialog: (options: { title: string; message: string }) => Promise<"retry" | "quit">;
  }) => Promise<"retry" | "quit">;
  isAllowedLoopbackNavigation: (targetUrl: string, serverUrl: string) => boolean;
  openCodexSuggestion: (payload: {
    projectPath: string;
    projectName: string;
    suggestionTitle: string;
    detail: string;
    currentValue: string;
    proposedValue: string;
  }, options?: {
    codexCliPath?: string;
    osascriptPath?: string;
    spawnProcess?: (...args: unknown[]) => { unref?: () => void };
  }) => { opened: boolean; message: string };
  resolvePackagedDataDir: (userDataPath: string) => string;
  resolveDesktopDataDir: (options: {
    userDataPath: string;
    isPackaged: boolean;
    dataDirOverride?: string;
  }) => string;
  resolvePackagedRuntimePaths: (entryDirectory: string) => {
    runtimeRoot: string;
    clientDistDir: string;
    seedDataDir: string;
    serverEntryPath: string;
  };
  resolveDesktopRuntimePaths: (entryDirectory: string) => {
    runtimeRoot: string;
    clientDistDir: string;
    seedDataDir: string;
    serverEntryPath: string;
  };
  startDesktopApplication: (options: Record<string, unknown>) => Promise<unknown>;
}

const require = createRequire(import.meta.url);

function loadElectronEntry(): ElectronEntry {
  return require("../../electron/main.cjs") as ElectronEntry;
}

describe("Electron desktop entry", () => {
  test("resolves an installed Electron runtime without opening a GUI session", () => {
    const electronBinary = require("electron") as string;

    expect(path.isAbsolute(electronBinary)).toBe(true);
    expect(existsSync(electronBinary)).toBe(true);
  });

  test("places packaged writable data below Electron's userData directory", () => {
    const { resolvePackagedDataDir } = loadElectronEntry();

    expect(resolvePackagedDataDir("/tmp/Codex Project Command Center")).toBe(
      path.join("/tmp/Codex Project Command Center", "data")
    );
  });

  test("sets the canonical userData path before startup and preserves legacy data", () => {
    const { configureUserDataPath } = loadElectronEntry();
    const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "electron-user-data-path-"));
    const legacyUserDataPath = path.join(temporaryRoot, "project-management-system");
    const canonicalUserDataPath = path.join(
      temporaryRoot,
      "Library",
      "Application Support",
      "Codex Atlas"
    );
    const legacyDataPath = path.join(legacyUserDataPath, "data");
    const legacyRegistry = "[{\"id\":\"legacy-project\"}]\n";
    mkdirSync(legacyDataPath, { recursive: true });
    writeFileSync(path.join(legacyDataPath, "projects.json"), legacyRegistry, "utf8");
    const setPath = vi.fn();

    try {
      const resolvedUserDataPath = configureUserDataPath({
        app: {
          getPath(name) {
            return name === "userData"
              ? legacyUserDataPath
              : path.join(temporaryRoot, "Library", "Application Support");
          },
          setPath
        },
        argv: ["electron", "electron/main.cjs"]
      });

      expect(resolvedUserDataPath).toBe(canonicalUserDataPath);
      expect(setPath).toHaveBeenCalledWith("userData", canonicalUserDataPath);
      expect(readFileSync(path.join(canonicalUserDataPath, "data", "projects.json"), "utf8"))
        .toBe(legacyRegistry);
    } finally {
      rmSync(temporaryRoot, { recursive: true, force: true });
    }
  });

  test("leaves an explicit Electron user-data-dir override untouched", () => {
    const { configureUserDataPath } = loadElectronEntry();
    const userDataPath = "/tmp/isolated-electron-user-data";
    const setPath = vi.fn();

    expect(configureUserDataPath({
      app: {
        getPath(name) {
          return name === "userData" ? userDataPath : "/tmp/Application Support";
        },
        setPath
      },
      argv: ["electron", "electron/main.cjs", "--user-data-dir=/tmp/isolated-electron-user-data"]
    })).toBe(userDataPath);
    expect(setPath).not.toHaveBeenCalled();
  });

  test("uses a resolved CODEX_PROJECT_DATA_DIR only for desktop development", () => {
    const { resolveDesktopDataDir } = loadElectronEntry();
    const userDataPath = "/tmp/Codex Project Command Center";
    const override = "/tmp/codex-project-command-center-dev";

    expect(resolveDesktopDataDir({
      userDataPath,
      isPackaged: false,
      dataDirOverride: `  ${override}  `
    })).toBe(path.resolve(override));
    expect(resolveDesktopDataDir({
      userDataPath,
      isPackaged: false,
      dataDirOverride: "   "
    })).toBe(path.join(userDataPath, "data"));
    expect(resolveDesktopDataDir({
      userDataPath,
      isPackaged: true,
      dataDirOverride: override
    })).toBe(path.join(userDataPath, "data"));
  });

  test("derives packaged assets from the Electron entry payload root", () => {
    const { resolvePackagedRuntimePaths } = loadElectronEntry();
    const paths = resolvePackagedRuntimePaths("/tmp/Codex Project Command Center.app/Contents/Resources/app.asar/electron");

    expect(paths).toEqual({
      runtimeRoot: "/tmp/Codex Project Command Center.app/Contents/Resources/app.asar",
      clientDistDir: "/tmp/Codex Project Command Center.app/Contents/Resources/app.asar/dist/client",
      seedDataDir: "/tmp/Codex Project Command Center.app/Contents/Resources/app.asar/dist/package-data",
      serverEntryPath: "/tmp/Codex Project Command Center.app/Contents/Resources/app.asar/dist/server/app.js"
    });
  });

  test("keeps the committed seed directory for desktop development", () => {
    const { resolveDesktopRuntimePaths } = loadElectronEntry();
    const paths = resolveDesktopRuntimePaths("/tmp/project-management-system/electron");

    expect(paths.seedDataDir).toBe("/tmp/project-management-system/resources/seed");
  });

  test("isolates and sandboxes the renderer without Node access", () => {
    const { createBrowserWindowOptions } = loadElectronEntry();

    expect(createBrowserWindowOptions("/app/electron/preload.cjs").webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      preload: "/app/electron/preload.cjs",
      sandbox: true,
      webSecurity: true
    });
  });

  test("opens an interactive Codex session for an accepted suggestion", () => {
    const { createCodexSuggestionPrompt, openCodexSuggestion } = loadElectronEntry();
    const projectPath = mkdtempSync(path.join(os.tmpdir(), "codex-suggestion-project-"));
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));

    try {
      const prompt = createCodexSuggestionPrompt({
        projectName: "Example Project",
        projectPath,
        suggestionTitle: "Clarify user need",
        detail: "The current record is missing the target user.",
        currentValue: "Unknown",
        proposedValue: "A local developer who needs a reliable project overview."
      });
      const result = openCodexSuggestion({
        projectPath,
        projectName: "Example Project",
        suggestionTitle: "Clarify user need",
        detail: "The current record is missing the target user.",
        currentValue: "Unknown",
        proposedValue: "A local developer who needs a reliable project overview."
      }, {
        codexCliPath: "/Applications/ChatGPT.app/Contents/Resources/codex",
        osascriptPath: "/usr/bin/osascript",
        spawnProcess
      });

      expect(prompt).toContain("Implement the accepted project suggestion for Example Project.");
      expect(result).toEqual({
        opened: true,
        message: "Opened Codex in Terminal for this suggestion."
      });
      expect(spawnProcess).toHaveBeenCalledWith(
        "/usr/bin/osascript",
        ["-e", expect.stringContaining("Example Project")],
        { detached: true, stdio: "ignore" }
      );
      expect(unref).toHaveBeenCalledOnce();
    } finally {
      rmSync(projectPath, { recursive: true, force: true });
    }
  });

  test("does not launch Codex when the project folder is unavailable", () => {
    const { openCodexSuggestion } = loadElectronEntry();
    const spawnProcess = vi.fn();

    const result = openCodexSuggestion({
      projectPath: "/tmp/does-not-exist-codex-project",
      projectName: "Missing Project",
      suggestionTitle: "Update the plan",
      detail: "The plan is incomplete.",
      currentValue: "Missing",
      proposedValue: "Add milestones"
    }, { spawnProcess });

    expect(result.opened).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  test("allows only same-origin loopback navigation", () => {
    const { isAllowedLoopbackNavigation } = loadElectronEntry();
    const serverUrl = "http://127.0.0.1:43123";

    expect(isAllowedLoopbackNavigation(`${serverUrl}/projects?status=active`, serverUrl)).toBe(true);
    expect(isAllowedLoopbackNavigation("http://127.0.0.1:43124/projects", serverUrl)).toBe(false);
    expect(isAllowedLoopbackNavigation("https://127.0.0.1:43123/projects", serverUrl)).toBe(false);
    expect(isAllowedLoopbackNavigation("https://example.com", serverUrl)).toBe(false);
    expect(isAllowedLoopbackNavigation("not a url", serverUrl)).toBe(false);
  });

  test("blocks loopback document redirects to external origins", () => {
    const { installNavigationRestrictions } = loadElectronEntry();
    let willNavigate: ((event: NavigationEvent, url: string) => void) | undefined;
    let willRedirect: ((event: NavigationEvent, url: string) => void) | undefined;
    let openWindow: ((details: { url: string }) => { action: "allow" | "deny" }) | undefined;
    const webContents = {
      on(event: string, handler: (...args: unknown[]) => void) {
        if (event === "will-navigate") {
          willNavigate = handler as (event: NavigationEvent, url: string) => void;
        }
        if (event === "will-redirect") {
          willRedirect = handler as (event: NavigationEvent, url: string) => void;
        }
      },
      setWindowOpenHandler(
        handler: (details: { url: string }) => { action: "allow" | "deny" }
      ) {
        openWindow = handler;
      }
    };
    installNavigationRestrictions(webContents, "http://127.0.0.1:43123");
    const preventDefault = vi.fn();

    willNavigate?.({ preventDefault }, "https://example.com");
    willRedirect?.({ preventDefault }, "https://example.com/redirected");

    expect(preventDefault).toHaveBeenCalledTimes(2);
    const allowedRedirectPreventDefault = vi.fn();
    willRedirect?.(
      { preventDefault: allowedRedirectPreventDefault },
      "http://127.0.0.1:43123/redirected"
    );
    expect(allowedRedirectPreventDefault).not.toHaveBeenCalled();
    expect(openWindow?.({ url: "https://example.com" })).toEqual({ action: "deny" });
    expect(openWindow?.({ url: "http://127.0.0.1:43123/project/one" })).toEqual({
      action: "allow"
    });
  });

  test("closes the server once before allowing Electron to quit", async () => {
    const { createBeforeQuitHandler } = loadElectronEntry();
    let releaseClose!: () => void;
    const close = vi.fn(() => new Promise<void>((resolve) => {
      releaseClose = resolve;
    }));
    const quit = vi.fn();
    const handler = createBeforeQuitHandler({ close, quit });
    const firstEvent = { preventDefault: vi.fn() };
    const secondEvent = { preventDefault: vi.fn() };

    handler(firstEvent);
    handler(secondEvent);

    expect(close).toHaveBeenCalledOnce();
    expect(firstEvent.preventDefault).toHaveBeenCalledOnce();
    expect(secondEvent.preventDefault).toHaveBeenCalledOnce();
    expect(quit).not.toHaveBeenCalled();

    releaseClose();
    await vi.waitFor(() => expect(quit).toHaveBeenCalledOnce());

    const finalEvent = { preventDefault: vi.fn() };
    handler(finalEvent);
    expect(finalEvent.preventDefault).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  test("cleans up a partial startup before showing the native failure dialog", async () => {
    const { handleStartupFailure } = loadElectronEntry();
    const actions: string[] = [];

    const decision = await handleStartupFailure({
      close: async () => {
        actions.push("close-server");
      },
      destroyWindow: () => {
        actions.push("destroy-window");
      },
      error: new Error("database unavailable"),
      showStartupDialog: async ({ title, message }) => {
        actions.push(`dialog:${title}:${message}`);
        return "retry";
      }
    });

    expect(decision).toBe("retry");
    expect(actions).toEqual([
      "close-server",
      "destroy-window",
      "dialog:Codex Atlas could not start:database unavailable"
    ]);
  });

  test("starts the Task 1 factory on an ephemeral loopback port before showing the window", async () => {
    const { startDesktopApplication } = loadElectronEntry();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    let requestedAppPath = "";
    let serverOptions: Record<string, unknown> | undefined;
    let loadedUrl = "";
    let shown = false;
    let permissionHandlerInstalled = false;
    let permissionCheckHandlerInstalled = false;
    let permissionRequestHandler: ((...args: unknown[]) => void) | undefined;
    let permissionCheckHandler: ((...args: unknown[]) => boolean) | undefined;
    const server = {
      url: "http://127.0.0.1:43123",
      close: async () => undefined
    };
    const app = {
      isPackaged: true,
      getPath(name: string) {
        requestedAppPath = name;
        return "/tmp/Codex Project Command Center";
      },
      on(name: string, handler: (...args: unknown[]) => void) {
        handlers.set(name, handler);
      },
      quit() {},
      async whenReady() {}
    };
    class BrowserWindow {
      webContents = {
        on() {},
        session: {
          setPermissionRequestHandler(handler: (...args: unknown[]) => void) {
            permissionHandlerInstalled = true;
            permissionRequestHandler = handler;
          },
          setPermissionCheckHandler(handler: (...args: unknown[]) => boolean) {
            permissionCheckHandlerInstalled = true;
            permissionCheckHandler = handler;
          }
        },
        setWindowOpenHandler() {}
      };

      destroy() {}

      isDestroyed() {
        return false;
      }

      async loadURL(url: string) {
        loadedUrl = url;
      }

      show() {
        shown = true;
      }
    }

    await startDesktopApplication({
      app,
      BrowserWindow,
      dialog: { showErrorBox() {} },
      loadServerFactory: async () => async (options: Record<string, unknown>) => {
        serverOptions = options;
        return server;
      },
      preloadPath: "/app/electron/preload.cjs"
    });

    expect(requestedAppPath).toBe("userData");
    expect(serverOptions).toEqual({
      host: "127.0.0.1",
      port: 0,
      dataDir: path.join("/tmp/Codex Project Command Center", "data"),
      enableWorkspaceWatcher: true,
      enableClientWatcher: false
    });
    expect(loadedUrl).toBe(server.url);
    expect(permissionHandlerInstalled).toBe(true);
    expect(permissionCheckHandlerInstalled).toBe(true);
    const permissionCallback = vi.fn();
    permissionRequestHandler?.({}, "notifications", permissionCallback);
    expect(permissionCallback).toHaveBeenCalledWith(false);
    expect(permissionCheckHandler?.({}, "notifications", "http://example.com", {})).toBe(false);
    expect(shown).toBe(true);
    expect(handlers.has("before-quit")).toBe(true);
    expect(handlers.has("window-all-closed")).toBe(true);
  });

  test("passes CODEX_PROJECT_DATA_DIR to the server during desktop development", async () => {
    const { startDesktopApplication } = loadElectronEntry();
    const originalOverride = process.env.CODEX_PROJECT_DATA_DIR;
    const override = "/tmp/codex-project-command-center-desktop-dev";
    process.env.CODEX_PROJECT_DATA_DIR = `  ${override}  `;
    let serverOptions: Record<string, unknown> | undefined;

    const app = {
      isPackaged: false,
      getPath: () => "/tmp/Codex Project Command Center",
      on: () => undefined,
      quit: () => undefined,
      async whenReady() {}
    };
    const server = {
      url: "http://127.0.0.1:43124",
      close: async () => undefined
    };
    class BrowserWindow {
      webContents = {
        on() {},
        session: {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {}
        },
        setWindowOpenHandler() {}
      };

      isDestroyed() {
        return false;
      }

      async loadURL() {}

      show() {}
    }

    try {
      await startDesktopApplication({
        app,
        BrowserWindow,
        dialog: { showMessageBox: async () => ({ response: 1 }) },
        loadServerFactory: async () => async (options: Record<string, unknown>) => {
          serverOptions = options;
          return server;
        }
      });
    } finally {
      if (originalOverride === undefined) {
        delete process.env.CODEX_PROJECT_DATA_DIR;
      } else {
        process.env.CODEX_PROJECT_DATA_DIR = originalOverride;
      }
    }

    expect(serverOptions?.dataDir).toBe(path.resolve(override));
  });

  test("rejects an unsafe initial server URL before calling loadURL", async () => {
    const { startDesktopApplication } = loadElectronEntry();
    let loadCalls = 0;
    let closeCalls = 0;
    let quitCalls = 0;
    let dialogOptions: Record<string, unknown> | undefined;
    const app = {
      getPath: () => "/tmp/Codex Project Command Center",
      on: () => undefined,
      quit: () => {
        quitCalls += 1;
      },
      async whenReady() {}
    };
    class BrowserWindow {
      webContents = {
        on() {},
        session: {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {}
        },
        setWindowOpenHandler() {}
      };

      destroy() {}

      isDestroyed() {
        return false;
      }

      async loadURL() {
        loadCalls += 1;
      }

      show() {}
    }

    await startDesktopApplication({
      app,
      BrowserWindow,
      dialog: {
        async showMessageBox(options: Record<string, unknown>) {
          dialogOptions = options;
          return { response: 1 };
        }
      },
      loadServerFactory: async () => async () => ({
        url: "https://example.com/not-loopback",
        close: async () => {
          closeCalls += 1;
        }
      })
    });

    expect(loadCalls).toBe(0);
    expect(closeCalls).toBe(1);
    expect(quitCalls).toBe(1);
    expect(dialogOptions).toMatchObject({
      buttons: ["Retry", "Quit"],
      cancelId: 1,
      defaultId: 0,
      type: "error"
    });
  });

  test("retries startup after cleanup when the native dialog chooses Retry", async () => {
    const { startDesktopApplication } = loadElectronEntry();
    let factoryAttempts = 0;
    let firstServerCloseCalls = 0;
    let quitCalls = 0;
    const dialogOptions: Array<Record<string, unknown>> = [];
    const handlers = new Map<string, () => void>();
    let resolveDialog!: (result: { response: number }) => void;
    let dialogShown!: () => void;
    const dialogReady = new Promise<void>((resolve) => {
      dialogShown = resolve;
    });
    const windows: Array<{ destroyed: boolean; shown: boolean }> = [];
    const app = {
      getPath: () => "/tmp/Codex Project Command Center",
      on: (name: string, handler: () => void) => {
        handlers.set(name, handler);
      },
      quit: () => {
        quitCalls += 1;
      },
      async whenReady() {}
    };
    class BrowserWindow {
      destroyed = false;
      shown = false;
      webContents = {
        on() {},
        session: {
          setPermissionRequestHandler() {},
          setPermissionCheckHandler() {}
        },
        setWindowOpenHandler() {}
      };

      constructor() {
        windows.push(this);
      }

      destroy() {
        this.destroyed = true;
      }

      isDestroyed() {
        return this.destroyed;
      }

      async loadURL() {
        if (windows.length === 1) {
          throw new Error("first window failed");
        }
      }

      show() {
        this.shown = true;
      }
    }

    const startupPromise = startDesktopApplication({
      app,
      BrowserWindow,
      dialog: {
        async showMessageBox(options: Record<string, unknown>) {
          dialogOptions.push(options);
          dialogShown();
          return new Promise<{ response: number }>((resolve) => {
            resolveDialog = resolve;
          });
        }
      },
      loadServerFactory: async () => async () => {
        factoryAttempts += 1;
        return {
          url: `http://127.0.0.1:${43123 + factoryAttempts}`,
          close: async () => {
            if (factoryAttempts === 1) {
              firstServerCloseCalls += 1;
            }
          }
        };
      }
    });

    await dialogReady;
    handlers.get("window-all-closed")?.();
    expect(quitCalls).toBe(0);
    resolveDialog({ response: 0 });
    const result = await startupPromise;

    expect(factoryAttempts).toBe(2);
    expect(firstServerCloseCalls).toBe(1);
    expect(windows).toHaveLength(2);
    expect(windows[0].destroyed).toBe(true);
    expect(windows[1].shown).toBe(true);
    expect(dialogOptions[0]).toMatchObject({ buttons: ["Retry", "Quit"] });
    expect(quitCalls).toBe(0);
    expect(result).toBeTruthy();
  });
});
