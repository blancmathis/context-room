# Remote QM deployment

Remote mode is an explicit deployment profile for a trusted QM Portal. Local Context Room remains loopback-only and requires no remote identity configuration.

## Network and identity boundary

- Publish only the QM Portal at `context.qm.peerlab.fr`; never publish port `4317`. The public edge must accept TLS 1.2 or newer, permanently redirect plain HTTP to HTTPS, and enable HSTS after HTTPS is proven for the host. These are Portal and edge requirements; the private Context Room process remains HTTP behind that boundary.
- The Portal signs a one-request human identity for an approved administrator and forwards it as `x-peerlab-context-identity`.
- QM Core signs ten-minute agent capabilities. Each capability contains the actor, QM scope, Context Room project, task/session, allowed operations, expiration, and a unique capability ID.
- Remote UI capabilities add `ui:workspace:list`, `ui:workspace:navigate`, and `ui:workspace:pair`. The Portal and server inject the authenticated user; browser-provided user identity is ignored.
- Human and agent signing secrets are distinct, at least 32 bytes, and mounted as files.
- `GET /api/health` is a service-only endpoint and requires its own secret. A
  human or agent request receives the same unavailable response as any unlisted
  hosted route; the successful service response contains only `ok`, `version`,
  and `buildRevision`.
- Every private GitHub HTTPS bootstrap, Shared refresh, review materialization,
  proposal publication, acceptance, or rejection requests a fresh installation
  token for the exact repository, with a bounded request timeout. The App remains
  limited to its configured installation and selected repositories. The token is
  written only to `git credential approve` on stdin, held by a repository-path-
  scoped Git credential-cache socket under a unique `0700` directory, and
  removed with `reject`, cache `exit`, verified socket disappearance, and
  directory deletion after each individual clone, fetch, or push. It never
  enters a process environment, command argument, remote URL, regular file,
  persistent Git configuration, or application log. Git tracing, inherited
  authorization headers, prompts, hooks, submodules, redirects, and disabled TLS
  verification are neutralized for that operation. A forced `SIGKILL` can bypass
  cleanup, so the in-memory cache TTL is capped to the Git operation budget plus
  five seconds as a bounded residual; the deployment user/container remains the
  boundary against another process of the same UID. The private key is mounted
  as a secret and is never stored under `/data`. Public HTTPS repositories may
  use anonymous reads only after an anonymous preflight succeeds; a private
  repository without the configured App fails before application-state creation.
- One gateway uses one pinned machine SSH identity for proposal Git operations,
  and the operator must explicitly authorize that identity on every Shared
  repository assigned to the gateway. Every SSH repository requires both the
  configured key and known-hosts file. These credentials are mounted read-only
  outside `/data` for the complete process lifetime, and branch protection must
  reject that identity on `main`. If any assigned repositories require different
  SSH keys, that is a deployment stop condition: use separate gateways, or wait
  for explicit per-repository authentication support. Never widen or substitute
  credentials automatically.
- Secret bytes and mounted secret paths, including SSH and GitHub App material,
  are never included in Hosted provider, error, runtime-event, or Workspace
  projections.
- Browser mutations must be same-origin. The public shell and its assets support
  `GET` and `HEAD`; route-aware `OPTIONS` returns `204` with `Allow`, verifies the
  configured forwarded host, does not require human identity, and never enables
  CORS or returns `Access-Control-Allow-Origin`.
- Every application response carries `x-context-room-version`. A validated image
  also carries its complete 40-character source SHA in
  `x-context-room-revision`; public static assets omit
  `x-context-room-project`. Hosted HTML is always `no-store`. The local,
  hosted-Hub, and hosted-review shells reference the same fingerprinted CSS and
  JavaScript bytes and ETags; only the HTML carries the runtime profile. Hosted
  mode exposes only the exact current asset paths, including the versioned
  Mermaid bundle, and rejects stale hashes and aliases.

The generic application-side contract is [Server boundary](assurance/server-boundary.md).
TLS termination, redirects, HSTS, Portal identity injection, and keeping the
private upstream unreachable are deployment checks and require separate live
edge verification.

