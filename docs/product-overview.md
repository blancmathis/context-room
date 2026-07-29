---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: product overview
  last_verified: 2026-07-28
  sources: [README.md, bin/context-room.mjs, src/context_room.mjs, src/context_engine.mjs, src/context_inventory.mjs, src/context_snapshots.mjs, src/context_settings.mjs, src/context_diagnostics.mjs, src/provider_profiles.mjs, src/codex_prompt_center.mjs, src/context_hub.mjs, src/doc_agent.mjs, src/shared_context.mjs, schemas/config.schema.json, schemas/codex-prompt-catalog-v1.schema.json, schemas/codex-prompt-overrides-v1.schema.json, schemas/codex-prompt-publication-state-v2.schema.json, schemas/codex-prompt-runtime-receipt-v2.schema.json, schemas/doc-context.schema.json, schemas/shared-repository.schema.json, schemas/shared-skill-locations.schema.json, schemas/shared-instruction-locations.schema.json, docs/agent-configuration.md]
---

# Product Overview

## Purpose

Context Room is a local browser UI for keeping project context visible, editable, and reviewable. It is built for repos where humans and agents both depend on docs, skills, runbooks, and startup instructions.

## Product Loop

1. Run `context-room setup` to initialize and register a project, or `context-room hub` to open the computer-wide room without adding the current directory. Both commands use the same global Context Room service.
2. Use the truth-aware hub to find current docs, targets, records, and source areas that matter.
3. Edit safe text files inside `allowedPaths`.
4. Review the current content versions covered by `watchAllow` and folder `watchRules`.
5. Run `doctor` or `guard` for deterministic proof, or `context ask` when a working agent needs a task-specific documentation packet from the detected project or an explicit shared-only project target.
6. Route durable documentation updates through the local review queue or a task-scoped shared proposal; selected large projects may run a scheduled read-only-first audit.
7. Give coding agents a compact `context ask` entry point and reveal specialized capabilities only on demand, while keeping every file decision human-owned.

Projects that need cross-project documentation or skills can add the optional
[Shared context](features/shared-context.md) loop. The accepted configured
default branch is mounted as read-only context. Agents propose changes on
scoped `proposal/*` branches; human decisions apply to the proposal's files,
and completing them finalizes the reviewed result without a separate
agent-facing proposal decision.

## Main Surfaces

- Context Room Home: one compact project-filterable queue that lists local files individually and shared changes by proposal, followed directly by the current project's Context Health, `hubSections`, and startup panels.
- History and project management: secondary routes from the queue and project picker; every selected project and worktree keeps its own identity while remaining inside the single global room.
- Codex Prompt Center: an advanced global tool opened from Settings, with runtime-published official, effective-after-restart, and runtime-loaded views; exact overrides remain private to `$CODEX_HOME`, while protected and server-owned targets stay visible and read-only.
- Explorer and editor: safe project text, with progressive folder loading in the global room, editing limited by `allowedPaths`, and four explicit folder watch modes.
- Document Graph: progressive global, project, and local Canvas views of explicit document references and applicable context, with accepted truth visible by default and pending layers opt-in.
- Documents to review: hash-backed human verification for watched documents, Git diffs when available, implicit project `AGENTS.md` files, and every skill exposed by Startup skills.
- Startup context: project instruction files by default, with ancestor and global discovery available by opt-in.
- Startup skills: project skill folders by default, with ancestor discovery available for existing or explicitly broadened configs.
- Startup hooks: project AI-agent and hook-manager files plus current-repository Git hooks by default.
- Settings: five-category editor—Project, Review and trust, Agent environment, Preferences, and Advanced extensions—with compact revision-safe project loading, live search, explicit scopes, progressive disclosure, one manual Save bar, Shared Skills and Shared Instructions management, and the entry to Codex Prompt Center.
- Project inspection: a compact companion to the Review Queue that keeps the selected worktree identity visible and exposes Context Health and Agent environment; configured Home sections remain the primary project navigation.
- Agent CLI: queue inspection, navigation, annotations, and explicit folder watch configuration for coding agents.
- Context Engine: exact provider-specific context for one registered project,
  worktree, and folder, with graph, trace, impact, metadata-only snapshots,
  diffs, and proposal impact shared by the CLI and UI.
