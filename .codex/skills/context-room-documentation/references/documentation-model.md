# Context Room Documentation Model

## Universal architecture

Use six stable zones for every project:

```text
README.md
AGENTS.md

docs/
├── INDEX.md
├── PROJECT-MAP.diagram.md
│
├── strategy/
│   ├── project.md
│   ├── market/
│   ├── audiences/
│   ├── positioning.md
│   ├── brand.md
│   ├── messaging.md
│   ├── business-model.md
│   ├── goals.md
│   └── principles.md
│
├── product/
│   ├── offer.md
│   ├── capabilities/
│   ├── journeys/
│   ├── experience/
│   ├── policies/
│   ├── pricing.md
│   └── content/
│
├── system/
│   ├── architecture.md
│   ├── components/
│   ├── contracts/
│   ├── data/
│   ├── flows/
│   ├── infrastructure/
│   └── integrations/
│
├── operations/
│   ├── marketing/
│   ├── communications/
│   ├── sales/
│   ├── launch/
│   ├── delivery/
│   ├── support/
│   ├── deployment/
│   ├── runbooks/
│   ├── team/
│   ├── finance/
│   └── legal/
│
├── quality/
│   ├── requirements.md
│   ├── verification/
│   ├── metrics/
│   ├── security/
│   ├── privacy/
│   ├── compliance/
│   └── risks/
│
└── evolution/
    ├── changes/
    │   ├── active/
    │   └── archive/
    ├── decisions/
    └── records/
        ├── incidents/
        ├── experiments/
        └── releases/
```

This tree is a vocabulary, not a checklist. Never create empty directories or placeholder documents merely to match it.

## What each zone owns

| Zone | Question it answers |
| --- | --- |
| `strategy/` | Why does the project exist, for whom, and what position or perception should it create? |
| `product/` | What does the project promise and deliver to users? |
| `system/` | How is the product technically realized? |
| `operations/` | How is it marketed, communicated, sold, launched, delivered, supported, and run? |
| `quality/` | How do we know it is good, safe, reliable, measurable, and compliant? |
| `evolution/` | What is changing, why was a choice made, and what happened historically? |

The distinctions matter:

```text
Strategy   → what the project wants people to understand, believe, or value
Product    → what users actually receive and experience
System     → how that experience is technically produced
Operations → how the project reaches people and functions in the real world
Quality    → how the expected result is measured and proven
Evolution  → how current truth changes and why
```

## Scaling rules

Start with the smallest useful set of documents.

- A small project may use one file in each relevant zone.
- Add a category directory only when more than one durable document belongs there.
- In large projects, place the category before the domain:

```text
docs/product/capabilities/billing/invoices.md
docs/system/components/billing/invoice-service.md
docs/quality/verification/billing/invoice-integrity.md
```

- A small subject is one file.
- A large subject becomes a directory with `index.md` as its entry point and focused child documents or assets.
- Use lowercase kebab-case for ordinary file and directory names.
- Reserve `INDEX.md` and `PROJECT-MAP.diagram.md` as special project entry points.
- `docs/INDEX.md` is a short navigation map, not another owner of project truth.
- Add `PROJECT-MAP.diagram.md` once several domains or documents make the project difficult to understand from the tree alone.

## Document kinds

Do not impose a rigid body template for every kind. The location and subject determine the natural content.

Typical durable documents include:

- strategy foundations, market research, audiences, positioning, brand, messaging, goals, principles, and business model;
- product offers, capabilities, journeys, experience rules, policies, pricing, and product content;
- system architecture, components, contracts, data models, flows, infrastructure, and integrations;
- operational plans and procedures for marketing, communication, sales, launch, delivery, support, deployment, team, finance, and legal work;
- quality requirements, evaluations, metrics, security, privacy, compliance, and risks;
- active changes, decisions, incidents, experiments, and releases; and
- visual maps, flows, states, and sequences that make the project easier to understand.

Create a new document only when its subject has an independent responsibility, can evolve independently, needs to be referenced from several places, or no existing document can own it clearly.

## Canonical ownership

Every durable fact must have one canonical owner.

Before writing:

1. search accepted documentation for the subject;
2. identify the existing owner if one exists;
3. update that document instead of adding a competing explanation; and
4. use links from other documents rather than copying the same truth.

A document may explain the consequence of another document's rule for its own scope. It must not maintain a second copy of that rule.

## Common document contract

Every first-class Markdown document uses this envelope:

```markdown
---
context_room:
  id: product.review.human-approval

  depends_on:
    - strategy.trust.human-control

  artifacts:
    code:
      - src/review/**
    tests:
      - test/review/**
---

# Human document approval

> **Summary:** A document version becomes trusted only after a human accepts its exact content.
>
> **Defines:** The observable approval, rejection, and invalidation rules for document review.
>
> **Does not define:** Git transport, proposal branch mechanics, or the internal storage format.

## How approval works

Start directly with the durable information the reader needs.

## Evidence

Add only when tests, metrics, research, schemas, or observations are necessary.

## Open questions

Add only when real unresolved questions exist.
```

Required body elements:

1. a literal title;
2. `Summary`;
3. `Defines`;
4. `Does not define`; and
5. the useful body.

`Evidence` and `Open questions` are optional. Delete them when empty. Do not add other boilerplate sections unless the subject needs them.

## Writing standard

### State the answer first

The summary expresses the main durable truth. It does not announce that the file exists.

