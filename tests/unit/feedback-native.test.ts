// @vitest-environment node
import { createRequire } from "node:module";
import { expect, test, vi } from "vitest";
const require = createRequire(import.meta.url);
const { openFeedback } = require("../../electron/feedback.cjs");

test("restricts native browser launches to the two project issue forms", async () => {
  const openExternal = vi.fn().mockResolvedValue(undefined);
  await openFeedback("bug", openExternal);
  await openFeedback("feature", openExternal);
  expect(openExternal.mock.calls).toEqual([
    ["https://github.com/jarven-bytes/codex-atlas/issues/new?template=bug_report.md"],
    ["https://github.com/jarven-bytes/codex-atlas/issues/new?template=feature_request.md"]
  ]);
  await expect(openFeedback("https://example.com", openExternal)).rejects.toThrow("Unknown feedback type");
  expect(openExternal).toHaveBeenCalledTimes(2);
});
