---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: agent CLI
  last_verified: 2026-08-09
  sources: [bin/context-room.mjs, bin/context-room-remote.mjs, src/cli_registry.mjs, src/cli_contract.mjs, src/agent_cli.mjs, src/context_engine.mjs, src/context_settings.mjs, src/review_authority.mjs, src/shared_context.mjs, src/context_room.mjs, test/cli_args.test.mjs, test/cli_registry.test.mjs, test/cli_contract_regressions.test.mjs, test/bin_context_room_shared_cli.test.mjs, test/remote_ui_control.test.mjs]
---

# Agent-First CLI

## Purpose

The CLI is Context Room's API for coding agents, voice agents, and management
agents. It is not designed as one flat list of every internal primitive.
Agents load only the profile required for their current responsibility.

The webapp remains the human decision surface. No CLI command accepts, rejects,
or verifies a file review. Agent configuration commands may add or widen review
coverage, but they cannot narrow or remove the last owner-authorized scope.
Every capabilities response includes `humanDecisionPolicy`. Before an agent
attempts a decision through the human surface, it must ask the user explicitly;
after the first yes it restates the exact action, project, proposal or file
scope, and effects, asks again, and does nothing without a second separate,
unambiguous yes.

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
context-room edit open proposal/atlas/20260730-clarify-deployment --repository <candidate-repository> --shared-project atlas --format json
```

`create` requires the complete proposal description and derives a concise title
unless `--title` is supplied. Without a project selector, `list` returns every
open local or remote proposal for the project containing the current directory.
`open` requires an exact branch and creates or restores its local worktree,
including for a Hub-only Shared Context with no local project binding. Without
`--repository`, discovery deduplicates supported repository aliases and fails
closed unless every registered Shared Context can be freshly checked within one
network budget. An unavailable repository returns
`proposal-discovery-incomplete`; several exact matches return
`proposal-ambiguous`. Each ambiguity candidate includes an exact `repository`
value that can be passed back to `--repository`; `--shared-project` optionally
narrows the branch to one project. An explicit repository bounds discovery to
that Shared Context.

The agent edits only the returned worktree, then publishes it with the returned
change handle:

```bash
context-room docs publish --change <change-id> --summary "Clarify deployment" --description "Fresh cumulative recap of the complete proposal." --format json
```

Updating an already-published proposal requires a fresh cumulative description.
Publication refreshes Shared state, rejects a moved or terminal proposal before
mutating the worktree, and uses a bounded Git push. Context Room keeps every
file decision in the human review interface; there is no agent-facing `accept`,
`reject`, or `verify` command.

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

Project selection is hierarchical rather than a union of names: exact
registered ID, exact project key, exact worktree ID, exact logical-project ID,
then a case-insensitive shared-project or title alias. The first matching tier
wins, so a friendly alias cannot shadow an exact machine identity. More than
one logical project in the same tier returns `ambiguous-target` with structured
candidates instead of using the current directory to guess.

Proposal selection first applies an explicit repository and project scope,
then prefers exact proposal ID and exact branch before considering a head or
title alias for compatible read and navigation commands. An explicit
repository matches only a proposal carrying that canonical repository, and a
normal project selector does not silently include the separate `global`,
`skills`, or `instructions` scopes. Several matches return
`proposal-ambiguous`; commands whose contract requires an exact branch or head
do not downgrade to a friendly alias.

For shared-only documentation or startup context with no registered local
location, pair `--repository` with `--shared-project`. `context bundle` accepts
that pair and is the compatible replacement for `agent prepare` with the same
Shared-only target. `edit open` is the deliberate exception: `--repository`
alone can select a unique exact branch, while `--shared-project` may further
disambiguate it. The ordinary `--project` option always means a registered
Context Room project in the canonical interface.

Context Room never scans the computer for worktrees. Ambiguous targets return
structured candidates instead of guessing.

Workspace navigation has its own deterministic target order:

1. `--workspace` selects that exact tab;
2. `--session` selects the page paired to that task or chat;
3. the current `CODEX_THREAD_ID` is used when available;
4. the only compatible page may be used;
5. otherwise the command returns `workspace_ambiguous` and candidates.

`--recent` is the explicit opt-in to choose the most recently focused
compatible page. `ui list [--project] [--session] [--all]` returns structured
Workspace metadata, including the short ID, project, view, proposal, file,
focus, label, and pairing state. `ui open` accepts the same selectors plus
`--project`, `--proposal`, `--file`, `--view`, `--settings`, `--search`,
`--filter`, `--heading`, `--text`, and `--percent`.

For a generic remote installation, set `CONTEXT_ROOM_REMOTE_URL` and provide a
short-lived bearer token in `CONTEXT_ROOM_REMOTE_TOKEN`. Remote navigation uses
`GET /api/agent/ui/workspaces` and `POST /api/agent/ui/open`. If a page must be
opened, the result is `open_required` with a secure URL; the caller decides
which browser or chat opens it. The scoped UI bearer can be reused for list and
open requests until its expiration; the URL pairing ticket remains one-use.

The Hosted Shared-only profile deliberately narrows this navigation contract.
It accepts only Home, Hub, or one exact configured proposal. File, diff, Graph,
Settings, folder, search, filter, target, highlight, and Codex prompt navigation
are rejected with `agent_navigation_scope_denied` instead of being translated
to a local server surface. Local worktree locations are absent from Hosted
Workspace discovery and cannot select or expose a server-side checkout.

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
