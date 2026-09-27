import type {
  AttentionFlag,
  FieldProvenance,
  MergeResult,
  NeedStatus,
  Project,
  ProjectCandidate,
  ProjectFieldKey,
  ProjectSource,
  Suggestion
} from "../../shared/domain";

export const DEFAULT_STALE_AFTER_DAYS = 30;

const protectedFields: Suggestion["field"][] = [
  "needStatus",
  "userNeed",
  "currentState",
  "nextAction"
];

const verifiedFields: ProjectFieldKey[] = [
  "name",
  "type",
  "rootPath",
  "repositoryUrl",
  "aliases",
  "launchTargets",
  "importantFiles",
  "missingItems",
  "tags",
  "lastActivityAt",
  "lastSyncedAt",
  "syncStatus"
];

function cloneProject(project: Project): Project {
  return JSON.parse(JSON.stringify(project)) as Project;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function getProjectField(project: Project, field: ProjectFieldKey): unknown {
  return (project as unknown as Record<string, unknown>)[field];
}

function setProjectField(project: Project, field: ProjectFieldKey, value: unknown): void {
  (project as unknown as Record<string, unknown>)[field] = value;
}

function getCandidateField(candidate: ProjectCandidate, field: ProjectFieldKey): unknown {
  return (candidate as unknown as Record<string, unknown>)[field];
}

function setProtectedField(
  project: Project,
  field: Suggestion["field"],
  value: Exclude<ProjectCandidate[Suggestion["field"]], undefined>
): void {
  switch (field) {
    case "needStatus":
      project.needStatus = value as NeedStatus;
      break;
    case "userNeed":
      project.userNeed = value;
      break;
    case "currentState":
      project.currentState = value;
      break;
    case "nextAction":
      project.nextAction = value;
      break;
  }
}

function toProjectSource(candidate: ProjectCandidate): ProjectSource {
  return {
    kind: candidate.source.kind,
    label: candidate.source.label,
    sourceId: candidate.source.sourceId,
    syncStatus: candidate.source.syncStatus,
    lastSyncedAt: candidate.source.observedAt,
    unavailableReason: candidate.source.unavailableReason
  };
}

function createProvenance(candidate: ProjectCandidate): FieldProvenance {
  return {
    sourceLabel: candidate.source.label,
    sourceId: candidate.source.sourceId,
    updatedAt: candidate.verifiedAt
  };
}

function createSuggestion(
  field: Suggestion["field"],
  currentValue: string,
  proposedValue: string,
  candidate: ProjectCandidate
): Suggestion {
  return {
    kind: "field-update",
    id: `${field}-${candidate.verifiedAt}`,
    field,
    title: `Review ${field}`,
    detail: `${candidate.source.label} proposed a new ${field}.`,
    currentValue,
    proposedValue,
    evidence: candidate.evidence,
    createdAt: candidate.verifiedAt
  };
}

function markUnavailable(
  project: Project,
  field: ProjectFieldKey,
  candidate: ProjectCandidate
): void {
  project.fieldProvenance ??= {};
  const previous = project.fieldProvenance[field];
  project.fieldProvenance[field] = {
    sourceLabel: candidate.source.label,
    sourceId: candidate.source.sourceId,
    updatedAt: previous?.updatedAt ?? candidate.verifiedAt,
    unavailableAt: candidate.verifiedAt,
    unavailableReason: candidate.source.unavailableReason,
    lastVerifiedValue: getProjectField(project, field)
  };
}

export function mergeCandidate(existing: Project, candidate: ProjectCandidate): MergeResult {
  const project = cloneProject(existing);
  const changedFields: ProjectFieldKey[] = [];
  const preservedFields: Array<Suggestion["field"]> = [];
  const suggestions: Suggestion[] = [...(existing.suggestions ?? [])];

  project.fieldProvenance = { ...(existing.fieldProvenance ?? {}) };
  project.sources = project.sources.filter(
    (source) => source.sourceId !== candidate.source.sourceId || source.kind !== candidate.source.kind
  );
  project.sources.push(toProjectSource(candidate));
  project.lastSyncedAt = candidate.source.observedAt;
  project.syncStatus = candidate.source.syncStatus;
  project.updatedAt = candidate.verifiedAt;

  for (const field of verifiedFields) {
    const nextValue = field === "lastSyncedAt"
      ? candidate.verifiedAt
      : field === "syncStatus"
        ? candidate.source.syncStatus
        : field === "lastActivityAt"
          ? candidate.lastActivityAt ?? project.lastActivityAt
          : getCandidateField(candidate, field);

    if (candidate.unavailableFields?.includes(field)) {
      markUnavailable(project, field, candidate);
      continue;
    }

    if (typeof nextValue === "undefined") {
      continue;
    }

    if (!valuesEqual(getProjectField(project, field), nextValue)) {
      setProjectField(project, field, nextValue);
      changedFields.push(field);
    }

    project.fieldProvenance[field] = createProvenance(candidate);
  }

  for (const field of protectedFields) {
    const nextValue = candidate[field];

    if (typeof nextValue === "undefined" || nextValue === "") {
      continue;
    }

    const currentValue = project[field];
    if (!currentValue) {
      setProtectedField(project, field, nextValue);
      project.fieldProvenance[field] = createProvenance(candidate);
      changedFields.push(field);
      continue;
    }

    if (currentValue !== nextValue) {
      preservedFields.push(field);
      suggestions.push(createSuggestion(field, String(currentValue), String(nextValue), candidate));
    }
  }

  project.suggestions = suggestions;
  project.attentionFlags = deriveAttentionFlags(project, new Date(candidate.verifiedAt), DEFAULT_STALE_AFTER_DAYS);

  return {
    project,
    suggestions,
    changedFields,
    preservedFields,
    attentionFlags: project.attentionFlags
  };
}

export function deriveAttentionFlags(
  project: Project,
  now: Date,
  staleAfterDays = DEFAULT_STALE_AFTER_DAYS
): AttentionFlag[] {
  const flags = new Set<AttentionFlag>();

  if (!project.archived) {
    const ageMs = now.getTime() - new Date(project.lastActivityAt).getTime();
    if (ageMs >= staleAfterDays * 24 * 60 * 60 * 1000) {
      flags.add("stale");
    }
  }

  if (
    project.syncStatus === "failed" ||
    project.sources.some((source) => source.syncStatus === "failed")
  ) {
    flags.add("sync-failed");
  }

  if (
    project.syncStatus !== "success" ||
    project.sources.some((source) => source.syncStatus !== "success")
  ) {
    flags.add("unverified");
  }

  if ((project.suggestions ?? []).length > 0) {
    flags.add("needs-review");
  }

  return Array.from(flags).sort((left, right) => {
    const order: AttentionFlag[] = ["needs-review", "stale", "sync-failed", "unverified"];
    return order.indexOf(left) - order.indexOf(right);
  });
}
