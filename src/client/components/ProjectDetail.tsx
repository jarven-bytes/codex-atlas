import {
  AlertTriangle,
  CheckCircle2,
  CircleX,
  Clock3,
  ChevronDown,
  FileText,
  GitBranch,
  ListTodo,
  RefreshCw,
  Sparkles,
  Star,
  TriangleAlert,
  X
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { FieldProvenance, Project, ProjectFieldKey } from "../../shared/domain";

export interface DetailBanner {
  tone: "info" | "success" | "warning" | "error";
  text: string;
}

interface ProjectDetailProps {
  project: Project | null;
  banner?: DetailBanner | null;
  onAcceptSuggestion: (projectId: string, suggestionId: string) => void | Promise<void>;
  onDismissSuggestion: (projectId: string, suggestionId: string) => void | Promise<void>;
  onAcceptAllSuggestions: (project: Project) => void | Promise<void>;
  onDismissAllSuggestions: (project: Project) => void | Promise<void>;
  onClose?: () => void;
  onTogglePin?: (projectId: string) => void;
  importCenter: ReactNode;
  launchControls: ReactNode;
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "Unknown";
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit"
  }).format(new Date(value));
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

function provenanceText(provenance: FieldProvenance | undefined): {
  sourceLabel: string;
  updatedAt: string;
} | null {
  if (!provenance) {
    return null;
  }

  return {
    sourceLabel: provenance.sourceLabel,
    updatedAt: formatTimestamp(provenance.updatedAt)
  };
}

function sourceSyncLabel(status: Project["sources"][number]["syncStatus"]): string {
  switch (status) {
    case "success":
      return "Verified";
    case "partial":
      return "Unverified";
    case "failed":
      return "Sync failed";
    case "unavailable":
      return "Stale";
    default:
      return "Unverified";
  }
}

function sourceSyncIcon(status: Project["sources"][number]["syncStatus"]) {
  if (status === "success") {
    return <CheckCircle2 size={14} aria-hidden="true" />;
  }

  if (status === "failed") {
    return <CircleX size={14} aria-hidden="true" />;
  }

  return <TriangleAlert size={14} aria-hidden="true" />;
}

function activityIcon(kind: "note" | "status-change" | "sync") {
  if (kind === "sync") {
    return <RefreshCw size={15} aria-hidden="true" />;
  }

  if (kind === "status-change") {
    return <GitBranch size={15} aria-hidden="true" />;
  }

  return <FileText size={15} aria-hidden="true" />;
}

function renderFieldBlock(
  project: Project,
  field: Extract<ProjectFieldKey, "userNeed" | "currentState" | "nextAction">,
  label: string
) {
  const provenance = provenanceText(project.fieldProvenance?.[field]);
  return (
    <div className="detail-section" key={field}>
      <h3>{label}</h3>
      <p>{project[field]}</p>
      {provenance ? (
        <span className="detail-meta">
          <span className="detail-meta-label">{provenance.sourceLabel}</span>
          <span>{provenance.updatedAt}</span>
        </span>
      ) : null}
    </div>
  );
}

