import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputRoot = path.join(root, "release");
await mkdir(outputRoot, { recursive: true });
const destination = await mkdtemp(path.join(outputRoot, "github-source-"));
// Export current source, never the original Git history or personal runtime data.
const entries = [
  ".github", ".gitignore", ".nvmrc", "README.md", "LICENSE", "CONTRIBUTING.md",
  "SECURITY.md", "CODE_OF_CONDUCT.md", "CHANGELOG.md", "bin", "build", "electron",
  "resources", "scripts", "src", "tests", "package.json", "package-lock.json",
  "electron-builder.yml", "index.html", "playwright.config.ts",
  "playwright.desktop.config.ts", "tsconfig.json", "tsconfig.server.json", "vite.config.ts"
];
for (const entry of entries) {
  await cp(path.join(root, entry), path.join(destination, entry), {
    recursive: true,
    filter: (source) => !source.endsWith(".DS_Store")
  });
}
await mkdir(path.join(destination, "docs"), { recursive: true });
for (const entry of ["macos-desktop-app.md", "codex-sync.md", "release.md", "images"]) {
  await cp(path.join(root, "docs", entry), path.join(destination, "docs", entry), { recursive: true });
}
async function check(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Unexpected symlink: ${file}`);
    if (entry.isDirectory()) {
      await check(file);
    } else if (/\.(?:md|json|ts|tsx|js|cjs|mjs|yml|css|html)$/u.test(entry.name)) {
      const contents = await readFile(file, "utf8");
      const privateHome = path.join("/Users", "jw") + "/";
      if (contents.includes(privateHome)) throw new Error(`Personal path found: ${file}`);
    }
  }
}
await check(destination);
await writeFile(path.join(outputRoot, "github-source-latest.txt"), destination + "\n");
console.log(`Public source prepared at ${destination}`);
