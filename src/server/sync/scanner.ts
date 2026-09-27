import { readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import chokidar from "chokidar";
import type { CloseWatcher, ProjectCandidate, ProjectType } from "../../shared/domain";

const ignoredDirectoryNames = new Set([
  ".git",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  ".idea",
  ".vscode",
  "coverage",
  "dist",
  "build",
  "node_modules"
]);

const ignoredFileNames = new Set([
  ".env",
  ".env.local",
  ".env.development",
  ".env.production",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock"
]);

const importantMarkdownNames = new Set(["README.md", "README", "readme.md"]);
const metadataEntryNames = new Set(["README.md", "README", "readme.md", "package.json", "docs"]);
const gitMetadataRoots = new Set(["HEAD", "config"]);

function toWorkspaceSource(rootPath: string, observedAt: string) {
  return {
    kind: "workspace" as const,
    label: "Workspace scan",
    sourceId: `workspace:${rootPath}`,
    syncStatus: "success" as const,
    observedAt
  };
}

function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim().replace(/\.git$/u, "");
  const sshMatch = /^git@github\.com:(.+)$/u.exec(trimmed);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  return trimmed;
}

function inferProjectType(packageJson: Record<string, unknown> | null): ProjectType {
  const scripts = packageJson?.scripts;
  if (scripts && typeof scripts === "object") {
    const scriptNames = Object.keys(scripts as Record<string, unknown>);
    if (scriptNames.some((name) => ["dev", "build", "start", "preview"].includes(name))) {
      return "web-app";
    }
  }

  return "other";
}

