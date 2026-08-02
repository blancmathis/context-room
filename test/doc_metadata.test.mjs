import assert from "node:assert/strict";
import test from "node:test";

import {
  collectContextRoomLinks,
  collectMermaidDocumentLinks,
  documentIdForPath,
  documentTruthStateForPath,
  parseContextRoomUri,
  parseDocMetadata,
} from "../src/doc_metadata.mjs";
import { parseSimpleYaml } from "../src/yaml_utils.mjs";

test("safe YAML parser accepts scalar block lists", () => {
  assert.deepEqual(parseSimpleYaml("context_room:\n  id: product.review.queue\n  depends_on:\n    - product.review.policy\n    - strategy.trust.human-control\n"), {
    context_room: {
      id: "product.review.queue",
      depends_on: ["product.review.policy", "strategy.trust.human-control"],
    },
  });
  assert.throws(() => parseSimpleYaml("context_room:\n  depends_on:\n    key: value\n    - invalid\n"), /Unsupported YAML list/);
});

test("minimal Markdown metadata derives truth from the path", () => {
  const content = "---\ncontext_room:\n  id: product.review.queue\n  depends_on:\n    - product.review.policy\n---\n\n# Queue\n";
  const metadata = parseDocMetadata(content, "docs/product/review/queue.md");
  assert.equal(metadata.contract, "minimal");
  assert.equal(metadata.id, "product.review.queue");
  assert.equal(metadata.idValid, true);
  assert.deepEqual(metadata.dependsOn, ["product.review.policy"]);
  assert.equal(metadata.truthState, "current");
  assert.equal(metadata.status, "current");
  assert.equal(documentTruthStateForPath("docs/product/capabilities/review.md"), "current");
  assert.equal(documentTruthStateForPath("docs/lifecycle/changes/active/review.md"), "target");
  assert.equal(documentTruthStateForPath("docs/lifecycle/changes/archive/review.md"), "historical");
  assert.equal(documentTruthStateForPath("docs/lifecycle/decisions/review-policy.md"), "historical");
  assert.equal(documentTruthStateForPath("docs/lifecycle/records/incidents/review.md"), "historical");
  assert.equal(documentTruthStateForPath("docs/evolution/changes/active/review.md"), "target");
  assert.equal(documentTruthStateForPath("docs/evolution/changes/archive/review.md"), "historical");
  assert.equal(documentTruthStateForPath("docs/target/review.md"), "target");
  assert.equal(documentTruthStateForPath("docs/review_target.md"), "target");
});

test("legacy and mixed metadata remain readable", () => {
  const legacy = parseDocMetadata("---\ncontext_room:\n  kind: canonical\n  status: current\n  canonical_for: review\n---\n", "docs/review.md");
  assert.equal(legacy.contract, "legacy");
  assert.equal(legacy.statusValid, true);
  const mixed = parseDocMetadata("---\ncontext_room:\n  id: product.review.queue\n  kind: canonical\n  status: current\n---\n", "docs/review.md");
  assert.equal(mixed.contract, "legacy");
  assert.equal(mixed.id, "product.review.queue");
});

test("legacy target status remains a supported target-truth alias", () => {
  const metadata = parseDocMetadata("---\ncontext_room:\n  kind: canonical\n  status: target\n  canonical_for: review-next\n---\n", "docs/review-next.md");
  assert.equal(metadata.contract, "legacy");
  assert.equal(metadata.statusValid, true);
  assert.equal(metadata.status, "target");
  assert.equal(metadata.truthState, "target");
});

test("HTML metadata is read only from the comment immediately after doctype", () => {
  const html = "<!doctype html>\n<!--\ncontext_room:\n  id: system.review.map\n  depends_on:\n    - product.review.queue\n-->\n<html><body></body></html>";
  const metadata = parseDocMetadata(html, "docs/system/review-map.html");
  assert.equal(metadata.contract, "minimal");
  assert.equal(metadata.id, "system.review.map");
  assert.deepEqual(metadata.dependsOn, ["product.review.queue"]);
  assert.equal(parseDocMetadata("<!doctype html><html><!-- context_room:\n id: system.review.map --></html>", "docs/map.html").present, false);
});

test("stable IDs and cr links support anchors and Mermaid nodes", () => {
  assert.equal(documentIdForPath("docs/product/review/human-approval.md"), "product.review.human-approval");
  assert.deepEqual(parseContextRoomUri("cr://product.review.human-approval#decision"), { id: "product.review.human-approval", anchor: "decision" });
  assert.deepEqual(collectMermaidDocumentLinks("```mermaid\ngraph LR\n  review[Review]\n  click review \"cr://product.review.human-approval#decision\"\n```"), [{
    nodeId: "review",
    id: "product.review.human-approval",
    anchor: "decision",
    uri: "cr://product.review.human-approval#decision",
  }]);
  assert.deepEqual(collectContextRoomLinks("Use the literal syntax `cr://` in documentation."), []);
});
