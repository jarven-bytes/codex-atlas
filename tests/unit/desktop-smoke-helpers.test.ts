import { describe, expect, test, vi } from "vitest";
import { resolveDmgCleanupHandle, stopProcessesWithEscalation } from "../e2e/desktop-smoke-helpers";

describe("desktop smoke cleanup helpers", () => {
  test("escalates remaining app processes after SIGTERM does not drain them", async () => {
    let remaining = [401, 402];
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const waitForExit = vi.fn(async () => remaining);

    await stopProcessesWithEscalation(
      () => remaining,
      (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGKILL") {
          remaining = [];
        }
      },
      waitForExit
    );

    expect(signals).toEqual([
      { pid: 401, signal: "SIGTERM" },
      { pid: 402, signal: "SIGTERM" },
      { pid: 401, signal: "SIGKILL" },
      { pid: 402, signal: "SIGKILL" }
    ]);
    expect(waitForExit).toHaveBeenCalledTimes(2);
  });

  test("reports an EPERM SIGTERM after still escalating every remaining process", async () => {
    let remaining = [501, 502];
    const termError = Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    const signals: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const waitForExit = vi.fn(async () => remaining);

    await expect(stopProcessesWithEscalation(
      () => remaining,
      (pid, signal) => {
        signals.push({ pid, signal });
        if (signal === "SIGTERM" && pid === 501) {
          throw termError;
        }
        if (signal === "SIGKILL") {
          remaining = [];
        }
      },
      waitForExit
    )).rejects.toMatchObject({
      name: "AggregateError",
      errors: [expect.objectContaining({
        cause: termError,
        message: "Failed to send SIGTERM to PID 501."
      })]
    });

    expect(signals).toEqual([
      { pid: 501, signal: "SIGTERM" },
      { pid: 502, signal: "SIGTERM" },
      { pid: 501, signal: "SIGKILL" },
      { pid: 502, signal: "SIGKILL" }
    ]);
    expect(waitForExit).toHaveBeenCalledTimes(2);
  });

  test("retains the attached device when mount-point parsing is incomplete", () => {
    expect(resolveDmgCleanupHandle(
      "/dev/disk7s1\tApple_HFS\tunexpected-output",
      ""
    )).toEqual({ device: "/dev/disk7s1" });
  });

  test("falls back to hdiutil info when attach output has no cleanup handle", () => {
    expect(resolveDmgCleanupHandle(
      "attach output changed",
      "image-path: /tmp/Codex Project Command Center.dmg\n/dev/disk8\nmount-point: /Volumes/Codex Project Command Center"
    )).toEqual({
      device: "/dev/disk8",
      mountPoint: "/Volumes/Codex Project Command Center"
    });
  });
});
