---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: HTML visual documents
  last_verified: 2026-07-11
  sources: [src/context_room.mjs, docs/features/file-explorer-and-editor.md, docs/features/html-visual-patterns.md, docs/context-room-visual-components.html, docs/context-room-data-visual-components.html]
---

# HTML Visual Documents

## Purpose

Use HTML when spatial structure makes an idea clearer than prose. Context Room renders it with the active app theme while agents edit the semantic source and users review changes.

Every initialized project exposes a standalone creation guide at `.context-room/README.md`. It covers the workflow, visual selection, structure, interaction, scale, and quality gate, then links to detailed references and catalogs. Give that stable path to an agent before asking it to create or change a visual HTML document. Context Room refreshes the generated files on every `init` and `start`.

## Theme Contract

Context Room injects the active app theme into every HTML preview. Changing the theme regenerates the preview with matching background, surface, text, border, accent, and status tokens.

- Prefer built-in `cr-*` classes and `data-tone` values.
- Use injected `--cr-*` variables for necessary custom structural CSS.
- Do not hard-code a page palette, force light or dark mode, or add a second theme selector inside the document.
- Do not copy Context Room theme CSS into the HTML source.

## Rules

- Keep one canonical file. Do not repeat the same truth in Markdown and HTML.
- Put all meaning in semantic text and structure. Color and position may reinforce meaning, never carry it alone.
- Prefer the built-in classes below. Do not copy the theme CSS into the file.
- Use one clear composition. Avoid decorative dashboards, nested cards, and grids that do not improve comparison.
- Use headings in order, short paragraphs, lists, `article`, `section`, and `table` only when the content fits them.
- Keep the document readable without JavaScript. Scripts and external resources do not run in previews.
- Use native controls, CSS view selectors, and `<details>` when interaction makes exploration easier. Keep the main conclusion visible without interaction.
- Open HTML reviews as rendered previews. Accept or reject the proposed document as a whole.
- Limit desktop rows to four steps, three cards, or two comparison options when possible. Built-in layouts collapse on mobile.
- Put the file in `watchAllow` when every current content version requires human verification.

## Choose A Pattern

Start with the question the visual must answer:

- Parts, boundaries, and exchanges: system landscape.
- Causes, mechanisms, effects, and feedback: causal chain.
- Conditions and possible outcomes: branching decision.
- Actors, order, and handoffs: actor sequence.
- Claim, evidence, objection, and conclusion: reasoning map.
- Exact quantities: use the retained data patterns only when the numbers themselves answer the question.

Do not diagram a simple idea. Use the smallest structure that removes real cognitive work. See the [pattern reference](html-visual-patterns.md), [diagram catalog](../context-room-visual-components.html), and [data catalog](../context-room-data-visual-components.html).

## Base Structure

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Clear document name</title>
</head>
<body>
  <main class="cr-page">
    <header class="cr-header">
      <div>
        <p class="cr-kicker">Document type</p>
        <h1>Literal subject</h1>
        <p>One sentence stating what the reader should understand or decide.</p>
      </div>
      <span class="cr-badge">Current state</span>
    </header>
  </main>
</body>
</html>
```

## Comparison

```html
<section class="cr-section">
  <h2>Choose an approach</h2>
  <div class="cr-comparison">
    <article class="cr-option" data-tone="positive">
      <span class="cr-badge">Recommended</span>
      <h3>Option A</h3>
      <p>Outcome, strongest reason, and main tradeoff.</p>
    </article>
    <article class="cr-option" data-tone="warning">
      <h3>Option B</h3>
      <p>Outcome, strongest reason, and main tradeoff.</p>
    </article>
  </div>
</section>
```

## Quality Check

Before handing off an HTML document, verify:

- The rendered page answers one clear question.
- The source is shorter than an equivalent file with repeated CSS.
- The chosen pattern matches the question instead of decorating the data.
- Relationships and groupings are named in text, not implied by layout alone.
- The diagram resolves several relationships, branches, states, actors, or boundaries that prose would make harder to track.
- Every visual group has a heading or label.
- Comparison options use parallel information.
- The page works at desktop and mobile widths.
- Every interaction works with mouse and keyboard, with a visible focus state.
- Large maps stay inside a bounded, focusable scroll viewport; labels remain readable at full size.
- The file appears in the review queue when watched.
