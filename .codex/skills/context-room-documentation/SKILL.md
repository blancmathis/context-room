---
name: "context-room-documentation"
description: "Create, restructure, and maintain complete project documentation with the Context Room model. Use for documentation architecture, canonical ownership, Markdown, Mermaid diagrams, visual HTML, image wrappers, document dependencies, project artifacts, or current-versus-target documentation changes."
---

# Context Room Documentation

## Outcome

Create one body of durable project truth that is easy for a human to understand and precise enough for an agent to build from.

The documentation covers the whole project:

- why it exists and how it should be perceived;
- what it promises and delivers;
- how it works technically;
- how it is marketed, sold, delivered, and operated;
- how quality, safety, and compliance are proven; and
- how it changes over time.

Use the simplest structure and format that make the truth clear. Do not create documentation bureaucracy.

## Read the references

For every documentation creation, restructuring, or maintenance task, read:

- `references/documentation-model.md` — universal structure, canonical ownership, writing standard, YAML, dependencies, artifacts, and current/target lifecycle.

Also read:

- `references/formats-and-diagrams.md` — Markdown, Mermaid diagram documents, navigable Context Room diagrams, visual HTML, PNG/SVG wrappers, and machine schemas.

The references are part of this skill. Follow them rather than inventing a competing structure.

## Non-negotiable rules

1. **One durable truth, one canonical owner.** Update the existing owner instead of creating a competing explanation.
2. **Current and target truth stay separate.** Normal project documents describe what is true now. Proposed changes live under `docs/evolution/changes/active/`.
3. **The path classifies the document.** Do not repeat type, domain, truth state, owner, or review status in metadata when the path or Context Room already determines them.
4. **Metadata stays minimal.** Use only a stable `id`, direct `depends_on`, and meaningful `artifacts`.
5. **References are not dependencies.** A body link helps navigation. `depends_on` means the current document may need review when the target changes.
6. **The body stays human-readable.** Structure it for agents without turning it into a machine form.
7. **No empty templates.** Add a section, file, or directory only when it carries useful information.
8. **Diagrams explain; they do not decorate.** Every diagram answers one explicit question.
9. **Use the simplest adequate format.** Markdown first, Mermaid for relationships and flow, HTML for richer spatial explanation, images for static evidence.
10. **Human review remains authoritative.** Never write acceptance, verification, review dates, hashes, or inverse dependencies into document metadata.

## Operating workflow

### 1. Decide whether the information is durable

Document information that must remain discoverable and treated as true in future work.

Do not create canonical documents for raw brainstorming, temporary task notes, every meeting transcript, backlogs, private agent reasoning, or reports already owned by another system unless they produce a durable conclusion.

### 2. Find the canonical owner before writing

Search accepted documentation before creating a file. When Context Room is available, use its deterministic documentation commands:

```bash
context-room docs search "<subject>" --status current
context-room docs related <path>
context-room docs trace <path>
context-room docs read <path-or-section>
```

Update the existing owner when one exists. Create a new document only when the subject has an independent responsibility, evolves independently, is referenced from several places, or has no clear owner.

Keep unresolved durable facts explicit as open questions. Do not silently invent current truth.

### 3. Place the document in the universal structure

Use the six zones defined in `references/documentation-model.md`:

| Zone | Question |
| --- | --- |
| `strategy/` | Why, for whom, and what position or perception? |
| `product/` | What is promised and delivered? |
| `system/` | How is it technically realized? |
| `operations/` | How is it marketed, sold, delivered, supported, and run? |
| `quality/` | How is the result measured, proven, secured, and governed? |
| `evolution/` | What is changing, why, and what happened historically? |

The directory tree is a vocabulary, not a checklist. Never create empty folders merely to match it.

### 4. Choose the simplest format

Use this order:

```text
Clear in prose or a small table?
  → Markdown

Primarily parts, flow, order, states, boundaries, or handoffs?
  → Mermaid in Markdown

Needs precise layout, multiple views, rich comparison, or native interaction?
  → HTML

Static screenshot, external visual, or visual evidence?
  → PNG or SVG owned by a text document
```

Use a separate `.diagram.md` only when the visual is reusable, cross-document, independently reviewed, or a navigation point. Keep a local diagram inside its owning Markdown document.

### 5. Apply the common document contract

Every first-class document must have:

- a stable document ID;
- a literal title;
- one sentence stating the main durable truth;
- what the document defines;
- what it does not define; and
- a natural body suited to the subject.

Markdown example:

```markdown
---
context_room:
  id: product.review.human-approval
  depends_on:
    - strategy.trust.human-control
  artifacts:
    code:
      - src/review/**
---

# Human document approval

> **Summary:** A document version becomes trusted only after a human accepts its exact content.
>
> **Defines:** The observable approval, rejection, and invalidation rules.
>
> **Does not define:** Git transport or the internal storage format.

## How approval works

Start directly with the durable information.
```

Do not force a fixed body template for every document kind. Add `Evidence`, `Open questions`, failure behavior, examples, or other sections only when useful.

### 6. Connect the document correctly

Use four distinct connections:

| Connection | Source | Meaning |
| --- | --- | --- |
| Dependency | YAML `depends_on` | The document may need review when the target changes. |
| Reference | Markdown link or HTML `href` | Helps the reader understand or navigate. |
| Visual connection | Mermaid arrow or HTML edge | Explains the subject inside a diagram. |
| Artifact | YAML `artifacts` | Links code, tests, schemas, config, telemetry, examples, or assets. |

Declare only direct maintenance dependencies. Never list transitive or inverse dependencies. Context Room derives `depended on by`, backlinks, diagram appearances, and artifact views.

A body link does not automatically create `depends_on`. When both meanings apply, keep both the YAML dependency and the body link.

### 7. Keep current and target truth separate

For an active project change:

1. describe the current state, target state, and delta under `docs/evolution/changes/active/`;
2. link the affected current documents and artifacts;
3. implement code, tests, schemas, operations, and documentation together;
4. update the canonical current owners after the change is real;
5. archive the change under `docs/evolution/changes/archive/`; and
6. ensure no current truth remains only in the archived change.

Decisions and records explain why something changed or what happened. They do not replace current documentation.

### 8. Validate before finishing

Check:

- canonical ownership and absence of duplicated truth;
- correct zone, category, and domain;
- unique stable ID;
- direct dependencies only;
- valid body links and artifact paths;
- literal title, `Summary`, `Defines`, and `Does not define`;
- current/target separation;
- no empty folders, files, or boilerplate sections;
- simplest adequate format;
- readable diagrams with one question and safe document links;
- semantic, accessible, script-free HTML;
- text ownership, provenance, caption, and alt text for standalone images; and
- current owner updates before archiving a completed change.

Run the narrowest relevant project checks and, when available:

```bash
context-room doctor --root .
```

## Review and write routing

- **Local canonical owner:** edit the local document and leave the exact changed version for human review.
- **Shared canonical owner:** use a scoped shared proposal and publish the exact proposal revision for review.
- **Mixed change:** use each required route without copying one truth into several owners.
- **Legacy metadata:** preserve the existing metadata contract unless the task explicitly includes migration.

Never accept, reject, merge, or mark documentation verified on the user's behalf.