## Hosted Shared-only application surface

The remote entry point starts one Hosted gateway. Requests at `/` use the
`hosted-hub` profile; requests under `/reviews/<authority-id>/` use the
`hosted-review` profile only when that exact authority is currently
materialized. An unknown review root returns recovery HTML, and its API paths
return `404 remote_review_not_found`. The gateway builds one immutable allowlist
from the configured Shared repositories, exact project IDs, and operator scopes
assigned to each repository. The built-in `global`, `skills`, and
`instructions` proposal scopes and the `projects` proposal-creation capability
are explicit repository-level permissions: none is inferred from a project ID,
repository contents, or another repository assignment. `projects` is not a
proposal or branch scope. Request parameters cannot register another repository,
add a deployment project or scope, or widen that mapping. Hosted JSON uses an
opaque `repositoryId`; repository URLs, checkout roots, review roots, and other
host paths are never public coordinates.

The human route matrix is deny-by-default. Paths below are exact after profile
resolution; public `hosted-review` requests prepend the exact
`/reviews/<authority-id>` root:

| Profile | Exact profile-relative human routes |
| --- | --- |
| Both | `GET` or `HEAD /`; `GET` or `HEAD` for the exact current CSS, JavaScript, and Mermaid asset paths; `GET /api/runtime-events`; `GET /api/workspaces`; `POST` or `DELETE /api/workspaces/register`; `POST /api/workspaces/pair`; and `GET /api/workspaces/<workspace-id>/command` |
| `hosted-hub` | `GET /api/context-hub`, `/api/context-hub/catalog`, `/api/context-hub/review-queue`, `/api/context-hub/sections`, and `/api/proposal/context-impact`; `POST /api/context-hub/refresh`, `/api/context-hub/review`, `/api/context-hub/reject`, `/api/context-hub/flash`, `/api/context-hub/shared-documents`, and `/api/context-hub/shared-projects` |
| `hosted-review` | `GET /api/shared-context`; `POST /api/shared-context/review-files`, `/api/shared-context/unreview-file`, `/api/shared-context/accept-challenge`, `/api/shared-context/accept`, and `/api/shared-context/reject` |

Workspace registration in this matrix is ephemeral browser presence held in
memory with a TTL. It never registers a project or repository and never reads
or writes the local Context Hub registry or snapshot.

`POST /api/context-hub/shared-projects` requires the exact opaque
`repositoryId` of one configured repository and fails before Git work unless
that same repository explicitly declares `scopes: ["projects"]`. A valid
request publishes a normal project-scoped `proposal/<new-project-id>/...` with
`createsProject: true`; it updates the proposal copy of `projects.json` and adds
one initial Markdown skeleton below
`projects/<new-project-id>/docs/`. The accepted default branch, Hosted project
allowlist, and local Context Hub registry remain unchanged. The proposal follows
the existing human file review and double-confirmed accept or reject flow. Its
catalogue entry and initial Markdown document are visible as one atomic review
bundle; Hosted rejects a partial file decision with a stable `409` before saving
review state.
Acceptance makes the project part of Shared main, but Hosted Hub exposes it as
current context only after the operator separately adds its ID to that
repository's deployment `projectIds` and restarts or redeploys the gateway.

The nine agent routes are available only in `hosted-hub`: `GET` on
`/api/agent/capabilities`, `/api/agent/accepted`, `/api/agent/proposals`,
`/api/agent/proposals/checkout`, and `/api/agent/ui/workspaces`; and `POST` on
`/api/agent/proposals/ensure`, `/api/agent/proposals/patch`,
`/api/agent/proposals/publish`, and `/api/agent/ui/open`. Service health is also
`hosted-hub` only. `OPTIONS` is derived from the human matrix for the requested
path and profile. Every other method, path, profile, alias, or non-canonical URL
returns `404 remote_operation_unavailable` before body parsing, Shared-provider
lookup, Git work, or another side effect.