- Documentation research agent: a fresh read-only Codex researcher per request, backed by a deterministic section-level documentation CLI and a schema-constrained evidence packet.
- Documentation lifecycle: shared maintenance and audit skills, task-scoped proposal reuse, and explicit local/shared/mixed write routing.
- Shared context: an optional, generic Git-backed accepted snapshot with documentation, skills, reviewed agent instruction collections, scoped proposal worktrees, and exact-commit human review.

Feature-level docs live in [Features](features/index.md).

## Product Rules

- Keep one global Context Room. `Local` and `Shared` identify documentation
  storage and review workflows, never separate room modes.
- Treat each browser tab or window as an independent Workspace within that
  global room. Workspace state is navigation metadata, not project truth or a
  documentation source.
- Keep the edit surface narrow. Add paths only when Context Room should be allowed to read and write them.
- Treat review as human-owned. Agents can surface the queue, but they should not mark docs verified for the user.
- Let owners rank logical projects device-wide and temporarily snooze an exact review version without changing its decision, trust, or gate status. New content returns immediately to the active queue.
- Keep executable hooks read-only unless the project owner explicitly enables hook editing.
- Keep deterministic context primitives available internally while exposing a compact documentation-research entry point to ordinary coding agents.
- Keep documentation research isolated. `context-room context ask` may launch Codex, while every `context-room docs` command remains deterministic and read-only.
- Keep accepted and pending evidence separate. Proposal metadata may stay
  visible, but proposal content never enters effective build context before
  human review and integration into the configured shared default branch.
- Keep config changes source-grounded. Run `context-room doctor` after changing `.context-room/config.json`.
- Keep accepted shared context read-only. Changes belong in a proposal worktree; only human file decisions can make its reviewed result eligible for automatic finalization into the shared default branch.
- Resolve worktrees only from the current directory or explicit registration. Context Room does not scan the computer for new worktrees.
- Keep CLI output machine-stable: versioned envelopes, plan/apply for new mutations, and structured ambiguity instead of guesses. The metadata-only event journal remains an internal UI synchronization mechanism rather than a public agent command.
- Keep rooms isolated. Automatic port selection must not stop another room, and a stale tab must not write state after its port begins serving another project root.

## Data Model

