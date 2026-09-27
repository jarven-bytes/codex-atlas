import path from "node:path";
import { matchProject } from "./identity";
import { mergeCandidate } from "./merge";
import type { ProjectStore } from "../store/project-store";
import type {
  ActivityEvent,
  CodexActivityEvent,
  MatchResult,
  Project,
  ProjectCandidate,
  SyncResult
} from "../../shared/domain";

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}

function deriveAliases(event: CodexActivityEvent): string[] {
  const baseName = path.basename(path.normalize(event.workingDirectory)).trim();
  return baseName ? [baseName] : [];
}

function normalizeChangedPaths(event: CodexActivityEvent): string[] {
  return Array.from(
    new Set(
      event.changedPaths
        .map((changedPath) => changedPath.trim())
        .filter(Boolean)
        .map((changedPath) => path.normalize(changedPath))
    )
  );
}

function hasMeaningfulActivity(event: CodexActivityEvent): boolean {
  return (
    normalizeChangedPaths(event).length > 0 ||
    Boolean(event.milestone?.trim()) ||
    event.decisionOrBlocker === "decision" ||
    event.decisionOrBlocker === "blocker"
  );
}

function deriveActivity(event: CodexActivityEvent, createdAt: string): ActivityEvent[] {
  const activity: ActivityEvent[] = [];

  if (event.milestone) {
    activity.push({
      kind: "status-change",
      id: `milestone-${createdAt}`,
      message: event.milestone,
      createdAt
    });
  }

  if (event.decisionOrBlocker === "decision") {
    activity.push({
      kind: "status-change",
      id: `decision-${createdAt}`,
      message: `Decision: ${event.summary}`,
      createdAt
    });
  }

  if (event.decisionOrBlocker === "blocker") {
    activity.push({
      kind: "status-change",
      id: `blocker-${createdAt}`,
      message: `Blocker: ${event.summary}`,
      createdAt
    });
  }

  activity.push({
    kind: "sync",
    id: `sync-${createdAt}`,
    message: event.summary,
    createdAt
  });

  return activity;
}

function buildCandidate(event: CodexActivityEvent, createdAt: string): ProjectCandidate {
  const normalizedRoot = path.normalize(event.workingDirectory);
  const aliases = deriveAliases(event);
  const changedPaths = normalizeChangedPaths(event);
  const milestoneTag = event.milestone ? slugify(event.milestone) : null;

  return {
    name: path.basename(normalizedRoot),
    type: "other",
    currentState: event.summary,
    nextAction: "Review the latest Codex activity.",
    userNeed: "Track durable Codex work for this project.",
    rootPath: normalizedRoot,
    aliases,
    importantFiles: changedPaths,
    tags: Array.from(new Set(["codex", ...(milestoneTag ? [milestoneTag] : [])])),
    source: {
      kind: "codex",
      label: "Codex activity sync",
      sourceId: event.sourceId ?? `codex:${event.taskId}`,
      syncStatus: "success",
      observedAt: createdAt
    },
    evidence: [
      {
        kind: "root-path",
        value: normalizedRoot
      },
      ...(event.sourceId
        ? [
            {
              kind: "source-id" as const,
              value: event.sourceId
            }
          ]
        : []),
      ...aliases.map((alias) => ({
        kind: "alias" as const,
        value: alias
      }))
    ],
    verifiedAt: createdAt,
    lastActivityAt: createdAt
  };
}

function mergeActivity(existing: Project["recentActivity"] = [], incoming: ActivityEvent[]): ActivityEvent[] {
  return [...incoming, ...existing].slice(0, 10);
}

export async function syncCodexEvent(
  event: CodexActivityEvent,
  store: ProjectStore
): Promise<SyncResult> {
  const createdAt = new Date().toISOString();
  if (!hasMeaningfulActivity(event)) {
    return {
      mutation: "none",
      project: null,
      match: {
        kind: "ignored",
        reason: "no-meaningful-activity"
      }
    };
  }

  const candidate = buildCandidate(event, createdAt);
  return store.transact<SyncResult>(async (projects): Promise<{ result: SyncResult; projects?: Project[] }> => {
    const match = matchProject(candidate, projects);

    if (match.kind === "needs-review") {
      return {
        result: {
          mutation: "none" as const,
          project: null,
          match,
          reviewItem: {
            kind: "codex-event" as const,
            taskId: event.taskId,
            workingDirectory: event.workingDirectory,
            summary: event.summary,
            changedPaths: event.changedPaths,
            milestone: event.milestone,
            decisionOrBlocker: event.decisionOrBlocker,
            matchReason: match.reason,
            duplicateProjectIds: match.duplicateProjectIds,
            evidence: match.evidence,
            createdAt
          }
        }
      };
    }

    const mergeResult = mergeCandidate(match.project, candidate);
    mergeResult.project.importantFiles = Array.from(
      new Set([
        ...(match.project.importantFiles ?? []),
        ...(mergeResult.project.importantFiles ?? []),
        ...(candidate.importantFiles ?? [])
      ])
    ).sort();
    mergeResult.project.tags = Array.from(
      new Set([...(match.project.tags ?? []), ...(mergeResult.project.tags ?? []), ...(candidate.tags ?? [])])
    );
    mergeResult.project.recentActivity = mergeActivity(
      match.project.recentActivity,
      deriveActivity(event, createdAt)
    );
    mergeResult.project.updatedAt = createdAt;

    return {
      result: {
        mutation: "upsert" as const,
        project: mergeResult.project,
        match
      },
      projects: projects.map((project) => project.id === mergeResult.project.id ? mergeResult.project : project)
    };
  });
}
