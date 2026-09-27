import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Project, ProjectSource, SyncReviewItem } from "../../src/shared/domain";
import { App } from "../../src/client/App";
import { clientApi } from "../../src/client/api";

function buildSource(overrides: Partial<ProjectSource> = {}): ProjectSource {
  return {
    kind: "workspace",
    label: "Workspace scan",
    sourceId: "workspace:/projects/example",
    syncStatus: "success",
    lastSyncedAt: "2026-08-20T12:00:00.000Z",
    ...overrides
  };
}

function buildProject(overrides: Partial<Project>): Project {
  return {
    id: overrides.id ?? "project",
    name: overrides.name ?? "Project",
    type: overrides.type ?? "web-app",
    needStatus: overrides.needStatus ?? "Plan",
    userNeed: overrides.userNeed ?? "Track project health.",
    currentState: overrides.currentState ?? "Healthy local state.",
    nextAction: overrides.nextAction ?? "Review the dashboard.",
    launchTargets: overrides.launchTargets ?? [],
    sources: overrides.sources ?? [buildSource()],
    lastActivityAt: overrides.lastActivityAt ?? "2026-08-20T10:00:00.000Z",
    lastSyncedAt: overrides.lastSyncedAt ?? "2026-08-20T12:00:00.000Z",
    syncStatus: overrides.syncStatus ?? "success",
    updatedAt: overrides.updatedAt ?? "2026-08-20T12:00:00.000Z",
    repositoryUrl: overrides.repositoryUrl,
    rootPath: overrides.rootPath ?? `/workspace/${overrides.id ?? "project"}`,
    aliases: overrides.aliases ?? [],
    importantFiles: overrides.importantFiles ?? [],
    missingItems: overrides.missingItems ?? [],
    tags: overrides.tags ?? [],
    suggestions: overrides.suggestions ?? [],
    recentActivity: overrides.recentActivity ?? [],
    fieldProvenance: overrides.fieldProvenance ?? {},
    attentionFlags: overrides.attentionFlags ?? [],
    pinned: overrides.pinned ?? false,
    archived: overrides.archived ?? false
  };
}

const projects = [
  buildProject({
    id: "pinned-plan",
    name: "Flight Price Tracker",
    pinned: true,
    type: "web-app",
    needStatus: "Plan",
    nextAction: "Define MVP scope",
    tags: ["travel"],
    recentActivity: [
      {
        kind: "note",
        id: "activity-pinned",
        message: "Detailed note for leadership review.",
        createdAt: "2026-08-20T11:00:00.000Z"
      }
    ]
  }),
  buildProject({
    id: "need-project",
    name: "ApplyPilot Job Search",
    type: "workflow",
    needStatus: "Need",
    nextAction: "Verify source coverage",
    currentState: "Unverified sources remain."
  }),
  buildProject({
    id: "insufficient-project",
    name: "AI Daily Planner",
    type: "mobile-app",
    needStatus: "Insufficient",
    syncStatus: "failed",
    currentState: "Sync failed this morning.",
    nextAction: "Fix sync errors"
  }),
  buildProject({
    id: "sync-failed-project",
    name: "Deploy Monitor",
    type: "automation",
    syncStatus: "failed",
    currentState: "Watcher exited unexpectedly.",
    nextAction: "Restart local sync"
  }),
  buildProject({
    id: "import-review-project",
    name: "Imported CRM Snapshot",
    type: "document",
    syncStatus: "partial",
    sources: [
      buildSource({
        kind: "import",
        label: "Imported CSV",
        syncStatus: "partial"
      })
    ],
    currentState: "Import needs confirmation.",
    nextAction: "Review imported rows"
  }),
  buildProject({
    id: "stale-project",
    name: "Linear Activity Summary",
    type: "connector",
    lastActivityAt: "2026-06-01T10:00:00.000Z",
    currentState: "No updates in weeks.",
    nextAction: "Refresh Linear token"
  }),
  buildProject({
    id: "suggestion-project",
    name: "Site Rewrite",
    type: "web-app",
    suggestions: [
      {
        kind: "field-update",
        id: "suggestion-1",
        field: "nextAction",
        title: "Review next action",
        detail: "A newer source suggested a better next action.",
        currentValue: "Review the dashboard.",
        proposedValue: "Open the detail pane and confirm launch targets.",
        evidence: [{ kind: "source-id", value: "import:site-rewrite" }],
        createdAt: "2026-08-20T12:10:00.000Z"
      }
    ],
    currentState: "Suggestion is waiting.",
    nextAction: "Review the dashboard."
  }),
  buildProject({
    id: "unavailable-project",
    name: "Source Drift",
    type: "other",
    syncStatus: "unavailable",
    sources: [
      buildSource({
        kind: "manual",
        label: "Private source",
        syncStatus: "unavailable",
        unavailableReason: "Manual source is currently unavailable."
      })
    ],
    currentState: "Missing source access.",
    nextAction: "Recover credentials"
  }),
  buildProject({
    id: "archived-project",
    name: "Archived Project",
    archived: true,
    needStatus: "Need",
    nextAction: "Should stay hidden"
  })
];

