export type NeedStatus = "Plan" | "Need" | "Insufficient";

export type ProjectType =
  | "web-app"
  | "mobile-app"
  | "automation"
  | "workflow"
  | "connector"
  | "document"
  | "other";

export type SourceKind = "codex" | "workspace" | "import" | "git" | "manual";

export type SyncState = "never" | "success" | "partial" | "failed" | "unavailable";

export type AttentionFlag = "stale" | "sync-failed" | "unverified" | "needs-review";

export type CandidateEvidenceKind = "source-id" | "root-path" | "repository-url" | "alias";

export interface CandidateEvidence {
  kind: CandidateEvidenceKind;
  value: string;
}

export interface LaunchCommand {
  executable: string;
  args: string[];
  cwd: string;
  port?: number;
}

export type LaunchTargetOrigin = "manual" | "scanner" | "imported";

export type LaunchTarget =
  | {
      kind: "url";
      id: string;
      label: string;
      url: string;
    }
  | {
      kind: "folder";
      id: string;
      label: string;
      path: string;
    }
  | {
      kind: "document";
      id: string;
      label: string;
      path: string;
      page?: string;
    }
  | {
      kind: "task";
      id: string;
      label: string;
      taskId: string;
      workspace?: string;
    }
  | {
      kind: "command";
      id: string;
      label: string;
      origin: LaunchTargetOrigin;
      executable: string;
      args: string[];
      cwd: string;
      port?: number;
    };

export interface ProjectSource {
  kind: SourceKind;
  label: string;
  sourceId?: string;
  syncStatus: SyncState;
  lastSyncedAt?: string;
  unavailableReason?: string;
}

export interface CandidateSource {
  kind: SourceKind;
  label: string;
  sourceId?: string;
  syncStatus: SyncState;
  observedAt: string;
  unavailableReason?: string;
}

export type ProjectFieldKey =
  | "name"
  | "type"
  | "needStatus"
  | "userNeed"
  | "currentState"
  | "nextAction"
  | "rootPath"
  | "repositoryUrl"
  | "aliases"
  | "launchTargets"
  | "importantFiles"
  | "missingItems"
  | "tags"
  | "lastActivityAt"
  | "lastSyncedAt"
  | "syncStatus";

export interface FieldProvenance {
  sourceLabel: string;
  sourceId?: string;
  updatedAt: string;
  manual?: boolean;
  unavailableAt?: string;
  unavailableReason?: string;
  lastVerifiedValue?: unknown;
}

export type FieldProvenanceMap = Partial<Record<ProjectFieldKey, FieldProvenance>>;

export interface Suggestion {
  kind: "field-update";
  id: string;
  field: "needStatus" | "userNeed" | "currentState" | "nextAction";
  title: string;
  detail: string;
  currentValue: string;
  proposedValue: string;
  evidence: CandidateEvidence[];
  createdAt: string;
}

export interface ActivityEvent {
  kind: "note" | "status-change" | "sync";
  id: string;
  message: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  type: ProjectType;
  needStatus: NeedStatus;
  userNeed: string;
  currentState: string;
  nextAction: string;
  launchTargets: LaunchTarget[];
  sources: ProjectSource[];
  lastActivityAt: string;
  lastSyncedAt: string;
  syncStatus: SyncState;
  updatedAt: string;
  repositoryUrl?: string;
  rootPath?: string;
  aliases?: string[];
  importantFiles?: string[];
  missingItems?: string[];
  tags?: string[];
  suggestions?: Suggestion[];
  recentActivity?: ActivityEvent[];
  fieldProvenance?: FieldProvenanceMap;
  attentionFlags?: AttentionFlag[];
  pinned?: boolean;
  archived?: boolean;
}

export interface ProjectRegistry {
  projects: Project[];
}

export type RegistryMutation =
  | {
      kind: "upsert";
      project: Project;
    }
  | {
      kind: "remove";
      projectId: string;
      removedAt: string;
    };

export interface MutationResult {
  mutation: RegistryMutation["kind"];
  project: Project | null;
  previousProject: Project | null;
  registry: Project[];
  registryPath: string;
  snapshotPath: string;
}

