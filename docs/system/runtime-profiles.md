---
context_room:
  id: system.runtime-profiles
  depends_on:
    - product.model
---

# Runtime Profiles

## Summary

Context Room has three runtime profiles with different data providers and route capabilities: `local`, `hosted-hub`, and `hosted-review`.

## Defines

This document defines the profile matrix and the rule that disallowed capabilities must be absent rather than merely hidden.

## Does not define

This document does not define reverse-proxy configuration, identity-token wire format, Shared Git mechanics, or local feature details.

## Profile matrix

| Capability | `local` | `hosted-hub` | `hosted-review` |
| --- | --- | --- | --- |
| Global Hub | Yes | Yes, Shared-only | No; exact review shell |
| Local projects/worktrees | Yes | No | No |
| Shared repositories | Registered local set | Explicit hosted set | Exact review repository |
| Explorer | Authorized local and accepted Shared | Accepted Shared projection | Exact review files |
| Settings | Yes | No | No |
| Startup environment | Yes | No | No |
| Codex Prompt Center | Yes | No | No |
| Local provider homes | Explicit local use | No | No |
| Local file mutation | Authorized paths | No | No |
| Proposal file review | Yes | Opens exact hosted review | Exact review |
| Terminal decision | Human UI only | Exact review | Scoped human UI |
| Health endpoint | Local health | Service-only build identity | Service-only build identity |

## Local

The local profile binds to loopback. It can access configured local paths, private Context Room homes, registered accepted Shared snapshots, and explicitly enabled local extensions.

## Hosted Hub

Hosted Hub starts from an empty host project and injects only configured Shared repositories. It returns projected IDs and Shared metadata without server filesystem paths, credentials, repository transports, review roots, local homes, or local settings.

## Hosted Review

Hosted Review is bound to one exact review authority, proposal branch, and head. It exposes only the files and actions required for that review. It is not a general Shared browser or local Context Room.

## Capability construction

Each profile receives an explicit route and asset allowlist. Disallowed providers must not be initialized before profile validation. A request to a local-only route in hosted mode returns the hosted unavailable response without touching local state.

## Identity

Hosted human identities are signed, short-lived, operation-scoped, and checked against an explicit case-sensitive administrator allowlist for terminal actions. Agent identities have narrower operations and never gain terminal review authority.

## New capability rule

Adding a route, asset, provider, startup read, filesystem root, response field, or mutation requires an explicit decision and deny-by-default test for every profile.
