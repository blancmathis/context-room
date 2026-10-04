---
context_room:
  id: system.shared.resource-materialization
  depends_on:
    - product.shared-context
    - system.runtime-profiles
---

# Shared Resource Materialization

## Summary

Accepted Shared skills, legacy instruction mappings, and metadata profiles are read from one immutable accepted repository revision and projected through Context Room-owned local destinations without overwriting unmanaged content.

## Defines

This document defines accepted resource inputs, provider destinations, managed ownership, local overrides, conflicts, and transactional reconciliation.

## Does not define

This document does not define proposal review, individual provider behavior beyond its versioned profile, or the Settings layout.

## Accepted inputs

A Shared repository can define:

- skill collections;
- skill assignments;
- legacy instruction collections and assignments, preserved for compatibility;
- metadata profiles;
- project and global resource scopes.

Only accepted main is eligible for materialization. An open proposal remains pending and does not alter effective resources.

## Immutable revision rule

One reconciliation run resolves every referenced manifest and resource from the same accepted revision. It does not mix accepted files from different revisions or read a proposal overlay.

The resulting local receipt records the accepted revision used.

## Provider profiles

A versioned provider profile defines native discovery locations, ordering, and evidence for Codex, Claude Code, and OpenCode.

Each profile states how it was checked and up to which provider version. The Claude Code profile is checked against Claude Code 2.1.289.

Context Room does not infer provider activation from a destination name alone.

Claude Code rules:

- It reads `CLAUDE.md`, `.claude/CLAUDE.md`, `CLAUDE.local.md`, and `.claude/rules/**/*.md` in the folder chain. A rule with `paths` frontmatter loads only when matching files are read, so it stays uncertain.
- From 2.1.277, it also reads `AGENTS.md` and `.claude/AGENTS.md` when no `CLAUDE.md`-family file exists in the folder or above. `pluginConfigs["agents-md@builtin"].options.instructionFiles` changes this: `claude-md`, `claude-md-or-agents-md` (default), `claude-md-and-agents-md`, or `managed-only`.
- An unknown Claude Code version or unreadable settings make `AGENTS.md` uncertain, never active.

Hook output (`SessionStart`, `UserPromptSubmit`) and MCP tool definitions reach the agent at runtime. Context Room lists them as unknown context and does not guess their size.

`context effective` and the agent environment also list `losses`: context an agent drops or receives twice. The checks are deterministic (`src/context_losses.mjs`) and each cites its rule, file, and evidence:

- `instruction_limit`: Codex joins project `AGENTS.md` files up to `project_doc_max_bytes` (32 KiB by default, read from `~/.codex/config.toml` and the project's `.codex/config.toml`) and drops the rest. Reported when exceeded, and from 80 %.
- `duplicate_context`: two active instructions or skills with the same content.
- `dead_path`: a cited path with a folder that exists nowhere (file folder, project, home). Global instructions are checked only for their `~/` paths. A cited path that exists is not a finding.
- `missing_command`: an `npm`, `pnpm`, `yarn`, or `bun` script cited in a project instruction is absent from `package.json`.
- `skill_description`: a skill without a description, or one over the 1,024 characters of the Agent Skills specification. No provider truncation limit is claimed.

They also carry `cost`: what the agent sees, in three parts (`src/context_cost.mjs`):

- **At startup**: active instructions (whole file) and each skill's name and description. Claude Code `@path` imports are not counted, and the row says so.
- **On demand**: skill bodies (read when the skill is used) and accepted documents.
- **Unknown**: hook output, MCP tools, and Claude Code auto memory. Shown as `—`, never guessed.

Tokens are estimates: characters ÷ 4, no tokenizer. An unreadable file counts as not measured, never as zero. Gauges compare against hard limits only: the Codex project instruction bytes, and skill descriptions from 80 % of 1,024 characters. The project Context view has an Agent choice (Codex, Claude Code, OpenCode); the browser remembers it.

Each local instruction, skill and hook has an origin, from its install location only: **Your files** (inside the project or an agent settings folder such as `~/.codex` or `~/.claude`), **Provided by the agent** (a folder the agent manages, such as `~/.codex/skills/.system`), or **Origin not confirmed** (a plugin, or anywhere else). Files provided by the agent are folded at the end of their group and stay counted. The origin changes no configuration, watch rule or decision.

A resource can therefore be:

- accepted but not installed;
- installed but not proven active;
- active;
- provider-disabled;
- locally overridden;
- conflicted;
- stale;
- recovery-required.

## Managed destinations

Context Room records every link or projected file it owns.

Reconciliation may create, update, migrate, or remove only entries proven to be managed by Context Room. An existing unmanaged file, directory, instruction, or skill at a destination is preserved and reported as a conflict.

Context Room never adopts or deletes unmanaged content implicitly.

## Skills

A skill collection contains reviewed accepted skill directories with valid entry points. Assignments select collections and individual skills for declared projects. New repositories start with explicit empty assignments, so no skill is exposed globally by default. Native providers may be omitted: the CLI remains usable by any harness. Existing legacy manifests retain their original broader scope until explicitly changed.

Editing canonical Shared skill content requires a `skills` proposal.

## Legacy instruction mappings

An instruction collection contains reviewed accepted Markdown sources. An assignment declares the exact source, provider set, scope, and target path.

A managed instruction can be installed without being active when the provider does not natively discover its target and no explicit provider configuration proves discovery.

The separate instructions category has been removed from Settings. Existing source files, links and pending proposals are preserved. Legacy compatibility commands remain available to inspect, reconcile or finish this state; ordinary document proposals are the forward path.

## Scopes

- `project`: declared project IDs and their exact registered locations;
- `shared`: registered local locations connected to the selected Shared repository;
- `device`: one provider destination on the device.

Local provider preferences, local destination overrides, and local assignment exclusions are private state. They do not rewrite accepted Shared intent.

## Connection reconciliation

Connecting a logical project:

1. resolves the exact accepted revision;
2. validates manifests, sources, and provider profiles;
3. previews destination changes and conflicts;
4. captures affected configuration, registries, and managed paths;
5. applies managed changes;
6. records the binding and resource receipts.

Disconnecting removes only managed projections and binding state. It preserves unmanaged content, accepted Shared history, and proposals.

## Failure and rollback

A reconciliation failure restores captured state where safe. If filesystem state is ambiguous, Context Room preserves recovery evidence, reports `recovery-required`, and blocks unsafe follow-up mutation.

## Shared consumers

The Context Engine, Startup environment, Settings, Health, and deterministic documentation CLI must consume the same accepted resource projection and distinguish accepted, installed, active, inactive, conflicted, stale, and pending proposal states.
