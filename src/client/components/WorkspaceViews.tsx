import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Contrast,
  Database,
  FileText,
  ListChecks,
  RefreshCw,
  RotateCcw,
  Settings2,
  Sun,
  Upload,
  Search,
  Sparkles,
  FolderOpen
} from "lucide-react";
import { useState, type ReactNode } from "react";
import type { InstalledSkill } from "../../server/skills/skills-service";
import type { Project, SyncState } from "../../shared/domain";
import { AttentionQueue, type AttentionQueueItem } from "./AttentionQueue";
import { StatusBadge } from "./StatusBadge";

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

function syncLabel(status: SyncState): string {
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
      return "Not synced";
  }
}

function syncIcon(status: SyncState) {
  if (status === "success") {
    return <CheckCircle2 size={15} aria-hidden="true" />;
  }

  return <CircleAlert size={15} aria-hidden="true" />;
}

function sourceRows(projects: Project[]) {
  return projects.flatMap((project) =>
    project.sources.map((source) => ({
      key: `${project.id}-${source.kind}-${source.label}`,
      project,
      source
    }))
  );
}

export function SourcesView({ projects }: { projects: Project[] }) {
  const rows = sourceRows(projects);
  const verifiedCount = rows.filter(({ source }) => source.syncStatus === "success").length;
  const reviewCount = rows.length - verifiedCount;

  return (
    <section className="workspace-view dashboard-panel" aria-labelledby="sources-view-heading">
      <div className="workspace-view-header">
        <div>
          <p className="workspace-eyebrow">Evidence registry</p>
          <h2 id="sources-view-heading">Sources</h2>
          <p>See what feeds each project and which inputs need review.</p>
        </div>
        <Database size={22} aria-hidden="true" />
      </div>
      <div className="workspace-metrics" aria-label="Source summary">
        <div><strong>{rows.length}</strong><span>Total sources</span></div>
        <div><strong>{verifiedCount}</strong><span>Verified</span></div>
        <div><strong>{reviewCount}</strong><span>Needs attention</span></div>
      </div>
      <div className="workspace-list workspace-source-list">
        <div className="workspace-list-head" aria-hidden="true">
          <span>Source</span><span>Project</span><span>Status</span><span>Last sync</span>
        </div>
        {rows.map(({ key, project, source }) => (
          <div className="workspace-list-row" key={key}>
            <div className="workspace-list-primary">
              <strong title={source.label}>{source.label}</strong>
              <span>{source.kind}</span>
            </div>
            <span className="workspace-project-label" title={project.name}>{project.name}</span>
            <span className={`workspace-sync workspace-sync-${source.syncStatus}`}>
              {syncIcon(source.syncStatus)}
              {syncLabel(source.syncStatus)}
            </span>
            <span className="workspace-time">{source.lastSyncedAt ? relativeTime(source.lastSyncedAt) : "Never"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function ChangeLogView({ projects }: { projects: Project[] }) {
  const events = projects
    .flatMap((project) => (project.recentActivity ?? []).map((activity) => ({ project, activity })))
    .sort((left, right) => new Date(right.activity.createdAt).getTime() - new Date(left.activity.createdAt).getTime());

  return (
    <section className="workspace-view dashboard-panel" aria-labelledby="change-log-view-heading">
      <div className="workspace-view-header">
        <div>
          <p className="workspace-eyebrow">Local evidence trail</p>
          <h2 id="change-log-view-heading">Change log</h2>
          <p>Review the activity that changed project understanding or sync state.</p>
        </div>
        <FileText size={22} aria-hidden="true" />
      </div>
      <div className="workspace-list workspace-activity-list">
        <div className="workspace-list-head" aria-hidden="true">
          <span>Event</span><span>Project</span><span>Type</span><span>When</span>
        </div>
        {events.length === 0 ? <p className="workspace-empty">No activity has been recorded yet.</p> : null}
        {events.map(({ project, activity }) => (
          <div className="workspace-list-row" key={`${project.id}-${activity.id}`}>
            <div className="workspace-list-primary workspace-event-primary">
              <strong>{activity.message}</strong>
              <span>{project.rootPath ?? "Local project"}</span>
            </div>
            <span className="workspace-project-label" title={project.name}>{project.name}</span>
            <span className="workspace-event-kind">{activity.kind.replace("-", " ")}</span>
            <span className="workspace-time">{relativeTime(activity.createdAt)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

interface SkillsViewProps {
  skills: InstalledSkill[];
  loading: boolean;
  error: string | null;
  selectedSkillId: string | null;
  onSelectSkill: (skillId: string) => void;
  onRefresh: () => void;
  onOpenProject: (projectId: string) => void;
}

export function SkillsView({
  skills,
  loading,
  error,
  selectedSkillId,
  onSelectSkill,
  onRefresh,
  onOpenProject
}: SkillsViewProps) {
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const filteredSkills = skills.filter((skill) =>
    !normalizedQuery || `${skill.name} ${skill.summary}`.toLowerCase().includes(normalizedQuery)
  );
  const selectedSkill = skills.find((skill) => skill.id === selectedSkillId) ?? null;

  return (
    <div className="skills-layout">
      <section className="workspace-view dashboard-panel skills-list-panel" aria-labelledby="skills-view-heading">
        <div className="workspace-view-header">
          <div>
            <p className="workspace-eyebrow">Local capability registry</p>
            <h2 id="skills-view-heading">Skills</h2>
            <p>See every installed Codex skill and where it is used across your projects.</p>
          </div>
          <button className="toolbar-icon" type="button" onClick={onRefresh} aria-label="Refresh skills" title="Refresh skills">
            <RefreshCw size={17} className={loading ? "spin" : ""} />
          </button>
        </div>
        <label className="skills-search">
          <Search size={16} aria-hidden="true" />
          <span className="sr-only">Search installed skills</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search installed skills"
          />
        </label>
        <div className="skills-summary" aria-label="Installed skill summary">
          <strong>{skills.length}</strong>
          <span>installed skills</span>
        </div>
        {error ? <p className="workspace-inline-error" role="alert">{error}</p> : null}
        {loading && skills.length === 0 ? <p className="workspace-empty">Scanning local skill folders...</p> : null}
        {!loading && !error && filteredSkills.length === 0 ? <p className="workspace-empty">No installed skills match this search.</p> : null}
        <div className="skills-list" role="list">
          {filteredSkills.map((skill) => (
            <div role="listitem" key={skill.id}>
              <button
                className={`skill-list-item${selectedSkill?.id === skill.id ? " skill-list-item-selected" : ""}`}
                type="button"
                onClick={() => onSelectSkill(skill.id)}
                aria-pressed={selectedSkill?.id === skill.id}
              >
                <span className="skill-list-icon" aria-hidden="true"><Sparkles size={17} /></span>
                <span className="skill-list-copy">
                  <strong>{skill.name}</strong>
                  <span>{skill.summary}</span>
                </span>
                <span className="skill-list-meta">{skill.projects.length} {skill.projects.length === 1 ? "project" : "projects"}</span>
              </button>
            </div>
          ))}
        </div>
      </section>

      <aside className="dashboard-panel skill-detail-panel" aria-label="Skill detail">
        {selectedSkill ? (
          <>
            <div className="skill-detail-heading">
              <span className="skill-detail-icon" aria-hidden="true"><Sparkles size={18} /></span>
              <div>
                <p className="workspace-eyebrow">Installed skill</p>
                <h2>{selectedSkill.name}</h2>
              </div>
            </div>
            <p className="skill-detail-summary">{selectedSkill.summary}</p>
            <dl className="skill-detail-meta">
              <div><dt>Source</dt><dd>User-installed</dd></div>
              <div><dt>Location</dt><dd title={selectedSkill.path}>{selectedSkill.path}</dd></div>
            </dl>
            <div className="skill-projects-section">
              <h3>Projects using this skill</h3>
              {selectedSkill.projects.length === 0 ? (
                <p className="workspace-empty">No project usage was found in local evidence.</p>
              ) : (
                <div className="skill-project-list">
                  {selectedSkill.projects.map((project) => (
                    <div className="skill-project-row" key={project.projectId}>
                      <button type="button" onClick={() => onOpenProject(project.projectId)}>
                        <FolderOpen size={15} aria-hidden="true" />
                        <strong>{project.projectName}</strong>
                      </button>
                      <ul>
                        {project.evidence.map((evidence) => <li key={evidence}>{evidence}</li>)}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="skill-detail-empty">
            <Sparkles size={22} aria-hidden="true" />
            <h2>Select a skill</h2>
            <p>Choose an installed skill to inspect its summary and project usage.</p>
          </div>
        )}
      </aside>
    </div>
  );
}

export function ActionsView({ items, projects, onViewAll }: { items: AttentionQueueItem[]; projects: Project[]; onViewAll: () => void }) {
  const urgentCount = items.filter((item) => item.priority <= 2).length;
  const readyCount = Math.max(0, projects.length - items.length);

  return (
    <div className="workspace-actions-view">
      <section className="workspace-view dashboard-panel" aria-labelledby="actions-view-heading">
        <div className="workspace-view-header">
          <div>
            <p className="workspace-eyebrow">Next moves</p>
            <h2 id="actions-view-heading">Actions</h2>
            <p>Work from the attention queue and keep every next action tied to a project.</p>
          </div>
          <ListChecks size={22} aria-hidden="true" />
        </div>
        <div className="workspace-metrics" aria-label="Action summary">
          <div><strong>{items.length}</strong><span>Open actions</span></div>
          <div><strong>{urgentCount}</strong><span>Urgent</span></div>
          <div><strong>{readyCount}</strong><span>On track</span></div>
        </div>
      </section>
      <AttentionQueue items={items} onViewAll={onViewAll} />
    </div>
  );
}

interface SettingsViewProps {
  isCompactMode: boolean;
  onCompactModeChange: (value: boolean) => void;
  isHighContrastStatus: boolean;
  onHighContrastStatusChange: (value: boolean) => void;
  autoRefresh: boolean;
  onAutoRefreshChange: (value: boolean) => void;
  refreshInterval: number;
  onRefreshIntervalChange: (value: number) => void;
  onRefresh: () => void;
  onResetFilters: () => void;
  onOpenImport: () => void;
}

function SettingToggle({
  label,
  detail,
  checked,
  onChange,
  icon
}: {
  label: string;
  detail: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  icon: ReactNode;
}) {
  return (
    <label className="settings-row">
      <span className="settings-row-icon">{icon}</span>
      <span className="settings-row-copy"><strong>{label}</strong><span>{detail}</span></span>
      <input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} aria-label={label} />
      <span className="settings-switch" aria-hidden="true"><span /></span>
    </label>
  );
}

export function SettingsView(props: SettingsViewProps) {
  return (
    <div className="settings-layout">
      <section className="workspace-view dashboard-panel settings-panel" aria-labelledby="settings-view-heading">
        <div className="workspace-view-header">
          <div>
            <p className="workspace-eyebrow">Codex Atlas preferences</p>
            <h2 id="settings-view-heading">Settings</h2>
            <p>Control how the local command center looks, refreshes, and handles your working view.</p>
          </div>
          <Settings2 size={22} aria-hidden="true" />
        </div>

        <div className="settings-group">
          <h3>Appearance</h3>
          <SettingToggle
            label="High-contrast status colors"
            detail="Make Plan, Need, and Insufficient easier to scan."
            checked={props.isHighContrastStatus}
            onChange={props.onHighContrastStatusChange}
            icon={<Contrast size={17} />}
          />
          <SettingToggle
            label="Compact project table"
            detail="Show more projects in the same vertical space."
            checked={props.isCompactMode}
            onChange={props.onCompactModeChange}
            icon={<ListChecks size={17} />}
          />
        </div>

        <div className="settings-group">
          <h3>Workspace updates</h3>
          <SettingToggle
            label="Automatic refresh"
            detail="Scan local project evidence on a repeating schedule."
            checked={props.autoRefresh}
            onChange={props.onAutoRefreshChange}
            icon={<RefreshCw size={17} />}
          />
          <label className="settings-select-row">
            <span><strong>Refresh interval</strong><span>How often automatic refresh runs.</span></span>
            <select value={props.refreshInterval} onChange={(event) => props.onRefreshIntervalChange(Number(event.target.value))}>
              <option value={5}>5 minutes</option>
              <option value={15}>15 minutes</option>
              <option value={30}>30 minutes</option>
              <option value={60}>60 minutes</option>
            </select>
          </label>
        </div>

        <div className="settings-group">
          <h3>Data controls</h3>
          <div className="settings-action-row">
            <div><strong>Refresh evidence now</strong><span>Run a local scan immediately.</span></div>
            <button className="toolbar-button" type="button" onClick={props.onRefresh}><RefreshCw size={15} />Refresh</button>
          </div>
          <div className="settings-action-row">
            <div><strong>Reset dashboard filters</strong><span>Return the project list to its full view.</span></div>
            <button className="toolbar-button" type="button" onClick={props.onResetFilters}><RotateCcw size={15} />Reset</button>
          </div>
          <div className="settings-action-row">
            <div><strong>Import outside source</strong><span>Add CSV, JSON, or clipboard project records.</span></div>
            <button className="toolbar-button" type="button" onClick={props.onOpenImport}><Upload size={15} />Import</button>
          </div>
        </div>
      </section>
      <aside className="dashboard-panel settings-status-panel" aria-label="Local storage status">
        <div className="settings-status-mark"><CheckCircle2 size={18} aria-hidden="true" /></div>
        <h3>Local-first storage</h3>
        <p>Project records, evidence, and settings stay on this Mac unless you explicitly launch an external target.</p>
        <span className="settings-status-caption">Ready for local work</span>
      </aside>
    </div>
  );
}
