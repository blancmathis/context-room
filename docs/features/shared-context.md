---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: shared context repositories
  last_verified: 2026-07-27
  sources: [src/shared_context.mjs, src/context_engine.mjs, src/context_inventory.mjs, src/context_snapshots.mjs, src/context_diagnostics.mjs, src/context_hub.mjs, bin/context-room.mjs, src/context_room.mjs, schemas/shared-repository.schema.json, schemas/shared-projects.schema.json, schemas/shared-skill-locations.schema.json, schemas/shared-skill-local-state.schema.json, schemas/shared-instruction-locations.schema.json, schemas/config.schema.json]
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

Read commands use the last accepted local snapshot immediately and report whether it is fresh, stale, refreshing, or offline. `agent prepare --fresh`, proposal publication, rebase, review materialization, and finalization require an online refresh. Other reads do not block automatically on a shared fetch.

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

Create a project-scoped proposal from the latest accepted remote commit:

```bash
context-room shared propose \
  --root . \
  --title "Clarify onboarding" \
  --description "Clarify the owner-visible onboarding steps and their prerequisites." \
  --session "$CODEX_THREAD_ID"
```

The description is the current **agent recap** shown before the diffs. Keep it cumulative and replace it whenever the proposal changes.

The command prints a proposal branch and a writable worktree path. With a task ID, it first looks for one open proposal with the same repository and project or global scope. It returns that worktree instead of creating a second proposal, including when the remote branch must be reattached on another local checkout. More than one matching open proposal is an explicit error. Accepted or merged proposals are terminal and are never reused.

Make the documentation or skill changes inside the returned worktree, then publish the exact proposal:

```bash
context-room shared publish \
  --root . \
  --proposal proposal/my-project/20260721120000-clarify-onboarding \
  --message "Clarify onboarding"
```

The proposal name and description are stored in the proposal commit, not only in local CLI state. When the agent changes an already published proposal, it must publish again with a current description:

```bash
context-room shared publish \
  --root . \
  --proposal proposal/my-project/20260721120000-clarify-onboarding \
  --title "Clarify onboarding and prerequisites" \
  --description "Adds the missing prerequisite and updates the two owner-facing onboarding pages." \
  --message "Update onboarding proposal"
```

`--title` is optional during an update; `--description` is required. Context Room refuses an update without it, so the proposal queue never silently keeps an older agent recap after the branch changes.

Publication first refreshes the configured shared default branch, then rebases
the proposal onto that accepted revision before pushing it. A clean Git rebase
receives updated proposal metadata and a force-with-lease update of its proposal
branch. A Git conflict remains persisted on the open proposal and blocks
publication. Review authority is bound to exact revisions, so affected file
revisions require current human proof. Context Room does not currently evaluate
semantic contradictions created by an otherwise clean rebase.

Project proposals may change only `projects/<project-id>/docs/` and `projects/<project-id>/skills/`. A global proposal uses `--scope global`, receives a `proposal/global/...` branch by default, and may change only the configured global skills directory. The explicit branch scope must match the requested scope.

Context Room repeats that validation after fetching the remote branch, so bypassing the local publish command does not widen the review. Proposal files must be reviewable UTF-8 text supported by Context Room and no larger than 750 KB. Symlinks, gitlinks, binaries, and special files are rejected.

The proposal commit records its current name and description, accepted-doc base, plus the source repository, branch, commit, and Codex task ID when those are available. `shared propose` reads `CODEX_THREAD_ID` automatically in Codex; `--session <task-id>` can attach an explicit identity in another agent runtime. This identity selects one open proposal per repository and project/global scope and lets the global Context Room find it. It is metadata, not an authorization token. One task may legitimately own a project proposal and a separate global proposal.

`--branch proposal/...` can provide an explicit unique branch name. Otherwise Context Room derives one from the project or global scope, timestamp, and title.

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

Pressing **Open files to review**, or clicking the proposal row on Home, displays a ready-to-select proposal summary immediately while a dedicated exact-hash review server and worktree are prepared in the background. Every changed path is actionable at once; choosing one during preparation queues that exact file and opens it as soon as the review room is ready. Context Room never makes the proposal summary wait on remote Git or server startup, and never chooses the first file for the owner.

