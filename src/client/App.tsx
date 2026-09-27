import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Bell,
  Database,
  Folder,
  History,
  LayoutDashboard,
  ListChecks,
  Menu,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings,
  Sparkles,
  Sun,
  Upload
} from "lucide-react";
import type {
  ImportCommitResponse,
  ImportMappingInput,
  SyncScanResponse,
  UndoResponse
} from "./api";
import { clientApi } from "./api";
import { openCodexSuggestion } from "./codex";
import { AttentionQueue, type AttentionQueueItem } from "./components/AttentionQueue";
import { ImportCenter } from "./components/ImportCenter";
import { Feedback } from "./components/Feedback";
import { LaunchControls, type LaunchTargetState } from "./components/LaunchControls";
import { ProjectDetail, type DetailBanner } from "./components/ProjectDetail";
import { ProjectTable } from "./components/ProjectTable";
import { StatusPieChart } from "./components/StatusPieChart";
import {
  ActionsView,
  ChangeLogView,
  SettingsView,
  SourcesView,
  SkillsView
} from "./components/WorkspaceViews";
import "./styles.css";
import type { ImportPreview, ImportSource } from "../server/imports/types";
import type { InstalledSkill } from "../server/skills/skills-service";
import type {
  LaunchTarget,
  NeedStatus,
  Project,
  ProjectType,
  SyncReviewItem,
  SyncScanOutcome
} from "../shared/domain";

const staleAfterMs = 30 * 24 * 60 * 60 * 1000;
const startingPollIntervalMs = 200;
const initialRunningPollIntervalMs = 1_000;
const maxRunningPollIntervalMs = 5_000;

interface QueryState {
  search: string;
  status?: NeedStatus;
  type?: ProjectType;
}

interface AppProps {
  onPollWaitSettled?: (key: string, waiter: Promise<void>) => void;
}

function readQueryState(): QueryState {
  if (typeof window === "undefined") {
    return { search: "" };
  }

  const params = new URLSearchParams(window.location.search);
  const status = params.get("status");
  const type = params.get("type");

  return {
    search: params.get("q") ?? "",
    status:
      status === "Plan" || status === "Need" || status === "Insufficient"
        ? status
        : undefined,
    type: type ? (type as ProjectType) : undefined
  };
}

