---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: startup context
  last_verified: 2026-07-27
  sources: [src/context_room.mjs, src/context_inventory.mjs, src/provider_profiles.mjs, src/context_engine.mjs, docs/agent-configuration.md]
---

# Startup Context

## Purpose

Startup context shows instruction files that may affect an agent launched from
the selected project, registered worktree, and folder. The panel and the CLI
use the same [Context Engine](context-engine.md).

## Example Flow

1. Fresh setup enables `startupContext` when the project contains a matching local instruction file.
2. Keep `projectOnly: true` for project-local discovery.
3. To inspect broader context deliberately, set `projectOnly: false` and configure ancestor filenames or explicit global paths.
4. Open matching files from the startup context panel.
5. Use **Trace** when the provider's ordered instruction chain matters.

## Rules

- Project-local instruction files can also appear in the normal explorer. Ancestor and global startup-context files stay outside it.
- Fresh configs are project-only. Existing configs without `projectOnly` retain ancestor discovery for compatibility.
- Global files must be listed explicitly; Context Room does not scan the whole home directory.
- Files outside the Context Room root require one initial review. Context Room stores an observation baseline as soon as each file is discovered, without marking it verified, so edits made before the first human decision still produce a real diff.
- Content changed before Context Room's first observation is recoverable only when Git history, a backup, or another trustworthy snapshot exists.
- Every `AGENTS.md` inside the project is automatically editable and watched, including nested instruction files omitted from configured paths. Its current content hash requires human verification under the same rule as every other watched document.
- Markdown startup files can be backed up and deleted from the panel when supported.
- Do not treat ancestor instructions as project docs unless they are actually inside the project.
- Select Codex, Claude Code, or OpenCode explicitly. Each provider has its own
  recognized filenames, ancestor order, and override behavior.
- The effective chain is calculated from the selected folder rather than from
  the project root alone. Global files load first when the provider profile and
  project settings allow them; project and nested files then follow the
  provider's documented order.
- A discovered file is `uncertain`, not `active`, when available evidence does
  not prove provider activation or precedence.
- Shared proposal instructions are visible only as proposal metadata. They do
  not affect startup context until their accepted result reaches the shared
  repository's configured default branch.
- Shared Instructions may project reviewed Markdown files such as **AGENTS.md**,
  **CLAUDE.md**, or a chosen provider filename into an exact project or device
  target. Startup and the Context Engine treat only managed links to accepted
  main as active shared instructions. A local unmanaged file at the same target
  is preserved and reported as a conflict.

## Source Map

- `listStartupContextFiles` discovers matching files.
- `readStartupContextFile`, `writeStartupContextFile`, and `deleteStartupContextFile` handle file actions.
- `buildStartupContextReviewQueue` adds external changes to review.
- `renderStartupContextPanel` renders the hub panel.
- `src/context_inventory.mjs` resolves folder- and provider-specific instruction chains.
- `src/provider_profiles.mjs` owns the versioned Codex, Claude Code, and OpenCode profiles.
- `src/context_engine.mjs` owns effective, trace, and impact projections.
