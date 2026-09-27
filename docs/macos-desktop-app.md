# macOS Desktop Workflow

Codex Atlas is packaged as `Codex Atlas.app`. The app starts the local server itself and opens the dashboard in a native Electron window; Safari, Chrome, a cloud database, or a separately managed server are not required.

## Run locally

From the project checkout:

```bash
npm ci
npm run desktop:dev
```

`desktop:dev` builds the client and compiled server runtime before opening Electron. When `CODEX_PROJECT_DATA_DIR` is set, the desktop entry trims and resolves it before passing it to the server. An unset or blank override uses Electron's `userData/data` directory; packaged apps always use `~/Library/Application Support/Codex Atlas/data` and ignore the override.

To build the macOS artifacts:

```bash
npm run package:mac
```

The `.app` bundle and DMG are written under `release/`. The package includes the compiled server and seed data; the packaged app does not invoke the development `tsx` server command.

## Local data

Packaged app data lives at:

```text
~/Library/Application Support/Codex Atlas/data
```

The writable directory contains the project registry, import mappings, mutation history, sync reviews, and launcher trust state. The app bundle's seed files are read-only resources. On first launch, an empty registry is copied into this Application Support directory. Later launches preserve an existing `projects.json`, including edits made in the dashboard. Use Import to add your projects.

Quit the app before copying or replacing these files.

### Back up and restore

Back up the complete `data` directory so registry history and import mappings travel with the registry:

```bash
ditto "$HOME/Library/Application Support/Codex Atlas/data" "$HOME/Desktop/codex-atlas-data-backup"
```

To restore, move the current directory aside first, then copy the backup into its place:

```bash
mv "$HOME/Library/Application Support/Codex Atlas/data" "$HOME/Library/Application Support/Codex Atlas/data.before-restore"
ditto "$HOME/Desktop/codex-atlas-data-backup" "$HOME/Library/Application Support/Codex Atlas/data"
```

To reset the packaged registry, quit the app and move `data` aside. The next launch creates a fresh directory with an empty registry:

```bash
mv "$HOME/Library/Application Support/Codex Atlas/data" "$HOME/Library/Application Support/Codex Atlas/data.before-reset"
```

Keep the moved directory until the reset has been confirmed. Restore it if the reset was not intended.

## Unsigned local builds

The first local macOS package is unsigned and is intended for local validation. Gatekeeper may report that the app is from an unidentified developer or prevent a normal double-click. In Finder, control-click the `.app`, choose **Open**, and confirm **Open**. macOS may instead expose an **Open Anyway** action in **System Settings > Privacy & Security** after the blocked launch. Only approve a build you created or otherwise trust.

## Imports and future automation

Imports are local, user-invoked operations in the dashboard. The import center can preview and commit:

- standalone structured files in JSON or CSV format;
- local folders that require both `PROJECT_TEMPLATE.md` and `package.json` metadata.

Imported changes are written to the selected data directory and create a registry snapshot for undo; there is no automatic upload.

The current sync boundary is deliberately explicit: use `npm run sync:codex` for a durable Codex outcome, not for exploratory conversation. Workspace watching and local sync review stay inside the app's configured local data directory. Cloud sync, scheduled automation, remote connectors, and unattended mutation approval are future work and are not implied by the macOS package.
