import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App, mergeLaunchStatePatch } from "../../src/client/App";
import { clientApi } from "../../src/client/api";
import type { LaunchTargetState } from "../../src/client/components/LaunchControls";
import type {
  ActivityEvent,
  FieldProvenanceMap,
  LaunchTarget,
  Project,
  ProjectSource,
  Suggestion
} from "../../src/shared/domain";
import type { ProcessState } from "../../src/server/launch/process-manager";

type MockedClientApi = typeof clientApi & {
  getProject: ReturnType<typeof vi.fn>;
  dismissSuggestion: ReturnType<typeof vi.fn>;
  previewImport: ReturnType<typeof vi.fn>;
  commitImport: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  getProcessState: ReturnType<typeof vi.fn>;
  launchProjectTarget: ReturnType<typeof vi.fn>;
  stopProcess: ReturnType<typeof vi.fn>;
};

vi.mock("../../src/client/api", () => ({
  clientApi: {
    listProjects: vi.fn(),
    getProject: vi.fn(),
    acceptSuggestion: vi.fn(),
    dismissSuggestion: vi.fn(),
    previewImport: vi.fn(),
    commitImport: vi.fn(),
    undo: vi.fn(),
    getProcessState: vi.fn(),
    launchProjectTarget: vi.fn(),
    stopProcess: vi.fn()
  }
}));

function buildSource(overrides: Partial<ProjectSource> = {}): ProjectSource {
  return {
    kind: "workspace",
    label: "Workspace scan",
    sourceId: "workspace:/workspace/task-9",
    syncStatus: "success",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  };
}

function buildSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    kind: "field-update",
    id: overrides.id ?? "suggestion-1",
    field: overrides.field ?? "nextAction",
    title: overrides.title ?? "Strengthen the next action",
    detail: overrides.detail ?? "The latest sync suggests a more actionable next step.",
    currentValue: overrides.currentValue ?? "Review the dashboard.",
    proposedValue: overrides.proposedValue ?? "Review the queued import rows and launch targets.",
    evidence: overrides.evidence ?? [
      { kind: "source-id", value: "codex:task-9" },
      { kind: "root-path", value: "/workspace/task-9" }
    ],
    createdAt: overrides.createdAt ?? "2026-08-20T12:05:00.000Z"
  };
}

function buildActivity(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return {
    kind: overrides.kind ?? "note",
    id: overrides.id ?? "activity-1",
    message: overrides.message ?? "Queued import rows need review before commit.",
    createdAt: overrides.createdAt ?? "2026-08-20T12:10:00.000Z"
  };
}

function buildProvenance(): FieldProvenanceMap {
  return {
    userNeed: {
      sourceLabel: "Manual review",
      sourceId: "manual:task-9",
      updatedAt: "2026-08-20T11:45:00.000Z",
      manual: true
    },
    currentState: {
      sourceLabel: "Codex sync",
      sourceId: "codex:task-9",
      updatedAt: "2026-08-20T12:00:00.000Z"
    },
    nextAction: {
      sourceLabel: "Imported CSV",
      sourceId: "import:seeded-preview",
      updatedAt: "2026-08-20T12:05:00.000Z",
      lastVerifiedValue: "Review the dashboard."
    }
  };
}

