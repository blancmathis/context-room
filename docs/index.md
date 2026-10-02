---
context_room:
  id: projection.documentation.map
  depends_on:
    - strategy.context-room
    - product.model
    - domains.documentation.truth-model
---

# Context Room Documentation

## Summary

This map routes readers from the product purpose to the canonical owners for product behavior, domain rules, system architecture, assurance, operations, and lifecycle.

## Defines

This document defines navigation only.

## Does not define

This document does not define product behavior, technical contracts, security guarantees, or future intent.

## Start here

1. [Strategy](../PRODUCT.md)
2. [Product model](product-overview.md)
3. [Global Context Hub](features/context-hub.md)
4. [Shared Context](features/shared-context.md)
5. [Human review authority](features/review-authority.md)

## Domain owners

- [Truth layers](domains/truth-layers.md)
- [Shared proposal lifecycle](domains/shared-proposal-lifecycle.md)
- [Documentation truth model](domains/documentation-truth-model.md)

## System owners

- [System architecture](system/architecture.md)
- [Runtime profiles](system/runtime-profiles.md)
- [Shared computer/tablet interface, connected devices and PWA](system/connected-devices.md)
- [Lisière recovery and migration](system/lisiere-migration.md)
- [Shared resource materialization](system/shared-resource-materialization.md)

## Product surfaces

- [Document workflow, formats and optional tablet](features/document-workflow.md)
- [Original-source conversations and dictation](features/conversations.md)

- [Global Context Hub](features/context-hub.md)
- [Shared Context](features/shared-context.md)
- [Human review authority](features/review-authority.md)

## Assurance

- [Human review authority](features/review-authority.md)

## Operations

- [Document workflow and migration](features/document-workflow.md)
- [Release verification](operations/release-verification.md)

## Lifecycle

Active implementation and its verification record:

- [Refactor: consolidated decisions, architecture, migration and verification](lifecycle/changes/active/refactor/index.md)
- [Connected notebooks and Android convergence](lifecycle/changes/active/android-convergence/index.md)
  - [Shared-web verification and reversible BOOX handoff](lifecycle/changes/active/android-convergence/codex-shared-web-handoff.md)

Historical evidence does not define current behavior:

- [v0.6.4 documentation replacement](lifecycle/records/v0.6.4/documentation-replacement.md)
