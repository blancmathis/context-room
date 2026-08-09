---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: shared context repositories
  last_verified: 2026-08-09
  sources: [src/shared_context.mjs, src/review_authority.mjs, src/provider_profiles.mjs, src/context_engine.mjs, src/context_inventory.mjs, src/context_snapshots.mjs, src/context_diagnostics.mjs, src/context_hub.mjs, bin/context-room.mjs, bin/context-room-remote.mjs, src/context_room.mjs, schemas/shared-repository.schema.json, schemas/shared-projects.schema.json, schemas/shared-skill-locations.schema.json, schemas/shared-skill-local-state.schema.json, schemas/shared-resource-local-state.schema.json, schemas/shared-instruction-locations.schema.json, schemas/config.schema.json]
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

Commit and push both schemas' data plus every registered `projects/<project-id>/` directory. The paths and proposal, acceptance, and rejection prefixes come from the manifest; the implementation is not tied to one organization or project name. `acceptancePrefix` remains the discovery contract for accepted refs created by compatible or pull-request-based delivery paths. The current direct in-app fast-forward flow records acceptance on the default branch and in its signed receipt; it does not create a new `accepted/*` ref. Context Room gives supported credential-free aliases for the same GitHub repository (`https://`, `git@`, and `ssh://git@`) one canonical repository identity; other protocols and SSH users remain distinct, while a `file://` URL without a host—or, on macOS, with a host proven local—is canonicalized to the repository's physical local path and any other file host is rejected. The first transport form stored for that identity remains the clone, fetch, and authentication transport. Registering a later alias therefore reuses the binding and cache instead of creating a duplicate or silently changing credentials. Hosted bootstrap separately pins the operator-configured raw address and never treats alias equivalence as permission to migrate persistent hosted state. Context Room chooses the longest matching source subpath. Older version 1 manifests without `acceptancePrefix` or `rejectionPrefix` use `accepted/` and `rejected/`.

During the v0.6.1 cache migration, Context Room also performs one bounded scan
for unclaimed legacy cache directories whose old transport alias is no longer
known. It adopts a cache only when its physical checkout has the exact canonical
origin and standard origin fetch mapping. Exactly one match receives a durable
identity claim in place, preserving its snapshots, proposal registry, and
worktrees. Multiple matches fail closed and none is claimed.

## Connect And Refresh A Project

Humans can perform the same setup without the CLI from **Settings → Project**:

1. Open **Shared repositories** and add each independent Git repository used by a team, client, or personal documentation space.
2. Select a local project or worktree in Explorer.
3. Open **Selected project connection**, choose the repository and shared project, then connect it.

Context Room supports multiple registered shared repositories on one device. Each repository keeps its own accepted default branch and proposal history. One local logical project connects to one shared repository at a time, across its registered worktrees. Disconnect before switching. Removing a repository from Settings only removes its device registration and is blocked while a local project remains connected; it never deletes Git data.

Each binding records the exact physical project and Git-worktree capability
that created it. A checkout replaced at the same path, or retargeted through a
different `.git` entry, does not inherit that binding and must reconnect
explicitly. Disconnect uses a durable, fsynced rollback journal. Recovery
restores files only while every recorded capability still matches; otherwise it
quarantines the journal as one global recovery issue for explicit local owner
acknowledgement, without writing into the replacement checkout.

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
- adds the project docs plus only the accepted Shared Skill and Shared Instruction
  collections whose assignments apply to this project to `allowedPaths`,
  `readOnlyPaths`, and the Shared context Hub section; collections assigned only
  to another project never enter this room; and
- refreshes the applicable global and project managed links.

When more than one registered project path could match a source checkout, Context Room uses the most specific matching source subpath.

