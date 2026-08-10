---
context_room:
  id: assurance.server-boundary
  kind: canonical
  scope: context-room
  status: current
  canonical_for: server request, resource, and network-operation safety
  last_verified: 2026-08-09
  sources: [src/context_room.mjs, src/context_hub.mjs, src/context_diagnostics.mjs, src/shared_context.mjs, src/filesystem_lock.mjs, src/qm_gateway.mjs, bin/context-room-remote.mjs, test/server_security.test.mjs, test/hosted_scope_boundary.test.mjs, test/revision_integrity.test.mjs, test/docqa_concurrency.test.mjs]
---

# Server Boundary

## Summary

Context Room treats every URL, header, browser mutation, project coordinate,
filesystem path, repository selector, and request body as untrusted input. A
bad request fails within that request. It must not widen a project boundary,
start unbounded external work, overwrite a newer resource version, expose
private server details, or terminate the shared Context Room process.

## Defines

The generic request, project, filesystem, revision, repository, network-budget,
error, and public-response invariants shared by local and remote Context Room
servers.

## Does not define

Human review authority, Shared proposal content decisions, or the QM edge
deployment. Those are owned by [Review authority](../features/review-authority.md),
[Shared Context](../features/shared-context.md), and [Remote QM](../remote-qm.md).

## Request And Identity Invariants

- Malformed request URLs, route identifiers, percent encoding, Host values, or
  bodies receive one bounded client error. Parsing failure never escapes the
  request handler or stops the server.
- Local mode accepts only loopback hosts and peers. Remote mode verifies the
  configured public forwarded host before serving the request.
- Browser mutations are same-origin. A local proposal room may additionally
  trust only the explicit parent loopback ports configured when that child room
  was created; initial Workspace registration may establish its identity, while
  every project-scoped mutation carries the current project identity. This is
  not generic same-site or loopback trust, and cross-site requests fail before
  mutation even when the browser can send a simple form-compatible body.
- Local mode permits one cross-port read transition back from an exact proposal
  room: `GET` or `HEAD /` with Fetch Metadata `navigate` + `document`, whose
  referrer matches one of the receiving parent's still-active child review
  servers and whose Origin is absent or matches that same child. This exception
  never applies to API paths, mutations, embedded documents, arbitrary loopback
  ports, or Hosted mode.
- `OPTIONS` describes the supported methods without enabling CORS. It never
  returns `Access-Control-Allow-Origin`. In remote mode it still verifies the
  public host, but it does not require a human identity because it cannot
  authorize the subsequent request.
- Request bodies are bounded. Unexpected server failures return a stable,
  sanitized error and never echo document content, configuration internals, or
  filesystem paths.

## Filesystem And Revision Invariants

- Every project-scoped API first resolves an explicit registered project
  location. Where a surface is confined to that project, a lexical path inside
  the root is insufficient: Context Room resolves existing filesystem
  ancestors and rejects a symbolic-link path whose physical target escapes the
  selected root.
- Document inspection is always physically contained by the selected project
  root. It never follows a project symlink to an external document.
- Save, local review, revert, and delete operations bind the mutation to the
  exact content hash or resource revision displayed to the owner. Revert
  requires the current diff revision. Delete first returns an exact manifest
  for every selected file or folder member.
- A missing revision fails before mutation. A stale revision returns `409` and
  leaves every selected path untouched; a multi-path delete is atomic after its
  complete preflight.
- These revision checks provide optimistic concurrency for Context Room
  requests and ordinary filesystem writers. Mutations stage the exact prior
  bytes and roll back a detectable conflict or partial operation before they
  report success.
- DocQA review-state, global-ledger, baseline, and trusted-evidence mutations
  sharing one ledger root are serialized by one recoverable filesystem lock
  under the private Context Hub home. Their control files use atomic temporary
  writes. A multi-file or multi-record decision snapshots every touched control
  file and restores both the bytes and matching trusted-state authorization if
  any step fails; an incomplete restoration returns
  `filesystem_recovery_required` rather than reporting a partial success.