- `allowedPaths`: files and folders Context Room may expose for editing.
- `readOnlyPaths`: allowed files and folders Context Room may display but must not create, edit, or delete.
- `watchAllow`: simple exact file watches and compatible recursive live folder watches; each current content hash requires human verification.
- `watchRules`: explicit folder watches that combine recursive or direct-child scope with live or current-file membership. The full contract lives in [Agent configuration](agent-configuration.md#watchrules).
- `reviewPaths` and `reviewAgentInstructions`: deprecated read-only compatibility fields migrated into the unified watched-document scope on the next human Settings save.
- `.context-room/review-gate.json`: local owner policy selecting which Git operations pending review can block. It stays outside project config and the agent CLI cannot change it.
- `hubSections`: visible navigation structure.
- `startupContext`: instruction files that may shape agent behavior before work starts.
- `startupSkills`: skill folders that may shape future agent behavior.
- `startupHooks`: hook files that can run around agent work, Git actions, or validation.
- `context_room` metadata: optional Markdown frontmatter used by `doctor`, graph health, and briefs.
- Context coordinates: a durable project ID, explicitly registered worktree
  location, project-relative folder, and provider.
- Context resources and applications: evidence-based identities, versions,
  statuses, scopes, reasons, destinations, and proven relations used by
  effective context, trace, impact, snapshots, and UI inspection.
- `~/.context-room/shared/registry.json`: user-approved source-repository and subpath bindings for generic shared context.
- `$HOME/.context-room/hub/registry.json`: local project and shared-repository catalog used by Context Room's global views.
- `$CODEX_HOME/prompt-overrides/`: private Codex-owned prompt catalog, exact overrides, hash-only runtime receipts, and immutable per-process catalog snapshots; it is never project configuration.
- `<shared-repository>/.context-room/shared-repository.json`: versioned contract for a shared repository's branch and path layout.
- `schemas/doc-context.schema.json`: structured evidence contract returned by the documentation research agent.

## Source Map

- `bin/context-room.mjs`: CLI entry point and command routing.
- `src/context_room.mjs`: server, file access, review queue, graph, brief, UI, and API.
- `src/shared_context.mjs`: shared repository sync, snapshots, managed skill and instruction links, proposals, review materialization, and acceptance.
- `src/agent_cli.mjs`: target resolution, exact-folder environment, task preparation, change routing, handoff, reviews, project commands, and shared resource inspection.
- `src/context_engine.mjs`, `src/context_inventory.mjs`, and `src/provider_profiles.mjs`: effective context, graph, trace, impact, accepted-document filtering, and provider evidence.
- `src/document_graph.mjs` and `src/document_graph_layout_worker.mjs`: the human-facing Document Graph, proven reference model, bounded deterministic layout, and progressive graph scopes.
- `src/context_snapshots.mjs`: private metadata-only context snapshots and diffs.
- `src/context_settings.mjs` and `src/context_diagnostics.mjs`: typed context Settings and structured Doctor or proposal-impact analysis.
- `src/cli_registry.mjs`, `src/cli_contract.mjs`, and `src/event_journal.mjs`: command parity, versioned machine output, completions, and resumable local events.
- `src/context_hub.mjs`: global project/shared-repository registration and single-Hub runtime discovery.
- `src/codex_prompt_center.mjs`: generic Codex prompt catalog, exact overlays, private storage, optimistic concurrency, and per-process receipt/snapshot proof.
- `src/doc_agent.mjs`: documentation-only corpus, section retrieval, Codex researcher invocation, and evidence packet rendering.
- `src/codex_composer_bridge.mjs`: loopback-only insertion into the active Codex composer.
- `src/doc_metadata.mjs`: Markdown metadata parsing.
- `src/yaml_utils.mjs`: YAML helpers.
- `schemas/config.schema.json`: config contract.
- `schemas/codex-prompt-catalog-v1.schema.json`: strict runtime catalog and immutable snapshot contract.
- `schemas/codex-prompt-overrides-v1.schema.json`: strict private override-manifest contract.
- `schemas/codex-prompt-runtime-receipt-v2.schema.json`: strict hash-only runtime receipt contract.
- `schemas/shared-repository.schema.json`: shared repository manifest contract.
- `schemas/doc-context.schema.json`: documentation research output contract.
- `test/context_room.test.mjs`: CLI, config, review, startup scanner, and UI behavior tests.
- `test/codex_prompt_center.test.mjs`: synthetic prompt catalog, overlay, storage, receipt, privacy, and API tests.
- `test/shared_context.test.mjs`: shared snapshots, skills, offline fallback, proposal scope, hash expiry, and partial-acceptance tests.
- `test/context_engine.test.mjs`, `test/context_snapshots.test.mjs`, and
  `test/context_diagnostics.test.mjs`: effective context, trace, impact,
  snapshots, diffs, Doctor helpers, and proposal impact.
- `test/doc_agent.test.mjs`: documentation corpus, retrieval, provenance, prompt boundaries, and Codex invocation tests.
- `docs/agent-configuration.md`: detailed config guide.

## Development Loop

```bash
npm test
node bin/context-room.mjs doctor --root .
node bin/context-room.mjs start --root .
```

Without an explicit port, Context Room selects the first free port within the 200-port range starting at `4317`. An explicitly requested occupied port fails; Context Room does not stop the process using it. Confirm the served root through `/api/health` after startup.
