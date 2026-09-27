import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { LaunchCommand, LaunchTarget } from "../../shared/domain";
import { serverConfig } from "../config";
import { createProjectStore, type ProjectStore } from "../store/project-store";
import {
  createProcessManager,
  type ProcessManager
} from "./process-manager";

export interface LaunchValidation {
  enabled: boolean;
  reason?: string;
  launchArgs?: string[];
  command?: LaunchCommand;
  fingerprint?: string;
}

export interface LaunchApproval {
  fingerprint: string;
}

export type LaunchResult =
  | {
      status: "disabled";
      reason: string;
    }
  | {
      status: "launched";
      launchArgs: string[];
    }
  | {
      status: "approval-required";
      fingerprint: string;
    }
  | {
      status: "started";
      processId: string;
    };

export class LaunchError extends Error {
  code: "PROJECT_NOT_FOUND" | "TARGET_NOT_FOUND";

  constructor(code: LaunchError["code"], message: string) {
    super(message);
    this.name = "LaunchError";
    this.code = code;
  }
}

interface TrustFileContents {
  trustedFingerprints: string[];
  trustedImportedTargets: string[];
}

interface CreateLauncherServiceOptions {
  store?: ProjectStore;
  processManager?: ProcessManager;
  trustFilePath?: string;
  openCommand?: (command: string[]) => Promise<void>;
}

function isExistingDirectory(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isDirectory();
}

function isExistingFile(filePath: string): boolean {
  return existsSync(filePath) && statSync(filePath).isFile();
}

function buildTaskUrl(target: Extract<LaunchTarget, { kind: "task" }>): string {
  const workspaceQuery = target.workspace
    ? `?workspace=${encodeURIComponent(path.normalize(target.workspace))}`
    : "";
  return `codex://task/${encodeURIComponent(target.taskId)}${workspaceQuery}`;
}

function createCommandFingerprint(command: LaunchCommand): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        executable: command.executable,
        args: command.args,
        cwd: command.cwd
      })
    )
    .digest("hex");
}

function createImportedTargetTrustKey(
  projectId: string,
  targetId: string,
  fingerprint: string
): string {
  return `${projectId}:${targetId}:${fingerprint}`;
}

function isShellWrapperCommand(executable: string, args: string[]): boolean {
  const shellExecutables = new Set([
    "sh",
    "bash",
    "zsh",
    "fish",
    "cmd",
    "cmd.exe",
    "powershell",
    "powershell.exe",
    "pwsh",
    "pwsh.exe"
  ]);
  const shellModes = new Set(["-c", "-lc", "/c", "/C", "-command", "-Command"]);
  const normalizedExecutable = path.basename(executable).toLowerCase();

  return shellExecutables.has(normalizedExecutable) || args.some((arg) => shellModes.has(arg));
}

async function defaultOpenCommand(command: string[]): Promise<void> {
  const { spawn } = await import("node:child_process");

  await new Promise<void>((resolve, reject) => {
    const [executable, ...args] = command;
    const child = spawn(executable, args, {
      shell: false,
      stdio: "ignore"
    });

    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`open exited with code ${code ?? "unknown"}`));
    });
  });
}