Hosted mode does not expose local or generic project creation, local file or
folder access, Settings, Startup context, Startup skills, Startup hooks, Codex prompt
providers, computer exploration, or another HOME-backed surface. The bounded
Shared project proposal above is the only project-creation exception. It never
reads or writes the local Context Hub registry or snapshot. Hosted Hub state is
projected directly from the immutable Shared allowlist; hosted review state is
projected from the one exact materialized proposal. Errors, runtime events, and
Workspace payloads use explicit public serializers, so they cannot disclose
roots, repository credentials, file or folder state, or private provider data.
Forged URLs, stored navigation, Workspace commands, and direct client calls are
normalized back to the active Hosted profile before they can request a local
surface; the deny-by-default server matrix remains the authority.
Shared paths must also match the proposal's exact or prefix path policy and a
configured project ID or an explicitly allowed special scope for that
repository. A `createsProject: true` proposal is the one bounded exception: the
repository's `projects` operator scope allows exactly `projects.json` plus the
new ID's initial `projects/<id>/docs/` content for that proposal and review; it
does not add the ID to the Hosted project allowlist. Catalog, agent, impact, and
review projections reapply that boundary; these hosted projections never reveal
paths or content outside the selected configured project or declared scope. A
review whose authority or complete manifest crosses the boundary is rejected
with a stable `403` before
review state or resource content is emitted.

This project boundary is not a confidentiality or information-flow boundary
between projects stored in the same Shared Git repository. An actor who can read
or author repository refs can read, copy, or transcribe content across project
paths; copy and rename classification is heuristic, not proof that information
did not move. The hosted gateway enforces the configured repository and project
allowlist, path policy, and the provenance it can detect from exact Git and
request coordinates. Projects requiring confidential isolation need separate
Shared repositories with separate Git permissions.

The generic enforcement contract is [Server boundary](assurance/server-boundary.md).

Hosted Hub catalogue reads never wait for Git. They return the last in-memory
Shared projection immediately and mark it `refreshing` while one deduplicated
refresh runs in the background. All configured repositories start in parallel
and share one global deadline, 15 seconds by default and never more than 30
seconds. A repository that fails or times out keeps only its previous cached
projection and is marked unavailable. It cannot stop another repository task or
make catalogue, health, and Workspace-event requests wait for Git. Other
repository tasks continue in parallel, but one coherent refreshed projection is
published only after all tasks settle or the global deadline expires. Results
arriving after the deadline are ignored. Proposal impact remains the separately documented
read-only operation that may refresh its already registered repository. A cold
deployment still completes one bootstrap synchronization for every configured
repository before the server listens, so the first public projection cannot
come from an unfinished bootstrap. For private GitHub HTTPS, every explicit
refresh mints a new request-scoped credential and passes it to the short-lived
repository process through a bounded stdin envelope; an expired credential is
never reused from the preceding projection.

This GitHub deployment uses complete 40-character SHA-1 object IDs for proposal
heads, review base and accepted commits, image revisions, and verified remote
heads in delivery proofs. Review authority IDs are separate UUIDs. Abbreviated
object IDs and 64-character SHA-256 object IDs are rejected at the Hosted
boundary. The local and provider-neutral Shared core can validate complete 40-
or 64-character Git object IDs, but that compatibility does not widen the
current GitHub Hosted contract.

## Persistent state

Mount the encrypted Docker volume at `/data`. It contains Shared accepted
snapshots, proposal review worktrees, review state, and audit journals, but no
hosted local-Hub registry or snapshot. Back up this volume, but exclude every
mounted secret file. The `Dockerfile.remote` image runs as an unprivileged user
and declares `/data` as its only persistent volume.

Exactly one live remote Context Room process may own a data root. The entry
point holds the private `/data/.context-room-instance.lock` lease for its whole
lifetime. A second process using the same root fails before Git work, bootstrap
marker changes, project initialization, or server listen, even when it requests
a different port. Clean shutdown releases the exact lease; a later process may
recover a stale lease only after proving that its recorded owner is no longer
alive. Do not run active-active replicas against one persistent volume.

