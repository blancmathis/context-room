---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: documentation research agent
  last_verified: 2026-07-23
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
  --session "$CODEX_THREAD_ID" \
  --json
```

`--files` supplies vocabulary and task context only. The documentation researcher must not open those files.

From a nested directory, the command walks upward to the nearest initialized Context Room project. If that project has approved shared context, Context Room refreshes the accepted shared snapshot before starting the researcher and uses the verified offline snapshot when refresh is unavailable. `--session` selects pending shared proposals from one Codex task; `CODEX_THREAD_ID` is the fallback.

No local project is required for a shared-only query:

```bash
context-room context ask \
  --repository git@github.com:example/company-shared-context.git \
  --project payments \
  --task "Change session expiration" \
  --session "$CODEX_THREAD_ID"
```

This reads only the selected project's accepted docs and project skills plus accepted global skills. It does not create `.context-room` state or bind the current directory. The accepted Git revision is frozen before the child starts, just like the proposal heads.

## Documentation-Agent CLI

The spawned researcher receives the exact installed CLI path and uses only these commands:

```bash
context-room docs search "session expiration" --status current --limit 8 --budget 1200
context-room docs search "session expiration" --status proposal --session "$CODEX_THREAD_ID"
context-room docs read docs/authentication.md#expiration --budget 1600
context-room docs related docs/authentication.md
context-room docs trace docs/authentication.md#expiration
```

- `search` ranks exact documentation sections with deterministic lexical matching and returns compact snippets. A search without `--status proposal` excludes pending proposal material.
- `read` returns one document or section with its truth state, source, revision, line range, and hash.
- `related` follows declared sources, Markdown or HTML links, and incoming documentation references.
- `trace` exposes canonical ownership, verification date, references, health issues, revision, and content hash.

The CLI indexes Markdown, MDX, text documentation, and semantic HTML exposed through the project's Context Room `allowedPaths`. Shared accepted documentation already mounted read-only by Context Room participates in the same corpus and keeps its accepted Git revision.

When a task already owns shared proposals, Context Room adds their exact commits as a separate session overlay. Project and global proposals may coexist. Every pending document carries its repository path, proposal branch, head, base revision, task ID, title, latest agent recap, review state, conflict signal, and deletion state. Proposals from other sessions remain invisible.

## Research Lifecycle

Every `context ask` call starts a new non-interactive Codex process. Context Room does not resume an earlier research process. The task ID is used only to select the task's pending proposals.

Before launch, the parent process resolves those proposals once and freezes their exact heads. The child receives that frozen manifest through its environment, so later `docs` commands cannot silently move to a newer proposal commit during the same answer.

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

`schemas/doc-context.schema.json` requires one stable result with:

- summary;
- current facts;
- constraints;
- accepted decisions;
- target differences;
- pending changes from this session, kept explicitly non-canonical;
- unknowns and conflicts;
- optional deeper reads;
- examined paths and documentation revision.

Every evidence item carries one exact path, section, truth state, revision, and 64-character content hash. Claims supported by several sections stay separate instead of joining their hashes. `targetDifferences` contains only differences supported by target documentation. Target, draft, historical, superseded, or proposal material must never be presented as current behavior.

`pendingSessionChanges` is the only field allowed to cite a session proposal. Context Room validates each item against the frozen corpus and exact proposal head. Proposal paths, hashes, or truth states are rejected from `currentFacts`, `constraints`, `decisions`, and `targetDifferences`. Missing facts remain explicit unknowns, while `coverage.docsRevision` records the accepted local-plus-shared corpus; pending heads remain attached to their own evidence.

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

| Project mode | Accepted research corpus | Pending session overlay |
| --- | --- | --- |
| Local only | Local Context Room documentation | None |
| Shared only | Selected project's accepted docs and project skills plus accepted global skills | Same-session project and global proposals |
| Shared through a connected project identity | Accepted shared project docs and accepted global/project skills | Same-session project and global proposals |
| Local plus shared | Local docs plus accepted shared snapshot | Same-session project and global proposals |

Local edits continue through the normal review queue. Context Room does not invent local proposal branches. The complete creation, audit, and consumption loop lives in [Documentation lifecycle](documentation-lifecycle.md).

## Source Map

- `src/doc_agent.mjs`: project resolution, documentation corpus, section retrieval, Codex prompt, invocation, validation, and packet rendering.
- `schemas/doc-context.schema.json`: final Codex response contract.
- `bin/context-room.mjs`: public `context ask` and internal `docs` command routing.
- `src/context_room.mjs`: allowed documentation files and graph metadata.
- `src/shared_context.mjs`: accepted shared snapshot freshness, task proposal resolution, and exact-head overlay documents.
- `test/doc_agent.test.mjs` and `test/shared_context.test.mjs`: corpus, retrieval, proposal isolation, frozen provenance, prompt boundary, ephemeral invocation, validation, and rendering coverage.
