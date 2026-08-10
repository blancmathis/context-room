---
context_room:
  id: product.shared-context
  depends_on:
    - product.model
    - domains.truth.layers
    - domains.shared.proposal-lifecycle
    - assurance.review.human-authority
---

# Shared Context

## Summary

Shared Context is accepted, reviewable context stored in Git. Accepted truth lives on each repository's configured default branch; pending changes live in isolated proposals and never affect current context before human acceptance.

## Defines

This document defines the user-visible Shared model, repository and project relationships, connection behavior, and the distinction between accepted resources and proposals.

## Does not define

This document does not define Git ref algorithms, terminal locks, schema fields, hosted secrets, provider destination internals, or deployment procedures.

## Repository model

A Shared repository contains one repository configuration, a project catalog, zero or more Shared projects, optional global and project skills, optional skill and instruction assignment manifests, and optional accepted metadata profiles.

A device or hosted instance may register several repositories. Repository identity is part of every Shared project and proposal identity.

## Accepted truth

The configured default branch, normally `main`, owns current Shared truth. Context Room consumes an immutable cached revision.

A resource may become effective only when it exists in that accepted revision, has valid repository/project identity, passes native schemas and path checks, is projected without unmanaged conflict, and is proven discoverable when activation is claimed.

## Local connection

One local logical project can be connected to one Shared project at a time. The connection applies to explicitly registered worktree locations.

Connecting records exact repository/project identity, exposes accepted docs read-only, reconciles accepted managed skills and instructions, and records private binding evidence.

Disconnecting removes only Context Room-owned links and binding state. It does not delete the repository, accepted content, proposals, history, or unmanaged local files.

## Shared projects

A Shared project is catalogued on accepted main. Creating a new project is itself a proposal: the catalog append and initial Markdown document are reviewed and accepted atomically.

Adding a local project to a Shared repository does not make the local working tree Shared truth.

## Proposals

A proposal is an isolated Git worktree and branch based on accepted main. It has one repository, scope, branch, base revision, head, file set, and review state.

Several proposals may exist simultaneously, including for the same project. They remain independent until a human accepts or rejects each exact head.

A proposal can cover one Shared project, global Shared content, skills, or instructions. Scope checks reject unrelated paths.

## Resources

Accepted resources can include documents, skills, instructions, and metadata profiles. Skills and instructions use managed destinations. Context Room never overwrites unmanaged destination content. Local provider preferences and destination overrides are local state, not Shared truth. Hooks are not Shared resources.

## Offline behavior

Read-only consumption may use the last verified immutable accepted snapshot when the operation explicitly permits it. Creating, publishing, accepting, rejecting, or delivering a mutation requires online verification and fails closed when exact remote state cannot be proved.

## Human authority

File review and terminal decisions are human-owned. Completing every file decision reveals the terminal action; it does not execute it.
