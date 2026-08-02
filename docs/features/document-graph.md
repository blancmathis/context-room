---
context_room:
  kind: feature
  scope: context-room
  status: current
  canonical_for: document relations graph
  last_verified: 2026-07-28
  sources: [src/document_graph.mjs, src/document_graph_layout_worker.mjs, src/context_room.mjs, src/doc_metadata.mjs, test/context_room.test.mjs]
---

# Document Graph

## Purpose

Graph is a human navigation view for proven relationships between managed documentation resources. It helps a person move from the global project landscape to one project's documents, then to the immediate context around one file.

Graph is different from the Context Engine's internal structural graph. The visual Document Graph describes references between documents and their explicitly applicable context. Agents normally use `context effective`, `context explain`, or `context impact`; an expert can include the structural graph explicitly with `context effective --include graph`.

## Views

- **All projects** shows one node per logical registered project. Registered worktrees remain grouped under their project. Projects connect only through an explicit shared origin.
- **Project** shows managed Markdown and HTML documents, recognized agent instructions, local or shared skills, and explicitly cited images, diagrams, or source files.
- **Local** centers the current file and shows proven incoming and outgoing relations up to depth 1, 2, or 3.

Open Graph from Explorer. A project's context menu opens its project graph, while a file's context menu or document toolbar opens its local graph.

## Proven Relations

Context Room recognizes:

- stable document IDs and Context Room links with optional anchors;
- explicit `depends_on` relations and their derived inverse;
- Markdown links and HTML `href` references;
- inline code paths;
- wikilinks, including labels and anchors;
- `context_room.sources` declarations;
- provider-proven instruction and skill applications;
- links declared by safe Mermaid `click` directives, exposed as `appears-in-diagram` relations;
- accepted shared origins and managed local destinations.

Relations are labeled `references`, `declares-source`, `applies-to`, `shared-origin`, or `managed-link`. Context Room does not scan source-code imports, infer semantic similarity, or discover unregistered worktrees.

The YAML fields have distinct meanings:

- `canonical_for` names the subject for which a document is authoritative. It does not point to another file and never creates a graph edge.
- `sources` declares files that the document relies on and creates outgoing `declares-source` relations.
- Markdown links, HTML links, wikilinks, anchors, and inline file paths create outgoing `references` relations.
- A backlink is the inverse view of either explicit relation: another document references or declares the current document as a source.

## Truth Layers

Accepted current context is the default layer. Unverified documents, target documents, unresolved references, and one selected proposal can be added explicitly.

These layers stay visually distinct. A proposal is compared at its exact head and never becomes accepted context merely because it is visible in Graph.

## Interaction And State

Use live search, type and relation filters, zoom, pan, fit, direction arrows, and orphan or unresolved-reference visibility to narrow the graph. Hover isolates immediate neighbors. Select a node to inspect its backlinks and outgoing links; open it to navigate to the project or file. The equivalent List view keeps the surface keyboard and screen-reader accessible.

Scope, depth, filters, camera, selected node, and manual node positions belong to the current Workspace and restore after refresh. They do not change project configuration.

Graph data is cached per project revision and invalidated after relevant file, review, shared, or Settings changes. Responses are capped at 5,000 nodes and 10,000 relations; a truncated graph asks the user to narrow its scope or filters.

The graph uses the generic metadata engine. Relation type, forward label, inverse label, strength, source profile, file, line, and range travel together. The built-in compatibility profile maps `depends_on` and legacy `sources`; other declarative profiles can add different relation vocabularies without changing the core.

## Visual Documents

**Visual documents** opens the same project graph narrowed to Mermaid, HTML, documented images, and installed renderer formats, with its accessible list enabled. Embedded Mermaid and standalone `.mmd` or `.mermaid` documents share one safe local renderer and expose Rendered, Source, and Split modes. Unsupported PlantUML, Graphviz, and draw.io formats remain source-first until an explicitly enabled local adapter is installed.

## Related In Explorer

When a document is open, Explorer exposes **Location** and **Related** as two explicit views. **Location** keeps the normal project tree and watched filters. **Related** is a depth-one, layout-free projection of this same deterministic graph; it does not run a second relation engine.

**This document uses** contains accepted outgoing references and declared sources. **Uses this document** contains accepted backlinks. **Unresolved references** lists explicit targets that cannot be resolved. The open document remains visible as the center even when it is in review or is a target, but its neighbors are accepted by default. Proposal relations remain identified as pending and never become accepted merely because they are displayed.

Opening another relation keeps **Related** active. **Reveal in Location** returns to the project tree, expands the document's parents, and centers its row. Opening a file updates both projections in the background without changing the chosen view or opening a closed Explorer. The chosen view belongs to the current Workspace and is reflected in its URL.
