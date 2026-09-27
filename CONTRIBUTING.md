# Contributing

Codex Atlas is a macOS desktop app. Keep changes light, useful, and needed.

Use Node 22 (at least 22.12) and npm. Run `npm ci`, `npm run build:desktop`, `npm run lint`,
`npm run test:ci`, and `npm run build:desktop` before opening a pull request.
For renderer changes, also install Chromium with `npx playwright install chromium`
and run `npm run test:e2e`. Desktop packaging needs macOS.

Describe the user-visible problem, the change, and how you tested it. Include a
screenshot for layout changes, using example records instead of personal data.
Keep status values limited to Plan, Need, and Insufficient. Sync and stale states
are attention flags. Imported commands require trust before execution.

Use fixtures under `tests/fixtures`; tests must not depend on files in a
contributor's home directory. Never commit project registries, credentials,
launch trust, local history, or generated builds. See SECURITY.md for private reports.
