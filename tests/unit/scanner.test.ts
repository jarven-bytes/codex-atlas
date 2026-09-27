// @vitest-environment node

import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createWorkspaceCandidate,
  createWorkspaceWatchScheduler,
  isRootWithinAllowedRoots,
  scanProjectRoot
} from "../../src/server/sync/scanner";

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(value, null, 2));
}

async function createFixtureProject(rootPath: string): Promise<void> {
  await mkdir(path.join(rootPath, ".git"), { recursive: true });
  await mkdir(path.join(rootPath, "scripts"), { recursive: true });
  await mkdir(path.join(rootPath, "docs"), { recursive: true });
  await mkdir(path.join(rootPath, "node_modules", "ignored-package"), { recursive: true });
  await mkdir(path.join(rootPath, ".turbo", "cache"), { recursive: true });
  await mkdir(path.join(rootPath, ".next", "cache"), { recursive: true });

  await writeFile(
    path.join(rootPath, "README.md"),
    "# Project Atlas\n\nLocal workspace tracker for Codex projects.\n"
  );
  await writeJson(path.join(rootPath, "package.json"), {
    name: "project-atlas",
    private: true,
    repository: {
      type: "git",
      url: "https://github.com/example/project-atlas.git"
    },
    scripts: {
      dev: "node scripts/dev.js",
      test: "vitest"
    }
  });
  await writeFile(path.join(rootPath, "scripts", "dev.js"), "console.log('dev');\n");
  await writeFile(path.join(rootPath, "docs", "brief.md"), "Important note\n");
  await writeFile(
    path.join(rootPath, ".git", "config"),
    "[remote \"origin\"]\n\turl = git@github.com:example/project-atlas.git\n"
  );
  await writeFile(path.join(rootPath, "node_modules", "ignored-package", "package.json"), "{ }\n");
  await writeFile(path.join(rootPath, ".env"), "SECRET=1\n");
  await writeFile(
    path.join(rootPath, "dist.zip"),
    "x".repeat(1024 * 1024)
  );
}

describe("scanProjectRoot", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "scanner-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("extracts candidate details from known metadata files without reading arbitrary large files", async () => {
    const projectRoot = path.join(tempRoot, "project-atlas");
    await mkdir(projectRoot, { recursive: true });
    await createFixtureProject(projectRoot);

    const candidate = await scanProjectRoot(projectRoot);

    expect(candidate).toMatchObject({
      name: "Project Atlas",
      type: "web-app",
      rootPath: projectRoot,
      repositoryUrl: "https://github.com/example/project-atlas",
      aliases: ["project-atlas"],
      source: {
        kind: "workspace",
        label: "Workspace scan",
        syncStatus: "success"
      }
    });
    expect(candidate.launchTargets).toEqual([
      {
        kind: "folder",
        id: "workspace-root",
        label: "Workspace root",
        path: projectRoot
      },
      {
        kind: "command",
        id: "script-dev",
        label: "Run dev",
        origin: "scanner",
        executable: "npm",
        args: ["run", "dev"],
        cwd: projectRoot
      },
      {
        kind: "command",
        id: "script-test",
        label: "Run test",
        origin: "scanner",
        executable: "npm",
        args: ["run", "test"],
        cwd: projectRoot
      }
    ]);
    expect(candidate.importantFiles).toEqual(["README.md", "docs/brief.md", "package.json"]);
    expect(candidate.evidence).toEqual(
      expect.arrayContaining([
        { kind: "root-path", value: projectRoot },
        { kind: "repository-url", value: "https://github.com/example/project-atlas" },
        { kind: "alias", value: "project-atlas" }
      ])
    );
  });

  test("normalizes paths and ignores caches, nested dependencies, and secrets while staying inside the configured root", async () => {
    const projectRoot = path.join(tempRoot, "workspace", "..", "workspace", "project-atlas");
    await mkdir(projectRoot, { recursive: true });
    await createFixtureProject(projectRoot);

    const outsideTarget = path.join(tempRoot, "outside-project");
    await mkdir(outsideTarget, { recursive: true });
    await writeFile(path.join(outsideTarget, "README.md"), "# Outside\n");
    await symlink(outsideTarget, path.join(projectRoot, "linked-outside"));

    const candidate = await scanProjectRoot(projectRoot);

    expect(candidate.rootPath).toBe(path.normalize(projectRoot));
    expect(candidate.importantFiles).not.toContain(".env");
    expect(candidate.importantFiles).not.toContain("node_modules/ignored-package/package.json");
    expect(candidate.importantFiles).not.toContain("linked-outside/README.md");
    expect(candidate.launchTargets).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          cwd: outsideTarget
        })
      ])
    );
  });

  test("marks the candidate unavailable when required metadata cannot be read", async () => {
    const missingRoot = path.join(tempRoot, "missing-project");

    const candidate = await scanProjectRoot(missingRoot);

    expect(candidate.source).toMatchObject({
      kind: "workspace",
      label: "Workspace scan",
      syncStatus: "unavailable",
      unavailableReason: expect.stringContaining("ENOENT")
    });
    expect(candidate.unavailableFields).toEqual(
      expect.arrayContaining(["name", "rootPath", "repositoryUrl", "launchTargets"])
    );
  });

  test("rejects roots outside configured workspace roots using normalized real paths", async () => {
    const allowedRoot = path.join(tempRoot, "allowed");
    const projectRoot = path.join(allowedRoot, "project-atlas");
    const outsideRoot = path.join(tempRoot, "outside");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await createFixtureProject(projectRoot);

    await expect(isRootWithinAllowedRoots(projectRoot, [allowedRoot])).resolves.toBe(true);
    await expect(isRootWithinAllowedRoots(outsideRoot, [allowedRoot])).resolves.toBe(false);

    const candidate = await createWorkspaceCandidate(outsideRoot, [allowedRoot]);
    expect(candidate.source).toMatchObject({
      syncStatus: "unavailable",
      unavailableReason: expect.stringContaining("outside configured workspace roots")
    });
  });
});

