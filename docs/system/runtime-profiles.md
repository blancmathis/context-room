---
context_room:
  id: system.runtime-profiles
  depends_on: [product.model]
---

# Local runtime

## Summary

The supported runtime is `local`, on macOS. Each contributor runs Context Room on their own computer. Shared collaboration uses Git and does not require a hosted Context Room server.

## Defines

The runtime boundary and treatment of retired hosted entry points.

## Does not define

Git proposal delivery, provider installation, or tablet protocol details.

## Supported capabilities

The loopback server supplies the global Hub, registered projects and worktrees, accepted Shared snapshots, the Explorer, Startup, Health, settings and human review. Filesystem access follows configured paths and exact registered project identity. Proposals are isolated from accepted files until application.

Owner-authenticated routes handle file decisions, corrections, cleanup rules and optional tablet handoffs. Agent CLI commands prepare and submit changes, inspect review status and configure project context. They cannot silently accept or reject documentation.

## Retired profiles

`hosted-hub`, `hosted-review`, `context-room-remote` and the remote-image publishing workflow have been retired. A non-local profile or remote runtime configuration fails before creating project or service state. Legacy state is preserved for recovery; its presence does not enable a hosted runtime.

The old hosted implementation still has internal compatibility helpers during this refactor. They are unreachable as supported server profiles. Their compatibility status is tracked in the repository dossier at `docs/lifecycle/changes/active/refactor/index.md`.

## Optional Lisière

Lisière is a separate local companion. Context Room starts and reviews documents without it. A requested drawing handoff uses an isolated workspace and the installed CLI; no Lisière token is placed in a document or sent through the browser. The current protocol can create and read a board, but does not remotely open it on the tablet.

## Verification

`test/local_runtime.test.mjs` checks early rejection and local capabilities. `test/server_security.test.mjs` checks loopback and owner-interface boundaries. These tests do not establish physical tablet behavior.
