import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { serverConfig } from "../config";
import type { MutationResult, Project, RegistryMutation, UndoResult } from "../../shared/domain";

interface ProjectStorePaths {
  dataDir: string;
  historyDir: string;
  registryPath: string;
}

export interface BatchMutationResult {
  mutation: "batch";
  projects: Project[];
  previousProjects: Project[];
  registry: Project[];
  registryPath: string;
  snapshotPath: string;
}

export interface ProjectStore {
  list(): Promise<Project[]>;
  transact<T>(
    operation: (projects: Project[]) => Promise<{ result: T; projects?: Project[] }>
  ): Promise<T>;
  readSnapshot(): Promise<{ projects: Project[]; revision: string }>;
  get(projectId: string): Promise<Project | null>;
  applyMutation(mutation: RegistryMutation): Promise<MutationResult>;
  applyMutations(mutations: RegistryMutation[], expectedRevision?: string): Promise<BatchMutationResult>;
  getRevision(): Promise<string>;
  undoLastMutation(expectedSnapshotPath?: string): Promise<UndoResult>;
  export(format: "json" | "markdown" | "csv"): Promise<string>;
}

interface CreateProjectStoreOptions {
  dataDir?: string;
}

let snapshotSequence = 0;
const snapshotSequenceWidth = 8;

function resolvePaths(options: CreateProjectStoreOptions = {}): ProjectStorePaths {
  if (!options.dataDir) {
    return {
      dataDir: serverConfig.dataDir,
      historyDir: serverConfig.historyDir,
      registryPath: serverConfig.registryPath
    };
  }

  return {
    dataDir: options.dataDir,
    historyDir: path.join(options.dataDir, "history"),
    registryPath: path.join(options.dataDir, "projects.json")
  };
}

function withTrailingNewline(value: string): string {
  return `${value}\n`;
}

function formatSnapshotSequence(sequence: number): string {
  return sequence.toString().padStart(snapshotSequenceWidth, "0");
}

function parseSnapshotParts(fileName: string): { timestamp: string; sequence: string } | null {
  const match = /^(\d+)-(\d+)-projects\.json$/.exec(fileName);
  if (!match) {
    return null;
  }

  const [, timestampPart, sequencePart] = match;
  return {
    timestamp: timestampPart,
    sequence: sequencePart
  };
}

export function compareSnapshotEntries(left: string, right: string): number {
  const leftParts = parseSnapshotParts(left);
  const rightParts = parseSnapshotParts(right);

  if (!leftParts && !rightParts) {
    return left.localeCompare(right);
  }

  if (!leftParts) {
    return -1;
  }

  if (!rightParts) {
    return 1;
  }

  const timestampComparison = leftParts.timestamp.localeCompare(rightParts.timestamp);
  if (timestampComparison !== 0) {
    return timestampComparison;
  }

  return leftParts.sequence.localeCompare(rightParts.sequence);
}