The entry point fixes
`CONTEXT_ROOM_SHARED_HOME=<dataRoot>/home/.context-room/shared`. An upgrade must
preserve that exact directory and its clones, Git directories, proposal and
review worktrees, authorities, receipts, and review progress. A concurrent
`<dataRoot>/shared` tree is a migration conflict and a stop condition; never
merge it with the preserved Shared Home. Only legacy project roots under
`<dataRoot>/projects/` and their exact Shared bindings are migrated, atomically
and with validation.

The remote entry point maintains private technical roots under
`/data/projects/<opaque-repository-directory-id>/<project-id>` for
project-scoped agent capabilities, Shared Context synchronization, and proposal
materialization. The directory ID is the first 24 lowercase hexadecimal
characters of SHA-256 over the canonical `github:<owner>/<repository>` identity;
it is a storage coordinate, not a repository URL. These directories are not
source checkouts and are never registered as local Context Room projects. The
visible project catalog comes only from the configured Shared Context provider.
Another deployment profile may connect a real local checkout, but that does not
widen this hosted process.

Historical Shared state uses a different key: the first 16 lowercase
hexadecimal characters of SHA-256 over the exact raw repository address. That
raw string—including HTTPS versus SSH, letter case, and presence of `.git`—must
remain byte-for-byte identical in the deployment configuration, preserved
registry, and project bindings. An equivalent Git remote spelling is not a
migration alias. Any mismatch is a stop condition: roll back the old image and
configuration. Changing the address requires a separately designed and tested
full migration of caches, clones, proposal and review worktrees, authorities,
receipts, and review state; the current upgrade procedure does not support it.

After configuration validation, a virgin private GitHub HTTPS deployment first
acquires exact repository-scoped credentials and proves that each remains valid
for its complete bootstrap Git budget. Missing App configuration, an expired
token, or a token-request timeout leaves the requested data root absent. A
public repository without an App must instead pass a read-only anonymous
`ls-remote` preflight under the same network budget. The exact repositories
that pass this preflight are carried into the server as an in-memory anonymous
read allowlist. Hosted accepted-context and proposal-impact refreshes may read
without an App only for that allowlist; an unlisted HTTPS repository fails
before Git or cache creation, and an App-backed repository never falls back to
anonymous access after an authentication failure. Only after that preflight,
and before it imports any project module, the entry point creates or validates
private roots for `HOME`, Context Room state, Codex, Hermes, projects, and the
host project under `/data`, then assigns their environment variables. It removes
every inherited `GIT_*` variable plus `SSH_AUTH_SOCK`, `SSH_ASKPASS`, and
`SSH_ASKPASS_REQUIRE`, installs an empty private one-link global Git config, and
disables system Git config and terminal prompting. For SSH it pins the exact key
and known-hosts file with `BatchMode=yes`, `IdentityAgent=none`,
`IdentitiesOnly=yes`, and `StrictHostKeyChecking=yes`. Hosted startup therefore
does not inherit the container user's normal HOME, agent-provider state, Git
config, credential helper, askpass helper, or SSH agent.

After configuration and existing-layout preflight, each boot writes a private
`/data/.bootstrap-incomplete.json` marker that records the exact raw repository
addresses, canonical identities, opaque storage IDs, project IDs, and scopes.
Context Room never listens while that marker represents unfinished work. It
removes the marker only after every repository has synchronized once and every
project binding and materialized configuration has passed its final check. A
Git or catalogue failure may leave internal cache or project-initialization
files, but it leaves the marker and no serving process. The next boot resumes
only if the one-link marker exactly matches the current configuration; an
invalid, symlinked, or mismatched marker fails before effects. Without the
marker, any partial project/registry layout still fails closed. This is a
bounded bootstrap retry, not a cache rollback or a repository-address migration:
internal cache state remains unserved until one complete boot succeeds.

### Legacy project-root migration

