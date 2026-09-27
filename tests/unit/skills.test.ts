// @vitest-environment node

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Project } from "../../src/shared/domain";
import { discoverInstalledSkills } from "../../src/server/skills/skills-service";

function buildProject(id: string, rootPath: string): Project {
  return {
    id,
    name: id === "atlas" ? "Codex Atlas" : "Flight Price Tracker",
    type: "web-app",
    needStatus: "Plan",
    userNeed: "Keep project work organized.",
    currentState: "The local project is active.",
    nextAction: "Review the next milestone.",
    rootPath,
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

describe("installed skill discovery", () => {
  let tempRoot: string;

  afterEach(async () => {
    if (tempRoot) {
      await rm(tempRoot, { recursive: true, force: true });
    }
  });

  test("discovers only direct user skills and links explicit project references", async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "codex-atlas-skills-"));
    const userSkillsRoot = path.join(tempRoot, "user-skills");
    const atlasRoot = path.join(tempRoot, "atlas");
    const flightRoot = path.join(tempRoot, "flight");

    await mkdir(path.join(userSkillsRoot, "ui-ux-pro-max"), { recursive: true });
    await mkdir(path.join(atlasRoot, ".codex"), { recursive: true });
    await mkdir(flightRoot, { recursive: true });

    await writeFile(
      path.join(userSkillsRoot, "ui-ux-pro-max", "SKILL.md"),
      "---\nname: ui-ux-pro-max\ndescription: Design intelligence for polished product interfaces.\n---\n\n# UI/UX Pro Max\n"
    );
    await writeFile(
      path.join(atlasRoot, ".codex", "AGENTS.md"),
      "Use the ui-ux-pro-max skill for the command center interface.\n"
    );

    const skills = await discoverInstalledSkills({
      userSkillsRoot,
      projects: [buildProject("atlas", atlasRoot), buildProject("flight", flightRoot)]
    });

    expect(skills.map((skill) => skill.name)).toEqual(["ui-ux-pro-max"]);
    expect(skills.find((skill) => skill.name === "ui-ux-pro-max")).toMatchObject({
      summary: "Design intelligence for polished product interfaces.",
      source: "user",
      projects: [
        expect.objectContaining({
          projectId: "atlas",
          projectName: "Codex Atlas",
          evidence: [expect.stringContaining("AGENTS.md")]
        })
      ]
    });
  });
});
