---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: shared context repositories
  last_verified: 2026-08-06
  sources: [src/shared_context.mjs, src/review_authority.mjs, src/provider_profiles.mjs, src/context_engine.mjs, src/context_inventory.mjs, src/context_snapshots.mjs, src/context_diagnostics.mjs, src/context_hub.mjs, bin/context-room.mjs, src/context_room.mjs, schemas/shared-repository.schema.json, schemas/shared-projects.schema.json, schemas/shared-skill-locations.schema.json, schemas/shared-skill-local-state.schema.json, schemas/shared-resource-local-state.schema.json, schemas/shared-instruction-locations.schema.json, schemas/config.schema.json]
---

# Shared Context

## Purpose

Shared Context adds an optional Git repository for documentation and skills that several projects, humans, or agents need to share. The normal Context Room workflow remains the default.

| Mode | Trusted content | How changes are made |
| --- | --- | --- |
| Project-local | Files in the current project | Edit an allowed file, then use the normal review queue |
| Shared | The accepted commit on the shared repository's default branch | Create and publish a `proposal/*` branch, review its exact commit in a dedicated Context Room, then accept the selected result directly into the default branch |

The accepted shared snapshot is exposed to the connected project as read-only. An agent therefore cannot change accepted shared documentation or skills through the normal editor. Its writable surface is a proposal worktree created by the CLI.

## Repository Contract

Initialize any Git repository with the generic shared layout:

```bash
context-room shared init-repository --root /path/to/shared-context --name "Company Shared Context"
```

The default layout is:

```text
.context-room/shared-repository.json
projects.json
skills/
  global/
    <skill-name>/SKILL.md
projects/
  <project-id>/
    docs/
    skills/
      <skill-name>/SKILL.md
```

The generated repository manifest contains the paths and branch conventions used by the CLI:

```json
{
  "$schema": "https://unpkg.com/context-room@latest/schemas/shared-repository.schema.json",
  "version": 1,
  "name": "Company Shared Context",
  "defaultBranch": "main",
  "proposalPrefix": "proposal/",
  "acceptancePrefix": "accepted/",
  "rejectionPrefix": "rejected/",
  "globalSkillsPath": "skills/global",
  "projectsPath": "projects",
  "projectsFile": "projects.json",
  "skillLocationsFile": "skill-locations.json",
  "instructionLocationsFile": "instruction-locations.json"
}
```

`projects.json` is the project-resolution authority. Each entry declares a stable project ID and may map it to one or more source-repository remotes plus a subpath:

```json
{
  "$schema": "https://unpkg.com/context-room@latest/schemas/shared-projects.schema.json",
  "version": 1,
  "projects": [
    {
      "id": "my-project",
      "title": "My Project",
      "source": {
        "remotes": ["git@github.com:example/product-monorepo.git"],
        "subpath": "apps/my-project"
      }
    }
  ]
}
```

Commit and push both schemas' data plus every registered `projects/<project-id>/` directory. The paths and proposal, acceptance, and rejection prefixes come from the manifest; the implementation is not tied to one organization or project name. Context Room normalizes SSH and HTTPS forms of the same Git remote and chooses the longest matching source subpath. Older version 1 manifests without `acceptancePrefix` or `rejectionPrefix` use `accepted/` and `rejected/`.

## Connect And Refresh A Project

Humans can perform the same setup without the CLI from **Settings → Project**:

1. Open **Shared repositories** and add each independent Git repository used by a team, client, or personal documentation space.
2. Select a local project or worktree in Explorer.
3. Open **Selected project connection**, choose the repository and shared project, then connect it.

Context Room supports multiple registered shared repositories on one device. Each repository keeps its own accepted default branch and proposal history. One local logical project connects to one shared repository at a time, across its registered worktrees. Disconnect before switching. Removing a repository from Settings only removes its device registration and is blocked while a local project remains connected; it never deletes Git data.

The compact **What is a Shared Context?** help button opens a dedicated dialog instead of adding another settings disclosure. It explains the product benefit—one canonical documentation source remains separate from code and consistent across collaborators, branches, and worktrees—and the full trust model. Accepted repositories can provide canonical documents, Shared Skills, and Shared Instructions, while executable hooks remain local.

