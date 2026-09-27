// @vitest-environment node

import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { syncCodexEvent } from "../../src/server/sync/codex-events";
import { createProjectStore } from "../../src/server/store/project-store";
import type { ProjectStore } from "../../src/server/store/project-store";
import type { CodexActivityEvent, Project } from "../../src/shared/domain";

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Project Atlas",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Track local work across Codex tasks.",
    currentState: "Base registry exists.",
    nextAction: "Connect sync flows.",
    rootPath: "/workspace/project-atlas",
    repositoryUrl: "https://github.com/example/project-atlas",
    aliases: ["project-atlas"],
    launchTargets: [
      {
        kind: "folder",
        id: "workspace-root",
        label: "Workspace root",
        path: "/workspace/project-atlas"
      }
    ],
    sources: [
      {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: "workspace:/workspace/project-atlas",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T11:00:00.000Z"
      }
    ],
    importantFiles: ["README.md", "package.json"],
    missingItems: [],
    tags: ["codex"],
    suggestions: [],
    recentActivity: [],
    fieldProvenance: {},
    attentionFlags: [],
    lastActivityAt: "2026-08-20T11:00:00.000Z",
    lastSyncedAt: "2026-08-20T11:00:00.000Z",
    syncStatus: "success",
    updatedAt: "2026-08-20T11:00:00.000Z",
    pinned: false,
    archived: false,
    ...overrides
  };
}

function buildEvent(overrides: Partial<CodexActivityEvent> = {}): CodexActivityEvent {
  return {
    taskId: "task-123",
    workingDirectory: "/workspace/project-atlas",
    summary: "Implemented sync CLI and watcher support.",
    changedPaths: ["src/server/sync/scanner.ts", "src/server/main.ts"],
    sourceId: "codex-task-123",
    ...overrides
  };
}

