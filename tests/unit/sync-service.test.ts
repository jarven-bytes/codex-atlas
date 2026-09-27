// @vitest-environment node

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { createProjectStore } from "../../src/server/store/project-store";
import { createSyncService } from "../../src/server/sync/sync-service";
import type { CodexActivityEvent } from "../../src/shared/domain";

function buildEvent(overrides: Partial<CodexActivityEvent>): CodexActivityEvent {
  return {
    taskId: "review-task",
    workingDirectory: "/workspace/review-a",
    summary: "Review evidence needs a human decision.",
    changedPaths: ["docs/review.md"],
    ...overrides
  };
}

describe("SyncService", () => {
  let tempRoot: string | undefined;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
      tempRoot = undefined;
    }
  });

  test("scans configured roots through the shared service and persists uncertain review evidence", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "sync-service-"));
    const workspaceRoot = path.join(tempRoot, "unmatched-project");
    const dataDir = path.join(tempRoot, "data");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(path.join(workspaceRoot, "README.md"), "# Unmatched Project\n");
    await writeFile(path.join(workspaceRoot, "package.json"), JSON.stringify({ name: "unmatched-project" }));

    const service = createSyncService({
      store: createProjectStore({ dataDir }),
      dataDir,
      workspaceRoots: [workspaceRoot]
    });
    const outcomes = await Promise.all([service.scanRoots(), service.scanRoots()]);
    const outcome = outcomes[0];

    expect(outcome.scannedRoots).toEqual([workspaceRoot]);
    expect(outcome.updatedProjectIds).toEqual([]);
    expect(outcome.reviewIds).toHaveLength(1);
    expect(outcomes[1].reviewIds).toEqual(outcome.reviewIds);
    expect(await service.listReviews()).toEqual([
      expect.objectContaining({
        kind: "workspace-scan",
        reason: "no-confident-match",
        evidence: expect.arrayContaining([
          expect.objectContaining({ kind: "root-path", value: workspaceRoot })
        ])
      })
    ]);
    expect(JSON.parse(await readFile(path.join(dataDir, "sync-reviews.json"), "utf8"))).toHaveLength(1);
  });

  test("serializes concurrent review writes without losing evidence", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "sync-review-queue-"));
    const dataDir = path.join(tempRoot, "data");
    const service = createSyncService({
      store: createProjectStore({ dataDir }),
      dataDir,
      workspaceRoots: []
    });

    await Promise.all([
      service.syncCodexEvent(buildEvent({
        taskId: "review-a",
        workingDirectory: "/workspace/review-a",
        sourceId: "codex:review-a"
      })),
      service.syncCodexEvent(buildEvent({
        taskId: "review-b",
        workingDirectory: "/workspace/review-b",
        sourceId: "codex:review-b"
      }))
    ]);

    const reviews = await service.listReviews();
    expect(reviews).toHaveLength(2);
    expect(reviews.map((review) => review.taskId)).toEqual(expect.arrayContaining(["review-a", "review-b"]));
    expect(JSON.parse(await readFile(path.join(dataDir, "sync-reviews.json"), "utf8"))).toHaveLength(2);
  });
});
