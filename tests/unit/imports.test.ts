// @vitest-environment node

import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { createProjectStore } from "../../src/server/store/project-store";
import { createImportService } from "../../src/server/imports/import-service";
import type { Project } from "../../src/shared/domain";
import type { ImportPreviewRow, ImportSource } from "../../src/server/imports/types";

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Existing Atlas",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Track current delivery work.",
    currentState: "Registry already contains the imported project.",
    nextAction: "Keep the import logic honest.",
    rootPath: "/workspace/existing-atlas",
    repositoryUrl: "https://github.com/example/project-atlas",
    aliases: ["project-atlas"],
    sources: [
      {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: "workspace:/workspace/existing-atlas",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T12:00:00.000Z"
      }
    ],
    launchTargets: [],
    lastActivityAt: "2026-08-20T12:00:00.000Z",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    syncStatus: "success",
    updatedAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  };
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

function expectPreviewRow(
  row: ImportPreviewRow,
  action: ImportPreviewRow["action"],
  reason: string
): void {
  expect(row.action).toBe(action);
  expect(row.reason).toContain(reason);
  expect(row.evidence.length).toBeGreaterThan(0);
}

describe("ImportService", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "imports-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("previews a local folder with project-template markdown, package scripts, and git metadata", async () => {
    const workspaceRoot = path.join(tempRoot, "workspace");
    const projectRoot = path.join(workspaceRoot, "project-atlas");
    await mkdir(path.join(projectRoot, ".git"), { recursive: true });
    await writeFile(
      path.join(projectRoot, "PROJECT_TEMPLATE.md"),
      [
        "# Project Atlas",
        "",
        "## User Need",
        "Help the team track local project delivery.",
        "",
        "## Current State",
        "The reusable import adapter is being built.",
        "",
        "## Next Action",
        "Finish import previews.",
        "",
        "## Tags",
        "- imports",
        "- codex",
        "",
        "## Missing Items",
        "- Review UI wiring"
      ].join("\n")
    );
    await writeJson(path.join(projectRoot, "package.json"), {
      name: "project-atlas",
      repository: {
        type: "git",
        url: "git@github.com:example/project-atlas.git"
      },
      scripts: {
        dev: "vite",
        test: "vitest"
      }
    });
    await writeFile(
      path.join(projectRoot, ".git", "config"),
      "[remote \"origin\"]\n\turl = git@github.com:example/project-atlas.git\n"
    );

    const service = createImportService({
      store: createProjectStore({ dataDir: path.join(tempRoot, "data") }),
      dataDir: path.join(tempRoot, "data")
    });

    const preview = await service.preview({
      kind: "local-folder",
      path: projectRoot,
      label: "Local folder import"
    });

    expect(preview.rows).toHaveLength(1);
    expect(preview.detectedColumns).toEqual(
      expect.arrayContaining([
        "name",
        "userNeed",
        "currentState",
        "nextAction",
        "tags",
        "missingItems",
        "repositoryUrl",
        "launchTargets"
      ])
    );
    expectPreviewRow(preview.rows[0], "create", "new project");
    expect(preview.rows[0].candidate).toMatchObject({
      name: "Project Atlas",
      repositoryUrl: "https://github.com/example/project-atlas",
      aliases: ["project-atlas"],
      tags: ["codex", "imports"],
      missingItems: ["Review UI wiring"]
    });
    expect(preview.rows[0].candidate.launchTargets).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "folder", path: projectRoot }),
        expect.objectContaining({ kind: "command", origin: "scanner", executable: "npm", args: ["run", "dev"], cwd: projectRoot }),
        expect.objectContaining({ kind: "command", origin: "scanner", executable: "npm", args: ["run", "test"], cwd: projectRoot })
      ])
    );
  });

  test("previews structured json and csv rows, saves mappings, and rejects malformed rows without guessing", async () => {
    const dataDir = path.join(tempRoot, "data");
    const jsonPath = path.join(tempRoot, "imports.json");
    const csvPath = path.join(tempRoot, "imports.csv");
    await writeJson(jsonPath, [
      {
        project_name: "Project Nimbus",
        user_need: "Ship import previews safely.",
        current_state: "JSON import fixture exists.",
        next_action: "Commit the valid rows."
      },
      {
        project_name: 42,
        user_need: "Wrong type should reject."
      }
    ]);
    await writeFile(
      csvPath,
      [
        "Project,Need,State,Action,Unknown",
        "Project Comet,Support CSV import,CSV row is valid,Commit the import,leave-me-alone",
        "\"Broken Row\",only-two-columns"
      ].join("\n")
    );

    const service = createImportService({
      store: createProjectStore({ dataDir }),
      dataDir
    });

    const jsonPreview = await service.preview(
      {
        kind: "structured-file",
        path: jsonPath,
        format: "json",
        label: "JSON import"
      },
      {
        project_name: "name",
        user_need: "userNeed",
        current_state: "currentState",
        next_action: "nextAction"
      }
    );

    expect(jsonPreview.rows).toHaveLength(2);
    expectPreviewRow(jsonPreview.rows[0], "create", "new project");
    expectPreviewRow(jsonPreview.rows[1], "reject", "project_name");
    expect(jsonPreview.rows[1].candidate).toBeNull();

    const csvPreview = await service.preview(
      {
        kind: "structured-file",
        path: csvPath,
        format: "csv",
        label: "CSV import"
      },
      {
        Project: "name",
        Need: "userNeed",
        State: "currentState",
        Action: "nextAction"
      }
    );

    expect(csvPreview.detectedColumns).toEqual(["Project", "Need", "State", "Action", "Unknown"]);
    expectPreviewRow(csvPreview.rows[0], "create", "new project");
    expectPreviewRow(csvPreview.rows[1], "reject", "column count");

    const savedMappingsPath = path.join(dataDir, "import-mappings.json");
    const savedMappings = JSON.parse(await readFile(savedMappingsPath, "utf8")) as Record<string, unknown>;
    expect(Object.values(savedMappings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mapping: {
            project_name: "name",
            user_need: "userNeed",
            current_state: "currentState",
            next_action: "nextAction"
          }
        }),
        expect.objectContaining({
          mapping: {
            Project: "name",
            Need: "userNeed",
            State: "currentState",
            Action: "nextAction"
          }
        })
      ])
    );
  });

  test("marks duplicate and update rows via the identity service and commits only valid rows with one undo snapshot", async () => {
    const dataDir = path.join(tempRoot, "data");
    const store = createProjectStore({ dataDir });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject()
    });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject({
        id: "project-2",
        name: "Duplicate Alias A",
        rootPath: undefined,
        repositoryUrl: undefined,
        aliases: ["shared-alias"],
        sources: []
      })
    });
    await store.applyMutation({
      kind: "upsert",
      project: buildProject({
        id: "project-3",
        name: "Duplicate Alias B",
        rootPath: undefined,
        repositoryUrl: undefined,
        aliases: ["shared-alias"],
        sources: []
      })
    });

    const jsonPath = path.join(tempRoot, "commit.json");
    await writeJson(jsonPath, [
      {
        name: "Project Atlas",
        rootPath: "/workspace/new-atlas",
        repositoryUrl: "https://github.com/example/project-atlas",
        userNeed: "Updated need from import",
        currentState: "Imported state should stay as suggestion.",
        nextAction: "Prompt review after import."
      },
      {
        name: "Shared Alias Project",
        aliases: ["shared-alias"],
        userNeed: "This should need review, not commit."
      },
      {
        name: "Project Nova",
        userNeed: "Create me from import",
        currentState: "Ready to import",
        nextAction: "Create the project"
      },
      {
        name: "",
        userNeed: "Invalid row should reject"
      }
    ]);

    const service = createImportService({ store, dataDir });
    const preview = await service.preview({
      kind: "structured-file",
      path: jsonPath,
      format: "json",
      label: "Commit import"
    });

    expect(preview.rows).toHaveLength(4);
    expectPreviewRow(preview.rows[0], "update", "matched existing project");
    expectPreviewRow(preview.rows[1], "duplicate", "review");
    expectPreviewRow(preview.rows[2], "create", "new project");
    expectPreviewRow(preview.rows[3], "reject", "name");

    const commit = await service.commit(preview.id);

    expect(commit.importedCount).toBe(2);
    expect(commit.skippedCount).toBe(2);
    expect(commit.snapshotPath).toContain(path.join(dataDir, "history"));
    expect(commit.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: "update", committed: true }),
        expect.objectContaining({ action: "create", committed: true }),
        expect.objectContaining({ action: "duplicate", committed: false }),
        expect.objectContaining({ action: "reject", committed: false })
      ])
    );

    const registry = await store.list();
    expect(registry).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "project-1",
          sources: expect.arrayContaining([
            expect.objectContaining({
              kind: "import",
              label: "Commit import"
            })
          ])
        }),
        expect.objectContaining({
          name: "Project Nova",
          userNeed: "Create me from import"
        })
      ])
    );

    const historyEntries = await readdir(path.join(dataDir, "history"));
    expect(historyEntries).toHaveLength(4);
  });

  test("surfaces source-level errors when a source cannot be read", async () => {
    const service = createImportService({
      store: createProjectStore({ dataDir: path.join(tempRoot, "data") }),
      dataDir: path.join(tempRoot, "data")
    });

    await expect(
      service.preview({
        kind: "structured-file",
        path: path.join(tempRoot, "missing.csv"),
        format: "csv",
        label: "Missing import"
      } satisfies ImportSource)
    ).rejects.toThrow(/missing\.csv/);
  });

  test("preserves committed source IDs and evidence so re-importing the same row matches by source ID", async () => {
    const dataDir = path.join(tempRoot, "data");
    const store = createProjectStore({ dataDir });
    const jsonPath = path.join(tempRoot, "stable-source.json");
    await writeJson(jsonPath, [
      {
        name: "Project Beacon",
        userNeed: "Track a stable imported row",
        currentState: "First import",
        nextAction: "Re-import the same row"
      }
    ]);

    const service = createImportService({ store, dataDir });
    const firstPreview = await service.preview({
      kind: "structured-file",
      path: jsonPath,
      format: "json",
      label: "Stable source import"
    });
    const originalCandidate = firstPreview.rows[0].candidate;
    expect(originalCandidate).not.toBeNull();

    await service.commit(firstPreview.id);

    const [createdProject] = await store.list();
    expect(createdProject.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "import",
          sourceId: originalCandidate?.source.sourceId,
          label: originalCandidate?.source.label
        })
      ])
    );

    const secondPreview = await service.preview({
      kind: "structured-file",
      path: jsonPath,
      format: "json",
      label: "Stable source import"
    });

    expectPreviewRow(secondPreview.rows[0], "update", "source-id");
    expect(secondPreview.rows[0].candidate?.source.sourceId).toBe(originalCandidate?.source.sourceId);
    expect(secondPreview.rows[0].evidence).toEqual(originalCandidate?.evidence);
  });

  test("keeps valid object rows when a json array also contains malformed entries", async () => {
    const dataDir = path.join(tempRoot, "data");
    const jsonPath = path.join(tempRoot, "mixed.json");
    await writeJson(jsonPath, [
      {
        name: "Project Valid",
        userNeed: "This row should commit",
        currentState: "Ready",
        nextAction: "Import it"
      },
      "not-an-object",
      {
        name: "Project Also Valid",
        userNeed: "This row should also commit",
        currentState: "Ready too",
        nextAction: "Import it too"
      }
    ]);

    const service = createImportService({
      store: createProjectStore({ dataDir }),
      dataDir
    });

    const preview = await service.preview({
      kind: "structured-file",
      path: jsonPath,
      format: "json",
      label: "Mixed JSON import"
    });

    expect(preview.rows).toHaveLength(3);
    expectPreviewRow(preview.rows[0], "create", "new project");
    expectPreviewRow(preview.rows[1], "reject", "object");
    expectPreviewRow(preview.rows[2], "create", "new project");

    const commit = await service.commit(preview.id);
    expect(commit.importedCount).toBe(2);
    expect(commit.skippedCount).toBe(1);
  });

  test("persists mappings by schema fingerprint and does not reuse a mapping for an unrelated schema", async () => {
    const dataDir = path.join(tempRoot, "data");
    const firstJsonPath = path.join(tempRoot, "first-schema.json");
    const secondJsonPath = path.join(tempRoot, "second-schema.json");
    await writeJson(firstJsonPath, [
      {
        project_name: "Project Alpha",
        user_need: "Mapped by first schema",
        current_state: "Ready",
        next_action: "Commit"
      }
    ]);
    await writeJson(secondJsonPath, [
      {
        title: "Project Beta",
        summary: "Different schema should not borrow mapping"
      }
    ]);

    const service = createImportService({
      store: createProjectStore({ dataDir }),
      dataDir
    });

    await service.preview(
      {
        kind: "structured-file",
        path: firstJsonPath,
        format: "json",
        label: "Schema one"
      },
      {
        project_name: "name",
        user_need: "userNeed",
        current_state: "currentState",
        next_action: "nextAction"
      }
    );

    const unrelatedPreview = await service.preview({
      kind: "structured-file",
      path: secondJsonPath,
      format: "json",
      label: "Schema two"
    });

    expectPreviewRow(unrelatedPreview.rows[0], "reject", "name");

    const savedMappingsPath = path.join(dataDir, "import-mappings.json");
    const savedMappings = JSON.parse(await readFile(savedMappingsPath, "utf8")) as Record<string, { mapping: Record<string, string> }>;
    expect(Object.keys(savedMappings)).toHaveLength(1);
    expect(Object.values(savedMappings)[0]?.mapping).toEqual({
      project_name: "name",
      user_need: "userNeed",
      current_state: "currentState",
      next_action: "nextAction"
    });
  });

  test("parses quoted csv fields with commas, escaped quotes, and embedded newlines", async () => {
    const dataDir = path.join(tempRoot, "data");
    const csvPath = path.join(tempRoot, "quoted.csv");
    await writeFile(
      csvPath,
      [
        "Project,Need,State,Action",
        "\"Project, Atlas\",\"Line one",
        "Line two\",\"State with \"\"quotes\"\" inside\",\"Ship it\"",
        "\"Broken\",\"unterminated"
      ].join("\n")
    );

    const service = createImportService({
      store: createProjectStore({ dataDir }),
      dataDir
    });

    const preview = await service.preview(
      {
        kind: "structured-file",
        path: csvPath,
        format: "csv",
        label: "Quoted CSV import"
      },
      {
        Project: "name",
        Need: "userNeed",
        State: "currentState",
        Action: "nextAction"
      }
    );

    expect(preview.rows).toHaveLength(2);
    expectPreviewRow(preview.rows[0], "create", "new project");
    expect(preview.rows[0].candidate).toMatchObject({
      name: "Project, Atlas",
      userNeed: "Line one\nLine two",
      currentState: "State with \"quotes\" inside",
      nextAction: "Ship it"
    });
    expectPreviewRow(preview.rows[1], "reject", "unterminated");
  });

  test("loads legacy json and csv mappings, reuses exact schema safely, and requires explicit review for different schemas", async () => {
    const dataDir = path.join(tempRoot, "data");
    await mkdir(dataDir, { recursive: true });
    await writeJson(path.join(dataDir, "import-mappings.json"), {
      json: {
        project_name: "name",
        user_need: "userNeed",
        current_state: "currentState",
        next_action: "nextAction"
      },
      csv: {
        Project: "name",
        Need: "userNeed",
        State: "currentState",
        Action: "nextAction"
      }
    });

    const exactJsonPath = path.join(tempRoot, "legacy-exact.json");
    const differentJsonPath = path.join(tempRoot, "legacy-different.json");
    const exactCsvPath = path.join(tempRoot, "legacy-exact.csv");

    await writeJson(exactJsonPath, [
      {
        project_name: "Project Legacy Exact",
        user_need: "Reuse exact legacy json mapping",
        current_state: "Exact schema match",
        next_action: "Auto map this row"
      }
    ]);
    await writeJson(differentJsonPath, [
      {
        title: "Project Legacy Different",
        summary: "Should not silently reuse legacy mapping"
      }
    ]);
    await writeFile(
      exactCsvPath,
      [
        "Project,Need,State,Action",
        "Project Legacy CSV,Reuse exact legacy csv mapping,Exact CSV schema,Auto map this row"
      ].join("\n")
    );

    const service = createImportService({
      store: createProjectStore({ dataDir }),
      dataDir
    });

    const exactJsonPreview = await service.preview({
      kind: "structured-file",
      path: exactJsonPath,
      format: "json",
      label: "Legacy exact json"
    });
    expectPreviewRow(exactJsonPreview.rows[0], "create", "new project");
    expect(exactJsonPreview.rows[0].candidate).toMatchObject({
      name: "Project Legacy Exact",
      userNeed: "Reuse exact legacy json mapping"
    });

    const exactCsvPreview = await service.preview({
      kind: "structured-file",
      path: exactCsvPath,
      format: "csv",
      label: "Legacy exact csv"
    });
    expectPreviewRow(exactCsvPreview.rows[0], "create", "new project");
    expect(exactCsvPreview.rows[0].candidate).toMatchObject({
      name: "Project Legacy CSV",
      userNeed: "Reuse exact legacy csv mapping"
    });

    const differentJsonPreview = await service.preview({
      kind: "structured-file",
      path: differentJsonPath,
      format: "json",
      label: "Legacy different json"
    });
    expectPreviewRow(differentJsonPreview.rows[0], "reject", "legacy/unscoped");
    expect(differentJsonPreview.rows[0].candidate).toBeNull();

    await service.preview(
      {
        kind: "structured-file",
        path: differentJsonPath,
        format: "json",
        label: "Legacy different json"
      },
      {
        title: "name",
        summary: "currentState"
      }
    );

    const savedMappings = JSON.parse(
      await readFile(path.join(dataDir, "import-mappings.json"), "utf8")
    ) as Record<string, unknown>;
    expect(savedMappings.json).toEqual({
      project_name: "name",
      user_need: "userNeed",
      current_state: "currentState",
      next_action: "nextAction"
    });
    expect(savedMappings.csv).toEqual({
      Project: "name",
      Need: "userNeed",
      State: "currentState",
      Action: "nextAction"
    });
    expect(Object.values(savedMappings)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          mapping: {
            title: "name",
            summary: "currentState"
          }
        })
      ])
    );
  });

  test("treats legacy mappings with a literal source field named mapping as legacy data, not scoped records", async () => {
    const dataDir = path.join(tempRoot, "data");
    await mkdir(dataDir, { recursive: true });
    await writeJson(path.join(dataDir, "import-mappings.json"), {
      json: {
        mapping: "name",
        user_need: "userNeed",
        current_state: "currentState",
        next_action: "nextAction"
      }
    });

    const jsonPath = path.join(tempRoot, "legacy-mapping-field.json");
    await writeJson(jsonPath, [
      {
        mapping: "Project Literal Mapping Column",
        user_need: "Legacy mapping should still load",
        current_state: "Exact field set match",
        next_action: "Auto map from legacy entry"
      }
    ]);

    const service = createImportService({
      store: createProjectStore({ dataDir }),
      dataDir
    });

    const preview = await service.preview({
      kind: "structured-file",
      path: jsonPath,
      format: "json",
      label: "Legacy literal mapping"
    });

    expectPreviewRow(preview.rows[0], "create", "new project");
    expect(preview.rows[0].candidate).toMatchObject({
      name: "Project Literal Mapping Column",
      userNeed: "Legacy mapping should still load"
    });
  });

  test("revalidates duplicate identities when two preview rows target the same new project", async () => {
    const dataDir = path.join(tempRoot, "data");
    const sourcePath = path.join(tempRoot, "duplicate-identities.json");
    await writeJson(sourcePath, [
      { name: "Same Project", rootPath: "/workspace/same-project", userNeed: "First row" },
      { name: "Same Project", rootPath: "/workspace/same-project", userNeed: "Second row" }
    ]);
    const store = createProjectStore({ dataDir });
    const service = createImportService({ store, dataDir });

    const preview = await service.preview({
      kind: "structured-file",
      path: sourcePath,
      format: "json",
      label: "Duplicate identity race"
    });
    expect(preview.rows).toHaveLength(2);
    expect(preview.rows.every((row) => row.action === "create")).toBe(true);

    const result = await service.commit(preview.id);
    expect(result.importedCount).toBe(1);
    expect(result.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "create", committed: true }),
      expect.objectContaining({ action: "duplicate", committed: false })
    ]));
    expect((await store.list()).filter((project) => project.rootPath === "/workspace/same-project")).toHaveLength(1);
  });

  test("rejects a preview commit when another mutation claims its identity", async () => {
    const dataDir = path.join(tempRoot, "data");
    const sourcePath = path.join(tempRoot, "preview-race.json");
    await writeJson(sourcePath, [
      { name: "Racing Project", rootPath: "/workspace/racing-project", userNeed: "Preview value" }
    ]);
    const store = createProjectStore({ dataDir });
    const service = createImportService({ store, dataDir });
    const preview = await service.preview({
      kind: "structured-file",
      path: sourcePath,
      format: "json",
      label: "Preview race"
    });

    await store.applyMutation({
      kind: "upsert",
      project: buildProject({
        id: "claimed-project",
        name: "Racing Project",
        rootPath: "/workspace/racing-project"
      })
    });

    await expect(service.commit(preview.id)).rejects.toThrow(/registry revision changed|committable rows/u);
    expect((await store.list()).filter((project) => project.rootPath === "/workspace/racing-project")).toHaveLength(1);
  });
});
