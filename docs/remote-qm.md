# Remote QM deployment

Remote mode is an explicit deployment profile for a trusted QM Portal. Local Context Room remains loopback-only and requires no remote identity configuration.

## Network and identity boundary

- Publish only the QM Portal at `context.qm.peerlab.fr`; never publish port `4317`.
- The Portal signs a one-request human identity for an approved administrator and forwards it as `x-peerlab-context-identity`.
- QM Core signs ten-minute agent capabilities. Each capability contains the actor, QM scope, Context Room project, task/session, allowed operations, expiration, and a unique capability ID.
- Remote UI capabilities add `ui:workspace:list`, `ui:workspace:navigate`, and `ui:workspace:pair`. The Portal and server inject the authenticated user; browser-provided user identity is ignored.
- Human and agent signing secrets are distinct, at least 32 bytes, and mounted as files.
- The private health endpoint requires its own secret.
- Human acceptance obtains a one-hour GitHub App installation token only for the exact repository. Git receives it non-interactively through a request-scoped HTTPS Basic authorization header using the `x-access-token` username; the token never enters the remote URL, command arguments, or persistent Git configuration. The private key is mounted as a secret and is never stored under `/data`.
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

For the Peerlab installation, every successful signed image build dispatches the exact commit and digest to the private `peerlab-qm` deployment repository. A dedicated GitHub App token is limited to `Actions: write` on that repository; it cannot read or change its contents. `peerlab-qm` independently checks that the commit tag resolves to the dispatched digest, verifies the Cosign signer, changes only the immutable image pin, runs its deployment contracts, and auto-merges the technical update. The resulting `main` push uses the existing validated OVH deployment and rollback path. No polling is involved.

This event-driven adapter is Peerlab-specific. Other installations may consume the signed image artifact with their own deployment system; Context Room's local and generic remote modes do not depend on QM or this GitHub App.

## Required configuration

```text
CONTEXT_ROOM_REMOTE=1
CONTEXT_ROOM_SHARED_REPOSITORY=git@github.com:blancmathis/peerlab-shared-context.git
CONTEXT_ROOM_DATA_ROOT=/data
CONTEXT_ROOM_PROJECT_IDS=peerlab,hicharlie,hicharlie-her,makemydoc,auditia,prospection,agent-factory,qm-operations
CONTEXT_ROOM_PUBLIC_HOST=context.qm.peerlab.fr
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

`CONTEXT_ROOM_PUBLIC_HOST` is the trusted host asserted by the private proxy.
When that proxy uses a different upstream hostname, set
`CONTEXT_ROOM_BROWSER_HOST` to the public hostname that pairing URLs must open.
The open-source default issuer is `context-room`; an adapter whose signed
identities use another issuer must set `CONTEXT_ROOM_IDENTITY_ISSUER` to the
same value.
`CONTEXT_ROOM_ADMIN_SUBJECTS` must use the exact identities produced by QM. The
three signing secrets must be different. GitHub App configuration may be
omitted only when acceptance is intentionally unavailable.

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

The proposal SSH key publishes only `proposal/*`. Human acceptance rechecks the proposal head and current `main`, requires every current proposal file to have review proof, creates the canonical commit with reviewer trailers, and pushes directly to `main` with the repository-limited GitHub App token. A changed proposal or concurrent `main` returns `409`; no force push is performed. The terminal confirmation stays open while this operation runs and shows any server rejection in place so a failed delivery cannot look successful or disappear silently.
