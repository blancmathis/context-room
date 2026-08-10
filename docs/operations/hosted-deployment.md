---
context_room:
  id: operations.hosted.deployment
  depends_on:
    - assurance.hosted.isolation
    - system.runtime-profiles
    - operations.release.verification
---

# Hosted Deployment

## Summary

Hosted Context Room runs the `context-room-remote` entry point in a non-root container with one dedicated data root, exact Shared repository configuration, separate scoped secrets, and an immutable image revision.

## Defines

This document defines deployment prerequisites, startup contract, rollout checks, rollback, and the evidence boundary between this repository and external infrastructure.

## Does not define

This document does not define product review policy, Shared proposal state transitions, DNS provider configuration, or the implementation of an external deployment repository.

## Prerequisites

- Immutable image digest produced from the intended commit.
- Dedicated persistent data root owned by the container user.
- Exact expected public host.
- Non-empty, case-sensitive administrator subject allowlist.
- Separate high-entropy human, agent, and health secrets.
- Explicit Shared repository list with opaque IDs and repository-scoped credentials.
- Network access limited to the required Git and identity endpoints.
- Reverse proxy that preserves only the expected host and authenticated identity headers.
- Release receipt for the exact image.

## Startup contract

The remote entry point validates all configuration before creating Shared providers or touching repository state.

It constructs an empty host project and injects only explicitly configured Shared repositories. Startup fails when a required secret, administrator, repository identity, host, path, or data-root invariant is missing or unsafe.

A failed startup must not fall back to a local profile or infer repositories from the service filesystem.

## Persistent state

All mutable hosted state lives below the dedicated data root:

- repository caches;
- immutable accepted snapshots;
- proposal worktrees;
- exact review workspaces;
- locks;
- journals;
- receipts.

Normal application rollout and rollback preserve this root.

## Health

The hosted health endpoint is service-authenticated and exposes only:

- `ok`;
- package version;
- build revision.

Human or agent identities do not receive service-health internals.

## Repository automation

The signed-image workflow starts only after the `CI` workflow has completed successfully for a same-repository push on `main`. It checks that the triggering source is still the exact remote `main` revision before building and again before dispatch.

The workflow signs and publishes the immutable image, then dispatches `update-context-room-image.yml` in the Peerlab QM deployment repository with the exact source SHA, image digest, and a unique correlation ID. It locates exactly one downstream run for that dispatch and waits for the exact `Validate and deploy · <correlation-id>` run before reporting delivery.

This repository proves the dispatch contract and exact-run correlation. The downstream repository and live service own the deployment result and runtime receipt.

## Rollout verification

After deployment:

1. verify that the public build revision equals the immutable image revision;
2. verify that Hosted Hub renders only configured Shared repositories;
3. verify that a local-only route returns the hosted unavailable response;
4. verify that Settings, Startup, Prompt Center, and composer-bridge assets are absent;
5. open one exact proposal review with a permitted non-terminal identity;
6. verify that a terminal action requires an allowed administrator identity and a fresh exact challenge;
7. verify response and error redaction;
8. inspect service logs for paths, credentials, prompt content, or local-home access;
9. record the image digest and deployment receipt.

## Rollback

Rollback selects the previous verified immutable image digest. Do not replace, copy, or discard the persistent data root as part of a normal application rollback.

After rollback, repeat:

- health identity;
- runtime-profile asset and route checks;
- Shared repository availability;
- exact review binding;
- response redaction.

If a terminal Shared operation may have reached the remote during a failed rollout, let Context Room reconcile exact remote terminal evidence. Do not manually rewrite proposal refs unless a dedicated, reviewed recovery procedure requires it.

## Escalation

Stop terminal mutations and escalate when:

- expected host or identity headers cannot be proved;
- administrator allowlist or secrets are ambiguous;
- the data root is unsafe or not private;
- repository identity conflicts;
- response redaction fails;
- terminal state is invalid or unverifiable;
- the running revision cannot be tied to an immutable image;
- external infrastructure evidence disagrees with the application release receipt.

## External evidence boundary

This repository defines and tests the application and container boundary. Production reverse proxy, certificate, DNS, secret injection, scheduler, and deployment status belong to the external infrastructure owner and require a separate receipt linked from the release record.