The dialog also explains proposal branches, human file review, multiple repositories, provider activation, local preferences, and preservation of unmanaged files. The repository manifest owns the accepted branch and paths. `projects.json` owns project mapping, `skill-locations.json` declares Shared Skill collections and assignments, and `instruction-locations.json` maps reviewed instruction sources to exact provider targets. Proposals stay outside effective context, while device preferences, destinations, overrides, and managed-link ownership stay local.

From the project that consumes the shared context:

```bash
context-room shared setup \
  --root . \
  --repository git@github.com:example/company-shared-context.git
```

When the catalog has no source mapping, or the current directory is not in a Git checkout, add `--project my-project` explicitly.

For a monorepo rollout, `shared bind` records the same approved cwd mapping without initializing or modifying the source project's Context Room config. A later `shared setup` or normal context-dependent command can materialize it:

```bash
context-room shared bind --root apps/my-project --repository git@github.com:example/company-shared-context.git
```

Setup:

- records an explicitly approved repository, project ID, Git source remote, and source subpath in the user-local registry under `~/.context-room/shared/`; a committed project file cannot silently authorize a new remote;
- resolves the canonical project root even when setup starts from a nested cwd, and applies the same binding in another worktree of the same source repository;
- fetches the shared remote's accepted default branch;
- materializes its exact commit under `~/.context-room/shared/` and advances a local `current` link to that immutable snapshot;
- adds the shared docs and skills to `allowedPaths` and `readOnlyPaths` and creates a Shared context hub section; and
- refreshes global and project skill links.

When more than one registered project path could match a source checkout, Context Room uses the most specific matching source subpath.

Inspect or refresh the connection explicitly:

```bash
context-room shared status --root .
context-room shared sync --root .
```

Read commands use the last accepted local snapshot immediately and report whether it is fresh, stale, refreshing, or offline. `context bundle --fresh`, proposal publication, rebase, review materialization, and finalization require an online refresh. Other reads do not block automatically on a shared fetch.

### Accepted History And Revision Diffs

The accepted commit on the configured remote `defaultBranch` is the only
canonical shared revision. Context Room does not hard-code `main`, follow a
proposal branch as effective context, or use its local event journal as Git
truth.

`readSharedMainRevision` verifies the configured remote branch and exposes its
exact accepted commit. `diffSharedMainRevisions` accepts only commits reachable
from that branch and follows its first-parent transitions. Each transition
includes changed paths and any Context Room acceptance trailers. A direct human
commit already present on the default branch is accepted history even without
proposal trailers. Complete proposal trailers let another device recognize the
proposal and exact head that produced an accepted commit.

If an older revision is no longer an ancestor, Context Room reports
`shared-history-diverged` rather than constructing a fictional merge history.

## Propose A Change

Open a bounded shared documentation change from the latest accepted remote
commit:

```bash
context-room edit create \
  --root . \
  --description "Clarify the complete owner-visible onboarding sequence, its prerequisites, failure handling, and the verification steps that must remain true." \
  --session "$CODEX_THREAD_ID"
```

The command returns a change handle and an isolated writable proposal worktree.
The mandatory description is the current **agent recap** shown before the diffs.
A concise title is derived from its first sentence unless `--title` is supplied.

List or restore an existing proposal without inventing another description:

```bash
context-room edit list
context-room edit open proposal/demo/20260730-clarify-onboarding
```

`edit list` uses the project containing the current directory when no selector
is provided. Because `edit open` receives the exact proposal branch, it resolves
the registered shared context itself and does not require a project selector.

`open` restores an explicitly selected proposal, including when its remote
branch must be reattached on another local checkout. Accepted or merged
proposals are terminal and cannot be reopened for editing.

Make the documentation or skill changes inside the returned worktree. There is
no second agent-facing publish command and no CLI acceptance step. Context Room
keeps the resulting file decisions in the human proposal review flow.

Publication first refreshes the configured shared default branch, then rebases
the proposal onto that accepted revision before pushing it. A clean Git rebase
receives updated proposal metadata and a force-with-lease update of its proposal
branch. A Git conflict remains persisted on the open proposal and blocks
publication. Review authority is bound to exact revisions, so affected file
revisions require current human proof. Context Room does not currently evaluate
semantic contradictions created by an otherwise clean rebase.

Project proposals may change only `projects/<project-id>/docs/` and `projects/<project-id>/skills/`. A global proposal uses `--scope global`, receives a `proposal/global/...` branch by default, and may change only the configured global skills directory. The explicit branch scope must match the requested scope.

