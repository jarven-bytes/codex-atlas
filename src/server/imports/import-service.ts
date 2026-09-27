import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mergeCandidate } from "../sync/merge";
import { matchProject } from "../sync/identity";
import type { ProjectStore } from "../store/project-store";
import type {
  Project,
  ProjectCandidate,
  ProjectSource,
  RegistryMutation
} from "../../shared/domain";
import { LocalFolderImportAdapter } from "./local-folder";
import {
  createSchemaFingerprint,
  detectStructuredSchema,
  StructuredImportAdapter
} from "./structured";
import type {
  FieldMapping,
  ImportAdapter,
  ImportCommitResult,
  ImportPreview,
  ImportPreviewRow,
  ImportSource,
  SavedMappingEntry,
  SavedMappings
} from "./types";

interface CreateImportServiceOptions {
  store: ProjectStore;
  dataDir: string;
  adapters?: ImportAdapter[];
  previewTtlMs?: number;
}

interface StoredPreview {
  preview: ImportPreview;
}

interface MappingLookupResult {
  mapping?: FieldMapping;
  legacyWarning?: string;
}

interface MappingStoreData {
  scoped: SavedMappings;
  legacy: Partial<Record<"json" | "csv", FieldMapping>>;
}

const defaultPreviewTtlMs = 60 * 60 * 1000;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function inferRowAction(candidate: ProjectCandidate, projects: Project[]): Pick<ImportPreviewRow, "action" | "reason" | "targetProjectId"> {
  const match = matchProject(candidate, projects);

  if (match.kind === "matched") {
    return {
      action: "update",
      reason: `matched existing project by ${match.reason}`,
      targetProjectId: match.projectId
    };
  }

  if (match.duplicateProjectIds.length > 0) {
    return {
      action: "duplicate",
      reason: `review required: ${match.reason}`,
      targetProjectId: undefined
    };
  }

  return {
    action: "create",
    reason: "new project from source-backed import"
  };
}

function createImportSourceFromCandidate(candidate: ProjectCandidate): ProjectSource {
  return {
    kind: candidate.source.kind,
    label: candidate.source.label,
    sourceId: candidate.source.sourceId,
    syncStatus: candidate.source.syncStatus,
    lastSyncedAt: candidate.source.observedAt,
    unavailableReason: candidate.source.unavailableReason
  };
}

function createFieldProvenance(candidate: ProjectCandidate): NonNullable<Project["fieldProvenance"]> {
  const provenance = {
    sourceLabel: candidate.source.label,
    sourceId: candidate.source.sourceId,
    updatedAt: candidate.verifiedAt
  };

  return {
    name: provenance,
    ...(candidate.type ? { type: provenance } : {}),
    ...(candidate.rootPath ? { rootPath: provenance } : {}),
    ...(candidate.repositoryUrl ? { repositoryUrl: provenance } : {}),
    ...(candidate.aliases?.length ? { aliases: provenance } : {}),
    ...(candidate.launchTargets?.length ? { launchTargets: provenance } : {}),
    ...(candidate.missingItems?.length ? { missingItems: provenance } : {}),
    ...(candidate.tags?.length ? { tags: provenance } : {}),
    ...(candidate.needStatus ? { needStatus: provenance } : {}),
    ...(candidate.userNeed ? { userNeed: provenance } : {}),
    ...(candidate.currentState ? { currentState: provenance } : {}),
    ...(candidate.nextAction ? { nextAction: provenance } : {})
  };
}

function createProjectFromCandidate(candidate: ProjectCandidate): Project {
  const observedAt = candidate.verifiedAt;
  const launchTargets = candidate.launchTargets?.map((target) => (
    target.kind === "command"
      ? {
          ...target,
          origin: "imported" as const
        }
      : target
  )) ?? [];
  return {
    id: randomUUID(),
    name: candidate.name,
    type: candidate.type ?? "other",
    needStatus: candidate.needStatus ?? "Insufficient",
    userNeed: candidate.userNeed ?? "",
    currentState: candidate.currentState ?? "",
    nextAction: candidate.nextAction ?? "",
    rootPath: candidate.rootPath,
    repositoryUrl: candidate.repositoryUrl,
    aliases: candidate.aliases,
    launchTargets,
    importantFiles: candidate.importantFiles,
    missingItems: candidate.missingItems,
    tags: candidate.tags,
    suggestions: [],
    recentActivity: [],
    fieldProvenance: createFieldProvenance(candidate),
    attentionFlags: ["unverified"],
    sources: [createImportSourceFromCandidate(candidate)],
    lastActivityAt: candidate.lastActivityAt ?? observedAt,
    lastSyncedAt: observedAt,
    syncStatus: "success",
    updatedAt: observedAt,
    archived: false,
    pinned: false
  };
}