The multi-Shared layout is not auto-migrated. If startup finds a configured
project at the old `/data/projects/<project-id>` location, it exits before
project initialization, Shared synchronization, Git work, or server listen. A
symlink or non-directory legacy root also fails. The operator must complete and
verify the migration to
`/data/projects/<opaque-repository-directory-id>/<project-id>` offline. This
procedure moves and validates only those project roots and their bindings; it
preserves `CONTEXT_ROOM_SHARED_HOME` in place.

For an upgrade of `context.qm.peerlab.fr`:

Before migration or deployment, the owner must make and record a separate scope
choice for every configured repository: which, if any, of `global`, `skills`,
and `instructions` this hosted process may expose, and whether `projects` may
create new Shared project proposals. Record `scopes: []` when none is
authorized. Never derive this decision from the repository's projects,
existing files, proposal branches, or the old single-repository configuration.

1. Stop the old Context Room process and keep the Portal from sending writes.
   Record the old image digest and configuration, then create and verify a
   restorable backup or copy of the complete encrypted `/data` volume.
2. Inventory every immediate child of `/data/projects` and classify it as an
   already-namespaced 24-character configured repository directory or a legacy
   project directory. Build an explicit table from each legacy `project-id` to
   exactly one prior raw repository address and its directory ID. Compare that
   address byte-for-byte with the proposed deployment configuration, including
   transport, case, and `.git`. Verify that every source is a real contained
   directory, that its project identity agrees with the mapping, and that the
   destination is absent. On any address mismatch, unknown or repeated entry,
   conflict, or ambiguity, stop and restore the previous image and configuration;
   never infer or normalize the destination.
3. Before moving data, record validation sentinels for each project: selected
   relative paths plus their SHA-256, type, mode, owner, and group. Include the
   project state needed to prove its Shared binding and review continuity.
4. On the same filesystem, create the private repository parent and rename the
   complete project directory atomically to the exact destination. If the
   storage system cannot provide that rename, copy into a private staging
   directory, verify the full tree and sentinels there, then rename staging to
   the final destination. Never merge with or overwrite an existing target.
5. Restore the remote service UID/GID and private directory permissions. Verify
   that every destination real path remains below `/data`, every sentinel still
   matches, and no legacy source path remains.
6. Back up and hash the preserved
   `home/.context-room/shared/registry.json`, then replace only that file with a
   deterministic version 1 document. It contains exactly one binding per
   configured project, in repositories-file and `projectIds` order. Each binding
   copies `repository` byte-for-byte from its backed-up binding and first proves
   that it is identical to the deployment configuration; the rewrite never
   changes that string. It also records the exact `projectId` and the same absolute
   `<dataRoot>/projects/<repository-id-24>/<project-id>` value for `sourceRoot`
   and the sole `projectRoots` entry:

   ```json
   {
     "version": 1,
     "bindings": [
       {
         "repository": "<exact-prior-raw-repository-address>",
         "projectId": "project-id",
         "sourceRoot": "<dataRoot>/projects/<repository-id-24>/project-id",
         "projectRoots": ["<dataRoot>/projects/<repository-id-24>/project-id"]
       }
     ]
   }
   ```

   Write the final newline-terminated bytes to a private `0600` sibling staging
   file, flush the file descriptor with `fsync`, close it, and atomically rename
   it over `registry.json`. Reopen and validate version, byte-exact repository
   addresses, project coverage, unique IDs, contained existing roots, and exact
   bindings before boot. Do not modify, move, merge, or clear proposal, review,
   receipt, authority, clone, Git-directory, worktree, or cache state elsewhere
   in the preserved Shared Home.
7. Run the new image first against the migrated copy with the production-shaped
   configuration and secrets. Require a clean startup, service-secret health,
   the expected repositories, projects, and explicitly chosen scopes, absence
   of every undeclared scope, and unchanged validation sentinels before
   promoting the migrated volume and starting the public service.