async function atomicWriteFile(filePath: string, contents: string): Promise<void> {
  const tempPath = path.join(
    path.dirname(filePath),
    `${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );

  await writeFile(tempPath, contents, "utf8");
  await rename(tempPath, filePath);
}

async function ensureRegistry(paths: ProjectStorePaths): Promise<void> {
  await mkdir(paths.historyDir, { recursive: true });
  await mkdir(paths.dataDir, { recursive: true });

  try {
    await readFile(paths.registryPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }

    await atomicWriteFile(paths.registryPath, withTrailingNewline("[]"));
  }
}

async function readRegistry(paths: ProjectStorePaths): Promise<Project[]> {
  const { projects } = await readRegistryWithRevision(paths);
  return projects;
}

async function readRegistryWithRevision(paths: ProjectStorePaths): Promise<{
  projects: Project[];
  revision: string;
}> {
  await ensureRegistry(paths);
  const raw = await readFile(paths.registryPath, "utf8");
  return {
    projects: JSON.parse(raw) as Project[],
    revision: createHash("sha256").update(raw).digest("hex")
  };
}

async function writeRegistry(paths: ProjectStorePaths, projects: Project[]): Promise<void> {
  const contents = withTrailingNewline(JSON.stringify(projects, null, 2));
  await atomicWriteFile(paths.registryPath, contents);
}

async function createSnapshot(paths: ProjectStorePaths, projects: Project[]): Promise<string> {
  snapshotSequence += 1;
  const snapshotPath = path.join(
    paths.historyDir,
    `${Date.now()}-${formatSnapshotSequence(snapshotSequence)}-projects.json`
  );
  await atomicWriteFile(
    snapshotPath,
    withTrailingNewline(JSON.stringify(projects, null, 2))
  );
  return snapshotPath;
}

function upsertProject(registry: Project[], incoming: Project): MutationResult["project"] {
  const current = registry.find((project) => project.id === incoming.id) ?? null;
  const normalizedProject: Project = current
    ? {
        ...incoming,
        lastActivityAt: incoming.lastActivityAt || current.lastActivityAt,
        lastSyncedAt: incoming.lastSyncedAt || current.lastSyncedAt
      }
    : incoming;

  const nextRegistry = current
    ? registry.map((project) => (project.id === incoming.id ? normalizedProject : project))
    : [...registry, normalizedProject];

  registry.splice(0, registry.length, ...nextRegistry);
  return normalizedProject;
}

function removeProject(registry: Project[], projectId: string): Project | null {
  const index = registry.findIndex((project) => project.id === projectId);
  if (index === -1) {
    return null;
  }

  const [removed] = registry.splice(index, 1);
  return removed;
}

function escapeCsv(value: string): string {
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

const registryExportFields = [
  "id",
  "name",
  "type",
  "needStatus",
  "userNeed",
  "currentState",
  "nextAction",
  "rootPath",
  "repositoryUrl",
  "aliases",
  "importantFiles",
  "launchTargets",
  "sources",
  "missingItems",
  "tags",
  "suggestions",
  "recentActivity",
  "fieldProvenance",
  "attentionFlags",
  "lastActivityAt",
  "lastSyncedAt",
  "syncStatus",
  "pinned",
  "archived",
  "updatedAt"
] as const satisfies readonly (keyof Project)[];

function serializeExportValue(value: unknown): string {
  if (typeof value === "undefined" || value === null) {
    return "";
  }

  return typeof value === "string" ? value : JSON.stringify(value);
}

function formatMarkdownValue(value: unknown): string {
  const serialized = serializeExportValue(value);
  return serialized || "(none)";
}

export function createProjectStore(options: CreateProjectStoreOptions = {}): ProjectStore {
  const paths = resolvePaths(options);
  let queue = Promise.resolve();

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    async list() {
      return enqueue(() => readRegistry(paths));
    },

    async transact(operation) {
      return enqueue(async () => {
        const registry = await readRegistry(paths);
        const transaction = await operation(registry);
        if (transaction.projects) {
          await createSnapshot(paths, registry);
          await writeRegistry(paths, transaction.projects);
        }
        return transaction.result;
      });
    },

    async readSnapshot() {
      return enqueue(() => readRegistryWithRevision(paths));
    },

    async get(projectId) {
      return enqueue(async () => {
        const registry = await readRegistry(paths);
        return registry.find((project) => project.id === projectId) ?? null;
      });
    },

    async getRevision() {
      return enqueue(async () => (await readRegistryWithRevision(paths)).revision);
    },

    async applyMutation(mutation) {
      return enqueue(async () => {
        const registry = await readRegistry(paths);
        const snapshotPath = await createSnapshot(paths, registry);
        let project: Project | null = null;
        let previousProject: Project | null = null;

        if (mutation.kind === "upsert") {
          previousProject = registry.find((entry) => entry.id === mutation.project.id) ?? null;
          project = upsertProject(registry, mutation.project);
        } else {
          previousProject = registry.find((entry) => entry.id === mutation.projectId) ?? null;
          project = removeProject(registry, mutation.projectId);
        }

        await writeRegistry(paths, registry);

        return {
          mutation: mutation.kind,
          project,
          previousProject,
          registry,
          registryPath: paths.registryPath,
          snapshotPath
        };
      });
    },

    async applyMutations(mutations, expectedRevision) {
      return enqueue(async () => {
        const current = await readRegistryWithRevision(paths);
        if (expectedRevision && current.revision !== expectedRevision) {
          const error = new Error("Registry changed since the import preview.") as Error & { code: string };
          error.code = "REGISTRY_REVISION_CONFLICT";
          throw error;
        }

        const registry = current.projects;
        const snapshotPath = await createSnapshot(paths, registry);
        const projects: Project[] = [];
        const previousProjects: Project[] = [];

        for (const mutation of mutations) {
          if (mutation.kind === "upsert") {
            const previousProject = registry.find((entry) => entry.id === mutation.project.id) ?? null;
            if (previousProject) {
              previousProjects.push(previousProject);
            }
            const project = upsertProject(registry, mutation.project);
            if (project) {
              projects.push(project);
            }
            continue;
          }

          const previousProject = registry.find((entry) => entry.id === mutation.projectId) ?? null;
          if (previousProject) {
            previousProjects.push(previousProject);
          }
          const project = removeProject(registry, mutation.projectId);
          if (project) {
            projects.push(project);
          }
        }

        await writeRegistry(paths, registry);

        return {
          mutation: "batch" as const,
          projects,
          previousProjects,
          registry,
          registryPath: paths.registryPath,
          snapshotPath
        };
      });
    },

    async undoLastMutation(expectedSnapshotPath) {
      return enqueue(async () => {
        await ensureRegistry(paths);
        const snapshots = (await readdir(paths.historyDir))
          .filter((entry) => entry.endsWith(".json"))
          .sort(compareSnapshotEntries);
        const latestSnapshot = snapshots.at(-1);

        if (!latestSnapshot) {
          return {
            restored: false,
            registry: await readRegistry(paths),
            snapshotPath: null,
            reason: "no-snapshot" as const
          };
        }

        const snapshotPath = path.join(paths.historyDir, latestSnapshot);
        if (expectedSnapshotPath && path.resolve(expectedSnapshotPath) !== path.resolve(snapshotPath)) {
          return {
            restored: false,
            registry: await readRegistry(paths),
            snapshotPath: null,
            reason: "snapshot-mismatch" as const
          };
        }
        const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Project[];

        await writeRegistry(paths, snapshot);
        await rm(snapshotPath);

        return {
          restored: true,
          registry: snapshot,
          snapshotPath
        };
      });
    },

    async export(format) {
      return enqueue(async () => {
        const registry = await readRegistry(paths);

        if (format === "json") {
          return withTrailingNewline(JSON.stringify(registry, null, 2));
        }

        if (format === "markdown") {
        const lines = ["# Project Registry", ""];

        for (const project of registry) {
          lines.push(`## ${project.name}`);
          lines.push(`- Status: ${project.needStatus}`);
          lines.push(`- User need: ${project.userNeed}`);
          lines.push(`- Current state: ${project.currentState}`);
          lines.push(`- Next action: ${project.nextAction}`);
          lines.push(`- Root path: ${formatMarkdownValue(project.rootPath)}`);
          lines.push(`- Missing information: ${formatMarkdownValue(project.missingItems)}`);
          lines.push(`- Sources / provenance: ${formatMarkdownValue(project.sources)}`);
          lines.push(`- Attention: ${formatMarkdownValue(project.attentionFlags)}`);
          lines.push(`- Launch targets: ${formatMarkdownValue(project.launchTargets)}`);
          lines.push("");
          lines.push("```json");
          lines.push(JSON.stringify(project, null, 2));
          lines.push("```");
          lines.push("");
        }

          return `${lines.join("\n").trimEnd()}\n`;
        }

      const header = [...registryExportFields];
      const rows = registry.map((project) =>
        registryExportFields
          .map((field) => escapeCsv(serializeExportValue(project[field])))
          .join(",")
      );

        return `${header.join(",")}\n${rows.join("\n")}\n`;
      });
    }
  };
}