Remote QM may expose several immutable Shared repository assignments without a
local checkout. Its agent gateway requires each normalized `projectId` to belong
to exactly one configured repository across the complete hosted process; a
duplicate repository identity, cross-repository project ID, or project ID that
collides with an opaque repository directory identity blocks startup. Technical
project roots are namespaced by that opaque repository directory ID, while the
public Shared model continues to use repository and project identities rather
than host filesystem paths. This is a hosted gateway constraint, not a new
restriction on a Shared repository manifest. Each repository also has a separate
allowlist for the built-in `global`, `skills`, and `instructions` proposal
scopes. The separate `projects` operator scope may authorize creation of a new
Shared project proposal; it is not a proposal or branch scope. Every operator
scope defaults to absent, permits only its exact value without duplicates, and
is never derived from a project ID or repository contents. The three proposal
scope names remain reserved and invalid as hosted project IDs. See
[Remote QM](../remote-qm.md).

Inspect or refresh the connection explicitly:

```bash
context-room shared status --root .
context-room shared sync --root .
```

Read commands use the last accepted local snapshot immediately and report whether it is fresh, stale, refreshing, or offline. `context bundle --fresh`, proposal publication, rebase, review materialization, and finalization require an online refresh. Other reads do not block automatically on a shared fetch. Ordinary Shared clone and fetch work shares one 30-second budget per refresh and returns the retryable `shared-git-timeout` error on expiry. Proposal publication and rejection also bound each Git push; terminal acceptance keeps the separate delivery budgets described below.

A direct local project room boots by reading `/api/shared-context` first. Only
an active project connection causes the current owner interface to issue the
protected `POST /api/shared-context/refresh`; disconnected rooms never turn the
initial read into a mutation. A refresh failure preserves an exact accepted
cached revision when one exists and reports the offline error honestly.

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

## Propose A Shared Project

From the global Context Room, **New shared project** creates a proposal in one
explicitly selected registered Shared repository. The request carries that
repository's exact opaque ID; Context Room never chooses a repository from a
project alias, a matching title, or the first result. This keeps the operation
unambiguous when several Shared repositories are registered.

The form requires a unique project ID made from lowercase letters, numbers,
and hyphens, a one-line title, a current proposal description, and one initial
Markdown path. The path is repository-relative only within
`projects/<project-id>/docs/`: absolute, escaping, hidden, non-normalized, and
non-Markdown paths are rejected. Context Room then publishes one dedicated
project-scoped `proposal/<project-id>/...` branch with `createsProject: true`.
That proposal changes only two repository paths: it appends the catalog
candidate in `projects.json` and adds the initial Markdown skeleton below
`projects/<project-id>/docs/<path>`.

This flow never registers a local project and never writes the accepted default
branch directly. Accepted `projects.json` and the project catalogue remain
unchanged until the proposal passes normal human file review and the owner
double-confirms terminal acceptance. Acceptance puts the reviewed result on the
configured default branch. Terminal rejection uses the same existing double
confirmation, archives the exact proposal, and leaves the project absent. A
project-creation review exposes exactly `projects.json` and the initial Markdown
document as one atomic bundle. Both files remain directly inspectable, but an
accept or reject batch must name the complete bundle; a partial batch returns
`409 shared_project_creation_review_partial` and records no decision.

Hosted Hub exposes the same Shared-only proposal flow only when the selected
repository's operator configuration explicitly includes the `projects` scope.
That permission authorizes the proposal, not immediate catalogue exposure.
After acceptance, the operator must also add the new ID to that repository's
deployment `projectIds` and restart or redeploy the gateway before Hosted Hub
can expose the project as accepted current context.

## Propose A Change

An owner can create a shared Markdown document without a local code checkout.
In the local profile, open **Manage projects…**, select a connected or
shared-only project, then choose **New shared document**. Hosted Hub has no
project manager and exposes **New shared document** directly for the selected
configured Shared project. Context Room requires a title, a path relative to
that project's `docs/` directory, and a current proposal description. It creates the
file with a stable project-scoped `context_room.id`, `Summary`, `Defines`, and
`Does not define` sections, then publishes the exact addition on a project-scoped
`proposal/*` branch. The accepted default branch remains unchanged until the
normal human file review and terminal acceptance flow completes. Unsafe,
hidden, non-Markdown, escaping, or already-existing paths are rejected before
publication.

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
Unless the caller supplies an explicit valid branch, Context Room combines the
scope, timestamp, title slug, and a full random UUID suffix. The timestamp and
slug are descriptive only; the UUID supplies strong collision resistance for
simultaneous automatic proposal creation.