function writeQueryState(state: QueryState) {
  if (typeof window === "undefined") {
    return;
  }

  const params = new URLSearchParams();
  if (state.search) {
    params.set("q", state.search);
  }
  if (state.status) {
    params.set("status", state.status);
  }
  if (state.type) {
    params.set("type", state.type);
  }

  const query = params.toString();
  window.history.replaceState({}, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
}

function matchesSearch(project: Project, search: string): boolean {
  if (!search.trim()) {
    return true;
  }

  const haystack = [
    project.name,
    project.rootPath,
    project.repositoryUrl,
    project.userNeed,
    project.currentState,
    project.nextAction,
    ...(project.tags ?? []),
    ...(project.aliases ?? []),
    ...(project.importantFiles ?? []),
    ...(project.recentActivity ?? []).map((entry) => entry.message)
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return haystack.includes(search.trim().toLowerCase());
}

function isUncertainImport(project: Project): boolean {
  return project.sources.some(
    (source) => source.kind === "import" && source.syncStatus !== "success"
  );
}

function isStale(project: Project): boolean {
  return Date.now() - new Date(project.lastActivityAt).getTime() >= staleAfterMs;
}

function toAttentionItem(
  project: Project,
  onOpenProject: (projectId: string) => void,
  onAcceptSuggestion: (projectId: string, suggestionId: string) => void
): AttentionQueueItem | null {
  if (project.syncStatus === "failed") {
    return {
      projectId: project.id,
      projectName: project.name,
      reason: "Sync failed",
      detail: project.nextAction,
      lastActivityAt: project.lastActivityAt,
      priority: 2,
      actionKind: "open",
      actionLabel: `Open ${project.name}`,
      onAction: () => onOpenProject(project.id)
    };
  }

  if (isUncertainImport(project)) {
    return {
      projectId: project.id,
      projectName: project.name,
      reason: "Unverified sources",
      detail: project.nextAction,
      lastActivityAt: project.lastActivityAt,
      priority: 3,
      actionKind: "open",
      actionLabel: `Open ${project.name}`,
      onAction: () => onOpenProject(project.id)
    };
  }

  if (isStale(project)) {
    return {
      projectId: project.id,
      projectName: project.name,
      reason: "Stale",
      detail: project.nextAction,
      lastActivityAt: project.lastActivityAt,
      priority: 4,
      actionKind: "open",
      actionLabel: `Open ${project.name}`,
      onAction: () => onOpenProject(project.id)
    };
  }

  if (project.needStatus === "Need") {
    return {
      projectId: project.id,
      projectName: project.name,
      reason: "Need",
      detail: project.nextAction,
      lastActivityAt: project.lastActivityAt,
      priority: 0,
      actionKind: "open",
      actionLabel: `Open ${project.name}`,
      onAction: () => onOpenProject(project.id)
    };
  }

  if (project.needStatus === "Insufficient") {
    return {
      projectId: project.id,
      projectName: project.name,
      reason: "Insufficient",
      detail: project.nextAction,
      lastActivityAt: project.lastActivityAt,
      priority: 1,
      actionKind: "open",
      actionLabel: `Open ${project.name}`,
      onAction: () => onOpenProject(project.id)
    };
  }

  const suggestion = project.suggestions?.[0];
  if (suggestion) {
    return {
      projectId: project.id,
      projectName: project.name,
      reason: suggestion.title,
      detail: suggestion.proposedValue,
      lastActivityAt: project.lastActivityAt,
      priority: 5,
      actionKind: "accept",
      actionLabel: `Accept suggestion for ${project.name}`,
      onAction: () => onAcceptSuggestion(project.id, suggestion.id)
    };
  }

  return null;
}

function sortProjects(projects: Project[], favoriteOrder: string[] = []): Project[] {
  return [...projects].sort((left, right) => {
    const leftFavoriteIndex = favoriteOrder.indexOf(left.id);
    const rightFavoriteIndex = favoriteOrder.indexOf(right.id);
    const leftFavoriteRank = leftFavoriteIndex >= 0 ? leftFavoriteIndex : left.pinned ? Number.MAX_SAFE_INTEGER : null;
    const rightFavoriteRank = rightFavoriteIndex >= 0 ? rightFavoriteIndex : right.pinned ? Number.MAX_SAFE_INTEGER : null;

    if (leftFavoriteRank !== rightFavoriteRank) {
      if (leftFavoriteRank === null) {
        return 1;
      }
      if (rightFavoriteRank === null) {
        return -1;
      }
      return leftFavoriteRank - rightFavoriteRank;
    }

    return right.lastActivityAt.localeCompare(left.lastActivityAt);
  });
}

function mergeFavoriteOrder(currentOrder: string[], projects: Project[]): string[] {
  const incomingPinnedIds = projects.filter((project) => project.pinned).map((project) => project.id);
  const incomingPinnedSet = new Set(incomingPinnedIds);
  const incomingProjectIds = new Set(projects.map((project) => project.id));
  const preservedOrder = currentOrder.filter(
    (projectId) => !incomingProjectIds.has(projectId) || incomingPinnedSet.has(projectId)
  );

  return [
    ...preservedOrder,
    ...incomingPinnedIds.filter((projectId) => !preservedOrder.includes(projectId))
  ];
}

function typeOptions(projects: Project[]): ProjectType[] {
  return Array.from(new Set(projects.map((project) => project.type))).sort();
}

function chartCounts(projects: Project[]) {
  return (["Plan", "Need", "Insufficient"] as NeedStatus[]).map((status) => ({
    status,
    count: projects.filter((project) => project.needStatus === status).length
  }));
}

const navigationItems = [
  { label: "Dashboard", icon: LayoutDashboard, active: true },
  { label: "Projects", icon: Folder },
  { label: "Actions", icon: ListChecks },
  { label: "Sources", icon: Database },
  { label: "Skills", icon: Sparkles },
  { label: "Change log", icon: History },
  { label: "Settings", icon: Settings }
];

function launchKey(projectId: string, targetId: string): string {
  return `${projectId}:${targetId}`;
}

export function mergeLaunchStatePatch(
  current: Record<string, LaunchTargetState>,
  key: string,
  patch: Partial<LaunchTargetState>
): Record<string, LaunchTargetState> {
  const previous = current[key];
  const unchanged = previous && Object.entries(patch).every(([field, value]) => (
    previous[field as keyof LaunchTargetState] === value
  ));
  if (unchanged) {
    return current;
  }
  return {
    ...current,
    [key]: { ...previous, ...patch } as LaunchTargetState
  };
}

export function App({ onPollWaitSettled }: AppProps = {}) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [favoriteOrder, setFavoriteOrder] = useState<string[]>([]);
  const [projectDetails, setProjectDetails] = useState<Record<string, Project>>({});
  const [skills, setSkills] = useState<InstalledSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [skillsError, setSkillsError] = useState<string | null>(null);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [hasLoadedSuccessfully, setHasLoadedSuccessfully] = useState(false);
  const [syncReviews, setSyncReviews] = useState<SyncReviewItem[]>([]);
  const [syncSummary, setSyncSummary] = useState<SyncScanOutcome | null>(null);
  const [query, setQuery] = useState<QueryState>(() => readQueryState());
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [detailBanner, setDetailBanner] = useState<DetailBanner | null>(null);
  const [isImportOpen, setIsImportOpen] = useState(false);
  const [launchStates, setLaunchStates] = useState<Record<string, LaunchTargetState>>({});
  const [isRailCollapsed, setIsRailCollapsed] = useState(false);
  const [activeNavigation, setActiveNavigation] = useState("Dashboard");
  const pageHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousNavigationRef = useRef(activeNavigation);

  useEffect(() => {
    if (previousNavigationRef.current !== activeNavigation) {
      pageHeadingRef.current?.focus({ preventScroll: true });
      previousNavigationRef.current = activeNavigation;
    }
  }, [activeNavigation]);
  const [isCompactMode, setIsCompactMode] = useState(false);
  const [isHighContrastStatus, setIsHighContrastStatus] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [refreshInterval, setRefreshInterval] = useState(15);
  const [isDarkMode, setIsDarkMode] = useState(() => {
    if (typeof window === "undefined") {
      return false;
    }
    try {
      return window.localStorage?.getItem("codex-atlas-theme") === "dark";
    } catch {
      return false;
    }
  });
  const [isDetailClosed, setIsDetailClosed] = useState(false);
  const launchGenerations = useRef<Record<string, number>>({});
  const pollTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const pollWaiters = useRef<Record<string, () => void>>({});
  const mountedRef = useRef(true);

  function clearPollTimer(key: string) {
    const timer = pollTimers.current[key];
    if (timer !== undefined) {
      clearTimeout(timer);
      delete pollTimers.current[key];
    }
    const resolveWaiter = pollWaiters.current[key];
    if (resolveWaiter) {
      delete pollWaiters.current[key];
      resolveWaiter();
    }
  }

  function nextLaunchGeneration(key: string): number {
    const next = (launchGenerations.current[key] ?? 0) + 1;
    launchGenerations.current[key] = next;
    clearPollTimer(key);
    return next;
  }

  function isCurrentLaunchGeneration(key: string, generation: number): boolean {
    return mountedRef.current && launchGenerations.current[key] === generation;
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      for (const key of Object.keys(pollTimers.current)) {
        clearPollTimer(key);
      }
    };
  }, []);

  function mergeProjects(nextProjects: Project[]) {
    setProjects(nextProjects);
    setFavoriteOrder((current) => mergeFavoriteOrder(current, nextProjects));
    setProjectDetails((current) => {
      const next = { ...current };
      for (const project of nextProjects) {
        next[project.id] = {
          ...next[project.id],
          ...project
        };
      }
      return next;
    });
  }

  function updateSingleProject(updatedProject: Project) {
    setProjects((current) =>
      current.map((project) => (project.id === updatedProject.id ? updatedProject : project))
    );
    setProjectDetails((current) => ({
      ...current,
      [updatedProject.id]: updatedProject
    }));
  }

  async function loadProjects(showRefreshState = false) {
    if (showRefreshState) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }

    try {
      let scanResponse: SyncScanResponse | null = null;
      if (showRefreshState) {
        scanResponse = await clientApi.scanWorkspace();
        setSyncReviews(scanResponse.reviews);
        setSyncSummary(scanResponse.outcome);
      }
      const response = await clientApi.listProjects({
        q: query.search || undefined,
        status: query.status,
        type: query.type
      });
      mergeProjects(response.projects);
      setSyncReviews(response.reviews ?? scanResponse?.reviews ?? []);
      setError(null);
      setHasLoadedSuccessfully(true);
      setSelectedProjectId((current) => {
        if (current && response.projects.some((project) => project.id === current)) {
          return current;
        }

        const nextFavoriteOrder = mergeFavoriteOrder(favoriteOrder, response.projects);
        const firstVisible = sortProjects(
          response.projects.filter((project) => !project.archived),
          nextFavoriteOrder
        )[0];
        return firstVisible?.id ?? null;
      });
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : "Dashboard data is unavailable.");
      setProjects([]);
      setSelectedProjectId(null);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function loadSkills() {
    setSkillsLoading(true);
    try {
      const response = await clientApi.listSkills();
      setSkills(response.skills);
      setSelectedSkillId((current) => (
        current && response.skills.some((skill) => skill.id === current)
          ? current
          : response.skills[0]?.id ?? null
      ));
      setSkillsError(null);
    } catch (loadError) {
      setSkillsError(loadError instanceof Error ? loadError.message : "Installed skills are unavailable.");
    } finally {
      setSkillsLoading(false);
    }
  }

  useEffect(() => {
    void loadProjects();
  }, []);

  useEffect(() => {
    writeQueryState(query);
  }, [query]);

  useEffect(() => {
    if (!autoRefresh) {
      return;
    }

    const timer = window.setInterval(() => {
      void loadProjects(false);
    }, refreshInterval * 60_000);

    return () => window.clearInterval(timer);
  }, [autoRefresh, refreshInterval, query]);

  useEffect(() => {
    document.documentElement.dataset.theme = isDarkMode ? "dark" : "light";
    try {
      window.localStorage?.setItem("codex-atlas-theme", isDarkMode ? "dark" : "light");
    } catch {
      // Theme state remains available for this session when persistence is unavailable.
    }
  }, [isDarkMode]);

  const activeProjects = projects.filter((project) => !project.archived);
  const searchAndTypeFiltered = activeProjects.filter(
    (project) => matchesSearch(project, query.search) && (!query.type || project.type === query.type)
  );
  const visibleProjects = sortProjects(
    searchAndTypeFiltered.filter((project) => !query.status || project.needStatus === query.status),
    favoriteOrder
  );

  useEffect(() => {
    if (!isDetailClosed && !selectedProjectId && visibleProjects.length > 0) {
      setSelectedProjectId(visibleProjects[0].id);
      return;
    }

    if (selectedProjectId && !activeProjects.some((project) => project.id === selectedProjectId)) {
      setSelectedProjectId(visibleProjects[0]?.id ?? null);
    }
  }, [activeProjects, isDetailClosed, selectedProjectId, visibleProjects]);

  useEffect(() => {
    if (!selectedProjectId) {
      return;
    }

    let cancelled = false;
    void clientApi
      .getProject(selectedProjectId)
      .then((response) => {
        if (cancelled) {
          return;
        }

        setProjectDetails((current) => ({
          ...current,
          [selectedProjectId]: response.project
        }));
        setDetailError(null);
      })
      .catch((detailLoadError) => {
        if (cancelled) {
          return;
        }

        setDetailError(
          detailLoadError instanceof Error
            ? detailLoadError.message
            : "Project detail is unavailable."
        );
      });

    return () => {
      cancelled = true;
    };
  }, [selectedProjectId]);

  const selectedProjectSummary =
    activeProjects.find((project) => project.id === selectedProjectId) ?? visibleProjects[0] ?? null;
  const selectedProject =
    selectedProjectSummary
      ? projectDetails[selectedProjectSummary.id] ?? selectedProjectSummary
      : null;

  const attentionItems = sortProjects(activeProjects, favoriteOrder)
    .map((project) =>
      toAttentionItem(project, setSelectedProjectId, handleAcceptSuggestion)
    )
    .filter((item): item is AttentionQueueItem => item !== null)
    .sort((left, right) => left.priority - right.priority);

  const counts = chartCounts(searchAndTypeFiltered);
  const typeValues = typeOptions(activeProjects);
  const notificationCount = attentionItems.length;

  async function handleAcceptSuggestion(projectId: string, suggestionId: string) {
    setIsDetailClosed(false);
    setSelectedProjectId(projectId);
    setDetailError(null);
    const project = activeProjects.find((entry) => entry.id === projectId);
    const suggestion = project?.suggestions?.find((entry) => entry.id === suggestionId);
    let codexOpened = false;

    if (project?.rootPath && suggestion) {
      try {
        const result = await openCodexSuggestion({
          projectPath: project.rootPath,
          projectName: project.name,
          suggestionTitle: suggestion.title,
          detail: suggestion.detail,
          currentValue: suggestion.currentValue,
          proposedValue: suggestion.proposedValue
        });
        codexOpened = result.opened;
      } catch {
        // The local suggestion action remains available if the external launch fails.
      }
    }

    try {
      const updated = await clientApi.acceptSuggestion(projectId, suggestionId);
      updateSingleProject(updated);
      setSelectedProjectId(projectId);
      setError(null);
      setDetailBanner({
        tone: "success",
        text: codexOpened
          ? "Opened Codex to implement this suggestion."
          : "Applied 1 suggested change."
      });
    } catch (acceptError) {
      setDetailBanner({
        tone: "error",
        text: acceptError instanceof Error ? acceptError.message : "Could not accept the suggestion."
      });
    }
  }

  async function handleDismissSuggestion(projectId: string, suggestionId: string) {
    try {
      const updated = await clientApi.dismissSuggestion(projectId, suggestionId);
      updateSingleProject(updated);
      setDetailBanner({ tone: "info", text: "Dismissed 1 suggested change." });
    } catch (dismissError) {
      setDetailBanner({
        tone: "error",
        text: dismissError instanceof Error ? dismissError.message : "Could not dismiss the suggestion."
      });
    }
  }

  async function handleAcceptAllSuggestions(project: Project) {
    let remainingProject = project;
    let appliedCount = 0;

    for (const suggestion of project.suggestions ?? []) {
      remainingProject = await clientApi.acceptSuggestion(project.id, suggestion.id);
      updateSingleProject(remainingProject);
      appliedCount += 1;
    }

    setDetailBanner({
      tone: "success",
      text: `Applied ${appliedCount} suggested change${appliedCount === 1 ? "" : "s"}.`
    });
  }

  async function handleDismissAllSuggestions(project: Project) {
    let remainingProject = project;
    let dismissedCount = 0;

    for (const suggestion of project.suggestions ?? []) {
      remainingProject = await clientApi.dismissSuggestion(project.id, suggestion.id);
      updateSingleProject(remainingProject);
      dismissedCount += 1;
    }

    setDetailBanner({
      tone: "info",
      text: `Dismissed ${dismissedCount} suggested change${dismissedCount === 1 ? "" : "s"}.`
    });
  }

  async function handlePreviewImport(
    source: ImportSource,
    mapping?: ImportMappingInput
  ): Promise<ImportPreview> {
    try {
      return mapping
        ? await clientApi.previewImport(source, mapping)
        : await clientApi.previewImport(source);
    } catch (previewError) {
      setDetailBanner({
        tone: "error",
        text: previewError instanceof Error ? previewError.message : "Could not preview the import."
      });
      throw previewError;
    }
  }

  async function handleCommitImport(previewId: string): Promise<ImportCommitResponse> {
    try {
      const response = await clientApi.commitImport(previewId);
      mergeProjects(response.projects);
      setDetailBanner({
        tone: "success",
        text: `Imported ${response.result.importedCount} rows.`
      });
      return response;
    } catch (commitError) {
      setDetailBanner({
        tone: "error",
        text: commitError instanceof Error ? commitError.message : "Could not commit the import."
      });
      throw commitError;
    }
  }

  async function handleUndo(snapshotPath: string): Promise<UndoResponse> {
    try {
      const response = await clientApi.undo(snapshotPath);
      mergeProjects(response.projects);
      setDetailBanner({
        tone: response.result.restored ? "info" : "warning",
        text: response.result.restored
          ? "Restored the previous registry snapshot."
          : "The import snapshot is no longer available to restore."
      });
      return response;
    } catch (undoError) {
      setDetailBanner({
        tone: "error",
        text: undoError instanceof Error ? undoError.message : "Could not undo the import."
      });
      throw undoError;
    }
  }

  async function handleLaunch(projectId: string, targetId: string, approvalFingerprint?: string) {
    const key = launchKey(projectId, targetId);
    const existingState = launchStates[key];
    const processStateUnconfirmed = existingState?.status === "error" &&
      Boolean(existingState.processId) && existingState.terminal !== true;
    if (
      existingState?.status === "starting" ||
      existingState?.status === "running" ||
      processStateUnconfirmed
    ) {
      return;
    }

    const generation = nextLaunchGeneration(key);
    setLaunchStates((current) => ({
      ...current,
      [key]: { status: "starting", message: "Starting target..." }
    }));

    try {
      const result = approvalFingerprint
        ? await clientApi.launchProjectTarget(projectId, targetId, {
            fingerprint: approvalFingerprint
          })
        : await clientApi.launchProjectTarget(projectId, targetId);
      if (result.status === "approval-required") {
        setLaunchStates((current) => ({
          ...current,
          [key]: {
            status: "approval-required",
            fingerprint: result.fingerprint,
            trusted: false,
            terminal: true,
            message: "Approval required before first launch."
          }
        }));
        return;
      }

      if (result.status === "started") {
        setLaunchStates((current) => ({
          ...current,
          [key]: {
            status: "starting",
            processId: result.processId,
            trusted: true,
            terminal: false,
            message: `Starting process ${result.processId}`
          }
        }));
        void pollProcessState(projectId, targetId, result.processId, generation);
        return;
      }

      if (result.status === "disabled") {
        setLaunchStates((current) => ({
          ...current,
          [key]: {
            status: "disabled",
            terminal: true,
            message: result.reason
          }
        }));
        return;
      }

      setLaunchStates((current) => ({
        ...current,
        [key]: {
          status: "opened",
          terminal: true,
          message: "Opened target."
        }
      }));
    } catch (launchError) {
      setLaunchStates((current) => ({
        ...current,
        [launchKey(projectId, targetId)]: {
          status: "error",
          terminal: true,
          message: launchError instanceof Error ? launchError.message : "Could not launch target."
        }
      }));
    }
  }

  async function pollProcessState(
    projectId: string,
    targetId: string,
    processId: string,
    generation: number
  ) {
    const key = launchKey(projectId, targetId);
    let runningPollIntervalMs = initialRunningPollIntervalMs;
    let nextPollIntervalMs = startingPollIntervalMs;

    const updatePolledState = (patch: Partial<LaunchTargetState>) => {
      setLaunchStates((current) => mergeLaunchStatePatch(current, key, patch));
    };

    while (isCurrentLaunchGeneration(key, generation)) {
      try {
        const process = await clientApi.getProcessState(processId);
        if (!isCurrentLaunchGeneration(key, generation)) {
          return;
        }

        if (process.status === "Starting") {
          updatePolledState({
            status: "starting",
            processId,
            trusted: true,
            terminal: false,
            pollError: undefined,
            message: `Starting process ${processId}`
          });
          nextPollIntervalMs = startingPollIntervalMs;
        }
        if (process.status === "Running") {
          updatePolledState({
            status: "running",
            processId,
            trusted: true,
            terminal: false,
            pollError: undefined,
            message: `Running process ${processId}`
          });
          nextPollIntervalMs = runningPollIntervalMs;
          runningPollIntervalMs = Math.min(runningPollIntervalMs * 2, maxRunningPollIntervalMs);
        }
        if (process.status === "Failed") {
          updatePolledState({
            status: "error",
            processId,
            trusted: true,
            terminal: true,
            pollError: undefined,
            message: process.stderr || `Startup failed for process ${processId}.`
          });
          return;
        }
        if (process.status === "Stopped") {
          updatePolledState({
            status: "stopped",
            processId,
            trusted: true,
            terminal: true,
            pollError: undefined,
            message: `Stopped process ${processId}`
          });
          return;
        }
      } catch (processError) {
        if (!isCurrentLaunchGeneration(key, generation)) {
          return;
        }

        updatePolledState({
          processId,
          terminal: false,
          pollError: processError instanceof Error ? processError.message : "Could not read process state."
        });
        nextPollIntervalMs = startingPollIntervalMs;
      }

      let waiter!: Promise<void>;
      waiter = new Promise<void>((resolve) => {
        let settled = false;
        const settle = () => {
          if (settled) {
            return;
          }
          settled = true;
          delete pollTimers.current[key];
          delete pollWaiters.current[key];
          resolve();
          onPollWaitSettled?.(key, waiter);
        };
        const timer = setTimeout(settle, nextPollIntervalMs);
        pollTimers.current[key] = timer;
        pollWaiters.current[key] = settle;
      });
      await waiter;
    }
  }

  async function handleStopLaunch(projectId: string, targetId: string, processId: string) {
    const key = launchKey(projectId, targetId);
    nextLaunchGeneration(key);
    try {
      await clientApi.stopProcess(processId);
      setLaunchStates((current) => ({
        ...current,
        [key]: {
          ...current[key],
          status: "stopped",
          processId,
          terminal: true,
          message: `Stopped process ${processId}`
        }
      }));
    } catch (stopError) {
      setLaunchStates((current) => ({
        ...current,
        [key]: {
          ...current[key],
          status: "error",
          processId,
          terminal: false,
          message: stopError instanceof Error ? stopError.message : "Could not stop the process."
        }
      }));
    }
  }

  function handleTogglePin(projectId: string) {
    const project = projects.find((entry) => entry.id === projectId);
    if (!project) {
      return;
    }

    setFavoriteOrder((current) => {
      if (project.pinned) {
        return current.filter((id) => id !== projectId);
      }
      return [...current.filter((id) => id !== projectId), projectId];
    });
    setProjects((current) =>
      current.map((project) =>
        project.id === projectId ? { ...project, pinned: !project.pinned } : project
      )
    );
    setProjectDetails((current) => {
      const project = current[projectId];
      if (!project) {
        return current;
      }
      return {
        ...current,
        [projectId]: { ...project, pinned: !project.pinned }
      };
    });
  }

  function handleRenameProject(projectId: string, name: string) {
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? { ...project, name } : project))
    );
    setProjectDetails((current) => {
      const project = current[projectId];
      if (!project) {
        return current;
      }
      return {
        ...current,
        [projectId]: { ...project, name }
      };
    });
  }

  function handleArchiveProject(projectId: string) {
    setProjects((current) =>
      current.map((project) => (project.id === projectId ? { ...project, archived: true } : project))
    );
    setProjectDetails((current) => {
      const project = current[projectId];
      if (!project) {
        return current;
      }
      return {
        ...current,
        [projectId]: { ...project, archived: true }
      };
    });
    setSelectedProjectId((current) => (current === projectId ? null : current));
  }

  async function handleCopyProjectPath(projectId: string) {
    const project = activeProjects.find((entry) => entry.id === projectId);
    if (!project?.rootPath || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(project.rootPath);
      setDetailBanner({ tone: "success", text: "Copied the project path." });
    } catch {
      setError("Could not copy the project path.");
    }
  }

  const selectedLaunchStates =
    selectedProject?.launchTargets.reduce<Record<string, LaunchTargetState | undefined>>(
      (result, target) => {
        result[target.id] = launchStates[launchKey(selectedProject.id, target.id)];
        return result;
      },
      {}
    ) ?? {};

  const projectDetailBanner = detailError
    ? { tone: "error" as const, text: detailError }
    : detailBanner;

  function handleNavigation(label: string) {
    setActiveNavigation(label);
    if (label === "Skills") {
      void loadSkills();
    }
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }

  const projectTableView = (
    <>
      <ProjectTable
        projects={visibleProjects}
        filters={query}
        typeOptions={typeValues}
        onSearchChange={(search) => setQuery((current) => ({ ...current, search }))}
        onTypeChange={(type) => setQuery((current) => ({ ...current, type }))}
        selectedProjectId={selectedProjectId}
        onOpenProject={(projectId) => {
          setIsDetailClosed(false);
          setSelectedProjectId(projectId);
          setDetailBanner(null);
        }}
        onTogglePin={handleTogglePin}
        onToggleArchive={handleArchiveProject}
        onRenameProject={handleRenameProject}
        onRefreshProjects={() => void loadProjects(true)}
        onCopyProjectPath={(projectId) => void handleCopyProjectPath(projectId)}
      />
      {visibleProjects.length === 0 ? (
        <section className="dashboard-panel empty-panel">
          <h2>No matching projects.</h2>
          <p>Adjust search, status, or type filters to widen the list.</p>
        </section>
      ) : null}
    </>
  );

  const projectDetailView = (
    <ProjectDetail
      project={selectedProject}
      banner={projectDetailBanner}
      onAcceptSuggestion={handleAcceptSuggestion}
      onDismissSuggestion={handleDismissSuggestion}
      onAcceptAllSuggestions={handleAcceptAllSuggestions}
      onDismissAllSuggestions={handleDismissAllSuggestions}
      onClose={() => {
        setSelectedProjectId(null);
        setIsDetailClosed(true);
      }}
      onTogglePin={handleTogglePin}
      launchControls={
        selectedProject ? (
          <LaunchControls
            projectId={selectedProject.id}
            targets={selectedProject.launchTargets}
            targetStates={selectedLaunchStates}
            onLaunch={handleLaunch}
            onStop={(targetId, processId) => void handleStopLaunch(selectedProject.id, targetId, processId)}
          />
        ) : null
      }
      importCenter={
        isImportOpen ? (
          <ImportCenter
            onPreview={handlePreviewImport}
            onCommit={handleCommitImport}
            onUndo={handleUndo}
            onGetSavedMappings={(format) => clientApi.getSavedMappings(format)}
            onInputChange={() => setDetailBanner(null)}
          />
        ) : null
      }
    />
  );
  const navigationClassName = activeNavigation.toLowerCase().replace(/\s+/g, "-");

  return (
    <main className={`dashboard-shell${isDarkMode ? " theme-dark" : ""}${isRailCollapsed ? " rail-collapsed" : ""}${isCompactMode ? " compact-mode" : ""}${isHighContrastStatus ? " high-contrast-status" : ""}`}>
      <aside className="navigation-rail" aria-label="Primary">
        <div className="rail-brand">
          <strong>Codex Project<br />Command Center</strong>
        </div>
        <button
          className="rail-collapse-button"
          type="button"
          onClick={() => setIsRailCollapsed((current) => !current)}
          aria-label={isRailCollapsed ? "Expand navigation" : "Collapse navigation"}
          title={isRailCollapsed ? "Expand navigation" : "Collapse navigation"}
        >
          {isRailCollapsed ? <PanelLeftOpen size={18} aria-hidden="true" /> : <PanelLeftClose size={18} aria-hidden="true" />}
        </button>
        <nav>
          <ul className="rail-nav">
            {navigationItems.map(({ label, icon: Icon }) => (
              <li key={label}>
                <button
                  className={`rail-link${activeNavigation === label ? " rail-link-active" : ""}`}
                  type="button"
                  onClick={() => handleNavigation(label)}
                  aria-current={activeNavigation === label ? "page" : undefined}
                  aria-label={label}
                  title={isRailCollapsed ? label : undefined}
                >
                  <Icon size={16} />
                  <span>{label}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
        <div className="rail-footer">
          <Feedback />
          <div className="rail-sync-state">
            <span className="rail-sync-mark" aria-hidden="true" />
            <div>
              <strong>Local-first</strong>
              <span>All data on this device</span>
            </div>
          </div>
          <label className="dark-mode-control">
            <span className="dark-mode-label">
              {isDarkMode ? <Sun size={15} aria-hidden="true" /> : <Moon size={15} aria-hidden="true" />}
              Dark mode
            </span>
            <input
              type="checkbox"
              checked={isDarkMode}
              onChange={(event) => setIsDarkMode(event.target.checked)}
              aria-label="Dark mode"
            />
            <span className="dark-mode-switch" aria-hidden="true"><span /></span>
          </label>
        </div>
      </aside>

      <section className={`dashboard-main view-${navigationClassName}`}>
        <header className="topbar">
          <Menu className="topbar-menu" size={22} aria-hidden="true" />
          <div className="topbar-title">
            <h1 ref={pageHeadingRef} tabIndex={-1}>{activeNavigation}</h1>
          </div>
          <div className="topbar-actions">
            <button
              className={`toolbar-button${isImportOpen ? " toolbar-button-primary" : ""}`}
              type="button"
              onClick={() => {
                setActiveNavigation("Dashboard");
                setIsImportOpen((current) => !current);
              }}
              aria-label="Import project data"
            >
              <Upload size={15} />
              <span>Import</span>
            </button>
            <button
              className="toolbar-button"
              type="button"
              onClick={() => void (activeNavigation === "Skills" ? loadSkills() : loadProjects(true))}
              aria-label={activeNavigation === "Skills" ? "Refresh skills" : "Refresh dashboard"}
              title={activeNavigation === "Skills" ? "Refresh skills" : "Refresh dashboard"}
            >
              <RefreshCw size={15} className={refreshing ? "spin" : ""} />
              <span>Refresh</span>
            </button>
            <button
              className="toolbar-icon"
              type="button"
              onClick={() => handleNavigation("Actions")}
              aria-label={`Attention items${notificationCount > 0 ? `, ${notificationCount} open` : ""}`}
              title="Attention items"
            >
              <Bell size={16} />
              {notificationCount > 0 ? (
                <span className="notification-dot">{notificationCount}</span>
              ) : null}
            </button>
          </div>
        </header>

        {error && activeProjects.length > 0 ? <div className="dashboard-alert">{error}</div> : null}

        {syncSummary || syncReviews.length > 0 ? (
          <div className="dashboard-alert" role="status">
            {syncSummary ? `Scanned ${syncSummary.scannedRoots.length} configured root${syncSummary.scannedRoots.length === 1 ? "" : "s"}; ` : "Sync review queue: "}
            {syncSummary ? `${syncSummary.updatedProjectIds.length} updated, ${syncSummary.reviewIds.length} review${syncSummary.reviewIds.length === 1 ? "" : "s"}.` : `${syncReviews.length} open item${syncReviews.length === 1 ? "" : "s"}.`}
            {syncReviews.length > 0 ? (
              <ul aria-label="Sync review evidence">
                {syncReviews.map((review) => (
                  <li key={review.id}>
                    {review.reason}: {review.evidence.map((evidence) => `${evidence.kind}=${evidence.value}`).join(", ")}; duplicateProjectIds={review.duplicateProjectIds.join(", ") || "none"}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {!loading && error ? (
          <section className="dashboard-panel empty-panel">
            <h2>Dashboard data is unavailable.</h2>
            <p>Retry the project load after the local API is ready.</p>
            <div className="empty-actions">
              <button className="toolbar-button" type="button" onClick={() => void loadProjects(true)}>
                <RefreshCw size={15} />
                <span>Retry load</span>
              </button>
            </div>
          </section>
        ) : null}

        {loading ? (
          <section className="dashboard-panel loading-panel">
            <p>Loading dashboard...</p>
          </section>
        ) : null}

        {!loading && !error && hasLoadedSuccessfully && activeProjects.length === 0 ? (
          <section className="dashboard-panel empty-panel">
            <h2>No active projects yet.</h2>
            <p>Import or sync a source to populate the dashboard.</p>
          </section>
        ) : null}

        {!loading && !error && activeNavigation === "Settings" ? (
          <SettingsView
            isCompactMode={isCompactMode}
            onCompactModeChange={setIsCompactMode}
            isHighContrastStatus={isHighContrastStatus}
            onHighContrastStatusChange={setIsHighContrastStatus}
            autoRefresh={autoRefresh}
            onAutoRefreshChange={setAutoRefresh}
            refreshInterval={refreshInterval}
            onRefreshIntervalChange={setRefreshInterval}
            onRefresh={() => void loadProjects(true)}
            onResetFilters={() => setQuery({ search: "" })}
            onOpenImport={() => {
              setIsImportOpen(true);
              setActiveNavigation("Dashboard");
            }}
          />
        ) : null}

        {!loading && !error && activeNavigation === "Skills" ? (
          <SkillsView
            skills={skills}
            loading={skillsLoading}
            error={skillsError}
            selectedSkillId={selectedSkillId}
            onSelectSkill={setSelectedSkillId}
            onRefresh={() => void loadSkills()}
            onOpenProject={(projectId) => {
              setActiveNavigation("Projects");
              setIsDetailClosed(false);
              setSelectedProjectId(projectId);
              setDetailBanner(null);
            }}
          />
        ) : null}

        {!loading && !error && activeProjects.length > 0 && activeNavigation !== "Settings" && activeNavigation !== "Skills" ? (
          activeNavigation === "Dashboard" ? (
            <div className="dashboard-grid">
              <div className="dashboard-overview">
                <AttentionQueue items={attentionItems} onViewAll={() => handleNavigation("Actions")} />
                <StatusPieChart
                  counts={counts}
                  selectedStatus={query.status}
                  onClearStatus={() => setQuery((current) => ({ ...current, status: undefined }))}
                  onStatusSelect={(status) =>
                    setQuery((current) => ({
                      ...current,
                      status: current.status === status ? undefined : status
                    }))
                  }
                />
                {projectTableView}
              </div>
              {projectDetailView}
            </div>
          ) : (
            <div className="workspace-route">
              <div className="workspace-route-main">
                {activeNavigation === "Projects" ? (
                  <section className="workspace-view dashboard-panel" aria-labelledby="projects-view-heading">
                    <div className="workspace-view-header">
                      <div>
                        <p className="workspace-eyebrow">Project registry</p>
                        <h2 id="projects-view-heading">Projects</h2>
                        <p>Browse every active project, its status, and its next action.</p>
                      </div>
                    </div>
                    {projectTableView}
                  </section>
                ) : null}
                {activeNavigation === "Actions" ? <ActionsView items={attentionItems} projects={activeProjects} onViewAll={() => handleNavigation("Actions")} /> : null}
                {activeNavigation === "Sources" ? <SourcesView projects={activeProjects} /> : null}
                {activeNavigation === "Change log" ? <ChangeLogView projects={activeProjects} /> : null}
              </div>
              {projectDetailView}
            </div>
          )
        ) : null}

        {!loading && isImportOpen && !selectedProject ? (
          <section className="dashboard-panel import-fallback-panel" aria-label="Import center fallback">
            <ImportCenter
              onPreview={handlePreviewImport}
              onCommit={handleCommitImport}
              onUndo={handleUndo}
              onGetSavedMappings={(format) => clientApi.getSavedMappings(format)}
              onInputChange={() => setDetailBanner(null)}
            />
          </section>
        ) : null}
      </section>
    </main>
  );
}

const rootElement = document.getElementById("root");

if (rootElement && import.meta.env.MODE !== "test") {
  createRoot(rootElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
