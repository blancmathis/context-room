---
context_room:
  id: domains.truth.layers
  depends_on:
    - strategy.context-room
---

# Truth Layers

## Summary

Context Room separates current, target, historical, and proposal material because each layer has different authority and consumption rules.

## Defines

This document defines the stable meanings and invariants of the four temporal layers.

## Does not define

This document does not define file paths, branch names, metadata syntax, UI styling, or migration procedures.

## Current

Current is accepted behavior or content that Context Room may present as effective truth.

- Local current documentation is inside authorized scope and carries required human review evidence for the exact meaningful content hash.
- Shared current content comes from the configured default branch at an accepted, verified revision.
- Implementation behavior is current only when it is actually present in the documented baseline.

## Target

Target is an accepted future direction that is not yet current behavior. It may guide planning and implementation, but a current owner must not present it as already implemented. When implementation lands, the current owner is rewritten and the target is retired or converted to history.

## Historical

Historical material explains past behavior, decisions, releases, incidents, or superseded states. It may explain why a rule exists, but it does not replace the current owner's statement.

## Proposal

A proposal is an unaccepted change under review. It is isolated from accepted truth, may be inspected, may not drive effective context, and becomes current only through an explicit human terminal decision and verified delivery.

## Invariants

1. One resource cannot be both current and proposal at the same revision.
2. Path inference may classify material, but valid explicit metadata and repository state remain authoritative.
3. A target is not a proposal: target intent is accepted; a proposal is pending.
4. Historical evidence cannot silently override a current owner.
5. Projections and generated views preserve the source layer.