function titleFromReadme(readme: string, rootPath: string): string {
  const firstHeading = readme
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => /^#\s+/u.test(line));

  if (firstHeading) {
    return firstHeading.replace(/^#\s+/u, "").trim();
  }

  return path.basename(rootPath);
}

async function readPackageJson(projectRoot: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await readFile(path.join(projectRoot, "package.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function readReadme(projectRoot: string): Promise<string | null> {
  for (const fileName of importantMarkdownNames) {
    try {
      return await readFile(path.join(projectRoot, fileName), "utf8");
    } catch {
      continue;
    }
  }

  return null;
}

async function readRepositoryUrl(projectRoot: string, packageJson: Record<string, unknown> | null): Promise<string | undefined> {
  const repository = packageJson?.repository;
  if (typeof repository === "string" && repository.trim()) {
    return normalizeRepositoryUrl(repository);
  }

  if (repository && typeof repository === "object") {
    const repositoryUrl = (repository as Record<string, unknown>).url;
    if (typeof repositoryUrl === "string" && repositoryUrl.trim()) {
      return normalizeRepositoryUrl(repositoryUrl);
    }
  }

  try {
    const gitConfig = await readFile(path.join(projectRoot, ".git", "config"), "utf8");
    const remoteMatch = /^\s*url = (.+)$/mu.exec(gitConfig);
    if (remoteMatch?.[1]) {
      return normalizeRepositoryUrl(remoteMatch[1]);
    }
  } catch {
    return undefined;
  }

  return undefined;
}

async function collectImportantFiles(projectRoot: string): Promise<string[]> {
  const entries = await readdir(projectRoot, { withFileTypes: true });
  const importantFiles = new Set<string>();

  for (const entry of entries) {
    if (ignoredFileNames.has(entry.name)) {
      continue;
    }

    if (entry.isDirectory()) {
      if (!metadataEntryNames.has(entry.name) || ignoredDirectoryNames.has(entry.name)) {
        continue;
      }

      if (entry.name === "docs") {
        const docsEntries = await readdir(path.join(projectRoot, entry.name), { withFileTypes: true });
        for (const docEntry of docsEntries) {
          if (docEntry.isFile() && docEntry.name.endsWith(".md")) {
            importantFiles.add(path.posix.join("docs", docEntry.name));
          }
        }
      }
      continue;
    }

    if (metadataEntryNames.has(entry.name)) {
      importantFiles.add(entry.name);
    }
  }

  return Array.from(importantFiles).sort();
}

function createLaunchTargets(projectRoot: string, packageJson: Record<string, unknown> | null) {
  const targets: ProjectCandidate["launchTargets"] = [
    {
      kind: "folder",
      id: "workspace-root",
      label: "Workspace root",
      path: projectRoot
    }
  ];
  const scripts = packageJson?.scripts;

  if (scripts && typeof scripts === "object") {
    for (const [scriptName] of Object.entries(scripts as Record<string, unknown>)) {
      targets.push({
        kind: "command",
        id: `script-${scriptName}`,
        label: `Run ${scriptName}`,
        origin: "scanner",
        executable: "npm",
        args: ["run", scriptName],
        cwd: projectRoot
      });
    }
  }

  return targets;
}

function metadataChanged(changedPath: string): boolean {
  const baseName = path.basename(changedPath);
  const normalizedPath = path.normalize(changedPath);
  const gitPathMarker = `${path.sep}.git${path.sep}`;
  const gitIndex = normalizedPath.lastIndexOf(gitPathMarker);

  if (gitIndex >= 0) {
    const gitRelativePath = normalizedPath.slice(gitIndex + gitPathMarker.length);
    const gitSegments = gitRelativePath.split(path.sep).filter(Boolean);
    if (gitSegments[0] && gitMetadataRoots.has(gitSegments[0])) {
      return true;
    }

    return gitSegments[0] === "refs" && gitSegments.length >= 2;
  }

  if (ignoredFileNames.has(baseName)) {
    return false;
  }

  const segments = changedPath.split(path.sep);
  if (segments.some((segment) => ignoredDirectoryNames.has(segment))) {
    return false;
  }

  return (
    baseName === "package.json" ||
    importantMarkdownNames.has(baseName) ||
    segments.includes("docs")
  );
}

async function detectProjectRoot(changedPath: string, roots: string[]): Promise<string | null> {
  const resolvedChangedPath = path.resolve(changedPath);
  const containingRoot = roots
    .map((root) => path.resolve(root))
    .find((root) => resolvedChangedPath === root || resolvedChangedPath.startsWith(`${root}${path.sep}`));

  if (!containingRoot) {
    return null;
  }

  let currentPath = resolvedChangedPath;

  try {
    const currentStat = await stat(currentPath);
    if (!currentStat.isDirectory()) {
      currentPath = path.dirname(currentPath);
    }
  } catch {
    currentPath = path.dirname(currentPath);
  }

  while (currentPath === containingRoot || currentPath.startsWith(`${containingRoot}${path.sep}`)) {
    const packagePath = path.join(currentPath, "package.json");
    const readmePath = path.join(currentPath, "README.md");
    const hasPackage = await stat(packagePath).then((entry) => entry.isFile()).catch(() => false);
    const hasReadme = await stat(readmePath).then((entry) => entry.isFile()).catch(() => false);
    if (hasPackage || hasReadme) {
      return currentPath;
    }

    if (currentPath === containingRoot) {
      break;
    }

    currentPath = path.dirname(currentPath);
  }

  return null;
}

async function resolveContainedPath(candidateRoot: string): Promise<string> {
  try {
    return await realpath(candidateRoot);
  } catch {
    return path.resolve(candidateRoot);
  }
}

async function resolveAllowedRoot(root: string): Promise<string> {
  try {
    return await realpath(root);
  } catch {
    return path.resolve(root);
  }
}

export async function isRootWithinAllowedRoots(
  rootPath: string,
  allowedRoots: string[]
): Promise<boolean> {
  if (allowedRoots.length === 0) {
    return false;
  }

  const candidateRoot = await resolveContainedPath(rootPath);

  for (const allowedRoot of allowedRoots) {
    const resolvedAllowedRoot = await resolveAllowedRoot(allowedRoot);
    if (
      candidateRoot === resolvedAllowedRoot ||
      candidateRoot.startsWith(`${resolvedAllowedRoot}${path.sep}`)
    ) {
      return true;
    }
  }

  return false;
}

function buildOutsideRootsCandidate(rootPath: string, verifiedAt: string): ProjectCandidate {
  const normalizedRoot = path.normalize(rootPath);
  return {
    name: path.basename(normalizedRoot) || normalizedRoot,
    rootPath: normalizedRoot,
    launchTargets: [],
    source: {
      kind: "workspace",
      label: "Workspace scan",
      sourceId: `workspace:${normalizedRoot}`,
      syncStatus: "unavailable",
      observedAt: verifiedAt,
      unavailableReason: "Root is outside configured workspace roots."
    },
    evidence: [
      {
        kind: "root-path",
        value: normalizedRoot
      }
    ],
    verifiedAt,
    unavailableFields: ["name", "rootPath", "repositoryUrl", "launchTargets"]
  };
}

export async function createWorkspaceCandidate(
  rootPath: string,
  allowedRoots: string[]
): Promise<ProjectCandidate> {
  const verifiedAt = new Date().toISOString();
  if (!(await isRootWithinAllowedRoots(rootPath, allowedRoots))) {
    return buildOutsideRootsCandidate(rootPath, verifiedAt);
  }

  return scanProjectRoot(rootPath);
}

export function createWorkspaceWatchScheduler(
  roots: string[],
  onCandidate: (candidate: ProjectCandidate) => Promise<void>
) {
  const resolvedRoots = roots.map((root) => path.resolve(root));
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  const activeCallbacks = new Set<Promise<void>>();
  let closed = false;

  return {
    async notify(changedPath: string): Promise<void> {
      if (closed) {
        return;
      }

      if (!metadataChanged(changedPath)) {
        return;
      }

      const projectRoot = await detectProjectRoot(changedPath, resolvedRoots);
      if (!projectRoot) {
        return;
      }
      if (closed) {
        return;
      }

      const existingTimer = debounceTimers.get(projectRoot);
      if (existingTimer) {
        clearTimeout(existingTimer);
      }

      debounceTimers.set(
        projectRoot,
        setTimeout(() => {
          debounceTimers.delete(projectRoot);
          if (closed) {
            return;
          }

          const callback = createWorkspaceCandidate(projectRoot, resolvedRoots).then(onCandidate);
          activeCallbacks.add(callback);
          void callback.then(
            () => activeCallbacks.delete(callback),
            () => activeCallbacks.delete(callback)
          );
        }, 500)
      );
    },
    async close() {
      closed = true;
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      await Promise.allSettled(activeCallbacks);
    }
  };
}

export async function scanProjectRoot(rootPath: string): Promise<ProjectCandidate> {
  const normalizedRoot = path.normalize(rootPath);
  const verifiedAt = new Date().toISOString();

  try {
    const resolvedRoot = await realpath(normalizedRoot);
    const packageJson = await readPackageJson(resolvedRoot);
    const readme = await readReadme(resolvedRoot);
    const repositoryUrl = await readRepositoryUrl(resolvedRoot, packageJson);
    const importantFiles = await collectImportantFiles(resolvedRoot);
    const packageName = typeof packageJson?.name === "string" ? packageJson.name.trim() : "";
    const alias = packageName || path.basename(resolvedRoot);

    return {
      name: readme ? titleFromReadme(readme, normalizedRoot) : path.basename(normalizedRoot),
      type: inferProjectType(packageJson),
      rootPath: normalizedRoot,
      repositoryUrl,
      aliases: alias ? [alias] : [],
      launchTargets: createLaunchTargets(normalizedRoot, packageJson),
      importantFiles,
      source: toWorkspaceSource(resolvedRoot, verifiedAt),
      evidence: [
        {
          kind: "root-path",
          value: normalizedRoot
        },
        ...(repositoryUrl
          ? [
              {
                kind: "repository-url" as const,
                value: repositoryUrl
              }
            ]
          : []),
        ...(alias
          ? [
              {
                kind: "alias" as const,
                value: alias
              }
            ]
          : [])
      ],
      verifiedAt
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      name: path.basename(normalizedRoot) || normalizedRoot,
      rootPath: normalizedRoot,
      launchTargets: [],
      source: {
        kind: "workspace",
        label: "Workspace scan",
        sourceId: `workspace:${normalizedRoot}`,
        syncStatus: "unavailable",
        observedAt: verifiedAt,
        unavailableReason: message
      },
      evidence: [
        {
          kind: "root-path",
          value: normalizedRoot
        }
      ],
      verifiedAt,
      unavailableFields: ["name", "rootPath", "repositoryUrl", "launchTargets"]
    };
  }
}

export function startWorkspaceWatcher(
  roots: string[],
  onCandidate: (candidate: ProjectCandidate) => Promise<void>
): CloseWatcher {
  const resolvedRoots = roots.map((root) => path.resolve(root));
  const scheduler = createWorkspaceWatchScheduler(resolvedRoots, onCandidate);
  const watcher = chokidar.watch(resolvedRoots, {
    ignoreInitial: true,
    ignored: (watchPath, stats) => {
      const baseName = path.basename(watchPath);
      if (ignoredFileNames.has(baseName)) {
        return true;
      }

      const segments = watchPath.split(path.sep);
      if (segments.some((segment) => ignoredDirectoryNames.has(segment))) {
        return true;
      }

      return stats?.isFile() ? false : false;
    }
  });

  watcher.on("add", (changedPath) => {
    void scheduler.notify(changedPath);
  });
  watcher.on("change", (changedPath) => {
    void scheduler.notify(changedPath);
  });
  watcher.on("unlink", (changedPath) => {
    void scheduler.notify(changedPath);
  });

  return async () => {
    await scheduler.close();
    await watcher.close();
  };
}
