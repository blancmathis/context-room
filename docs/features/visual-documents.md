---
context_room:
  id: product.visual-documents
  depends_on:
    - product.document-workflow
---

# Visual HTML documents

## Summary

A project can hold visual documents as `.html` files built from the `cr-*` patterns. Context Room renders them in the reader and in the review, in an isolated page without scripts, and injects the pattern styles. Agents in any project learn the patterns with `context-room docs visual-guide`.

## Defines

When to choose HTML over Markdown, the rules for a visual document, and how an agent finds the patterns.

## Does not define

Review of visual documents (see [Document workflow](document-workflow.md)) or the styles themselves (in the application).

## When to choose HTML

Write Markdown by default. Choose HTML only when several relationships, branches, actors, states, boundaries or layers are easier to follow spatially. Do not diagram a simple idea: with fewer than three meaningful relationships, prose, bullets or a short comparison are clearer. Each visual answers one explicit question. Use metrics and charts only for genuinely quantitative questions.

## Rules

- Semantic HTML with `cr-*` classes only. No script, no external resource, no copied theme CSS.
- The meaning stays in text: headings, short labels, a sentence before and after each visual. `docs search` and `docs read` serve the extracted text, so an HTML document costs an agent about as many tokens as its text.
- Secondary detail goes in `<details>`. Nothing depends on hover or animation, which also keeps the page readable on an e-ink tablet.
- Diagrams sit in `<div class="cr-diagram-scroll" tabindex="0">` and use the grid primitives: nodes, edges, groups, boundaries, lanes, notes and legends.

## For agents

`context-room docs visual-guide` prints the choice rules, the page skeleton and the 45 patterns (summary, comparison, chart, structure and five canonical diagrams). `--pattern <id or class>` prints one exact example. The output is the same in every project and calls no model. A project can propose its own rule in the documentation block of its `AGENTS.md`; Context Room never imposes it.
