// @vitest-environment node

import { describe, expect, test } from "vitest";
import { matchProject } from "../../src/server/sync/identity";
import type { Project } from "../../src/shared/domain";

function buildProject(overrides: Record<string, unknown> = {}): Project {
  return {
    id: "project-1",
    name: "Codex Project Command Center",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Track project work across Codex outputs.",
    currentState: "A local app exists.",
    nextAction: "Implement identity rules.",
    rootPath: "/workspace/command-center",
    repositoryUrl: "https://github.com/example/command-center",
    aliases: ["command-center"],
    sources: [
      {
        kind: "codex",
        label: "Codex task",
        sourceId: "task-123",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T14:00:00.000Z"
      }
    ],
    launchTargets: [],
    lastActivityAt: "2026-08-20T14:00:00.000Z",
    lastSyncedAt: "2026-08-20T14:00:00.000Z",
    syncStatus: "success",
    updatedAt: "2026-08-20T14:00:00.000Z",
    ...overrides
  } as Project;
}

function buildCandidate(overrides: Record<string, unknown> = {}) {
  return {
    name: "Codex Project Command Center",
    rootPath: "/workspace/command-center",
    repositoryUrl: "https://github.com/example/command-center",
    aliases: ["command-center"],
    source: {
      kind: "codex",
      label: "Codex task",
      sourceId: "task-123",
      syncStatus: "success",
      observedAt: "2026-08-20T14:00:00.000Z"
    },
    evidence: [
      {
        kind: "source-id",
        value: "task-123"
      }
    ],
    verifiedAt: "2026-08-20T14:00:00.000Z",
    ...overrides
  };
}