8. If any move, copy, registry rewrite, validation, binding check, or smoke boot
   is incomplete,
   keep the service stopped. Preserve both trees as evidence, discard neither,
   and restore the complete verified volume backup together with the previous
   image and configuration. Retry only after the mapping and destination are
   unambiguous. Startup never repairs, merges, deletes, or silently accepts a
   partial migration.

## Peerlab image deployment

For the Peerlab installation, the remote image workflow starts only after the `CI` workflow has completed successfully for a same-repository push on `main`. The unit matrix covers Node 20, the pinned Node 22.23.0 patch, and Node 24; each matrix job has a 25-minute cap. Browser, performance, and soak gates run on Node 24 to match the remote image runtime, with 35-minute browser and soak caps; the image job has a 90-minute cap. An eligibility job checks the current `main` revision through the GitHub API before the run can enter the image concurrency group, so an obsolete CI completion cannot cancel a valid build. Eligible image runs are serialized and a newer run cancels the older one. The image job reads `refs/heads/main` from the remote again immediately before the build and inside the dispatch script immediately before the downstream workflow call; if the CI revision is no longer the current head, it exits without deploying that obsolete revision. Every remaining step checks out, builds, tags, records, and dispatches the exact `head_sha` that passed CI together with the signed digest.

The dispatch carries `correlation_id=context-room-<source-sha>-<image-workflow-run-id>-<image-run-attempt>`, so a manual rerun cannot collide with the downstream run from its earlier attempt. A dedicated GitHub App token is limited to `Actions: write` on the private `peerlab-qm` repository; it cannot read or change repository contents. The source workflow locates exactly one downstream run named `Update Context Room image · <correlation-id>`, fails closed on ambiguity or timeout, records its exact run ID, then issues a fresh repository-scoped App token immediately before watching that run with exit-status propagation. That updater independently verifies the commit tag, digest, and Cosign signer, changes only the immutable image pin, and auto-merges the technical update. It then dispatches and waits for the exact `Validate and deploy · <correlation-id>` run on the resulting QM `main` revision. Therefore a non-stale Context Room image run completes successfully only after the actual validated OVH deployment succeeds; an updater, merge, or deployment failure propagates back through the chain.

This release adapter is Peerlab-specific. Other installations may consume the signed image artifact with their own deployment system; Context Room's local and generic remote modes do not depend on QM or this GitHub App.

## Required configuration

```text
CONTEXT_ROOM_REMOTE=1
CONTEXT_ROOM_BUILD_REVISION=<complete 40-character source Git SHA baked into the image>
CONTEXT_ROOM_SHARED_REPOSITORIES_FILE=/run/secrets/context-room-shared-repositories.json
CONTEXT_ROOM_DATA_ROOT=/data
CONTEXT_ROOM_PUBLIC_HOST=context.peerlab.fr
CONTEXT_ROOM_BROWSER_HOST=context.qm.peerlab.fr
CONTEXT_ROOM_IDENTITY_ISSUER=peerlab-qm
CONTEXT_ROOM_ADMIN_SUBJECTS=<Mathis principal>,<Florent principal>
CONTEXT_ROOM_HUMAN_SECRET_FILE=/run/secrets/context-room-human
CONTEXT_ROOM_AGENT_SECRET_FILE=/run/secrets/context-room-agent
CONTEXT_ROOM_HEALTH_SECRET_FILE=/run/secrets/context-room-health
CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE=/run/secrets/context-room-proposal-ssh
CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE=/run/secrets/github-known-hosts
CONTEXT_ROOM_GITHUB_APP_ID=<app id>
CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID=<installation id>
CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE=/run/secrets/context-room-review-app.pem
```

`CONTEXT_ROOM_SHARED_REPOSITORIES_FILE` is a non-empty JSON array. Every entry
is an object with `repository`, `projectIds`, and optionally `scopes`; any other
field, an empty top-level array, a non-string project ID, or an empty
`projectIds` list fails startup. An explicit empty `scopes` list is valid:

