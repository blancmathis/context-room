---
name: context-room-documentation
description: Create and maintain Context Room documentation with stable IDs, explicit dependencies, human review, and shared proposals. Use when creating, restructuring, or updating project documentation managed by Context Room.
---

# Context Room Documentation

Create durable documentation that agents can resolve deterministically and humans can review safely.

## Workflow

1. Find the current canonical owner before writing. Start with `context-room ask` and give it a complete research brief: the work being done, what must be understood or verified, relevant constraints, and the expected output. Do not reduce the request to keywords. When deterministic inspection is needed, open only the relevant `context-room capabilities` section and request the exact command contract instead of loading the exhaustive inventory.
2. Read the relevant current documents and their direct dependencies.
3. Update the smallest canonical owner. Do not duplicate the same fact in several files.
4. Place truth by its nature: strategy, product, optional business domain, system, operations, or assurance. Keep accepted future targets, decisions, and historical records under `lifecycle/`. A domain owns stable language, models, boundaries, events, and implementation-independent invariants; it links to product and system owners instead of duplicating them.
5. Keep formats complementary: Markdown or a native schema owns exact truth; a diagram maps a relationship; and an HTML `.view.html` guides exploration. A map is selective, a focused model may own one exact relation, and a view must not copy the full truth of its sources.
6. Follow the official Context Room documentation profile: give every ordinary new Markdown or HTML document a stable `context_room.id`. Add `depends_on` only when a change to another document requires this document to be reconsidered. This is the skill's convention, not a universal metadata requirement of the Context Room core.
7. Route local documents to their normal file review. For shared documentation, use `context-room edit list` to inspect open proposals, `context-room edit open <branch>` to resume the correct one, or `context-room edit create "<complete proposal description>"` to create a new one. Edit only the returned proposal worktree; never write directly to accepted shared main.
8. Leave acceptance or rejection to the human.

Read [documentation-model.md](references/documentation-model.md) for the metadata contract and [formats-and-diagrams.md](references/formats-and-diagrams.md) for links, HTML, Mermaid, images, and schema files.

## Boundaries

- Accepted current documentation is the only source of build context.
- Targets, history, unverified files, and proposal content remain explicit non-current layers.
- The architecture is a vocabulary, not a checklist. Do not create empty areas, domains, or lifecycle folders.
- Preserve coherent legacy `quality/`, `evolution/`, `_target.*`, or `target/` conventions until an explicit migration owns the path changes.
- `AGENTS.md`, `CLAUDE.md`, and `SKILL.md` may use their provider-native contracts without a document ID.
- Do not infer dependencies from vague thematic similarity. Record only dependencies that require human reconsideration when their accepted version changes.
- Never mark a review verified for the user.
- A dependency freshness task does not mean the accepted content became unverified. Update the document only when its meaning changed; otherwise leave **Confirm still current** to the human.
