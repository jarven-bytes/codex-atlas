import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import net from "node:net";
import type { LaunchCommand } from "../../shared/domain";

export type ProcessStatus = "Starting" | "Running" | "Failed" | "Stopped";

export interface ProcessState {
  processId: string;
  status: ProcessStatus;
  command: LaunchCommand;
  stdout: string;
  stderr: string;
  startedAt: string;
  exitCode?: number | null;
  endedAt?: string;
}

export class LaunchProcessError extends Error {
  code: "PROCESS_NOT_FOUND" | "PROCESS_SPAWN_FAILED" | "PROCESS_PORT_TIMEOUT";

  constructor(
    code: LaunchProcessError["code"],
    message: string
  ) {
    super(message);
    this.name = "LaunchProcessError";
    this.code = code;
  }
}

interface ManagedProcess {
  child: ChildProcess;
  state: ProcessState;
  stopRequested: boolean;
  cleanupTimer?: NodeJS.Timeout;
}

interface CreateProcessManagerOptions {
  openCommand?: (command: string[]) => Promise<void>;
  outputLimit?: number;
  readinessPollIntervalMs?: number;
  readinessTimeoutMs?: number;
  completedProcessTtlMs?: number;
  waitForPort?: (port: number) => Promise<void>;
  spawnProcess?: (
    executable: string,
    args: string[],
    options: SpawnOptions
  ) => ChildProcess;
}

export interface ProcessManager {
  startProcess(command: LaunchCommand): Promise<ProcessState>;
  stopProcess(processId: string): Promise<ProcessState>;
  getProcessState(processId: string): ProcessState;
  shutdown(): Promise<void>;
}

const defaultOutputLimit = 8_192;
const defaultReadinessPollIntervalMs = 100;
const defaultReadinessTimeoutMs = 15_000;

function boundedAppend(current: string, chunk: string, limit: number): string {
  const combined = `${current}${chunk}`;
  return combined.length <= limit ? combined : combined.slice(-limit);
}

async function defaultOpenCommand(command: string[]): Promise<void> {
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

async function waitForLocalPort(
  port: number,
  pollIntervalMs: number,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const ready = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolve(true);
      });
      socket.once("error", () => {
        resolve(false);
      });
    });

    if (ready) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new LaunchProcessError(
    "PROCESS_PORT_TIMEOUT",
    `Timed out waiting for local port ${port}.`
  );
}