- Context Room is not an operating-system isolation boundary against another
  arbitrary process running as the same user. Portable Node filesystem APIs
  cannot atomically bind a pre-opened file descriptor or a relocated parent
  directory to the final validation and unlink on every platform. A hostile
  same-user writer can therefore still race the last validation window; a
  stronger guarantee requires OS-level process isolation or native
  directory-handle primitives. This limit does not widen any HTTP, project,
  path, or review authorization boundary.
- The in-memory mutation plan can reconcile a helper-process failure, but it is
  not a write-ahead log. An abrupt Context Room process or operating-system
  termination, or a power loss, is not guaranteed to be crash-durable. Any
  remaining staging file or managed backup is recovery evidence and must not
  be removed or replayed automatically without exact identity validation.

## Hosted Shared-only Request Boundary

- Before project-module import, provider, Git, or persisted application-state
  effects, the remote entry point rejects a broad system data root and any
  existing reserved `home`, `hub`, `shared`, `review-authority`, `snapshots`,
  `codex`, `hermes`, `projects`, or `host` root that is a symbolic link or is not
  a directory. It resolves every root and requires the derived real paths to
  remain contained by the resolved dedicated data root. Repository and project
  directories receive the same check.
- Every external repositories file, signing-secret file, SSH key, known-hosts
  file, or GitHub App key must be an absolute readable regular final entry, not
  a symlink, and remain pinned to the validated device, inode, and bounded size.
  Before dynamic imports, hosted startup redirects HOME and every Context Room,
  Codex, and Hermes state home into private data-root directories; removes
  inherited Git and SSH-agent environment; and installs an empty private global
  Git config with system config and terminal prompting disabled.
- Configured GitHub App and installation IDs must be positive decimal values no
  greater than `2^63 - 1`. Startup fail-fast parses the private-key file as an
  unencrypted RSA PEM; a missing companion setting, invalid or out-of-range ID,
  encrypted key, non-RSA key, or malformed PEM fails before provider or
  persistent application-state initialization.
- One hosted gateway has one pinned machine SSH identity, explicitly authorized
  by the operator on every Shared repository assigned to that gateway. GitHub
  App authority remains limited to its configured installation and selected
  repositories; its acceptance token is never ordinary clone or fetch
  authentication, so unauthenticated HTTPS supports only public repositories.
  Every SSH repository requires the pinned key and known-hosts file. The mounts
  remain read-only for the process lifetime, and Git uses `BatchMode=yes`,
  `IdentityAgent=none`, `IdentitiesOnly=yes`, and `StrictHostKeyChecking=yes`
  after inherited askpass and SSH-agent variables are removed. Repositories that
  require distinct SSH keys cannot share this gateway: that is an operator stop
  condition requiring separate gateways or future explicit per-repository
  authentication, never automatic credential widening or substitution. No
  secret value or mounted secret path is projected through a Hosted provider or
  public response.
- These startup checks prevent configured or mounted path redirection; they do
  not isolate Context Room from a hostile process running under the same UID
  and racing later filesystem changes. That threat requires restrictive
  deployment permissions and a process sandbox or separate operating-system
  identity.
- Hosted startup freezes the configured Shared repositories, the exact project
  IDs assigned to each one, and a separate per-repository allowlist for the
  built-in `global`, `skills`, and `instructions` proposal scopes. Special
  scopes default to none, are never inferred from project IDs or repository
  contents, and cannot be named as project IDs. A query, body, header,
  repository URL, or local Context Hub record cannot register another
  repository or widen either mapping.
- Hosted technical project roots are namespaced under one deterministic opaque
  repository directory ID, and every project ID is globally unique across the
  configured repositories. The entry point refuses duplicate repository
  identities, duplicate project assignments, any project ID equal to a
  repository directory ID, or any old flat `projects/<project-id>` root before
  it imports project modules or creates application state. Before it initializes
  or synchronizes an existing namespaced project root, that root's Shared
  binding repository must equal the configured raw repository address
  byte-for-byte, and its project ID must match exactly. The entry point performs
  no automatic operator migration, move, merge, or cleanup; the only recovery
  path is the exact bootstrap retry described below. The
  operator procedure in [Remote QM](../remote-qm.md) requires an unambiguous
  mapping, verified backup, offline atomic move or staging rename, smoke boot
  on a copy, sentinel checks, and whole-volume rollback on uncertainty.
