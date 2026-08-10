---
context_room:
  id: projection.repository-entry
  depends_on:
    - strategy.context-room
    - product.model
    - projection.documentation.map
---

# Context Room

Context Room is a local-first control room for documentation used by humans and AI agents. It keeps accepted context, pending changes, and human review authority visibly separate.

## Documentation

- [Documentation map](docs/index.md)
- [Product strategy](PRODUCT.md)
- [Product model](docs/product-overview.md)
- [System architecture](docs/system/architecture.md)
- [Shared Context](docs/features/shared-context.md)
- [Human review authority](docs/features/review-authority.md)

The current canonical documentation was rebuilt for the `v0.6.4` baseline. Its source archive and exact digest are recorded in [the v0.6.4 replacement record](docs/lifecycle/records/v0.6.4/documentation-replacement.md).

## Development

Requires Node.js 20 or later.

```bash
npm ci
npm test
node bin/context-room.mjs doctor --root .
```

The CLI entry point is `bin/context-room.mjs`; the main implementation is `src/context_room.mjs`.
