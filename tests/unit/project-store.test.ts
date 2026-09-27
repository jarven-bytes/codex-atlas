// @vitest-environment node

import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  compareSnapshotEntries,
  createProjectStore
} from "../../src/server/store/project-store";
import { StructuredImportAdapter } from "../../src/server/imports/structured";
import type { Project } from "../../src/shared/domain";

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Codex Project Management System",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Track current work across local tasks and sources.",
    currentState: "Task 2 is wiring the shared registry store.",
    nextAction: "Finish persistence and export coverage.",
    rootPath: "/Users/example/Documents/Codex/project-management-system",
    repositoryUrl: "https://github.com/example/project-management-system",
    aliases: ["project-management-system"],
    sources: [
      {
        kind: "workspace",
        label: "Local workspace",
        sourceId: "workspace-1",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T12:00:00.000Z"
      }
    ],
    launchTargets: [
      {
        kind: "folder",
        id: "workspace-root",
        label: "Workspace root",
        path: "/Users/example/Documents/Codex/project-management-system"
      },
      {
        kind: "url",
        id: "task-brief",
        label: "Task brief",
        url: "https://example.test/task-2"
      }
    ],
    syncStatus: "success",
    suggestions: [
      {
        kind: "field-update",
        id: "suggestion-1",
        field: "nextAction",
        title: "Implement the store",
        detail: "Start with failing tests for undo and exports.",
        currentValue: "Finish persistence and export coverage.",
        proposedValue: "Start with failing tests for undo and exports.",
        evidence: [],
        createdAt: "2026-08-20T12:01:00.000Z"
      }
    ],
    recentActivity: [
      {
        kind: "note",
        id: "activity-1",
        message: "Created from the Task 2 test fixture.",
        createdAt: "2026-08-20T12:02:00.000Z"
      }
    ],
    fieldProvenance: {
      name: {
        sourceLabel: "Local workspace",
        sourceId: "workspace-1",
        updatedAt: "2026-08-20T12:00:00.000Z"
      }
    },
    attentionFlags: [],
    lastActivityAt: "2026-08-20T12:00:00.000Z",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    pinned: false,
    archived: false,
    ...overrides
  };
}

