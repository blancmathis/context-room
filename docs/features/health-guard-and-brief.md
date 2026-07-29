---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: health guard and brief
  last_verified: 2026-07-27
  sources: [src/context_room.mjs, src/context_diagnostics.mjs, src/agent_cli.mjs, bin/context-room.mjs, src/doc_metadata.mjs, docs/agent-configuration.md]
---

# Health, Guard, And Brief

## Purpose

These surfaces turn project docs into local proof: health issues, review signals, and deterministic task context.

## Example Flow

1. Run `context-room doctor` after config or doc architecture changes.
2. Choose the owner review-gate operations in Settings, then install the matching local hooks.
3. Run `context-room context ask "..."` when an agent needs accepted project documentation.

## Rules

- `doctor` reports health; strict mode fails on high-impact issues.
- Document Health reports malformed YAML or JSON, invalid or conflicting profiles, schema failures, sidecar conflicts, invalid or duplicate identities, unresolved and ambiguous links, missing declared dependencies, cycles, unavailable renderers, and stale dependency observations.
- Doctor accepts structured project, location, folder, provider, shared,
  severity, query, cursor, and limit filters. `--all-projects` inspects only
  explicitly registered locations and filters before expensive diagnostics.
- `doctor explain <issue-key>` returns the selected structured issue, evidence,
  and explanation without mutating state.
- `doctor plan <issue-key>` previews a deterministic safe repair only when an
  exact primitive exists. Otherwise it returns `repairable: false` and a manual
  action. A plan never widens `allowedPaths`, removes watch rules, rewrites
  documentation, changes an unknown hook, or changes a review decision.
- Context Health stays available even when no triggered issue is open. `Refresh all` forces a complete fresh analysis, resets the view filters to all states, severities, and areas, and keeps existing `OK` decisions intact.
- The State, Severity, and Area filters control only which results are visible. They never disable a health check. Areas separate configuration, documentation, references, review safety, startup context, and hooks.
- **Fix in Codex** adds the issues currently visible after those filters to the active Codex composer with a source-grounded fix prompt. It preserves the existing draft and never sends the message automatically. If the local composer bridge is unavailable, Context Room copies the prompt instead.
- The web UI can mark a health issue `OK`; the default Open view hides it until the issue changes. `Open + OK` and `OK only` make acknowledged results visible again, while `doctor` always reports them.
- `guard` and `review-only` report without blocking. Only explicit strict mode can fail.
- `guard --operation commit|push|pull-request|merge` follows the local owner policy. A selected operation fails when review is pending.
- Context Room manages local hooks for commit, push, and local merge commits without overwriting custom hooks. Pull requests and hosted merges require a provider check and repository rule.
- Review-gate operation policy is local owner state, separate from project config and unavailable to the agent CLI.
- `context ask` is the compact agent entry point for task-specific documentation research.
- Generic interpreted metadata, declared and reference-strength relations, Mermaid node text, ambiguities, and dependency freshness improve research ranking and evidence. Existing Markdown still works and no profile becomes universally mandatory.
- The web UI refreshes shared reports in the background and reuses one project scan.

## Source Map

- `buildDocumentationGraph` creates graph nodes, edges, and health issues.
- `buildContextRoomDoctorReport` packages health output.
- `src/context_diagnostics.mjs` normalizes structured issue identity, filters
  without parsing messages, explains issues, and constrains repair plans.
- `healthIssueCategory` assigns every issue to one stable Context Health filter area.
- `buildContextHealthCodexPrompt` turns only the currently shown issues into a repair request without treating diagnostics as executable instructions.
- `buildContextRoomReports` and `background_worker.mjs` keep web reports off the HTTP critical path.
- The local health acknowledgements runtime file stores `OK` decisions.
- `buildDocQaReport` powers review state and guard decisions.
- `buildAgentBrief` ranks read-first docs.
- `src/document_metadata_engine.mjs` preserves and interprets Markdown, MDX, HTML, sidecar, YAML, and JSON metadata. `parseDocMetadata` remains the compatibility projection for the official profile.
