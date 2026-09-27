// @vitest-environment node

import { describe, expect, test } from "vitest";
import {
  DEFAULT_STALE_AFTER_DAYS,
  deriveAttentionFlags,
  mergeCandidate
} from "../../src/server/sync/merge";
import type { Project } from "../../src/shared/domain";

function buildProject(overrides: Record<string, unknown> = {}): Project {
  return {
    id: "project-1",
    name: "Codex Project Command Center",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Track project work across Codex outputs.",
    currentState: "The app exists with a basic registry.",
    nextAction: "Implement identity rules.",
    rootPath: "/workspace/command-center",
    repositoryUrl: "https://github.com/example/command-center",
    aliases: ["command-center"],
    sources: [
      {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: "workspace-1",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T14:00:00.000Z"
      }
    ],
    launchTargets: [
      {
        kind: "folder",
        id: "root",
        label: "Open folder",
        path: "/workspace/command-center"
      }
    ],
    importantFiles: ["README.md"],
    missingItems: [],
    tags: ["codex"],
    fieldProvenance: {
      name: {
        sourceLabel: "Workspace scan",
        sourceId: "workspace-1",
        updatedAt: "2026-08-20T14:00:00.000Z"
      },
      rootPath: {
        sourceLabel: "Workspace scan",
        sourceId: "workspace-1",
        updatedAt: "2026-08-20T14:00:00.000Z"
      }
    },
    attentionFlags: [],
    lastActivityAt: "2026-08-20T14:00:00.000Z",
    lastSyncedAt: "2026-08-20T14:00:00.000Z",
    syncStatus: "success",
    suggestions: [],
    recentActivity: [],
    updatedAt: "2026-08-20T14:00:00.000Z",
    archived: false,
    pinned: false,
    ...overrides
  } as Project;
}

function buildCandidate(overrides: Record<string, unknown> = {}) {
  return {
    name: "Codex Project Command Center",
    type: "web-app",
    needStatus: "Need",
    userNeed: "Consolidate Codex work into one product record.",
    currentState: "The app now includes merge logic and sync history.",
    nextAction: "Review generated suggestions.",
    rootPath: "/workspace/command-center-renamed",
    repositoryUrl: "https://github.com/example/command-center",
    aliases: ["command-center", "project-command-center"],
    launchTargets: [
      {
        kind: "folder",
        id: "root",
        label: "Open folder",
        path: "/workspace/command-center-renamed"
      },
      {
        kind: "url",
        id: "local-app",
        label: "Open app",
        url: "http://127.0.0.1:4173"
      }
    ],
    importantFiles: ["README.md", "docs/spec.md"],
    missingItems: ["Confirm the next task owner."],
    tags: ["codex", "dashboard"],
    source: {
      kind: "workspace",
      label: "Workspace scan",
      sourceId: "workspace-1",
      syncStatus: "success",
      observedAt: "2026-08-20T15:00:00.000Z"
    },
    evidence: [
      {
        kind: "root-path",
        value: "/workspace/command-center-renamed"
      }
    ],
    verifiedAt: "2026-08-20T15:00:00.000Z",
    lastActivityAt: "2026-08-20T15:00:00.000Z",
    ...overrides
  };
}

describe("mergeCandidate", () => {
  test("updates verified facts immediately and records field provenance", () => {
    const result = mergeCandidate(buildProject(), buildCandidate());

    expect(result.project).toMatchObject({
      rootPath: "/workspace/command-center-renamed",
      repositoryUrl: "https://github.com/example/command-center",
      aliases: ["command-center", "project-command-center"],
      importantFiles: ["README.md", "docs/spec.md"],
      missingItems: ["Confirm the next task owner."],
      tags: ["codex", "dashboard"],
      lastActivityAt: "2026-08-20T15:00:00.000Z",
      lastSyncedAt: "2026-08-20T15:00:00.000Z",
      syncStatus: "success"
    });
    expect(result.project.fieldProvenance.rootPath).toMatchObject({
      sourceId: "workspace-1",
      sourceLabel: "Workspace scan",
      updatedAt: "2026-08-20T15:00:00.000Z"
    });
    expect(result.project.fieldProvenance.launchTargets).toMatchObject({
      sourceId: "workspace-1",
      sourceLabel: "Workspace scan",
      updatedAt: "2026-08-20T15:00:00.000Z"
    });
    expect(result.project.sources).toEqual([
      {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: "workspace-1",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T15:00:00.000Z"
      }
    ]);
  });

  test("preserves manual intent fields and creates suggestions instead of overwriting them", () => {
    const result = mergeCandidate(
      buildProject({
        needStatus: "Plan",
        userNeed: "Track project work across Codex outputs.",
        currentState: "The app exists with a basic registry.",
        nextAction: "Implement identity rules."
      }),
      buildCandidate()
    );

    expect(result.project).toMatchObject({
      needStatus: "Plan",
      userNeed: "Track project work across Codex outputs.",
      currentState: "The app exists with a basic registry.",
      nextAction: "Implement identity rules."
    });
    expect(result.suggestions).toHaveLength(4);
    expect(result.suggestions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          field: "needStatus",
          currentValue: "Plan",
          proposedValue: "Need"
        }),
        expect.objectContaining({
          field: "userNeed",
          currentValue: "Track project work across Codex outputs.",
          proposedValue: "Consolidate Codex work into one product record."
        }),
        expect.objectContaining({
          field: "currentState",
          currentValue: "The app exists with a basic registry.",
          proposedValue: "The app now includes merge logic and sync history."
        }),
        expect.objectContaining({
          field: "nextAction",
          currentValue: "Implement identity rules.",
          proposedValue: "Review generated suggestions."
        })
      ])
    );
  });

  test("preserves the last verified values when the source is unavailable", () => {
    const result = mergeCandidate(
      buildProject({
        rootPath: "/workspace/command-center",
        launchTargets: [
          {
            kind: "folder",
            id: "root",
            label: "Open folder",
            path: "/workspace/command-center"
          }
        ],
        fieldProvenance: {
          rootPath: {
            sourceLabel: "Workspace scan",
            sourceId: "workspace-1",
            updatedAt: "2026-08-19T13:00:00.000Z"
          },
          launchTargets: {
            sourceLabel: "Workspace scan",
            sourceId: "workspace-1",
            updatedAt: "2026-08-19T13:00:00.000Z"
          }
        }
      }),
      buildCandidate({
        rootPath: undefined,
        launchTargets: [],
        source: {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "workspace-1",
          syncStatus: "unavailable",
          observedAt: "2026-08-20T16:00:00.000Z",
          unavailableReason: "Folder is offline."
        },
        unavailableFields: ["rootPath", "launchTargets"]
      })
    );

    expect(result.project.rootPath).toBe("/workspace/command-center");
    expect(result.project.launchTargets).toEqual([
      {
        kind: "folder",
        id: "root",
        label: "Open folder",
        path: "/workspace/command-center"
      }
    ]);
    expect(result.project.sources).toEqual([
      {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: "workspace-1",
        syncStatus: "unavailable",
        lastSyncedAt: "2026-08-20T16:00:00.000Z",
        unavailableReason: "Folder is offline."
      }
    ]);
  });
});