List or restore an existing proposal without inventing another description:

```bash
context-room edit list
context-room edit open proposal/demo/20260730-clarify-onboarding
context-room edit open proposal/demo/20260730-clarify-onboarding --repository <candidate-repository> --shared-project demo
```

`edit list` uses the project containing the current directory when no selector
is provided. Because `edit open` receives the exact proposal branch, it can
resolve the registered Shared Context itself and does not require a project
selector. Unselected discovery is fail-closed: every registered Shared Context
must be freshly checked within one shared deadline. If one cannot be verified,
the command returns `proposal-discovery-incomplete`. If several repositories
contain the branch, `proposal-ambiguous` returns candidates whose exact
`repository` value can be reused with `--repository`; `--shared-project`
optionally narrows the project. An explicit repository bounds discovery to that
Shared Context.

`open` restores an explicitly selected proposal, including when its remote
branch must be reattached without any local project binding. Accepted, merged,
and rejected proposals are terminal and cannot be reopened for editing.

Make the documentation or skill changes inside the returned worktree, then pass
its change handle to `context-room docs publish --change <change-id>`. A fresh
cumulative `--description` is required when updating an already-published
proposal. Publication works for Hub-only proposals without creating a synthetic
local binding. There is no CLI acceptance step: Context Room keeps the resulting
file decisions in the human proposal review flow.

Publication first refreshes the configured shared default branch, then rebases
the proposal onto that accepted revision before pushing it. A clean Git rebase
receives updated proposal metadata and a force-with-lease update of its proposal
branch. A Git conflict remains persisted on the open proposal and blocks
publication. Review authority is bound to the complete exact proposal and base
revisions. After either revision changes, Context Room creates a new review room
and requires fresh proof for every proposal-changed path, even when an individual
blob happens to be byte-identical to one seen in the previous room. Context Room does not currently evaluate
semantic contradictions created by an otherwise clean rebase.

Project proposals may change only `projects/<project-id>/docs/` and `projects/<project-id>/skills/`. The skills directory is optional: a docs-only project and a docs-only proposal remain valid, and acceptance does not create a missing skills directory. A global proposal uses `--scope global`, receives a `proposal/global/...` branch by default, and may change only the configured global skills directory. The explicit branch scope must match the requested scope.

Context Room repeats that validation before a proposal can enter accepted main. Proposal files must be reviewable UTF-8 text supported by Context Room and no larger than 750 KB. Symlinks, gitlinks, binaries, and special files are rejected.

The proposal commit records its current name and description, accepted-doc
base, plus the source repository, branch, commit, and Codex task ID when those
are available. `edit` reads `CODEX_THREAD_ID` automatically in Codex;
`--session <task-id>` can attach an explicit identity in another agent runtime.
This identity selects one open proposal per repository and project scope and
lets the global Context Room find it. It is metadata, not an authorization
token.

Legacy proposal transport remains internal during migration. New agents use
`edit create` or `edit open` to obtain the exact worktree and change handle,
then `docs publish` to publish that handle. They never orchestrate branch names,
worktree paths, or terminal acceptance themselves.

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

Every local Context Room exposes shared proposals in its mixed review queue,
which aggregates every registered Shared repository instead of only the
repository connected to the current project. It links proposals to local
projects when that relationship exists, while shared-only projects remain
reviewable without a local folder. Hosted Hub instead exposes only proposals
from its immutable Shared allowlist and has no local side of the queue. Search
covers project and repository names, title, agent recap, changed paths, branch,
author, commit hash, and linked Codex task ID.

In the local profile, the same Home queue exposes local review work, but local files never become
proposals. Opening a local item targets its registered worktree and opens it in
the global room. Opening a shared item creates the exact-hash proposal review
described below. The proposal manager labels the latest description as the
agent recap and keeps the full task ID visible before the owner opens files.
See [Global Context Room](context-hub.md).