describe("syncCodexEvent", () => {
  let tempRoot: string;
  let store: ProjectStore;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-events-"));
    store = createProjectStore({ dataDir: tempRoot });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("persists review evidence for meaningful activity without a confident match", async () => {
    const result = await syncCodexEvent(
      buildEvent({
        workingDirectory: "/workspace/new-atlas",
        summary: "Built the first local project scanner for Atlas."
      }),
      store
    );

    expect(result).toMatchObject({
      mutation: "none",
      match: {
        kind: "needs-review",
        reason: "no-confident-match"
      },
      project: null,
      reviewItem: expect.objectContaining({
        taskId: "task-123",
        evidence: expect.any(Array)
      })
    });
  });

  test("matches follow-up activity to an existing root and preserves protected manual fields", async () => {
    await store.applyMutation({
      kind: "upsert",
      project: buildProject({
        userNeed: "Preserve the manual intent.",
        currentState: "Waiting on task 4.",
        nextAction: "Review the next sync."
      })
    });

    const result = await syncCodexEvent(
      buildEvent({
        summary: "Completed local watcher integration and refreshed the current state."
      }),
      store
    );

    expect(result.match).toMatchObject({
      kind: "matched",
      reason: "root-path"
    });
    expect(result.project).toMatchObject({
      id: "project-1",
      userNeed: "Preserve the manual intent.",
      currentState: "Waiting on task 4.",
      nextAction: "Review the next sync."
    });
    expect(result.project?.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "currentState",
          proposedValue: "Completed local watcher integration and refreshed the current state."
        })
      ])
    );
  });

  test("records milestone activity and changed paths on the matched project", async () => {
    await store.applyMutation({
      kind: "upsert",
      project: buildProject()
    });

    const result = await syncCodexEvent(
      buildEvent({
        milestone: "Task 4 shipped",
        changedPaths: ["src/server/sync/codex-events.ts", "bin/codex-project-sync.ts"]
      }),
      store
    );

    expect(result.project?.tags).toEqual(expect.arrayContaining(["codex", "task-4-shipped"]));
    expect(result.project?.importantFiles).toEqual(
      expect.arrayContaining(["README.md", "package.json", "src/server/sync/codex-events.ts"])
    );
    expect(result.project?.recentActivity).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "status-change",
          message: "Task 4 shipped"
        })
      ])
    );
  });

  test("ignores summary-only activity without durable evidence and does not create a project", async () => {
    const result = await syncCodexEvent(
      buildEvent({
        workingDirectory: "/workspace/summary-only",
        summary: "Talked through a possible next step.",
        changedPaths: [],
        milestone: undefined
      }),
      store
    );

    expect(result).toMatchObject({
      mutation: "none",
      project: null,
      match: {
        kind: "ignored",
        reason: "no-meaningful-activity"
      }
    });
    expect(await store.list()).toEqual([]);
  });

  test("accepts a summary-only decision event as meaningful activity", async () => {
    const result = await syncCodexEvent(
      buildEvent({
        workingDirectory: "/workspace/decision-only",
        summary: "Chose the local scanner approach.",
        changedPaths: [],
        milestone: undefined,
        decisionOrBlocker: "decision"
      }),
      store
    );

    expect(result).toMatchObject({
      mutation: "none",
      match: {
        kind: "needs-review",
        reason: "no-confident-match"
      },
      project: null,
      reviewItem: expect.objectContaining({ decisionOrBlocker: "decision" })
    });
  });

  test("accepts a summary-only blocker event as meaningful activity", async () => {
    const result = await syncCodexEvent(
      buildEvent({
        workingDirectory: "/workspace/blocker-only",
        summary: "Blocked on connector approval.",
        changedPaths: [],
        milestone: undefined,
        decisionOrBlocker: "blocker"
      }),
      store
    );

    expect(result).toMatchObject({
      mutation: "none",
      match: {
        kind: "needs-review",
        reason: "no-confident-match"
      },
      project: null,
      reviewItem: expect.objectContaining({ decisionOrBlocker: "blocker" })
    });
  });

  test("does not derive aliases from summary words when matching identity", async () => {
    await store.applyMutation({
      kind: "upsert",
      project: buildProject({
        id: "project-a",
        rootPath: "/workspace/other-root",
        aliases: ["atlas"]
      })
    });

    const result = await syncCodexEvent(
      buildEvent({
        workingDirectory: "/workspace/unmatched-root",
        summary: "Atlas planning discussion only.",
        changedPaths: ["docs/notes.md"],
        sourceId: undefined
      }),
      store
    );

    expect(result).toMatchObject({
      mutation: "none",
      match: {
        kind: "needs-review",
        reason: "no-confident-match"
      }
    });
  });

  test("creates a review item instead of mutating a project when the event is not confidently matched", async () => {
    await store.applyMutation({
      kind: "upsert",
      project: buildProject({
        id: "project-a",
        aliases: ["atlas"]
      })
    });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject({
        id: "project-b",
        rootPath: "/workspace/other-atlas",
        repositoryUrl: "https://github.com/example/other-atlas",
        aliases: ["atlas"]
      })
    });

    const result = await syncCodexEvent(
      buildEvent({
        workingDirectory: "/workspace/ambiguous",
        summary: "Updated atlas documentation.",
        changedPaths: ["docs/atlas.md"],
        sourceId: undefined
      }),
      store
    );

    expect(result).toMatchObject({
      mutation: "none",
      match: {
        kind: "needs-review",
        reason: "no-confident-match",
        duplicateProjectIds: []
      },
      project: null
    });
    expect(result.reviewItem).toMatchObject({
      kind: "codex-event",
      taskId: "task-123",
      workingDirectory: "/workspace/ambiguous"
    });
  });

  test("serializes concurrent syncs so both source facts survive on one project", async () => {
    await store.applyMutation({
      kind: "upsert",
      project: buildProject()
    });

    await Promise.all([
      syncCodexEvent(
        buildEvent({
          sourceId: "source-a",
          summary: "Source A completed the registry synchronization.",
          changedPaths: ["src/server/sync/source-a.ts"]
        }),
        store
      ),
      syncCodexEvent(
        buildEvent({
          sourceId: "source-b",
          summary: "Source B completed the registry synchronization.",
          changedPaths: ["src/server/sync/source-b.ts"]
        }),
        store
      )
    ]);

    const project = await store.get("project-1");
    expect(project?.sources).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceId: "source-a" }),
      expect.objectContaining({ sourceId: "source-b" })
    ]));
    expect(project?.importantFiles).toEqual(expect.arrayContaining([
      "src/server/sync/source-a.ts",
      "src/server/sync/source-b.ts"
    ]));
  });
});
