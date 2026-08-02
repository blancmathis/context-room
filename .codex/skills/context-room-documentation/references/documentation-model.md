# Documentation Model

## Canonical architecture

Use the smallest relevant subset of this vocabulary:

| Area | Owns |
| --- | --- |
| `strategy/` | Purpose, audiences, positioning, goals, and principles |
| `product/` | Offer, capabilities, behavior, journeys, experience, and policies |
| `domains/` | Optional stable business boundaries, language, models, events, and implementation-independent invariants |
| `system/` | Architecture, components, technical data, flows, and contracts |
| `operations/` | Delivery, support, deployment, observability, and project operation |
| `assurance/` | Requirements and evidence for reliability, security, privacy, compliance, and risk |
| `lifecycle/` | Accepted future targets, significant decisions, and historical records |

Areas own current truths. Domains orient a stable business perimeter and link to
the product, system, operations, and assurance owners needed to understand it;
they do not copy those truths. When technical documentation needs the same
navigation perimeter, place it under `system/areas/<area>/`, not under a second
`system/domains/` taxonomy. The vocabulary is not a checklist, so do not create
empty directories. Put user-visible features under
`product/capabilities/<capability>/` and create a domain only when a stable
language, model, boundary, or invariant needs its own owner.

Keep three document roles distinct: an owner defines durable truth, a
projection selects or presents owners, and a generated view is rebuilt from
metadata and links. Maps and HTML views normally project; backlinks and the
relation inventory are generated. A focused model may own one exact relation
only when its `Defines` section says so explicitly.

For large corpora, navigate progressively from project map to domain map, then
to a capability or `system/areas/<area>/` map, and finally to a focused flow,
state, sequence, or boundary model. Skip levels that do not improve navigation
and keep every child reachable from a parent or another intentional entry point.

## New-document metadata

Use the minimal contract:

```yaml
---
context_room:
  id: product.review.human-approval
  depends_on:
    - strategy.trust.human-control
---
```

`id` is stable across file moves. Use lowercase dot-separated segments; hyphens may appear inside a segment. `depends_on` contains stable document IDs, not paths.

An ordinary document should contain:

```markdown
# Title

## Summary

## Defines

## Does not define
```

Add further sections only when they own durable facts.

## Meaning of a dependency

`A depends_on B` means a newly accepted version of B can invalidate the human understanding captured in A. Context Room therefore asks a human to revalidate A. It is stronger than a link or citation.

Use an ordinary Markdown, HTML, or `cr://` reference when a document merely mentions or navigates to another document.

## Truth layers

- current: ordinary managed documentation, after exact-hash human validation;
- target: `_target.*`, `target/`, or `docs/lifecycle/changes/active/`;
- historical: `docs/lifecycle/changes/archive/`, decisions, and records;
- proposal: shared proposal head, never accepted context before merge.

Legacy `docs/evolution/changes/...`, `quality/`, `kind`, `scope`, `status`,
`canonical_for`, `last_verified`, and `sources` remain readable. Do not rewrite
paths or metadata merely to modernize the format. Stable IDs do not change when
a document moves.