The opened file uses the proposal room's Explorer, file-history arrows, diff control, path, and existing document review controls. Proposal context never creates a second banner: the normal workspace bar shows **← Proposal** in a file. There is no separate proposal decision control.

The Context Room logo returns to the global room URL carried into the review; browser Back provides the same escape route. Reopening the same unchanged proposal reuses its existing review worktree—even after the main room restarts—when the exact proposal hash and shared `main` revision are unchanged. This avoids repeated materialization and preserves review progress. If either revision moved, Context Room creates a fresh exact review instead. Deleted and otherwise non-openable paths remain visible in the summary instead of being hidden by a first-file redirect.

Context Room records whether the current proposal hash is new, updated after an earlier review, accepted into the default branch, or rejected. If the default branch advanced since the proposal base, the review queue shows the commit distance and a merge-conflict signal when Git can calculate it. Accepted and rejected proposals leave the active queue while their Git refs and commits retain the durable history.

The owner can right-click a proposal row to start a selection, then reject one or several proposals and local reviews from the mixed queue. Proposal rejection is bound to the exact head displayed at confirmation time. Context Room atomically creates `rejected/<proposal-suffix>-<short-hash>` at that commit and removes the active `proposal/...` ref, so the rejected work disappears from the active queue without losing its Git history. A moved proposal must be refreshed first, and a local proposal workspace with unpublished changes blocks rejection instead of discarding them. In the same mixed action, local files are marked **Needs changes** rather than deleted.

Use the existing inline controls to accept or reject each change. Rejecting a change block rewrites the review worktree to remove that block; accepting it keeps the proposed result. This means the final worktree diff contains only the parts the human chose to accept.

After the final current file version receives its human decision, Context Room automatically finalizes the selected review result against the latest `main`. Remaining and reviewed counts use the complete proposal review state, even when the general detailed queue is capped at 80 entries for responsiveness.

**Reviewed is a positive-proof state**: Context Room emits it only when the current file content or current deletion identity has an explicit, still-valid human verification record. Files outside the first detailed page, missing state, incomplete coverage, stale hashes, and report inconsistencies all remain pending and block acceptance. Absence from a queue page never means reviewed.

File views show only the return to proposal files. The agent-facing CLI deliberately has no acceptance, rejection, or verification command.

Acceptance is bound to the recorded proposal hash. If the proposal branch moved after the room was created, acceptance expires and the new commit must be reviewed in a new room. The cockpit makes this visible by showing the old exact hash and offering the branch's new hash as a separate review.

An exact review authority is single-use after successful finalization. Reopen the proposal if another reviewed result is needed.

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

The built-in destinations are `~/.codex/skills` and `.codex/skills`, `~/.claude/skills` and `.claude/skills`, plus `~/.config/opencode/skills` and `.opencode/skills`. Custom destinations are local mounts selected in the Explorer.

Collections, assignments, scopes, providers, and shared `include` or `exclude`
filters are accepted intent from `skill-locations.json` on the canonical shared
revision. Creating, reassigning, or removing an assignment always publishes a
`skills` proposal. A local `link` maps one accepted assignment to a physical
destination; `unlink` removes only that managed mapping. Physical paths,
provider activation, local exclusions, disabled assignments, pending imports,
archives, and managed-link records use the version 2 local-state contract under
`~/.context-room/shared/`; they never enter Git.

Codex, Claude Code, and OpenCode are enabled on the device by default. A project can inherit that state or override one provider to `enabled` or `disabled` for its `project` and `shared` destinations. A `device` assignment uses the device preference only, so several projects cannot race over one global link. A disabled provider reports `provider-disabled` and loses only links registered as managed.

Every materialized skill is one managed symlink to the exact accepted immutable snapshot. Relative scripts and assets remain inside the skill directory, executable bits are preserved, and snapshot content is read-only.