Bad:

```text
This document explains the review system.
```

Better:

```text
A document version becomes trusted only after a human accepts its exact content.
```

### Make scope explicit

- `Defines` states what this file is the primary reference for.
- `Does not define` names nearby subjects that belong elsewhere. Link to their owners when useful.

### Keep one primary subject

The sentence “This document is the primary reference for…” should have a simple answer. Split independent subjects when they have different reasons to change or different natural readers.

### Describe current truth directly

Normal documents under `strategy/`, `product/`, `system/`, `operations/`, and `quality/` describe the current accepted project.

Put proposed behavior under `evolution/changes/active/`. Put significant historical reasoning under `evolution/decisions/`.

### Separate rules from rationale

A reader must be able to distinguish a requirement from its explanation. Use `MUST`, `MUST NOT`, `SHOULD`, and `MAY` only when the distinction is important.

### Use literal headings

Prefer:

```text
How a document becomes accepted
What invalidates an approval
Behavior when the shared repository is offline
```

Avoid vague labels such as `Overview`, `Details`, `Other`, or `Notes` when a more informative heading is possible.

### Keep exact contracts machine-readable

OpenAPI, JSON Schema, Protobuf, database definitions, and similar artifacts own mechanical detail. The human document explains purpose, semantics, compatibility, examples, constraints, and tradeoffs, then links to the exact contract.

### Make uncertainty visible

Record unresolved blocking facts as open questions. Do not write assumptions as current truth. When a question is resolved, remove it and integrate the answer into the owning section.

### Prefer concise completeness

Remove prose that does not change understanding, a decision, or an action. Preserve material constraints, edge cases, failure behavior, and evidence.

## Metadata contract

The target Context Room metadata is deliberately small:

```yaml
context_room:
  id: zone.domain.subject
  depends_on:
    - another.document.id
  artifacts:
    code:
      - path/**
```

Only `id` is required. `depends_on` and `artifacts` are optional.

### Stable document ID

Rules for `id`:

- use lowercase dot-separated words;
- make it unique inside the documentation corpus;
- derive it from the initial logical location when useful;
- do not change it merely because the file moves or is renamed; and
- use IDs, not file paths, in dependencies and Context Room diagram links.

Examples:

```yaml
id: strategy.positioning
id: product.review.human-approval
id: system.review.review-engine
id: evolution.change.folder-review
```

### Direct maintenance dependencies

`depends_on` has one precise meaning:

> If the target document changes significantly, this document may need to be reviewed again.

Rules:

- declare only direct dependencies;
- do not list transitive dependencies;
- do not add a dependency merely because another document is interesting or related;
- target stable document IDs;
- never maintain the inverse manually; Context Room derives “depended on by”; and
- when a dependency also helps the reader, keep a normal body link as well.

Example:

```yaml
context_room:
  id: system.review.review-engine
  depends_on:
    - product.review.human-approval
    - product.review.human-owned-policy
```

### References and backlinks

A Markdown link or HTML `href` is a reference, not automatically a dependency.

```markdown
See [Human approval](../../product/review/human-approval.md).
```

Use a normal link for navigation, context, attribution, or further reading. Context Room should derive `references` and `referenced by` from the content.

If the current document may become stale when the target changes, also declare the target under `depends_on`. Context Room may merge the metadata declaration and body link while preserving both origins.

Do not add a generic `related_to` field. Ordinary references already cover that need.

### Project artifacts

Artifacts connect a document to the real project without turning every source file into a document node.

```yaml
artifacts:
  code:
    - src/review/**
  tests:
    - test/review/**
  schemas:
    - schemas/review-state.schema.json
  config:
    - .context-room/config.json
  telemetry:
    - observability/review-dashboard.json
  assets:
    - review-flow.png
  examples:
    - examples/review-state.json
```

Rules:

- use project-relative paths or deliberate globs;
- include only artifacts that materially implement, verify, configure, measure, or illustrate the document;
- do not use `artifacts` as an exhaustive source map; and
- use `schemas` for machine schemas, not visual diagrams.

### Metadata Context Room should own or infer

Do not add these fields merely to repeat path, Git, or review information:

```text
type
domain
authority
truth
owner
status
stage
accepted
last_verified
verified_hash
reverse dependencies
```

The path classifies the document. Context Room and Git own review state, exact hashes, revisions, and history.

When a project already uses another metadata contract, preserve it unless the task explicitly includes a migration. Apply the ownership, structure, linking, and writing rules immediately, but do not silently rewrite every frontmatter block.

## Current, target, and history

### Current truth

The normal six-zone documents describe what is accepted as true now.

### Active target

A proposed change belongs under:

```text
docs/evolution/changes/active/
```

Its natural content normally makes these points unambiguous:

- the problem and desired outcome;
- the relevant current state;
- the target state and exact delta;
- constraints or invariants that must remain true;
- non-goals;
- affected documents and artifacts;
- acceptance evidence; and
- migration or rollback when relevant.

Do not force all of them as empty headings. Include what the change actually needs.

### Completion

When the change is complete:

1. update the canonical current documents in the relevant six zones;
2. update dependencies and artifacts where necessary;
3. ensure tests, schemas, telemetry, procedures, and messages agree;
4. move the change to `docs/evolution/changes/archive/`; and
5. verify that no current truth exists only in the archived change.

Decisions and records preserve why something changed or what happened. They are not substitutes for current documentation.