function mockListProjects(data: Project[] = projects) {
  vi.mocked(clientApi.listProjects).mockResolvedValue({ projects: data });
}

describe("dashboard", () => {
  let listProjectsSpy: ReturnType<typeof vi.spyOn<typeof clientApi, "listProjects">>;
  let acceptSuggestionSpy: ReturnType<typeof vi.spyOn<typeof clientApi, "acceptSuggestion">>;

  afterEach(() => {
    cleanup();
    delete window.codexAtlas;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(new Date("2026-08-20T13:00:00.000Z").getTime());
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    window.history.replaceState({}, "", "/");
    listProjectsSpy = vi.spyOn(clientApi, "listProjects");
    vi.spyOn(clientApi, "scanWorkspace").mockResolvedValue({
      outcome: { scannedRoots: [], updatedProjectIds: [], reviewIds: [] },
      projects: [],
      reviews: []
    });
    acceptSuggestionSpy = vi.spyOn(clientApi, "acceptSuggestion");
    mockListProjects();
    acceptSuggestionSpy.mockImplementation(
      async (projectId: string, suggestionId: string) => {
        const project = projects.find((entry) => entry.id === projectId);
        if (!project || project.suggestions?.[0]?.id !== suggestionId) {
          throw new Error("Missing suggestion fixture.");
        }

        return {
          ...project,
          nextAction: project.suggestions[0].proposedValue,
          suggestions: []
        };
      }
    );
  });

  test("loads the dashboard, excludes archived projects, pins the first row, and orders attention items", async () => {
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Show all projects" })).toHaveTextContent("8");
    expect(screen.getByRole("button", { name: "Plan 6 projects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Need 1 projects" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Insufficient 1 projects" })).toBeVisible();

    expect(screen.queryByText("Archived Project")).not.toBeInTheDocument();

    const table = screen.getByRole("table", { name: "Projects" });
    const rows = within(table).getAllByRole("row");
    expect(within(rows[1]).getByText("Flight Price Tracker")).toBeVisible();

    const queue = screen.getByRole("list", { name: "Attention queue" });
    const items = within(queue).getAllByRole("listitem");
    expect(items.map((item) => within(item).getByRole("heading").textContent)).toEqual([
      "ApplyPilot Job Search",
      "AI Daily Planner",
      "Deploy Monitor",
      "Imported CRM Snapshot",
      "Linear Activity Summary",
      "Site Rewrite"
    ]);
  });

  test("expands an attention item with its fix and opens the related project", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "AI Daily Planner: Sync failed" }));
    expect(screen.getByText("What is happening")).toBeVisible();
    expect(screen.getByText("Recommended fix")).toBeVisible();
    expect(screen.getAllByText("Fix sync errors").length).toBeGreaterThan(0);

    const details = screen.getByText("What is happening").closest(".attention-item-details");
    expect(details).toBeTruthy();
    if (!details) {
      throw new Error("Expanded attention details are missing.");
    }

    await user.click(within(details as HTMLElement).getByRole("button", { name: "Open AI Daily Planner" }));
    expect(
      within(screen.getByRole("complementary", { name: "Project detail" })).getByRole("heading", {
        name: "AI Daily Planner"
      })
    ).toBeVisible();
  });

  test("shows saved facts for projects in Documents without mockup substitutions", async () => {
    mockListProjects([buildProject({
      id: "real-tracker",
      name: "Flight Price Tracker",
      rootPath: "/Users/example/Documents/tracker",
      needStatus: "Insufficient",
      currentState: "Provider integration is blocked.",
      nextAction: "Obtain provider approval.",
      suggestions: []
    })]);
    render(<App />);
    const table = await screen.findByRole("table", { name: "Projects" });
    expect(within(table).getByText("Insufficient")).toBeVisible();
    expect(within(table).getByText("Obtain provider approval.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Insufficient 1 projects" })).toBeVisible();
    expect(screen.queryByText("Add user need context")).not.toBeInTheDocument();
    expect(screen.queryByText("Commit a1b2c3d")).not.toBeInTheDocument();
  });

  test("uses the project action menu for rename and archive", async () => {
    const user = userEvent.setup();

    render(<App />);

    const table = await screen.findByRole("table", { name: "Projects" });
    const flightRow = within(table)
      .getAllByRole("row")
      .find((row) => within(row).queryByText("Flight Price Tracker"));
    expect(flightRow).toBeTruthy();
    if (!flightRow) {
      throw new Error("Flight Price Tracker row is missing.");
    }

    await user.click(within(flightRow).getByRole("button", { name: "Project actions for Flight Price Tracker" }));
    expect(screen.getByRole("menu", { name: "Actions for Flight Price Tracker" })).toHaveTextContent(
      /Open project.*Rename.*Refresh data.*Copy project path.*Archive project/
    );
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    await user.clear(within(flightRow).getByRole("textbox", { name: "Rename Flight Price Tracker" }));
    await user.type(within(flightRow).getByRole("textbox", { name: "Rename Flight Price Tracker" }), "Renamed Tracker");
    await user.click(within(flightRow).getByRole("button", { name: "Save name for Flight Price Tracker" }));
    expect(within(table).getByText("Renamed Tracker")).toBeVisible();

    const renamedRow = within(table)
      .getAllByRole("row")
      .find((row) => within(row).queryByText("Renamed Tracker"));
    expect(renamedRow).toBeTruthy();
    if (!renamedRow) {
      throw new Error("Renamed project row is missing.");
    }

    await user.click(within(renamedRow).getByRole("button", { name: "Project actions for Renamed Tracker" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive project" }));
    expect(within(table).queryByText("Renamed Tracker")).not.toBeInTheDocument();
  });

  test("orders favorites by the sequence they were selected", async () => {
    const user = userEvent.setup();

    render(<App />);

    const table = await screen.findByRole("table", { name: "Projects" });
    const projectNames = () =>
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => row.querySelector(".project-name-copy strong")?.textContent ?? "");

    await user.click(within(table).getByRole("button", { name: "Pin ApplyPilot Job Search" }));
    expect(projectNames().slice(0, 2)).toEqual(["Flight Price Tracker", "ApplyPilot Job Search"]);

    await user.click(within(table).getByRole("button", { name: "Pin AI Daily Planner" }));
    expect(projectNames().slice(0, 3)).toEqual([
      "Flight Price Tracker",
      "ApplyPilot Job Search",
      "AI Daily Planner"
    ]);

    await user.click(within(table).getByRole("button", { name: "Unpin Flight Price Tracker" }));
    expect(projectNames().slice(0, 2)).toEqual(["ApplyPilot Job Search", "AI Daily Planner"]);
  });

  test("filters by URL query state, search terms, and status selection", async () => {
    window.history.replaceState({}, "", "/?q=leadership&type=web-app");

    const user = userEvent.setup();
    render(<App />);
    const table = await screen.findByRole("table", { name: "Projects" });

    expect((await screen.findAllByText("Flight Price Tracker")).length).toBeGreaterThan(0);
    expect(within(table).queryByText("Site Rewrite")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Customize columns" }));
    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by type" }), "document");
    await user.clear(screen.getByRole("searchbox", { name: "Search projects" }));
    await user.type(screen.getByRole("searchbox", { name: "Search projects" }), "imported");
    expect((await screen.findAllByText("Imported CRM Snapshot")).length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByRole("combobox", { name: "Filter by type" }), "");
    await user.clear(screen.getByRole("searchbox", { name: "Search projects" }));
    await user.click(screen.getByRole("button", { name: "Need 1 projects" }));
    const filteredTable = await screen.findByRole("table", { name: "Projects" });
    expect(within(filteredTable).getByText("ApplyPilot Job Search")).toBeVisible();
    expect(within(filteredTable).queryByText("Flight Price Tracker")).not.toBeInTheDocument();
    expect(window.location.search).toContain("status=Need");

    await user.click(screen.getByRole("button", { name: "Plan slice 6 projects" }));
    const sliceFilteredTable = await screen.findByRole("table", { name: "Projects" });
    expect(within(sliceFilteredTable).getByText("Flight Price Tracker")).toBeVisible();
    expect(within(sliceFilteredTable).queryByText("ApplyPilot Job Search")).not.toBeInTheDocument();
    expect(window.location.search).toContain("status=Plan");
  });

  test("opens the detail panel, shows unavailable source messaging, and supports explicit empty states", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Project actions for Source Drift" }));
    await user.click(screen.getByRole("menuitem", { name: "Open project" }));
    expect(within(screen.getByRole("complementary", { name: "Project detail" }))
      .getByRole("heading", { name: "Source Drift" })).toBeVisible();
    expect(screen.getByText("Manual source is currently unavailable.")).toBeVisible();

    vi.mocked(clientApi.listProjects).mockResolvedValueOnce({ projects: [] });
    await user.click(screen.getByRole("button", { name: "Refresh dashboard" }));
    expect(await screen.findByText("No active projects yet.")).toBeVisible();
    expect(screen.getByText("Import or sync a source to populate the dashboard.")).toBeVisible();
  });

  test("accepts queued suggestions through the client contract", async () => {
    const user = userEvent.setup();

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Site Rewrite: Review next action" }));
    expect(screen.getByText("What is happening")).toBeVisible();
    expect(screen.getByText("Recommended fix")).toBeVisible();
    expect(screen.getAllByText("Open the detail pane and confirm launch targets.").length).toBeGreaterThan(0);
    await user.click(screen.getByRole("button", { name: "Apply suggestion for Site Rewrite" }));

    expect(clientApi.acceptSuggestion).toHaveBeenCalledWith("suggestion-project", "suggestion-1");
    expect(
      (await screen.findAllByText("Open the detail pane and confirm launch targets.")).length
    ).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Apply suggestion for Site Rewrite" })).not.toBeInTheDocument();
  });

  test("opens Codex with suggestion context before accepting the change", async () => {
    const user = userEvent.setup();
    const openSuggestion = vi.fn().mockResolvedValue({
      opened: true,
      message: "Opened Codex in Terminal for this suggestion."
    });
    window.codexAtlas = { openSuggestion };
    vi.spyOn(clientApi, "getProject").mockResolvedValue({
      project: projects.find((project) => project.id === "suggestion-project")!
    });

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Site Rewrite: Review next action" }));
    await user.click(screen.getByRole("button", { name: "Apply suggestion for Site Rewrite" }));

    expect(openSuggestion).toHaveBeenCalledWith(expect.objectContaining({
      projectPath: "/workspace/suggestion-project",
      projectName: "Site Rewrite",
      suggestionTitle: "Review next action",
      proposedValue: "Open the detail pane and confirm launch targets."
    }));
    expect(await screen.findByText("Opened Codex to implement this suggestion.")).toBeVisible();
  });

  test("shows only the error state and recovery action when loading fails", async () => {
    vi.mocked(clientApi.listProjects).mockRejectedValueOnce(new Error("Dashboard data is unavailable."));

    render(<App />);

    expect(await screen.findByText("Dashboard data is unavailable.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Retry load" })).toBeVisible();
    expect(screen.queryByText("No active projects yet.")).not.toBeInTheDocument();
  });

  test("exposes persisted sync conflict evidence and duplicate project ids", async () => {
    const review: SyncReviewItem = {
      id: "review-conflict",
      kind: "workspace-scan",
      sourceLabel: "Workspace scan",
      reason: "alias-conflict",
      evidence: [{ kind: "alias", value: "shared-project" }],
      duplicateProjectIds: ["project-a", "project-b"],
      createdAt: "2026-08-20T12:00:00.000Z",
      status: "open"
    };
    vi.mocked(clientApi.listProjects).mockResolvedValueOnce({ projects: [], reviews: [review] });

    render(<App />);

    expect(await screen.findByRole("status")).toHaveTextContent(
      "duplicateProjectIds=project-a, project-b"
    );
  });

  test("surfaces a clear error when the projects endpoint returns a non-json success response", async () => {
    listProjectsSpy.mockRestore();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("ok", {
          status: 200,
          headers: {
            "Content-Type": "text/plain; charset=utf-8"
          }
        })
      );

    await expect(clientApi.listProjects()).rejects.toThrow(
      "Expected a JSON API response but received text/plain; charset=utf-8."
    );

    fetchMock.mockRestore();
  });

  test("surfaces a clear error when the projects endpoint returns json null", async () => {
    listProjectsSpy.mockRestore();
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response("null", {
          status: 200,
          headers: {
            "Content-Type": "application/json; charset=utf-8"
          }
        })
      );

    await expect(clientApi.listProjects()).rejects.toThrow(
      "Projects API returned an empty or malformed payload."
    );

    fetchMock.mockRestore();
  });
});