Context Room repeats that validation before a proposal can enter accepted main. Proposal files must be reviewable UTF-8 text supported by Context Room and no larger than 750 KB. Symlinks, gitlinks, binaries, and special files are rejected.

The proposal commit records its current name and description, accepted-doc
base, plus the source repository, branch, commit, and Codex task ID when those
are available. `edit` reads `CODEX_THREAD_ID` automatically in Codex;
`--session <task-id>` can attach an explicit identity in another agent runtime.
This identity selects one open proposal per repository and project scope and
lets the global Context Room find it. It is metadata, not an authorization
token.

Legacy proposal transport remains internal during migration. New agents use
only `edit`, so they do not orchestrate branch names, worktree paths, or a
separate publication command.

## Review And Partial Acceptance

List remote proposals, then open one in a dedicated review room:

```bash
context-room shared proposals --root .
context-room shared review \
  --root . \
  --proposal proposal/my-project/20260721120000-clarify-onboarding
```

The review command:

1. fetches the current accepted default branch;
2. records the exact proposal commit hash;
3. creates a detached review worktree from the accepted default branch;
4. applies the proposal as uncommitted changes; and
5. starts the normal Context Room review UI for those changes.

Every Context Room exposes shared proposals in its global mixed review queue, which aggregates every registered shared repository instead of only the repository connected to the current project. It links proposals to local projects when that relationship exists, while shared-only projects remain reviewable without a local folder. Search covers project and repository names, title, agent recap, changed paths, branch, author, commit hash, and linked Codex task ID.

The same Home queue exposes local review work, but local files never become
proposals. Opening a local item targets its registered worktree and opens it in
the global room. Opening a shared item creates the exact-hash proposal review
described below. The proposal manager labels the latest description as the
agent recap and keeps the full task ID visible before the owner opens files.
See [Global Context Room](context-hub.md).

Pressing **Open files to review**, or clicking the proposal row on Home, displays the proposal summary immediately while a dedicated exact-hash review server and worktree are prepared in the background. Every changed path is visible at once. Until the exact review report arrives, its state reads **Checking…** and selection stays unavailable. When preparation completes, the summary moves into that exact review room even when no file was selected; this makes **Reject proposal** and, after every file is reviewed, **Put on main** available against the exact revision. Opening a file normally during preparation can still queue that exact path and enter it as soon as the review room is ready. Context Room never makes the initial proposal summary wait on remote Git or server startup, and never chooses the first file for the owner.

The opened file uses the proposal room's Explorer, file-history arrows, diff control, path, and existing document review controls. Proposal context never creates a second banner: the normal workspace bar shows **← Proposal** in a file. Terminal proposal controls stay in that bar: rejection is always available, while **Put on main** appears only after every required file has current review proof.

The Context Room logo returns to the canonical Home URL carried into the review; browser Back provides the same escape route. Context Room preserves the originating Workspace and selected project but removes `view=proposal`, the proposal selector, file and folder state, so a review worktree can never masquerade as a project or global Home. Same-origin HTTPS returns are allowed on hosted QM; local rooms remain restricted to loopback HTTP targets. If a bookmarked or refreshed exact-review URL no longer exists, Context Room shows a dedicated recovery page whose **Return to Context Room** button uses that same canonical Home target; review API calls keep their structured `remote_review_not_found` response. Reopening the same unchanged proposal reuses its existing review worktree—even after the main room restarts—when the exact proposal hash and shared `main` revision are unchanged. The reused URL is always normalized back to the proposal summary, never a stale Hub, file, or selection view. This avoids repeated materialization and preserves review progress. If either revision moved, Context Room creates a fresh exact review instead. Deleted and otherwise non-openable paths remain visible in the summary instead of being hidden by a first-file redirect.

Context Room records whether the current proposal hash is new, updated after an earlier review, accepted into the default branch, rejected, or missing in violation of review authority. If the default branch advanced since the proposal base, the review queue shows the commit distance and a merge-conflict signal when Git can calculate it. Accepted and rejected proposals leave the active queue only when their exact durable evidence agrees.

