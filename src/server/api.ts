import type { IncomingMessage, ServerResponse } from "node:http";
import { createImportService } from "./imports/import-service";
import type { ImportSource, FieldMapping } from "./imports/types";
import { createLauncherService, type LaunchApproval } from "./launch/launcher";
import { createProcessManager, type ProcessManager, type ProcessState } from "./launch/process-manager";
import { serverConfig } from "./config";
import { createProjectStore, type ProjectStore } from "./store/project-store";
import { createSyncService, type SyncService } from "./sync/sync-service";
import {
  discoverInstalledSkills,
  type InstalledSkill
} from "./skills/skills-service";
import type {
  CodexActivityEvent,
  Project,
  ProjectFieldKey,
  Suggestion
} from "../shared/domain";

const defaultBodyLimitBytes = 32_768;
const jsonContentType = "application/json; charset=utf-8";

interface JsonErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

class ApiError extends Error {
  statusCode: number;
  code: string;
  details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface CreateApiHandlerOptions {
  store?: ProjectStore;
  processManager?: ProcessManager;
  launcher?: ReturnType<typeof createLauncherService>;
  syncService?: SyncService;
  importService?: ReturnType<typeof createImportService>;
  listSkills?: (projects: Project[]) => Promise<InstalledSkill[]>;
  syncEvent?: (event: CodexActivityEvent, store: ProjectStore) => Promise<unknown>;
  launchTarget?: (
    projectId: string,
    targetId: string,
    approval?: LaunchApproval
  ) => Promise<unknown>;
  stopProcess?: (processId: string) => Promise<ProcessState>;
  getProcessState?: (processId: string) => ProcessState;
  bodyLimitBytes?: number;
  logError?: (error: unknown, context: string) => void;
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", jsonContentType);
  response.end(JSON.stringify(body));
}

function sendJsonError(response: ServerResponse, error: JsonErrorShape, statusCode: number): void {
  sendJson(response, statusCode, { error });
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) {
    if (error.statusCode >= 500) {
      return new ApiError(error.statusCode, error.code, "Internal server error.");
    }
    return error;
  }

  if (error instanceof Error) {
    const errorWithCode = error as Error & { code?: string };

    if (errorWithCode.code === "PROJECT_NOT_FOUND") {
      return new ApiError(404, "PROJECT_NOT_FOUND", error.message);
    }

    if (errorWithCode.code === "TARGET_NOT_FOUND") {
      return new ApiError(404, "TARGET_NOT_FOUND", error.message);
    }

    if (errorWithCode.code === "PROCESS_NOT_FOUND") {
      return new ApiError(404, "PROCESS_NOT_FOUND", error.message);
    }

    if (errorWithCode.code === "REGISTRY_REVISION_CONFLICT") {
      return new ApiError(409, "REGISTRY_REVISION_CONFLICT", error.message);
    }

    if (error.message.startsWith("Unknown preview:") || error.message.startsWith("Preview expired:")) {
      return new ApiError(409, "STALE_PREVIEW", error.message);
    }

    if (error.message.includes("did not contain any committable rows")) {
      return new ApiError(409, "IMPORT_PREVIEW_EMPTY", error.message);
    }

    return new ApiError(500, "INTERNAL_ERROR", "Internal server error.");
  }

  return new ApiError(500, "INTERNAL_ERROR", "Internal server error.");
}

function decodeRouteParam(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new ApiError(
      400,
      "INVALID_ROUTE_PARAM",
      "Route parameters must be valid URL-encoded strings."
    );
  }
}

async function readJsonBody(
  request: IncomingMessage,
  bodyLimitBytes: number
): Promise<unknown> {
  const contentLengthHeader = request.headers["content-length"];
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > bodyLimitBytes) {
      throw new ApiError(
        400,
        "REQUEST_BODY_TOO_LARGE",
        "Request body exceeded the configured limit."
      );
    }
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    size += buffer.byteLength;

    if (size > bodyLimitBytes) {
      throw new ApiError(
        400,
        "REQUEST_BODY_TOO_LARGE",
        "Request body exceeded the configured limit."
      );
    }

    chunks.push(buffer);
  }

  if (size === 0) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body must be valid JSON.");
  }
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Request body did not match the expected shape."
    );
  }

  return value as Record<string, unknown>;
}

function requireString(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {}
): string {
  if (typeof value !== "string") {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Request body did not match the expected shape.",
      { field }
    );
  }

  if (!options.allowEmpty && value.trim() === "") {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Request body did not match the expected shape.",
      { field }
    );
  }

  return value;
}

