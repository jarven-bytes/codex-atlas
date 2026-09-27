import { ExternalLink, FolderOpen, ShieldCheck, Square, Terminal } from "lucide-react";
import type { LaunchTarget } from "../../shared/domain";

export interface LaunchTargetState {
  status: "idle" | "approval-required" | "starting" | "running" | "stopped" | "disabled" | "opened" | "error";
  message?: string;
  fingerprint?: string;
  processId?: string;
  trusted?: boolean;
  terminal?: boolean;
  pollError?: string;
}

interface LaunchControlsProps {
  projectId: string;
  targets: LaunchTarget[];
  targetStates: Record<string, LaunchTargetState | undefined>;
  onLaunch: (projectId: string, targetId: string, approvalFingerprint?: string) => void | Promise<void>;
  onStop: (targetId: string, processId: string, targetLabel: string) => void | Promise<void>;
}

function targetKindLabel(target: LaunchTarget, state: LaunchTargetState | undefined): string {
  switch (target.kind) {
    case "command":
      return `${target.origin === "imported" ? "Imported command" : "Command"} · ${state?.trusted ? "Trusted" : "Untrusted"}`;
    case "document":
      return "Document";
    case "folder":
      return "Folder";
    case "task":
      return "Task";
    case "url":
      return "URL";
  }
}

function targetCommandLabel(target: Extract<LaunchTarget, { kind: "command" }>): string {
  const port = target.port === undefined ? "" : `, port: ${target.port}`;
  return `${[target.executable, ...target.args].join(" ")} (cwd: ${target.cwd}${port})`;
}

function launchActionLabel(target: LaunchTarget): string {
  return target.kind === "command" ? `Launch ${target.label}` : `Open ${target.label}`;
}

function launchIcon(target: LaunchTarget) {
  if (target.kind === "command") {
    return <Terminal size={15} />;
  }

  if (target.kind === "folder") {
    return <FolderOpen size={15} />;
  }

  return <ExternalLink size={15} />;
}

export function LaunchControls({
  projectId,
  targets,
  targetStates,
  onLaunch,
  onStop
}: LaunchControlsProps) {
  return (
    <section className="detail-section detail-launch-section" aria-labelledby="launch-controls-heading">
      <div className="detail-section-header">
        <h3 id="launch-controls-heading">Launch actions</h3>
      </div>

      {targets.length === 0 ? (
        <p className="empty-copy">No launch targets are registered yet.</p>
      ) : (
        <div className="launch-list">
          {targets.map((target) => {
            const state = targetStates[target.id];
            const isCommand = target.kind === "command";
            const isProcessActive = state?.status === "starting" || state?.status === "running";
            const isProcessStateUnconfirmed = state?.status === "error" &&
              Boolean(state.processId) && state.terminal !== true;
            const isStartingOrRunning = isProcessActive || isProcessStateUnconfirmed;
            const appUrl = isCommand && target.port
              ? `http://127.0.0.1:${target.port}`
              : null;
            return (
              <article className="launch-row" key={target.id}>
                <div className="launch-copy">
                  <div className="launch-label-row">
                    <strong>{target.label}</strong>
                    <span className="launch-kind">{targetKindLabel(target, state)}</span>
                  </div>
                  <p className="launch-summary">
                    {isCommand ? targetCommandLabel(target) : target.label}
                  </p>
                  {state?.status === "approval-required" ? (
                    <p className="launch-message launch-message-warning">
                      Review the complete command identity, including its working directory, before approving.
                    </p>
                  ) : null}
                  {state?.message ? (
                    <p
                      className={`launch-message launch-message-${state.status === "error" ? "error" : state.status === "approval-required" ? "warning" : "info"}`}
                    >
                      {state.message}
                    </p>
                  ) : null}
                  {state?.pollError ? (
                    <p className="launch-message launch-message-error" role="alert">
                      {state.pollError}
                    </p>
                  ) : null}
                </div>
                <div className="launch-actions">
                  <button
                    className="toolbar-button toolbar-button-quiet"
                    type="button"
                    onClick={() => void onLaunch(projectId, target.id)}
                    disabled={isStartingOrRunning}
                    aria-label={launchActionLabel(target)}
                  >
                    {launchIcon(target)}
                    <span>{isCommand ? "Launch" : target.label}</span>
                  </button>

                  {state?.status === "approval-required" && state.fingerprint ? (
                    <button
                      className="toolbar-button toolbar-button-primary"
                      type="button"
                      onClick={() => void onLaunch(projectId, target.id, state.fingerprint)}
                      aria-label={`Approve and launch ${target.label}`}
                    >
                      <ShieldCheck size={15} />
                      <span>Approve</span>
                    </button>
                  ) : null}

                  {state?.processId ? (
                    <button
                      className="toolbar-button toolbar-button-danger"
                      type="button"
                      onClick={() => void onStop(target.id, state.processId as string, target.label)}
                      aria-label={`Stop ${target.label}`}
                    >
                      <Square size={15} />
                      <span>Stop</span>
                    </button>
                  ) : null}
                  {appUrl && state?.status === "running" ? (
                    <button
                      className="toolbar-button toolbar-button-quiet"
                      type="button"
                      onClick={() => window.open(appUrl, "_blank", "noopener,noreferrer")}
                      aria-label={`Open app ${target.label}`}
                    >
                      <ExternalLink size={15} />
                      <span>Open app</span>
                    </button>
                  ) : null}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
