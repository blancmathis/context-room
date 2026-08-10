---
context_room:
  id: system.architecture
  depends_on:
    - product.model
    - system.runtime-profiles
    - domains.truth.layers
---

# System Architecture

## Summary

Context Room is a Node.js package with one declarative CLI, a global loopback Hub, project and Shared data providers, deterministic context and documentation engines, human review authority, and a separate Shared-only hosted entry point.

## Defines

This document defines the major components, ownership boundaries, data flows, persistence classes, and the deterministic/model boundary.

## Does not define

This document does not define every HTTP route, function, schema field, UI component, deployment command, or product workflow.

## Component map

```mermaid
flowchart LR
    CLI[bin/context-room.mjs] --> Registry[src/cli_registry.mjs]
    Registry --> AgentCLI[src/agent_cli.mjs]
    Registry --> Diagnostics[src/context_diagnostics.mjs]
    Registry --> Settings[src/context_settings.mjs]
    Registry --> Docs[src/doc_agent.mjs]

    CLI --> Hub[src/context_hub.mjs]
    Hub --> Server[src/context_room.mjs]
    Server --> Review[src/review_authority.mjs]
    Server --> Engine[src/context_engine.mjs]
    Server --> Inventory[src/context_inventory.mjs]
    Server --> Shared[src/shared_context.mjs]

    Remote[bin/context-room-remote.mjs] --> Server
    Remote --> Gateway[src/qm_gateway.mjs]
    Remote --> Identity[src/remote_identity.mjs]

    Shared --> Locks[src/filesystem_lock.mjs]
    Shared --> GitHubToken[src/github_app_token.mjs]

    Docs --> Metadata[src/doc_metadata.mjs]
    Docs --> MetadataEngine[src/document_metadata_engine.mjs]
    Docs --> Graph[src/document_graph.mjs]
    Docs --> Researcher[isolated Codex process]
```

## Global Hub control plane

The private Hub registry owns registered project locations, logical-project grouping, worktree identity, display order, Shared bindings, and recovery state.

The Hub host is not an implicit project. It opens a global loopback server with no broad project allowlist and accesses a selected project only through an exact registered capability.

## Project control plane

Each initialized project keeps explicit configuration under `.context-room/`. The configuration defines authorized document paths, review coverage, startup discovery, and product organization. Owner-authorized review scope is protected by separate private authority state and cannot be narrowed merely by editing project JSON.

## Shared control plane

Each Shared repository has:

- canonical repository identity;
- a private clone and immutable accepted-revision cache;
- proposal and review worktrees;
- proposal, connection, resource-link, observation, and recovery registries;
- exact terminal state refs;
- owner decision evidence.

Accepted resources are read from one immutable accepted revision. Proposal and terminal mutations use bounded Git operations, private locks, leases, atomic ref updates, and post-delivery verification.

## Review control plane

Review authority is separate from mutable project configuration. It owns:

- the last owner-authorized local review scope;
- trusted exact file review state;
- the cross-room path-and-content ledger;
- exact Shared proposal review authorities;
- owner-interface nonces;
- one-use terminal challenges;
- signed owner decisions.

## Context and documentation engines

The Context Engine resolves effective, trace, and impact views from explicit resources, provider profiles, accepted Shared state, and temporal layers.

The metadata and graph components parse stable IDs, direct maintenance dependencies, references, profiles, diagrams, and truth states. Content-addressed snapshots preserve exact evidence without becoming competing owners.

## Deterministic and model boundary

The following surfaces are deterministic:

- CLI registry and envelopes;
- Context Engine;
- document inventory, metadata, graph, search, read, inspect, and validation;
- settings plans and stale checks;
- `doctor`, `guard`, and `brief`;
- review state and proposal state;
- path, schema, identity, and delivery verification.

`context-room ask` is the documentation feature that launches a model. It starts one fresh, read-only Codex process over a frozen accepted-only corpus and validates the returned packet. Codex Prompt Center edits a compatible local runtime contract but does not call a model.

## Persistence classes

| Class | Examples | Authority |
| --- | --- | --- |
| Project configuration | `.context-room/config.json` | Project configuration constrained by owner authority |
| Private device state | Hub registry, UI preferences, local provider overrides | Local device |
| Review authority | scope, ledgers, exact decisions, challenges | Human owner |
| Accepted Shared truth | configured default branch | Human-accepted Git history |
| Proposal state | proposal branch, worktree, exact head | Pending change |
| Generated evidence | graph, coverage, snapshots, receipts | Derived, non-normative |
| Hosted service state | dedicated data root | Explicit Shared-only service scope |

## Architectural constraints

- Local project and worktree paths never become hosted inputs.
- Worktrees are location variants of one logical project.
- Accepted Shared content and proposal content use different revisions and authority.
- Provider destinations are resolved through versioned profiles, not guessed by name.
- Read-only operations must not bootstrap or mutate review authority.
- A route, provider, or persistence root must be explicitly assigned to each runtime profile.

## Maintainability risk

In v0.6.4, `src/context_room.mjs` and `src/shared_context.mjs` concentrate many responsibilities. Documentation must follow stable product, domain, system, assurance, and operations boundaries rather than mirror these source-file boundaries.
