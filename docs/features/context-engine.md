---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: effective context resolution, graph, trace, impact, snapshots, and diffs
  last_verified: 2026-07-29
  sources: [src/context_engine.mjs, src/context_inventory.mjs, src/provider_profiles.mjs, src/context_snapshots.mjs, src/context_diagnostics.mjs, src/shared_context.mjs, src/agent_cli.mjs, bin/context-room.mjs]
---

# Context Engine

## Purpose

The Context Engine answers four deterministic questions for one exact project,
registered worktree, folder, and provider:

1. Which context applies here?
2. Why does each resource apply?
3. Which registered targets consume a resource?
4. What changed between two recorded context states?

It resolves context. It does not manage agent tasks, sessions, reasoning,
compaction, or learning, and it does not replace the existing documentation
Research Agent.

## Coordinate And Identity

Every resolution uses a `projectId`, `locationId`, project-relative `folder`,
and `provider`. Locations are registered explicitly; Context Room never scans
the computer for worktrees.

Resource identity is evidence-based:

- a local or device file uses its canonical physical path and content hash;
- an ordinary managed document additionally exposes its stable document ID, direct dependencies, and dependency-review state;
- a shared resource uses its normalized repository, Git path, accepted commit,
  and blob or tree identity;
- a Shared Skill is one canonical resource with one or more local applications
  and destinations;
- two copies in different worktrees remain distinct resources; and
- one physical global file can have several registered consumers.

Context Room never merges resources because their names or contents look
similar. This identity model powers impact analysis without changing how the
Review queue presents files.

## Effective Context

```bash
context-room context effective \
  --project hicharlie \
  --location <location-id> \
  --folder apps/calls \
  --provider codex \
  --format json
```

The result contains ordered instructions, local and shared skills, hooks,
provider configuration, accepted documents, inactive resources, proposal
metadata, related Context Health issues, and freshness. Applications use the
states `active`, `inactive`, `disabled`, `shadowed`, `uncertain`, `blocked`, or
`unverified`.

Only accepted documentation can enter `effective.documents`:

- a shared document must come from the accepted commit on the configured
  default branch;
- a local managed document must be `current` and its present content hash must
  have a human verification; and
- target, proposal, unmanaged, or locally modified unverified content remains
  outside effective documents.

An open proposal can appear by ID, title, head, and status, but its content is
never injected as accepted build context. The existing Research Agent keeps its
ranking logic and consumes the same accepted-versus-unverified boundary.

For a connected shared context, normal effective resolution verifies the
configured remote default-branch head. Failure returns
`shared-freshness-unverified`. `--allow-stale` is a read-only diagnostic escape
hatch: it exposes the last accepted local snapshot with stale freshness and
must not be presented as current.

## Provider Profiles

Context Room ships versioned profiles for Codex, Claude Code, and OpenCode.
Each profile describes recognized instruction files, discovery order,
overrides, skill roots, provider configuration, and hook sources. The profiles
are grounded in the providers' current official documentation:

