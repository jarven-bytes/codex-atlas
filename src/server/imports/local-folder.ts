import { readFile } from "node:fs/promises";
import path from "node:path";
import type { CandidateEvidence, ProjectCandidate } from "../../shared/domain";
import { parseProjectTemplateMarkdown } from "./markdown";
import { readPackageJsonMetadata } from "./package-json";
import type { AdapterPreviewResult, ImportAdapter, ImportSource } from "./types";

function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim().replace(/\.git$/u, "");
  const sshMatch = /^git@github\.com:(.+)$/u.exec(trimmed);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  return trimmed;
}

async function readGitRepositoryUrl(projectRoot: string): Promise<string | undefined> {
  try {
    const config = await readFile(path.join(projectRoot, ".git", "config"), "utf8");
    const match = /^\s*url = (.+)$/mu.exec(config);
    return match?.[1] ? normalizeRepositoryUrl(match[1]) : undefined;
  } catch {
    return undefined;
  }
}

export class LocalFolderImportAdapter implements ImportAdapter {
  canHandle(source: ImportSource): boolean {
    return source.kind === "local-folder";
  }

  async preview(source: ImportSource): Promise<AdapterPreviewResult> {
    if (source.kind !== "local-folder") {
      throw new Error(`Unsupported source kind: ${source.kind}`);
    }

    const projectRoot = path.resolve(source.path);
    const [templateMarkdown, packageMetadata, gitRepositoryUrl] = await Promise.all([
      readFile(path.join(projectRoot, "PROJECT_TEMPLATE.md"), "utf8"),
      readPackageJsonMetadata(projectRoot),
      readGitRepositoryUrl(projectRoot)
    ]);

    const parsedMarkdown = parseProjectTemplateMarkdown(templateMarkdown, projectRoot);
    const repositoryUrl = packageMetadata.repositoryUrl ?? gitRepositoryUrl;
    const evidence: CandidateEvidence[] = [{ kind: "root-path", value: projectRoot }];

    if (repositoryUrl) {
      evidence.push({ kind: "repository-url", value: repositoryUrl });
    }

    for (const alias of packageMetadata.aliases) {
      evidence.push({ kind: "alias", value: alias });
    }

    const candidate: ProjectCandidate = {
      name: parsedMarkdown.name ?? path.basename(projectRoot),
      source: {
        kind: "import",
        label: source.label,
        sourceId: `local-folder:${projectRoot}`,
        syncStatus: "success",
        observedAt: new Date().toISOString()
      },
      evidence,
      verifiedAt: new Date().toISOString(),
      type: packageMetadata.type,
      userNeed: parsedMarkdown.userNeed,
      currentState: parsedMarkdown.currentState,
      nextAction: parsedMarkdown.nextAction,
      rootPath: projectRoot,
      repositoryUrl,
      aliases: packageMetadata.aliases,
      launchTargets: packageMetadata.launchTargets,
      tags: parsedMarkdown.tags,
      missingItems: parsedMarkdown.missingItems
    };

    return {
      detectedColumns: [
        "name",
        "userNeed",
        "currentState",
        "nextAction",
        "tags",
        "missingItems",
        "repositoryUrl",
        "launchTargets"
      ],
      rows: [{ candidate, raw: { path: projectRoot } }]
    };
  }
}
