import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultDocumentExtensionRegistry, DocumentExtensionRegistry } from "../src/document_extensions.mjs";

test("document renderer registry exposes Mermaid and source fallbacks", () => {
  const registry = createDefaultDocumentExtensionRegistry();
  assert.equal(registry.rendererFor("docs/process.mmd").id, "mermaid");
  assert.equal(registry.capabilities().renderers.find((item) => item.id === "graphviz").unavailable, true);
});

test("shared executable adapters are rejected", () => {
  const registry = new DocumentExtensionRegistry();
  assert.throws(() => registry.registerRenderer({ id: "unsafe", formats: ["x"], command: "render" }, { origin: "shared", enabled: true }), /only be installed locally/);
});
