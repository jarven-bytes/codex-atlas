import path from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

const originalDataDir = process.env.CODEX_PROJECT_DATA_DIR;

afterEach(() => {
  if (originalDataDir === undefined) {
    delete process.env.CODEX_PROJECT_DATA_DIR;
  } else {
    process.env.CODEX_PROJECT_DATA_DIR = originalDataDir;
  }
  vi.resetModules();
});

describe("server configuration", () => {
  test("keeps registry, history, mappings, and launcher state inside the configured data directory", async () => {
    const isolatedDataDir = path.resolve("/tmp/codex-project-e2e-data");
    process.env.CODEX_PROJECT_DATA_DIR = isolatedDataDir;
    vi.resetModules();

    const { serverConfig } = await import("../../src/server/config");

    expect(serverConfig.dataDir).toBe(isolatedDataDir);
    expect(serverConfig.historyDir).toBe(path.join(isolatedDataDir, "history"));
    expect(serverConfig.registryPath).toBe(path.join(isolatedDataDir, "projects.json"));
  });
});
