import { useEffect, useState } from "react";
import { AlertCircle, Archive, Check, CheckCircle2, ChevronRight, Circle, CircleX, Clipboard, Clock3, ExternalLink, Pencil, RefreshCw, Search, Settings, Star, TriangleAlert, X } from "lucide-react";
import type { NeedStatus, Project, ProjectType } from "../../shared/domain";
import { StatusBadge } from "./StatusBadge";

export interface TableFilters {
  search: string;
  status?: NeedStatus;
  type?: ProjectType;
}

interface ProjectTableProps {
  projects: Project[];
  filters: TableFilters;
  typeOptions: ProjectType[];
  onSearchChange: (search: string) => void;
  onTypeChange: (type?: ProjectType) => void;
  selectedProjectId?: string | null;
  onOpenProject: (projectId: string) => void;
  onTogglePin?: (projectId: string) => void;
  onToggleArchive?: (projectId: string) => void;
  onRenameProject?: (projectId: string, name: string) => void;
  onRefreshProjects?: () => void;
  onCopyProjectPath?: (projectId: string) => void;
}

function formatSyncLabel(project: Project): string {
  if (project.syncStatus === "failed") {
    return "Sync failed";
  }
  if (project.syncStatus === "partial") {
    return "Unverified";
  }
  if (project.syncStatus === "unavailable") {
    return "Stale";
  }

  return "Synced";
}

function relativeTime(value: string): string {
  const elapsedMinutes = Math.max(0, Math.round((Date.now() - new Date(value).getTime()) / 60_000));
  if (elapsedMinutes < 60) {
    return `${Math.max(1, elapsedMinutes)}m ago`;
  }

  const elapsedHours = Math.round(elapsedMinutes / 60);
  if (elapsedHours < 24) {
    return `${elapsedHours}h ago`;
  }

  return `${Math.max(1, Math.round(elapsedHours / 24))}d ago`;
}

function openCount(project: Project): number {
  return project.launchTargets.length;
}

function tableNextAction(project: Project): string {
  return project.nextAction;
}

function tableActivityTone(project: Project): "normal" | "warning" | "error" {
  if (project.syncStatus === "failed" || project.needStatus === "Insufficient") return "error";
  if (project.syncStatus === "partial" || project.needStatus === "Need") return "warning";
  return "normal";
}

function referenceActionTone(project: Project): "normal" | "warning" | "error" {
  return tableActivityTone(project);
}

function referenceActionIcon(project: Project) {
  if (project.syncStatus === "failed") return <AlertCircle size={16} aria-hidden="true" />;
  if (project.syncStatus === "unavailable") return <Clock3 size={16} aria-hidden="true" />;
  if (project.syncStatus === "partial") return <TriangleAlert size={16} aria-hidden="true" />;
  if (project.needStatus === "Need") return <Circle size={16} aria-hidden="true" />;
  if (project.needStatus === "Insufficient") return <AlertCircle size={16} aria-hidden="true" />;
  return null;
}

function SyncState({ project }: { project: Project }) {
  if (project.syncStatus === "failed") {
    return (
      <span className="sync-state sync-state-error">
        <CircleX size={15} aria-hidden="true" />
        <span>{formatSyncLabel(project)}</span>
      </span>
    );
  }

  if (project.syncStatus === "partial" || project.syncStatus === "unavailable") {
    return (
      <span className="sync-state sync-state-warning">
        <TriangleAlert size={15} aria-hidden="true" />
        <span>{formatSyncLabel(project)}</span>
      </span>
    );
  }

  return (
    <span className="sync-state sync-state-success">
      <CheckCircle2 size={15} aria-hidden="true" />
      <span>{formatSyncLabel(project)}</span>
    </span>
  );
}

