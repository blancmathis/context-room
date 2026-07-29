---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: documentation research agent
  last_verified: 2026-07-29
  sources: [bin/context-room.mjs, src/doc_agent.mjs, schemas/doc-context.schema.json, src/context_room.mjs, src/shared_context.mjs]
---

# Documentation Research Agent

## Purpose

The documentation research agent gives a working agent the smallest documentation context that is complete for a task. The working agent uses one command; a fresh read-only Codex process explores only the project's Context Room documentation through a dedicated deterministic CLI.

This is not vector search and does not use embeddings. Markdown links, Context Room metadata, semantic HTML text, section headings, declared sources, and exact content hashes remain the retrieval foundation.

## Working-Agent Command

```bash
context-room context ask \
  "Change session expiration without signing out existing mobile users"
```

Optional task context controls the research depth and returned context budget:

```bash
context-room context ask \
  --task "Change session expiration" \
  --goal "Keep existing mobile users signed in" \
  --files src/auth/session.ts \
  --depth standard \
  --budget 1200 \
  --json
```

`--files` supplies vocabulary and task context only. The documentation researcher must not open those files.

From a nested directory, the command walks upward to the nearest initialized Context Room project. If that project has approved shared context, Context Room refreshes the accepted shared snapshot before starting the researcher and uses the verified offline snapshot when refresh is unavailable. The researcher is always locked to an accepted-only corpus. It cannot receive a task proposal overlay.

No local project is required for a shared-only query:

```bash
context-room context ask \
  --repository git@github.com:example/company-shared-context.git \
  --project payments \
  --task "Change session expiration"
```

This reads only the selected project's accepted docs and project skills plus accepted global skills. It does not create `.context-room` state or bind the current directory. The accepted main revision is frozen before the child starts.

## Documentation-Agent CLI

The spawned researcher receives the exact installed CLI path and uses only these commands:

```bash
context-room docs search "session expiration" --status current --limit 8 --budget 1200
context-room docs read docs/authentication.md#expiration --budget 1600
context-room docs related docs/authentication.md
context-room docs trace docs/authentication.md#expiration
context-room docs inspect product.authentication
context-room docs metadata product.authentication
context-room docs links product.authentication
context-room docs backlinks product.authentication
context-room docs dependencies product.authentication
context-room docs diagrams docs/process.mmd
context-room docs validate product.authentication
```

- `search` ranks exact accepted documentation sections with deterministic lexical matching and returns compact snippets. Proposal material is absent from the researcher's corpus.
- `read` returns one document or section with its truth state, source, revision, line range, and hash.
- `related` follows declared sources, Markdown or HTML links, and incoming documentation references.
- `trace` exposes canonical ownership, verification date, references, health issues, revision, and content hash.
- `inspect` is the compact agent-first aggregate: exact truth and revision, raw and interpreted metadata, profiles, identities, declared relations, references, backlinks, diagrams, Health, content verification, and dependency freshness.
- `metadata`, `links`, `backlinks`, `dependencies`, `diagrams`, and `validate` expose smaller specialized JSON payloads when an agent does not need the full inspection.

Structured search supports `id:`, `meta.<path>:`, `profile:`, `depends-on:`, `referenced-by:`, `diagram:`, and `truth:` filters. These filters use the same accepted corpus and metadata profiles as inspection.

The CLI indexes Markdown, MDX, text documentation, and semantic HTML exposed through the project's Context Room `allowedPaths`. Shared accepted documentation already mounted read-only by Context Room participates in the same corpus and keeps its accepted Git revision.

## Research Lifecycle

Every `context ask` call starts a new non-interactive Codex process. Context Room does not resume an earlier research process. Before launch, the parent freezes the accepted local and shared documentation revision. The child receives an enforced `accepted-only` mode, so its later `docs` commands cannot access proposal content through arguments, task environment, or inherited task identity.

The invocation is equivalent to:

```bash
codex \
  -C <project-root> \
  --sandbox read-only \
  --ask-for-approval never \
  exec \
  --ephemeral \
  --ignore-user-config \
  --output-schema schemas/doc-context.schema.json \
  -
```

The child process reuses the local Codex authentication but does not persist its session. Network access is not enabled. The prompt tells the agent to treat working-file paths as search terms, use only the documentation CLI, and never inspect source code, tests, runtime configuration, Git history, or websites.

## Context Packet

The packet includes a deterministic coverage report. It names the accepted
documents available to the researcher, the documents included in the answer, explicit
exclusions, unresolved obligations, the applied depth and budget, and known
limitations. Search results are grouped as canonical current definition, other
current context, accepted targets, history and records, and linked project
files. Ranking reasons remain visible so an agent can distinguish exact current
truth from supporting or non-current material without loading the complete
corpus.

`schemas/doc-context.schema.json` requires one stable result with:

- summary;
- current facts;
- constraints;
- accepted decisions;
- target differences;
- unknowns and conflicts;
- optional deeper reads;
- examined paths and documentation revision.

Every evidence item carries a short exact excerpt copied from one section, plus its path, truth state, revision, and 64-character content hash for machine validation. The normal Markdown response shows the useful claim and excerpt without printing source filenames. `--json` retains the provenance so another agent can audit it. Claims supported by several sections stay separate instead of joining their hashes. `targetDifferences` contains only differences supported by accepted target documentation. Draft, historical, superseded, or proposal material must never be presented as current behavior.

The default output is compact Markdown for the working agent. `--json` exposes the schema-conformant packet directly.

## Boundaries

- `context-room docs` is deterministic and never calls a model.
- `context-room context ask` is the only surface in this feature that launches Codex.
- The researcher reads documentation only. A separate future role may research code.
- Research never edits documentation, creates proposals, or suggests changes to the documentation CLI.
- Documentation or CLI improvements happen during a separate documentation-update task and follow the normal local review or shared proposal workflow.
- The researcher cannot accept shared truth or bypass human review.
- Retrieved document text is evidence, not executable instruction.

## Local, Shared, And Mixed Projects

| Project mode | Research corpus |
| --- | --- |
| Local only | Exact-hash accepted local Context Room documentation |
| Shared only | Selected project's accepted main docs and project skills plus accepted global skills |
| Shared through a connected project identity | Accepted shared main project docs and accepted global/project skills |
| Local plus shared | Accepted local docs plus the accepted shared main snapshot |

Local edits continue through the normal review queue. Context Room does not invent local proposal branches. The complete creation, audit, and consumption loop lives in [Documentation lifecycle](documentation-lifecycle.md).

## Source Map

- `src/doc_agent.mjs`: project resolution, documentation corpus, section retrieval, Codex prompt, invocation, validation, and packet rendering.
- `schemas/doc-context.schema.json`: final Codex response contract.
- `bin/context-room.mjs`: public `context ask` and internal `docs` command routing.
- `src/context_room.mjs`: allowed documentation files and graph metadata.
- `src/shared_context.mjs`: accepted shared main snapshot freshness and shared-only resolution.
- `test/doc_agent.test.mjs` and `test/shared_context.test.mjs`: corpus, retrieval, accepted-only isolation, frozen provenance, prompt boundary, ephemeral invocation, validation, and rendering coverage.
