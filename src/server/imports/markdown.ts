import path from "node:path";
import type { LocalFolderMetadata } from "./types";

function normalizeHeading(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeList(lines: string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.replace(/^[-*]\s+/u, "").trim())
    .filter(Boolean);
}

export function parseProjectTemplateMarkdown(markdown: string, folderPath: string): LocalFolderMetadata {
  const lines = markdown.split(/\r?\n/u);
  const sections = new Map<string, string[]>();
  let currentHeading: string | null = null;

  for (const line of lines) {
    const headingMatch = /^##\s+(.+)$/u.exec(line.trim());
    if (headingMatch) {
      currentHeading = normalizeHeading(headingMatch[1]);
      sections.set(currentHeading, []);
      continue;
    }

    if (!currentHeading) {
      continue;
    }

    sections.get(currentHeading)?.push(line);
  }

  const titleLine = lines.find((line) => /^#\s+/u.test(line.trim()));
  const title = titleLine?.replace(/^#\s+/u, "").trim() || path.basename(folderPath);

  return {
    name: title,
    userNeed: sections.get("user need")?.join("\n").trim() || undefined,
    currentState: sections.get("current state")?.join("\n").trim() || undefined,
    nextAction: sections.get("next action")?.join("\n").trim() || undefined,
    tags: normalizeList(sections.get("tags") ?? []).sort(),
    missingItems: normalizeList(sections.get("missing items") ?? [])
  };
}