The owner can right-click a proposal row to start a selection, then reject one or several proposals and local reviews from the mixed queue. Proposal rejection is bound to the exact head displayed at confirmation time. Context Room creates `rejected/<proposal-suffix>-<short-hash>` at that commit, records an owner decision receipt for audit, and deliberately keeps the original `proposal/...` ref. The rejected work leaves the active queue as soon as the exact expected rejection archive points to the proposal head; the local receipt is not required for that terminal state. A moved proposal must be refreshed first, and a local proposal workspace with unpublished changes blocks rejection instead of discarding them. In the same mixed action, local files are marked **Needs changes** rather than deleted.

Context Room records proposals when it publishes them and whenever it refreshes the remote queue. If a previously observed `proposal/*` ref disappears without an exact acceptance or an exact matching `rejected/*` archive, its last-known metadata remains visible as `externally_deleted`, review controls are disabled, and the owner must restore the exact ref. The expected archive name and its commit hash are the rejection authority: a matching archive is terminal even when the local owner receipt is absent. A receipt whose archive is missing or mismatched remains `rejection_archive_missing`; an absent or wrong-hash archive never creates a terminal review state. See [Review authority](review-authority.md).

Use the existing inline controls to accept or reject each change. Rejecting a change block rewrites the review worktree to remove that block; accepting it keeps the proposed result. This means the final worktree diff contains only the parts the human chose to accept.

The proposal summary labels each path as created, modified, deleted, renamed, copied, or dependency-only review. Once the exact report identifies a file as pending, it can be selected with no permanent checkbox column: right-click its row, or press and hold it on touch screens, to enter selection mode. A selection started in the immediate Hub preview carries that exact path into the dedicated review room. Right-clicking while a row still reads **Checking…** only explains that the review state is loading; it never queues or applies a review decision. Trying to select a row already marked **Reviewed** shows an inline explanation that selection only applies to rows still marked **Review**; the reviewed file stays unchanged and can still be opened normally for inspection. Accepting a selection keeps the proposal versions; rejecting it restores the accepted-main versions, including add, delete, rename, and copy semantics. Dependency-only reviews can be batch-accepted but have no proposal delta to reject. A batch is limited to 200 files and is preflighted as one exact-revision operation before any file changes.

After the final current file version receives its human decision, Context Room reveals **Put on main** but does not finalize automatically. **Reject proposal** remains available at every stage. Both terminal actions are bound to the displayed proposal head and use the double-confirmation checkpoint. The confirmation remains visible and disabled while the server runs the terminal action; a stale head, conflict, authentication failure, or rejected push is reported inside that same dialog and can be retried after the cause is resolved. Remaining and reviewed counts use the complete proposal review state, even when the general detailed queue is capped at 80 entries for responsiveness.

**Reviewed is a positive-proof state**: Context Room emits it only when the current file content or current deletion identity has an explicit, still-valid human verification record. Files outside the first detailed page, missing state, incomplete coverage, stale hashes, and report inconsistencies all remain pending and block acceptance. Absence from a queue page never means reviewed.

File views show only the return to proposal files. The agent-facing CLI deliberately has no acceptance, rejection, or verification command.

Acceptance is bound to the recorded proposal hash. If the proposal branch moved after the room was created, acceptance expires and the new commit must be reviewed in a new room. The cockpit makes this visible by showing the old exact hash and offering the branch's new hash as a separate review.

An exact review authority is single-use after successful acceptance. Reopen the proposal if another reviewed result is needed.

Before publishing, Context Room fetches the latest default branch and applies only the reviewed result onto that newer commit. Unrelated accepted changes already on the default branch are preserved. If the selected result conflicts with the latest default branch, nothing is pushed and the resolved result must be reviewed again. If no selected change remains, no commit is created.

The reviewed result becomes one identifiable commit whose parent is the latest fetched default-branch revision. Context Room then pushes that commit directly to the default branch with a normal fast-forward push. A concurrent remote update or branch protection rejects the push; Context Room never force-pushes or overwrites the newer remote state.

## Shared Skill Locations

`skill-locations.json` separates shared intent from local filesystem paths. A collection names one declared directory in the shared repository; every direct child with the standard skill entrypoint is a skill. An assignment selects a collection, provider identities, optional `include` or `exclude` names, and one scope:

- `project` applies to the declared `projectIds` and every explicitly registered location or worktree for those projects;
- `shared` applies to every project in this shared repository that has an explicitly registered local location, using each provider's project destination;
- `device` materializes one physical provider destination for the assignment on this computer.

