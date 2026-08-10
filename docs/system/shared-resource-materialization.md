---
context_room:
  id: system.shared.resource-materialization
  depends_on:
    - product.shared-context
    - system.runtime-profiles
---

# Shared Resource Materialization

## Summary

Accepted Shared skills, instructions, and metadata profiles are read from one immutable accepted repository revision and projected through Context Room-owned local destinations without overwriting unmanaged content.

## Defines

This document defines accepted resource inputs, provider destinations, managed ownership, local overrides, conflicts, and transactional reconciliation.

## Does not define

This document does not define proposal review, individual provider behavior beyond its versioned profile, or the Settings layout.

## Accepted inputs

A Shared repository can define:

- skill collections;
- skill assignments;
- instruction collections;
- instruction assignments;
- metadata profiles;
- project and global resource scopes.

Only accepted main is eligible for materialization. An open proposal remains pending and does not alter effective resources.

## Immutable revision rule

One reconciliation run resolves every referenced manifest and resource from the same accepted revision. It does not mix accepted files from different revisions or read a proposal overlay.

The resulting local receipt records the accepted revision used.

## Provider profiles

A versioned provider profile defines native discovery locations, ordering, and evidence for Codex, Claude Code, and OpenCode.

Context Room does not infer provider activation from a destination name alone.

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

A skill collection contains reviewed accepted skill directories with valid entry points. Assignments select collections for project, Shared, or device scope and one or more providers.

Editing canonical Shared skill content requires a `skills` proposal.

## Instructions

An instruction collection contains reviewed accepted Markdown sources. An assignment declares the exact source, provider set, scope, and target path.

A managed instruction can be installed without being active when the provider does not natively discover its target and no explicit provider configuration proves discovery.

Editing canonical Shared instruction intent requires an `instructions` proposal.

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

The Context Engine, Startup environment, Settings, Health, and documentation researcher must consume the same accepted resource projection and distinguish accepted, installed, active, inactive, conflicted, stale, and pending proposal states.