export function ProjectTable({
  projects,
  filters,
  typeOptions,
  onSearchChange,
  onTypeChange,
  selectedProjectId,
  onOpenProject,
  onTogglePin,
  onToggleArchive,
  onRenameProject,
  onRefreshProjects,
  onCopyProjectPath
}: ProjectTableProps) {
  const [isCustomizeOpen, setIsCustomizeOpen] = useState(false);
  const [openMenuProjectId, setOpenMenuProjectId] = useState<string | null>(null);
  const [editingProjectId, setEditingProjectId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  useEffect(() => {
    if (!openMenuProjectId) {
      return;
    }

    function closeMenu(event: MouseEvent) {
      if (!(event.target instanceof HTMLElement) || !event.target.closest(".project-action-menu-wrap")) {
        setOpenMenuProjectId(null);
      }
    }

    function closeMenuOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpenMenuProjectId(null);
      }
    }

    document.addEventListener("mousedown", closeMenu);
    document.addEventListener("keydown", closeMenuOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeMenu);
      document.removeEventListener("keydown", closeMenuOnEscape);
    };
  }, [openMenuProjectId]);

  function startRename(project: Project) {
    setOpenMenuProjectId(null);
    setEditingProjectId(project.id);
    setRenameDraft(project.name);
  }

  function cancelRename() {
    setEditingProjectId(null);
    setRenameDraft("");
  }

  function saveRename(project: Project) {
    const nextName = renameDraft.trim();
    if (!nextName || nextName === project.name) {
      cancelRename();
      return;
    }

    onRenameProject?.(project.id, nextName);
    cancelRename();
  }

  return (
    <section className="dashboard-panel dashboard-section dashboard-table-panel">
      {isCustomizeOpen ? (
        <div className="project-table-tools project-table-tools-popover">
          <label className="table-search-field">
            <Search size={14} aria-hidden="true" />
            <input
              type="search"
              value={filters.search}
              onChange={(event) => onSearchChange(event.target.value)}
              aria-label="Search projects"
              placeholder="Search projects"
            />
          </label>
          <select
            className="table-type-filter"
            value={filters.type ?? ""}
            onChange={(event) => onTypeChange(event.target.value ? event.target.value as ProjectType : undefined)}
            aria-label="Filter by type"
          >
            <option value="">All types</option>
            {typeOptions.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <div className="table-scroll">
        <table className="project-table" aria-label="Projects">
          <thead>
            <tr>
              <th scope="col">Project</th>
              <th scope="col">Status</th>
              <th scope="col">Next action</th>
              <th scope="col">Last activity</th>
              <th scope="col">Sync</th>
              <th scope="col">Open</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((project) => {
              const actionIcon = referenceActionIcon(project);
              const actionTone = referenceActionTone(project);

              return (
                <tr
                  key={project.id}
                  className={project.id === selectedProjectId ? "project-row-selected" : undefined}
                  aria-selected={project.id === selectedProjectId}
                  onClick={(event) => {
                    if ((event.target as HTMLElement).closest("button, a, input, select")) {
                      return;
                    }
                    onOpenProject(project.id);
                  }}
                  onKeyDown={(event) => {
                    if ((event.target as HTMLElement).closest("button, a, input, select")) {
                      return;
                    }
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenProject(project.id);
                    }
                  }}
                  tabIndex={0}
                >
                <td>
                  <div className="project-name-cell">
                    <button
                      className={`icon-button${project.pinned ? " icon-button-active" : ""}`}
                      type="button"
                      onClick={() => onTogglePin?.(project.id)}
                      aria-label={`${project.pinned ? "Unpin" : "Pin"} ${project.name}`}
                      title={`${project.pinned ? "Unpin" : "Pin"} ${project.name}`}
                    >
                      <Star size={14} />
                    </button>
                    <div className="project-name-copy">
                      {editingProjectId === project.id ? (
                        <div className="project-rename-control">
                          <input
                            className="project-rename-input"
                            value={renameDraft}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              if (event.key === "Enter") {
                                event.preventDefault();
                                saveRename(project);
                              }
                              if (event.key === "Escape") {
                                event.preventDefault();
                                cancelRename();
                              }
                            }}
                            aria-label={`Rename ${project.name}`}
                            autoFocus
                          />
                          <button
                            className="icon-button project-rename-action"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              saveRename(project);
                            }}
                            aria-label={`Save name for ${project.name}`}
                            title="Save name"
                          >
                            <Check size={14} />
                          </button>
                          <button
                            className="icon-button project-rename-action"
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              cancelRename();
                            }}
                            aria-label={`Cancel rename for ${project.name}`}
                            title="Cancel rename"
                          >
                            <X size={14} />
                          </button>
                        </div>
                      ) : (
                        <strong>{project.name}</strong>
                      )}
                      <p>{project.type}</p>
                    </div>
                  </div>
                </td>
                <td>
                  <div className="status-with-reference-icon">
                    <StatusBadge status={project.needStatus} />
                    {actionIcon ? (
                      <span className={`reference-action-icon reference-action-icon-${actionTone}`}>
                        {actionIcon}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td>
                  <div className="next-action-cell">
                    <span>{tableNextAction(project)}</span>
                    <button
                      className="icon-button"
                      type="button"
                      onClick={() => onToggleArchive?.(project.id)}
                      aria-label={`Archive ${project.name}`}
                      title={`Archive ${project.name}`}
                    >
                      <Archive size={14} />
                    </button>
                  </div>
                </td>
                <td>
                  <span className={`table-activity-time table-activity-time-${tableActivityTone(project)}`}>
                    {relativeTime(project.lastActivityAt)}
                  </span>
                </td>
                <td><SyncState project={project} /></td>
                <td>
                  <div className="open-project-cell project-action-cell">
                    <span>{openCount(project)}</span>
                    <div className="project-action-menu-wrap">
                      <button
                        className={`icon-button${openMenuProjectId === project.id ? " icon-button-active" : ""}`}
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          setOpenMenuProjectId((current) => (current === project.id ? null : project.id));
                        }}
                        aria-haspopup="menu"
                        aria-expanded={openMenuProjectId === project.id}
                        aria-label={`Project actions for ${project.name}`}
                        title={`Project actions for ${project.name}`}
                      >
                        <ChevronRight size={16} />
                      </button>
                      {openMenuProjectId === project.id ? (
                        <div className="project-action-menu" role="menu" aria-label={`Actions for ${project.name}`}>
                          <button className="project-action-menu-item" type="button" role="menuitem" onClick={() => { setOpenMenuProjectId(null); onOpenProject(project.id); }}>
                            <ExternalLink size={14} />
                            <span>Open project</span>
                          </button>
                          <button className="project-action-menu-item" type="button" role="menuitem" onClick={() => startRename(project)}>
                            <Pencil size={14} />
                            <span>Rename</span>
                          </button>
                          <button className="project-action-menu-item" type="button" role="menuitem" onClick={() => { setOpenMenuProjectId(null); onRefreshProjects?.(); }}>
                            <RefreshCw size={14} />
                            <span>Refresh data</span>
                          </button>
                          {project.rootPath ? (
                            <button className="project-action-menu-item" type="button" role="menuitem" onClick={() => { setOpenMenuProjectId(null); onCopyProjectPath?.(project.id); }}>
                              <Clipboard size={14} />
                              <span>Copy project path</span>
                            </button>
                          ) : null}
                          <div className="project-action-menu-separator" role="separator" />
                          <button className="project-action-menu-item project-action-menu-item-danger" type="button" role="menuitem" onClick={() => { setOpenMenuProjectId(null); onToggleArchive?.(project.id); }}>
                            <Archive size={14} />
                            <span>Archive project</span>
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </div>
                </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="project-table-footer">
        <span>Showing {projects.length} of {projects.length} projects</span>
        <button
          className="text-action table-customize-button"
          type="button"
          onClick={() => setIsCustomizeOpen((current) => !current)}
          aria-expanded={isCustomizeOpen}
          aria-label="Customize columns"
        >
          <Settings size={14} />
          <span>Customize columns</span>
        </button>
      </div>
    </section>
  );
}
