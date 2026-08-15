---
context_room:
  id: product.hub.global
  depends_on:
    - product.model
    - domains.truth.layers
    - domains.shared.proposal-lifecycle
    - system.runtime-profiles
---

# Global Context Hub

## Summary

The Context Hub is always the global level. Starting Context Room from a project or worktree opens the global Hub, registers that location when needed, selects it, and leaves the global view reachable.

## Defines

This document defines Hub aggregation, project and worktree identity, selection, navigation, and observable unavailable or recovery states.

## Does not define

This document does not define registry JSON, filesystem transaction internals, Shared proposal algorithms, or hosted deployment.

## Launch behavior

`context-room`, `context-room start`, `context-room setup`, and `context-room ui open` resolve to the global Hub.

When invoked from or for a local project or worktree, Context Room:

1. initializes the local project when required;
2. registers the exact location in the private Hub registry;
3. groups it with locations that share the same logical Git identity;
4. opens or reuses the loopback Hub server;
5. selects the requested location.

The Hub host has no broad project allowlist. Project data is loaded through exact registered capabilities.

## Logical projects and locations

A logical project represents one project across one or more registered Git worktrees. Each location keeps its physical root, branch, revision, availability, local configuration, review state, and health state.

The logical group keeps shared product identity, display order, and one Shared binding. Connecting or disconnecting Shared Context applies to the exact registered locations through a capability-bound transaction.

Context Room does not discover every Git worktree implicitly. A worktree appears after explicit registration or launch.

## Global aggregation

The Hub aggregates local logical projects and locations, registered Shared repositories, accepted Shared projects, active proposals, local file reviews, Shared proposal reviews, and recovery/attention states.

Several Shared repositories can coexist. Repository identity remains part of project and proposal keys so equal project IDs or branch names do not collide.

## Selection

Selecting a local location changes project-specific Explorer, Settings, Startup environment, effective-context queries, and actions.

Selecting a Shared-only project exposes accepted Shared content but no local project Settings.

Selecting a proposal opens exact proposal review without making the proposal effective.

Clearing selection returns to the global Hub.

## Proposal opening

The Hub follows the proposal projection defined by [Shared Proposal Lifecycle](../domains/shared-proposal-lifecycle.md#hub-projection). `ready`, `in_review`, and `updated` proposals are active and openable. A proposal already integrated into accepted main, a terminal proposal, or a proposal whose branch no longer exists is absent from the active list. Pending recovery remains visible only while a live, non-integrated proposal branch still requires action.

Opening an active proposal keeps the proposal surface visible while Context Room verifies and materializes the exact review. The surface shows the known repository, branch, and head immediately, reports preparation honestly, and does not claim readiness before exact review is available.

After a fresh local Hub snapshot, Context Room prepares the exact review authority, proposal-only DocQA projection, and response payload without creating a human decision. Proposal records expose `openReadiness` as `preparing`, `ready`, or `blocked`; the open action remains disabled until `ready`. A stale snapshot always reports an otherwise active proposal as `preparing`, including when an exact room was restored after restart.

Active review authorities are re-indexed from private persisted evidence after restart, so an unchanged exact room can be reused without a global proposal scan or rematerialization. Legacy active proposals that predate protected proposal-state refs use that fast path only after a fresh Hub snapshot has verified the exact main and proposal heads, conflict result, and absence of terminal or recovery evidence.

Opening stays in the current browser document. A stable proposal shell appears immediately, and the prepared review is adopted in place; Explorer and unrelated reports are not loaded as part of proposal verification. `POST /api/context-hub/review` reports `exact-ref`, `room`, `docqa`, and `payload` durations through `Server-Timing`.

If that snapshot becomes stale, terminal, unavailable, or recovery-required during opening, the proposal surface transitions inline and offers an explicit refresh, recovery, retry, or return action. An opening result or failure never silently clears selection or sends the user back to the Hub.

## Recovery and unavailable state

Registry and Shared-binding mutations use private journals and exact capability checks. If recovery is ambiguous, Context Room blocks further mutation and surfaces recovery-required rather than guessing.

An unavailable worktree remains identifiable as a registered location. Context Room does not reinterpret another path as that location.

## Hosted Hub

`hosted-hub` uses the same product model over a narrower provider. It includes only configured Shared repositories and projected Shared data. Local projects, worktrees, settings, prompts, and provider state are absent.

## Action-changing errors

- **Location unavailable:** restore or explicitly remove the registered location.
- **Registry recovery required:** resolve recorded recovery before another group mutation.
- **Shared repository unavailable:** mutations fail closed; permitted read surfaces may use exact verified cached state.
- **Stale selection:** select the current projection again.
