# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Canonical Product Truth

This file is the compact design-facing product record. The canonical product
overview remains [`docs/product-overview.md`](docs/product-overview.md), with
feature behavior owned by [`docs/features/index.md`](docs/features/index.md).

## Users

Context Room is for people who use coding agents across one or many projects
and need documentation changes to remain visible, reviewable, and human-owned.
It is designed for local work, multiple registered worktrees, and shared Git
documentation repositories.

## Product Purpose

Context Room keeps project knowledge easy to inspect and update while ensuring
that the current version of every watched document is explicitly reviewed by a
person. Local files remain individual review items. Shared documentation
changes remain grouped in proposals until their file reviews are decided.

## Positioning

Context Room combines a file explorer, documentation reader/editor, review
queue, shared proposal workflow, startup-environment inspection, and context
health in one local-first workbench. Its Context Engine resolves the exact
accepted instructions, skills, hooks, provider configuration, and documents for
one registered project, worktree, folder, and provider. Agents can prepare and
publish work, but human review decisions remain outside the agent CLI.

## Operating Context

- Context Room has one global room across registered projects. Selecting a
  project or worktree changes the active target inside that room; it never
  starts a project-scoped room.
- `Local` and `Shared` describe where documentation is stored and how it is
  reviewed. They are sources, not room modes.
- The Explorer is the primary way to choose a project, worktree, folder, or
  document.
- Home is review-first and also contains user-arranged project sections.
- Shared contexts are Git repositories whose configured default branch is the accepted truth;
  proposal content remains pending metadata until its reviewed result reaches
  that branch.
- Context Room never discovers local projects or worktrees implicitly.

## Capabilities and Constraints

- Preserve review, proposal, shared-context, startup, CLI, and watch semantics.
- Keep the seven Settings tabs, live Settings search, manual Save, interface
  sounds, and existing theme choices.
- Keep Context Room local-first and deterministic. Do not add implicit LLM work
  to product-critical checks.
- All user-facing interface copy is English.

## Brand Commitments

Context Room should feel like a calm native workbench: compact, precise,
readable, and comfortable during long documentation and review sessions. Its
default accent is cyan; alternate themes change color, not product geometry.

## Product Principles

1. Human review is the product's primary action.
2. The document, proposal, or queue being acted on is always the visual focus.
3. Navigation and scope stay visible and predictable.
4. Advanced detail is available without crowding routine work.
5. Cached or stale state is never presented as fresh truth.

## Accessibility & Inclusion

The interface must remain keyboard-operable, retain visible focus, support
reduced motion and 200% zoom, avoid color-only status communication, and meet
WCAG AA contrast for text and essential controls.
