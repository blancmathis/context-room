# Documentation Model

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
- target: `_target.*`, `target/`, or `docs/evolution/changes/active/`;
- historical: archived changes, decisions, and records;
- proposal: shared proposal head, never accepted context before merge.

Legacy `kind`, `scope`, `status`, `canonical_for`, `last_verified`, and `sources` metadata remains readable. Do not rewrite it merely to modernize the format.
