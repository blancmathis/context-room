---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent CLI
  last_verified: 2026-08-03
  sources: [bin/context-room.mjs, src/cli_registry.mjs, src/cli_contract.mjs, src/agent_cli.mjs, src/context_engine.mjs, src/context_settings.mjs, src/review_authority.mjs, src/shared_context.mjs, test/cli_args.test.mjs, test/cli_registry.test.mjs]
---

# Agent-First CLI

## Purpose

The CLI is Context Room's API for coding agents, voice agents, and management
agents. It is not designed as one flat list of every internal primitive.
Agents load only the profile required for their current responsibility.

The webapp remains the human decision surface. No CLI command accepts, rejects,
or verifies a file review. Agent configuration commands may add or widen review
coverage, but they cannot narrow or remove the last owner-authorized scope.

## Three Root Commands

An ordinary coding agent or voice agent starts with exactly three commands:

```bash
context-room ask "We are changing production rollback for the Atlas deployment service. Find the accepted documents that define the current workflow and ownership, explain the exact sequence and constraints the implementation must preserve, identify contradictions or missing decisions, and return the useful passages in the answer."
context-room edit create "Clarify the production deployment sequence, ownership boundaries, rollback conditions, and verification steps in the accepted documentation." --project atlas
context-room capabilities
```

`ask` launches the read-only documentation researcher against accepted content
only. Its argument is a complete research brief, not a short search query. State
the work being performed, the questions to resolve, the constraints to check,
and the result the working agent needs. `edit` manages the writable worktrees of
shared documentation proposals. `capabilities` returns a compact static index
of the two primary actions and six capability sections. An agent requests one
section, then one exact command contract only when needed. It never interprets
a goal, selects a command, or routes an action.

`edit` has three explicit actions:

```bash
context-room edit create "Clarify the production deployment sequence, ownership boundaries, rollback conditions, and verification steps in the accepted documentation." --project atlas --format json
context-room edit list --format json
context-room edit open proposal/atlas/20260730-clarify-deployment --format json
```

`create` requires the complete proposal description and derives a concise title
unless `--title` is supplied. Without a project selector, `list` returns every
open local or remote proposal for the project containing the current directory.
`open` requires an exact branch, finds its registered shared context without a
project selector, and creates or restores its local worktree. If the same exact
branch exists in several shared contexts, Context Room returns the candidates
instead of guessing. The agent edits only the returned worktree. Context Room keeps every file
decision in the human review interface. There is no agent-facing `publish`,
`accept`, `reject`, or `verify` command.

## Advanced Capabilities

Capabilities use progressive disclosure. The first call returns only six
sections: documentation, context, review, shared, workspace, and configuration.
The agent opens only the section relevant to its task, then requests the exact
contract of one command when necessary:

```bash
context-room capabilities
context-room capabilities --include review
context-room capabilities "watch set"
```

Each section has one owner:

- documentation: deterministic document search and inspection;
- context: effective context, explanation, impact, snapshots, and diffs;
- review: watch rules, annotations, reviews, and proposal impact;
- shared: shared connections, synchronization, skills, and instructions;
- workspace: registered projects, worktrees, Hub state, and UI navigation;
- configuration: Settings, Doctor, and local hooks.

`capabilities --include docs` remains available as a namespace compatibility
query. `--profile` also remains executable for existing integrations, but
sections are the canonical discovery surface.

Compatibility commands remain executable during migration but are absent from
normal help, canonical namespace help, default capabilities, and completions.
`agent help` and `agent instructions` are removed. `context graph` and `guard`
are internal.

## Machine Output

The compact v2 contract is opt-in during the compatibility window:

```bash
context-room capabilities --contract v2 --format json
context-room context effective --contract v2 --detail compact --format json
```

Success:

```json
{"schema":"context-room.cli/2","ok":true,"data":{}}
```

Failure:

```json
{"schema":"context-room.cli/2","ok":false,"error":{"code":"ambiguous-target","message":"Several registered locations match.","retryable":true,"candidates":[]}}
```

`compact` is the agent default, `standard` adds essential target and freshness
proof, and `full` is reserved for diagnostics. Expensive expansions are
explicit, for example `context effective --include graph`. Empty arrays,
request IDs, repeated command names, and full graphs are not emitted by
default. Existing v1 output remains available while integrations migrate.
Human and JSON outputs are available for ordinary commands. JSONL is reserved
for the real multi-project stream exposed by
`doctor --all-projects --format jsonl`; it is rejected elsewhere.

## Deterministic Targeting

Every command uses registered identities:

- the current directory wins only when it belongs to a registered location;
- `--project` selects a durable logical project;
- `--location` selects one registered worktree;
- `--folder` selects the exact folder coordinate;
- `--root` remains a location-path alias.

For shared-only documentation with no registered local location, pair
`--repository` with `--shared-project`. The ordinary `--project` option always
means a registered Context Room project in the canonical interface.

Context Room never scans the computer for worktrees. Ambiguous targets return
structured candidates instead of guessing.

## Effect Classes

| Effect | Behavior | Examples |
| --- | --- | --- |
| `none` | Direct read | `ask`, list, show, `doctor` |
| `ephemeral` | Direct UI navigation, no project truth change | `ui open` |
| `reversible-local` | Direct and idempotent local change; optional `--dry-run` where useful | note, register, add or widen watch |
| `proposal-only` | Creates proposal-owned state, never accepted truth | `edit`, `shared assign` |
| `protected` | Exact plan, then the same command with `--apply <plan-id>` | permitted typed settings, unlink, repository security |
| `human-only` | Unavailable in the CLI | accept, reject, verify, narrow or remove review coverage |

There is no canonical boolean `--plan`, no separate `settings apply`, and no
plan for simple UI navigation. A stale protected plan returns `stale-plan`.

Example:

```bash
context-room settings set --set 'allowedPaths=["docs/","runbooks/"]' --project <id>
context-room settings set --apply <plan-id> --project <id>

context-room watch set runbooks/ --mode recursive-live --project <id>
```

`watch set --mode off`, `agent unwatch`, replacing a live rule with a narrower
mode, disabling protected Startup scanners, or removing protected review paths
returns `human-authority-required`. The owner performs an intentional reduction
in the current Settings interface. Direct config edits still fail closed under
the separate [Review authority](review-authority.md) control.

## Accepted Context Boundary

- `ask` receives only human-verified local documentation and the
  accepted shared default branch.
- Targets, historical material, unverified content, and proposals never enter
  its research corpus.
- Shared proposal metadata may appear in administrative diagnostics, but its
  content never becomes effective context before human file review and merge.
- Shared publication refreshes accepted main, rebases safely, validates scope,
  and refuses unresolved conflicts.
- Unmanaged files, links, and skill destinations are never replaced.

## Compatibility

Legacy paths such as `agent prepare`, `agent handoff`, `workspace open`,
`shared propose`, `shared publish`, `project search`, `project recent`, and
`settings plan|apply` remain temporarily executable. Their registry entries
include a machine-readable replacement. New agents should use the three root
commands above.

The exhaustive compatibility and internal inventory is available only for
diagnostics:

```bash
context-room capabilities --expand --detail full
```

Ordinary agents should not load this inventory. Run `context-room capabilities`
and open one section instead.