function buildProject(
  overrides: Partial<Project> = {},
  launchTargets: LaunchTarget[] = overrides.launchTargets ?? []
): Project {
  return {
    id: overrides.id ?? "project-1",
    name: overrides.name ?? "Flight Price Tracker",
    type: overrides.type ?? "web-app",
    needStatus: overrides.needStatus ?? "Plan",
    userNeed: overrides.userNeed ?? "Track route prices and launch the latest local experience safely.",
    currentState:
      overrides.currentState ??
      "Task 8 shipped the dashboard overview and Task 9 is wiring the project drawer.",
    nextAction: overrides.nextAction ?? "Review suggestions, import rows, and launch the approved target.",
    launchTargets,
    sources: overrides.sources ?? [
      buildSource(),
      buildSource({
        kind: "import",
        label: "Imported CSV",
        sourceId: "import:seeded-preview",
        syncStatus: "partial",
        unavailableReason: undefined
      })
    ],
    lastActivityAt: overrides.lastActivityAt ?? "2026-08-20T12:10:00.000Z",
    lastSyncedAt: overrides.lastSyncedAt ?? "2026-08-20T12:08:00.000Z",
    syncStatus: overrides.syncStatus ?? "partial",
    updatedAt: overrides.updatedAt ?? "2026-08-20T12:10:00.000Z",
    repositoryUrl: overrides.repositoryUrl ?? "https://github.com/example/flight-price-tracker",
    rootPath: overrides.rootPath ?? "/workspace/task-9",
    aliases: overrides.aliases ?? ["flight-price-tracker"],
    importantFiles: overrides.importantFiles ?? [
      "/workspace/task-9/src/client/App.tsx",
      "/workspace/task-9/data/seed.csv"
    ],
    missingItems: overrides.missingItems ?? [
      "Confirm imported command approval",
      "Resolve duplicate import rows"
    ],
    tags: overrides.tags ?? ["dashboard", "task-9"],
    suggestions: overrides.suggestions ?? [buildSuggestion(), buildSuggestion({
      id: "suggestion-2",
      field: "currentState",
      title: "Tighten the current state",
      currentValue: "Task 8 shipped the dashboard overview and Task 9 is wiring the project drawer.",
      proposedValue: "Task 8 is accepted, and Task 9 is focused on the drawer, imports, and launch lifecycle."
    })],
    recentActivity: overrides.recentActivity ?? [
      buildActivity(),
      buildActivity({
        id: "activity-2",
        kind: "sync",
        message: "Synced a seeded registry snapshot for visual verification.",
        createdAt: "2026-08-20T11:58:00.000Z"
      })
    ],
    fieldProvenance: overrides.fieldProvenance ?? buildProvenance(),
    attentionFlags: overrides.attentionFlags ?? ["needs-review", "unverified"],
    pinned: overrides.pinned ?? true,
    archived: overrides.archived ?? false
  };
}

function api(): MockedClientApi {
  return clientApi as MockedClientApi;
}

async function advanceTimersByTime(milliseconds: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });
}

async function flushAsyncWork() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function expectPollingWaiterSettled(waiter: Promise<void> | undefined) {
  expect(waiter).toBeDefined();
  if (!waiter) {
    return;
  }
  const result = await Promise.race([waiter, Promise.resolve("not-settled")]);
  expect(result).toBeUndefined();
}

