---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent CLI
  last_verified: 2026-07-28
  sources: [bin/context-room.mjs, src/cli_registry.mjs, src/cli_contract.mjs, src/agent_cli.mjs, src/event_journal.mjs, src/context_engine.mjs, src/context_snapshots.mjs, src/context_settings.mjs, src/context_diagnostics.mjs, src/shared_context.mjs, schemas/cli-envelope.schema.json, schemas/cli-event.schema.json, schemas/agent-prepare.schema.json]
---

# Agent-First CLI

## Purpose

The CLI is Context Room's local API for AI agents. Codex, Claude Code,
OpenCode, and voice agents consume the same stable machine contract. Human
interaction belongs in the webapp; human-readable CLI rendering exists only
for debugging and compatibility.

The CLI resolves only registered projects and worktrees, never calls a model
implicitly, and never accepts, rejects, or verifies a file review.

Browser control targets an active **Workspace**, not a project-local server:

```bash
context-room workspace list
context-room workspace open --project hicharlie
context-room workspace open --project hicharlie --file apps/calls/AGENTS.md
context-room agent state --workspace <workspace-id>
context-room agent open --workspace <workspace-id> --path apps/calls/AGENTS.md
```

Without `--workspace`, browser-control commands select automatically only when
one active Workspace matches the requested project or worktree. Multiple
matches return `workspace-ambiguous` with candidates; the CLI never guesses
from recency. The Workspace registry contains navigation metadata only, never
document content or drafts.

The default agent entry point is:

```text
context ask -> inspect cited evidence -> work
```

Only a human accepts or rejects each file awaiting review. A shared proposal is
a Git delivery group around those file decisions; there is no separate
agent-facing proposal acceptance command.

## Discover The Installed Contract

```bash
context-room capabilities
context-room completion zsh
context-room completion bash
context-room completion fish
```

The command registry owns paths, arguments, scopes, formats, mutation
status, plan/apply protocol, schemas, handlers, freshness requirements,
expected cost, authority, and compatibility status.
Capabilities, help, completion, and dispatch parity are checked against that
registry.

`capabilities` exposes the installed contract as a static inventory. It never
interprets natural language, ranks commands, or selects an operation for the
agent.

Agent-first commands support `--format human|json|jsonl`, `--quiet`,
`--verbose`, `--no-color`, and `--non-interactive`. Omitting `--format` uses
JSON for the machine contract. JSON uses the
`context-room.cli/1` envelope. Results use stdout; diagnostics use stderr.
Structured errors include a code, message, retryability, details, and available
correction commands.

Agents can reduce output without inventing command-specific filters:

```bash
context-room context effective --fields target,instructions,health --summary
context-room context effective --summary --expand instructions,skills
```

`--fields` selects exact data paths. `--summary` replaces unexpanded arrays with
counts and deeply nested objects with structural summaries. `--expand` preserves
the named paths while summary mode remains active.

## Resolve A Target

```bash
context-room project current --format json
context-room project list --cursor <cursor> --limit 25 --query hicharlie --format json
context-room project register --root . --format json
context-room project register --root . --apply <plan-id> --format json
context-room project open --project <id> --location <id> --format json
```

The current working directory wins when it belongs to a registered location.
`--project` selects the durable project, `--location` selects one registered
worktree, `--folder` selects the exact environment folder, and `--root` remains
a location-path alias. An ambiguous target returns candidates instead of
guessing. Context Room never discovers worktrees by scanning the disk.

Bulk list commands use `--cursor`, `--limit`, and `--query`. The default page is
25 entries and the maximum is 100 unless a command documents a narrower limit.

## Prepare And Inspect Context

```bash
context-room agent prepare --task "Clarify onboarding" --provider codex --format json
context-room context effective --project <id> --location <id> --folder apps/calls --provider codex --format json
context-room context graph --project <id> --folder apps/calls --provider codex --format json
context-room context trace AGENTS.md --project <id> --folder apps/calls --provider codex --format json
context-room context impact ~/.codex/AGENTS.md --provider codex --format json
```

`agent prepare` combines the resolved target, accepted task-relevant
documentation, effective startup environment, review and proposal summaries,
Context Health, freshness, and next actions. Pending proposals remain separate
from accepted documentation.

For the canonical accepted boundary, statuses, trace, impact, and freshness rules, see
[Context Engine](context-engine.md).

Use `context-room context ask "question"` only for a deeper documentation-only
Research Agent pass. The deterministic context commands do not invoke it.

## Snapshot And Compare Context

```bash
context-room context snapshot --project <id> --location <id> --folder apps/calls --provider codex --format json
context-room context diff --from <snapshot-id> --to <snapshot-id> --format json
```

Snapshots are private, metadata-only, and content-addressed. Shared snapshots
require a freshly verified accepted default-branch head. A diff never mutates
the project or emits an event.

## Classify And Hand Off Changes

```bash
context-room agent changes --session <task-id> --format json
context-room agent handoff --task "Clarify onboarding" --session <task-id> --format json
context-room agent handoff --task "Clarify onboarding" --session <task-id> --apply <plan-id> --format json
```