Context Room never scans the computer for new projects or worktrees.

```json
{
  "$schema": "https://unpkg.com/context-room@latest/schemas/shared-skill-locations.schema.json",
  "version": 1,
  "collections": [
    { "id": "team", "title": "Team skills", "path": "skills/team" }
  ],
  "assignments": [
    {
      "id": "team-projects",
      "collectionId": "team",
      "scope": "project",
      "projectIds": ["my-project"],
      "providers": ["codex", "claude-code", "opencode"],
      "include": ["*"],
      "exclude": []
    }
  ]
}
```

The built-in destinations come from the same provider profiles used by Startup
environment and the Context Engine. They are `~/.agents/skills` and
`.agents/skills` for Codex, `~/.claude/skills` and `.claude/skills` for Claude
Code, plus `~/.config/opencode/skills` and `.opencode/skills` for OpenCode.
Custom destinations remain explicit local mounts selected in the Explorer.

Context Room migrates only links it previously recorded as managed. It creates
the new provider-profile destination atomically, verifies it, and removes the
old managed link only after success. An unmanaged `.codex/skills` file,
directory, or symlink is reported as a legacy location and is never removed or
replaced.

Collections, assignments, scopes, providers, and shared `include` or `exclude`
filters are accepted intent from `skill-locations.json` on the canonical shared
revision. Creating, reassigning, or removing an assignment always publishes a
`skills` proposal. A local `link` maps one accepted assignment to a physical
destination; `unlink` removes only that managed mapping. Physical paths,
provider activation, local exclusions, disabled assignments, pending imports,
archives, and managed-link ownership use the version 3 Shared Resources local-state contract under
`~/.context-room/shared/`; they never enter Git.

Codex, Claude Code, and OpenCode are enabled on the device by default. The same preference governs both Shared Skills and Shared Instructions. A project can inherit that state or override one provider to `enabled` or `disabled` for its `project` and `shared` destinations. A `device` assignment uses the device preference only, so several projects cannot race over one global link. A disabled provider reports `provider-disabled` and loses only links registered as managed.

Every materialized skill is one managed symlink to the exact accepted immutable snapshot. Relative scripts and assets remain inside the skill directory, executable bits are preserved, and snapshot content is read-only.

Reconciliation is atomic per destination and guarded by a recoverable local lock. A device-wide owner registry records the repository, assignment, provider, revision, and target behind every managed destination. An ordinary directory, file, unmanaged symlink, or link owned by another shared context is never replaced. Both owners are reported explicitly and there is no implicit priority. Refresh removes only links recorded as managed.

Refresh compares `previousRevision` with the accepted `revision`. An unchanged
revision does not reconcile already current destinations. When the accepted
revision advances, Context Room materializes that exact immutable commit and
reconciles every explicitly registered consumer location. A provider-targeted
reconcile updates only the destinations included in its plan.

Context Room applies project assignments to every explicitly registered location or worktree for that project ID. It never scans the computer for new worktrees. Offline refresh keeps the last accepted snapshot and its working links.

Without `skill-locations.json`, Context Room synthesizes the compatible legacy collections `skills/global → Codex device` and `projects/<id>/skills → Codex project`. Reading that fallback does not modify `main`. The first explicit change creates the manifest only through a `skills` proposal, whose writable scope is limited to the manifest and declared collection directories.

Use the common status and mutation surface from Settings, the Explorer, the API, or the CLI:

```bash
context-room shared skills status --root .
context-room shared skills effective --root . --provider codex --format json
context-room shared skills explain team-project --root . --format json
context-room shared skills assign --root . --collection team --providers codex,claude-code --scope project --projects my-project --format json
context-room shared skills assign --root . --collection team --providers codex,claude-code --scope project --projects my-project --apply <plan-id> --format json
context-room shared skills unlink --root . --id mount-123 --format json
context-room shared skills unlink --root . --id mount-123 --apply <plan-id> --format json
context-room shared skills override --root . --assignment team-project --enabled false --exclude experimental --format json
context-room shared skills reconcile --root . --provider codex --format json
context-room shared skills reconcile --root . --provider codex --apply <plan-id> --format json
```

