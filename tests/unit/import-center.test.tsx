import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../../src/client/App";
import { clientApi } from "../../src/client/api";
import type { ImportPreview, SavedMappingEntry } from "../../src/server/imports/types";
import type { Project } from "../../src/shared/domain";

type MockedClientApi = typeof clientApi & {
  getProject: ReturnType<typeof vi.fn>;
  dismissSuggestion: ReturnType<typeof vi.fn>;
  previewImport: ReturnType<typeof vi.fn>;
  commitImport: ReturnType<typeof vi.fn>;
  undo: ReturnType<typeof vi.fn>;
  getSavedMappings: ReturnType<typeof vi.fn>;
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
    getSavedMappings: vi.fn(),
    launchProjectTarget: vi.fn(),
    stopProcess: vi.fn()
  }
}));

function buildProject(overrides: Partial<Project> = {}): Project {
  return {
    id: "project-1",
    name: "Import Atlas",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Turn seeded import data into tracked projects.",
    currentState: "The import center needs a preview and commit workflow.",
    nextAction: "Review the preview before commit.",
    launchTargets: [],
    sources: [
      {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: "workspace:/workspace/import-atlas",
        syncStatus: "success",
        lastSyncedAt: "2026-08-20T12:00:00.000Z"
      }
    ],
    lastActivityAt: "2026-08-20T12:00:00.000Z",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    syncStatus: "success",
    updatedAt: "2026-08-20T12:00:00.000Z",
    rootPath: "/workspace/import-atlas",
    aliases: [],
    importantFiles: [],
    missingItems: [],
    tags: ["imports"],
    suggestions: [],
    recentActivity: [],
    fieldProvenance: {},
    attentionFlags: [],
    pinned: false,
    archived: false,
    ...overrides
  };
}

function buildPreview(): ImportPreview {
  return {
    id: "preview-1",
    source: {
      kind: "structured-file",
      path: "/workspace/imports/projects.csv",
      format: "csv",
      label: "Seeded CSV"
    },
    detectedColumns: ["Project", "Need", "State", "Action", "Notes"],
    createdAt: "2026-08-20T12:10:00.000Z",
    expiresAt: "2026-08-20T13:10:00.000Z",
    registryRevision: "test-revision",
    rows: [
      {
        id: "row-1",
        action: "create",
        reason: "new project from source-backed import",
        evidence: [{ kind: "source-id", value: "row-1" }],
        candidate: {
          name: "Project Nova",
          source: {
            kind: "import",
            label: "Seeded CSV",
            sourceId: "import:row-1",
            syncStatus: "success",
            observedAt: "2026-08-20T12:10:00.000Z"
          },
          evidence: [{ kind: "source-id", value: "row-1" }],
          verifiedAt: "2026-08-20T12:10:00.000Z",
          userNeed: "Create a new tracked project.",
          currentState: "Import row is valid.",
          nextAction: "Commit the row."
        },
        raw: { Project: "Project Nova" }
      },
      {
        id: "row-2",
        action: "update",
        reason: "matched existing project by repository-url",
        evidence: [{ kind: "repository-url", value: "https://github.com/example/existing" }],
        candidate: {
          name: "Existing Project",
          source: {
            kind: "import",
            label: "Seeded CSV",
            sourceId: "import:row-2",
            syncStatus: "success",
            observedAt: "2026-08-20T12:10:00.000Z"
          },
          evidence: [{ kind: "repository-url", value: "https://github.com/example/existing" }],
          verifiedAt: "2026-08-20T12:10:00.000Z",
          userNeed: "Refresh the existing project.",
          currentState: "Import row is valid.",
          nextAction: "Merge the changes."
        },
        raw: { Project: "Existing Project" },
        targetProjectId: "project-1"
      },
      {
        id: "row-3",
        action: "skip",
        reason: "unchanged row",
        evidence: [{ kind: "source-id", value: "row-3" }],
        candidate: {
          name: "Stable Project",
          source: {
            kind: "import",
            label: "Seeded CSV",
            sourceId: "import:row-3",
            syncStatus: "success",
            observedAt: "2026-08-20T12:10:00.000Z"
          },
          evidence: [{ kind: "source-id", value: "row-3" }],
          verifiedAt: "2026-08-20T12:10:00.000Z"
        },
        raw: { Project: "Stable Project" }
      },
      {
        id: "row-4",
        action: "duplicate",
        reason: "review required: alias conflict",
        evidence: [{ kind: "alias", value: "shared-alias" }],
        candidate: {
          name: "Duplicate Alias",
          source: {
            kind: "import",
            label: "Seeded CSV",
            sourceId: "import:row-4",
            syncStatus: "success",
            observedAt: "2026-08-20T12:10:00.000Z"
          },
          evidence: [{ kind: "alias", value: "shared-alias" }],
          verifiedAt: "2026-08-20T12:10:00.000Z"
        },
        raw: { Project: "Duplicate Alias" }
      },
      {
        id: "row-5",
        action: "reject",
        reason: "row could not be parsed: column count mismatch",
        evidence: [{ kind: "source-id", value: "row-5" }],
        candidate: null,
        raw: { Project: "Broken Row" }
      }
    ]
  };
}