Pressing **Open files to review**, or clicking the proposal row on Home, displays the proposal summary immediately while a dedicated exact-hash review server and worktree are prepared in the background. Every changed path is visible at once. Until the exact review report arrives, its state reads **Checking…** and selection stays unavailable. When preparation completes, the summary moves into that exact review room even when no file was selected; this makes **Reject proposal** and, after every file is reviewed, **Put on main** available against the exact revision. Opening a file normally during preparation can still queue that exact path and enter it as soon as the review room is ready. Context Room never makes the initial proposal summary wait on remote Git or server startup, and never chooses the first file for the owner.

On hosted QM, this exact proposal room uses a whole-file review protocol. The
bootstrap `GET /api/shared-context` returns only the proposal descriptor, exact
manifest paths and change metadata, present or absent states, safe Git modes,
reviewed or pending state, and the minimal review summary. It returns no file
content or content hash. `GET /api/shared-context?file=<exact-manifest-path>`
then returns the base, proposal, and current resource for that one exact
manifest path, with content and its SHA-256 hash for each present resource. It
also returns the corresponding rename resources when applicable. A
non-canonical path or a path outside the manifest fails closed.

Before a hosted room reads review state or any resource content, it validates
the complete authority path list and derived manifest against the proposal's
exact paths or allowed prefixes and either the repository's configured project
IDs or its explicitly allowed special scope. A single out-of-scope path rejects
the whole room with
`403 shared_context_project_scope_denied`; catalog, agent, impact, descriptor,
and decision projections filter paths again. A hosted proposal therefore cannot
reveal paths or document content outside its selected configured project or
declared scope.

A hosted file decision contains only the exact proposal head, `accept` or
`reject`, and one or more canonical manifest path strings; unreview contains
that same exact head and one canonical path. The server re-derives the complete
manifest, expected states, content hashes, safe modes, rename semantics, and
dependency versions under the exact review lock before it mutates the review
worktree or records evidence. Client-supplied content, hashes, modes, versions,
repository URLs, or filesystem paths are not review authority. Local proposal
rooms preserve their existing change-block controls and partial-file result;
the hosted whole-file transport does not replace local hunk review. Neither
transport authorizes a terminal action: the double confirmation and one-use
acceptance challenge described below remain required. Hosted review renders a
dedicated whole-file, read-only diff model; it never invokes generic
`/api/file*`, editor, hunk-decision, or DocQA-decision controls.

In a local proposal room, the opened file uses the Explorer, file-history
arrows, diff control, path, and existing document review controls. Proposal
context never creates a second banner: the normal workspace bar shows **←
Proposal** in a file. Terminal proposal controls stay in that bar: rejection is
always available, while **Put on main** appears only after every required file
has current review proof.

The Context Room logo returns to the canonical Home URL carried into the review; browser Back provides the same escape route. Context Room preserves the originating Workspace and selected project but removes `view=proposal`, the proposal selector, file and folder state, so a review worktree can never masquerade as a project or global Home. Hosted QM accepts only an HTTPS return on the same origin; it never accepts a loopback or another origin. A local return target must be loopback HTTP, and the parent server accepts a cross-port return only as `GET` or `HEAD /` with Fetch Metadata `navigate` and `document`, from one of its still-active child review ports. That exception never covers an API path, mutation, embedded load, or arbitrary loopback port. If a bookmarked or refreshed exact-review URL no longer exists, Context Room shows a dedicated recovery page whose **Return to Context Room** button uses that same canonical Home target; review API calls keep their structured `remote_review_not_found` response. Reopening the same unchanged proposal reuses its existing review worktree—even after the main room restarts—when the exact proposal hash and shared `main` revision are unchanged. The reused URL is always normalized back to the proposal summary, never a stale Hub, file, or selection view. This avoids repeated materialization and preserves review progress. If either revision moved, Context Room creates a fresh exact review instead. Deleted and otherwise non-openable paths remain visible in the summary instead of being hidden by a first-file redirect.

Context Room records whether the current proposal hash is new, updated after an earlier review, accepted into the default branch, rejected, or missing in violation of review authority. If the default branch advanced since the proposal base, the review queue shows the commit distance and a merge-conflict signal when Git can calculate it. Accepted and rejected proposals leave the active queue only when their exact durable evidence agrees.