`assign`, `unassign`, `import`, `link`, `unlink`, `override`, and `reconcile`
all preview first and apply only with the returned exact plan ID. Assignment
preview includes selected skills, providers, destinations, local overrides, and
collisions. Imports can select individual skills. Apply rejects stale plans and
never replaces unmanaged content.

The HTTP surface mirrors those boundaries: `/api/shared-skills/assignments/*` previews or publishes assignment proposals; `/api/shared-skills/locations/*` previews or changes local destinations; `/api/shared-skills/providers` changes device or project-local activation; and `/api/shared-skills/import/*` previews or publishes imports.

**Settings → Agent environment → Shared resources** first explains the unfamiliar model, then separates **Provider availability**, **Collections and assignments**, and **Local destinations and conflicts**. A collection is reviewed skill content stored in the shared context. An assignment is accepted shared intent. A local destination is the physical provider folder on this device, populated with managed links rather than copies.

**Use these skills in…** creates or updates shared intent through a proposal. **Set local destination…** maps an accepted assignment without editing the manifest. The Explorer action **Link this skill location to shared…** imports local skills through the same three-step review flow. In a global room, Settings requires a project or worktree selection in Explorer before showing that shared context's collections.

An import leaves the selected local folder unchanged while it publishes a
`proposal/skills/*` branch. Only after every changed file is reviewed and the
proposal is finalized into the configured default branch does refresh archive
the original local skill directories under the local shared cache and replace
them with managed links to the accepted snapshot. Refusing the proposed files
leaves the local folder untouched.

Startup environment and `context effective` consume the same Shared Skills
projection: collection, assignment, accepted revision, applied filters,
provider state and its origin, local override, consuming project and worktree,
destination, resolved target, status, reason, collisions, and preserved
unmanaged content. Context Health reports provider-disabled or unavailable
destinations, unmanaged collisions, missing collections, local overrides, and
registered-worktree reconciliation failures.

## Shared Instruction Locations

`instruction-locations.json` applies the accepted-main boundary to agent
instruction files without treating executable hooks as shareable resources. A
collection is a reviewed folder in the shared repository. Each assignment maps
explicit Markdown source files to exact target paths and providers:

```json
{
  "$schema": "https://unpkg.com/context-room@latest/schemas/shared-instruction-locations.schema.json",
  "version": 1,
  "collections": [
    { "id": "team", "title": "Team instructions", "path": "instructions/team" }
  ],
  "assignments": [
    {
      "id": "team-project",
      "collectionId": "team",
      "scope": "project",
      "projectIds": ["my-project"],
      "files": [
        { "source": "AGENTS.md", "target": "AGENTS.md", "providers": ["codex", "opencode"] },
        { "source": "CLAUDE.md", "target": "CLAUDE.md", "providers": ["claude-code"] }
      ]
    }
  ]
}
```

The shared source name is not hard-coded. A collection may contain **CALL.md**
or any other reviewed `.md` or `.mdx` file. The target is explicit and must be
recognized by the selected provider: for example **AGENTS.md** or
**AGENTS.override.md** for Codex, **CLAUDE.md** or a Claude rules/import target,
and **AGENTS.md**, its documented fallback, or an `instructions` entry for OpenCode. It may be nested, such as
**apps/calls/AGENTS.md**. Project and shared scopes resolve targets from each
registered project root. Device scope resolves them from the selected
provider's global configuration root.

Status keeps materialization and activation separate. A link can be installed
while the provider still ignores its filename. Settings, Startup environment,
Context Health, and `context effective` share this projection. Only instructions
with proven native or configured activation enter effective context.
Provider precedence is included: a configured Codex fallback such as
**CALL.md** is reported as shadowed when **AGENTS.override.md** or **AGENTS.md**
already wins in the same directory.

The accepted commit on the configured default branch is the only effective
version. Assignment, import, and removal changes use an `instructions`
proposal. A proposal branch never changes a project until its reviewed result
reaches accepted main. Reconciliation creates file symlinks to that immutable
snapshot, removes only links recorded as managed, and reports a conflict rather
than replacing an ordinary file or unmanaged link. Context Room never scans
for unregistered projects or worktrees.

