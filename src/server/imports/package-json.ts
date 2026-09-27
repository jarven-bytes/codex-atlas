import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LaunchTarget, ProjectType } from "../../shared/domain";

export interface PackageJsonMetadata {
  aliases: string[];
  repositoryUrl?: string;
  type?: ProjectType;
  launchTargets: LaunchTarget[];
}

function normalizeRepositoryUrl(value: string): string {
  const trimmed = value.trim().replace(/\.git$/u, "");
  const sshMatch = /^git@github\.com:(.+)$/u.exec(trimmed);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  return trimmed;
}

function inferProjectType(scripts: Record<string, unknown> | undefined): ProjectType | undefined {
  if (!scripts) {
    return undefined;
  }

  const scriptNames = Object.keys(scripts);
  if (scriptNames.some((name) => ["dev", "build", "start", "preview"].includes(name))) {
    return "web-app";
  }

  return undefined;
}

export async function readPackageJsonMetadata(projectRoot: string): Promise<PackageJsonMetadata> {
  const packagePath = path.join(projectRoot, "package.json");
  const raw = await readFile(packagePath, "utf8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const scripts = parsed.scripts && typeof parsed.scripts === "object"
    ? parsed.scripts as Record<string, unknown>
    : undefined;

  const launchTargets: LaunchTarget[] = [
    {
      kind: "folder",
      id: "workspace-root",
      label: "Workspace root",
      path: projectRoot
    }
  ];

  if (scripts) {
    for (const [scriptName] of Object.entries(scripts)) {
      launchTargets.push({
        kind: "command",
        id: `script-${scriptName}`,
        label: `Run ${scriptName}`,
        origin: "scanner",
        executable: "npm",
        args: ["run", scriptName],
        cwd: projectRoot
      });
    }
  }

  let repositoryUrl: string | undefined;
  if (typeof parsed.repository === "string" && parsed.repository.trim()) {
    repositoryUrl = normalizeRepositoryUrl(parsed.repository);
  } else if (parsed.repository && typeof parsed.repository === "object") {
    const value = (parsed.repository as Record<string, unknown>).url;
    if (typeof value === "string" && value.trim()) {
      repositoryUrl = normalizeRepositoryUrl(value);
    }
  }

  return {
    aliases: typeof parsed.name === "string" && parsed.name.trim() ? [parsed.name.trim()] : [],
    repositoryUrl,
    type: inferProjectType(scripts),
    launchTargets
  };
}
