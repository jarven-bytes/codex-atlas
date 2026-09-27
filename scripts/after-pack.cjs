"use strict";

const fs = require("node:fs");
const path = require("node:path");

function makeResourceFilesReadOnly(resourcesDir) {
  for (const entry of fs.readdirSync(resourcesDir, { withFileTypes: true })) {
    const entryPath = path.join(resourcesDir, entry.name);
    if (entry.isDirectory()) {
      makeResourceFilesReadOnly(entryPath);
      continue;
    }
    if (entry.isFile()) {
      const mode = fs.statSync(entryPath).mode & 0o7777;
      fs.chmodSync(entryPath, mode & ~0o222);
    }
  }
}

async function afterPack(context) {
  if (context.electronPlatformName !== "darwin") {
    return;
  }

  const appBundlePath = context.appOutDir.endsWith(".app")
    ? context.appOutDir
    : path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const resourcesDir = path.join(appBundlePath, "Contents", "Resources");
  if (!fs.existsSync(resourcesDir)) {
    throw new Error(`Packaged macOS resources directory is missing: ${resourcesDir}`);
  }

  makeResourceFilesReadOnly(resourcesDir);
}

module.exports = { afterPack, makeResourceFilesReadOnly };
