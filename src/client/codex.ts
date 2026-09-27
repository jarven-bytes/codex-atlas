export interface CodexSuggestionRequest {
  projectPath: string;
  projectName: string;
  suggestionTitle: string;
  detail: string;
  currentValue: string;
  proposedValue: string;
}

export interface CodexSuggestionResult {
  opened: boolean;
  message: string;
}

declare global {
  interface Window {
    codexAtlas?: {
      openSuggestion(request: CodexSuggestionRequest): Promise<CodexSuggestionResult>;
      openFeedback?(kind: "bug" | "feature"): Promise<void>;
    };
  }
}

export async function openCodexSuggestion(
  request: CodexSuggestionRequest
): Promise<CodexSuggestionResult> {
  if (typeof window === "undefined" || !window.codexAtlas) {
    return {
      opened: false,
      message: "Codex bridge unavailable in this environment."
    };
  }

  return window.codexAtlas.openSuggestion(request);
}
