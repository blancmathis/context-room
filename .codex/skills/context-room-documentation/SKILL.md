---
name: context-room-documentation
description: Create and maintain Context Room documentation with stable IDs, explicit dependencies, human review, and shared proposals. Use when creating, restructuring, or updating project documentation managed by Context Room.
---

# Context Room Documentation

Create durable documentation that agents can resolve deterministically and humans can review safely.

## Workflow

1. Find the current canonical owner before writing. Use `context-room context ask`, `context-room docs search`, and `context-room docs trace` as needed.
2. Read the relevant current documents and their direct dependencies.
3. Update the smallest canonical owner. Do not duplicate the same fact in several files.
4. Follow the official Context Room documentation profile: give every ordinary new Markdown or HTML document a stable `context_room.id`. Add `depends_on` only when a change to another document requires this document to be reconsidered. This is the skill's convention, not a universal metadata requirement of the Context Room core.
5. Route local documents to their normal file review. Route shared documentation through `context-room shared propose` and publish the proposal; never write directly to accepted shared main.
6. Leave acceptance or rejection to the human.

Read [documentation-model.md](references/documentation-model.md) for the metadata contract and [formats-and-diagrams.md](references/formats-and-diagrams.md) for links, HTML, Mermaid, images, and schema files.

## Boundaries

- Accepted current documentation is the only source of build context.
- Targets, history, unverified files, and proposal content remain explicit non-current layers.
- `AGENTS.md`, `CLAUDE.md`, and `SKILL.md` may use their provider-native contracts without a document ID.
- Do not infer dependencies from vague thematic similarity. Record only dependencies that require human reconsideration when their accepted version changes.
- Never mark a review verified for the user.
- A dependency freshness task does not mean the accepted content became unverified. Update the document only when its meaning changed; otherwise leave **Confirm still current** to the human.
