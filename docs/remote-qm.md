# Remote QM deployment

Remote mode is an explicit deployment profile for a trusted QM Portal. Local Context Room remains loopback-only and requires no remote identity configuration.

## Network and identity boundary

- Publish only the QM Portal at `context.qm.peerlab.fr`; never publish port `4317`.
- The Portal signs a one-request human identity for an approved administrator and forwards it as `x-peerlab-context-identity`.
- QM Core signs ten-minute agent capabilities. Each capability contains the actor, QM scope, Context Room project, task/session, allowed operations, expiration, and anti-replay ID.
- Human and agent signing secrets are distinct, at least 32 bytes, and mounted as files.
- The private health endpoint requires its own secret.
- Human acceptance obtains a one-hour GitHub App installation token only for the exact repository. The private key is mounted as a secret and is never stored under `/data`.
- Proposal Git SSH credentials are mounted outside `/data`; branch protection must reject that credential on `main`.

## Persistent state

Mount the encrypted Docker volume at `/data`. It contains the Context Hub registry, shared accepted snapshots, proposal review worktrees, review state, and audit journals. Back up this volume, but exclude every mounted secret file. The `Dockerfile.remote` image runs as an unprivileged user and declares `/data` as its only persistent volume.

## Required configuration

```text
CONTEXT_ROOM_REMOTE=1
CONTEXT_ROOM_SHARED_REPOSITORY=git@github.com:blancmathis/peerlab-shared-context.git
CONTEXT_ROOM_DATA_ROOT=/data
CONTEXT_ROOM_PROJECT_IDS=peerlab,hicharlie,hicharlie-her,makemydoc,auditia,prospection,agent-factory,qm-operations
CONTEXT_ROOM_PUBLIC_HOST=context.qm.peerlab.fr
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

`CONTEXT_ROOM_ADMIN_SUBJECTS` must use the exact identities produced by QM. The three signing secrets must be different. GitHub App configuration may be omitted only when acceptance is intentionally unavailable.

## Acceptance authority

The proposal SSH key publishes only `proposal/*`. Human acceptance rechecks the proposal head and current `main`, requires every current proposal file to have review proof, creates the canonical commit with reviewer trailers, and pushes directly to `main` with the repository-limited GitHub App token. A changed proposal or concurrent `main` returns `409`; no force push is performed.
