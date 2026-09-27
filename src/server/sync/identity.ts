import path from "node:path";
import type { MatchResult, Project, ProjectCandidate } from "../../shared/domain";

function normalizePath(value?: string): string | null {
  if (!value) {
    return null;
  }

  return path.normalize(value);
}

function normalizeRepository(value?: string): string | null {
  if (!value) {
    return null;
  }

  return value.trim().replace(/\.git$/u, "");
}

function normalizeAlias(value: string): string {
  return value.trim().toLowerCase();
}

function matched(
  project: Project,
  candidate: ProjectCandidate,
  confidence: Extract<MatchResult, { kind: "matched" }>["confidence"],
  reason: Extract<MatchResult, { kind: "matched" }>["reason"]
): MatchResult {
  return {
    kind: "matched",
    projectId: project.id,
    project,
    confidence,
    reason,
    evidence: candidate.evidence
  };
}

function needsReview(
  candidate: ProjectCandidate,
  reason: Extract<MatchResult, { kind: "needs-review" }>["reason"],
  projects: Project[]
): MatchResult {
  return {
    kind: "needs-review",
    projectId: null,
    project: null,
    confidence: "low",
    reason,
    evidence: candidate.evidence,
    duplicateProjectIds: projects.map((project) => project.id)
  };
}

export function matchProject(candidate: ProjectCandidate, projects: Project[]): MatchResult {
  const candidateSourceId = candidate.source.sourceId;

  if (candidateSourceId) {
    const bySourceId = projects.filter((project) =>
      project.sources.some((source) => source.sourceId === candidateSourceId)
    );

    if (bySourceId.length === 1) {
      return matched(bySourceId[0], candidate, "high", "source-id");
    }

    if (bySourceId.length > 1) {
      return needsReview(candidate, "source-id-conflict", bySourceId);
    }
  }

  const candidateRoot = normalizePath(candidate.rootPath);
  if (candidateRoot) {
    const byRoot = projects.filter((project) => normalizePath(project.rootPath) === candidateRoot);
    if (byRoot.length === 1) {
      return matched(byRoot[0], candidate, "high", "root-path");
    }

    if (byRoot.length > 1) {
      return needsReview(candidate, "root-path-conflict", byRoot);
    }
  }

  const candidateRepository = normalizeRepository(candidate.repositoryUrl);
  if (candidateRepository) {
    const byRepository = projects.filter(
      (project) => normalizeRepository(project.repositoryUrl) === candidateRepository
    );

    if (byRepository.length === 1) {
      return matched(byRepository[0], candidate, "high", "repository-url");
    }

    if (byRepository.length > 1) {
      return needsReview(candidate, "repository-url-conflict", byRepository);
    }
  }

  const candidateAliases = (candidate.aliases ?? []).map(normalizeAlias);
  const aliasMatches = projects.filter((project) =>
    (project.aliases ?? []).some((alias) => candidateAliases.includes(normalizeAlias(alias)))
  );

  if (aliasMatches.length === 1) {
    return matched(aliasMatches[0], candidate, "medium", "alias");
  }

  if (aliasMatches.length > 1) {
    return needsReview(candidate, "alias-conflict", aliasMatches);
  }

  return needsReview(candidate, "no-confident-match", []);
}