describe("project detail drawer", () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/");

    const importedTarget: LaunchTarget = {
      kind: "command",
      id: "imported-dev",
      label: "Imported dev server",
      origin: "imported",
      executable: "npm",
      args: ["run", "dev"],
      cwd: "/workspace/task-9",
      port: 4173
    };
    const docsTarget: LaunchTarget = {
      kind: "document",
      id: "docs",
      label: "Workspace docs",
      path: "/workspace/task-9/docs/brief.md"
    };

    const project = buildProject({}, [importedTarget, docsTarget]);
    api().listProjects.mockResolvedValue({ projects: [project] });
    api().getProject.mockResolvedValue(project);
    api().acceptSuggestion
      .mockResolvedValueOnce({
        ...project,
        suggestions: [project.suggestions![1]],
        nextAction: project.suggestions![0].proposedValue
      })
      .mockResolvedValueOnce({
        ...project,
        suggestions: [],
        nextAction: project.suggestions![0].proposedValue,
        currentState: project.suggestions![1].proposedValue
      });
    api().dismissSuggestion.mockResolvedValue({
      ...project,
      suggestions: [project.suggestions![1]]
    });
    api().launchProjectTarget
      .mockResolvedValueOnce({
        status: "approval-required",
        fingerprint: "fingerprint-1"
      })
      .mockResolvedValueOnce({
        status: "started",
        processId: "process-123"
      })
      .mockResolvedValueOnce({
        status: "launched",
        launchArgs: ["/workspace/task-9/docs/brief.md"]
      });
    api().stopProcess.mockResolvedValue({
      process: {
        processId: "process-123",
        status: "Stopped",
        command: {
          executable: "npm",
          args: ["run", "dev"],
          cwd: "/workspace/task-9"
        },
        stdout: "ready",
        stderr: "",
        startedAt: "2026-08-20T12:12:00.000Z",
        endedAt: "2026-08-20T12:13:00.000Z"
      } satisfies ProcessState
    });
    api().getProcessState.mockResolvedValue({
      processId: "process-123",
      status: "Running",
      command: {
        executable: "npm",
        args: ["run", "dev"],
        cwd: "/workspace/task-9",
        port: 4173
      },
      stdout: "ready",
      stderr: "",
      startedAt: "2026-08-20T12:12:00.000Z"
    } satisfies ProcessState);
  });

  test("renders the right-side project drawer with provenance, activity, missing items, and important files", async () => {
    render(<App />);

    const drawer = await screen.findByRole("complementary", { name: "Project detail" });
    expect(within(drawer).getByRole("heading", { name: "Flight Price Tracker" })).toBeVisible();
    expect(
      within(drawer).getByText(
        "Track route prices and launch the latest local experience safely."
      )
    ).toBeVisible();
    expect(
      within(drawer).getByText(
        "Task 8 shipped the dashboard overview and Task 9 is wiring the project drawer."
      )
    ).toBeVisible();
    expect(
      within(drawer).getByText(
        "Review suggestions, import rows, and launch the approved target."
      )
    ).toBeVisible();
    expect(within(drawer).getByText("Confirm imported command approval")).toBeVisible();
    expect(within(drawer).getByText("/workspace/task-9/src/client/App.tsx")).toBeVisible();
    expect(within(drawer).getByText("Manual review")).toBeVisible();
    expect(within(drawer).getByText("Last activity")).toBeVisible();
    expect(within(drawer).getByText("Last sync")).toBeVisible();
    expect(within(drawer).getByText("needs-review")).toBeVisible();
    expect(within(drawer).getByText("Field: nextAction")).toBeVisible();
    expect(within(drawer).getAllByText("Imported CSV").length).toBeGreaterThan(0);
    expect(
      within(drawer).getByText("Synced a seeded registry snapshot for visual verification.")
    ).toBeVisible();
  });

  test("supports dismissing one suggestion and batch-applying the remaining suggestions with a count message", async () => {
    const user = userEvent.setup();
    render(<App />);

    const drawer = await screen.findByRole("complementary", { name: "Project detail" });
    expect(within(drawer).getByText("Strengthen the next action")).toBeVisible();
    expect(
      within(drawer).getByText("Review the queued import rows and launch targets.")
    ).toBeVisible();

    await user.click(
      within(drawer).getByRole("button", { name: "Dismiss Strengthen the next action" })
    );
    expect(api().dismissSuggestion).toHaveBeenCalledWith("project-1", "suggestion-1");

    await user.click(within(drawer).getByRole("button", { name: "Accept all suggestions" }));
    expect(api().acceptSuggestion).toHaveBeenCalledTimes(1);
    expect(await within(drawer).findByText("Applied 1 suggested change.")).toBeVisible();
  });

  test("shows approval-first launch controls, launches non-command targets, and stops the running process", async () => {
    const user = userEvent.setup();
    render(<App />);

    const drawer = await screen.findByRole("complementary", { name: "Project detail" });

    await user.click(within(drawer).getByRole("button", { name: "Launch Imported dev server" }));
    expect(api().launchProjectTarget).toHaveBeenCalledWith("project-1", "imported-dev");
    expect(await within(drawer).findByText("Approval required before first launch.")).toBeVisible();
    expect(within(drawer).getByText(/Imported command.*Untrusted/)).toBeVisible();
    expect(within(drawer).getByText("npm run dev (cwd: /workspace/task-9, port: 4173)")).toBeVisible();

    await user.click(within(drawer).getByRole("button", { name: "Approve and launch Imported dev server" }));
    expect(api().launchProjectTarget).toHaveBeenLastCalledWith("project-1", "imported-dev", {
      fingerprint: "fingerprint-1"
    });
    expect(await within(drawer).findByText("Running process process-123")).toBeVisible();
    expect(api().getProcessState).toHaveBeenCalledWith("process-123");
    expect(await within(drawer).findByRole("button", { name: "Open app Imported dev server" })).toBeEnabled();
    expect(within(drawer).getByText(/Imported command.*Trusted/)).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "Launch Imported dev server" })).toBeDisabled();
    await user.click(within(drawer).getByRole("button", { name: "Launch Imported dev server" }));
    expect(api().launchProjectTarget).toHaveBeenCalledTimes(2);

    await user.click(within(drawer).getByRole("button", { name: "Stop Imported dev server" }));
    expect(api().stopProcess).toHaveBeenCalledWith("process-123");
    expect(await within(drawer).findByText("Stopped process process-123")).toBeVisible();

    await user.click(within(drawer).getByRole("button", { name: "Open Workspace docs" }));
    expect(api().launchProjectTarget).toHaveBeenLastCalledWith("project-1", "docs");
  });

  test("disposes the pending polling timer and quiesces when the process is stopped", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let observedWaiter: Promise<void> | undefined;
    render(<App onPollWaitSettled={(_key, waiter) => { observedWaiter = waiter; }} />);
    await flushAsyncWork();
    const drawer = screen.getByRole("complementary", { name: "Project detail" });

    fireEvent.click(within(drawer).getByRole("button", { name: "Launch Imported dev server" }));
    await flushAsyncWork();
    fireEvent.click(within(drawer).getByRole("button", { name: "Approve and launch Imported dev server" }));
    await flushAsyncWork();
    expect(within(drawer).getByText("Running process process-123")).toBeVisible();
    expect(api().getProcessState).toHaveBeenCalledTimes(1);
    const pollingTimerCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1_000);
    if (pollingTimerCallIndex < 0) {
      throw new Error("Expected the running poll to schedule a 1-second timer.");
    }
    const pollingTimer = setTimeoutSpy.mock.results[pollingTimerCallIndex]?.value;

    fireEvent.click(within(drawer).getByRole("button", { name: "Stop Imported dev server" }));
    await flushAsyncWork();
    expect(within(drawer).getByText("Stopped process process-123")).toBeVisible();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(pollingTimer);
    await expectPollingWaiterSettled(observedWaiter);
    await advanceTimersByTime(5_000);

    expect(api().getProcessState).toHaveBeenCalledTimes(1);
  });

  test("disposes the pending polling timer and quiesces when the detail view unmounts", async () => {
    vi.useFakeTimers();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let observedWaiter: Promise<void> | undefined;
    const { unmount } = render(
      <App onPollWaitSettled={(_key, waiter) => { observedWaiter = waiter; }} />
    );
    await flushAsyncWork();
    const drawer = screen.getByRole("complementary", { name: "Project detail" });

    fireEvent.click(within(drawer).getByRole("button", { name: "Launch Imported dev server" }));
    await flushAsyncWork();
    fireEvent.click(within(drawer).getByRole("button", { name: "Approve and launch Imported dev server" }));
    await flushAsyncWork();
    expect(within(drawer).getByText("Running process process-123")).toBeVisible();
    expect(api().getProcessState).toHaveBeenCalledTimes(1);
    const pollingTimerCallIndex = setTimeoutSpy.mock.calls.findIndex(([, delay]) => delay === 1_000);
    if (pollingTimerCallIndex < 0) {
      throw new Error("Expected the running poll to schedule a 1-second timer.");
    }
    const pollingTimer = setTimeoutSpy.mock.results[pollingTimerCallIndex]?.value;

    unmount();
    expect(clearTimeoutSpy).toHaveBeenCalledWith(pollingTimer);
    await expectPollingWaiterSettled(observedWaiter);
    await advanceTimersByTime(5_000);

    expect(api().getProcessState).toHaveBeenCalledTimes(1);
  });

  test("surfaces failed startup from authoritative process state and avoids duplicate launches", async () => {
    const user = userEvent.setup();
    api().getProcessState.mockResolvedValue({
      processId: "process-123",
      status: "Failed",
      command: {
        executable: "npm",
        args: ["run", "dev"],
        cwd: "/workspace/task-9",
        port: 4173
      },
      stdout: "",
      stderr: "npm exited with code 1",
      startedAt: "2026-08-20T12:12:00.000Z",
      exitCode: 1,
      endedAt: "2026-08-20T12:12:02.000Z"
    } satisfies ProcessState);
    render(<App />);
    const drawer = await screen.findByRole("complementary", { name: "Project detail" });

    await user.click(within(drawer).getByRole("button", { name: "Launch Imported dev server" }));
    await user.click(await within(drawer).findByRole("button", { name: "Approve and launch Imported dev server" }));
    expect(await within(drawer).findByText("npm exited with code 1")).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "Launch Imported dev server" })).toBeEnabled();
    expect(api().launchProjectTarget).toHaveBeenCalledTimes(2);
  });

  test("backs off healthy polling and terminates after a later process failure", async () => {
    vi.useFakeTimers();
    api().getProcessState.mockResolvedValue({
      processId: "process-123",
      status: "Running",
      command: { executable: "npm", args: ["run", "dev"], cwd: "/workspace/task-9", port: 4173 },
      stdout: "ready",
      stderr: "",
      startedAt: "2026-08-20T12:12:00.000Z"
    } satisfies ProcessState);
    render(<App />);
    await flushAsyncWork();
    const drawer = screen.getByRole("complementary", { name: "Project detail" });

    fireEvent.click(within(drawer).getByRole("button", { name: "Launch Imported dev server" }));
    await flushAsyncWork();
    fireEvent.click(within(drawer).getByRole("button", { name: "Approve and launch Imported dev server" }));
    await flushAsyncWork();
    expect(within(drawer).getByText("Running process process-123")).toBeVisible();
    expect(api().getProcessState).toHaveBeenCalledTimes(1);
    await advanceTimersByTime(999);
    expect(api().getProcessState).toHaveBeenCalledTimes(1);
    await advanceTimersByTime(1);
    expect(api().getProcessState).toHaveBeenCalledTimes(2);
    await advanceTimersByTime(1_999);
    expect(api().getProcessState).toHaveBeenCalledTimes(2);
    await advanceTimersByTime(1);
    expect(api().getProcessState).toHaveBeenCalledTimes(3);
    await advanceTimersByTime(3_999);
    expect(api().getProcessState).toHaveBeenCalledTimes(3);
    await advanceTimersByTime(1);
    expect(api().getProcessState).toHaveBeenCalledTimes(4);
    await advanceTimersByTime(4_999);
    expect(api().getProcessState).toHaveBeenCalledTimes(4);
    await advanceTimersByTime(1);
    expect(api().getProcessState).toHaveBeenCalledTimes(5);
    api().getProcessState.mockResolvedValueOnce({
      processId: "process-123",
      status: "Failed",
      command: { executable: "npm", args: ["run", "dev"], cwd: "/workspace/task-9", port: 4173 },
      stdout: "ready",
      stderr: "server exited after the capped backoff",
      startedAt: "2026-08-20T12:12:00.000Z",
      exitCode: 1,
      endedAt: "2026-08-20T12:12:01.000Z"
    } satisfies ProcessState);
    await advanceTimersByTime(4_999);
    expect(api().getProcessState).toHaveBeenCalledTimes(5);
    await advanceTimersByTime(1);
    expect(api().getProcessState).toHaveBeenCalledTimes(6);
    expect(within(drawer).getByText("server exited after the capped backoff")).toBeVisible();
    await advanceTimersByTime(5_000);
    expect(api().getProcessState).toHaveBeenCalledTimes(6);
    expect(within(drawer).getByRole("button", { name: "Launch Imported dev server" })).toBeEnabled();
  });

  test("preserves launch-state identity when a healthy poll patch is unchanged", () => {
    const key = "project-1:imported-dev";
    const runningState: LaunchTargetState = {
      status: "running",
      processId: "process-123",
      trusted: true,
      terminal: false,
      message: "Running process process-123"
    };
    const current = { [key]: runningState };

    const next = mergeLaunchStatePatch(current, key, {
      status: "running",
      processId: "process-123",
      trusted: true,
      terminal: false,
      pollError: undefined,
      message: "Running process process-123"
    });

    expect(next).toBe(current);
    expect(next[key]).toBe(runningState);
  });

  test("retains authoritative state through a poll error and continues to terminal failure", async () => {
    vi.useFakeTimers();
    let resolveTerminalFailure!: (process: ProcessState) => void;
    const terminalFailure = new Promise<ProcessState>((resolve) => {
      resolveTerminalFailure = resolve;
    });
    api().getProcessState
      .mockResolvedValueOnce({
        processId: "process-123",
        status: "Running",
        command: { executable: "npm", args: ["run", "dev"], cwd: "/workspace/task-9", port: 4173 },
        stdout: "ready",
        stderr: "",
        startedAt: "2026-08-20T12:12:00.000Z"
      } satisfies ProcessState)
      .mockRejectedValueOnce(new Error("Process state unavailable."))
      .mockReturnValueOnce(terminalFailure);
    render(<App />);
    await flushAsyncWork();
    const drawer = screen.getByRole("complementary", { name: "Project detail" });

    fireEvent.click(within(drawer).getByRole("button", { name: "Launch Imported dev server" }));
    await flushAsyncWork();
    fireEvent.click(within(drawer).getByRole("button", { name: "Approve and launch Imported dev server" }));
    await flushAsyncWork();
    expect(within(drawer).getByText("Running process process-123")).toBeVisible();
    expect(api().getProcessState).toHaveBeenCalledTimes(1);
    await advanceTimersByTime(1_000);
    expect(api().getProcessState).toHaveBeenCalledTimes(2);
    expect(within(drawer).getByText("Process state unavailable.")).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "Launch Imported dev server" })).toBeDisabled();

    await advanceTimersByTime(200);
    expect(api().getProcessState).toHaveBeenCalledTimes(3);
    await act(async () => {
      resolveTerminalFailure({
        processId: "process-123",
        status: "Failed",
        command: { executable: "npm", args: ["run", "dev"], cwd: "/workspace/task-9", port: 4173 },
        stdout: "ready",
        stderr: "server exited after polling recovered",
        startedAt: "2026-08-20T12:12:00.000Z",
        exitCode: 1,
        endedAt: "2026-08-20T12:12:02.000Z"
      });
      await Promise.resolve();
    });
    expect(within(drawer).getByText("server exited after polling recovered")).toBeVisible();
    expect(within(drawer).getByRole("button", { name: "Launch Imported dev server" })).toBeEnabled();
    await advanceTimersByTime(5_000);
    expect(api().getProcessState).toHaveBeenCalledTimes(3);
  });
});
