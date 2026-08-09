---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: hub and navigation
  last_verified: 2026-08-09
  sources: [src/context_room.mjs, bin/context-room-remote.mjs, schemas/config.schema.json, docs/agent-configuration.md, docs/remote-qm.md, test/e2e/hosted-profiles.spec.mjs]
---

# Hub And Navigation

## Purpose

Home is the first screen for review-first work. In the local profile, it combines a computer-wide local/shared review queue with the current isolated project's Context Health, navigation, and startup environment. Hosted Home is instead the Shared-only Hub or one exact proposal review; it has no local Explorer, local project creation, Settings, Startup resources, computer view, or Codex prompt surface. Its only project-creation exception is the proposal-only **New shared project** action for an exact repository whose operator scope includes `projects`; it never registers a local project or widens the immutable Hosted allowlist. The global registry and secondary views are documented in [Global Context Room](context-hub.md).

## Example Flow

1. Open Context Room.
2. Start with the review queue.
3. Open pending review files before using navigation.
4. If nothing needs review, use the explorer or cards to open files, filter folders, or expand child cards.
5. Use breadcrumbs to return through nested cards.

## Rules

- The review queue is the primary hub surface. Do not bury it behind navigation.
- Unless a rule explicitly says Hosted, the local project, Explorer, Settings,
  and startup rules below apply only to the local profile.
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
  and review decisions include the displayed content hash. Revert includes the
  displayed diff revision, while delete uses a preview manifest containing the
  exact revision of every selected file or folder member. A stale operation is
  rejected with `409` before any newer content is overwritten, validated,
  reverted, or removed.
- Settings navigation state also restores its active category and explicit disclosure states. Settings search may open the one matching group, but unrelated navigation never changes disclosure state.
- A current tab binds API requests to the project root established at boot. If the same origin later serves a different root, stale requests are rejected and the tab reloads before its navigation or session state can affect the new room. Browser mutations from an older tab without a project identity are also rejected with `409` and cannot write state until the tab is reloaded.
- Workspace and project requests follow [Server boundary](../assurance/server-boundary.md): untrusted origins cannot mutate the registry, malformed input remains request-local, and project coordinates never widen the selected root.
- Home, project navigation, the responsive Explorer, menus, dialogs, and terminal controls follow [Interface accessibility](../assurance/interface-accessibility.md).
- The protected boot shell becomes visible after its initial styles, profile,
  and safe default state are installed. The workbench is revealed only after
  Workspace identity, core project data, and requested navigation are restored;
  background reports may then render asynchronously. Hosted profile CSS hides
  every forbidden local control before first paint, and later data renders must
  update in place without granting a capability before its server response
  arrives.
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
