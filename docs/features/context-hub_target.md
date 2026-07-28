---
context_room:
  kind: target
  scope: context-room
  status: draft
  canonical_for: remaining unimplemented Context Hub and context-management decisions
  last_verified: 2026-07-27
  sources: [docs/features/context-hub.md, docs/features/context-engine.md, docs/features/file-explorer-and-editor.md, docs/features/shared-context.md, docs/agent-configuration.md, src/context_hub.mjs, src/context_room.mjs, src/context_engine.mjs, src/shared_context.mjs]
---

# Context Hub Target

## Purpose

This document contains only decisions that remain unimplemented or unproven.
Current project selection, worktree grouping, Explorer folder inspection,
provider-specific effective context, trace, impact, proposal impact, Shared
Skills, and accepted shared history are documented in their canonical current
pages.

## Permission Model Beyond `allowedPaths`

The owner has decided that Explorer navigation and explicit watch selection
should eventually be independent from the current static edit boundary.

The target distinguishes:

- visibility and navigation;
- an explicit human edit;
- agent, automation, and API write authority;
- watch and review scope; and
- technical compatibility or sensitive-file warnings.

Under that model, an owner or agent can explicitly watch any selected local
file or folder without granting edit authority to its ancestors. Context Room
chooses Git history when available and a local content baseline otherwise.
Project-relative containment alone does not decide visibility.

This is not current behavior. `allowedPaths` and `projectOnly` remain active
configuration boundaries, and Context Room must not widen them implicitly.

## Custom Provider Discovery

Current provider profiles for Codex, Claude Code, and OpenCode are built in and
versioned. The remaining target is an owner-controlled extension mechanism for
additional instruction filenames, skill roots, hook sources, and configuration
paths.

Custom entries must supplement a named profile unless the owner explicitly
chooses replacement. Every result still needs evidence and must remain
`uncertain` when activation or precedence cannot be proved.

## Direct Human Editing Of Accepted Shared Content

The current safe path is a proposal followed by human file review and automatic
finalization into the configured default branch. Agents cannot write that
branch.

The remaining target allows a human to edit accepted shared content in the
normal editor without an extra Edit mode. Save would still create an isolated
change, refresh the latest accepted branch, detect conflicts, integrate without
overwriting a newer remote revision, and require distinct human authority.

The first direct accepted-branch Save in an editing session should warn that a
proposal is the recommended collaborative path. Whether its temporary branch
must always be pushed for recovery remains open.

## Semantic Rebase Review

Current proposal impact reports Git conflicts and exact-revision review
invalidation. It explicitly does not evaluate semantic contradictions.

The remaining target detects documentary duplication, contradiction, or
competing canonical ownership after a clean rebase and sends only affected
zones back to targeted human review. Conflict and invalidated-zone state should
persist across sessions.

This work must extend the existing proposal and Doctor evidence rather than
introduce a second Context Health or review system.

## Multi-Repository Task Presentation

Context Room can register several independent shared contexts and keeps each
proposal scoped to its owning Git repository. The remaining product question
is whether proposals created for one task across several repositories should
appear as a visual group and how partial completion should be represented.

No Git proposal may span repositories, and grouping must never merge canonical
state or review authority.

## Open Decisions

1. Should custom provider discovery extend or replace the selected built-in
   profile by default?
2. Must the isolated branch for a direct human accepted-branch Save always be
   pushed, or only when the operation cannot finish immediately?
3. How should one task's repository-specific proposals be grouped without
   implying shared acceptance or atomicity?
4. Should recent or habitual destinations appear in a dynamic Home section
   without reordering the owner's manual sections?

## Required Proof

These target decisions are complete only when tests and rendered behavior prove
that:

- explicit navigation or watch selection never grants write authority;
- a watched path outside registered projects uses real Git or local-baseline
  evidence without automatic worktree discovery;
- custom provider entries preserve provenance and uncertain states;
- direct human accepted-branch Save cannot be invoked by the agent CLI, cannot
  overwrite a newer remote revision, and persists conflicts safely;
- a clean rebase can invalidate only evidenced affected zones after semantic
  analysis; and
- cross-repository visual grouping never merges proposal identity, review
  decisions, or canonical Git history.
