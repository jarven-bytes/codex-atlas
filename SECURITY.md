# Security

## Supported versions

Security fixes target the latest release and the default branch.

## Reporting

Use the repository's **Security > Report a vulnerability** feature after the
maintainer enables private vulnerability reporting. If that option is unavailable,
open an issue requesting a private contact without exploit details, credentials,
local paths, or project data. Do not post sensitive reports in public issues.

## Local trust model

The desktop renderer is sandboxed with context isolation and no Node integration.
The application server binds to loopback. It is not intended to be exposed to a
network or used as a multi-user service. Local data is stored as plaintext on your
Mac and inherits your account's filesystem protection.

Launching a project can run local software. Imported commands require explicit
trust. Accepting a suggestion can open Codex in Terminal with project context;
review the resulting changes before using them. Skills usage is inferred from
explicit project-file evidence, not private conversation history.

Unsigned downloads have no notarized publisher identity. Only run a release from
a source you trust. Signing credentials must stay in CI secrets or the macOS keychain.