```json
[
  {
    "repository": "git@github.com:blancmathis/peerlab-shared-context.git",
    "projectIds": ["peerlab", "hicharlie", "hicharlie-her"],
    "scopes": ["global", "skills", "instructions"]
  },
  {
    "repository": "https://github.com/example/another-shared-context.git",
    "projectIds": ["another-project"],
    "scopes": ["projects"]
  }
]
```

Hosted repositories accept only these GitHub network-remote forms:
`https://github.com/<owner>/<repository>[.git]` or
`git@github.com:<owner>/<repository>[.git]`. Once persistent Shared state exists,
the complete raw `repository` value is immutable: SSH and HTTPS, case variants,
and values with or without `.git` are distinct storage keys and are never
normalized during upgrade. Alternate spellings of the same GitHub identity in
one configuration are rejected rather than merged. Project IDs are trimmed,
lowercased, limited to 63 letters, numbers, or hyphens, and must start with a
letter or number. `global`, `skills`, and `instructions` are reserved and cannot
be project IDs. `scopes` is a separate, optional array containing only those
four exact values: `global`, `skills`, `instructions`, and `projects`. It
defaults to `[]` and rejects duplicates. `projects` remains a valid project ID
because this operator capability is not a proposal scope. Declaring a project
ID never authorizes an operator scope, and a scope declaration for one
repository never authorizes it for another. A repeated project ID inside one
entry, a project ID assigned to more than one repository, or a project ID equal
to any generated 24-character repository directory ID fails the complete boot.
Global project-ID uniqueness is required because the agent gateway resolves its
technical roots by project ID.

The legacy single-repository pair remains compatible:

```text
CONTEXT_ROOM_SHARED_REPOSITORY=git@github.com:blancmathis/peerlab-shared-context.git
CONTEXT_ROOM_PROJECT_IDS=peerlab,hicharlie,hicharlie-her
```

Those two variables must appear together. They may also appear with
`CONTEXT_ROOM_SHARED_REPOSITORIES_FILE`; startup merges both sources and then
applies the same repository-identity, project-ID, and collision checks. They are
not two ways to repeat the same repository. The legacy pair always grants
`scopes: []`; to authorize a special scope on that repository, replace the pair
with one repositories-file entry whose repository address is copied
byte-for-byte from the legacy value. At least one repositories-file entry or the
complete legacy pair is required.

The repositories file, all three signing-secret files, the proposal SSH key,
known-hosts file, and GitHub App private key must use absolute paths whose final
entry is a readable regular file rather than a symlink. Validation pins the
resolved file to the same device, inode, and bounded size before use. The
repositories file and Git key material are limited to 1 MiB; each signing secret
is limited to 64 KiB and must contain at least 32 bytes. Mount these files as
read-only secret or configuration files outside `/data`; do not place their
contents in environment values or the persistent volume.

When GitHub App acceptance is configured, the App ID and installation ID must
both be positive decimal integers no greater than `2^63 - 1`, and all three App
settings must be present together. Startup reads and parses the private-key file
as an unencrypted RSA PEM. A missing companion setting, zero, negative,
out-of-range or malformed ID, encrypted key, non-RSA key, or malformed PEM fails
before providers or persistent application state initialize.

`CONTEXT_ROOM_PUBLIC_HOST` is the trusted upstream host asserted by the private
proxy. Peerlab's Portal reaches Context Room through `context.peerlab.fr`, while
`CONTEXT_ROOM_BROWSER_HOST` names the public `context.qm.peerlab.fr` page that
pairing and return URLs must open.
The image build writes the exact source revision into its OCI metadata, its
root-owned read-only build file, and its runtime environment. Remote startup
rejects a missing, abbreviated, or malformed revision, as well as an environment
override that differs from the baked revision, before it initializes persistent
state. Browser URLs must use `CONTEXT_ROOM_BROWSER_HOST`; the private upstream
host is never emitted as the hosted user-facing origin.
The open-source default issuer is `context-room`; an adapter whose signed
identities use another issuer must set `CONTEXT_ROOM_IDENTITY_ISSUER` to the
same value.
`CONTEXT_ROOM_ADMIN_SUBJECTS` must use the exact identities produced by QM. The
three signing secrets must be different. GitHub App configuration may be
omitted only when acceptance is intentionally unavailable; in that state both
`POST /api/shared-context/accept-challenge` and
`POST /api/shared-context/accept` return
`503 shared_context_remote_acceptance_unavailable` before issuing authority or
starting Git work.