`agent changes` classifies local reviews, shared project, global, and skills
proposals, unmanaged documents, and non-documentation files. `agent handoff`
previews first. Apply uses the exact plan ID, publishes shared work through a
proposal, leaves local documents in their file review queue, and returns an
idempotent receipt. Changed inputs return `stale-plan`.

Handoff never writes shared accepted content directly. Publication refreshes
and rebases against the accepted default branch; a conflict remains open and
blocks publication.

## Reviews

```bash
context-room review list --reason changed --severity high --cursor <cursor> --limit 25 --format json
context-room review show docs/guide.md --format json
context-room review diff docs/guide.md --format json
context-room review open docs/guide.md --format json
context-room review annotate docs/guide.md --note "Check this term" --format json
context-room review annotate docs/guide.md --note "Check this term" --apply <plan-id> --format json
```

Review commands inspect, open, or annotate; none changes the human decision.
The application may keep an internal metadata-only event journal for UI
synchronization, but it is not part of the agent CLI contract.

## Proposal Impact

```bash
context-room proposal context-impact proposal/project/example \
  --repository <shared-id-or-url> \
  --format json
```

This command is read-only and requires the repository to prevent ambiguous
branch selection. Its current limitations are explicit: semantic conflicts are
not evaluated, review invalidation is exact-revision based, and a Health delta
appears only when revision-specific Doctor evidence is available. See
[Context Engine](context-engine.md#proposal-context-impact).

## Shared Skills

```bash
context-room shared skills status --root .
context-room shared skills effective --provider codex --format json
context-room shared skills explain <selector> --format json
context-room shared skills assign --collection team --scope project --projects p1,p2 --providers codex,claude-code --format json
context-room shared skills assign --collection team --scope project --projects-file projects.json --providers codex --apply <plan-id> --format json
context-room shared skills reconcile --provider codex --format json
context-room shared skills reconcile --provider codex --apply <plan-id> --format json
```

`assign`, `unassign`, `import`, `link`, `unlink`, `override`, and `reconcile`
all return a plan when called without `--apply`. Apply requires that exact plan
ID. A stale plan is refused, and provider-targeted reconciliation changes only
destinations present in the plan.

`--projects` accepts comma-separated project IDs. `--projects-file` accepts a
newline-separated ID list or a JSON array. Logical assignment changes create a
`skills` proposal; local destinations, provider state, assignment disablement,
and individual skill exclusions remain local.

## Shared Instructions

```bash
context-room shared instructions status --root . --format json
context-room shared instructions import --collection team --collection-path instructions/team --files mappings.json --format json
context-room shared instructions import --collection team --collection-path instructions/team --files mappings.json --apply <plan-id> --format json
context-room shared instructions assign --collection team --scope project --projects p1,p2 --files mappings.json --format json
context-room shared instructions unassign --assignment team-project --format json
context-room shared instructions reconcile --format json
```

The JSON mappings select the exact Markdown source, target, and providers;
imports additionally name each `localPath`. Assignment, unassignment, and
import create `instructions` proposals. Reconcile is local and installs only
managed links to accepted main. Every mutation uses preview then exact
`--apply`; no command can replace an unmanaged instruction file or share a
hook.

## Context Settings

```bash
context-room settings get [key] --project <id> --format json
context-room settings explain startupSkills.projectOnly --format json
context-room settings plan --set 'startupSkills.projectOnly=true' --project <id> --format json
context-room settings apply <plan-id> --format json
```

The typed Settings CLI covers context boundaries, watched-document scope,
startup discovery, Shared Skills provider and local overrides, and Hub
organization. It does not expose arbitrary JSON mutation. Appearance, sounds,
shortcuts, Codex prompts, templates, document or hook content, owner Git gates,
and review decisions are excluded. Shared collections and assignments still
change through `shared skills` proposals.

Apply checks the exact stored revision. Concurrent changes return `stale-plan`
instead of overwriting newer settings.

## Doctor

```bash
context-room doctor --project <id> --location <id> --folder apps/calls --provider codex --format json
context-room doctor --all-projects --only actionable --cursor <cursor> --limit 25 --format json
context-room doctor explain <issue-key> --project <id> --format json
context-room doctor plan <issue-key> --project <id> --format json
```

Doctor filters structured issue fields rather than parsing messages. Explain is
read-only. Plan returns a deterministic repair only when an exact safe
primitive exists; otherwise it returns `repairable: false` with the manual
action. Doctor never plans a wider `allowedPaths`, removal of a watch rule,
documentation rewrite, unknown hook change, or review decision.

## Compatibility And Schemas

Older project, Hub, proposal, watch, guard, and maintenance
commands remain installed. Existing legacy default outputs and `--json` remain
compatible where the registry declares them.

Machine schemas:

- [`cli-envelope.schema.json`](../../schemas/cli-envelope.schema.json)
- [`cli-event.schema.json`](../../schemas/cli-event.schema.json)
- [`agent-prepare.schema.json`](../../schemas/agent-prepare.schema.json)

Run `context-room capabilities` for the exact canonical contract installed
on the current device.
