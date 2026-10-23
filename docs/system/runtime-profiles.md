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

## Preparing a macOS installation kit

`node scripts/prepare-mac-install.mjs --output /path/to/private-kit --node /absolute/mac/node`
previews an exact package-source kit. Repeat with `--apply --revision REVISION` to
prepare it, or `--verify --output /path/to/private-kit --revision REVISION` to
verify every staged file and mode. The destination must be outside the source;
occupied destinations, links, credentials, generated directories and different
later bytes are refused. `--node` describes the target Mac executable, not an
assertion that the current machine is macOS. Python 3 and Node 20 or later remain
runtime prerequisites for the migration helpers and product respectively.

This is staging, not an installed service. The kit includes no `node_modules`,
Whisper executable, model or credentials. Preparation is read-only by default,
and does not access user project state, install dependencies, alter pairings,
register a project or start any application. Optional `--whisper` and `--model`
absolute paths configure an existing local recognizer and model in the rendered
LaunchAgent; they do not download or validate recognition quality.

After local installation authorization, keep the kit at its final stable private
location. Verify it **before** adding dependencies. Inside its `runtime/`, inspect
the dependency lock and run `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`
only with authorization for dependency downloads (or add `--offline` for an
already populated cache). This downloads the pinned JavaScript dependencies,
not a speech model. `node bin/context-room.mjs doctor --root /path/to/synthetic-project`
and `node bin/context-room.mjs hub status --format json` provide local diagnostics.
The kit verifier intentionally rejects a runtime directory with unlisted files,
including newly installed dependencies; its verification receipt applies to the
prepared source, not to a later expanded `node_modules` tree.

Rendering `--launch-plist --output /path/to/private-kit --revision REVISION --home "$HOME"`
prints an inert definition for `app.contextroom.local`. It runs the exact Node
and CLI paths with `hub --no-local --port 4317` (or the explicit `--port`). It does
not replace global/shared/assistant stores. Its PATH includes the selected Node
folder and standard Homebrew/system locations for local tools. No device network
listener is enabled implicitly. Connected-device startup stays opt-in through
the existing documented device options.

On the Mac, inspect `launchctl print gui/$(id -u)/app.contextroom.local`, existing
Hub processes and `~/Library/LaunchAgents/app.contextroom.local.plist` first.
An occupied plist or running Hub requires explicit local reconciliation, not
replacement. Only after that review, save the definition without overwriting an
existing file, validate it with `plutil -lint`, then bootstrap the exact plist
with `launchctl bootstrap gui/$(id -u) PATH_TO_PLIST`. Stopping it uses an explicit
`launchctl bootout gui/$(id -u)/app.contextroom.local`; do not remove user data.
Service installation/activation, local dependency availability and reboot
behavior have not been tested by kit preparation. Use a synthetic account/project
for the first local verification. No older service is stopped automatically by
this installation procedure; legacy retirement is the separate migration action.

## Backup and restore

`context-room backup --output DIR` copies the user data of one Context Room installation into a new private folder (mode 0700): `manifest.json` plus content-addressed files in `objects/<sha256>`. `--plan` shows the counts and writes nothing. `--only registry,review,conversations,recordings,notebooks` limits the sections. The folder must not exist and must not sit inside a source home.

Included: the project registry, the review authority (`authority.key` and signed receipts), assistant conversations, recordings, and the notebooks of every registered root (including the free Carnets space). Excluded: paired devices, models, audio jobs, `runtime.json`, locks and temporary files, the Shared home, and ordinary project files.

The review `authority.key` is in the backup. Keep the folder private. To archive it, use `tar czf` on the folder and store it somewhere private. The tablet keystore is not part of this backup.

`context-room restore DIR` shows a preview: each file is `create`, `same`, `conflict` or `blocked`, with a `revision`. Nothing is written. Then run `restore DIR --apply --revision R`. The apply step needs these conditions:

- The Hub is stopped (`launchctl bootout gui/$(id -u)/app.contextroom.local`).
- The revision still matches the current state.
- There are no conflicts, or you pass `--replace` (in the preview and in the apply).

Before it replaces a file, restore saves the existing files in `<parent of the Hub home>/backups/before-restore-<date>` (same format). To undo, run `restore <that folder> --replace` and then `--apply --revision R`. Restore never deletes files that are not in the backup, and it puts written files back if a write fails. The undo folder covers only the files that restore replaces. Files that restore creates stay after an undo. If a file changes after the preview, the restore stops (`restore_stale`) and writes nothing; if it changes during the writes, the file is never overwritten, and the error names the undo folder. Notebook files are restored only for projects in the registry (the current one or the one saved in the backup).

A file that cannot be saved is skipped, not fatal: a link or hard link (for example a project whose `.context-room` is a link), or a file over 256 MiB (a long recording). The report and `manifest.json` (`skipped`) list each one. Back such files up by hand. The backup folder must not sit in the Shared home. A warning appears when it sits in a Git work tree.

Limits: project identity (`rootIdentity`, `authorityId`, `serverId`) depends on the path and on `dev:ino`. After a restore to another disk or path, confirm the projects with the confirmation gesture. Never register them again.