- Hosted startup fixes `CONTEXT_ROOM_SHARED_HOME` at
  `<dataRoot>/home/.context-room/shared` and preserves that one state tree for
  clones, Git directories, worktrees, authorities, receipts, and review
  progress. A concurrent `<dataRoot>/shared` tree is a fail-closed migration
  conflict. Upgrade migration is limited to atomic, validated project-root moves
  and their exact Shared bindings; it never moves, merges, or recreates the
  preserved Shared Home. Before boot, the operator backs up and atomically
  rewrites only its `registry.json` as a deterministic version 1 binding list:
  each binding preserves its prior raw `repository` string unchanged, proves it
  byte-for-byte equal to deployment configuration, and changes only the exact
  namespaced project root used by `sourceRoot` and its sole `projectRoots` entry.
  A private staging file is file-synced, renamed, and revalidated; proposal,
  review, receipt, authority, clone, Git-directory, worktree, and cache state is
  not changed. Historical Shared cache directories use the first 16 lowercase
  hexadecimal characters of SHA-256 over that exact raw repository address.
  Changing transport, case, or `.git` changes the key and is unsupported: stop
  and restore the previous image and configuration. A full cache, proposal,
  review, authority, receipt, and worktree migration must be designed and tested
  separately before any such address change.
- After configuration and existing-layout preflight, every hosted boot writes a
  private bootstrap-incomplete marker containing the exact raw
  repositories, identities, storage IDs, project IDs, and scopes. The server
  cannot listen until every repository has synchronized once, every project
  binding and materialized configuration has been rechecked, and the marker has
  been removed. A Git, catalogue, or later bootstrap failure can leave internal
  cache or project initialization files, but never an active server; the marker
  remains. A later boot may resume only when that one-link marker exactly
  matches the current configuration. An invalid, symlinked, or mismatched
  marker blocks before effects, and a boot without a marker still rejects any
  partial project/registry layout. This retry is not a rollback guarantee for
  cache internals: they remain bootstrap-only and unserved until a complete boot
  succeeds.
- The `hosted-hub` and `hosted-review` profiles admit only the exact
  method-and-path matrix defined in [Remote QM](../remote-qm.md). Unknown
  methods, path aliases, malformed or non-canonical paths, mismatched profiles,
  and browser-supplied target-project headers on non-`OPTIONS` requests return
  `404 remote_operation_unavailable` before request-body parsing, Shared-provider
  access, Git, or another route side effect. The one route-resolution exception
  is an unknown `/reviews/<authority-id>/` root: its page returns recovery HTML
  and its API paths return `404 remote_review_not_found`, without exposing or
  initializing another review.
- Hosted requests never consult or mutate the local Context Hub registry or
  snapshot. Generic project creation, files, folders, Settings, Startup
  resources, Codex prompts, computer exploration, and other HOME-backed APIs
  are outside the hosted matrix. A denied route cannot initialize or call their
  providers.
- The hosted Hub reads only the immutable Shared provider projection. Hosted
  review reads only its configured repository, allowed project ID or explicitly
  declared special scope, exact proposal, and exact review manifest. Public
  repository coordinates are opaque identifiers, not remote URLs or filesystem
  roots.
- A Hosted proposal write is resolved inside the exact opaque repository and
  configured project or special scope. Patch, publish, review materialization,
  and terminal decision requests bind to the current complete proposal head;
  mutation selection accepts the canonical proposal ID or exact branch, never a
  title or a head used as a branch alias. A missing or changed head fails before
  proposal, review, Git, or receipt mutation.
- Every Hosted Shared path must match the proposal's server-owned exact paths or
  allowed prefixes and either one configured project ID or one special scope
  explicitly assigned to that repository. The complete review authority and
  derived manifest are preflighted before review-state or resource-content
  access; one out-of-scope path rejects the entire room with the constant
  `403 shared_context_project_scope_denied`. Catalog, agent, impact, review, and
  authority/error projections independently reapply the same repository,
  project-or-scope, and path boundary, so these hosted API projections cannot
  disclose paths or content outside the selected configured project or declared
  scope.
