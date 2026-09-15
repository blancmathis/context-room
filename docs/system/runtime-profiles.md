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

## Connected drawing devices

The optional native drawing-device listener is part of the local Context Room
process. It has its own restricted TLS routes and does not enable a hosted
profile or expose the loopback owner API. See [connected devices](connected-devices.md)
for activation, pairing and the current implementation boundary.

## Native drawing and optional local voice

Context Room's PNG review, editable notebook and connected-device drawing paths
use the native notebook engine. The compatibility route names `/api/lisiere/*`
are retained for existing clients, but no separate companion executable or
service is invoked. Original transfer sessions require explicit migration,
not automatic continuation of old tasks. Recovery coverage and its remaining
queue-reconciliation boundary are owned by
[Lisière migration](lisiere-migration.md).

Voice remains a separate optional local dependency, not a requirement for Hub,
review, notebooks or the CLI. `doctor` reports missing local audio prerequisites
without installing software, downloading a model, starting Codex or changing
review health decisions. The runtime no longer treats a model filename alone
as configured transcription: an executable Whisper CLI and a readable, nonempty
regular model file must both be present. This is readiness to attempt recognition,
not proof of model compatibility or acoustic quality.

Set `CONTEXT_ROOM_WHISPER_BIN` to an installed local `whisper-cli` executable
(or make it available on an absolute PATH entry). Set
`CONTEXT_ROOM_WHISPER_MODEL` to the chosen compatible local model. The unchanged
default model location is
`$CONTEXT_ROOM_ASSISTANT_HOME/models/ggml-large-v3-turbo-q5_0.bin`, under
`~/.context-room/assistant` when that home is not set. Speech synthesis uses the
local macOS speech executable; other platforms report that dependency unavailable
rather than silently falling back to a paid API. These diagnostics do not perform
installation or verify an actual microphone, speaker or recognition result.

## Verification

`test/local_runtime.test.mjs` checks early rejection and local capabilities. `test/server_security.test.mjs` checks loopback and owner-interface boundaries. These tests do not establish physical tablet behavior.

## Enrolled migration writer

An explicit legacy cutover enrolls the chosen project in a revisioned writer
authority. Transition and rollback-pause reject document, notebook, proposal and
owner HTTP mutations; readback and safety actions such as stopping an agent or
revoking a device remain available. `doctor` reports this state read-only and
never restarts either runtime. See [cutover and safe rollback](lisiere-migration.md#explicit-single-writer-cutover).