describe("matchProject", () => {
  test("matches by existing source ID before considering any other evidence", () => {
    const projects = [
      buildProject({
        id: "project-source",
        rootPath: "/workspace/source",
        repositoryUrl: "https://github.com/example/source",
        aliases: ["source-project"],
        sources: [
          {
            kind: "codex",
            label: "Codex task",
            sourceId: "task-123",
            syncStatus: "success",
            lastSyncedAt: "2026-08-20T14:00:00.000Z"
          }
        ]
      }),
      buildProject({
        id: "project-root",
        rootPath: "/workspace/command-center",
        repositoryUrl: "https://github.com/example/command-center",
        aliases: ["command-center"],
        sources: []
      })
    ];

    const result = matchProject(buildCandidate(), projects);

    expect(result).toMatchObject({
      kind: "matched",
      confidence: "high",
      projectId: "project-source",
      reason: "source-id"
    });
    expect(result.evidence).toEqual([
      {
        kind: "source-id",
        value: "task-123"
      }
    ]);
  });

  test("matches by exact root path when no source ID match exists", () => {
    const result = matchProject(
      buildCandidate({
        source: {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "scan-1",
          syncStatus: "success",
          observedAt: "2026-08-20T14:00:00.000Z"
        },
        evidence: [
          {
            kind: "root-path",
            value: "/workspace/command-center"
          }
        ]
      }),
      [
        buildProject({
          id: "project-root",
          rootPath: "/workspace/command-center",
          repositoryUrl: "https://github.com/example/other",
          aliases: ["other-project"],
          sources: []
        })
      ]
    );

    expect(result).toMatchObject({
      kind: "matched",
      confidence: "high",
      projectId: "project-root",
      reason: "root-path"
    });
  });

  test("returns needs-review when more than one project shares the same source ID", () => {
    const result = matchProject(buildCandidate(), [
      buildProject({
        id: "project-a",
        rootPath: "/workspace/a",
        repositoryUrl: "https://github.com/example/a"
      }),
      buildProject({
        id: "project-b",
        rootPath: "/workspace/b",
        repositoryUrl: "https://github.com/example/b"
      })
    ]);

    expect(result).toMatchObject({
      kind: "needs-review",
      confidence: "low",
      reason: "source-id-conflict",
      projectId: null,
      duplicateProjectIds: ["project-a", "project-b"]
    });
    expect(result.evidence).toEqual([
      {
        kind: "source-id",
        value: "task-123"
      }
    ]);
  });

  test("matches by exact repository URL when root path is absent", () => {
    const result = matchProject(
      buildCandidate({
        rootPath: undefined,
        repositoryUrl: "https://github.com/example/command-center",
        source: {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "scan-1",
          syncStatus: "success",
          observedAt: "2026-08-20T14:00:00.000Z"
        },
        evidence: [
          {
            kind: "repository-url",
            value: "https://github.com/example/command-center"
          }
        ]
      }),
      [
        buildProject({
          id: "project-repo",
          rootPath: undefined,
          repositoryUrl: "https://github.com/example/command-center",
          aliases: ["other-project"],
          sources: []
        })
      ]
    );

    expect(result).toMatchObject({
      kind: "matched",
      confidence: "high",
      projectId: "project-repo",
      reason: "repository-url"
    });
  });

  test("returns needs-review when more than one project shares the same root path", () => {
    const result = matchProject(
      buildCandidate({
        source: {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "scan-1",
          syncStatus: "success",
          observedAt: "2026-08-20T14:00:00.000Z"
        },
        evidence: [
          {
            kind: "root-path",
            value: "/workspace/command-center"
          }
        ]
      }),
      [
        buildProject({
          id: "project-a",
          repositoryUrl: "https://github.com/example/a",
          aliases: ["a"],
          sources: []
        }),
        buildProject({
          id: "project-b",
          repositoryUrl: "https://github.com/example/b",
          aliases: ["b"],
          sources: []
        })
      ]
    );

    expect(result).toMatchObject({
      kind: "needs-review",
      confidence: "low",
      reason: "root-path-conflict",
      projectId: null,
      duplicateProjectIds: ["project-a", "project-b"]
    });
  });

  test("returns needs-review when more than one project shares the same repository URL", () => {
    const result = matchProject(
      buildCandidate({
        rootPath: undefined,
        repositoryUrl: "https://github.com/example/command-center",
        source: {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "scan-1",
          syncStatus: "success",
          observedAt: "2026-08-20T14:00:00.000Z"
        },
        evidence: [
          {
            kind: "repository-url",
            value: "https://github.com/example/command-center"
          }
        ]
      }),
      [
        buildProject({
          id: "project-a",
          rootPath: undefined,
          aliases: ["a"],
          repositoryUrl: "https://github.com/example/command-center",
          sources: []
        }),
        buildProject({
          id: "project-b",
          rootPath: undefined,
          aliases: ["b"],
          repositoryUrl: "https://github.com/example/command-center",
          sources: []
        })
      ]
    );

    expect(result).toMatchObject({
      kind: "needs-review",
      confidence: "low",
      reason: "repository-url-conflict",
      projectId: null,
      duplicateProjectIds: ["project-a", "project-b"]
    });
  });

  test("matches by unique exact alias when source, root, and repository are inconclusive", () => {
    const result = matchProject(
      buildCandidate({
        rootPath: undefined,
        repositoryUrl: undefined,
        aliases: ["command-center"],
        evidence: [
          {
            kind: "alias",
            value: "command-center"
          }
        ]
      }),
      [
        buildProject({
          id: "project-alias",
          rootPath: "/workspace/another",
          repositoryUrl: "https://github.com/example/another",
          aliases: ["command-center"],
          sources: []
        })
      ]
    );

    expect(result).toMatchObject({
      kind: "matched",
      confidence: "medium",
      projectId: "project-alias",
      reason: "alias"
    });
  });

  test("returns needs-review when an alias matches multiple projects", () => {
    const result = matchProject(
      buildCandidate({
        rootPath: undefined,
        repositoryUrl: undefined,
        aliases: ["command-center"],
        evidence: [
          {
            kind: "alias",
            value: "command-center"
          }
        ]
      }),
      [
        buildProject({
          id: "project-a",
          rootPath: "/workspace/a",
          repositoryUrl: "https://github.com/example/a",
          aliases: ["command-center"],
          sources: []
        }),
        buildProject({
          id: "project-b",
          rootPath: "/workspace/b",
          repositoryUrl: "https://github.com/example/b",
          aliases: ["command-center"],
          sources: []
        })
      ]
    );

    expect(result).toMatchObject({
      kind: "needs-review",
      confidence: "low",
      reason: "alias-conflict",
      projectId: null,
      duplicateProjectIds: ["project-a", "project-b"]
    });
  });

  test("returns needs-review without creating a project when no confident match exists", () => {
    const result = matchProject(
      buildCandidate({
        source: {
          kind: "workspace",
          label: "Workspace scan",
          sourceId: "scan-new",
          syncStatus: "success",
          observedAt: "2026-08-20T14:00:00.000Z"
        },
        rootPath: undefined,
        repositoryUrl: undefined,
        aliases: ["new-project"],
        evidence: [
          {
            kind: "alias",
            value: "new-project"
          }
        ]
      }),
      [buildProject()]
    );

    expect(result).toMatchObject({
      kind: "needs-review",
      confidence: "low",
      reason: "no-confident-match",
      projectId: null
    });
    expect(result.evidence).toEqual([
      {
        kind: "alias",
        value: "new-project"
      }
    ]);
  });
});
