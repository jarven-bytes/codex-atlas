import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { App } from "../../src/client/App";
import { clientApi } from "../../src/client/api";
import type { Project } from "../../src/shared/domain";

function buildProject(): Project {
  return {
    id: "atlas",
    name: "Codex Atlas",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Keep project work organized.",
    currentState: "The local project is active.",
    nextAction: "Review the next milestone.",
    rootPath: "/workspace/atlas",
    launchTargets: [],
    sources: [],
    lastActivityAt: "2026-09-04T12:00:00.000Z",
    lastSyncedAt: "2026-09-04T12:00:00.000Z",
    syncStatus: "success",
    updatedAt: "2026-09-04T12:00:00.000Z",
    suggestions: [],
    recentActivity: [],
    tags: [],
    importantFiles: [],
    missingItems: [],
    fieldProvenance: {},
    attentionFlags: [],
    pinned: false,
    archived: false
  };
}

describe("skills workspace view", () => {
  afterEach(() => {
    cleanup();
    delete (clientApi as unknown as { listSkills?: unknown }).listSkills;
    vi.restoreAllMocks();
  });

  beforeEach(() => {
    vi.spyOn(window, "scrollTo").mockImplementation(() => {});
    vi.spyOn(clientApi, "listProjects").mockResolvedValue({ projects: [buildProject()] });
    vi.spyOn(clientApi, "getProject").mockResolvedValue({ project: buildProject() });
  });

  test("loads installed skills and opens a skill detail with project usage", async () => {
    const user = userEvent.setup();
    const listSkills = vi.fn().mockResolvedValue({
      skills: [
        {
          id: "ui-ux-pro-max",
          name: "ui-ux-pro-max",
          summary: "Design intelligence for polished product interfaces.",
          path: "/Users/example/.codex/skills/ui-ux-pro-max",
          source: "user",
          projects: [
            {
              projectId: "atlas",
              projectName: "Codex Atlas",
              rootPath: "/workspace/atlas",
              evidence: ["Referenced in .codex/AGENTS.md"]
            }
          ]
        }
      ]
    });
    (clientApi as unknown as { listSkills: typeof listSkills }).listSkills = listSkills;

    render(<App />);

    await user.click(await screen.findByRole("button", { name: "Skills" }));
    expect(await screen.findByRole("heading", { name: "Skills", level: 2 })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Skills", level: 1 })).toHaveFocus();
    expect(listSkills).toHaveBeenCalledOnce();

    await user.click(screen.getByRole("button", { name: /ui-ux-pro-max/ }));
    const detail = screen.getByRole("complementary", { name: "Skill detail" });
    expect(within(detail).getByText("Design intelligence for polished product interfaces.")).toBeVisible();
    expect(within(detail).getByText("Codex Atlas")).toBeVisible();
    expect(within(detail).getByText("Referenced in .codex/AGENTS.md")).toBeVisible();
  });
});
