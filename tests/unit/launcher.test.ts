// @vitest-environment node

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createLauncherService } from "../../src/server/launch/launcher";
import { createProjectStore } from "../../src/server/store/project-store";
import type { ProcessState } from "../../src/server/launch/process-manager";
import type { LaunchTarget, Project } from "../../src/shared/domain";

function buildProject(launchTargets: LaunchTarget[], overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Project Atlas",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Launch safe local targets.",
    currentState: "Task 6 is implementing launch lifecycle support.",
    nextAction: "Ship the launcher service.",
    rootPath: "/workspace/project-atlas",
    repositoryUrl: "https://github.com/example/project-atlas",
    aliases: ["project-atlas"],
    sources: [
      {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: "workspace:/workspace/project-atlas",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T12:00:00.000Z"
      }
    ],
    launchTargets,
    syncStatus: "success",
    lastActivityAt: "2026-08-20T12:00:00.000Z",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    pinned: false,
    archived: false,
    ...overrides
  };
}

describe("launcher", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "launcher-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("validates url, folder, document, and task targets and returns disabled reasons for unavailable targets", async () => {
    const folderPath = path.join(tempRoot, "project");
    const documentPath = path.join(folderPath, "docs", "brief.md");
    await mkdir(path.dirname(documentPath), { recursive: true });
    await writeFile(documentPath, "# Brief\n");

    const launcher = createLauncherService({
      store: createProjectStore({ dataDir: path.join(tempRoot, "data") })
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "url",
        id: "docs",
        label: "Docs",
        url: "https://example.test/docs"
      })
    ).toMatchObject({
      enabled: true,
      launchArgs: ["https://example.test/docs"]
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "folder",
        id: "folder",
        label: "Folder",
        path: folderPath
      })
    ).toMatchObject({
      enabled: true,
      launchArgs: [folderPath]
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "document",
        id: "brief",
        label: "Brief",
        path: documentPath,
        page: "3"
      })
    ).toMatchObject({
      enabled: true,
      launchArgs: [expect.stringContaining(documentPath)]
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "task",
        id: "task",
        label: "Task",
        taskId: "task-123",
        workspace: folderPath
      })
    ).toMatchObject({
      enabled: true,
      launchArgs: [expect.stringContaining("codex://task/task-123")]
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "url",
        id: "bad-url",
        label: "Bad URL",
        url: "not a url"
      })
    ).toMatchObject({
      enabled: false,
      reason: "Invalid URL."
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "folder",
        id: "missing-folder",
        label: "Missing folder",
        path: path.join(tempRoot, "missing")
      })
    ).toMatchObject({
      enabled: false,
      reason: "Folder does not exist."
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "document",
        id: "missing-doc",
        label: "Missing doc",
        path: path.join(tempRoot, "missing.md")
      })
    ).toMatchObject({
      enabled: false,
      reason: "Document does not exist."
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "task",
        id: "missing-task-workspace",
        label: "Missing task workspace",
        taskId: "task-123",
        workspace: path.join(tempRoot, "missing-workspace")
      })
    ).toMatchObject({
      enabled: false,
      reason: "Task workspace does not exist."
    });
  });

  test("launches non-command targets with the macOS open executable and argument arrays", async () => {
    const folderPath = path.join(tempRoot, "project");
    await mkdir(folderPath, { recursive: true });

    const openCommand = vi.fn().mockResolvedValue(undefined);
    const launcher = createLauncherService({
      store: createProjectStore({ dataDir: path.join(tempRoot, "data") }),
      trustFilePath: path.join(tempRoot, "data", "launch-trust.json"),
      openCommand
    });

    const result = await launcher.openValidatedTarget({
      kind: "folder",
      id: "folder",
      label: "Folder",
      path: folderPath
    });

    expect(result).toMatchObject({
      status: "launched",
      launchArgs: [folderPath]
    });
    expect(openCommand).toHaveBeenCalledWith(["/usr/bin/open", folderPath]);
  });

  test("requires explicit approval for an untrusted command, persists the exact fingerprint, and allows later launches without approval", async () => {
    const projectRoot = path.join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });

    const processState: ProcessState = {
      processId: "process-1",
      status: "Running",
      command: {
        executable: "npm",
        args: ["run", "dev"],
        cwd: projectRoot
      },
      stdout: "ready",
      stderr: "",
      startedAt: "2026-08-20T12:00:00.000Z"
    };
    const startProcess = vi.fn().mockResolvedValue(processState);
    const store = createProjectStore({ dataDir: path.join(tempRoot, "data") });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject([
        {
          kind: "command",
          id: "dev-server",
          label: "Dev server",
          origin: "manual",
          executable: "npm",
          args: ["run", "dev"],
          cwd: projectRoot,
          port: 4173
        }
      ])
    });

    const launcher = createLauncherService({
      store,
      trustFilePath: path.join(tempRoot, "data", "launch-trust.json"),
      processManager: {
        startProcess,
        stopProcess: vi.fn(),
        getProcessState: vi.fn()
      }
    });

    const approvalNeeded = await launcher.launchTarget("project-1", "dev-server");
    expect(approvalNeeded).toMatchObject({
      status: "approval-required",
      fingerprint: expect.any(String)
    });
    expect(startProcess).not.toHaveBeenCalled();

    const launched = await launcher.launchTarget("project-1", "dev-server", {
      fingerprint: approvalNeeded.fingerprint
    });
    expect(launched).toMatchObject({
      status: "started",
      processId: "process-1"
    });
    expect(startProcess).toHaveBeenCalledTimes(1);

    const relaunched = await launcher.launchTarget("project-1", "dev-server");
    expect(relaunched).toMatchObject({
      status: "started",
      processId: "process-1"
    });
    expect(startProcess).toHaveBeenCalledTimes(2);

    const trustFile = path.join(tempRoot, "data", "launch-trust.json");
    const trustContents = JSON.parse(await readFile(trustFile, "utf8")) as { trustedFingerprints: string[] };
    expect(trustContents.trustedFingerprints).toContain(approvalNeeded.fingerprint);
  });

  test("invalidates trust when any command argument changes", async () => {
    const projectRoot = path.join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });

    const store = createProjectStore({ dataDir: path.join(tempRoot, "data") });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject([
        {
          kind: "command",
          id: "dev-server",
          label: "Dev server",
          origin: "manual",
          executable: "npm",
          args: ["run", "dev"],
          cwd: projectRoot
        }
      ])
    });

    const launcher = createLauncherService({
      store,
      trustFilePath: path.join(tempRoot, "data", "launch-trust.json"),
      processManager: {
        startProcess: vi.fn().mockResolvedValue({
          processId: "process-1",
          status: "Running",
          command: {
            executable: "npm",
            args: ["run", "dev"],
            cwd: projectRoot
          },
          stdout: "",
          stderr: "",
          startedAt: "2026-08-20T12:00:00.000Z"
        } satisfies ProcessState),
        stopProcess: vi.fn(),
        getProcessState: vi.fn()
      }
    });

    const firstAttempt = await launcher.launchTarget("project-1", "dev-server");
    await launcher.launchTarget("project-1", "dev-server", {
      fingerprint: firstAttempt.fingerprint
    });

    await store.applyMutation({
      kind: "upsert",
      project: buildProject([
        {
          kind: "command",
          id: "dev-server",
          label: "Dev server",
          executable: "npm",
          args: ["run", "preview"],
          cwd: projectRoot
        }
      ])
    });

    const secondAttempt = await launcher.launchTarget("project-1", "dev-server");
    expect(secondAttempt).toMatchObject({
      status: "approval-required",
      fingerprint: expect.any(String)
    });
    expect(secondAttempt.fingerprint).not.toBe(firstAttempt.fingerprint);
  });

  test("keeps imported commands untrusted until explicit approval", async () => {
    const importRoot = path.join(tempRoot, "imported-project");
    await mkdir(importRoot, { recursive: true });

    const store = createProjectStore({ dataDir: path.join(tempRoot, "data") });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject(
        [
          {
            kind: "command",
            id: "imported-dev",
            label: "Imported dev server",
            origin: "imported",
            executable: "npm",
            args: ["run", "dev"],
            cwd: importRoot
          }
        ],
        {
          sources: [
            {
              kind: "import",
              label: "Imported metadata",
              sourceId: "import:row-1",
              syncStatus: "success",
              lastSyncedAt: "2026-08-20T12:00:00.000Z"
            }
          ]
        }
      )
    });

    const launcher = createLauncherService({
      store,
      trustFilePath: path.join(tempRoot, "data", "launch-trust.json"),
      processManager: {
        startProcess: vi.fn(),
        stopProcess: vi.fn(),
        getProcessState: vi.fn()
      }
    });

    await expect(launcher.launchTarget("project-1", "imported-dev")).resolves.toMatchObject({
      status: "approval-required",
      fingerprint: expect.any(String)
    });
  });

  test("keeps imported commands untrusted even when the same fingerprint was approved for a manual target", async () => {
    const projectRoot = path.join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });

    const startProcess = vi.fn().mockResolvedValue({
      processId: "process-1",
      status: "Running",
      command: {
        executable: "npm",
        args: ["run", "dev"],
        cwd: projectRoot
      },
      stdout: "",
      stderr: "",
      startedAt: "2026-08-20T12:00:00.000Z"
    } satisfies ProcessState);
    const store = createProjectStore({ dataDir: path.join(tempRoot, "data") });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject(
        [
          {
            kind: "command",
            id: "manual-dev",
            label: "Manual dev server",
            origin: "manual",
            executable: "npm",
            args: ["run", "dev"],
            cwd: projectRoot
          },
          {
            kind: "command",
            id: "imported-dev",
            label: "Imported dev server",
            origin: "imported",
            executable: "npm",
            args: ["run", "dev"],
            cwd: projectRoot
          }
        ],
        {
          sources: [
            {
              kind: "manual",
              label: "Manual entry",
              sourceId: "manual:1",
              syncStatus: "success",
              lastSyncedAt: "2026-08-20T12:00:00.000Z"
            }
          ]
        }
      )
    });

    const launcher = createLauncherService({
      store,
      trustFilePath: path.join(tempRoot, "data", "launch-trust.json"),
      processManager: {
        startProcess,
        stopProcess: vi.fn(),
        getProcessState: vi.fn()
      }
    });

    const manualApproval = await launcher.launchTarget("project-1", "manual-dev");
    expect(manualApproval).toMatchObject({
      status: "approval-required",
      fingerprint: expect.any(String)
    });
    await launcher.launchTarget("project-1", "manual-dev", {
      fingerprint: manualApproval.fingerprint
    });

    const importedAttempt = await launcher.launchTarget("project-1", "imported-dev");
    expect(importedAttempt).toMatchObject({
      status: "approval-required",
      fingerprint: manualApproval.fingerprint
    });
    expect(startProcess).toHaveBeenCalledTimes(1);
  });

  test("rejects shell wrapper executables before spawn", async () => {
    const projectRoot = path.join(tempRoot, "project");
    await mkdir(projectRoot, { recursive: true });

    const launcher = createLauncherService({
      store: createProjectStore({ dataDir: path.join(tempRoot, "data") })
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "command",
        id: "bash-wrapper",
        label: "Bash wrapper",
        origin: "manual",
        executable: "bash",
        args: ["-lc", "npm run dev"],
        cwd: projectRoot
      })
    ).toMatchObject({
      enabled: false,
      reason: "Shell wrapper commands are not allowed."
    });

    expect(
      launcher.validateLaunchTarget({
        kind: "command",
        id: "sh-wrapper",
        label: "Sh wrapper",
        origin: "manual",
        executable: "sh",
        args: ["-c", "npm run dev"],
        cwd: projectRoot
      })
    ).toMatchObject({
      enabled: false,
      reason: "Shell wrapper commands are not allowed."
    });
  });
});
