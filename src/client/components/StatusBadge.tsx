import type { NeedStatus } from "../../shared/domain";

const statusClassName: Record<NeedStatus, string> = {
  Plan: "status-badge status-badge-plan",
  Need: "status-badge status-badge-need",
  Insufficient: "status-badge status-badge-insufficient"
};

interface StatusBadgeProps {
  status: NeedStatus;
}

export function StatusBadge({ status }: StatusBadgeProps) {
  return <span className={statusClassName[status]}>{status}</span>;
}
