---
context_room:
  id: strategy.context-room
  depends_on: []
---

# Context Room Strategy

## Summary

Context Room is a local-first control room for documentation used by humans and AI agents. It makes accepted context inspectable, keeps pending changes separate from current truth, and preserves human authority over review and acceptance.

## Defines

This document defines why Context Room exists, who it serves, and the product principles that constrain every implementation and documentation decision.

## Does not define

This document does not define UI behavior, CLI syntax, storage layouts, Shared proposal mechanics, hosted deployment, or future roadmap items.

## Purpose

AI agents can read and change a codebase faster than a person can continuously reconstruct its intent. Context Room gives the owner one place to inspect the documentation, instructions, skills, proposals, and review obligations that influence that work.

The product is not a generic file browser, a wiki, a vector database, or an autonomous authority. It is a control surface over explicit files and deterministic evidence.

## Primary readers

- Project owners who decide what documentation is trusted.
- Contributors who need current behavior before changing it.
- Coding agents that need a bounded, machine-readable context surface.
- Operators who verify local and hosted isolation.
- Documentation maintainers who require one owner for each durable truth.

## Product principles

### Local first

Local projects and worktrees remain on the user's computer. Local Context Room binds to loopback and operates over explicitly authorized paths.

### The Context Hub is global

The Context Hub is always the top-level surface. Launching from a project or worktree opens the global Hub and selects that location. The user can always return to the global view.

### Deterministic evidence before model inference

Inventory, graph construction, health checks, review state, proposal state, path boundaries, and effective-context resolution are deterministic. A model may research accepted documentation through `context-room ask`, but it does not define truth.

### Accepted truth and pending change are different objects

Accepted local content, accepted Shared main, proposals, targets, and historical records remain distinguishable in storage, APIs, UI, and documentation. A proposal is never current truth before human acceptance.

### Human authority is terminal

Humans accept or reject files and Shared proposals. Agent-facing commands do not expose terminal review decisions. Agent assistance for a multi-file or terminal proposal action requires two separate explicit confirmations for the exact action and scope.

### Shared truth is reviewable Git truth

A Shared repository keeps accepted truth on its configured default branch. Pending changes live in isolated proposal branches and worktrees. Acceptance delivers only the exact result reviewed by a human.

### Hosted means Shared only

A hosted Context Room receives only explicitly configured Shared repositories and scoped capabilities. It cannot read local files, local project settings, local prompt state, local provider homes, or local-only APIs.

### Documentation describes reality

Current documentation describes accepted, implemented behavior. Accepted targets, historical records, and unaccepted proposals remain labeled and separate. Unknowns stay visible.

## Success criteria

Context Room succeeds when:

1. a human can tell what is current, pending, targeted, or historical;
2. every important behavior has one canonical documentary owner;
3. an agent can retrieve accepted context without gaining review authority;
4. worktrees appear as variants of one logical project;
5. Shared proposal delivery is exact, reviewable, and recoverable;
6. hosted operation cannot cross into local state;
7. deterministic verification detects drift between code, contracts, tests, and documentation.