## Remote Workspace control

The open-source remote protocol exposes:

- `GET /api/agent/ui/workspaces` to list only Workspaces owned by the token user and scoped project;
- `POST /api/agent/ui/open` to resolve and navigate an exact, paired, unique, or explicitly recent Workspace;
- `POST /api/workspaces/pair` for the authenticated browser to redeem a five-minute, one-use pairing ticket.

The pairing ticket is carried only in the URL fragment and binds the user,
project, session, and expected Workspace. The browser removes the fragment
immediately after exchange. A missing page returns `open_required`; multiple
compatible pages return `workspace_ambiguous`. QM maps its `threadRef` to the
Context Room session and exposes these commands through `peerlab-context ui`.
Navigation remains ephemeral and cannot invoke review, rejection, or acceptance.
The short-lived `ui:workspace:*` bearer is a reusable capability until it
expires, so an agent can list candidates and then navigate with the same scoped
token. Pairing tickets remain strictly one-use. Non-UI agent mutations keep
their one-request anti-replay enforcement.

Each pending browser Workspace command exists only in memory and is bound to
the exact `generation`, `reviewAuthorityId`, and `reviewProposalHead` of that
Workspace registration. When registration changes the review binding—including
the transition from an unbound Hub to one exact Hosted Review—it rotates the
generation and removes the previous command. Under the review, `GET
/api/workspaces/<workspace-id>/command` returns HTTP `200` with
`{"command":null}` until a command is issued under that exact current binding;
reading also purges any mismatched entry fail-closed. A newly issued command
after the exact review binding is established is readable normally.

## Acceptance authority

The proposal SSH key publishes only `proposal/*`. Opening the terminal acceptance confirmation creates a short-lived, one-use challenge bound to the signed QM administrator, current review authority, `accept` action, and exact proposal head. Human acceptance consumes that challenge, rechecks the proposal head and current `main`, requires every current proposal file to have review proof for its exact content or absence and safe Git mode, creates the canonical commit with reviewer trailers, and pushes directly to `main` with the repository-limited GitHub App token. A missing, expired, reused, or mismatched challenge, changed proposal, unsafe entry type, mode mismatch, or concurrent `main` fails closed; no force push is performed.

After the push, Context Room fetches the remote default branch again and proves that it contains the accepted commit before returning `deliveryVerified: true`. Clone, initial fetch, push, and delivery-verification fetch each have a 120-second budget. The GitHub App token request has a 15-second budget. Either expiry returns HTTP `504` with `retryable: true` and `github-app-token-timeout` or `shared-delivery-timeout`. The response also carries the exact proposal and head, commit, verified remote head, default branch, Hub refresh state, and a one-use flash token of exactly 32 URL-safe characters; the UI accepts terminal success only when every field matches the open review.

The terminal confirmation stays open with **Putting on main…** while this operation runs. A server rejection or incomplete success response closes that consumed confirmation and leaves a persistent accessible error with **Retry**; retry opens a fresh challenge and confirmation so a failed delivery cannot look successful or replay stale authority. If the push succeeded but local delivery proof or response recording failed, a retry locates a candidate by the exact `Context-Room-Proposal` and `Context-Room-Proposal-Head` trailers, reapplies the reviewed result to that commit's single parent, and requires the complete expected tree—including content, paths, executable modes, and safe entry types—to equal the candidate tree. Matching trailers alone are insufficient. Only renewed remote containment proof permits an atomic acceptance-receipt write, without a second commit or push. If delivery is verified but the Hub snapshot cannot be rebuilt, the UI reports **Merged into main · Hub refresh pending** instead of presenting the merge as failed; the proposal row and active counters may remain stale until the Hub refresh completes.
