// @vitest-environment node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createImportService } from "../../src/server/imports/import-service";
import type { ImportSource } from "../../src/server/imports/types";
import type { ProcessState } from "../../src/server/launch/process-manager";
import type { ProjectStore } from "../../src/server/store/project-store";
import { createProjectStore } from "../../src/server/store/project-store";
import type { CodexActivityEvent, LaunchTarget, Project, Suggestion } from "../../src/shared/domain";
import { createApiHandler } from "../../src/server/api";
import { discoverInstalledSkills } from "../../src/server/skills/skills-service";

type ApiHandler = ReturnType<typeof createApiHandler>;

function buildSuggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  return {
    kind: "field-update",
    id: "suggestion-1",
    field: "nextAction",
    title: "Review the API route implementation",
    detail: "The watcher should be started after the server binds.",
    currentValue: "Keep the current route stub.",
    proposedValue: "Wire the HTTP API and start the watcher after listen.",
    evidence: [
      {
        kind: "source-id",
        value: "codex:task-7"
      }
    ],
    createdAt: "2026-08-20T12:30:00.000Z",
    ...overrides
  };
}

function buildProject(launchTargets: LaunchTarget[], overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Project Atlas",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Expose the local project API.",
    currentState: "The registry exists but the API layer is missing.",
    nextAction: "Implement the Task 7 API routes.",
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
    suggestions: [buildSuggestion()],
    recentActivity: [
      {
        kind: "note",
        id: "activity-1",
        message: "Created by the Task 7 API fixture.",
        createdAt: "2026-08-20T12:31:00.000Z"
      }
    ],
    fieldProvenance: {},
    attentionFlags: ["needs-review"],
    syncStatus: "success",
    lastActivityAt: "2026-08-20T12:00:00.000Z",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    updatedAt: "2026-08-20T12:00:00.000Z",
    pinned: false,
    archived: false,
    ...overrides
  };
}

async function invokeApi(
  handler: ApiHandler,
  options: {
    method: string;
    pathname: string;
    body?: string;
    headers?: Record<string, string>;
  }
): Promise<{
    status: number;
    headers: Map<string, string>;
    text: string;
    json: unknown;
  }> {
  const request = Object.assign(
    Readable.from(options.body === undefined ? [] : [options.body]),
    {
      method: options.method,
      url: options.pathname,
      headers: {
        host: "127.0.0.1",
        ...(options.headers ?? {})
      }
    }
  );

  const headers = new Map<string, string>();
  let text = "";
  const response = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
      return this;
    },
    end(chunk?: string | Buffer) {
      text = chunk === undefined ? "" : chunk.toString();
      return this;
    }
  };

  await handler(
    request as never,
    response as never
  );

  return {
    status: response.statusCode,
    headers,
    text,
    json: headers.get("content-type")?.includes("application/json") && text
      ? JSON.parse(text)
      : null
  };
}