function parseImportSource(value: unknown): ImportSource {
  const body = requireRecord(value);
  const kind = requireString(body.kind, "source.kind");
  const filePath = requireString(body.path, "source.path");
  const label = requireString(body.label, "source.label");

  if (kind === "local-folder") {
    return {
      kind,
      path: filePath,
      label
    };
  }

  if (kind === "structured-file") {
    const format = requireString(body.format, "source.format");
    if (format !== "json" && format !== "csv") {
      throw new ApiError(
        400,
        "INVALID_REQUEST",
        "Request body did not match the expected shape.",
        { field: "source.format" }
      );
    }

    return {
      kind,
      path: filePath,
      format,
      label
    };
  }

  throw new ApiError(
    400,
    "INVALID_REQUEST",
    "Request body did not match the expected shape.",
    { field: "source.kind" }
  );
}

function parseMapping(value: unknown): FieldMapping | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(
      400,
      "INVALID_REQUEST",
      "Request body did not match the expected shape.",
      { field: "mapping" }
    );
  }

  return value as FieldMapping;
}

function parseSyncPayload(value: unknown): CodexActivityEvent {
  const body = requireRecord(value);

  return {
    taskId: requireString(body.taskId, "taskId"),
    workingDirectory: requireString(body.workingDirectory, "workingDirectory"),
    summary: requireString(body.summary, "summary"),
    changedPaths: Array.isArray(body.changedPaths) && body.changedPaths.every((entry) => typeof entry === "string")
      ? body.changedPaths
      : (() => {
          throw new ApiError(
            400,
            "INVALID_REQUEST",
            "Request body did not match the expected shape.",
            { field: "changedPaths" }
          );
        })(),
    ...(body.milestone === undefined ? {} : { milestone: requireString(body.milestone, "milestone") }),
    ...(body.decisionOrBlocker === undefined
      ? {}
      : body.decisionOrBlocker === "decision" || body.decisionOrBlocker === "blocker"
        ? { decisionOrBlocker: body.decisionOrBlocker }
        : (() => {
            throw new ApiError(
              400,
              "INVALID_REQUEST",
              "Request body did not match the expected shape.",
              { field: "decisionOrBlocker" }
            );
          })()),
    ...(body.sourceId === undefined ? {} : { sourceId: requireString(body.sourceId, "sourceId") })
  };
}

function parsePreviewCommit(value: unknown): { previewId: string } {
  const body = requireRecord(value);

  return {
    previewId: requireString(body.previewId, "previewId")
  };
}

function parseLaunchApproval(value: unknown): LaunchApproval | undefined {
  const body = requireRecord(value);
  if (body.fingerprint === undefined) {
    return undefined;
  }

  return {
    fingerprint: requireString(body.fingerprint, "fingerprint")
  };
}

const loopbackHostnames = new Set(["127.0.0.1", "localhost"]);

function singleHeader(value: string | string[] | undefined): string | null {
  return typeof value === "string" ? value : null;
}

