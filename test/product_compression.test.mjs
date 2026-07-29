import assert from "node:assert/strict";
import test from "node:test";

import {
  ATTENTION_ITEM_SCHEMA,
  CONTEXT_COVERAGE_SCHEMA,
  DOCUMENT_SEARCH_GROUPS_SCHEMA,
  buildAttentionItems,
  buildContextCoverage,
  groupDocumentSearchResults,
} from "../src/product_compression.mjs";

test("attention keeps reviews first and uses one stable item contract", () => {
  const items = buildAttentionItems({
    project: { projectKey: "local:atlas" },
    reviews: [{ id: "review:one", title: "Review one", path: "docs/one.md" }],
    freshness: [{ id: "fresh:one", path: "docs/two.md" }],
    decisions: [{ id: "decision:one", title: "Choose destination" }],
    healthIssues: [{ id: "health:one", severity: "high", message: "Broken link" }],
  });
  assert.equal(items[0].kind, "review");
  assert.deepEqual(items.map((item) => item.kind), ["review", "recheck", "decide", "fix"]);
  assert.ok(items.every((item) => item.schemaVersion === ATTENTION_ITEM_SCHEMA));
  assert.deepEqual(new Set(items.map((item) => item.kind)), new Set(["review", "recheck", "decide", "fix"]));
});

test("document search groups current ownership away from pending and history", () => {
  const grouped = groupDocumentSearchResults([
    { path: "docs/product.md", truthState: "current", kind: "canonical" },
    { path: "docs/note.md", truthState: "current", kind: "guide" },
    { path: "docs/product_target.md", truthState: "target", kind: "canonical" },
    { path: "docs/archive.md", truthState: "historical", kind: "record" },
  ]);
  assert.equal(grouped.schemaVersion, DOCUMENT_SEARCH_GROUPS_SCHEMA);
  assert.deepEqual(grouped.groups.map((group) => group.id), ["canonical-current", "current-context", "pending-target", "history"]);
});

test("coverage reports candidates, exclusions, budget pressure, and duplicate owners", () => {
  const corpus = { documents: [
    { path: "docs/a.md", truthState: "current", reviewStatus: "accepted", source: "local", metadata: { canonical_for: "deployment" } },
    { path: "docs/b.md", truthState: "current", reviewStatus: "accepted", source: "local", metadata: { canonical_for: "deployment" } },
    { path: "docs/c_target.md", truthState: "target", reviewStatus: "unverified", source: "local", metadata: {} },
  ] };
  const coverage = buildContextCoverage({ corpus, searchResults: [
    { path: "docs/a.md", snippet: "A".repeat(400) },
    { path: "docs/c_target.md", snippet: "Target evidence" },
  ], budget: 100, obligations: ["read-canonical-owner"] });
  assert.equal(coverage.schemaVersion, CONTEXT_COVERAGE_SCHEMA);
  assert.equal(coverage.candidateUniverse.acceptedCurrent, 2);
  assert.equal(coverage.excluded.documents, 1);
  assert.deepEqual(coverage.included.paths, ["docs/a.md"]);
  assert.deepEqual(coverage.included.evidencePaths, ["docs/a.md", "docs/c_target.md"]);
  assert.equal(coverage.redundancy.length, 1);
  assert.equal(coverage.budget.pressure, 1);
});
