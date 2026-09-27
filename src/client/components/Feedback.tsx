import { Bug, ExternalLink, Lightbulb, MessageSquare } from "lucide-react";
import { useEffect, useRef, useState } from "react";

const options = [
  { kind: "bug", label: "Report a bug", template: "bug_report.md", Icon: Bug },
  { kind: "feature", label: "Suggest a feature", template: "feature_request.md", Icon: Lightbulb }
] as const;

export function Feedback() {
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (detailsRef.current && !detailsRef.current.contains(event.target as Node)) {
        detailsRef.current.open = false;
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && detailsRef.current?.open) {
        detailsRef.current.open = false;
        detailsRef.current.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, []);

  return (
    <details className="feedback-control" ref={detailsRef}>
      <summary><MessageSquare size={16} aria-hidden="true" /><span>Send feedback</span></summary>
      <div className="feedback-popover" role="group" aria-label="Send feedback">
        {options.map(({ kind, label, template, Icon }) => (
          <a
            key={kind}
            href={`https://github.com/jarven-bytes/codex-atlas/issues/new?template=${template}`}
            target="_blank"
            rel="noopener noreferrer"
            onClick={async (event) => {
              setError("");
              if (!window.codexAtlas?.openFeedback) return;
              event.preventDefault();
              try {
                await window.codexAtlas.openFeedback(kind);
                if (detailsRef.current) detailsRef.current.open = false;
              } catch {
                setError("Could not open GitHub. Please try again.");
              }
            }}
          >
            <Icon size={16} aria-hidden="true" />
            <span>{label}</span>
            <ExternalLink size={13} aria-hidden="true" />
          </a>
        ))}
        <p>GitHub issues are public. Don't include private project information. No project data or logs are attached.</p>
        {error ? <p role="alert">{error}</p> : null}
      </div>
    </details>
  );
}
