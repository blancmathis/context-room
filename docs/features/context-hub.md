---
context_room:
  id: product.hub.global
  depends_on:
    - product.model
    - domains.truth.layers
    - domains.shared.proposal-lifecycle
    - system.runtime-profiles
---

# Global Context Hub

## Summary

The Context Hub is always the global level. Starting Context Room from a project or worktree opens the global Hub, registers that location when needed, selects it, and leaves the global view reachable.

## Defines

This document defines Hub aggregation, project and worktree identity, selection, navigation, and observable unavailable or recovery states.

## Does not define

This document does not define registry JSON, filesystem transaction internals, Shared proposal algorithms.

## Launch behavior

`context-room`, `context-room start`, `context-room setup`, and `context-room ui open` resolve to the global Hub.

When invoked from or for a local project or worktree, Context Room:

1. initializes the local project when required;
2. registers the exact location in the private Hub registry;
3. groups it with locations that share the same logical Git identity;
4. opens or reuses the loopback Hub server;
5. selects the requested location.

The Hub host has no broad project allowlist. Project data is loaded through exact registered capabilities.

## Logical projects and locations

A logical project represents one project across one or more registered Git worktrees. Each location keeps its physical root, branch, revision, availability, local configuration, review state, and health state.

The logical group keeps shared product identity, display order, and one Shared binding. Connecting or disconnecting Shared Context applies to the exact registered locations through a capability-bound transaction.

Context Room does not discover every Git worktree implicitly. A worktree appears after explicit registration or launch.

## Global aggregation

The Hub aggregates local logical projects and locations, registered Shared repositories, accepted Shared projects, active proposals, local file reviews, Shared proposal reviews, and recovery/attention states.

Several Shared repositories can coexist. Repository identity remains part of project and proposal keys so equal project IDs or branch names do not collide.

## Selection

Selecting a local location immediately changes project-specific Explorer, Settings, Startup environment, effective-context queries, and actions. Background refresh cannot delay the visible selection; if the exact project cannot be opened, Context Room restores the previous selection and URL.

Selecting a Shared-only project exposes accepted Shared content but no local project Settings.

Selecting a proposal opens exact proposal review without making the proposal effective.

Clearing selection returns to the global Hub.

## Proposal opening

