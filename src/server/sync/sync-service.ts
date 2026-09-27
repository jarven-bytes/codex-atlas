import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { matchProject } from "./identity";
import { mergeCandidate } from "./merge";
import { scanProjectRoot, startWorkspaceWatcher } from "./scanner";
import { syncCodexEvent } from "./codex-events";
import type { ProjectStore } from "../store/project-store";
import type {
  CloseWatcher,
  CodexActivityEvent,
  MatchResult,
  Project,
  ProjectCandidate,
  SyncReviewItem,
  SyncResult,
  SyncScanOutcome
} from "../../shared/domain";

export interface SyncService {
  syncCodexEvent(event: CodexActivityEvent): Promise<SyncResult>;
  syncWorkspaceCandidate(candidate: ProjectCandidate): Promise<SyncResult>;
  scanRoots(): Promise<SyncScanOutcome>;
  listReviews(): Promise<SyncReviewItem[]>;
  startWatcher(): Promise<CloseWatcher | null>;
}

interface CreateSyncServiceOptions {
  store: ProjectStore;
  dataDir: string;
  workspaceRoots: string[];
  enableWatcher?: boolean;
  log?: (message: string) => void;
}

function reviewFilePath(dataDir: string): string {
  return path.join(dataDir, "sync-reviews.json");
}

async function readReviewFile(filePath: string): Promise<SyncReviewItem[]> {
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is SyncReviewItem => (
      Boolean(entry) && typeof entry === "object" && (entry as SyncReviewItem).status === "open"
    )) : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeReviewFile(filePath: string, reviews: SyncReviewItem[]): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(reviews, null, 2)}\n`, "utf8");
  await rename(temporaryPath, filePath);
}

function toReviewItem(
  candidate: ProjectCandidate,
  match: Extract<MatchResult, { kind: "needs-review" }>,
  extra: Partial<Pick<SyncReviewItem, "kind" | "taskId" | "workingDirectory" | "summary" | "changedPaths">> = {}
): SyncReviewItem {
  return {
    id: randomUUID(),
    kind: extra.kind ?? (candidate.source.kind === "codex" ? "codex-event" : "workspace-scan"),
    sourceLabel: candidate.source.label,
    reason: match.reason,
    evidence: match.evidence,
    duplicateProjectIds: match.duplicateProjectIds,
    createdAt: candidate.verifiedAt,
    status: "open",
    ...extra
  };
}

export function createSyncService(options: CreateSyncServiceOptions): SyncService {
  const reviewsPath = reviewFilePath(options.dataDir);
  let reviewQueue = Promise.resolve();

  function enqueueReview<T>(operation: () => Promise<T>): Promise<T> {
    const result = reviewQueue.then(operation, operation);
    reviewQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  async function listReviews(): Promise<SyncReviewItem[]> {
    return enqueueReview(() => readReviewFile(reviewsPath));
  }

  async function persistReview(review: SyncReviewItem): Promise<SyncReviewItem> {
    return enqueueReview(async () => {
      const reviews = await readReviewFile(reviewsPath);
      const existing = reviews.find((entry) => (
        entry.reason === review.reason &&
        entry.sourceLabel === review.sourceLabel &&
        JSON.stringify(entry.evidence) === JSON.stringify(review.evidence)
      ));
      if (existing) {
        return existing;
      }
      await writeReviewFile(reviewsPath, [...reviews, review]);
      return review;
    });
  }

  async function syncWorkspaceCandidate(candidate: ProjectCandidate): Promise<SyncResult> {
    const result = await options.store.transact<SyncResult>(async (projects): Promise<{ result: SyncResult; projects?: Project[] }> => {
      const match = matchProject(candidate, projects);
      if (match.kind === "needs-review") {
        return { result: { mutation: "none" as const, project: null, match } };
      }

      const merged = mergeCandidate(match.project, candidate);
      return {
        result: { mutation: "upsert" as const, project: merged.project, match },
        projects: projects.map((project) => project.id === merged.project.id ? merged.project : project)
      };
    });
    if (result.match.kind === "needs-review") {
      await persistReview(toReviewItem(candidate, result.match));
    }
    return result;
  }

  return {
    async syncCodexEvent(event) {
      const result = await syncCodexEvent(event, options.store);
      if (result.reviewItem) {
        await persistReview({
          id: randomUUID(),
          kind: "codex-event",
          sourceLabel: "Codex activity sync",
          reason: result.reviewItem.matchReason,
          evidence: result.reviewItem.evidence,
          duplicateProjectIds: result.reviewItem.duplicateProjectIds,
          createdAt: result.reviewItem.createdAt,
          status: "open",
          taskId: result.reviewItem.taskId,
          workingDirectory: result.reviewItem.workingDirectory,
          summary: result.reviewItem.summary,
          changedPaths: result.reviewItem.changedPaths
        });
      }
      return result;
    },

    syncWorkspaceCandidate,
    listReviews,

    async scanRoots() {
      const outcome: SyncScanOutcome = {
        scannedRoots: [],
        updatedProjectIds: [],
        reviewIds: []
      };
      for (const root of options.workspaceRoots) {
        const candidate = await scanProjectRoot(root);
        outcome.scannedRoots.push(root);
        const result = await syncWorkspaceCandidate(candidate);
        if (result.project) {
          outcome.updatedProjectIds.push(result.project.id);
        } else if (result.match.kind === "needs-review") {
          const review = await persistReview(toReviewItem(candidate, result.match));
          outcome.reviewIds.push(review.id);
        }
      }
      return outcome;
    },

    async startWatcher() {
      if (!options.enableWatcher || options.workspaceRoots.length === 0) {
        return null;
      }
      return startWorkspaceWatcher(options.workspaceRoots, async (candidate) => {
        await syncWorkspaceCandidate(candidate);
        options.log?.(`Workspace sync processed ${candidate.rootPath ?? candidate.name}.`);
      });
    }
  };
}