The owner can right-click a proposal row to start a selection, then reject one or several proposals and local reviews from the mixed queue. Proposal rejection is bound to the exact head displayed at confirmation time. Context Room atomically creates `rejected/<proposal-suffix>-<short-hash>` at that commit and advances the distributed rejected state, records the signed owner decision receipt, and deliberately keeps the original `proposal/...` ref. The rejected work leaves the active queue only while that receipt, archive, and terminal state agree. A moved proposal must be refreshed first, and a local proposal workspace with unpublished changes blocks rejection instead of discarding them. In the same mixed action, local files are marked **Needs changes** rather than deleted.

In an exact proposal room, the UI accepts a rejection response as terminal only
when it states `rejected: true`, repeats the open proposal and exact head,
returns a `rejected/` archive branch, and reports the Hub refresh as `complete`
or `pending`. It then shows **Proposal rejected**, includes the archive branch,
and returns to the canonical Home that opened the review. A pending refresh is
labeled **Proposal rejected · Hub refresh pending** rather than turning the
verified rejection into a failure. An incomplete or mismatched response stays
in the proposal as an error.

Context Room records proposals when it publishes them and whenever it refreshes the remote queue. If a previously observed `proposal/*` ref disappears without exact accepted-main evidence or matching signed rejection evidence, its last-known metadata remains visible as `externally_deleted`, review controls are disabled, and the owner must restore the exact ref. An exact remote rejected marker and archive without this installation's valid owner receipt remain visible as `unverified_rejection`; explicit human recovery verifies both refs, creates any missing legacy state marker, and records the receipt before the item leaves the queue. A receipt whose archive is missing or mismatched remains `rejection_archive_missing`; an absent or wrong-hash archive never creates a verified rejection. See [Review authority](review-authority.md).

Publication, acceptance, and rejection of one exact proposal revision share a
terminal lock for every process using the same Shared Home. They also use the
distributed Git ref `context-room-state/<sha256(proposal-branch)>` as one exact
compare-and-set across installations. Publication atomically advances the
proposal and active-state refs from the same expected head; acceptance
atomically advances accepted `main` and the terminal state, while rejection
atomically creates the exact archive and terminal state. A stale publisher or
losing terminal decision receives a conflict without a partial remote
transition. [Review authority](review-authority.md) owns the exact failure and
recovery contract.

In a local proposal room, use the existing inline controls to accept or reject
each change. Rejecting a change block rewrites the review worktree to remove
that block; accepting it keeps the proposed result. This means the final
worktree diff contains only the parts the human chose to accept.

The proposal summary labels each path as created, modified, deleted, renamed, copied, or dependency-only review. Once the exact report identifies a file as pending, it can be selected with no permanent checkbox column: right-click its row, or press and hold it on touch screens, to enter selection mode. A selection started in the immediate Hub preview carries that exact path into the dedicated review room. Right-clicking while a row still reads **Checking…** only explains that the review state is loading; it never queues or applies a review decision. Trying to select a row already marked **Reviewed** shows an inline explanation that selection only applies to rows still marked **Review**; the reviewed file stays unchanged and can still be opened normally for inspection. In the exact review room, **Unreview** asks the human directly, removes that document's current exact review proof, restores its proposal version when a previous rejection changed the review workspace, and returns it to **Review**. The accepted shared branch and proposal branch stay unchanged. Accepting a selection keeps the proposal versions; rejecting it restores the accepted-main versions, including add, delete, rename, copy, and executable-mode semantics. Dependency-only reviews can be batch-accepted but have no proposal delta to reject. A batch is limited to 200 files and is preflighted as one exact-revision operation before any file changes.

