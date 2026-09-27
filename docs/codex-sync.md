# Codex Sync

Use the sync CLI only for durable Codex outcomes that should update the local project registry. Exploratory conversation without a durable result should not call the command.

Exact command:

```bash
npm run sync:codex -- --task-id TASK_ID --working-directory /absolute/project/path --summary "Short durable result" --changed-path src/file.ts
```

Optional milestone example:

```bash
npm run sync:codex -- --task-id TASK_ID --working-directory /absolute/project/path --summary "Short durable result" --changed-path src/file.ts --milestone "Task 4 shipped"
```

Optional decision example:

```bash
npm run sync:codex -- --task-id TASK_ID --working-directory /absolute/project/path --summary "Chose the local scanner approach" --decision
```

Optional blocker example:

```bash
npm run sync:codex -- --task-id TASK_ID --working-directory /absolute/project/path --summary "Blocked on connector approval" --blocker
```

The local server accepts the normalized event at the canonical `POST /api/sync` route. `GET /api/sync/reviews` returns persisted uncertain/conflict items with evidence, and `POST /api/sync/scan` runs the configured-root scan used by the dashboard Refresh action. When `ENABLE_WORKSPACE_WATCHER=1` and `WORKSPACE_SCAN_ROOTS` are configured, workspace metadata changes are debounced for 500 ms and processed by that same synchronization service. A source without a confident identity match is retained for review and is never auto-created as a project.

## Local data and verification

The public seed under `resources/seed` is empty. Runtime records under `data/`
are private and ignored. Fictional six-project test fixtures live under
`tests/fixtures/seed`; they are never packaged as a user's projects.

Set `CODEX_PROJECT_DATA_DIR` to an absolute directory to run the complete app and API against an isolated registry, history, import-mapping, launcher-trust, and sync-review location. The Playwright workflow does this automatically under ignored `test-results/task-10-runtime/` data.

`CODEX_LAUNCHER_LOG_PATH` is a test-only launcher seam. When explicitly set, validated URL, folder, document, and task opens are appended as JSONL command arrays instead of opening a local application. Do not set it for normal use.

## macOS desktop data boundary

The packaged Electron app stores its writable registry and related local state at `~/Library/Application Support/Codex Atlas/data`. Its first launch creates an empty registry; later launches preserve an existing registry. Quit the app before backing up, restoring, or resetting that directory. The full workflow, including recoverable `ditto` commands and unsigned-app Gatekeeper handling, is documented in [macOS Desktop Workflow](macos-desktop-app.md).

Imports remain local and user initiated. The import center previews and commits supported folders, Markdown, `package.json`, JSON, and CSV sources into the selected data directory; it does not upload source files or turn exploratory conversation into sync activity.

Future scheduled automation, cloud sync, remote connectors, and unattended registry changes are outside the current sync contract. Any future automation must keep the existing explicit durable-outcome boundary and add its own review and approval design.
