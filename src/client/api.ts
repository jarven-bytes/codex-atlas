import type { ProcessState } from "../server/launch/process-manager";
import type {
  ImportCommitResult,
  ImportPreview,
  ImportSource,
  SavedMappingEntry
} from "../server/imports/types";
import type { LaunchApproval, LaunchResult } from "../server/launch/launcher";
import type { InstalledSkill } from "../server/skills/skills-service";
import type {
  NeedStatus,
  Project,
  ProjectType,
  SyncReviewItem,
  SyncScanOutcome,
  UndoResult
} from "../shared/domain";

export interface ProjectFilters {
  q?: string;
  status?: NeedStatus;
  type?: ProjectType;
}

export interface ProjectListResponse {
  projects: Project[];
  reviews?: SyncReviewItem[];
}

export interface SkillsResponse {
  skills: InstalledSkill[];
}

export interface SyncScanResponse {
  outcome: SyncScanOutcome;
  projects: Project[];
  reviews: SyncReviewItem[];
}

interface ProjectResponse {
  project: Project;
}

interface ProjectMutationResponse {
  project: Project;
  projects: Project[];
}

export interface ImportCommitResponse {
  result: ImportCommitResult;
  projects: Project[];
}

export interface UndoResponse {
  result: UndoResult;
  projects: Project[];
}

export type ImportMappingInput = Record<string, string>;

interface LaunchResponse {
  result: LaunchResult;
}

interface StopProcessResponse {
  process: ProcessState;
}

interface PreviewResponse {
  preview: ImportPreview;
}

interface SavedMappingsResponse {
  mappings: SavedMappingEntry[];
}

interface ProcessResponse {
  process: ProcessState;
}

function readApiError(body: unknown, status: number): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error &&
    typeof body.error.message === "string"
  ) {
    return body.error.message;
  }

  return `Request failed with status ${status}.`;
}

async function requestJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const response = await fetch(input, init);
  const contentType = response.headers.get("content-type") ?? "";
  const isJson = contentType.toLowerCase().includes("application/json");
  const hasBody = response.status !== 204 && response.status !== 205;
  let body: unknown = null;

  if (hasBody && isJson) {
    body = await response.json();
  }

  if (!response.ok) {
    throw new Error(readApiError(body, response.status));
  }

  if (hasBody && !isJson) {
    throw new Error(
      `Expected a JSON API response but received ${contentType || "an empty content type"}.`
    );
  }

  return body as T;
}

function isProjectListResponse(value: unknown): value is ProjectListResponse {
  return (
    !!value &&
    typeof value === "object" &&
    "projects" in value &&
    Array.isArray(value.projects)
  );
}

export const clientApi = {
  async listProjects(filters: ProjectFilters = {}): Promise<ProjectListResponse> {
    const params = new URLSearchParams();
    if (filters.q) {
      params.set("q", filters.q);
    }
    if (filters.status) {
      params.set("status", filters.status);
    }
    if (filters.type) {
      params.set("type", filters.type);
    }

    const query = params.toString();
    const response = await requestJson<unknown>(`/api/projects${query ? `?${query}` : ""}`);
    if (!isProjectListResponse(response)) {
      throw new Error("Projects API returned an empty or malformed payload.");
    }

    return response;
  },

  async listSkills(): Promise<SkillsResponse> {
    const response = await requestJson<SkillsResponse>("/api/skills");
    if (!response || !Array.isArray(response.skills)) {
      throw new Error("Skills API returned an empty or malformed payload.");
    }

    return response;
  },

  async scanWorkspace(): Promise<SyncScanResponse> {
    return requestJson<SyncScanResponse>("/api/sync/scan", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({})
    });
  },

  async getProject(projectId: string): Promise<ProjectResponse> {
    return requestJson<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}`);
  },

  async acceptSuggestion(projectId: string, suggestionId: string): Promise<Project> {
    const response = await requestJson<ProjectMutationResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/suggestions/${encodeURIComponent(suggestionId)}/accept`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }
    );

    return response.project;
  },

  async dismissSuggestion(projectId: string, suggestionId: string): Promise<Project> {
    const response = await requestJson<ProjectMutationResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/suggestions/${encodeURIComponent(suggestionId)}/dismiss`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }
    );

    return response.project;
  },

  async previewImport(source: ImportSource, mapping?: ImportMappingInput): Promise<ImportPreview> {
    const response = await requestJson<PreviewResponse>("/api/import/preview", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        source,
        ...(mapping ? { mapping } : {})
      })
    });

    return response.preview;
  },

  async getSavedMappings(format: "json" | "csv"): Promise<SavedMappingEntry[]> {
    const response = await requestJson<SavedMappingsResponse>(
      `/api/import/mappings?format=${encodeURIComponent(format)}`
    );
    return response.mappings;
  },

  async commitImport(previewId: string): Promise<ImportCommitResponse> {
    return requestJson<ImportCommitResponse>("/api/import/commit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ previewId })
    });
  },

  async undo(snapshotPath?: string): Promise<UndoResponse> {
    return requestJson<UndoResponse>("/api/undo", {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(snapshotPath ? { snapshotPath } : {})
    });
  },

  async launchProjectTarget(
    projectId: string,
    targetId: string,
    approval?: LaunchApproval
  ): Promise<LaunchResult> {
    const response = await requestJson<LaunchResponse>(
      `/api/projects/${encodeURIComponent(projectId)}/launch/${encodeURIComponent(targetId)}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(approval ?? {})
      }
    );

    return response.result;
  },

  async stopProcess(processId: string): Promise<StopProcessResponse> {
    return requestJson<StopProcessResponse>(
      `/api/processes/${encodeURIComponent(processId)}/stop`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({})
      }
    );
  },

  async getProcessState(processId: string): Promise<ProcessState> {
    const response = await requestJson<ProcessResponse>(
      `/api/processes/${encodeURIComponent(processId)}`
    );
    return response.process;
  }
};
