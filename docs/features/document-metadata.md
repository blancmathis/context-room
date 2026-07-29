---
context_room:
  kind: canonical
  scope: context-room
  status: current
  canonical_for: stable document identity and dependency metadata
  last_verified: 2026-07-29
  sources: [src/doc_metadata.mjs, src/yaml_utils.mjs, src/document_graph.mjs, src/context_room.mjs]
---

# Generic Document Metadata

## Purpose

Context Room preserves complete YAML or JSON metadata and lets declarative profiles interpret it. The built-in `context-room-documentation` profile supplies stable IDs and explicit dependencies for the official documentation skill, but those fields are not universal requirements of the core.

Metadata can come from Markdown or MDX frontmatter, the explicit `context-room-metadata` comment immediately after an HTML doctype, standalone YAML or JSON documents, or `<file>.meta.yaml|yml|json` sidecars. Unknown fields, types, source ranges, and each source's provenance remain available. Conflicting sources are reported instead of being silently merged.

## Profiles And Schemas

A versioned `MetadataProfile` declares matching files, identity paths, relation paths and labels, display fields, schemas, and declarative Health rules. Built-in, project, device, accepted shared-main, and explicitly installed local plugin profiles can be evaluated together. Contradictory interpretations remain visible; there is no implicit priority.

Project and shared profiles are data only and cannot execute code. Local JSON Schemas are validated with AJV. A remote schema requires both a declared SHA-256 and an explicit local download; opening a document never triggers a silent network request.

## Minimal Contract

New ordinary Markdown documents use:

```yaml
---
context_room:
  id: product.review.human-approval
  depends_on:
    - strategy.trust.human-control
---
```

HTML uses the same body in a comment immediately after `<!doctype html>`. IDs contain lowercase dot-separated segments with optional internal hyphens. A dependency is another stable ID.

`depends_on` is intentionally stronger than a reference: accepting a new version of the dependency creates a freshness review for the dependent document. Markdown links, HTML links, wikilinks, inline paths, `cr://` links, and legacy `sources` remain navigational or evidential relations.

## Compatibility And Truth

Legacy metadata remains readable indefinitely. Context Room never rewrites frontmatter during an ordinary Save. Provider-native agent instruction and skill files do not require this ID.

For the official compatibility profile, truth follows the managed path: ordinary paths are current, target paths remain target, and archive, decision, or record paths remain historical. Current local content enters effective context only after a human validates its exact hash. Shared content is accepted only from the configured main branch.

Content acceptance and dependency freshness are separate. A dependency change does not revoke an already accepted content hash or remove it from effective context. It creates a focused task showing the old and new dependency versions. **Confirm still current** updates only the versions observed during review and does not propagate another invalidation.

Duplicate, missing, invalid, self-referential, or cyclic dependencies are diagnostics; Context Room does not guess or repair them automatically.

## Inspection And Search

The document **Context** panel exposes the same versioned inspection used by agents. Its Metadata group offers interpreted, complete, and raw-source views, plus key/value filtering and copyable metadata paths. Connections, visuals, project location, trust, and Health remain separate so a profile interpretation is never confused with source truth.

The local API exposes:

- `GET /api/context-hub/document-inspect` for the aggregate inspection;
- `GET /api/context-hub/document-resolve` for path, ID, or `cr://` resolution;
- `GET /api/context-hub/document-search` for cursor-paginated structured search;
- `GET /api/context-hub/document-validate` for profile, schema, relation, trust, and renderer diagnostics.

Each request targets an explicit registered project location. Search supports the same structured filters as the agent-first CLI, including `id:`, `profile:`, `truth:`, `depends-on:`, `referenced-by:`, `diagram:`, and `meta.<path>:`.