describe("ProjectStore", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "project-store-"));
  });

  afterEach(async () => {
    await import("node:fs/promises").then(({ rm }) =>
      rm(tempRoot, { recursive: true, force: true })
    );
  });

  test("creates an empty registry file when the store starts without data", async () => {
    const store = createProjectStore({ dataDir: tempRoot });

    await expect(store.list()).resolves.toEqual([]);

    const registryPath = path.join(tempRoot, "projects.json");
    await expect(readFile(registryPath, "utf8")).resolves.toBe("[]\n");
    expect(
      (await readdir(tempRoot)).some((entry) => entry.endsWith(".tmp"))
    ).toBe(false);
  });

  test("applies an upsert mutation atomically, preserves timestamps, and creates a history snapshot", async () => {
    const store = createProjectStore({ dataDir: tempRoot });
    const original = buildProject();
    const initialResult = await store.applyMutation({
      kind: "upsert",
      project: original
    });

    expect(initialResult.registry).toHaveLength(1);
    expect(initialResult.project.lastActivityAt).toBe(original.lastActivityAt);
    expect(initialResult.project.updatedAt).toBe(original.updatedAt);

    const historyDir = path.join(tempRoot, "history");
    const historyFilesAfterCreate = await readdir(historyDir);
    expect(historyFilesAfterCreate).toHaveLength(1);
    await expect(
      readFile(path.join(historyDir, historyFilesAfterCreate[0]), "utf8")
    ).resolves.toBe("[]\n");

    const registryPath = path.join(tempRoot, "projects.json");
    expect(path.basename(initialResult.registryPath)).toBe("projects.json");
    expect(path.dirname(initialResult.registryPath)).toBe(tempRoot);
    expect(await stat(registryPath)).toMatchObject({ isFile: expect.any(Function) });
    expect(
      (await readdir(tempRoot)).some((entry) => entry.endsWith(".tmp"))
    ).toBe(false);

    const updated = buildProject({
      currentState: "Task 2 store persistence is implemented.",
      nextAction: "Ship the registry APIs next.",
      updatedAt: "2026-08-20T14:00:00.000Z"
    });
    const updateResult = await store.applyMutation({
      kind: "upsert",
      project: updated
    });

    expect(updateResult.project.lastActivityAt).toBe(original.lastActivityAt);
    expect(updateResult.project.updatedAt).toBe(updated.updatedAt);
    await expect(store.get(original.id)).resolves.toMatchObject({
      currentState: updated.currentState,
      nextAction: updated.nextAction,
      lastActivityAt: original.lastActivityAt,
      updatedAt: updated.updatedAt
    });

    const historyFilesAfterUpdate = await readdir(historyDir);
    expect(historyFilesAfterUpdate).toHaveLength(2);
    const latestSnapshot = await readFile(
      path.join(historyDir, historyFilesAfterUpdate.sort()[1]),
      "utf8"
    );
    expect(JSON.parse(latestSnapshot)).toEqual([original]);
  });

  test("undoes the latest mutation by restoring the previous snapshot and removing it after success", async () => {
    const store = createProjectStore({ dataDir: tempRoot });
    const firstProject = buildProject();
    const secondProject = buildProject({
      id: "project-2",
      name: "Registry API follow-up",
      needStatus: "Need",
      nextAction: "Add HTTP endpoints."
    });

    await store.applyMutation({ kind: "upsert", project: firstProject });
    await store.applyMutation({ kind: "upsert", project: secondProject });

    const historyDir = path.join(tempRoot, "history");
    const beforeUndoSnapshots = await readdir(historyDir);
    expect(beforeUndoSnapshots).toHaveLength(2);

    const undoResult = await store.undoLastMutation();

    expect(undoResult.restored).toBe(true);
    expect(undoResult.snapshotPath).toContain(path.join(tempRoot, "history"));
    expect(undoResult.registry).toEqual([firstProject]);
    await expect(store.list()).resolves.toEqual([firstProject]);

    const afterUndoSnapshots = await readdir(historyDir);
    expect(afterUndoSnapshots).toHaveLength(1);
  });

  test("undo restores the newest snapshot deterministically after 10+ same-millisecond mutations", async () => {
    const store = createProjectStore({ dataDir: tempRoot });
    const dateNow = vi.spyOn(Date, "now").mockReturnValue(1_787_254_100_000);

    try {
      for (let index = 0; index < 12; index += 1) {
        await store.applyMutation({
          kind: "upsert",
          project: buildProject({
            id: `project-${index}`,
            name: `Project ${index}`,
            nextAction: `Action ${index}`
          })
        });
      }
    } finally {
      dateNow.mockRestore();
    }

    const twelfthProject = await store.get("project-11");
    expect(twelfthProject).not.toBeNull();

    const undoResult = await store.undoLastMutation();
    expect(undoResult.restored).toBe(true);
    expect(await store.get("project-11")).toBeNull();
    expect(await store.get("project-10")).toMatchObject({
      id: "project-10",
      name: "Project 10"
    });
    expect(undoResult.registry).toHaveLength(11);
  });

  test("compares same-millisecond snapshot filenames without numeric precision loss", () => {
    expect(
      compareSnapshotEntries(
        "1787254100000-00000011-projects.json",
        "1787254100000-00000012-projects.json"
      )
    ).toBeLessThan(0);
  });

  test("writes registry and snapshot files atomically without leaving temp files behind", async () => {
    const store = createProjectStore({ dataDir: tempRoot });

    await store.applyMutation({
      kind: "upsert",
      project: buildProject()
    });

    const historyDir = path.join(tempRoot, "history");
    const tempRootEntries = await readdir(tempRoot);
    const historyEntries = await readdir(historyDir);

    expect(tempRootEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    expect(historyEntries.some((entry) => entry.endsWith(".tmp"))).toBe(false);
    expect(historyEntries).toHaveLength(1);
    expect(existsSync(path.join(tempRoot, "projects.json"))).toBe(true);
  });

  test("serializes concurrent mutations so no update is lost", async () => {
    const store = createProjectStore({ dataDir: tempRoot });
    const firstProject = buildProject({ id: "project-a", name: "Project A" });
    const secondProject = buildProject({ id: "project-b", name: "Project B" });

    await Promise.all([
      store.applyMutation({ kind: "upsert", project: firstProject }),
      store.applyMutation({ kind: "upsert", project: secondProject })
    ]);

    expect(await store.list()).toEqual(expect.arrayContaining([firstProject, secondProject]));
  });

  test("exports canonical records as json, markdown, and csv without mutating the registry", async () => {
    const store = createProjectStore({ dataDir: tempRoot });
    const project = buildProject({
      rootPath: undefined,
      repositoryUrl: undefined,
      aliases: ["imported-row"],
      sources: [
        {
          kind: "import",
          label: "Imported CSV row",
          sourceId: "import-1:row-3",
          syncStatus: "success",
          lastSyncedAt: "2026-08-20T12:00:00.000Z"
        }
      ]
    });

    await store.applyMutation({ kind: "upsert", project });

    await expect(store.export("json")).resolves.toContain('"id": "project-1"');

    const markdown = await store.export("markdown");
    expect(markdown).toContain("# Project Registry");
    expect(markdown).toContain("Codex Project Management System");
    expect(markdown).toContain("Track current work across local tasks and sources.");
    expect(markdown).toContain("Task 2 is wiring the shared registry store.");
    expect(markdown).toContain("Finish persistence and export coverage.");
    expect(markdown).toContain("Status: Plan");
    expect(markdown).toContain("Imported CSV row");
    expect(markdown).toContain("Workspace root");
    expect(markdown).toContain("Task brief");

    const csv = await store.export("csv");
    expect(csv.split("\n", 1)[0]).toBe(
      "id,name,type,needStatus,userNeed,currentState,nextAction,rootPath,repositoryUrl,aliases,importantFiles,launchTargets,sources,missingItems,tags,suggestions,recentActivity,fieldProvenance,attentionFlags,lastActivityAt,lastSyncedAt,syncStatus,pinned,archived,updatedAt"
    );
    expect(csv).toContain("\"project-1\",\"Codex Project Management System\"");

    const csvPath = path.join(tempRoot, "export.csv");
    await writeFile(csvPath, csv, "utf8");
    const csvPreview = await new StructuredImportAdapter().preview({
      kind: "structured-file",
      path: csvPath,
      format: "csv",
      label: "Export validation"
    });
    expect(csvPreview.rows).toHaveLength(1);
    expect(csvPreview.rows[0].candidate).toMatchObject({
      name: project.name,
      userNeed: project.userNeed,
      currentState: project.currentState,
      nextAction: project.nextAction,
      aliases: ["imported-row"],
      launchTargets: expect.any(Array)
    });

    await expect(store.list()).resolves.toEqual([project]);
  });
});
