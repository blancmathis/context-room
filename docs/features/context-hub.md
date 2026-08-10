---
context_room:
  id: product.hub.global
  depends_on:
    - product.model
    - domains.truth.layers
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
