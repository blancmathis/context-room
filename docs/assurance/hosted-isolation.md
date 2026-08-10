---
context_room:
  id: assurance.hosted.isolation
  depends_on:
    - strategy.context-room
    - system.runtime-profiles
---

# Hosted Isolation

## Summary

Hosted Context Room is a Shared-only service. It must not read, infer, expose, or mutate a user's local projects, worktrees, prompt state, provider homes, Context Room homes, or local-only capabilities.

## Defines

This document defines the hosted threat model, prohibited data and capabilities, fail-closed rules, and evidence required to claim isolation.

## Does not define

This document does not define container rollout commands, external DNS, reverse-proxy implementation, or Shared proposal semantics.

## Protected local domains

Hosted operation must not access:

- local project or worktree roots;
- local Hub registry;
- local review ledgers or owner scope;
- local snapshots;
- `$HOME`, `$CODEX_HOME`, Hermes or provider homes;
- Prompt Center catalogs, overrides, receipts, or composer bridge;
- local Settings;
- local startup instructions, skills, or hooks;
- arbitrary repositories or credentials outside service configuration.

## Allowed hosted domains

Hosted operation may access only the dedicated service data root, explicitly configured Shared repositories, immutable accepted snapshots, exact proposal/review workspaces under the data root, service secrets and repository-scoped credentials, and public build identity through service-authenticated health.

## Fail-closed startup

Before providers or files are touched, startup validates exact host, non-empty administrator allowlist, separate human/agent/health secrets, dedicated data root, exact repository configuration, safe opaque IDs, and required profile. Invalid configuration prevents startup.

## Route isolation

Hosted profiles use explicit allowlists. A local-only route remains unavailable even with a local-looking path, project ID, query, Origin, Referer, or forged navigation state. Browser history is canonicalized to the hosted profile.

## Response isolation

Hosted responses and errors remove server-only fields. They must not expose physical roots, review roots, worktree paths, repository transports, credentials, home paths, or absolute paths. Internal exceptions pass through the same projection.

## Filesystem isolation

Mutable caches, proposal worktrees, review workspaces, locks, receipts, and journals live below the dedicated service data root. Symlinks, special files, traversal, root substitution, and cache escape fail closed.

## Evidence required

A release may claim hosted isolation only when tests prove:

1. exact hosted assets;
2. denial of local routes;
3. no touches to fake local homes/providers;
4. response and error redaction;
5. exact proposal scope and safe paths;
6. identity and operation scoping;
7. fail-closed startup;
8. non-root container execution;
9. immutable image identity and provenance.

This repository proves application and image-build behavior. Live proxy, secret injection, DNS, and external deployment require separate operational evidence.