- [Codex `AGENTS.md`](https://developers.openai.com/codex/guides/agents-md),
  [skills](https://developers.openai.com/codex/skills), and
  [configuration](https://developers.openai.com/codex/config-reference)
- [Claude Code memory](https://docs.anthropic.com/en/docs/claude-code/memory),
  [settings](https://docs.anthropic.com/en/docs/claude-code/settings),
  [hooks](https://docs.anthropic.com/en/docs/claude-code/hooks), and
  [skills](https://docs.anthropic.com/en/docs/claude-code/skills)
- [OpenCode rules](https://opencode.ai/docs/rules/),
  [skills](https://opencode.ai/docs/skills/),
  [configuration](https://opencode.ai/docs/config/), and
  [plugins](https://opencode.ai/docs/plugins/)

Discovery is not proof of activation. When the runtime contract or available
local evidence cannot establish precedence or activation, Context Room reports
the resource as `uncertain` rather than `active`.

Shared Skills, Shared Instructions, Startup environment, Settings, and Health
all consume these same profiles. Shared Instructions expose both
`materializationStatus` and `activationStatus`; only an installed instruction
with proven native or configured activation enters effective context. An
installed arbitrary filename remains visible for diagnosis without being
given to the agent as effective instructions.

The Codex profile uses the official skill destinations `~/.agents/skills` and
`.agents/skills`. Startup discovery, Shared Skills projection, Settings,
effective context, and Health all consume this same profile rather than
maintaining separate destination tables.

## Effective Context, Explain, And Impact

```bash
context-room context effective --project hicharlie --folder apps/calls --provider codex --format json
context-room context explain AGENTS.md --project hicharlie --folder apps/calls --provider codex --format json
context-room context impact ~/.codex/AGENTS.md --provider codex --format json
```

`context effective` returns the accepted resources that apply to the exact
coordinate. Its default response does not include the structural graph. An
expert diagnostic can request it explicitly with `--include graph`; the raw
`context graph` command remains an internal engine primitive.

`context explain` selects one resource and returns the ordered application
chain for its kind. It falls back to a path, review, or proposal explanation
when the selector is not an effective context resource. An ambiguous selector
returns candidates instead of guessing.
Instruction traces follow provider order; Shared Skill traces connect the
collection, assignment, provider, override, destination, and managed link.
Document traces retain accepted-state evidence.

`context impact` reverses those proven applications. It reports registered
projects and worktrees, providers, destinations, review evidence, and Shared
Skill consumers. Folder scope is returned as a subtree rather than as an
invented list of every descendant. It never scans for unregistered consumers.

## Snapshots And Diffs

```bash
context-room context snapshot --project hicharlie --folder apps/calls --provider codex --format json
context-room context diff --from <snapshot-id> --to <snapshot-id> --format json
```

A snapshot is a content-addressed metadata manifest containing the coordinate,
resolver and provider-profile versions, resource IDs and versions,
applications, local Git/config/review watermarks, and accepted shared commits.
It stores no document content, task state, or event history.

Manifests are private (`0600`) and retained for at most 90 days and 1,000
entries. Identical state produces the same snapshot ID. Creating a snapshot for
a shared target requires an online verification of the accepted default-branch
head.

`context diff` reports resources and applications added, removed, or changed;
provider, status, and destination changes; obsolete review evidence; shared
default-branch transitions; changed paths; and paths applicable to the compared
coordinate. Snapshots for different coordinates return
`snapshot-target-mismatch`. Rewritten shared history returns
`shared-history-diverged` instead of inventing a transition sequence. Existing
stored snapshots can still be compared offline; Git transition detail is then
explicitly unverified.

## Proposal Context Impact

```bash
context-room proposal impact proposal/project/example \
  --repository <shared-id-or-url> \
  --format json
```

This read-only command compares the freshly verified accepted default-branch
commit with the proposal's exact head. It reports changed paths, documents,
instructions, Shared Skill files, registered consumers, Git conflicts,
technical skill collisions, and exact-revision review invalidations.

The current adapter classifies proposal paths conservatively. It does not yet
evaluate semantic contradictions. Its output therefore states
`semanticConflicts: "not-evaluated"`. Review invalidation uses
`mode: "exact-revision"`. A Health delta is populated only when an adapter can
evaluate the existing Doctor issues at both compared revisions; otherwise its
introduced and resolved lists are empty rather than inferred.

## UI And Compatibility

The Explorer folder action **Inspect agent environment** selects a provider and
uses this same engine. Startup environment shows effective, inactive, disabled,
shadowed, uncertain, blocked, and unverified resources, with **Trace** and
**Show impact** actions. Proposal review exposes the same read-only Context
Impact result.

The UI consumes the Context Engine directly rather than routing through a
second compatibility CLI command.
Snapshots and diffs are CLI-first and are not separate UI pages.

## Related Documentation

- [Agent CLI](agent-cli.md): commands, machine output, plan/apply, and human boundaries.
- [Shared context](shared-context.md): accepted Git history and Shared Skills.
- [Startup context](startup-context.md): instruction discovery and review.
- [Startup skills](startup-skills.md): local discovery and managed shared projections.
- [Health, Guard, and Brief](health-guard-and-brief.md): existing Doctor diagnostics.
