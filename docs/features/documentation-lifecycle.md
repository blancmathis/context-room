---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: documentation creation audit and consumption lifecycle
  last_verified: 2026-07-29
  sources: [bin/context-room.mjs, src/doc_agent.mjs, src/shared_context.mjs, docs/features/documentation-agent.md, docs/features/shared-context.md]
---

# Documentation Lifecycle

## Purpose

Context Room separates three responsibilities so documentation can stay complete without letting agents make accepted truth by themselves.

| Loop | Actor | Result |
| --- | --- | --- |
| Create or update | Working agent with the documentation-maintenance skill | Local review changes, a shared project proposal, a shared global proposal, or a combination |
| Audit | Scheduled documentation auditor | No change when clean; otherwise the same human-reviewable routes |
| Consume | Fresh read-only documentation researcher | A compact evidence packet for one working task |

## 1. Create Or Update

The maintenance skill first finds the canonical owner with `docs search` and `docs trace`. It applies the normal documentation quality rules, then routes each change independently:

The official documentation skill creates ordinary documents with the minimal `id` and optional `depends_on` convention described in [Document Metadata](document-metadata.md). Context Room itself accepts other metadata contracts through profiles. A newly accepted dependency version creates a freshness task for direct dependents without revoking their accepted content; confirming unchanged freshness does not propagate another invalidation.

- local canonical owner: edit the local file and leave it in the normal Context Room review queue;
- shared project docs or skill: create or reuse a project proposal;
- shared global skill: create or reuse a global proposal;
- mixed change: use all required routes without copying one fact into several owners.

If a durable fact is unresolved, the agent asks the user focused questions instead of writing an assumption. After the answer, it resumes the same workflow.

For shared content, `edit` uses `CODEX_THREAD_ID` or `--session` and returns a change handle plus the exact proposal worktree. The identity is the shared repository, project scope, and task ID. A later message in the same task therefore returns the same open proposal worktree. A terminal accepted or merged proposal is not reopened; the next update creates a new one. There is no agent-facing publish or acceptance step.

The default agent-facing route is `ask` for accepted documentation. Shared documentation changes use `edit`; the CLI never accepts, rejects, or verifies a file review.

The proposal description is temporary review context: it explains the intended change before the owner reads the diffs, but it never becomes accepted project truth by itself.

## 2. Audit

The audit begins read-only and uses only accepted local and shared documentation. It checks internal coherence, canonical ownership, current-versus-target separation, references, and recent project-bound Codex tasks.

Recent tasks are read through the official Codex task tools and selected by canonical project root or a verified worktree. Explicit later user decisions and corrections may justify a change. Brainstorming, agent speculation, missing evidence, and unrelated tasks do not.

Each finding has one outcome:

- certain durable inconsistency: invoke the maintenance workflow;
- ambiguous: report the smallest question and make no change;
- non-durable: ignore it.

A clean audit creates nothing. The Codex desktop scheduler runs this loop for selected large projects; Context Room itself remains scheduler-independent. A scheduled shared audit uses a stable session such as `audit-<project-id>-nightly`, so repeated runs update one open proposal until a human completes it.

## 3. Consume

The working agent calls `context-room ask` with a complete research brief: task context, questions to resolve, constraints to verify, and the desired output. It must not reduce the request to keywords. It may use the detected or explicitly selected registered project, or target shared-only context with `--repository <git-url> --shared-project <shared-project-id>`. A new read-only Codex process uses only the deterministic documentation CLI, returns a schema-constrained packet, then exits.

Accepted local and shared docs supply the complete research corpus. Shared-only research includes accepted project docs plus accepted project and global skills, without creating a local Context Room project. Proposal branches are not mounted, summarized, or exposed to the researcher. The accepted shared main revision is frozen for the full call.

If the packet exposes a blocking unknown, the working agent asks the user. A durable answer then returns to loop 1. The documentation researcher itself never edits docs or improves the CLI.

## Trust Boundary

- Local review remains human-owned.
- Shared `main` and accepted snapshots remain read-only to agents.
- Agents may push only proposal branches; only the human proposal action can
  publish the reviewed result to the configured shared default branch.
- A proposal recap helps review but does not replace the diff.
- A scheduled audit may propose a correction but cannot accept or merge it.
- Only accepted shared content on `main` and reviewed local content become normal accepted research input.

## Skills

The recommended shared global skills are:

- `context-room-documentation`: create or update documentation through the correct local, shared project, shared global, or mixed route;
- `context-room-documentation-audit`: audit accepted documentation and recent project tasks, then invoke the maintenance skill only for certain durable inconsistencies.

When accepted in a shared repository, Context Room links them from the immutable
snapshot into the provider-profile destination. Codex uses
`~/.agents/skills/` device-wide and `.agents/skills/` inside a project.
Project-specific documentation skills use the same accepted-snapshot mechanism.