export function createLauncherService(options: CreateLauncherServiceOptions = {}) {
  const store = options.store ?? createProjectStore();
  const processManager = options.processManager ?? createProcessManager();
  const trustFilePath =
    options.trustFilePath ??
    path.join(serverConfig.dataDir, "launch-trust.json");
  const openCommand = options.openCommand ?? defaultOpenCommand;

  async function readTrustFile(): Promise<TrustFileContents> {
    try {
      const raw = await readFile(trustFilePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<TrustFileContents>;
        return {
          trustedFingerprints: Array.isArray(parsed.trustedFingerprints)
            ? parsed.trustedFingerprints.filter((entry): entry is string => typeof entry === "string")
          : [],
        trustedImportedTargets: Array.isArray(parsed.trustedImportedTargets)
          ? parsed.trustedImportedTargets.filter((entry): entry is string => typeof entry === "string")
          : []
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {
          trustedFingerprints: [],
          trustedImportedTargets: []
        };
      }

      throw error;
    }
  }

  async function writeTrustFile(contents: TrustFileContents): Promise<void> {
    await mkdir(path.dirname(trustFilePath), { recursive: true });
    await writeFile(trustFilePath, `${JSON.stringify(contents, null, 2)}\n`, "utf8");
  }

  function validateLaunchTarget(target: LaunchTarget): LaunchValidation {
    switch (target.kind) {
      case "url":
        try {
          const url = new URL(target.url);
          return {
            enabled: true,
            launchArgs: [url.toString()]
          };
        } catch {
          return {
            enabled: false,
            reason: "Invalid URL."
          };
        }
      case "folder":
        return isExistingDirectory(target.path)
          ? {
              enabled: true,
              launchArgs: [target.path]
            }
          : {
              enabled: false,
              reason: "Folder does not exist."
            };
      case "document":
        return isExistingFile(target.path)
          ? {
              enabled: true,
              launchArgs: [target.page ? `${target.path}#page=${target.page}` : target.path]
            }
          : {
              enabled: false,
              reason: "Document does not exist."
            };
      case "task":
        if (target.workspace && !isExistingDirectory(target.workspace)) {
          return {
            enabled: false,
            reason: "Task workspace does not exist."
          };
        }

        return {
          enabled: true,
          launchArgs: [buildTaskUrl(target)]
        };
      case "command": {
        if (!target.executable.trim()) {
          return {
            enabled: false,
            reason: "Command executable is required."
          };
        }

        if (isShellWrapperCommand(target.executable, target.args)) {
          return {
            enabled: false,
            reason: "Shell wrapper commands are not allowed."
          };
        }

        if (!isExistingDirectory(target.cwd)) {
          return {
            enabled: false,
            reason: "Command working directory does not exist."
          };
        }

        if (!target.args.every((entry) => typeof entry === "string")) {
          return {
            enabled: false,
            reason: "Command arguments must be strings."
          };
        }

        if (
          target.port !== undefined &&
          (!Number.isInteger(target.port) || target.port < 1 || target.port > 65_535)
        ) {
          return {
            enabled: false,
            reason: "Command port must be a valid local TCP port."
          };
        }

        const command: LaunchCommand = {
          executable: target.executable,
          args: target.args,
          cwd: target.cwd,
          ...(target.port !== undefined ? { port: target.port } : {})
        };
        return {
          enabled: true,
          command,
          fingerprint: createCommandFingerprint(command)
        };
      }
    }
  }

  async function openValidatedTarget(target: Exclude<LaunchTarget, { kind: "command" }>): Promise<LaunchResult> {
    const validation = validateLaunchTarget(target);
    if (!validation.enabled || !validation.launchArgs) {
      return {
        status: "disabled",
        reason: validation.reason ?? "Target is disabled."
      };
    }

    await openCommand(["/usr/bin/open", ...validation.launchArgs]);
    return {
      status: "launched",
      launchArgs: validation.launchArgs
    };
  }

  async function launchTarget(
    projectId: string,
    targetId: string,
    approval?: LaunchApproval
  ): Promise<LaunchResult> {
    const project = await store.get(projectId);
    if (!project) {
      throw new LaunchError("PROJECT_NOT_FOUND", `Unknown project: ${projectId}`);
    }

    const target = project.launchTargets.find((entry) => entry.id === targetId);
    if (!target) {
      throw new LaunchError(
        "TARGET_NOT_FOUND",
        `Unknown launch target: ${projectId}/${targetId}`
      );
    }

    const validation = validateLaunchTarget(target);
    if (!validation.enabled) {
      return {
        status: "disabled",
        reason: validation.reason ?? "Target is disabled."
      };
    }

    if (target.kind !== "command") {
      return openValidatedTarget(target);
    }

    const trust = await readTrustFile();
    const fingerprint = validation.fingerprint!;
    const requiresTargetScopedTrust = target.origin === "imported";
    const importedTrustKey = createImportedTargetTrustKey(projectId, targetId, fingerprint);
    const isTrusted = requiresTargetScopedTrust
      ? trust.trustedImportedTargets.includes(importedTrustKey)
      : trust.trustedFingerprints.includes(fingerprint);

    if (!isTrusted) {
      if (!approval || approval.fingerprint !== fingerprint) {
        return {
          status: "approval-required",
          fingerprint
        };
      }

      if (requiresTargetScopedTrust) {
        trust.trustedImportedTargets.push(importedTrustKey);
      } else {
        trust.trustedFingerprints.push(fingerprint);
      }
      await writeTrustFile(trust);
    }

    const processState = await processManager.startProcess(validation.command!);
    return {
      status: "started",
      processId: processState.processId
    };
  }

  return {
    validateLaunchTarget,
    openValidatedTarget,
    launchTarget
  };
}

const defaultLauncher = createLauncherService();

export const validateLaunchTarget = defaultLauncher.validateLaunchTarget;
export const launchTarget = defaultLauncher.launchTarget;
