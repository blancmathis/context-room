---
context_room:
  kind: agents
  scope: context-room
  status: current
  canonical_for: repository agent instructions
  last_verified: 2026-08-10
  sources: [README.md, PRODUCT.md, docs/index.md, docs/product-overview.md, docs/system/architecture.md, package.json]
---

# AGENTS.md

## Scope

These instructions apply to this repository. Use them for Context Room product, code, docs, config, tests, and release work.

## Read First

- Documentation map: `docs/index.md`.
- Product strategy and model: `PRODUCT.md` and `docs/product-overview.md`.
- Global local/shared cockpit: `docs/features/context-hub.md`.
- Shared behavior and lifecycle: `docs/features/shared-context.md` and `docs/domains/shared-proposal-lifecycle.md`.
- Human review boundary: `docs/features/review-authority.md`.
- Architecture and runtime profiles: `docs/system/architecture.md` and `docs/system/runtime-profiles.md`.
- Config contract: `schemas/config.schema.json`.
- CLI entry point: `bin/context-room.mjs`.
- Main implementation: `src/context_room.mjs`.
- Tests: `test/context_room.test.mjs`.

## Local Rules

- Keep Context Room local-first and deterministic. Do not add LLM calls to `doctor`, `guard`, or `brief`.
- Keep edit and review boundaries explicit. Changes to `allowedPaths`, `watchAllow`, or `reviewPaths` must be source-grounded.
- Treat review as human-owned. Individual file decisions stay in the direct human UI and are never agent-facing commands. Before an agent operates a multi-file batch or terminal proposal acceptance or rejection, it must ask the user explicitly. After the first yes, restate the exact action, project, proposal or file scope, and effects, ask again, and do nothing unless the user gives a second separate, unambiguous yes.
- Keep executable hooks read-only by default. Only enable hook editing when the project owner asks.
- Replace stale docs instead of adding competing notes.
- Prefer fewer clearer words in docs and UI copy.
- Keep Markdown review focused on human-reviewable docs; do not add code or JSON to review paths unless requested.
- For visual HTML docs, use the injected Context Room components, semantic text, and no scripts or repeated theme CSS.
- Do not diagram simple ideas. Use the diagram grammar only when several relationships, branches, actors, states, boundaries, or layers become easier to track spatially; use metrics only for genuinely quantitative questions.

## Implementation Notes

- `src/context_room.mjs` contains the server, API, file access, review queue, graph, brief logic, and browser UI.
- Prefer small changes inside existing helpers before adding new abstractions.
- When config behavior changes, update `schemas/config.schema.json` and the smallest relevant canonical document.
- When user-facing behavior changes, update or add a focused test in `test/context_room.test.mjs`.

## Verification

Run the narrowest useful check first.

```bash
npm test
node bin/context-room.mjs doctor --root .
```

For package/release work, also run:

```bash
npm run package:privacy
npm pack --dry-run
```
