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

The active refactor and its measured results are recorded in the [implementation dossier](docs/lifecycle/changes/active/refactor/index.md). Historical release records do not describe this working branch.

## Agent workflow

Any agent harness can use the CLI. Normal search and reading return accepted content. To change documentation, create an isolated proposal, edit its returned directory, then submit it to the human Review Queue:

```bash
context-room docs search "authentication" --root /path/to/project --format json
context-room changes begin --task "Clarify authentication" --root /path/to/project --format json
context-room changes status --change CHANGE_ID --format json
context-room changes submit --change CHANGE_ID --format json
```

Use `--scope shared` when creating a Shared change. Keep the reader token returned by document commands and supply `--reader` on subsequent reads. The [document workflow](docs/features/document-workflow.md) describes accepted versions, formats, migration and the optional tablet bridge.

## Development

Requires Node.js 20 or later.

```bash
npm ci
npm test
node bin/context-room.mjs doctor --root .
```

The CLI entry point is `bin/context-room.mjs`; the main implementation is `src/context_room.mjs`.