The Hub follows the proposal projection defined by [Shared Proposal Lifecycle](../domains/shared-proposal-lifecycle.md#hub-projection). `ready`, `in_review`, and `updated` proposals are active and openable. A proposal already integrated into accepted main, a terminal proposal, or a proposal whose branch no longer exists is absent from the active list. Pending recovery remains visible only while a live, non-integrated proposal branch still requires action.

Opening an active proposal keeps the proposal surface visible while Context Room verifies and materializes the exact review. The surface shows the known repository, branch, and head immediately, reports preparation honestly, and does not claim readiness before exact review is available.

After a fresh local Hub snapshot, Context Room prepares the exact review authority, proposal-only DocQA projection, and response payload without creating a human decision. Proposal records expose `openReadiness` as `preparing`, `ready`, or `blocked`; the open action remains disabled until `ready`. A stale snapshot always reports an otherwise active proposal as `preparing`, including when an exact room was restored after restart.

Active review authorities are re-indexed from private persisted evidence after restart, so an unchanged exact room can be reused without a global proposal scan or rematerialization. Legacy active proposals that predate protected proposal-state refs use that fast path only after a fresh Hub snapshot has verified the exact main and proposal heads, conflict result, and absence of terminal or recovery evidence.

Opening stays in the current browser document. A stable proposal shell appears immediately, and the prepared review is adopted in place; Explorer and unrelated reports are not loaded as part of proposal verification. `POST /api/context-hub/review` reports `exact-ref`, `room`, `docqa`, and `payload` durations through `Server-Timing`.

If that snapshot becomes stale, terminal, unavailable, or recovery-required during opening, the proposal surface transitions inline and offers an explicit refresh, recovery, retry, or return action. An opening result or failure never silently clears selection or sends the user back to the Hub.

## Home

The Hub home starts with the project list. Each row shows the project, its location,
an attention pill, and three destinations: Context (agent environment), To review
(Review Queue filtered to the project), and Documents (the project's documentation map, with its files in Explorer).

The order is the manual project order, then the title. Attention, opening a project,
and refreshes never reorder the list. The header shows local coverage, for example
`1/7 local inspected`.

⌘K (Ctrl+K) opens the project picker to go to a project: type, then press Enter.

The active project and the Review Queue filter are separate scopes. Opening a
project, in Explorer, with ⌘K or with Back and Forward, does not change the
filter. Only To review, the queue's Project filter, and opening a review set it.
A link that names a project (`?project=`) filters the queue to that project once;
a reload keeps the filter the tab had.

When the reviews of a project are fully known, the header also says what changed
since this browser last left Context Room: new, updated, and no longer pending
reviews, by project. Local reviews have no date, so the comparison uses each
review's identity and revision, stored in the browser only.

## Recovery and unavailable state

Registry and Shared-binding mutations use private journals and exact capability checks. If recovery is ambiguous, Context Room blocks further mutation and surfaces recovery-required rather than guessing.

An unavailable worktree remains identifiable as a registered location. Context Room does not reinterpret another path as that location.

Project rows show `Unavailable · reason` for a missing folder, changed folder identity,
denied access, or unavailable project configuration. Shared-only rows name the absence
of a local folder. An available worktree represents a logical project before any
unavailable location, including a previously selected location.

An uninspected location has an unknown local review count (`—`), not zero. A group
with an uninspected worktree also has an unknown total. The global queue keeps known
reviews visible, names incomplete local coverage, and does not claim `All clear` or
`0 files` until every local location is inspected and the snapshot is current.

Registering a changed folder still requires an explicit new Shared connection: it
never inherits the previous folder's binding. The registration result identifies
the binding not carried over (repository, project ID and reason). Launch and project
registration commands print one warning and direct the owner to re-link it in Hub
project settings. Unavailable Shared-linked location details warn about this effect
before re-registration.

### Location continuity after a restart

macOS can give a disk a new device number after a restart. Each registered location
keeps a durable identity (inode and birth time) and a signed attestation stored
outside the project, in the review authority directory.

- **Same durable identity:** the location stays available. Context Room records the
  new device number as an observed alias. Notebooks, conversations, local proposals,
  workflow state and Shared accept it without a gesture.
- **Registered before durable identities:** a changed device number shows
  `Unavailable · identity to confirm`. The owner checks the folder and uses
  **Confirm location** once (owner-only `POST /api/context-hub/confirm-location`
  with the exact project ID, root and stored identity). Context Room adds the earlier
  identities found in the project's own records, at the same inode, as confirmed
  aliases. No project file is rewritten. Drawing grants accept only observed
  continuity: pair drawing tablets again.
- **Replaced folder:** a different inode, birth time or Git worktree membership
  shows `folder identity changed`. Confirmation refuses it; register the folder as a
  new location.

Registering an unconfirmed location again leaves the registry unchanged and reports
`identityUnconfirmed: true`. Notebook capabilities list `serverIdAliases`, so a
browser moves offline caches saved under an earlier identity to the current one. A
cache that cannot move, because a newer cache holds the current identity, stays in
the offline list and opens as itself.

Confirmation reads only the root identity field of each record kind, through paths
without links. If the attestation is lost while the registry's durable identity
still matches, the registry's previous identity becomes a confirmed alias.

## Local review

The global queue also includes submitted local proposals and changed image assets. Local drafts stay out of the queue until submitted. Each proposal opens an exact before/after file review. [Document workflow](document-workflow.md) owns acceptance, correction, cleanup and recovery behavior.

A selection keeps the exact version that was checked: its content, mode and accepted dependencies. If a refresh brings a newer version, the row shows "Changed since selected" and the selection actions skip it until it is selected again. Accepting a selection is all-or-nothing before the first write: if any selected file changed, nothing is accepted and the changed files are listed. Once writes start, accepted files stay accepted and each file that fails is listed with its reason. A failure to record the review event after a decision is saved is a warning, not a failed decision.

## Action-changing errors

- **Location unavailable:** restore or explicitly remove the registered location.
- **Location to confirm:** check that it is the same folder, then confirm it once.
- **Registry recovery required:** resolve recorded recovery before another group mutation.
- **Shared repository unavailable:** mutations fail closed; permitted read surfaces may use exact verified cached state.
- **Stale selection:** the selection keeps the checked version; select the item again to act on the newer one.
