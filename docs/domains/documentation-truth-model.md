---
context_room:
  id: domains.documentation.truth-model
  depends_on:
    - domains.truth.layers
    - strategy.context-room
---

# Documentation Truth Model

## Summary

Each durable truth has one canonical owner. Other documents may navigate, project, summarize, or generate views of that owner, but they do not restate its normative content.

## Defines

This document defines document roles, stable IDs, direct maintenance dependencies, required owner sections, temporal classification, and the treatment of source evidence.

## Does not define

This document does not define product behavior owned elsewhere, exact implementation schemas, every format style rule, or migration history.

## Document roles

### Owner

An owner defines one durable responsibility. There is one accepted owner for that responsibility.

An owner can cite code, schemas, tests, workflows, decisions, and related documents. Those references do not transfer ownership.

### Projection

A projection helps a reader navigate or understand several owners. It summarizes only enough to orient the reader and links to owners for normative detail.

Examples include README, indexes, maps, operator entry pages, and coordinated HTML explorations.

### Generated

A generated artifact derives mechanically from owners, schemas, code, tests, or runtime state. It is reproducible and is not edited as an independent truth.

Examples include graph layouts, source-evidence matrices, metadata reports, link reports, and release receipts.

## Stable IDs

Every first-rank Markdown or HTML owner and projection has a path-independent ID:

```yaml
---
context_room:
  id: product.review.queue
  depends_on:
    - assurance.review.human-authority
---
```

IDs are lowercase dot-separated identifiers. Moving or renaming a file does not change its ID.

One accepted ID resolves to one accepted document. Duplicate owners fail validation.

## Direct maintenance dependencies

`A depends_on B` only when an accepted change to B can require a human to reconsider A.

The edge is direct. Transitive dependencies are derived by the graph.

The following are not automatically dependencies:

- source files;
- tests;
- schemas;
- citations;
- “see also” references;
- navigation links;
- documents that merely mention the same subject.

## Required owner structure

Every ordinary canonical owner contains:

1. a literal title;
2. `Summary`;
3. `Defines`;
4. `Does not define`;
5. only the additional sections required for its responsibility.

The conclusion appears first. Unknowns and limits remain explicit.

## Temporal classification

- **Current** describes implemented and accepted behavior.
- **Target** describes accepted future intent that is not yet implemented.
- **Historical** preserves past behavior, decisions, releases, incidents, or superseded states.
- **Proposal** is pending review and never current truth.

The path may reinforce classification, but valid explicit metadata and repository state are authoritative. A target is not a proposal: the target has been accepted as intent; the proposal has not been accepted.

## Evidence

Source files, schemas, tests, workflows, and explicit product decisions support an owner. They are recorded as references or generated evidence, not copied into `depends_on`.

`last_verified` is a maintenance hint, not proof. Verification requires a reproducible receipt identifying the exact baseline and checks performed.

A test proves only its assertions. The presence of a test file or workflow does not prove that every nearby documentary promise is guaranteed or that the exact release run passed.

## Mechanical contracts

Exact JSON structures remain in native schemas. CLI contracts remain in the declarative registry and schemas. Documentation explains meaning, lifecycle, and consequences without duplicating every mechanical field.

## Indexes, diagrams, and HTML views

An index routes readers to owners.

A diagram answers a specific relationship, state, branch, actor, or sequence question. Its textual owner remains authoritative.

An HTML exploration coordinates several owners and links to them. It does not become a visually richer copy of their normative prose.

## Migration rule

Correct semantics before moving files. Preserve paths, stable IDs, inbound links, and legacy metadata until a reviewed migration can update all consumers together.

Delete a document only after every unique truth has an accepted owner and every inbound reference has been repaired.
