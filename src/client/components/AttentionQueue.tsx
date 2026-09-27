import { AlertCircle, Circle, Clock3, TriangleAlert } from "lucide-react";
import { useState } from "react";

export interface AttentionQueueItem {
  projectId: string;
  projectName: string;
  reason: string;
  detail: string;
  lastActivityAt: string;
  priority: number;
  actionLabel: string;
  onAction: () => void;
  actionKind: "open" | "accept";
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

interface AttentionQueueProps {
  items: AttentionQueueItem[];
  onViewAll: () => void;
}

function iconForItem(item: AttentionQueueItem) {
  switch (item.reason) {
    case "Sync failed":
      return <AlertCircle size={16} />;
    case "Unverified sources":
      return <TriangleAlert size={16} />;
    case "Needs review":
      return <Circle size={16} />;
    case "Stale":
      return <Clock3 size={16} />;
    default:
      return <AlertCircle size={16} />;
  }
}

export function AttentionQueue({ items, onViewAll }: AttentionQueueProps) {
  const [expandedItemKey, setExpandedItemKey] = useState<string | null>(null);

  if (items.length === 0) {
    return (
      <section className="dashboard-panel dashboard-section" aria-labelledby="attention-heading">
        <div className="section-header">
          <h2 id="attention-heading">Attention</h2>
        </div>
        <p className="empty-copy">No projects need attention right now.</p>
      </section>
    );
  }

  return (
    <section className="dashboard-panel dashboard-section" aria-labelledby="attention-heading">
      <div className="section-header">
        <h2 id="attention-heading">Attention</h2>
        <span className="count-pill">{items.length}</span>
      </div>
      <ul className="attention-list" aria-label="Attention queue">
        {items.map((item) => {
          const itemKey = `${item.projectId}-${item.reason}`;
          const isExpanded = expandedItemKey === itemKey;

          return (
            <li className={`attention-item${isExpanded ? " attention-item-expanded" : ""}`} key={itemKey}>
              <button
                className="attention-item-toggle"
                type="button"
                onClick={() => setExpandedItemKey((current) => (current === itemKey ? null : itemKey))}
                aria-expanded={isExpanded}
                aria-controls={`attention-details-${itemKey}`}
                aria-label={`${item.projectName}: ${item.reason}`}
              >
                <div className={`attention-icon attention-icon-${item.actionKind} attention-icon-priority-${item.priority}`} aria-hidden="true">
                  {iconForItem(item)}
                </div>
                <div className="attention-copy">
                  <h3>{item.projectName}</h3>
                  <p className="attention-reason">{item.reason}</p>
                  <p className="attention-detail">{item.detail}</p>
                </div>
                <span className="attention-time">{relativeTime(item.lastActivityAt)}</span>
              </button>
              {isExpanded ? (
                <div className="attention-item-details" id={`attention-details-${itemKey}`}>
                  <div className="attention-detail-block">
                    <strong>What is happening</strong>
                    <p>{item.reason}</p>
                  </div>
                  <div className="attention-detail-block">
                    <strong>Recommended fix</strong>
                    <p>{item.detail}</p>
                  </div>
                  <button
                    className={`toolbar-button ${item.actionKind === "accept" ? "toolbar-button-primary" : "toolbar-button-quiet"}`}
                    type="button"
                    onClick={item.onAction}
                    aria-label={item.actionKind === "accept" ? `Apply suggestion for ${item.projectName}` : item.actionLabel}
                  >
                    {item.actionKind === "accept" ? "Apply suggestion" : "Open project"}
                  </button>
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
      <button className="attention-view-all" type="button" onClick={onViewAll}>
        View all attention items
      </button>
    </section>
  );
}