Reconciliation is atomic per destination. An ordinary directory, file, or unmanaged symlink is never replaced: that destination reports a collision while documentation and other destinations continue to refresh. Two shared contexts targeting the same skill name at the same destination likewise conflict explicitly; there is no implicit priority. Refresh removes only links recorded as managed.

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

**Settings → Shared skills** first explains the unfamiliar model, then separates **Provider availability**, **Collections and assignments**, and **Local destinations and conflicts**. A collection is reviewed skill content stored in the shared context. An assignment is accepted shared intent. A local destination is the physical provider folder on this device, populated with managed links rather than copies.

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

Names are not hard-coded. A collection may use **AGENTS.md**,
**AGENTS.override.md**, **CLAUDE.md**, or another reviewed `.md` or `.mdx` file.
The target is explicit and may be nested, such as
**apps/calls/AGENTS.md**. Project and shared scopes resolve targets from each
registered project root. Device scope resolves them from the selected
provider's global configuration root.

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
context-room shared instructions reconcile --root . --format json
context-room shared instructions reconcile --root . --apply <plan-id> --format json
```

`--files` points to a JSON array. Import entries contain `localPath`, `source`,
`target`, and `providers`; assignment entries contain `source`, `target`, and
`providers`. Mutations preview first and apply only with the exact returned plan
ID. Settings exposes the same collections, mappings, conflicts, import, removal,
and reconciliation primitives under **Shared resources**.

Startup environment and the Context Engine read these managed links as
accepted `shared-main` instructions. `effective`, `trace`, and `impact` retain
their collection, assignment, provider, target, and accepted revision. Hooks
remain local discovery sources and are not part of Shared Instructions.

The recommended global documentation-maintenance and audit skills are described in [Documentation lifecycle](documentation-lifecycle.md). They use the same links and proposal boundaries; they do not receive a separate path to accepted content.

## Permission Boundary

Proposal publication writes only `proposal/*`. The agent-facing CLI can create and publish proposals but cannot make file decisions. Human file review drives automatic finalization of the selected result onto the latest default branch with a normal fast-forward push; Context Room never force-pushes `main`.

For a GitHub shared repository, an owner runs this once from the shared repository or a connected project:

```bash
context-room shared secure-github --root .
context-room shared security-check --root .
```

`secure-github` is the legacy pull-request protection setup. Its no-bypass pull-request rule blocks automatic in-app finalization and should not be enabled for a repository that uses the file-review flow described above. Finalization requires the configured shared-repository Git credential to be allowed to fast-forward the default branch.

`security-check` reads the live GitHub rule, exits non-zero unless every required protection is present, and records the last successful remote check for `shared status`. Re-run it after repository or permission changes. If the GitHub plan does not support rulesets for that private repository, setup fails instead of claiming protection.

The generated deploy key used by the legacy setup can push proposal branches but cannot complete direct acceptance while its pull-request rule protects `main`. Context Room reports the rejected push instead of falling back to another delivery path.

## Source Map

- `src/shared_context.mjs`: repository format, connections, cache, snapshots, skill links, proposals, reviews, and acceptance.
- `bin/context-room.mjs`: shared CLI commands and automatic refresh before context-dependent commands.
- `schemas/shared-repository.schema.json`: shared repository manifest contract.
- `schemas/shared-projects.schema.json`: project catalog and cwd-resolution contract.
- `schemas/shared-skill-locations.schema.json`: shared collections and logical assignment contract.
- `schemas/shared-skill-local-state.schema.json`: version 2 private destinations, overrides, provider overrides, and pending imports.
- `schemas/shared-instruction-locations.schema.json`: reviewed instruction collections, exact file mappings, providers, and scopes.
- `readOnlyPaths` in `schemas/config.schema.json`: displayable paths that the Context Room server must not create, edit, or delete.
- The Context Engine canonical feature page owns accepted shared resources in
  effective context, impact, snapshots, and diffs.
- [Review queue](review-queue.md): inline accept and reject behavior reused by proposal review rooms.
- [Agent configuration](../agent-configuration.md): project config fields written by shared setup.
