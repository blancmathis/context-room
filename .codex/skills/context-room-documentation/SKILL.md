---
name: context-room-documentation
description: Create and maintain Context Room documentation with stable IDs, explicit dependencies, human review, and shared proposals. Use when creating, restructuring, or updating project documentation managed by Context Room.
---

# Context Room Documentation

Create durable documentation that agents can resolve deterministically and humans can review safely.

## Workflow

1. Find the canonical owner with `context-room docs search`, then read the relevant sections with `context-room docs read`. Both read accepted versions deterministically. Resume the returned `readerToken` using `--reader` to receive accepted changes to documents already consulted; an available generic conversation ID can provide continuity automatically. Consult only the relevant `context-room capabilities` section when the exact command contract is needed.
2. Read the relevant current documents and their direct dependencies.
3. Update the smallest canonical owner. Do not duplicate the same fact in several files.
4. Place truth by its nature: strategy, product, optional business domain, system, operations, or assurance. Keep accepted future targets, decisions, and historical records under `lifecycle/`. A domain owns stable language, models, boundaries, events, and implementation-independent invariants; it links to product and system owners instead of duplicating them.
5. Keep formats complementary: Markdown or a native schema owns exact truth; a diagram maps a relationship; and an HTML `.view.html` guides exploration. A map is selective, a focused model may own one exact relation, and a view must not copy the full truth of its sources.
6. Follow the official Context Room documentation profile: give every ordinary new Markdown or HTML document a stable `context_room.id`. Use `depends_on` to record explicit semantic relationships for navigation. This is the skill's convention, not a universal metadata requirement of the Context Room core.
7. Use `context-room changes list` and `changes status` to find existing work. Start an isolated local or Shared proposal with `changes begin --scope local|shared`, edit only its returned `editRoot`, then run `changes submit`. Accepted files remain unchanged until human acceptance. Direct filesystem changes remain detectable for compatibility. Never write directly to Shared main.
8. Leave every review decision to the human. Before any acceptance, rejection, verification, removal confirmation, or other review decision, ask the user explicitly. After the first yes, restate the exact action, project, proposal or file scope, and effects, ask again, and do nothing unless the user gives a second separate, unambiguous yes.

Read [documentation-model.md](references/documentation-model.md) for the metadata contract and [formats-and-diagrams.md](references/formats-and-diagrams.md) for links, HTML, Mermaid, images, and schema files.

## Boundaries

- Accepted current documentation is the only source of build context.
- Targets, history, unverified files, and proposal content remain explicit non-current layers.
- The architecture is a vocabulary, not a checklist. Do not create empty areas, domains, or lifecycle folders.
- Preserve coherent legacy `quality/`, `evolution/`, `_target.*`, or `target/` conventions until an explicit migration owns the path changes.
- `AGENTS.md`, `CLAUDE.md`, and `SKILL.md` may use their provider-native contracts without a document ID.
- Do not infer dependencies from vague thematic similarity. Links support navigation; Context Room does not create reviews or alerts for unchanged dependent documents.
- Never mark a review verified for the user. Never accept, reject, or confirm a removal after only one user approval; the two-confirmation rule in step 8 applies every time.
- Documentation maintenance belongs to the project prompt or agent instructions. Change a document only when its content needs updating.
