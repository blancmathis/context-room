---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup skills
  last_verified: 2026-07-29
  sources: [src/context_room.mjs, src/context_inventory.mjs, src/provider_profiles.mjs, src/context_engine.mjs, src/shared_context.mjs, docs/agent-configuration.md, docs/features/shared-context.md]
---

# Startup Skills

## Purpose

Startup skills show every skill folder that may affect future agent behavior, including managed collections projected from an accepted shared-context snapshot.

Startup skills and Shared skills answer different questions. Startup skills discover what is locally available around the selected project or folder. Shared skills manage reviewed canonical skill content, accepted assignments, and the managed links that expose that content to providers.

Shared instructions use the same provider preference but report two separate
facts. **Installed** means Context Room created the managed link. **Active**
means the selected provider is proven to discover its destination. An
arbitrary shared filename can therefore be installed while remaining inactive
until it targets a native provider filename or local provider configuration
explicitly names it. Startup environment lists effective instructions first
and keeps installed-but-undiscovered resources separate.

## Example Flow

1. Fresh setup enables `startupSkills` immediately, including before a configured local skill root exists.
2. Keep `projectOnly: true`, or deliberately opt into ancestor skill roots for a broader room.
3. Open a discovered skill from the startup skills panel.
4. Review each discovered skill entrypoint once to establish its trusted content.
5. Create or delete skills only in writable skill folders.

## Rules

- System skill folders are read-only.
- Accepting the current content of a changed system skill records the review without rewriting the file. A reject or mixed decision that would change the file is blocked and returns the review to an actionable state.
- Fresh configs keep startup skill discovery enabled and discover project skill roots only. A configured skill root added later appears automatically. Existing configs without `projectOnly` retain ancestor discovery for compatibility.
- Codex discovery and managed Shared Skills use the same provider profile:
  `.agents/skills` for a project and `~/.agents/skills` for the device. Existing
  `.codex/skills` content may still be shown as legacy, but Context Room never
  rewrites or removes an unmanaged legacy location.
- Writable skill folders can create a new skill from the panel.
- Startup skills can be opened in the explorer without broadening the whole project allowlist.
- Every discovered skill entrypoint enters review once, then re-enters only after its meaningful content changes.
- At first discovery, Context Room stores an observation baseline immediately without accepting or trusting the skill. If the file remains unchanged, the initial review still offers `Accept document` or `Request changes` for the whole document.
- Any edit after that first observation uses the stored baseline and normal line-level accept/reject diff, even when the initial human review has not happened yet.
- Context Room cannot infer content that changed before its first observation when no Git history, backup, or recoverable snapshot exists. A recovered snapshot can be imported as the baseline without accepting or modifying the current skill.
- Repo skills already covered by a Git-backed queue item are deduplicated in favor of that richer diff.
- A managed shared destination is listed separately from ordinary discovered folders. It shows the shared repository, collection, provider, assignment scope, shared-or-local origin, physical destination, accepted revision, current state, and individual skill names.
- Local discovery follows the selected folder and provider profile. It does not
  merge same-named skills by heuristic, and an unproven duplicate or precedence
  remains `uncertain`.
- Shared skills remain read-only. Editing one must happen in a `skills` proposal, not through the startup file editor.
- In the global Context Room, Startup environment always follows the project/worktree selected in Explorer. With no selection it asks for one instead of combining unrelated startup environments.
- Provider-disabled or unavailable destinations, unmanaged collisions, stale links, local overrides, and registered-worktree reconciliation failures also surface in Context health.
- `context effective`, Startup environment, Shared Skills Settings, and Context
  Health use the same accepted Shared Skills projection. An open skills
  proposal never changes effective skills until its result reaches the
  configured shared default branch.

## Source Map

- `listStartupSkillFolders` discovers skill roots.
- `readStartupSkillFile`, `writeStartupSkillFile`, `createStartupSkillFile`, and `deleteStartupSkill` handle skill actions.
- `startupSkillExplorerRootPath` exposes one active skill folder to the explorer.
- `buildStartupSkillReviewQueue` adds initial and changed skill reviews.
- `writeDocReviewBaselineContent` imports a recovered pre-edit snapshot without recording a review decision.
- `renderStartupSkillsPanel` renders the hub panel.
- `src/context_inventory.mjs` resolves provider- and folder-specific local skill roots.
- `src/context_engine.mjs` combines local and accepted shared skills without heuristic identity merging.
