---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: global Context Room registry and views
  last_verified: 2026-08-04
  sources: [src/context_hub.mjs, src/context_room.mjs, src/context_engine.mjs, src/context_inventory.mjs, src/codex_prompt_center.mjs, src/shared_context.mjs, bin/context-room.mjs, bin/context-room-remote.mjs, docs/features/shared-context.md, docs/features/codex-prompt-center.md, docs/remote-qm.md]
---

# Global Context Room

## Purpose

Context Room has one review-first Home and one global runtime. It aggregates every registered local project and shared-context repository while keeping the selected project's navigation, Context Health, startup context, skills, and hooks directly below the queue.

Each browser tab or window is an independent **Workspace** within that global
runtime. A Workspace is only a view: it owns its selected project, worktree,
folder, file, proposal, history, filters, Explorer state, and open panels. It
is not a project, a documentation source, or another Context Room server.

`Local` and `Shared` describe documentation sources only. Local documents live
with a project and enter its file review queue. Shared documents live in a Git
repository and change through proposals. Neither source creates a separate
room mode.

`context-room hub` is the launcher and `src/context_hub.mjs` owns the computer-local registry, but the UI does not expose a second product surface named Context Hub or a primary tab bar. Context Room itself is Home. Project management and Codex prompt editing use explicit secondary entry points.

| Source | Trusted content | Owner workflow |
| --- | --- | --- |
| Local project | Files inside that project's allowed paths | Select the project in Explorer, edit in the global room, then complete its local review queue |
| Shared repository | The accepted configured default-branch snapshot | Open an exact proposal commit, accept or reject its file reviews, then explicitly put the fully reviewed result on the default branch or reject the proposal |

A project may be local-only, shared-only, or local and connected to shared docs and skills. The UI labels every item by source and explains which review path it uses.

Remote deployments may keep private technical directories for project-scoped
agent capabilities and Shared Context caches. A directory created only for
that purpose is not a local project: it is excluded from the project registry,
local Explorer, editor, and file review queue. When no real checkout is
connected, the project appears as shared-only and all documentation changes go
through Shared Context proposals.

## Start Or Reuse The Global Room

```bash
context-room hub --root .
```

The command initializes and registers the current local project, then starts one global Context Room service. If that service is already healthy, another invocation reuses it and prints a URL focused on the current project instead of starting another service.

Start the global room without registering the current directory:

```bash
context-room hub
```

Inspect the user-local catalog, connect a selected project to a shared
repository, list proposals, or open the project in a Workspace:

```bash
context-room hub status
context-room shared connect --project <project-id> --repository git@github.com:example/company-shared-context.git
context-room proposal list --project <project-id> --session <task-id>
context-room ui open --project <project-id>
```

If the repository contains several possible shared project IDs and Context
Room cannot infer the match, add `--shared-project <shared-project-id>`.

`setup` and `start` register their initialized project and focus it inside the
global room. `init` remains write-only. Shared setup records the repository and
links the local project to its shared project ID. The legacy `--no-local` flag
is still accepted by `hub` for compatibility but is no longer needed.

Every registered Git worktree keeps its own root, branch, configuration, and
local review state. Context Room groups those locations under one logical
project and targets one worktree at a time inside the global room. The stable
group identity uses Git's common directory plus the Context Room root relative
to the Git top level. Non-Git projects keep their path identity. Context Room
never scans the disk for worktrees: only explicitly registered locations
appear.

`hub proposals` exposes the aggregated proposal index to agents and can filter by project or Codex task ID. `hub open` prints a deep link into the running Context Room with the same focus.

Use `context-room ui list --all --format json` to inspect the active Workspaces,
then `context-room ui open --workspace <id> --project <id>` to target one exact
tab. `--session` targets the Workspace paired to a task, and `--recent`
explicitly selects the most recently focused compatible page. Without an exact
selector, Context Room uses the current task session, then the only compatible
Workspace. Several remaining candidates return `workspace_ambiguous` without
moving a page. No compatible page returns `open_required` with a five-minute,
one-use pairing URL; the CLI never chooses or launches a browser.