export function createProcessManager(options: CreateProcessManagerOptions = {}): ProcessManager {
  const openCommand = options.openCommand ?? defaultOpenCommand;
  const outputLimit = options.outputLimit ?? defaultOutputLimit;
  const readinessPollIntervalMs =
    options.readinessPollIntervalMs ?? defaultReadinessPollIntervalMs;
  const readinessTimeoutMs = options.readinessTimeoutMs ?? defaultReadinessTimeoutMs;
  const completedProcessTtlMs = options.completedProcessTtlMs ?? 60_000;
  const waitForPort = options.waitForPort ?? ((port: number) =>
    waitForLocalPort(port, readinessPollIntervalMs, readinessTimeoutMs));
  const spawnProcess = options.spawnProcess ?? spawn;
  const processes = new Map<string, ManagedProcess>();

  function requireProcess(processId: string): ManagedProcess {
    const managed = processes.get(processId);
    if (!managed) {
      throw new LaunchProcessError(
        "PROCESS_NOT_FOUND",
        `Unknown process: ${processId}`
      );
    }

    return managed;
  }

  function scheduleCleanup(processId: string): void {
    const current = processes.get(processId);
    if (!current) {
      return;
    }

    if (current.cleanupTimer) {
      clearTimeout(current.cleanupTimer);
    }

    current.cleanupTimer = setTimeout(() => {
      processes.delete(processId);
    }, completedProcessTtlMs);
    processes.set(processId, current);
  }

  function setTerminalState(
    processId: string,
    nextStatus: Extract<ProcessStatus, "Failed" | "Stopped">,
    updates: Partial<ProcessState> = {}
  ): void {
    const current = processes.get(processId);
    if (!current) {
      return;
    }

    const preservedFailed = current.state.status === "Failed";
    current.state = {
      ...current.state,
      ...updates,
      status: preservedFailed ? "Failed" : nextStatus
    };
    processes.set(processId, current);
    scheduleCleanup(processId);
  }

  async function markRunningWhenReady(processId: string): Promise<void> {
    const managed = requireProcess(processId);

    if (managed.state.command.port) {
      await waitForPort(managed.state.command.port);
    }

    const current = processes.get(processId);
    if (!current || current.stopRequested || current.state.status === "Failed") {
      return;
    }

    current.state = {
      ...current.state,
      status: "Running"
    };
    processes.set(processId, current);

    if (current.state.command.port) {
      await openCommand([
        "/usr/bin/open",
        `http://127.0.0.1:${current.state.command.port}`
      ]);
    }
  }

  const manager: ProcessManager = {
    async startProcess(command) {
      const processId = randomUUID();
      const startedAt = new Date().toISOString();

      let child: ChildProcess;
      try {
        child = spawnProcess(command.executable, command.args, {
          cwd: command.cwd,
          detached: true,
          shell: false,
          stdio: ["ignore", "pipe", "pipe"]
        });
      } catch (error) {
        throw new LaunchProcessError(
          "PROCESS_SPAWN_FAILED",
          error instanceof Error ? error.message : String(error)
        );
      }

      const managed: ManagedProcess = {
        child,
        stopRequested: false,
        state: {
          processId,
          status: "Starting",
          command,
          stdout: "",
          stderr: "",
          startedAt
        }
      };
      processes.set(processId, managed);

      child.stdout?.on("data", (chunk) => {
        const current = processes.get(processId);
        if (!current) {
          return;
        }

        current.state = {
          ...current.state,
          stdout: boundedAppend(current.state.stdout, String(chunk), outputLimit)
        };
        processes.set(processId, current);
      });

      child.stderr?.on("data", (chunk) => {
        const current = processes.get(processId);
        if (!current) {
          return;
        }

        current.state = {
          ...current.state,
          stderr: boundedAppend(current.state.stderr, String(chunk), outputLimit)
        };
        processes.set(processId, current);
      });

      child.once("error", (error) => {
        const current = processes.get(processId);
        if (!current) {
          return;
        }

        setTerminalState(processId, "Failed", {
          stderr: boundedAppend(current.state.stderr, error.message, outputLimit),
          endedAt: new Date().toISOString()
        });
      });

      child.once("exit", (code) => {
        const current = processes.get(processId);
        if (!current) {
          return;
        }

        setTerminalState(
          processId,
          current.stopRequested || code === 0 ? "Stopped" : "Failed",
          {
            exitCode: code,
            endedAt: new Date().toISOString()
          }
        );
      });

      void markRunningWhenReady(processId).catch(async (error) => {
        const current = processes.get(processId);
        if (!current || current.stopRequested) {
          return;
        }

        const shouldTerminateProcess = current.state.status !== "Running";

        setTerminalState(processId, "Failed", {
          stderr: boundedAppend(
            current.state.stderr,
            error instanceof Error ? error.message : String(error),
            outputLimit
          ),
          endedAt: new Date().toISOString()
        });

        if (shouldTerminateProcess) {
          try {
            process.kill(-current.child.pid!, "SIGTERM");
          } catch {
            current.child.kill("SIGTERM");
          }
        }
      });

      return managed.state;
    },

    async stopProcess(processId) {
      const managed = requireProcess(processId);
      managed.stopRequested = true;
      processes.set(processId, managed);

      if (managed.child.exitCode !== null && managed.child.exitCode !== undefined) {
        managed.state = {
          ...managed.state,
          status: "Stopped",
          endedAt: managed.state.endedAt ?? new Date().toISOString()
        };
        processes.set(processId, managed);
        scheduleCleanup(processId);
        return managed.state;
      }

      await new Promise<void>((resolve) => {
        let settled = false;

        const finish = () => {
          if (settled) {
            return;
          }

          settled = true;
          const current = processes.get(processId);
          if (current) {
            current.state = {
              ...current.state,
              status: "Stopped",
              endedAt: current.state.endedAt ?? new Date().toISOString()
            };
            processes.set(processId, current);
            scheduleCleanup(processId);
          }
          resolve();
        };

        managed.child.once("exit", finish);

        try {
          process.kill(-managed.child.pid!, "SIGTERM");
        } catch {
          managed.child.kill("SIGTERM");
        }

        setTimeout(() => {
          try {
            process.kill(-managed.child.pid!, "SIGKILL");
          } catch {
            managed.child.kill("SIGKILL");
          }
        }, 500);

        setTimeout(finish, 1_500);
      });

      return requireProcess(processId).state;
    },

    getProcessState(processId) {
      return requireProcess(processId).state;
    },

    async shutdown() {
      const processIds = Array.from(processes.keys());
      await Promise.all(processIds.map((processId) => manager.stopProcess(processId).catch(() => undefined)));
    }
  };

  return manager;
}
