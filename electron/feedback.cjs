"use strict";

const feedbackUrls = {
  bug: "https://github.com/jarven-bytes/codex-atlas/issues/new?template=bug_report.md",
  feature: "https://github.com/jarven-bytes/codex-atlas/issues/new?template=feature_request.md"
};

async function openFeedback(kind, openExternal) {
  if (kind !== "bug" && kind !== "feature") {
    throw new Error("Unknown feedback type.");
  }
  await openExternal(feedbackUrls[kind]);
}

module.exports = { openFeedback };