function isLoopbackHost(hostHeader: string): URL | null {
  try {
    const parsed = new URL(`http://${hostHeader}`);
    if (
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash ||
      !loopbackHostnames.has(parsed.hostname.toLowerCase())
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function effectivePort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80");
}

function allowsLoopbackMutation(request: IncomingMessage): boolean {
  const hostHeader = singleHeader(request.headers.host);
  if (!hostHeader) {
    return false;
  }

  const host = isLoopbackHost(hostHeader);
  if (!host) {
    return false;
  }

  const originHeader = singleHeader(request.headers.origin);
  if (!originHeader) {
    return true;
  }

  try {
    const origin = new URL(originHeader);
    return (
      (origin.protocol === "http:" || origin.protocol === "https:") &&
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash &&
      loopbackHostnames.has(origin.hostname.toLowerCase()) &&
      origin.hostname.toLowerCase() === host.hostname.toLowerCase() &&
      effectivePort(origin) === effectivePort(host)
    );
  } catch {
    return false;
  }
}

function isMutationMethod(method: string): boolean {
  return method === "POST" || method === "PUT" || method === "PATCH" || method === "DELETE";
}

function findProjectOrThrow(projects: Project[], projectId: string): Project {
  const project = projects.find((entry) => entry.id === projectId);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  return project;
}

function updateProjectForSuggestionAction(
  project: Project,
  suggestionId: string,
  action: "accept" | "dismiss"
): Project {
  const suggestions = project.suggestions ?? [];
  const suggestion = suggestions.find((entry) => entry.id === suggestionId);
  if (!suggestion) {
    throw new ApiError(
      404,
      "SUGGESTION_NOT_FOUND",
      `Suggestion not found: ${project.id}/${suggestionId}`
    );
  }

  const remainingSuggestions = suggestions.filter((entry) => entry.id !== suggestionId);
  const nextProject: Project = {
    ...project,
    suggestions: remainingSuggestions,
    updatedAt: new Date().toISOString()
  };

  if (action === "accept") {
    assignSuggestionField(nextProject, suggestion.field, suggestion.proposedValue);
  }

  return nextProject;
}

function assignSuggestionField(
  project: Project,
  field: Suggestion["field"],
  proposedValue: string
): void {
  const key = field as ProjectFieldKey;
  if (key === "needStatus") {
    if (proposedValue === "Plan" || proposedValue === "Need" || proposedValue === "Insufficient") {
      project.needStatus = proposedValue;
      return;
    }

    throw new ApiError(
      400,
      "INVALID_SUGGESTION",
      `Suggestion proposed an unsupported need status: ${proposedValue}`
    );
  }

  if (field === "userNeed") {
    project.userNeed = proposedValue;
    return;
  }

  if (field === "currentState") {
    project.currentState = proposedValue;
    return;
  }

  project.nextAction = proposedValue;
}

async function applySuggestionAction(
  store: ProjectStore,
  projectId: string,
  suggestionId: string,
  action: "accept" | "dismiss"
): Promise<Project> {
  const project = await store.get(projectId);
  if (!project) {
    throw new ApiError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }

  const updated = updateProjectForSuggestionAction(project, suggestionId, action);
  const result = await store.applyMutation({
    kind: "upsert",
    project: updated
  });

  if (!result.project) {
    throw new ApiError(500, "INTERNAL_ERROR", "Suggestion mutation did not return a project.");
  }

  return result.project;
}

export function createApiHandler(options: CreateApiHandlerOptions = {}) {
  const store = options.store ?? createProjectStore();
  const processManager = options.processManager ?? createProcessManager();
  const launcher = options.launcher ?? createLauncherService({ store, processManager });
  const importService = options.importService ?? createImportService({
    store,
    dataDir: serverConfig.dataDir
  });
  const listSkills = options.listSkills ?? ((projects: Project[]) => discoverInstalledSkills({ projects }));
  const syncService = options.syncService ?? createSyncService({
    store,
    dataDir: serverConfig.dataDir,
    workspaceRoots: serverConfig.workspaceRoots
  });
  const syncEvent = options.syncEvent ?? ((event: CodexActivityEvent) => syncService.syncCodexEvent(event));
  const launchTarget = options.launchTarget ?? launcher.launchTarget;
  const stopProcess = options.stopProcess ?? processManager.stopProcess.bind(processManager);
  const getProcessState = options.getProcessState ?? processManager.getProcessState.bind(processManager);
  const bodyLimitBytes = options.bodyLimitBytes ?? defaultBodyLimitBytes;
  const logError = options.logError ?? ((error: unknown, context: string) => {
    console.error(`[api] ${context}`, error);
  });

  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const method = request.method ?? "GET";
    const pathname = url.pathname;

    if (!pathname.startsWith("/api/")) {
      return false;
    }

    try {
      if (isMutationMethod(method) && !allowsLoopbackMutation(request)) {
        throw new ApiError(
          403,
          "UNTRUSTED_LOCAL_ORIGIN",
          "Mutating local API requests require a loopback Host and matching Origin."
        );
      }

      if (method === "GET" && pathname === "/api/projects") {
        sendJson(response, 200, {
          projects: await store.list(),
          reviews: await syncService.listReviews()
        });
        return true;
      }

      if (method === "GET" && pathname === "/api/skills") {
        sendJson(response, 200, {
          skills: await listSkills(await store.list())
        });
        return true;
      }

      const projectDetailMatch = /^\/api\/projects\/([^/]+)$/.exec(pathname);
      if (method === "GET" && projectDetailMatch) {
        const projectId = decodeRouteParam(projectDetailMatch[1]);
        const project = await store.get(projectId);
        if (!project) {
          throw new ApiError(
            404,
            "PROJECT_NOT_FOUND",
            `Project not found: ${projectId}`
          );
        }
        sendJson(response, 200, { project });
        return true;
      }

      if (method === "POST" && pathname === "/api/sync") {
        const payload = parseSyncPayload(await readJsonBody(request, bodyLimitBytes));
        const result = await syncEvent(payload, store);
        sendJson(response, 200, {
          result,
          projects: await store.list(),
          reviews: await syncService.listReviews()
        });
        return true;
      }

      if (method === "POST" && pathname === "/api/sync/scan") {
        const outcome = await syncService.scanRoots();
        sendJson(response, 200, {
          outcome,
          projects: await store.list(),
          reviews: await syncService.listReviews()
        });
        return true;
      }

      if (method === "GET" && pathname === "/api/sync/reviews") {
        sendJson(response, 200, { reviews: await syncService.listReviews() });
        return true;
      }

      if (method === "POST" && pathname === "/api/import/preview") {
        const body = requireRecord(await readJsonBody(request, bodyLimitBytes));
        const preview = await importService.preview(
          parseImportSource(body.source),
          parseMapping(body.mapping)
        );
        sendJson(response, 200, { preview });
        return true;
      }

      if (method === "GET" && pathname === "/api/import/mappings") {
        const format = url.searchParams.get("format");
        if (format !== null && format !== "json" && format !== "csv") {
          throw new ApiError(400, "INVALID_REQUEST", "Unsupported mapping format.", { field: "format" });
        }
        sendJson(response, 200, {
          mappings: await importService.listSavedMappings(format ?? undefined)
        });
        return true;
      }

      if (method === "POST" && pathname === "/api/import/commit") {
        const { previewId } = parsePreviewCommit(await readJsonBody(request, bodyLimitBytes));
        const result = await importService.commit(previewId);
        sendJson(response, 200, {
          result,
          projects: await store.list()
        });
        return true;
      }

      const suggestionMatch =
        /^\/api\/projects\/([^/]+)\/suggestions\/([^/]+)\/(accept|dismiss)$/.exec(pathname);
      if (method === "POST" && suggestionMatch) {
        await readJsonBody(request, bodyLimitBytes);
        const project = await applySuggestionAction(
          store,
          decodeRouteParam(suggestionMatch[1]),
          decodeRouteParam(suggestionMatch[2]),
          suggestionMatch[3] as "accept" | "dismiss"
        );
        sendJson(response, 200, {
          project,
          projects: await store.list()
        });
        return true;
      }

      if (method === "POST" && pathname === "/api/undo") {
        const body = requireRecord(await readJsonBody(request, bodyLimitBytes));
        const snapshotPath = body.snapshotPath === undefined
          ? undefined
          : requireString(body.snapshotPath, "snapshotPath");
        const result = await store.undoLastMutation(snapshotPath);
        sendJson(response, 200, {
          result,
          projects: await store.list()
        });
        return true;
      }

      const exportMatch = /^\/api\/export\/([^/]+)$/.exec(pathname);
      if (method === "GET" && exportMatch) {
        const format = decodeRouteParam(exportMatch[1]);
        if (format !== "json" && format !== "markdown" && format !== "csv") {
          throw new ApiError(400, "INVALID_EXPORT_FORMAT", `Unsupported export format: ${format}`);
        }

        const contents = await store.export(format);
        response.statusCode = 200;
        response.setHeader(
          "Content-Type",
          format === "json"
            ? "application/json; charset=utf-8"
            : format === "markdown"
              ? "text/markdown; charset=utf-8"
              : "text/csv; charset=utf-8"
        );
        response.end(contents);
        return true;
      }

      const launchMatch = /^\/api\/projects\/([^/]+)\/launch\/([^/]+)$/.exec(pathname);
      if (method === "POST" && launchMatch) {
        const approval = parseLaunchApproval(await readJsonBody(request, bodyLimitBytes));
        const result = await launchTarget(
          decodeRouteParam(launchMatch[1]),
          decodeRouteParam(launchMatch[2]),
          approval
        );
        sendJson(response, 200, { result });
        return true;
      }

      const stopMatch = /^\/api\/processes\/([^/]+)\/stop$/.exec(pathname);
      if (method === "POST" && stopMatch) {
        await readJsonBody(request, bodyLimitBytes);
        const process = await stopProcess(decodeRouteParam(stopMatch[1]));
        sendJson(response, 200, { process });
        return true;
      }

      const processMatch = /^\/api\/processes\/([^/]+)$/.exec(pathname);
      if (method === "GET" && processMatch) {
        const process = getProcessState(decodeRouteParam(processMatch[1]));
        sendJson(response, 200, { process });
        return true;
      }

      throw new ApiError(404, "ROUTE_NOT_FOUND", `Route not found: ${method} ${pathname}`);
    } catch (error) {
      if (!(error instanceof ApiError) || error.statusCode >= 500) {
        logError(error, `${method} ${pathname}`);
      }
      const apiError = toApiError(error);
      sendJsonError(
        response,
        {
          code: apiError.code,
          message: apiError.message,
          ...(apiError.details === undefined ? {} : { details: apiError.details })
        },
        apiError.statusCode
      );
      return true;
    }
  };
}