function isFieldMapping(value: unknown): value is FieldMapping {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isScopedMappingEntry(
  key: string,
  value: unknown
): value is SavedMappings[string] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (typeof record.format !== "string" || !isFieldMapping(record.mapping)) {
    return false;
  }

  if (typeof record.schemaFingerprint === "string") {
    return true;
  }

  if (!Array.isArray(record.detectedColumns) || record.detectedColumns.some((column) => typeof column !== "string")) {
    return false;
  }

  const derivedFingerprint = createSchemaFingerprint(
    record.format as "json" | "csv",
    record.detectedColumns as string[]
  );

  return key !== "json" && key !== "csv" && derivedFingerprint === key;
}

function splitMappings(raw: unknown): MappingStoreData {
  const result: MappingStoreData = {
    scoped: {},
    legacy: {}
  };

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }

  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if ((key === "json" || key === "csv") && isFieldMapping(value)) {
      result.legacy[key] = value;
      continue;
    }

    if (isScopedMappingEntry(key, value)) {
      const entry = value as SavedMappings[string];
      const schemaFingerprint = typeof entry.schemaFingerprint === "string"
        ? entry.schemaFingerprint
        : key;

      result.scoped[key] = {
        ...entry,
        schemaFingerprint
      };
    }
  }

  return result;
}

async function readMappings(filePath: string): Promise<MappingStoreData> {
  try {
    const raw = await readFile(filePath, "utf8");
    return splitMappings(JSON.parse(raw));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        scoped: {},
        legacy: {}
      };
    }
    throw error;
  }
}

function normalizeMappingKeys(mapping: FieldMapping): string[] {
  return Object.keys(mapping)
    .map((key) => key.trim().toLowerCase())
    .filter(Boolean)
    .sort();
}

function exactLegacyMappingForSchema(
  format: "json" | "csv",
  detectedColumns: string[],
  legacy: Partial<Record<"json" | "csv", FieldMapping>>
): MappingLookupResult {
  const legacyMapping = legacy[format];
  if (!legacyMapping) {
    return {};
  }

  const legacyKeys = normalizeMappingKeys(legacyMapping);
  const schemaKeys = detectedColumns
    .map((column) => column.trim().toLowerCase())
    .filter(Boolean)
    .sort();

  if (JSON.stringify(legacyKeys) === JSON.stringify(schemaKeys)) {
    return { mapping: legacyMapping };
  }

  return {
    legacyWarning: `legacy/unscoped ${format} mapping does not exactly match this schema; explicit review required`
  };
}

async function writeAllMappings(filePath: string, mappings: MappingStoreData): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(
    filePath,
    `${JSON.stringify({ ...mappings.legacy, ...mappings.scoped }, null, 2)}\n`,
    "utf8"
  );
}