- Project scoping inside one Shared Git repository is an access-path and
  detectable-provenance boundary, not a confidentiality or information-flow
  boundary against an actor who can read or author repository refs. Such an
  actor can copy or transcribe content across project paths, and Git copy or
  rename classification is heuristic. Confidential isolation requires separate
  Shared repositories with distinct Git permissions; the hosted gateway cannot
  infer or prevent semantic transcription.
- Agent proposal patches accept only the scoped project's documentation or
  skills paths. An absolute, traversal, or symbolic-parent path is rejected with
  `403 agent_path_denied`; a non-regular final entry is also refused. A resolved
  local proposal workspace is validated and reused directly; denial does not
  synchronize Shared state, rewrite a registry, create another workspace, or
  mutate the proposal or external target.
- Hosted responses are route-specific allowlists. Errors use stable public
  status, code, and message values; runtime-event streams expose only sanitized
  invalidation or Workspace-command events; Workspace state and commands omit
  roots, worktrees, URLs, files, folders, credentials, and provider internals.
- A pending Workspace command is memory-only and bound to the registration's
  exact `generation`, `reviewAuthorityId`, and `reviewProposalHead`. Registering
  a different review binding rotates the generation and deletes the previous
  command, including on an unbound-Hub-to-exact-Hosted-Review transition. A
  command read purges any mismatched entry and returns HTTP `200` with
  `{"command":null}` when no command belongs to the exact current binding. A
  command issued after that binding is established remains readable.
- `GET /api/health` belongs only to the `hosted-hub` service audience and
  requires the dedicated health secret. It returns exactly `ok`, `version`, and
  `buildRevision`; human, agent, and hosted-review requests cannot use it.

## Repository And Network Invariants

- Proposal review and impact APIs accept only Shared repositories already
  registered or connected in the current Context Room. A URL supplied in a
  query or body never authorizes a new clone.
- Ordinary Shared clone and fetch operations have a non-zero 30-second budget.
  A timeout is retryable and cannot be converted into a fresh or successful
  state. Terminal acceptance keeps its separate 120-second delivery budget.
- Hosted Hub catalogue reads never perform Git work or await a refresh. They
  return the current in-memory projection immediately, with `refreshing: true`
  when one deduplicated refresh is running. Repository refreshes start in
  parallel under one global deadline, 15 seconds by default and capped at 30
  seconds. Failure or timeout preserves only that repository's previous cached
  projection and marks it unavailable. It cannot make catalogue reads, service
  health, or Workspace events wait for Git, and the other repository tasks keep
  running in parallel. The provider publishes one coherent refreshed projection
  only after every task settles or the global deadline expires; late worker
  results are ignored. The remote entry point separately requires one complete
  all-repository bootstrap synchronization before the first listen.
- The current GitHub Hosted profile accepts only complete 40-character SHA-1
  object IDs at its public proposal, review, build, and delivery boundaries.
  It rejects abbreviations and 64-character SHA-256 IDs. Provider-neutral local
  Shared helpers may accept complete SHA-1 or SHA-256 object IDs; this is not a
  claim that the GitHub Hosted provider supports SHA-256 repositories.
- Read-only proposal impact may refresh the registered repository required to
  compare accepted main with the exact proposal head. It does not modify
  accepted Git history, register another repository, or scan for unregistered
  consumers.

## Public Responses

- The document shell and versioned assets support `GET` and `HEAD`; `HEAD`
  returns the same status and relevant headers without a body.
- Every response exposes the package version through
  `x-context-room-version`. A remote image built from a validated complete Git
  SHA also exposes `x-context-room-revision`; invalid or unavailable build
  identity is omitted rather than guessed.
- Public static assets never expose `x-context-room-project` or an internal
  filesystem path. The HTML shell is always `no-store`; the runtime profile is
  injected only into HTML. Local, hosted-Hub, and hosted-review profiles reuse
  identical fingerprinted CSS and JavaScript bytes and ETags. Hosted mode admits
  only the exact current application and bundled Mermaid asset paths, so stale
  hashes and unversioned aliases fail closed.

## Verification

Run the focused server, hosted-scope, and revision suites:

```bash
node --test test/server_security.test.mjs test/hosted_scope_boundary.test.mjs test/revision_integrity.test.mjs
```
