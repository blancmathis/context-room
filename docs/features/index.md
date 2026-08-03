---
context_room:
  kind: index
  scope: context-room
  status: current
  canonical_for: features
  last_verified: 2026-08-03
  sources: [README.md, docs/product-overview.md, bin/context-room.mjs, src/context_room.mjs, src/review_authority.mjs, src/context_engine.mjs, src/context_hub.mjs, src/codex_prompt_center.mjs, src/doc_agent.mjs, src/shared_context.mjs, schemas/config.schema.json]
---

# Features

This folder explains Context Room by user-facing feature. Read this when changing product behavior or checking whether a doc update covers the app clearly.

## Start Here

- [Hub and navigation](hub-and-navigation.md)
- [Global Context Room](context-hub.md)
- [Codex Prompt Center](codex-prompt-center.md)
- [File explorer and editor](file-explorer-and-editor.md)
- [Document Graph](document-graph.md)
- [HTML visual documents](html-visual-documents.md)
- [Review queue](review-queue.md)
- [Review authority](review-authority.md)
- [Startup context](startup-context.md)
- [Startup skills](startup-skills.md)
- [Startup hooks](startup-hooks.md)
- [Settings](settings.md)
- [Health, guard, and brief](health-guard-and-brief.md)
- [Documentation research agent](documentation-agent.md)
- [Documentation lifecycle](documentation-lifecycle.md)
- [Document metadata](document-metadata.md)
- [Agent CLI](agent-cli.md)
- [Context Engine](context-engine.md)
- [Shared context](shared-context.md)

## Target Design

- [Context Hub and agent environment target](context-hub_target.md)

## Boundaries

- Config field details live in [Agent configuration guide](../agent-configuration.md).
- Product/source map lives in [Product overview](../product-overview.md).
- Visual component contracts live in [HTML visual patterns](html-visual-patterns.md).
- `Example Flow` sections show one common path, not the full feature surface.
- This folder should stay feature-focused and short.
