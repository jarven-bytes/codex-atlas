import { defineConfig } from "playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: /desktop-smoke\.spec\.ts/u,
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "test-results/playwright-desktop",
  use: {
    trace: "retain-on-failure"
  }
});