export function ProjectDetail({
  project,
  banner,
  onAcceptSuggestion,
  onDismissSuggestion,
  onAcceptAllSuggestions,
  onDismissAllSuggestions,
  onClose,
  onTogglePin,
  importCenter,
  launchControls
}: ProjectDetailProps) {
  const [isSuggestionsOpen, setIsSuggestionsOpen] = useState(false);
  const isReferenceProject = project?.rootPath?.includes("Documents/") === true;

  useEffect(() => {
    setIsSuggestionsOpen(!isReferenceProject);
  }, [isReferenceProject, project?.id]);

  if (!project) {
    return (
      <aside className="dashboard-panel detail-drawer" aria-label="Project detail" role="complementary">
        <div className="empty-panel">
          <h2>No project selected.</h2>
          <p>Open a project from the table or the attention queue.</p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={`dashboard-panel detail-drawer${project.rootPath?.includes("Documents/") ? " detail-reference-mode" : ""}`} aria-label="Project detail" role="complementary">
      <div className="detail-header">
        <div>
          <h2>{project.name}</h2>
          <div className="detail-status-row">
            <span className={`detail-dot detail-dot-${project.needStatus.toLowerCase()}`} aria-hidden="true" />
            <span>{project.needStatus}</span>
            <span className="detail-divider">|</span>
            <span className={`detail-sync-state detail-sync-${project.syncStatus}`}>
              {project.syncStatus === "success"
                ? <CheckCircle2 size={14} aria-hidden="true" />
                : project.syncStatus === "partial"
                  ? <TriangleAlert size={14} aria-hidden="true" />
                  : project.syncStatus === "failed"
                    ? <CircleX size={14} aria-hidden="true" />
                    : <TriangleAlert size={14} aria-hidden="true" />}
              <span>
                {project.syncStatus === "success"
                  ? "Synced"
                  : project.syncStatus === "partial"
                    ? "Unverified"
                    : project.syncStatus === "failed"
                      ? "Sync failed"
                      : "Stale"}
              </span>
            </span>
          </div>
        </div>
        <div className="detail-header-actions">
          <button
            className="icon-button"
            type="button"
            onClick={onClose}
            aria-label="Close project detail"
            title="Close project detail"
          >
            <X size={16} />
          </button>
          <button
            className={`icon-button${project.pinned ? " icon-button-active" : ""}`}
            type="button"
            onClick={() => onTogglePin?.(project.id)}
            aria-label={`${project.pinned ? "Unpin" : "Pin"} ${project.name}`}
            title={`${project.pinned ? "Unpin" : "Pin"} ${project.name}`}
          >
            <Star size={16} />
          </button>
        </div>
      </div>

      {banner ? (
        <div
          className={`detail-banner detail-banner-${banner.tone}`}
          role={banner.tone === "error" ? "alert" : "status"}
          aria-live={banner.tone === "error" ? "assertive" : "polite"}
        >
          {banner.text}
        </div>
      ) : null}

      {renderFieldBlock(project, "userNeed", "User need")}
      {renderFieldBlock(project, "currentState", "Current state")}
      {renderFieldBlock(project, "nextAction", "Next action")}

      <section className="detail-section detail-summary-meta" aria-label="Project timing and attention">
        <div><span className="detail-meta-label">Last activity</span><strong>{formatTimestamp(project.lastActivityAt)}</strong></div>
        <div><span className="detail-meta-label">Last sync</span><strong>{formatTimestamp(project.lastSyncedAt)}</strong></div>
        <div>
          <span className="detail-meta-label">Attention</span>
          {project.attentionFlags?.length ? project.attentionFlags.map((flag) => <span key={flag} className="import-count">{flag}</span>) : <span>None</span>}
        </div>
      </section>

      {project.missingItems?.length ? (
        <section className="detail-section detail-secondary">
          <div className="detail-section-header">
            <h3>Missing items</h3>
            <ListTodo size={15} />
          </div>
          <ul className="detail-list detail-list-stack">
            {project.missingItems.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      ) : null}

      {project.importantFiles?.length ? (
        <section className="detail-section detail-secondary">
          <div className="detail-section-header">
            <h3>Important files</h3>
            <FileText size={15} />
          </div>
          <ul className="detail-list detail-list-stack">
            {project.importantFiles.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="detail-section">
        <div className="detail-section-header">
          <h3>Sources</h3>
          <GitBranch size={15} />
        </div>
        <ul className="detail-list detail-list-stack detail-source-list">
          {project.sources.map((source) => (
            <li key={`${source.kind}-${source.label}`}>
              <div className="source-row">
                <span className="source-label">
                  <span className="source-bullet" aria-hidden="true" />
                  <strong>{source.label}</strong>
                </span>
                <span className={`source-status source-status-${source.syncStatus}`}>
                  {sourceSyncIcon(source.syncStatus)}
                  <span>{sourceSyncLabel(source.syncStatus)}</span>
                </span>
              </div>
              <span className="detail-meta source-detail">
                {source.syncStatus}
                {source.lastSyncedAt ? ` · ${formatTimestamp(source.lastSyncedAt)}` : ""}
              </span>
              {source.unavailableReason ? (
                <span className="detail-warning-inline">{source.unavailableReason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </section>

      <section className="detail-section">
        <div className="detail-section-header">
          <h3>Recent activity</h3>
          <Clock3 size={15} />
        </div>
        <ul className="detail-list detail-list-stack detail-activity-list">
          {(project.recentActivity ?? []).length > 0 ? (
            project.recentActivity?.map((entry) => (
              <li className="activity-item" key={entry.id}>
                <span className="activity-icon" aria-hidden="true">{activityIcon(entry.kind)}</span>
                <strong>{entry.message}</strong>
                <span className="detail-meta">{relativeTime(entry.createdAt)}</span>
              </li>
            ))
          ) : (
            <li>No recorded activity yet.</li>
          )}
        </ul>
      </section>

      <section className={`detail-section detail-suggestions-section${isSuggestionsOpen ? " suggestions-open" : ""}`}>
        <button
          className="detail-section-header detail-section-toggle"
          type="button"
          onClick={() => setIsSuggestionsOpen((current) => !current)}
          aria-expanded={isSuggestionsOpen}
          aria-controls="suggested-changes-content"
        >
          <span className="detail-section-title">
            <h3>Suggested changes</h3>
            <Sparkles size={15} aria-hidden="true" />
          </span>
          <span className="count-pill suggestion-count">{project.suggestions?.length ?? 0}</span>
          <ChevronDown className="suggestion-toggle-icon" size={16} aria-hidden="true" />
        </button>

        <div id="suggested-changes-content">
          {project.suggestions?.length ? (
          <>
            {project.suggestions.length > 0 ? (
              <div className="detail-inline-actions">
                <button
                  className="toolbar-button toolbar-button-primary"
                  type="button"
                  onClick={() => void onAcceptAllSuggestions(project)}
                  aria-label="Accept all suggestions"
                >
                  <Sparkles size={15} />
                  <span>Accept all</span>
                </button>
                <button
                  className="toolbar-button toolbar-button-quiet"
                  type="button"
                  onClick={() => void onDismissAllSuggestions(project)}
                  aria-label="Dismiss all suggestions"
                >
                  <AlertTriangle size={15} />
                  <span>Dismiss all</span>
                </button>
              </div>
            ) : null}

            <div className="suggestion-list">
              {project.suggestions.map((suggestion) => (
                <article className="suggestion-card" key={suggestion.id}>
                  <div className="suggestion-card-header">
                    <strong>{suggestion.title}</strong>
                    <span className="detail-meta">{formatTimestamp(suggestion.createdAt)}</span>
                  </div>
                  <span className="detail-meta">{`Field: ${suggestion.field}`}</span>
                  <p>{suggestion.detail}</p>
                  <div className="suggestion-values">
                    <div>
                      <span className="detail-meta">Current value</span>
                      <p>{`Current: ${suggestion.currentValue}`}</p>
                    </div>
                    <div>
                      <span className="detail-meta">Proposed value</span>
                      <p>{suggestion.proposedValue}</p>
                    </div>
                  </div>
                  <div className="suggestion-evidence">
                    {suggestion.evidence.map((evidence) => (
                      <span className="import-count" key={`${suggestion.id}-${evidence.kind}-${evidence.value}`}>
                        {evidence.kind}: {evidence.value}
                      </span>
                    ))}
                  </div>
                  <div className="detail-inline-actions">
                    <button
                      className="toolbar-button toolbar-button-primary"
                      type="button"
                      onClick={() => void onAcceptSuggestion(project.id, suggestion.id)}
                      aria-label={`Accept ${suggestion.title}`}
                      title="Accept and open Codex to implement"
                    >
                      <Sparkles size={15} />
                      <span>Accept</span>
                    </button>
                    <button
                      className="toolbar-button toolbar-button-quiet"
                      type="button"
                      onClick={() => void onDismissSuggestion(project.id, suggestion.id)}
                      aria-label={`Dismiss ${suggestion.title}`}
                    >
                      <AlertTriangle size={15} />
                      <span>Dismiss</span>
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </>
          ) : (
            <p className="empty-copy">No pending suggestions.</p>
          )}
        </div>
      </section>

      {launchControls}
      {importCenter}
    </aside>
  );
}