```bash
context-room shared instructions status --root . --format json
context-room shared instructions import --root . --collection team --collection-path instructions/team --files mappings.json --format json
context-room shared instructions import --root . --collection team --collection-path instructions/team --files mappings.json --apply <plan-id> --format json
context-room shared instructions assign --root . --collection team --files mappings.json --scope project --projects my-project --format json
context-room shared instructions reconcile --root . --provider codex --format json
context-room shared instructions reconcile --root . --provider codex --apply <plan-id> --format json
```

`--files` points to a JSON array. Import entries contain `localPath`, `source`,
`target`, and `providers`; assignment entries contain `source`, `target`, and
`providers`. Mutations preview first and apply only with the exact returned plan
ID. Settings exposes the same collections, **Use these instructions in…** assignment,
mappings, conflicts, import, removal, and reconciliation primitives under **Shared resources**.

Instruction imports record the exact local hash. After exact acceptance, an
unchanged source that is also its provider destination is archived locally
before the managed link is installed. A source elsewhere is preserved. If the
source changed after preview, Context Room reports `import-source-changed` and
does not move or replace it. Refused imports leave every local file untouched.

Startup environment and the Context Engine read these managed links as
accepted `shared-main` instructions only when provider activation is proven. `effective`, `trace`, and `impact` retain
their collection, assignment, provider, target, and accepted revision. Hooks
remain local discovery sources and are not part of Shared Instructions.

The recommended global documentation-maintenance and audit skills are described in [Documentation lifecycle](documentation-lifecycle.md). They use the same links and proposal boundaries; they do not receive a separate path to accepted content.

## Permission Boundary

Proposal publication writes only `proposal/*`. The agent-facing CLI can create and publish proposals but cannot make file or terminal proposal decisions. Human file review prepares the selected result; a separate explicit human action puts it onto the latest default branch with a normal fast-forward push. Context Room never force-pushes `main`.

For a GitHub shared repository, an owner runs this once from the shared repository or a connected project:

```bash
context-room shared secure-github --root .
context-room shared security-check --root .
```

`secure-github` installs or updates three no-bypass branch rulesets: default-branch pull-request protection with one approval, stale-approval dismissal, last-push approval, resolved review threads, deletion protection, and force-push protection; deletion protection for the configured `proposal/*` pattern; and deletion, force-push, and update protection for the configured `rejected/*` pattern. The default-branch rule deliberately blocks direct in-app acceptance. A repository that enables it needs a delivery path with a distinct authenticated human reviewer whose permissions agree with the branch policy.

`security-check` reads all three live GitHub rulesets, exits non-zero unless every required protection and the configured agent deploy key are present, and records the last successful remote check for `shared status`. Re-run it after repository or permission changes. If the GitHub plan does not support rulesets for that private repository, setup fails instead of claiming protection.

The generated deploy key used by the legacy setup can push proposal branches but cannot complete direct acceptance while its pull-request rule protects `main`. Context Room reports the rejected push instead of falling back to another delivery path.

Provider rules are the durable prevention layer for direct `git push --delete`, alternate clones, and skipped local hooks. Local receipts and UI nonces remain defense in depth rather than proof of physical human presence. The complete threat model and recovery procedure live in [Review authority](review-authority.md).

## Source Map

- `src/shared_context.mjs`: repository format, connections, cache, snapshots, skill links, proposals, reviews, and acceptance.
- `src/review_authority.mjs`: owner-authorized review scope and exact shared-proposal decision receipts.
- `bin/context-room.mjs`: shared CLI commands and automatic refresh before context-dependent commands.
- `schemas/shared-repository.schema.json`: shared repository manifest contract.
- `schemas/shared-projects.schema.json`: project catalog and cwd-resolution contract.
- `schemas/shared-skill-locations.schema.json`: shared collections and logical assignment contract.
- `schemas/shared-resource-local-state.schema.json`: version 3 private Skills and Instructions destinations, provider overrides, pending imports, archives, and managed owners. Version 2 Skills state remains readable and migrates on the first local mutation.
- `schemas/shared-instruction-locations.schema.json`: reviewed instruction collections, exact file mappings, providers, and scopes.
- `readOnlyPaths` in `schemas/config.schema.json`: displayable paths that the Context Room server must not create, edit, or delete.
- The Context Engine canonical feature page owns accepted shared resources in
  effective context, impact, snapshots, and diffs.
- [Review queue](review-queue.md): inline accept and reject behavior reused by proposal review rooms.
- [Agent configuration](../agent-configuration.md): project config fields written by shared setup.
