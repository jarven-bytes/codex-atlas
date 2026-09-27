import type { NeedStatus } from "../../shared/domain";
import { Cell, Pie, PieChart } from "recharts";

export interface StatusCount {
  status: NeedStatus;
  count: number;
}

interface StatusPieChartProps {
  counts: StatusCount[];
  selectedStatus?: NeedStatus;
  onStatusSelect: (status: NeedStatus) => void;
  onClearStatus: () => void;
}

const statusColor: Record<NeedStatus, string> = {
  Plan: "#3f8fe5",
  Need: "#f2a10a",
  Insufficient: "#cf4f4f"
};

export function StatusPieChart({
  counts,
  selectedStatus,
  onStatusSelect,
  onClearStatus
}: StatusPieChartProps) {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  let cumulativeCount = 0;
  const segments = counts.map((entry) => {
    const start = total ? cumulativeCount / total * Math.PI * 2 : 0;
    cumulativeCount += entry.count;
    const end = total ? cumulativeCount / total * Math.PI * 2 : 0;
    const midpoint = (start + end) / 2;
    return {
      ...entry,
      labelLeft: 112 + Math.sin(midpoint) * 80,
      labelTop: 112 - Math.cos(midpoint) * 80
    };
  });
  const handleStatusSelect = (status: NeedStatus) => {
    onStatusSelect(status);
  };

  return (
    <section className="dashboard-panel dashboard-section" aria-labelledby="status-heading">
      <div className="section-header">
        <h2 id="status-heading">Status</h2>
      </div>
      <div className="status-chart-layout">
        <table className="sr-only">
          <caption>Project status totals</caption>
          <thead><tr><th scope="col">Status</th><th scope="col">Projects</th></tr></thead>
          <tbody>
            {counts.map((entry) => <tr key={entry.status}><th scope="row">{entry.status}</th><td>{entry.count}</td></tr>)}
          </tbody>
          <tfoot><tr><th scope="row">Total</th><td>{total}</td></tr></tfoot>
        </table>
        <div className="status-chart-frame" role="group" aria-label="Status chart">
          <PieChart width={224} height={224}>
            <Pie
              data={counts}
              dataKey="count"
              nameKey="status"
              cx="50%"
              cy="50%"
              innerRadius={56}
              outerRadius={106}
              startAngle={90}
              endAngle={-270}
              paddingAngle={1}
              stroke="#ffffff"
              strokeWidth={2}
              isAnimationActive={false}
              onClick={(entry) => {
                if (entry && typeof entry === "object" && "status" in entry) {
                  handleStatusSelect(entry.status as NeedStatus);
                }
              }}
            >
              {counts.map((entry) => (
                <Cell
                  key={entry.status}
                  fill={statusColor[entry.status]}
                  style={{ cursor: "pointer" }}
                />
              ))}
            </Pie>
          </PieChart>
          <button
            className="status-chart-total status-chart-total-button"
            type="button"
            onClick={onClearStatus}
            aria-label="Show all projects"
            title="Show all projects"
          >
            <strong>{total}</strong>
            <span>Total</span>
          </button>
          <div className="status-chart-counts" aria-hidden="true">
            {segments.filter((entry) => entry.count > 0).map((entry) => (
              <span className="status-chart-count" key={entry.status} style={{ left: entry.labelLeft, top: entry.labelTop }}>
                {entry.count}
              </span>
            ))}
          </div>
          <div className="status-chart-hitboxes" aria-label="Status chart controls">
            {segments.map((entry) => {
              const label = `${entry.status} slice ${entry.count} projects`;
              return (
                <button
                  key={entry.status}
                  className={`chart-slice-button${
                    selectedStatus === entry.status ? " chart-slice-button-selected" : ""
                  }`}
                  type="button"
                  style={{ left: entry.labelLeft - 22, top: entry.labelTop - 22, width: 44, height: 44 }}
                  disabled={entry.count === 0}
                  onClick={() => handleStatusSelect(entry.status)}
                  aria-label={label}
                  aria-pressed={selectedStatus === entry.status}
                  title={label}
                />
              );
            })}
          </div>
        </div>
        <ul className="status-legend" aria-label="Status legend">
          {counts.map((entry) => {
            const percentage = total === 0 ? 0 : Math.round((entry.count / total) * 100);
            const isSelected = selectedStatus === entry.status;
            const label = `${entry.status} ${entry.count} projects`;

            return (
              <li key={entry.status}>
                <button
                  className={`legend-button${isSelected ? " legend-button-selected" : ""}`}
                  type="button"
                  onClick={() => handleStatusSelect(entry.status)}
                  aria-pressed={isSelected}
                  aria-label={label}
                  title={label}
                >
                  <span className="legend-label">
                    <span
                      className="legend-swatch"
                      style={{ backgroundColor: statusColor[entry.status] }}
                      aria-hidden="true"
                    />
                    {entry.status}
                  </span>
                  <span className="legend-value">
                    {entry.count} ({percentage}%)
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