`ui open` can navigate Home, a project, proposal, file, diff, Graph, Prompt
Center, or a Settings section. It can also apply ephemeral search, filters,
scroll, highlight, and a human-readable tab label. A normal project click
reuses the current Workspace. Modified clicks, middle-click, and **Open in new
workspace** preserve independent browser-tab behavior.

Workspace navigation is stored per tab in `sessionStorage`. Theme, sounds, and
other device-wide preferences remain shared. Duplicate tabs keep their view
but receive a new Workspace identity. In remote mode the server associates a
Workspace with the authenticated user, its project, and an optional task
session. Pairing uses a signed one-use ticket in the URL fragment; the page
checks the human session, exchanges it, and removes the fragment immediately.
The server stores only ephemeral presence and navigation metadata; it never
stores editor drafts, navigation history, pairing tokens, search text in the
audit journal, or document content there.

## Primary Room And Secondary Tools

Home is deliberately review-first. The unified Review Queue remains the first
surface and keeps local files atomic while shared changes remain grouped by
proposal. The project-owned Hub sections directly below the queue are the
primary project navigation. They preserve the names, cards, nesting, and empty
separators configured by the owner instead of inferring a second set of entry
points or domains from filenames. When a project is selected, the compact
Project inspection surface shows only its exact worktree identity, Context
Health, and Agent environment.

Attention uses one compact grammar. Reviews stay first because only a human can
decide them. Other actionable items are ordered as Recheck, Decide, then Fix.
Informational diagnostics stay in Context Health instead of competing with the
Review Queue.

**Home** is the default computer-wide cockpit. Its order is deliberate:

1. one compact, scrollable review queue containing every local file waiting for review and every actionable shared proposal;
2. the current local project's Context Health;
3. the selected project's `hubSections`, startup context, skills, and hooks.

Each local file waiting for review gets its own compact row and opens directly in that project's normal review queue. Local changes are never grouped as a proposal. Each shared proposal gets one visually distinct row because the proposal branch is its review unit. Its current description, exact revision, and up to four changed paths stay visible on Home.

Clicking anywhere on the row shows that proposal's file-review summary immediately while Context Room materializes the exact commit in the background. Every changed path is listed with its change type and review state, and no file is chosen for the owner. Once materialization completes, Context Room switches the summary to the exact proposal room even when no file was selected, so terminal proposal controls use the exact review state and owner nonce. Selecting a file during preparation opens that file in the exact proposal room once ready, with that room's Explorer, file-history arrows, diff control, path, and normal document review UI.

Proposal navigation is integrated into the single workspace bar: a file shows **← Proposal**, and the grouped summary shows progress. **Reject proposal** remains available throughout review. When the last file receives a current decision, **Put on main** appears; Context Room never runs that terminal action automatically. The Context Room logo exits the dedicated review room and returns to the real Home that opened it, preserving its Workspace and selected project while removing proposal-only navigation state. A proposal review worktree never exposes its own Home. When the description exceeds its two-line preview, a compact **+** appears beside it and expands or collapses only the description without opening the proposal.

Rows stay visually clean until the owner starts a selection. Right-clicking an actionable local file or shared proposal opens a compact menu for selecting that item, selecting every visible item, or clearing the current selection. Once one item is selected, left-clicking another row adds or removes it instead of opening it; the proposal description control remains usable.

The selection bar can select or unselect every currently visible item, clear the selection, or reject the selected set. Multi-item and whole-proposal decisions use the explicit double-confirmation checkpoint. Selection may span projects and sources while filters change. Shared proposals leave the active queue while their exact revisions remain archived on `rejected/...` branches.

Local files are not deleted: their reviews are marked **Needs changes** and remain visible until the underlying work is corrected and reviewed again. Accepted proposals and local reviews already marked **Needs changes** cannot be selected for the same rejection action.