function buildSavedMapping(): SavedMappingEntry {
  return {
    format: "csv",
    schemaFingerprint: "csv:project-need-state-action-notes",
    detectedColumns: ["Project", "Need", "State", "Action", "Notes"],
    mapping: {
      Project: "name",
      Need: "userNeed",
      State: "currentState",
      Action: "nextAction"
    }
  };
}

function api(): MockedClientApi {
  return clientApi as MockedClientApi;
}

describe("import center", () => {
  afterEach(() => {
    cleanup();
    vi.resetAllMocks();
  });

  beforeEach(() => {
    window.history.replaceState({}, "", "/");
    api().listProjects.mockResolvedValue({ projects: [buildProject()] });
    api().getProject.mockResolvedValue(buildProject());
    api().previewImport.mockResolvedValue(buildPreview());
    api().getSavedMappings.mockResolvedValue([buildSavedMapping()]);
    api().commitImport.mockResolvedValue({
      result: {
        previewId: "preview-1",
        importedCount: 2,
        skippedCount: 3,
        snapshotPath: "/tmp/import-snapshot.json",
        rows: [
          { id: "row-1", action: "create", committed: true, projectId: "project-2", reason: "new project from source-backed import" },
          { id: "row-2", action: "update", committed: true, projectId: "project-1", reason: "matched existing project by repository-url" },
          { id: "row-3", action: "skip", committed: false, reason: "unchanged row" },
          { id: "row-4", action: "duplicate", committed: false, reason: "review required: alias conflict" },
          { id: "row-5", action: "reject", committed: false, reason: "row could not be parsed: column count mismatch" }
        ],
        projects: [buildProject(), buildProject({ id: "project-2", name: "Project Nova" })]
      },
      projects: [buildProject(), buildProject({ id: "project-2", name: "Project Nova" })]
    });
    api().undo.mockResolvedValue({
      result: {
        restored: true,
        registry: [buildProject()],
        snapshotPath: "/tmp/import-snapshot.json"
      },
      projects: [buildProject()]
    });
  });

  test("previews imports with mapping controls, saved mapping selection, category counts, and row-level errors", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });

    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Import type" }), "structured-file");
    await user.type(
      within(importCenter).getByRole("textbox", { name: "Import path" }),
      "/workspace/imports/projects.csv"
    );
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Structured format" }), "csv");
    expect(within(importCenter).getByRole("option", { name: /Saved mapping/ })).toBeVisible();
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Mapping preset" }), "csv:project-need-state-action-notes");
    expect(within(importCenter).getByRole("combobox", { name: "Mapping preset" })).toHaveValue("csv:project-need-state-action-notes");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));

    expect(api().previewImport).toHaveBeenCalledWith(
      {
        kind: "structured-file",
        path: "/workspace/imports/projects.csv",
        format: "csv",
        label: "Structured import"
      },
      buildSavedMapping().mapping
    );

    expect(await within(importCenter).findByText("create 1")).toBeVisible();
    expect(within(importCenter).getByText("update 1")).toBeVisible();
    expect(within(importCenter).getByText("skip 1")).toBeVisible();
    expect(within(importCenter).getByText("duplicate 1")).toBeVisible();
    expect(within(importCenter).getByText("reject 1")).toBeVisible();

    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Map Project" }), "name");
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Map Need" }), "userNeed");
    await user.click(within(importCenter).getByRole("button", { name: "Refresh preview" }));
    expect(api().previewImport).toHaveBeenLastCalledWith(
      {
        kind: "structured-file",
        path: "/workspace/imports/projects.csv",
        format: "csv",
        label: "Structured import"
      },
      {
        Need: "userNeed",
        Project: "name",
        State: "currentState",
        Action: "nextAction"
      }
    );
    expect(within(importCenter).getByRole("combobox", { name: "Mapping preset" })).toHaveValue("csv:project-need-state-action-notes");
    expect(within(importCenter).getByText("row could not be parsed: column count mismatch")).toBeVisible();
  });

  test("commits a preview and offers undo for the imported changes", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });

    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Import type" }), "structured-file");
    await user.type(
      within(importCenter).getByRole("textbox", { name: "Import path" }),
      "/workspace/imports/projects.csv"
    );
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Structured format" }), "csv");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));
    await screen.findByText("Project Nova");

    await user.click(within(importCenter).getByRole("button", { name: "Commit preview" }));
    expect(api().commitImport).toHaveBeenCalledWith("preview-1");
    expect(await within(importCenter).findByText("Imported 2 rows.")).toBeVisible();

    await user.click(within(importCenter).getByRole("button", { name: "Undo last import" }));
    expect(api().undo).toHaveBeenCalledWith("/tmp/import-snapshot.json");
    expect(await within(importCenter).findByText("Restored the previous registry snapshot.")).toBeVisible();
    expect(within(importCenter).queryByRole("button", { name: "Undo last import" })).toBeNull();
  });

  test("keeps a preview stale and blocks commit after source, format, or mapping changes", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Import type" }), "structured-file");
    await user.type(within(importCenter).getByRole("textbox", { name: "Import path" }), "/workspace/imports/projects.csv");
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Structured format" }), "csv");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));
    const commitButton = within(importCenter).getByRole("button", { name: "Commit preview" });
    expect(commitButton).toBeEnabled();

    await user.type(within(importCenter).getByRole("textbox", { name: "Import path" }), ".updated");
    expect(commitButton).toBeDisabled();
    expect(within(importCenter).getByRole("alert")).toHaveTextContent("Preview is out of date");
    await user.click(within(importCenter).getByRole("button", { name: "Refresh preview" }));
    expect(commitButton).toBeEnabled();

    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Structured format" }), "json");
    expect(commitButton).toBeDisabled();
    await user.click(within(importCenter).getByRole("button", { name: "Refresh preview" }));
    expect(commitButton).toBeEnabled();

    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Structured format" }), "csv");
    await user.click(within(importCenter).getByRole("button", { name: "Refresh preview" }));
    expect(commitButton).toBeEnabled();
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Map Project" }), "currentState");
    expect(within(importCenter).getByRole("button", { name: "Commit preview" })).toBeDisabled();
  });

  test("renders preview rejection as an accessible alert", async () => {
    const user = userEvent.setup();
    api().previewImport.mockReset();
    api().previewImport.mockRejectedValueOnce(new Error("Preview failed."));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });
    await user.type(within(importCenter).getByRole("textbox", { name: "Import path" }), "/workspace/imports/projects.csv");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));
    expect(await within(importCenter).findByRole("alert")).toHaveTextContent("Preview failed.");
  });

  test("keeps undo available and reports an undo rejection", async () => {
    const user = userEvent.setup();
    api().undo.mockRejectedValueOnce(new Error("Undo failed."));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });
    await user.type(within(importCenter).getByRole("textbox", { name: "Import path" }), "/workspace/imports/projects.csv");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));
    await user.click(within(importCenter).getByRole("button", { name: "Commit preview" }));
    await user.click(within(importCenter).getByRole("button", { name: "Undo last import" }));
    expect(await within(importCenter).findByText("Undo failed.", { exact: true })).toBeVisible();
    expect(within(importCenter).getByRole("button", { name: "Undo last import" })).toBeVisible();
  });

  test("renders a missing import snapshot as a warning", async () => {
    const user = userEvent.setup();
    api().undo.mockResolvedValueOnce({
      result: {
        restored: false,
        registry: [buildProject()],
        snapshotPath: null,
        reason: "snapshot-mismatch"
      },
      projects: [buildProject()]
    });
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });
    await user.type(within(importCenter).getByRole("textbox", { name: "Import path" }), "/workspace/imports/projects.csv");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));
    await user.click(within(importCenter).getByRole("button", { name: "Commit preview" }));
    await user.click(within(importCenter).getByRole("button", { name: "Undo last import" }));

    expect(await within(importCenter).findByText(
      "The import snapshot is no longer available to restore.",
      { selector: ".detail-banner-warning" }
    )).toBeVisible();
    expect(within(importCenter).queryByRole("button", { name: "Undo last import" })).toBeNull();
  });

  test("clears the parent detail banner when import inputs change", async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });
    await user.type(within(importCenter).getByRole("textbox", { name: "Import path" }), "/workspace/imports/projects.csv");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));
    await user.click(within(importCenter).getByRole("button", { name: "Commit preview" }));
    const drawer = screen.getByRole("complementary", { name: "Project detail" });
    expect(within(drawer).getAllByRole("status")[0]).toHaveTextContent("Imported 2 rows.");
    await user.clear(within(importCenter).getByRole("textbox", { name: "Import path" }));
    expect(screen.queryByText("Imported 2 rows.")).toBeNull();
  });

  test("keeps import controls reachable when the project registry is empty", async () => {
    api().listProjects.mockResolvedValue({ projects: [] });
    render(<App />);

    await userEvent.setup().click(await screen.findByRole("button", { name: "Import project data" }));
    expect(await screen.findByRole("region", { name: "Import center" })).toBeVisible();
  });

  test("renders accessible alerts and clears stale success after import failures", async () => {
    const user = userEvent.setup();
    api().commitImport.mockRejectedValueOnce(new Error("Commit failed."));
    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Import project data" }));
    const importCenter = await screen.findByRole("region", { name: "Import center" });
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Import type" }), "structured-file");
    await user.type(within(importCenter).getByRole("textbox", { name: "Import path" }), "/workspace/imports/projects.csv");
    await user.selectOptions(within(importCenter).getByRole("combobox", { name: "Structured format" }), "csv");
    await user.click(within(importCenter).getByRole("button", { name: "Preview import" }));
    await user.click(within(importCenter).getByRole("button", { name: "Commit preview" }));
    expect(await within(importCenter).findByRole("alert")).toHaveTextContent("Commit failed.");
    expect(within(importCenter).queryByText("Imported 2 rows.")).toBeNull();
  });
});
