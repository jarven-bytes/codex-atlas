import type { ProcessManager } from "./launch/process-manager";

export interface GracefulShutdownOptions {
  processManager: Pick<ProcessManager, "shutdown">;
  closeWatcher?: () => Promise<void>;
  closeVite?: () => Promise<void>;
  closeServer: () => Promise<void>;
  exit?: (code: number) => void;
  logError?: (error: unknown) => void;
  shutdownDeadlineMs?: number;
}

export function createGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  let shutdownPromise: Promise<void> | null = null;
  const shutdownDeadlineMs = options.shutdownDeadlineMs ?? 5_000;

  return () => {
    shutdownPromise ??= (async () => {
      const deadlineAt = Date.now() + shutdownDeadlineMs;
      const operations: Array<[string, () => Promise<void> | undefined]> = [
        ["watcher", options.closeWatcher],
        ["process manager", () => options.processManager.shutdown()],
        ["Vite", options.closeVite]
      ].filter((entry): entry is [string, () => Promise<void>] => Boolean(entry[1]));
      const settled = Promise.allSettled(
        operations.map(async ([label, operation]) => {
          try {
            await operation();
          } catch (error) {
            options.logError?.(new Error(`${label} cleanup failed.`, { cause: error }));
          }
        })
      );
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<"deadline">((resolve) => {
        deadlineTimer = setTimeout(() => resolve("deadline"), shutdownDeadlineMs);
      });
      const outcome = await Promise.race([settled.then(() => "complete" as const), deadline]);
      if (deadlineTimer) {
        clearTimeout(deadlineTimer);
      }
      if (outcome === "deadline") {
        options.logError?.(new Error(`Graceful shutdown exceeded ${shutdownDeadlineMs}ms.`));
      }

      const closeServerTask = (async () => {
        try {
          await options.closeServer();
        } catch (error) {
          options.logError?.(new Error("HTTP server cleanup failed.", { cause: error }));
        }
      })();
      const remainingMs = Math.max(0, deadlineAt - Date.now());
      if (remainingMs > 0) {
        await Promise.race([
          closeServerTask,
          new Promise<void>((resolve) => setTimeout(resolve, remainingMs))
        ]);
      } else {
        void closeServerTask;
      }
      options.exit?.(0);
    })();

    return shutdownPromise;
  };
}