The mixed queue interleaves local files and shared proposals without flattening them into the same object. Separate counters report files and proposals. Its search, review-type selector, and project button filter the active queue immediately. Selecting a project resets the review-type selector so a local-only project naturally shows files and a shared-only project naturally shows proposals. Selecting a local review targets its exact registered worktree and opens the file in the same global room. Selecting a shared review opens its exact proposal workspace.

The owner can give logical projects an exact device-wide priority order in
**Settings → Project → Project priority** or through a project's Explorer context
menu. Every registered worktree shares its logical project's rank. The same
order drives Explorer, project pickers, and review ordering; blocking conflicts
still surface first. Projects without an explicit rank retain the normal
current-project, attention, recent-use, and title fallback. Priority is private
local preference: it never changes project config, shared Git history, Home
sections, or review decisions.

Right-clicking one review, selecting several, or right-clicking an Explorer
folder containing active reviews opens the same snooze chooser. It offers quick
durations, a custom number of minutes, hours, days, or weeks, and an exact
return time. Snooze hides only the displayed version from Home; it remains
pending and continues to block any enabled review gate. **Settings → Review and trust →
Snoozed reviews** lists every hidden item and can return it immediately. The
item also returns when its deadline passes. A local content-hash change or
shared proposal-head change returns immediately, so a newer version can never
stay hidden behind an older snooze.

The project button opens one reusable picker popup. The popup shows the complete prioritized project registry in a scrollable list, separates each title from its local path or shared identity, exposes Local and Shared badges, and filters the visible list immediately while the user types. Arrow keys move through the live results, Enter selects one, Escape closes the popup, and **All projects** clears the queue filter. **Manage projects…** at the bottom opens the complete registry without keeping Projects as permanent navigation.

A logical project appears once in Home, the project picker, and the global Explorer even when dozens of its worktrees are registered. Its badge reports the worktree count. Shared proposals remain project-level and therefore appear once. Local reviews remain attached to the concrete worktree that produced them and show its branch label when the group contains several worktrees.

Home stays bounded when the registry contains many projects. It renders at most 80 matching review rows at once, while the searchable popup and **Manage projects…** retain the complete registry.

When at least one file has been opened, the file-history arrows remain visible on Home. **Back** returns to the exact last file without adding Home to the file stack; **Forward** remains available whenever that stack already contains a later file.

The aggregate queue, Context Health, project sections, folder Explorer, and startup panels share one normal Context Room document flow. Global Home always includes a project-inspection panel after the review queue. Until a local project or one of its files is selected in Explorer, it asks the owner to make that selection rather than presenting the global host's diagnostics as project data.

Once selected, **View Context health** and **View startup environment** become two inline disclosure rows for that exact worktree. Opening one reveals its diagnostics in place; selecting it again closes it, and opening the other switches the expanded view. The URL, global Explorer, Review Queue, panel heading, and surrounding Home remain in place. Shared-only projects remain visible in the project registry and shared proposal flows but expose no local inspection until a local folder is connected.

The Explorer folder menu also exposes **Inspect agent environment**. It keeps
the current page and folder selection, asks for Codex, Claude Code, or OpenCode,
then resolves that exact project, worktree, and folder through the shared
[Context Engine](context-engine.md). The inspector separates active, inactive,
disabled, shadowed, uncertain, blocked, and unverified resources. A resource
can be opened without widening `allowedPaths`; **Trace** explains its ordered
application chain and **Show impact** lists only registered consumers.

Opening a grouped project keeps a worktree selector in Explorer and loads the
selected worktree's real file tree. Changing the selection retargets the same
global room. Startup context, skills, hooks, files, and Context Health always
come from that exact worktree rather than being merged across branches.

When a document is open, the project Explorer offers two views. **Location**
shows the existing tree centered on the document and retains the watched
filters. **Related** shows the document's direct accepted sources, references,
and backlinks from the same deterministic [Document Graph](document-graph.md),
plus unresolved explicit references. The selected view is Workspace-local.
Opening another document updates both views but does not switch the view or
open a closed Explorer. **Reveal in Location** expands the current document's
parents and returns to the tree.

