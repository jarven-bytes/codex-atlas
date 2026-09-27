import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Project } from "../../shared/domain";

export type SkillSource = "user";

export interface SkillProjectUsage {
  projectId: string;
  projectName: string;
  rootPath?: string;
  evidence: string[];
}

export interface InstalledSkill {
  id: string;
  name: string;
  summary: string;
  path: string;
  source: SkillSource;
  projects: SkillProjectUsage[];
}

export interface DiscoverInstalledSkillsOptions {
  userSkillsRoot?: string;
  projects: Project[];
}

interface SkillFileCandidate {
  filePath: string;
  source: SkillSource;
}

interface SkillMetadata {
  name: string;
  summary: string;
}

interface ProjectEvidence {
  project: Project;
  references: string[];
  searchableText: string;
}

const ignoredProjectDirectories = new Set([
  ".git",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "release"
]);

const readableProjectExtensions = new Set([
  ".cjs",
  ".js",
  ".json",
  ".md",
  ".mdx",
  ".txt",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml"
]);

async function readDirectory(directoryPath: string) {
  try {
    return await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function collectSkillFiles(
  rootPath: string,
  source: SkillSource,
  maxDepth: number,
  depth = 0
): Promise<SkillFileCandidate[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await readDirectory(rootPath);
  const candidates: SkillFileCandidate[] = [];
  for (const entry of entries) {
    const entryPath = path.join(rootPath, entry.name);
    if (entry.isFile() && entry.name === "SKILL.md") {
      candidates.push({ filePath: entryPath, source });
      continue;
    }

    if (entry.isDirectory() && !entry.name.startsWith(".") && depth < maxDepth) {
      candidates.push(...await collectSkillFiles(entryPath, source, maxDepth, depth + 1));
    }
  }

  return candidates;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith("\"") && trimmed.endsWith("\""))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseFrontmatter(content: string): SkillMetadata | null {
  const match = /^---\s*\n([\s\S]*?)\n---(?:\s*\n|$)/.exec(content);
  if (!match) {
    return null;
  }

  const lines = match[1].split(/\r?\n/);
  let name = "";
  let summary = "";
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const nameMatch = /^name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      name = unquote(nameMatch[1]);
      continue;
    }

    const descriptionMatch = /^description:\s*(.*)$/.exec(line);
    if (descriptionMatch) {
      const value = descriptionMatch[1].trim();
      if (value === ">" || value === "|") {
        const continuation: string[] = [];
        for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
          const nextLine = lines[nextIndex];
          if (nextLine && !/^\s+/.test(nextLine)) {
            break;
          }
          continuation.push(nextLine.trim());
          index = nextIndex;
        }
        summary = continuation.filter(Boolean).join(" ");
      } else {
        summary = unquote(value);
      }
    }
  }

  return name ? { name, summary } : null;
}

function fallbackMetadata(content: string, directoryPath: string): SkillMetadata {
  const body = content.replace(/^---\s*\n[\s\S]*?\n---\s*\n?/, "");
  const paragraph = body
    .split(/\r?\n\s*\r?\n/)
    .map((part) => part.replace(/^#+\s*/, "").replace(/[`*_]/g, "").trim())
    .find(Boolean);

  return {
    name: path.basename(directoryPath),
    summary: paragraph ?? "No summary provided."
  };
}

function normalizeSkillName(name: string): string {
  return name.trim().toLowerCase();
}

function skillPathFromFile(filePath: string): string {
  return path.dirname(filePath);
}

async function readSkillMetadata(candidate: SkillFileCandidate): Promise<InstalledSkill> {
  const content = await readFile(candidate.filePath, "utf8");
  const skillPath = skillPathFromFile(candidate.filePath);
  const metadata = parseFrontmatter(content) ?? fallbackMetadata(content, skillPath);
  return {
    id: normalizeSkillName(metadata.name),
    name: metadata.name,
    summary: metadata.summary || "No summary provided.",
    path: skillPath,
    source: candidate.source,
    projects: []
  };
}

async function collectProjectFiles(rootPath: string, maxDepth: number, depth = 0): Promise<string[]> {
  if (depth > maxDepth) {
    return [];
  }

  const entries = await readDirectory(rootPath);
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".codex") {
      continue;
    }
    if (entry.isDirectory()) {
      if (ignoredProjectDirectories.has(entry.name)) {
        continue;
      }
      files.push(...await collectProjectFiles(path.join(rootPath, entry.name), maxDepth, depth + 1));
      continue;
    }
    if (entry.isFile() && readableProjectExtensions.has(path.extname(entry.name).toLowerCase())) {
      files.push(path.join(rootPath, entry.name));
    }
  }
  return files;
}

async function collectProjectEvidence(project: Project): Promise<ProjectEvidence> {
  const searchableEntries = [
    ...(project.tags ?? []),
    ...(project.aliases ?? []),
    ...(project.importantFiles ?? []),
    ...(project.recentActivity ?? []).map((activity) => activity.message)
  ];
  const references: string[] = [];
  const rootPath = project.rootPath;
  if (rootPath) {
    const files = await collectProjectFiles(rootPath, 4);
    for (const filePath of files) {
      try {
        const contents = await readFile(filePath, "utf8");
        searchableEntries.push(contents);
        references.push(path.relative(rootPath, filePath) || path.basename(filePath));
      } catch {
        // Unreadable files do not provide usable evidence.
      }
    }
  }

  return {
    project,
    references,
    searchableText: searchableEntries.join("\n").toLowerCase()
  };
}

function projectUsageForSkill(skill: InstalledSkill, evidence: ProjectEvidence[]): SkillProjectUsage[] {
  const needle = normalizeSkillName(skill.name);
  return evidence
    .filter(({ searchableText }) => searchableText.includes(needle))
    .map(({ project, references }) => ({
      projectId: project.id,
      projectName: project.name,
      ...(project.rootPath ? { rootPath: project.rootPath } : {}),
      evidence: references
        .filter((reference) => reference.toLowerCase().includes(needle) || reference.toLowerCase().endsWith("agents.md") || reference.toLowerCase().endsWith("claude.md"))
        .slice(0, 3)
        .map((reference) => `Referenced in ${reference}`)
        .concat(references.length === 0 ? [`Referenced in project metadata`] : [])
    }))
    .filter((usage) => usage.evidence.length > 0);
}

export async function discoverInstalledSkills({
  userSkillsRoot = path.join(os.homedir(), ".codex", "skills"),
  projects
}: DiscoverInstalledSkillsOptions): Promise<InstalledSkill[]> {
  const candidates = await collectSkillFiles(userSkillsRoot, "user", 2);

  const discovered: InstalledSkill[] = [];
  const seenNames = new Set<string>();
  for (const candidate of candidates) {
    const skill = await readSkillMetadata(candidate);
    if (seenNames.has(skill.id)) {
      continue;
    }
    seenNames.add(skill.id);
    discovered.push(skill);
  }

  const evidence = await Promise.all(projects.filter((project) => !project.archived).map(collectProjectEvidence));
  return discovered
    .map((skill) => ({ ...skill, projects: projectUsageForSkill(skill, evidence) }))
    .sort((left, right) => left.name.localeCompare(right.name));
}
