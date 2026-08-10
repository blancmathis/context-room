---
context_room:
  id: assurance.review.human-authority
  depends_on:
    - strategy.context-room
    - domains.truth.layers
---

# Human Review Authority

## Summary

Humans own file review decisions and Shared proposal acceptance or rejection. Context Room preserves that authority through separated agent and owner surfaces, monotonic agent permissions, exact review evidence, and one-use terminal request binding.

## Defines

This document defines who may decide, what evidence a decision covers, the mandatory agent confirmation protocol, and limits of technical enforcement.

## Does not define

This document does not define queue ordering, diff rendering, Git delivery algorithms, identity-provider deployment, or conversational UX beyond the mandatory confirmation rule.

## Authority rules

1. A human decides whether each file change is accepted, rejected, or needs changes.
2. Individual file decisions are available only in the direct human interface.
3. A Shared proposal terminal decision is separate from its file decisions.
4. Agent-facing commands do not expose file decisions, proposal acceptance, proposal rejection, or verification.
5. Agent-controlled settings may widen review coverage but may not narrow owner-authorized coverage.
6. Snoozing changes visibility only; it does not change trust.
7. Recovered or damaged authority evidence is not silently trusted.

## Agent confirmation protocol

Before an agent performs a multi-file review mutation or assists with a terminal proposal action:

1. it asks whether the user wants the exact action;
2. after the first affirmative answer, it restates the exact project, repository, proposal or file set, and effects;
3. it asks again;
4. it does nothing unless the user gives a second separate, unambiguous affirmative answer.

Confirmations do not transfer to another action, scope, proposal head, or retry.

This is a behavioral authority rule. The command surface reinforces it by withholding terminal commands, but the runtime cannot prove the semantic content of a conversation.

## Owner-authorized scope

Context Room stores the last owner-authorized review scope outside project configuration. Direct configuration changes that narrow the protected scope do not become effective automatically. They produce an authority issue until the owner saves the intended scope through the human Settings surface.

## File review evidence

Trusted evidence binds to exact resource state, including canonical path, content hash or absence, file mode where relevant, resource version, dependency versions where required, and owner-authority integrity.

A changed hash, restored deletion, changed mode, changed proposal head, or stale dependency invalidates the old decision.

## Terminal request binding

The terminal UI requests a short-lived, one-use challenge bound to principal, review authority, action, repository, proposal branch, and exact head. The challenge is consumed before mutable terminal work begins. A retry requires a new challenge.

Local mode proves continuity with the current owner-interface instance. Hosted mode also binds the signed allowed administrator identity and scope.

## Security limit

A nonce, challenge, and separated CLI block accidental or raw unauthorized requests. They do not prove physical human presence against an unrestricted process or browser automation running as the same OS user. Product claims must state this limit.

## Failure behavior

Missing, altered, replayed, expired, mismatched, recovered, or stale authority evidence fails closed. The user must reopen or rematerialize the review and establish fresh exact decisions.