Every review item has exactly one source: **Local** for a file or **Shared** for a proposal. A project may be available through both independent sources, in which case the project catalog shows two separate badges rather than inventing a combined source. When the owner selects such a mixed project, Home keeps both review types visible but warns that two documentation review flows are active. **Keep Shared** and **Keep Local** prepare a source-grounded migration prompt in the active Codex composer; they never send the prompt or mutate the project directly.

**Manage projects…** shows every registered project, including clean local projects and shared projects with no local folder. Filters can narrow by project or by local versus shared source. Search covers project names, proposal metadata, paths, sessions, hashes, roots, and repositories.

Repository-wide proposal scopes appear as a dedicated **Global skills** project. They stay searchable and filterable without being duplicated under every project that consumes them.

**Settings → Advanced extensions → Codex prompts** opens a compatible installed Codex runtime's global prompt catalog on demand. It groups every runtime-published target without hardcoding mode or model names, compares official, effective-after-restart, and runtime-loaded versions, and saves exact private overlays. Runtime receipts prove local resolution by target, not mode selection or task delivery. Prompt state is not project configuration and never enters the local or shared review workflow. See [Codex Prompt Center](codex-prompt-center.md).

Keyboard shortcuts inside the secondary views:

- `/`: focus search;
- `j` and `k`: move through visible project-management, review, or prompt items;
- `Escape`: return to the current Context Room.

## Freshness And Isolation

Opening a connected local project refreshes its accepted shared snapshot before
the global room uses it. If the remote is unavailable, the normal
shared-context offline rules apply.

The global server keeps a fixed host identity and requires every project-scoped
file request to carry the exact registered location ID. It resolves that ID
against the local registry before reading or mutating anything, so changing
projects does not widen access or merge worktree state. Shared proposal reviews
still use a temporary exact-commit review worktree because they are immutable
review artifacts, not project-scoped rooms. Home never nests another Home.

The global registry lives at `$HOME/.context-room/hub/registry.json`. The running global-room record lives beside it in `runtime.json`. Device-wide project priority and exact-version review snoozes live in the private, atomic `$HOME/.context-room/hub/attention.json` file. These files are computer-local state, not project truth and not files to commit.

Context Room writes a versioned catalog snapshot to `$HOME/.context-room/hub/snapshot.json` with private `0600` permissions. It contains project identities, registered worktrees, review counters, proposal summaries, Home sections, and freshness metadata, but no document content. The first paint reads that snapshot or the minimal registry without running Git on the critical path. A missing, corrupt, or older snapshot is safe to display only as **Refreshing**; it can never label a project **Up to date** until a background refresh confirms the current state.

The browser requests the project catalog, the paginated review queue, and Home sections separately. Review rows default to 80 per page. The aggregate `/api/context-hub` route remains available for existing consumers. Refresh work is coalesced, runs outside the HTTP critical path, and indexes only registered projects and worktrees. The explicit **Refresh** action rebuilds the snapshot from current local and shared state. Opening a proposal still performs one required remote synchronization before binding the review to its exact head; reopening the same exact head reuses its existing review room without another materialization.

## Source Map

- `src/context_hub.mjs`: global project, shared-repository, runtime registry, private startup snapshot, and device-local attention preferences.
- `src/context_room.mjs`: aggregate state, unified review-first Home, project management, Settings entry to the prompt-center UI, project-room isolation, and full-room proposal navigation.
- `src/codex_prompt_center.mjs`: runtime-published prompt catalog, private overlays, and load receipts.
- `src/shared_context.mjs`: shared-only repository listing, proposal lifecycle signals, and exact review materialization.
- `bin/context-room.mjs`: `context-room hub` commands and automatic registration.
- `src/context_engine.mjs` and `src/context_inventory.mjs`: provider-specific folder inspection shared by the UI and CLI.
- [Context Engine](context-engine.md): accepted context, graph, trace, impact, snapshots, and proposal impact.
- [Shared context](shared-context.md): proposal, acceptance, skills, freshness, and permission contracts.