export interface UndoResult {
  restored: boolean;
  registry: Project[];
  snapshotPath: string | null;
  reason?: "no-snapshot" | "snapshot-mismatch";
}

export interface ProjectCandidate {
  name: string;
  source: CandidateSource;
  evidence: CandidateEvidence[];
  verifiedAt: string;
  type?: ProjectType;
  needStatus?: NeedStatus;
  userNeed?: string;
  currentState?: string;
  nextAction?: string;
  rootPath?: string;
  repositoryUrl?: string;
  aliases?: string[];
  launchTargets?: LaunchTarget[];
  importantFiles?: string[];
  missingItems?: string[];
  tags?: string[];
  lastActivityAt?: string;
  unavailableFields?: ProjectFieldKey[];
}

export interface CodexActivityEvent {
  taskId: string;
  workingDirectory: string;
  summary: string;
  changedPaths: string[];
  milestone?: string;
  decisionOrBlocker?: "decision" | "blocker";
  sourceId?: string;
}

export interface CodexReviewItem {
  kind: "codex-event";
  taskId: string;
  workingDirectory: string;
  summary: string;
  changedPaths: string[];
  milestone?: string;
  decisionOrBlocker?: "decision" | "blocker";
  matchReason: Extract<MatchResult, { kind: "needs-review" }>["reason"];
  duplicateProjectIds: string[];
  evidence: CandidateEvidence[];
  createdAt: string;
}

export interface SyncReviewItem {
  id: string;
  kind: "codex-event" | "workspace-scan";
  sourceLabel: string;
  reason: string;
  evidence: CandidateEvidence[];
  duplicateProjectIds: string[];
  createdAt: string;
  status: "open";
  taskId?: string;
  workingDirectory?: string;
  summary?: string;
  changedPaths?: string[];
}

export interface SyncScanOutcome {
  scannedRoots: string[];
  updatedProjectIds: string[];
  reviewIds: string[];
}

export type SyncResult =
  | {
      mutation: "none";
      project: null;
      match:
        | Extract<MatchResult, { kind: "needs-review" }>
        | {
            kind: "ignored";
            reason: "no-meaningful-activity";
          };
      reviewItem?: CodexReviewItem;
    }
  | {
      mutation: "upsert";
      project: Project;
      match:
        | MatchResult
        | {
            kind: "created";
            projectId: string;
          };
      reviewItem?: undefined;
    };

export type CloseWatcher = () => Promise<void>;

export type MatchResult =
  | {
      kind: "matched";
      projectId: string;
      project: Project;
      confidence: "high" | "medium";
      reason: "source-id" | "root-path" | "repository-url" | "alias";
      evidence: CandidateEvidence[];
    }
  | {
      kind: "needs-review";
      projectId: null;
      project: null;
      confidence: "low";
      reason:
        | "source-id-conflict"
        | "root-path-conflict"
        | "repository-url-conflict"
        | "alias-conflict"
        | "no-confident-match";
      evidence: CandidateEvidence[];
      duplicateProjectIds: string[];
    };

export interface MergeResult {
  project: Project;
  suggestions: Suggestion[];
  changedFields: ProjectFieldKey[];
  preservedFields: Array<Suggestion["field"]>;
  attentionFlags: AttentionFlag[];
}

export type SourceRef =
  | {
      kind: "manual";
      label: string;
      detail?: string;
    }
  | {
      kind: "workspace";
      label: string;
      path: string;
    }
  | {
      kind: "import";
      label: string;
      importId: string;
      locator?: string;
    }
  | {
      kind: "url";
      label: string;
      url: string;
    };

export type ImportPreview =
  | {
      kind: "structured-file";
      sourcePath: string;
      rowCount: number;
      detectedColumns: string[];
      rootPath?: string;
    }
  | {
      kind: "clipboard";
      rowCount: number;
      detectedColumns: string[];
      rootPath?: string;
    }
  | {
      kind: "api";
      sourceLabel: string;
      rowCount: number;
      rootPath?: string;
    };
