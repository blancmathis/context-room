# Remote QM deployment

Remote mode is an explicit deployment profile for a trusted QM Portal. Local Context Room remains loopback-only and requires no remote identity configuration.

## Network and identity boundary

- Publish only the QM Portal at `context.qm.peerlab.fr`; never publish port `4317`.
- The Portal signs a one-request human identity for an approved administrator and forwards it as `x-peerlab-context-identity`.
- QM Core signs ten-minute agent capabilities. Each capability contains the actor, QM scope, Context Room project, task/session, allowed operations, expiration, and a unique capability ID.
- Remote UI capabilities add `ui:workspace:list`, `ui:workspace:navigate`, and `ui:workspace:pair`. The Portal and server inject the authenticated user; browser-provided user identity is ignored.
- Human and agent signing secrets are distinct, at least 32 bytes, and mounted as files.
- The private health endpoint requires its own secret.
- Human acceptance requests a one-hour GitHub App installation token only for the exact repository, with a 15-second request timeout. Git receives it non-interactively through a request-scoped HTTPS Basic authorization header using the `x-access-token` username; the token never enters the remote URL, command arguments, or persistent Git configuration. The private key is mounted as a secret and is never stored under `/data`.
- Proposal Git SSH credentials are mounted outside `/data`; branch protection must reject that credential on `main`.

## Persistent state

Mount the encrypted Docker volume at `/data`. It contains the Context Hub registry, shared accepted snapshots, proposal review worktrees, review state, and audit journals. Back up this volume, but exclude every mounted secret file. The `Dockerfile.remote` image runs as an unprivileged user and declares `/data` as its only persistent volume.

The remote entry point also maintains private technical roots under
`/data/projects/<project-id>` for project-scoped agent capabilities, Shared
Context synchronization, and proposal materialization. These directories are
not source checkouts and must never be registered as local Context Room
projects. The visible project catalog comes from the Shared Context repository,
so remote projects remain shared-only unless a real local checkout is connected
by another deployment profile. On startup, the remote entry point removes any
legacy registry entries that exposed these technical roots as writable local
projects and rebuilds the catalog snapshot before accepting browser requests.

## Peerlab image deployment

For the Peerlab installation, the remote image workflow starts only after the `CI` workflow has completed successfully for a same-repository push on `main`. An eligibility job checks the current `main` revision through the GitHub API before the run can enter the image concurrency group, so an obsolete CI completion cannot cancel a valid build. Eligible image runs are serialized and a newer run cancels the older one. The image job reads `refs/heads/main` from the remote again immediately before the build and inside the dispatch script immediately before the downstream workflow call; if the CI revision is no longer the current head, it exits without deploying that obsolete revision. Every remaining step checks out, builds, tags, records, and dispatches the exact `head_sha` that passed CI together with the signed digest.

The dispatch carries `correlation_id=context-room-<source-sha>-<image-workflow-run-id>-<image-run-attempt>`, so a manual rerun cannot collide with the downstream run from its earlier attempt. A dedicated GitHub App token is limited to `Actions: write` on the private `peerlab-qm` repository; it cannot read or change repository contents. The source workflow locates exactly one downstream run named `Update Context Room image · <correlation-id>`, fails closed on ambiguity or timeout, records its exact run ID, then issues a fresh repository-scoped App token immediately before watching that run with exit-status propagation. That updater independently verifies the commit tag, digest, and Cosign signer, changes only the immutable image pin, and auto-merges the technical update. It then dispatches and waits for the exact `Validate and deploy · <correlation-id>` run on the resulting QM `main` revision. Therefore a non-stale Context Room image run completes successfully only after the actual validated OVH deployment succeeds; an updater, merge, or deployment failure propagates back through the chain.

This release adapter is Peerlab-specific. Other installations may consume the signed image artifact with their own deployment system; Context Room's local and generic remote modes do not depend on QM or this GitHub App.

## Required configuration

```text
CONTEXT_ROOM_REMOTE=1
CONTEXT_ROOM_SHARED_REPOSITORY=git@github.com:blancmathis/peerlab-shared-context.git
CONTEXT_ROOM_DATA_ROOT=/data
CONTEXT_ROOM_PROJECT_IDS=peerlab,hicharlie,hicharlie-her,makemydoc,auditia,prospection,agent-factory,qm-operations
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

`CONTEXT_ROOM_PUBLIC_HOST` is the trusted upstream host asserted by the private
proxy. Peerlab's Portal reaches Context Room through `context.peerlab.fr`, while
`CONTEXT_ROOM_BROWSER_HOST` names the public `context.qm.peerlab.fr` page that
pairing and return URLs must open.
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

## Acceptance authority

The proposal SSH key publishes only `proposal/*`. Opening the terminal acceptance confirmation creates a short-lived, one-use challenge bound to the signed QM administrator, current review authority, `accept` action, and exact proposal head. Human acceptance consumes that challenge, rechecks the proposal head and current `main`, requires every current proposal file to have review proof for its exact content or absence and safe Git mode, creates the canonical commit with reviewer trailers, and pushes directly to `main` with the repository-limited GitHub App token. A missing, expired, reused, or mismatched challenge, changed proposal, unsafe entry type, mode mismatch, or concurrent `main` fails closed; no force push is performed.

After the push, Context Room fetches the remote default branch again and proves that it contains the accepted commit before returning `deliveryVerified: true`. Clone, initial fetch, push, and delivery-verification fetch each have a 120-second budget. The GitHub App token request has a 15-second budget. Either expiry returns HTTP `504` with `retryable: true` and `github-app-token-timeout` or `shared-delivery-timeout`. The response also carries the exact proposal and head, commit, verified remote head, default branch, Hub refresh state, and a one-use flash token of exactly 32 URL-safe characters; the UI accepts terminal success only when every field matches the open review.

The terminal confirmation stays open with **Putting on main…** while this operation runs. A server rejection or incomplete success response closes that consumed confirmation and leaves a persistent accessible error with **Retry**; retry opens a fresh challenge and confirmation so a failed delivery cannot look successful or replay stale authority. If the push succeeded but local delivery proof or response recording failed, a retry locates a candidate by the exact `Context-Room-Proposal` and `Context-Room-Proposal-Head` trailers, reapplies the reviewed result to that commit's single parent, and requires the complete expected tree—including content, paths, executable modes, and safe entry types—to equal the candidate tree. Matching trailers alone are insufficient. Only renewed remote containment proof permits an atomic acceptance-receipt write, without a second commit or push. If delivery is verified but the Hub snapshot cannot be rebuilt, the UI reports **Merged into main · Hub refresh pending** instead of presenting the merge as failed; the proposal row and active counters may remain stale until the Hub refresh completes.