export function createImportService(options: CreateImportServiceOptions) {
  const adapters = options.adapters ?? [new LocalFolderImportAdapter(), new StructuredImportAdapter()];
  const previews = new Map<string, StoredPreview>();
  const mappingsPath = path.join(options.dataDir, "import-mappings.json");

  function getAdapter(source: ImportSource): ImportAdapter {
    const adapter = adapters.find((entry) => entry.canHandle(source));
    if (!adapter) {
      throw new Error(`No import adapter for source kind: ${source.kind}`);
    }
    return adapter;
  }

  async function resolveMapping(source: ImportSource, mapping?: FieldMapping): Promise<MappingLookupResult> {
    if (source.kind !== "structured-file") {
      return { mapping };
    }

    const schema = await detectStructuredSchema(source);
    const savedMappings = await readMappings(mappingsPath);
    const scopedMapping = savedMappings.scoped[schema.schemaFingerprint]?.mapping;
    const legacyMappingResult = exactLegacyMappingForSchema(
      source.format,
      schema.detectedColumns,
      savedMappings.legacy
    );

    if (mapping) {
      await writeAllMappings(mappingsPath, {
        legacy: savedMappings.legacy,
        scoped: {
          ...savedMappings.scoped,
          [schema.schemaFingerprint]: {
            format: source.format,
            schemaFingerprint: schema.schemaFingerprint,
            detectedColumns: schema.detectedColumns,
            mapping
          }
        }
      });
      return { mapping };
    }

    if (scopedMapping) {
      return { mapping: scopedMapping };
    }

    return legacyMappingResult;
  }

  return {
    async listSavedMappings(format?: "json" | "csv"): Promise<SavedMappingEntry[]> {
      const savedMappings = await readMappings(mappingsPath);
      const scoped = Object.values(savedMappings.scoped)
        .filter((entry) => !format || entry.format === format)
        .map((entry) => clone(entry));
      const legacy = Object.entries(savedMappings.legacy)
        .filter(([entryFormat]) => !format || entryFormat === format)
        .map(([entryFormat, mapping]) => ({
          format: entryFormat as "json" | "csv",
          schemaFingerprint: `legacy:${entryFormat}`,
          detectedColumns: Object.keys(mapping),
          mapping: clone(mapping)
        }));
      return [...scoped, ...legacy];
    },

    async preview(source: ImportSource, mapping?: FieldMapping): Promise<ImportPreview> {
      const resolvedMapping = await resolveMapping(source, mapping);
      const effectiveMapping = resolvedMapping.mapping;
      const adapter = getAdapter(source);
      const adapterPreview = await adapter.preview(source, effectiveMapping);
      const projects = await options.store.list();
      const createdAt = new Date().toISOString();
      const previewId = randomUUID();
      const rows: ImportPreviewRow[] = adapterPreview.rows.map((row, index) => {
        const rejectEvidence = [
          { kind: "source-id" as const, value: `${source.kind}:${source.path}:row-${index + 1}` }
        ];
        if (!row.candidate) {
          const reasonParts = [resolvedMapping.legacyWarning, row.error ?? "row could not be parsed"].filter(Boolean);
          return {
            id: `row-${index + 1}`,
            action: "reject",
            reason: reasonParts.join("; "),
            evidence: rejectEvidence,
            candidate: null,
            raw: row.raw
          };
        }

        const decision = inferRowAction(row.candidate, projects);
        return {
          id: `row-${index + 1}`,
          action: decision.action,
          reason: decision.reason,
          evidence: row.candidate.evidence,
          candidate: row.candidate,
          raw: row.raw,
          targetProjectId: decision.targetProjectId
        };
      });

      const preview: ImportPreview = {
        id: previewId,
        source: clone(source),
        detectedColumns: adapterPreview.detectedColumns,
        rows,
        createdAt,
        expiresAt: new Date(Date.now() + (options.previewTtlMs ?? defaultPreviewTtlMs)).toISOString(),
        registryRevision: await options.store.getRevision()
      };

      previews.set(previewId, { preview: clone(preview) });
      return clone(preview);
    },

    async commit(previewId: string): Promise<ImportCommitResult> {
      const stored = previews.get(previewId);
      if (!stored) {
        throw new Error(`Unknown preview: ${previewId}`);
      }

      const preview = clone(stored.preview);
      if (Date.now() > Date.parse(preview.expiresAt)) {
        previews.delete(previewId);
        throw new Error(`Preview expired: ${previewId}`);
      }

      const currentSnapshot = await options.store.readSnapshot();
      const currentRevision = currentSnapshot.revision;
      const projectMap = new Map(currentSnapshot.projects.map((project) => [project.id, project]));
      const mutations: RegistryMutation[] = [];
      const commitRows: ImportCommitResult["rows"] = [];
      const committedProjects: Project[] = [];

      for (const row of preview.rows) {
        if (!row.candidate) {
          commitRows.push({
            id: row.id,
            action: row.action,
            committed: false,
            reason: row.reason
          });
          continue;
        }

        if (row.action === "duplicate" || row.action === "reject" || row.action === "skip") {
          commitRows.push({
            id: row.id,
            action: row.action,
            committed: false,
            reason: row.reason
          });
          continue;
        }

        const liveDecision = inferRowAction(row.candidate, Array.from(projectMap.values()));
        const previewDecisionChanged = (
          liveDecision.action !== row.action ||
          liveDecision.targetProjectId !== row.targetProjectId
        );
        if (previewDecisionChanged || currentRevision !== preview.registryRevision && row.action === "create" && liveDecision.action !== "create") {
          commitRows.push({
            id: row.id,
            action: "duplicate",
            committed: false,
            reason: `Registry identity changed since preview; review required (${liveDecision.reason}).`
          });
          continue;
        }

        if (liveDecision.action === "update" && liveDecision.targetProjectId) {
          row.targetProjectId = liveDecision.targetProjectId;
        }

        if (row.action === "update" && row.targetProjectId) {
          const existing = projectMap.get(row.targetProjectId);
          if (!existing) {
            commitRows.push({
              id: row.id,
              action: "reject",
              committed: false,
              reason: `target project missing for ${row.targetProjectId}`
            });
            continue;
          }

          const merged = mergeCandidate(existing, row.candidate);
          projectMap.set(merged.project.id, merged.project);
          mutations.push({
            kind: "upsert",
            project: merged.project
          });
          committedProjects.push(merged.project);
          commitRows.push({
            id: row.id,
            action: row.action,
            committed: true,
            projectId: merged.project.id,
            reason: row.reason
          });
          continue;
        }

        const created = createProjectFromCandidate(row.candidate);
        projectMap.set(created.id, created);
        mutations.push({
          kind: "upsert",
          project: created
        });
        committedProjects.push(created);
        commitRows.push({
          id: row.id,
          action: row.action,
          committed: true,
          projectId: created.id,
          reason: row.reason
        });
      }

      if (mutations.length === 0) {
        throw new Error(`Preview ${previewId} did not contain any committable rows`);
      }

      const result = await options.store.applyMutations(mutations, preview.registryRevision);
      previews.delete(previewId);

      return {
        previewId,
        importedCount: commitRows.filter((row) => row.committed).length,
        skippedCount: commitRows.filter((row) => !row.committed).length,
        rows: commitRows,
        snapshotPath: result.snapshotPath,
        projects: committedProjects
      };
    }
  };
}