describe("workspace watch scheduling", () => {
  let tempRoot: string;

  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "watcher-"));
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  test("debounces relevant metadata changes for 500 ms and ignores cache churn", async () => {
    vi.useFakeTimers();

    const projectRoot = path.join(tempRoot, "project-atlas");
    await mkdir(projectRoot, { recursive: true });
    await createFixtureProject(projectRoot);

    const onCandidate = vi.fn().mockResolvedValue(undefined);
    const scheduler = createWorkspaceWatchScheduler([tempRoot], onCandidate);

    try {
      await scheduler.notify(path.join(projectRoot, "README.md"));
      await scheduler.notify(path.join(projectRoot, "package.json"));
      await scheduler.notify(path.join(projectRoot, ".turbo", "cache", "state.json"));

      await vi.advanceTimersByTimeAsync(499);
      expect(onCandidate).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      await vi.waitFor(() => {
        expect(onCandidate).toHaveBeenCalledTimes(1);
      });
      expect(onCandidate).toHaveBeenCalledWith(
        expect.objectContaining({
          rootPath: projectRoot,
          source: expect.objectContaining({
            kind: "workspace",
            syncStatus: "success"
          })
        })
      );
    } finally {
      scheduler.close();
      vi.useRealTimers();
    }
  });

  test("rescans on bounded git identity files and cancels queued work on cleanup", async () => {
    vi.useFakeTimers();

    const projectRoot = path.join(tempRoot, "project-atlas");
    await mkdir(path.join(projectRoot, ".git", "refs", "heads"), { recursive: true });
    await createFixtureProject(projectRoot);
    await writeFile(path.join(projectRoot, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(projectRoot, ".git", "refs", "heads", "main"), "abc123\n");

    const onCandidate = vi.fn().mockResolvedValue(undefined);
    const scheduler = createWorkspaceWatchScheduler([tempRoot], onCandidate);

    try {
      await scheduler.notify(path.join(projectRoot, ".git", "HEAD"));
      await scheduler.notify(path.join(projectRoot, ".git", "refs", "heads", "main"));
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => {
        expect(onCandidate).toHaveBeenCalledTimes(1);
      });

      const canceled = vi.fn().mockResolvedValue(undefined);
      const cancelScheduler = createWorkspaceWatchScheduler([tempRoot], canceled);
      await cancelScheduler.notify(path.join(projectRoot, ".git", "config"));
      cancelScheduler.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(canceled).not.toHaveBeenCalled();
    } finally {
      scheduler.close();
      vi.useRealTimers();
    }
  });

  test("waits for an active sync callback before watcher cleanup resolves", async () => {
    vi.useFakeTimers();

    const projectRoot = path.join(tempRoot, "project-atlas");
    await mkdir(projectRoot, { recursive: true });
    await createFixtureProject(projectRoot);

    let releaseCallback!: () => void;
    let callbackStarted = false;
    let callbackSettled = false;
    const delayedCallback = new Promise<void>((resolve) => {
      releaseCallback = resolve;
    });
    const scheduler = createWorkspaceWatchScheduler([tempRoot], async () => {
      callbackStarted = true;
      await delayedCallback;
      callbackSettled = true;
    });

    try {
      await scheduler.notify(path.join(projectRoot, "README.md"));
      await vi.advanceTimersByTimeAsync(500);
      await vi.waitFor(() => {
        expect(callbackStarted).toBe(true);
      });

      let closeSettled = false;
      const closePromise = scheduler.close().then(() => {
        closeSettled = true;
      });
      await Promise.resolve();
      expect(closeSettled).toBe(false);
      expect(callbackSettled).toBe(false);

      releaseCallback();
      await closePromise;
      expect(callbackSettled).toBe(true);
      expect(closeSettled).toBe(true);
    } finally {
      releaseCallback();
      await scheduler.close();
      vi.useRealTimers();
    }
  });
});
