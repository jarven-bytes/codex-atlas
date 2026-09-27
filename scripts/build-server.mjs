import { spawn } from "node:child_process";
import { access, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = path.resolve(path.dirname(scriptPath), "..");
const serverOutputRoot = path.join(repositoryRoot, "dist", "server");
const tsconfigPath = path.join(repositoryRoot, "tsconfig.server.json");
const relativeImportPattern = /((?:from\s+|import\s*\(\s*|import\s+))(["'])(\.{1,2}\/[^"']+)\2/g;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${signal ?? `code ${code ?? "unknown"}`}.`));
    });
  });
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function resolveRelativeImport(filePath, specifier) {
  const queryStart = specifier.search(/[?#]/);
  const pathPart = queryStart === -1 ? specifier : specifier.slice(0, queryStart);
  const suffix = queryStart === -1 ? "" : specifier.slice(queryStart);
  const targetPath = path.resolve(path.dirname(filePath), pathPart);
  const extension = path.extname(pathPart);

  if (extension) {
    if (!(await fileExists(targetPath))) {
      throw new Error(`Compiled server import target does not exist: ${specifier} from ${filePath}`);
    }
    return specifier;
  }

  const javascriptTarget = `${targetPath}.js`;
  if (!(await fileExists(javascriptTarget))) {
    throw new Error(`Compiled server import target does not exist: ${specifier} from ${filePath}`);
  }
  return `${pathPart}.js${suffix}`;
}

export async function rewriteServerFile(filePath) {
  const source = await readFile(filePath, "utf8");
  const matches = [...source.matchAll(relativeImportPattern)];
  let rewritten = source;

  for (const match of matches.reverse()) {
    const [, prefix, quote, specifier] = match;
    const start = match.index + prefix.length + quote.length;
    const end = start + specifier.length;
    const resolvedSpecifier = await resolveRelativeImport(filePath, specifier);
    rewritten = `${rewritten.slice(0, start)}${resolvedSpecifier}${rewritten.slice(end)}`;
  }

  if (rewritten !== source) {
    await writeFile(filePath, rewritten, "utf8");
  }
}

async function rewriteServerTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await rewriteServerTree(filePath);
    } else if (entry.name.endsWith(".js")) {
      await rewriteServerFile(filePath);
    }
  }
}

export async function buildServer() {
  await rm(serverOutputRoot, { recursive: true, force: true });
  await run(process.execPath, [
    path.join(repositoryRoot, "node_modules", "typescript", "bin", "tsc"),
    "-p",
    tsconfigPath
  ]);
  await rewriteServerTree(serverOutputRoot);
}

if (path.resolve(process.argv[1] ?? "") === scriptPath) {
  await buildServer();
}