After the final current file version receives its human decision, Context Room reveals **Put on main** but does not finalize automatically. **Reject proposal** remains available at every stage. Both terminal actions are bound to the displayed proposal head and use the double-confirmation checkpoint. Opening the acceptance confirmation creates a short-lived, one-use server challenge bound to the signed administrator identity on remote QM, or to the current owner-interface nonce instance locally, plus the review authority, `accept` action, and exact proposal head. The local binding proves continuity with that interface instance, not physical human identity. `POST /api/shared-context/accept` rejects a missing, expired, reused, cross-principal, cross-authority, cross-action, or cross-proposal challenge. In remote QM mode, both `/api/shared-context/accept-challenge` and `/api/shared-context/accept` return `503 shared_context_remote_acceptance_unavailable` before authority or Git mutation when the repository-scoped GitHub App is absent. After the immutable request binding is checked, the server consumes that challenge before it rechecks mutable review completeness or starts any Git work. Every retry opens a new confirmation challenge; a previous challenge is never reused.

While acceptance runs, the terminal action reads **Putting on main…**, remains disabled, and keeps the current confirmation visible. A stale head, conflict, authentication failure, rejected push, or failed remote verification closes that consumed confirmation, stays visible as a persistent accessible error in the same proposal, and offers **Retry**. Retry creates a fresh challenge and double confirmation instead of reusing terminal authority. The GitHub App installation-token request has a 15-second budget; clone, initial fetch, push, and delivery-verification fetch each have a 120-second Git budget in remote and local acceptance. A budget expiry returns HTTP `504`, `retryable: true`, and `github-app-token-timeout` or `shared-delivery-timeout`. Context Room never plays the success sound or leaves the proposal before the server proves that the accepted commit is contained in the fetched remote default branch.

On verified delivery, the response includes `deliveryVerified`, the exact `proposal` and `proposalHead`, `commit`, `verifiedRemoteHead`, `defaultBranch`, the Hub refresh state, and a one-use flash token of exactly 32 URL-safe characters. The UI treats the response as terminal success only when those proposal coordinates match the open review, both commit fields are valid exact hashes, the configured default branch matches, delivery and Hub states are allowlisted, and the flash token has that exact shape. Any incomplete or mismatched HTTP `200` stays on the proposal as an error with **Retry**. The review room transports only the validated token as `crFlash`; the destination Hub removes it from the URL immediately and consumes it once from the shared server store before rendering the allowlisted merge outcome. Terminal acceptance does not fall back to `sessionStorage`, and arbitrary URL message, commit, or refresh parameters are ignored. Context Room invalidates the affected shared caches, rebuilds the Home snapshot and active counters, shows **Proposal merged into main** with the accepted commit, and then returns to the canonical Home that opened the review. If remote delivery is verified but the Hub refresh cannot finish, the result remains successful and reads **Merged into main · Hub refresh pending**; it must never be presented as a failed merge. Remaining and reviewed counts use the complete proposal review state, even when the general detailed queue is capped at 80 entries for responsiveness.

**Reviewed is a positive-proof state**: Context Room emits it only when the current file content or current deletion identity has an explicit, still-valid human verification record. That proof binds the resource's present or absent state, exact content hash, and safe Git mode (`100644`, `100755`, or `absent`); symlinks and special entries are rejected. Compatible legacy proof without `resourceMode` is accepted only when one unambiguous safe mode can be derived from the reviewed base or proposal blob. An ambiguous or mode-only change requires a fresh review. Files outside the first detailed page, missing state, incomplete coverage, stale hashes, and report inconsistencies all remain pending and block acceptance. Absence from a queue page never means reviewed.

File views show only the return to proposal files. The agent-facing CLI deliberately has no acceptance, rejection, or verification command.

Acceptance is bound to the recorded proposal hash. If the proposal branch moved after the room was created, acceptance expires and the new commit must be reviewed in a new room. The cockpit makes this visible by showing the old exact hash and offering the branch's new hash as a separate review.

Each terminal acceptance challenge authorizes one confirmed attempt and is consumed before mutable review and Git checks. Successful acceptance makes that exact proposal terminal. If more work is needed, start a new proposal; the accepted proposal is never reopened for editing.

