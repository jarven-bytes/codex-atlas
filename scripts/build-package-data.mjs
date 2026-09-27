import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const defaultSourceDir = path.join(repositoryRoot, "resources", "seed");
const defaultOutputDir = path.join(repositoryRoot, "dist", "package-data");
const userHomePrefixPattern = /\/Users\/[^/]+(?=\/|$)/gu;

export const CODEX_HOME_TOKEN = "__CODEX_HOME__";

export function tokenizePackagedSeed(value) {
  if (typeof value === "string") {
    return value.replace(userHomePrefixPattern, CODEX_HOME_TOKEN);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => tokenizePackagedSeed(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, tokenizePackagedSeed(entry)])
    );
  }
  return value;
}

export async function buildPackageData({ sourceDir = defaultSourceDir, outputDir = defaultOutputDir } = {}) {
  await rm(outputDir, { recursive: true, force: true });
  await mkdir(outputDir, { recursive: true });

  const projects = JSON.parse(await readFile(path.join(sourceDir, "projects.json"), "utf8"));
  await writeFile(
    path.join(outputDir, "projects.json"),
    `${JSON.stringify(tokenizePackagedSeed(projects), null, 2)}\n`,
    "utf8"
  );
  await copyFile(
    path.join(sourceDir, "import-mappings.json"),
    path.join(outputDir, "import-mappings.json")
  );
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  await buildPackageData();
}
