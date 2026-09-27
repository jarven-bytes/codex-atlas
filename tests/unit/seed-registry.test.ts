import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { Project } from "../../src/shared/domain";
import { createProjectStore } from "../../src/server/store/project-store";
import { StructuredImportAdapter } from "../../src/server/imports/structured";

const projectRoot = path.resolve(import.meta.dirname, "../..");
const seedPath = path.join(projectRoot, "tests", "fixtures", "seed", "projects.json");
const temporaryDirectories: string[] = [];

async function readSeed(): Promise<Project[]> {
  const parsed = JSON.parse(await readFile(seedPath, "utf8")) as unknown;
  expect(Array.isArray(parsed)).toBe(true);
  return Array.isArray(parsed) ? parsed as Project[] : [];
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      const { rm } = await import("node:fs/promises");
      await rm(directory, { recursive: true, force: true });
    })
  );
});

describe("canonical seed registry", () => {
  test("contains the six approved projects with truthful status, path, provenance, and trust state", async () => {
    const projects = await readSeed();
    const byId = new Map(projects.map((project) => [project.id, project]));

    expect(projects).toHaveLength(6);
    expect(new Set(projects.map((project) => project.id)).size).toBe(6);
    expect(projects.map((project) => project.needStatus).sort()).toEqual([
      "Insufficient",
      "Insufficient",
      "Need",
      "Need",
      "Plan",
      "Plan"
    ]);
    expect([...byId.keys()].sort()).toEqual([
      "ai-daily-planner",
      "applypilot-job-search",
      "flight-price-tracker",
      "linear-activity-summary",
      "sites-web-project",
      "weekday-morning-brief"
    ]);

    for (const project of projects) {
      expect(project.rootPath).toBe(`/workspace/examples/${project.id}`);
      expect(project.userNeed.trim()).not.toBe("");
      expect(project.currentState.trim()).not.toBe("");
      expect(project.nextAction.trim()).not.toBe("");
      expect(project.sources.length).toBeGreaterThan(0);
      expect(project.fieldProvenance?.needStatus?.manual).toBe(true);
      expect(project.fieldProvenance?.userNeed?.manual).toBe(true);
      expect(project.fieldProvenance?.nextAction?.manual).toBe(true);
      expect(project.repositoryUrl).toBeUndefined();
      expect(JSON.stringify(project)).not.toContain('"trusted"');

      for (const target of project.launchTargets) {
        if (target.kind === "command") {
          expect(target.origin).toBe("manual");
        }
      }
    }
  });

  test("exports the seeded registry in valid formats and remains duplicate-free across store restart", async () => {
    const dataDir = await mkdtemp(path.join(os.tmpdir(), "project-seed-restart-"));
    temporaryDirectories.push(dataDir);
    await cp(seedPath, path.join(dataDir, "projects.json"));

    const firstStore = createProjectStore({ dataDir });
    const firstProjects = await firstStore.list();
    const json = await firstStore.export("json");
    const markdown = await firstStore.export("markdown");
    const csv = await firstStore.export("csv");

    const jsonProjects = JSON.parse(json) as Project[];
    expect(jsonProjects).toHaveLength(6);
    expect(markdown.match(/^## /gmu)).toHaveLength(6);
    const markdownProjects = Array.from(
      markdown.matchAll(/```json\n([\s\S]*?)\n```/gmu),
      (match) => JSON.parse(match[1]) as Project
    );
    expect(markdownProjects).toEqual(jsonProjects);

    const exportedCsvPath = path.join(dataDir, "exported-projects.csv");
    await writeFile(exportedCsvPath, csv, "utf8");
    const csvPreview = await new StructuredImportAdapter().preview({
      kind: "structured-file",
      path: exportedCsvPath,
      format: "csv",
      label: "Export validation"
    });
    expect(csvPreview.rows).toHaveLength(6);
    expect(csvPreview.rows.every((row) => row.candidate !== null && !row.error)).toBe(true);
    for (const row of csvPreview.rows) {
      expect(row.candidate).toMatchObject({
        name: expect.any(String),
        needStatus: expect.any(String),
        userNeed: expect.any(String),
        currentState: expect.any(String),
        nextAction: expect.any(String),
        rootPath: expect.any(String),
        launchTargets: expect.any(Array),
        missingItems: expect.any(Array),
        tags: expect.any(Array)
      });
    }

    const restartedStore = createProjectStore({ dataDir });
    const restartedProjects = await restartedStore.list();
    expect(restartedProjects).toHaveLength(6);
    expect(new Set(restartedProjects.map((project) => project.id)).size).toBe(6);
    expect(restartedProjects).toEqual(firstProjects);
    expect(restartedProjects).toEqual(jsonProjects);
  });
});