Before publishing, Context Room fetches the latest default branch and applies only the reviewed result onto that newer commit. Unrelated accepted changes already on the default branch are preserved. If the selected result conflicts with the latest default branch, nothing is pushed and the resolved result must be reviewed again. If every proposed change was rejected file by file, `acceptedChangesRemain` is `false`: **Put on main** stays disabled, no commit is created, and the owner uses **Reject proposal** to close the proposal.

The reviewed result becomes one identifiable commit whose parent is the latest fetched default-branch revision. Context Room then atomically pushes that commit to the default branch together with the exact accepted terminal state, fetches the remote refs again, and verifies that the accepted commit is contained in the fetched default branch. A concurrent remote update or branch protection rejects the push; Context Room never force-pushes or overwrites the newer default-branch state. The original `proposal/*` ref remains as Git evidence. Every installation recognizes the exact distributed accepted state as terminal and refuses to reopen, reuse, or republish that proposal identifier. When a legacy delivery has no state ref, accepted-main history still blocks reuse and requires explicit acceptance recovery; matching Git trailers alone do not create a local signed receipt.

If the remote push succeeded but the response or local receipt was lost, retry recovery first locates a single-parent commit by the exact `Context-Room-Proposal` and `Context-Room-Proposal-Head` trailers. It then reapplies the exact reviewed patch to that commit's parent and requires the resulting complete tree—including content, paths, executable bits, and safe entry types—to equal the candidate commit tree. Matching trailers alone are insufficient. Only after renewed remote containment proof does Context Room write the private acceptance receipt through an atomic temporary-file rename; otherwise recovery fails closed and creates no second commit.

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

Skill collection trees are mutually disjoint and cannot overlap instruction
collection trees, repository manifests, or `.context-room/` state. A collection
inside an always-visible root is valid only when its assignment is at least as
broad: `shared` or `device` under the global skills root, or an assignment that
applies to the corresponding project under `projects/<id>/docs` or
`projects/<id>/skills`. Ancestors of those roots are rejected. These checks run
against the skill and instruction manifests together before sync, publication,
or acceptance. The compatible legacy global and per-project skill collections
remain valid because their synthesized assignments have matching visibility.

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

Proposal publication atomically writes its `proposal/*` ref and matching active `context-room-state/*` ref. The agent-facing CLI can create and publish proposals but cannot make file or terminal proposal decisions. Human file review prepares the selected result; a separate explicit human action puts it onto the latest default branch with a normal fast-forward update in the same atomic transition as the accepted state. Context Room never force-pushes `main`.

For a GitHub shared repository, an owner runs this once from the shared repository or a connected project:

```bash
context-room shared secure-github --root .
context-room shared security-check --root .
```

`secure-github` installs or updates four no-bypass branch rulesets: default-branch pull-request protection with one approval, stale-approval dismissal, last-push approval, resolved review threads, deletion protection, and force-push protection; deletion protection for the configured `proposal/*` pattern; deletion, force-push, and update protection for the configured `rejected/*` pattern; and deletion plus non-fast-forward protection for `context-room-state/*`. The default-branch rule deliberately blocks direct in-app acceptance. A repository that enables it needs a delivery path with a distinct authenticated human reviewer whose permissions agree with the branch policy.

`security-check` reads all four live GitHub rulesets, exits non-zero unless every required protection and the configured agent deploy key are present, and records the last successful remote check for `shared status`. Re-run it after repository or permission changes. If the GitHub plan does not support rulesets for that private repository, setup fails instead of claiming protection.

The generated deploy key used by the legacy setup can push proposal branches but cannot complete direct acceptance while its pull-request rule protects `main`. Context Room reports the rejected push instead of falling back to another delivery path.

Provider rules are the durable prevention layer for direct `git push --delete`, alternate clones, and skipped local hooks. These rules make existing rejection and terminal-state refs immutable; they do not authenticate their initial creation. A repository writer that can create both exact refs can trigger a visible `unverified_rejection` and fail-closed availability block, but cannot create the signed human receipt or silently remove the proposal from review. Preventing even that block requires provider-side creation authority held by a separate reviewer identity. Local receipts and UI nonces remain defense in depth rather than proof of physical human presence. The complete threat model and recovery procedure live in [Review authority](review-authority.md).

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
