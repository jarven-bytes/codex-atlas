import type {
  CandidateEvidence,
  Project,
  ProjectCandidate,
  ProjectFieldKey,
  ProjectType
} from "../../shared/domain";

export type ImportAction = "create" | "update" | "skip" | "reject" | "duplicate";

export type ImportSource =
  | {
      kind: "local-folder";
      path: string;
      label: string;
    }
  | {
      kind: "structured-file";
      path: string;
      format: "json" | "csv";
      label: string;
    };

export type FieldMapping = Partial<Record<string, ProjectFieldKey>>;

export interface ImportPreviewRow {
  id: string;
  action: ImportAction;
  reason: string;
  evidence: CandidateEvidence[];
  candidate: ProjectCandidate | null;
  raw: unknown | null;
  targetProjectId?: string;
}

export interface ImportPreview {
  id: string;
  source: ImportSource;
  detectedColumns: string[];
  rows: ImportPreviewRow[];
  createdAt: string;
  expiresAt: string;
  registryRevision: string;
}

export interface ImportCommitRowResult {
  id: string;
  action: ImportAction;
  committed: boolean;
  projectId?: string;
  reason: string;
}

export interface ImportCommitResult {
  previewId: string;
  importedCount: number;
  skippedCount: number;
  rows: ImportCommitRowResult[];
  snapshotPath: string;
  projects: Project[];
}

export interface ImportAdapter {
  canHandle(source: ImportSource): boolean;
  preview(source: ImportSource, mapping?: FieldMapping): Promise<AdapterPreviewResult>;
}

export interface AdapterPreviewResult {
  schemaFingerprint?: string;
  detectedColumns: string[];
  rows: Array<{
    candidate: ProjectCandidate | null;
    raw: unknown | null;
    error?: string;
  }>;
}

export interface SavedMappingEntry {
  format: "json" | "csv";
  schemaFingerprint: string;
  detectedColumns: string[];
  mapping: FieldMapping;
}

export type SavedMappings = Record<string, SavedMappingEntry>;

export interface LocalFolderMetadata {
  name?: string;
  type?: ProjectType;
  userNeed?: string;
  currentState?: string;
  nextAction?: string;
  tags?: string[];
  missingItems?: string[];
}
