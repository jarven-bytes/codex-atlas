export type ProcessLookup = () => number[];
export type ProcessSignaler = (pid: number, signal: NodeJS.Signals) => void;
export type ProcessWaiter = (lookup: ProcessLookup) => Promise<number[]>;

interface ProcessSignalError {
  pid: number;
  signal: NodeJS.Signals;
  error: unknown;
}

function signalProcesses(
  processIds: number[],
  signal: NodeJS.Signals,
  signalProcess: ProcessSignaler
): ProcessSignalError[] {
  const errors: ProcessSignalError[] = [];
  for (const pid of processIds) {
    try {
      signalProcess(pid, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        errors.push({ pid, signal, error });
      }
    }
  }
  return errors;
}

async function waitForProcessesToExit(lookup: ProcessLookup): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const remaining = lookup();
    if (remaining.length === 0) {
      return remaining;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return lookup();
}

export async function stopProcessesWithEscalation(
  lookup: ProcessLookup,
  signalProcess: ProcessSignaler,
  waitForExit: ProcessWaiter = waitForProcessesToExit
): Promise<void> {
  let remaining = lookup();
  if (remaining.length === 0) {
    return;
  }

  const signalErrors = signalProcesses(remaining, "SIGTERM", signalProcess);
  remaining = await waitForExit(lookup).catch(() => lookup());
  if (remaining.length > 0) {
    signalErrors.push(...signalProcesses(remaining, "SIGKILL", signalProcess));
    remaining = await waitForExit(lookup).catch(() => lookup());
  }

  const reportedErrors = signalErrors.map(({ pid, signal, error }) => (
    new Error(`Failed to send ${signal} to PID ${pid}.`, { cause: error })
  ));
  if (remaining.length > 0) {
    reportedErrors.push(new Error(`Packaged app processes did not exit: ${remaining.join(", ")}`));
  }
  if (reportedErrors.length > 0) {
    throw new AggregateError(reportedErrors, "Failed to terminate one or more packaged app processes.");
  }
}

export interface DmgCleanupHandle {
  device?: string;
  mountPoint?: string;
}

function parseDmgCleanupHandle(output: string): DmgCleanupHandle {
  const device = output.match(/\/dev\/disk\d+(?:s\d+)?/u)?.[0];
  const mountPoint = output.match(/\/Volumes\/[^\r\n]+/u)?.[0]?.trim();
  return {
    ...(device ? { device } : {}),
    ...(mountPoint ? { mountPoint } : {})
  };
}

export function resolveDmgCleanupHandle(attachOutput: string, infoOutput: string): DmgCleanupHandle {
  const attachHandle = parseDmgCleanupHandle(attachOutput);
  const infoHandle = parseDmgCleanupHandle(infoOutput);
  return {
    ...(attachHandle.device ?? infoHandle.device ? { device: attachHandle.device ?? infoHandle.device } : {}),
    ...(attachHandle.mountPoint ?? infoHandle.mountPoint
      ? { mountPoint: attachHandle.mountPoint ?? infoHandle.mountPoint }
      : {})
  };
}
