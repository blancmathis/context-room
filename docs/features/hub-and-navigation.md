---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: hub and navigation
  last_verified: 2026-07-27
  sources: [src/context_room.mjs, schemas/config.schema.json, docs/agent-configuration.md]
---

# Hub And Navigation

## Purpose

Home is the first screen for review-first work. It combines a computer-wide local/shared review queue with the current isolated project's Context Health, navigation, and startup environment. The global registry and secondary views are documented in [Global Context Room](context-hub.md).

## Example Flow

1. Open Context Room.
2. Start with the review queue.
3. Open pending review files before using navigation.
4. If nothing needs review, use the explorer or cards to open files, filter folders, or expand child cards.
5. Use breadcrumbs to return through nested cards.

## Rules

- The review queue is the primary hub surface. Do not bury it behind navigation.
- Present Home as a continuous workbench: a compact title bar, native review
  toolbar, hairline-separated review rows, then user sections. Do not restore
  the former cosmic background or floating-card shell.
- The explorer is the direct path to known files and folders.
- Registered Git worktrees appear as one logical project. Explorer selects one concrete worktree at a time inside the global room; it never merges branch file trees or startup environments.
- Worktree grouping is registry-based. Context Room does not discover or scan unregistered worktrees on disk.
- Cards are secondary navigation for stable project areas.
- The aggregate local/shared queue is the normal Home review queue.
- Home is Context Room itself; do not add a permanent Home, Activity, Projects, or Codex prompts tab bar.
- The searchable project picker owns routine project selection. Its **Manage projects…** action opens the complete registry only when needed.
- Context Health, the selected project's `hubSections`, and startup panels follow directly in the same Home; project selection never embeds another Home or duplicates navigation.
- In a global room, a project-inspection panel follows the aggregate queue and keeps both **View Context health** and **View startup environment** visible as disclosure rows. It requires a project or file selection in Explorer, then expands the selected row for the exact worktree without changing the page or analyzing the global host. The panel itself remains visible.
- The project filter scopes only the aggregate queue. Project inspection follows the project or file currently opened in Explorer.
- Shared-only projects stay visible in the project manager and proposal workflows but expose no local cards until a local project location is connected.
- Fresh setup derives cards from paths that exist. It uses nonempty sections for Start here, Current documentation, Target documentation, Decisions, research, and incidents, Documentation to classify, and Agent guidance. Unclassified docs stay visible without being promoted to current truth.
- Startup context, skills, and hooks stay collapsed until needed.
- Cards must point only to paths covered by `allowedPaths`.
- Browser refresh restores the current page, project, worktree, folder, file,
  proposal, history, filters, diff state, and scroll position for that exact
  Workspace.
- Workspace navigation state version 4 lives in `sessionStorage`, including
  Explorer and inspector dimensions. Versions 1–3 may seed the first
  Workspace from the former shared navigation state, but new writes never
  return to the cross-tab `localStorage` key.
- A normal project click reuses the current Workspace. Project and file rows
  remain real links so modified clicks and middle-click open independent
  Workspaces. The context menu also exposes **Open in new workspace**.
- Tabs exchange metadata-only invalidations. Clean files can reload after a
  save elsewhere; dirty files keep their draft and show a conflict. File saves
  and review decisions include the displayed content hash, so stale tabs are
  rejected with `409` instead of overwriting or validating unseen content.
- Settings navigation state also restores its active category and explicit disclosure states. Settings search may open the one matching group, but unrelated navigation never changes disclosure state.
- A current tab binds API requests to the project root established at boot. If the same origin later serves a different root, stale requests are rejected and the tab reloads before its navigation or session state can affect the new room. Browser mutations from an older tab without a project identity are also rejected with `409` and cannot write state until the tab is reloaded.
- The first frame appears only after files, settings, and review data are ready, so the hub never assembles in visible stages.
- Background audits reuse cached results until a relevant file or setting changes; navigation and session-state updates do not rebuild the hub.
- Use child cards for curated structure and `autoChildren` for immediate folder children.
- Keep card titles short.
- Review behavior belongs in [Review Queue](review-queue.md).

## Source Map

- `renderContextRoomGlobalReviewQueue` renders the aggregate queue.
- `renderDocQaDashboard` renders that queue before Context Health and hub folders.
- `renderHubFolders`, `renderHubFolderCard`, and related helpers render the hub.
- `hubSectionsForRoot` and card normalization build the visible card model.
- `buildDocQaReport` builds the changed files queue.
- `schemas/config.schema.json` defines the config shape.
