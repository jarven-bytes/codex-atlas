# Release checklist

## First public repository

The original development checkout contains personal records and historical notes.
Do not push its history publicly. Run `npm run prepare:github` to create a fresh,
allowlisted source directory under `release/github-source-*`. It excludes Git
history, runtime data, internal planning notes, node_modules, and built artifacts.
The path is also recorded in `release/github-source-latest.txt`.

Review that directory, initialize a new Git repository there, and publish it to
`jarven-bytes/codex-atlas` only after approval. No script creates a remote, commits,
or pushes automatically. New public clones can use their normal Git history.

## Verification

From the prepared source directory:

```bash
npm ci
npm run build:desktop
npm run lint
npm run test:ci
npx playwright install chromium
npm run test:e2e
npm run package:mac
npm run test:desktop
```

Unit/API tests that inspect compiled runtime need `build:desktop` first.
Desktop smoke requires an interactive macOS session. Keep test results private;
screenshots must use the fictional test fixtures.

## Artifacts

The manual GitHub Actions packaging workflow creates separate unsigned ARM64
and x64 DMG artifacts. It does not publish a release. Verify each architecture on
matching hardware before marking it supported. Attach the verified DMG, its
SHA-256 checksum, release notes, installation instructions, and the unsigned-build
notice to a draft GitHub Release.

Version 0.1.0 is a preview. ARM64 is the locally tested target; x64 packaging in CI
does not substitute for an Intel launch test. Enable private vulnerability reporting
in repository settings. Require the Checks workflow before merging.

## Signing

The default package is explicitly unsigned. A notarized public release requires
the owner's Apple Developer signing identity and notarization credentials.
Provide those through the macOS keychain or CI secrets and supply a separate
electron-builder configuration enabling signing and hardened runtime. Never commit
credentials. Verify with `codesign --verify --deep --strict` and `spctl --assess`
before labeling a download signed or notarized.