describe("deriveAttentionFlags", () => {
  test("derives stale, sync-failed, unverified, and needs-review flags from project state", () => {
    const project = buildProject({
      suggestions: [
        {
          kind: "field-update",
          id: "suggestion-1",
          field: "currentState",
          title: "Review currentState",
          detail: "Workspace scan proposed a new currentState.",
          currentValue: "The app exists with a basic registry.",
          proposedValue: "The app now includes merge logic and sync history.",
          evidence: [
            {
              kind: "root-path",
              value: "/workspace/command-center"
            }
          ],
          createdAt: "2026-08-20T15:00:00.000Z"
        }
      ],
      lastActivityAt: "2026-07-01T00:00:00.000Z",
      syncStatus: "failed",
      fieldProvenance: {
        name: {
          sourceLabel: "Workspace scan",
          sourceId: "workspace-1",
          updatedAt: "2026-08-20T14:00:00.000Z"
        }
      },
      sources: [
        {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "workspace-1",
          syncStatus: "failed",
          lastSyncedAt: "2026-08-20T14:00:00.000Z"
        }
      ]
    });

    expect(
      deriveAttentionFlags(project, new Date("2026-08-20T00:00:00.000Z"), DEFAULT_STALE_AFTER_DAYS)
    ).toEqual(["needs-review", "stale", "sync-failed", "unverified"]);
  });

  test("skips stale for archived projects and honors a custom stale threshold", () => {
    const project = buildProject({
      archived: true,
      lastActivityAt: "2026-08-01T00:00:00.000Z",
      syncStatus: "success",
      fieldProvenance: {
        name: {
          sourceLabel: "Workspace scan",
          sourceId: "workspace-1",
          updatedAt: "2026-08-20T14:00:00.000Z"
        },
        userNeed: {
          sourceLabel: "Manual",
          updatedAt: "2026-08-20T14:00:00.000Z",
          manual: true
        }
      },
      sources: [
        {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "workspace-1",
          syncStatus: "success",
          lastSyncedAt: "2026-08-20T14:00:00.000Z"
        }
      ]
    });

    expect(
      deriveAttentionFlags(project, new Date("2026-08-20T00:00:00.000Z"), 7)
    ).toEqual([]);
  });

  test("clears resolved flags instead of carrying prior attention flags forward", () => {
    const project = buildProject({
      attentionFlags: ["needs-review", "stale", "sync-failed", "unverified"],
      lastActivityAt: "2026-08-20T00:00:00.000Z",
      syncStatus: "success",
      suggestions: [],
      sources: [
        {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "workspace-1",
          syncStatus: "success",
          lastSyncedAt: "2026-08-20T14:00:00.000Z"
        }
      ]
    });

    expect(
      deriveAttentionFlags(project, new Date("2026-08-20T12:00:00.000Z"), DEFAULT_STALE_AFTER_DAYS)
    ).toEqual([]);
  });

  test("derives needs-review from current unresolved suggestions", () => {
    const project = buildProject({
      attentionFlags: [],
      suggestions: [
        {
          kind: "field-update",
          id: "suggestion-1",
          field: "nextAction",
          title: "Review nextAction",
          detail: "Workspace scan proposed a new nextAction.",
          currentValue: "Implement identity rules.",
          proposedValue: "Review generated suggestions.",
          evidence: [
            {
              kind: "root-path",
              value: "/workspace/command-center"
            }
          ],
          createdAt: "2026-08-20T15:00:00.000Z"
        }
      ]
    });

    expect(
      deriveAttentionFlags(project, new Date("2026-08-20T15:10:00.000Z"), DEFAULT_STALE_AFTER_DAYS)
    ).toEqual(["needs-review"]);
  });
});
