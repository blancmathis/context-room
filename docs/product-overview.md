---
context_room:
  id: product.model
  depends_on:
    - strategy.context-room
    - domains.truth.layers
    - assurance.review.human-authority
---

# Product Model

## Summary

Context Room is one global Hub with selectable local, worktree, Shared, proposal-review, and hosted surfaces. It presents accepted context and pending review without collapsing their authority or temporal state.

## Defines

This document defines the observable product model, primary user surfaces, and distinctions between local, global, Shared, proposal, and hosted operation.

## Does not define

This document does not define Git algorithms, HTTP routes, JSON schemas, deployment steps, review cryptography, or feature-specific interaction details.

## Mental model

The user works in one Context Hub.

The Hub aggregates:

- registered local logical projects;
- registered worktree locations for each logical project;
- registered Shared repositories;
- Shared projects from accepted repository main;
- active Shared proposals;
- local file reviews and exact Shared proposal reviews;
- deterministic health, context, and review summaries.

A selected location narrows Explorer, Settings, Startup environment, effective context, and project-specific actions. Selection does not replace the global level.

## Product surfaces

### Context Hub

The Hub is the global entry point and attention surface. It groups worktrees as locations of one logical project and keeps Shared repositories independently identifiable.

### Explorer and editor

The workspace exposes only authorized project files and supported visual assets. It is not a general filesystem browser. Editability and review coverage are separate boundaries.

### Review queue

The queue shows watched local files and exact Shared proposal files that still require human decisions. File decisions do not implicitly accept a proposal.

### Shared Context

Shared Context connects one local logical project to one project in one registered Shared repository. Several Shared repositories may be registered. Accepted Shared main can project documents, skills, instructions, and metadata profiles.

### Proposal review

A proposal is an isolated Git change against accepted Shared main. It can be created, resumed, edited, published, rebased, reviewed file by file, accepted, or rejected. Visibility never makes it effective.

### Settings

Local Settings controls project configuration, device preferences, Shared connections, review scope, startup discovery, and advanced local extensions. Hosted profiles do not expose Settings.

### Agent surfaces

`context-room docs`, Context Engine commands, doctor, guard, brief, settings plans, and the CLI registry are deterministic. `context-room ask` launches one isolated researcher over a frozen accepted-only corpus. Agent commands do not accept or reject reviews.

## Runtime profiles

| Profile | Data scope | Main purpose |
| --- | --- | --- |
| `local` | Explicit local paths plus registered accepted Shared snapshots | Full owner workspace |
| `hosted-hub` | Explicitly configured Shared repositories and projected Shared data | Shared-only global overview |
| `hosted-review` | One exact Shared proposal review authority | Human review of one exact proposal revision |

Hosted profiles do not expose local project files, local prompts, local Settings, local provider discovery, or local-only mutation APIs.

## Truth layers

| Layer | Meaning | May drive effective context? |
| --- | --- | --- |
| Current | Accepted local content or accepted Shared main | Yes, subject to scope and provider rules |
| Proposal | Pending isolated change awaiting human decision | No |
| Target | Accepted statement of a future intended change | No |
| Historical | Past decision, release, incident, or superseded behavior | No |

## Core invariants

1. The Hub is always the top level.
2. Worktrees are locations of one logical project.
3. Accepted main and proposal content remain separate.
4. A file review decision never silently performs a proposal terminal decision.
5. Agents do not own acceptance or rejection.
6. Hosted operation is Shared-only.
7. Effective context is deterministic and accepted-only.