describe("HTTP API", () => {
  let tempRoot: string;
  let store: ProjectStore;
  let importService: ReturnType<typeof createImportService>;
  let handler: ApiHandler;
  let stopProcess: ReturnType<typeof vi.fn>;
  let launchTarget: ReturnType<typeof vi.fn>;
  let syncEvent: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "api-server-"));
    store = createProjectStore({ dataDir: path.join(tempRoot, "data") });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject([
        {
          kind: "folder",
          id: "workspace-root",
          label: "Workspace root",
          path: tempRoot
        },
        {
          kind: "command",
          id: "dev-server",
          label: "Dev server",
          origin: "manual",
          executable: "npm",
          args: ["run", "dev"],
          cwd: tempRoot,
          port: 4173
        }
      ])
    });

    importService = createImportService({
      store,
      dataDir: path.join(tempRoot, "data")
    });

    stopProcess = vi.fn().mockResolvedValue({
      processId: "process-1",
      status: "Stopped",
      command: {
        executable: "npm",
        args: ["run", "dev"],
        cwd: tempRoot,
        port: 4173
      },
      stdout: "",
      stderr: "",
      startedAt: "2026-08-20T12:50:00.000Z",
      endedAt: "2026-08-20T12:55:00.000Z"
    } satisfies ProcessState);

    launchTarget = vi.fn().mockResolvedValue({
      status: "approval-required",
      fingerprint: "launch-fingerprint"
    });

    syncEvent = vi.fn().mockImplementation(async (event: CodexActivityEvent) => {
      const project = buildProject(
        [
          {
            kind: "folder",
            id: "workspace-root",
            label: "Workspace root",
            path: tempRoot
          }
        ],
        {
          currentState: event.summary,
          suggestions: []
        }
      );

      await store.applyMutation({
        kind: "upsert",
        project
      });

      return {
        mutation: "upsert" as const,
        project,
        match: {
          kind: "matched" as const,
          projectId: project.id,
          project,
          confidence: "high" as const,
          reason: "root-path" as const,
          evidence: [
            {
              kind: "root-path" as const,
              value: event.workingDirectory
            }
          ]
        }
      };
    });

    handler = createApiHandler({
      store,
      importService,
      syncEvent,
      launchTarget,
      stopProcess,
      listSkills: (projects) => discoverInstalledSkills({
        projects,
        userSkillsRoot: path.join(tempRoot, "skills")
      }),
      logError: vi.fn()
    });
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("lists projects, fetches project detail, mutates suggestions and undo through the store, and exports registry formats", async () => {
    const listResponse = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/projects"
    });
    expect(listResponse.status).toBe(200);
    expect(listResponse.json).toMatchObject({
      projects: [
        expect.objectContaining({
          id: "project-1",
          name: "Project Atlas"
        })
      ]
    });

    const detailResponse = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/projects/project-1"
    });
    expect(detailResponse.status).toBe(200);
    expect(detailResponse.json).toMatchObject({
      project: expect.objectContaining({
        id: "project-1",
        suggestions: [expect.objectContaining({ id: "suggestion-1" })]
      })
    });

    const acceptResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/suggestions/suggestion-1/accept",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(acceptResponse.status).toBe(200);
    expect((acceptResponse.json as { project: Project }).project.nextAction).toBe(
      "Wire the HTTP API and start the watcher after listen."
    );
    expect((acceptResponse.json as { project: Project }).project.suggestions).toEqual([]);
    expect((acceptResponse.json as { projects: Project[] }).projects[0].nextAction).toBe(
      "Wire the HTTP API and start the watcher after listen."
    );

    await store.applyMutation({
      kind: "upsert",
      project: buildProject(
        [
          {
            kind: "folder",
            id: "workspace-root",
            label: "Workspace root",
            path: tempRoot
          }
        ],
        {
          suggestions: [
            buildSuggestion({
              id: "suggestion-2",
              field: "currentState",
              currentValue: "The registry exists but the API layer is missing.",
              proposedValue: "The HTTP API is ready for wiring.",
              title: "Promote the new current state"
            })
          ]
        }
      )
    });

    const dismissResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/suggestions/suggestion-2/dismiss",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(dismissResponse.status).toBe(200);
    expect((dismissResponse.json as { project: Project }).project.suggestions).toEqual([]);
    expect((dismissResponse.json as { project: Project }).project.currentState).toBe(
      "The registry exists but the API layer is missing."
    );

    const undoResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/undo",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(undoResponse.status).toBe(200);
    expect((undoResponse.json as { result: { restored: boolean } }).result.restored).toBe(true);
    expect((undoResponse.json as { projects: Project[] }).projects[0].suggestions).toHaveLength(1);

    const jsonExport = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/export/json"
    });
    expect(jsonExport.status).toBe(200);
    expect(jsonExport.headers.get("content-type")).toContain("application/json");
    expect(jsonExport.text).toContain("\"Project Atlas\"");

    const markdownExport = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/export/markdown"
    });
    expect(markdownExport.status).toBe(200);
    expect(markdownExport.text).toContain("# Project Registry");

    const csvExport = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/export/csv"
    });
    expect(csvExport.status).toBe(200);
    expect(csvExport.text).toContain("id,name,type,needStatus,userNeed,currentState,nextAction");
  });

  test("lists installed skills with summaries and project usage evidence", async () => {
    const skillDir = path.join(tempRoot, "skills", "fixture-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"),
      "---\nname: fixture-skill\ndescription: A self-contained API test skill.\n---\n");
    const skillsResponse = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/skills"
    });

    expect(skillsResponse.status).toBe(200);
    expect(skillsResponse.json).toEqual({
      skills: expect.arrayContaining([
        expect.objectContaining({
          name: "fixture-skill",
          summary: "A self-contained API test skill.",
          path: skillDir,
          source: "user",
          projects: expect.any(Array)
        })
      ])
    });
  });

  test("syncs events, previews and commits imports, launches projects, stops processes, and maps expected route errors", async () => {
    const syncResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/sync",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        taskId: "task-7",
        workingDirectory: tempRoot,
        summary: "Route layer sync completed.",
        changedPaths: ["src/server/api.ts"]
      } satisfies CodexActivityEvent)
    });
    expect(syncResponse.status).toBe(200);
    expect((syncResponse.json as { result: { project: Project } }).result.project.currentState).toBe("Route layer sync completed.");
    expect(syncEvent).toHaveBeenCalledTimes(1);

    const importRoot = path.join(tempRoot, "import-atlas");
    await mkdir(path.join(importRoot, ".git"), { recursive: true });
    await writeFile(
      path.join(importRoot, "PROJECT_TEMPLATE.md"),
      [
        "# Import Atlas",
        "",
        "## User Need",
        "Load projects from a local folder.",
        "",
        "## Current State",
        "The import fixture is ready.",
        "",
        "## Next Action",
        "Commit the preview."
      ].join("\n")
    );
    await writeFile(
      path.join(importRoot, ".git", "config"),
      "[remote \"origin\"]\n\turl = git@github.com:example/import-atlas.git\n"
    );
    await writeFile(
      path.join(importRoot, "package.json"),
      JSON.stringify({
        name: "import-atlas",
        scripts: {
          dev: "vite"
        }
      })
    );

    const previewResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/import/preview",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source: {
          kind: "local-folder",
          path: importRoot,
          label: "Import fixture"
        } satisfies ImportSource
      })
    });
    expect(previewResponse.status).toBe(200);
    expect((previewResponse.json as { preview: { rows: Array<{ action: string }> } }).preview.rows[0].action).toBe("create");

    const previewId = (previewResponse.json as { preview: { id: string } }).preview.id;
    const commitResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/import/commit",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        previewId
      })
    });
    expect(commitResponse.status).toBe(200);
    expect((commitResponse.json as { result: { importedCount: number } }).result.importedCount).toBe(1);
    expect((commitResponse.json as { projects: Project[] }).projects).toHaveLength(2);

    const staleCommit = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/import/commit",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        previewId
      })
    });
    expect(staleCommit.status).toBe(409);
    expect((staleCommit.json as { error: { code: string; message: string } }).error).toMatchObject({
      code: "STALE_PREVIEW",
      message: expect.stringContaining(previewId)
    });

    const launchResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/launch/dev-server",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(launchResponse.status).toBe(200);
    expect((launchResponse.json as { result: { status: string; fingerprint: string } }).result).toMatchObject({
      status: "approval-required",
      fingerprint: "launch-fingerprint"
    });

    const stopResponse = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/processes/process-1/stop",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(stopResponse.status).toBe(200);
    expect((stopResponse.json as { process: ProcessState }).process.status).toBe("Stopped");
    expect(stopProcess).toHaveBeenCalledWith("process-1");

    const malformedJson = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/import/commit",
      headers: {
        "content-type": "application/json"
      },
      body: "{"
    });
    expect(malformedJson.status).toBe(400);
    expect(malformedJson.json).toMatchObject({
      error: {
        code: "INVALID_JSON",
        message: "Request body must be valid JSON."
      }
    });

    const tooLargeBody = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/import/commit",
      headers: {
        "content-type": "application/json",
        "content-length": String(JSON.stringify({
          previewId: "x".repeat(40_000)
        }).length)
      },
      body: JSON.stringify({
        previewId: "x".repeat(40_000)
      })
    });
    expect(tooLargeBody.status).toBe(400);
    expect(tooLargeBody.json).toMatchObject({
      error: {
        code: "REQUEST_BODY_TOO_LARGE",
        message: "Request body exceeded the configured limit."
      }
    });

    const missingProject = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/projects/missing-project"
    });
    expect(missingProject.status).toBe(404);
    expect(missingProject.json).toMatchObject({
      error: {
        code: "PROJECT_NOT_FOUND",
        message: "Project not found: missing-project"
      }
    });

    const missingSuggestion = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/suggestions/missing/accept",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(missingSuggestion.status).toBe(404);
    expect((missingSuggestion.json as { error: { code: string; message: string } }).error).toMatchObject({
      code: "SUGGESTION_NOT_FOUND",
      message: "Suggestion not found: project-1/missing"
    });

    launchTarget.mockRejectedValueOnce(Object.assign(new Error("Unknown launch target"), {
      code: "TARGET_NOT_FOUND"
    }));
    const unknownLaunch = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/launch/missing-target",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(unknownLaunch.status).toBe(404);
    expect((unknownLaunch.json as { error: { code: string; message: string } }).error).toMatchObject({
      code: "TARGET_NOT_FOUND"
    });

    stopProcess.mockRejectedValueOnce(Object.assign(new Error("Unknown process"), {
      code: "PROCESS_NOT_FOUND"
    }));
    const missingProcess = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/processes/missing-process/stop",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(missingProcess.status).toBe(404);
    expect((missingProcess.json as { error: { code: string; message: string } }).error).toMatchObject({
      code: "PROCESS_NOT_FOUND"
    });

    const invalidPreviewBody = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/import/preview",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        source: {
          kind: "unknown",
          path: importRoot,
          label: "Broken source"
        }
      })
    });
    expect(invalidPreviewBody.status).toBe(400);
    expect((invalidPreviewBody.json as { error: { code: string; message: string; details?: unknown } }).error).toMatchObject({
      code: "INVALID_REQUEST",
      message: "Request body did not match the expected shape."
    });
    expect((invalidPreviewBody.json as { error: { details: unknown } }).error.details).toEqual(
      expect.objectContaining({
        field: "source.kind"
      })
    );
  });

  test("returns 400 for malformed encoded route params and redacts unexpected API errors", async () => {
    const malformedDetail = await invokeApi(handler, {
      method: "GET",
      pathname: "/api/projects/%E0%A4%A"
    });
    expect(malformedDetail.status).toBe(400);
    expect(malformedDetail.json).toMatchObject({
      error: {
        code: "INVALID_ROUTE_PARAM",
        message: "Route parameters must be valid URL-encoded strings."
      }
    });

    const malformedSuggestion = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/suggestions/%E0%A4%A/accept",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(malformedSuggestion.status).toBe(400);
    expect(malformedSuggestion.json).toMatchObject({
      error: {
        code: "INVALID_ROUTE_PARAM",
        message: "Route parameters must be valid URL-encoded strings."
      }
    });

    const malformedLaunch = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/launch/%E0%A4%A",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(malformedLaunch.status).toBe(400);
    expect(malformedLaunch.json).toMatchObject({
      error: {
        code: "INVALID_ROUTE_PARAM",
        message: "Route parameters must be valid URL-encoded strings."
      }
    });

    launchTarget.mockRejectedValueOnce(
      new Error("secret-token sk_live_123 should never reach the client")
    );
    const leakedError = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/projects/project-1/launch/dev-server",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(leakedError.status).toBe(500);
    expect(leakedError.json).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error."
      }
    });
    expect(leakedError.text).not.toContain("sk_live_123");
  });

  test("redacts explicit 500 ApiError responses the same way as unexpected failures", async () => {
    const brokenStore: ProjectStore = {
      list: vi.fn().mockResolvedValue([
        buildProject([
          {
            kind: "folder",
            id: "workspace-root",
            label: "Workspace root",
            path: tempRoot
          }
        ])
      ]),
      get: vi.fn().mockResolvedValue(
        buildProject([
          {
            kind: "folder",
            id: "workspace-root",
            label: "Workspace root",
            path: tempRoot
          }
        ])
      ),
      readSnapshot: vi.fn().mockResolvedValue({ projects: [], revision: "test-revision" }),
      applyMutation: vi.fn().mockResolvedValue({
        mutation: "upsert",
        project: null,
        previousProject: null,
        registry: [],
        registryPath: path.join(tempRoot, "data", "projects.json"),
        snapshotPath: path.join(tempRoot, "data", "history", "snapshot.json")
      }),
      applyMutations: vi.fn(),
      getRevision: vi.fn().mockResolvedValue("test-revision"),
      undoLastMutation: vi.fn(),
      export: vi.fn()
    };

    const brokenHandler = createApiHandler({
      store: brokenStore,
      importService,
      syncEvent,
      launchTarget,
      stopProcess,
      logError: vi.fn()
    });

    const explicit500 = await invokeApi(brokenHandler, {
      method: "POST",
      pathname: "/api/projects/project-1/suggestions/suggestion-1/accept",
      headers: {
        "content-type": "application/json"
      },
      body: "{}"
    });
    expect(explicit500.status).toBe(500);
    expect(explicit500.json).toMatchObject({
      error: {
        code: "INTERNAL_ERROR",
        message: "Internal server error."
      }
    });
    expect(explicit500.text).not.toContain("Suggestion mutation did not return a project.");
  });

  test("rejects mutating requests with non-loopback or mismatched Host and Origin headers", async () => {
    const foreignHost = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/sync",
      headers: { host: "attacker.example" },
      body: JSON.stringify({
        taskId: "blocked-host",
        workingDirectory: tempRoot,
        summary: "Should not reach sync",
        changedPaths: ["src/blocked.ts"]
      })
    });
    expect(foreignHost.status).toBe(403);
    expect(foreignHost.json).toMatchObject({ error: { code: "UNTRUSTED_LOCAL_ORIGIN" } });
    expect(syncEvent).not.toHaveBeenCalledWith(expect.objectContaining({ taskId: "blocked-host" }), expect.anything());

    const mismatchedOrigin = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/undo",
      headers: {
        host: "127.0.0.1:3000",
        origin: "http://localhost:3000"
      },
      body: "{}"
    });
    expect(mismatchedOrigin.status).toBe(403);

    const matchingOrigin = await invokeApi(handler, {
      method: "POST",
      pathname: "/api/sync",
      headers: {
        host: "localhost:3000",
        origin: "http://localhost:3000"
      },
      body: JSON.stringify({
        taskId: "allowed-origin",
        workingDirectory: tempRoot,
        summary: "Allowed loopback sync",
        changedPaths: ["src/allowed.ts"]
      })
    });
    expect(matchingOrigin.status).toBe(200);
    expect(syncEvent).toHaveBeenCalledWith(expect.objectContaining({ taskId: "allowed-origin" }), expect.anything());
  });
});
