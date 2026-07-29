import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  extractDocumentMetadata,
  inspectDocumentMetadata,
  interpretDocumentMetadata,
  loadMetadataProfiles,
  parseMetadataSource,
} from "../src/document_metadata_engine.mjs";

test("generic metadata preserves arbitrary YAML and source ranges", () => {
  const envelope = extractDocumentMetadata({
    relPath: "docs/page.md",
    content: `---\ntitle: Review\ncustom:\n  upstream:\n    - positioning\ncontext_room:\n  id: product.review\n---\n# Review\n`,
  });
  assert.equal(envelope.raw.title, "Review");
  assert.deepEqual(envelope.raw.custom.upstream, ["positioning"]);
  assert.equal(envelope.sources[0].ranges["context_room.id"].start.line, 7);
});

test("HTML requires the explicit generic marker but keeps legacy compatibility", () => {
  const generic = extractDocumentMetadata({
    relPath: "docs/map.html",
    content: `<!doctype html>\n<!-- context-room-metadata\ntitle: Map\ncustom_system:\n  node_id: map\n-->\n<html></html>`,
  });
  assert.equal(generic.raw.custom_system.node_id, "map");
  const unrelated = extractDocumentMetadata({ relPath: "docs/map.html", content: `<!doctype html><!-- title: no --><html></html>` });
  assert.deepEqual(unrelated.raw, {});
});

test("sidecars are constrained to the project root and remain separate sources", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-metadata-"));
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "architecture.png"), "image");
  fs.writeFileSync(path.join(root, "docs", "architecture.png.meta.yaml"), "title: Architecture\nowner: platform\n");
  const envelope = extractDocumentMetadata({ root, relPath: "docs/architecture.png", content: "", absolutePath: path.join(root, "docs", "architecture.png") });
  assert.equal(envelope.raw.title, "Architecture");
  assert.equal(envelope.sources[0].source, "docs/architecture.png.meta.yaml");
});

test("conflicting sidecars remain explicit instead of silently overriding metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-metadata-conflict-"));
  fs.mkdirSync(path.join(root, "docs"));
  const file = path.join(root, "docs", "page.md");
  fs.writeFileSync(file, "---\ntitle: Frontmatter\n---\n# Page\n");
  fs.writeFileSync(`${file}.meta.yaml`, "title: Sidecar\n");
  const inspected = inspectDocumentMetadata({ root, relPath: "docs/page.md", absolutePath: file, content: fs.readFileSync(file, "utf8") });
  assert.equal(inspected.metadata.raw.title, "Frontmatter");
  assert.ok(inspected.health.some((issue) => issue.type === "metadata_source_conflict" && issue.path === "title"));
});

test("profiles interpret arbitrary identity and relation paths independently", () => {
  const envelope = extractDocumentMetadata({ relPath: "docs/external.md", content: `---\ndoc:\n  id: external-1\nupstream: [external-0]\n---\n# External\n` });
  const interpreted = interpretDocumentMetadata(envelope, [{
    schemaVersion: "context-room.metadata-profile/1",
    id: "external-docs",
    version: "1",
    valid: true,
    origin: "project",
    match: ["docs/**/*.md"],
    identity: { path: "doc.id" },
    relations: [{ path: "upstream", type: "uses", label: "Uses", reverseLabel: "Used by", strength: "declared" }],
  }]);
  assert.equal(interpreted.identities[0].value, "external-1");
  assert.deepEqual(interpreted.interpretations[0].relations.map((item) => item.target), ["external-0"]);
});

test("invalid profiles and malformed JSON are exposed as health issues", () => {
  const malformed = parseMetadataSource('{"broken":', { format: "json", source: "broken.json" });
  assert.match(malformed.parseError, /Invalid JSON/);
  const inspected = inspectDocumentMetadata({ relPath: "docs/page.md", content: "---\ntitle: Page\n---\n" }, {
    profileSet: { profiles: [{ id: "broken", valid: false, errors: [{ message: "bad" }] }], conflicts: [] },
  });
  assert.ok(inspected.health.some((issue) => issue.type === "metadata_profile_invalid"));
});

test("profile loader includes the official compatibility profile", () => {
  const loaded = loadMetadataProfiles({ root: "", deviceRoot: "" });
  const profile = loaded.profiles.find((item) => item.id === "context-room-documentation");
  assert.equal(profile.valid, true);
  assert.equal(profile.identity.path, "context_room.id");
});

test("local schemas validate metadata without network access", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-schema-"));
  fs.mkdirSync(path.join(root, "schemas"));
  fs.writeFileSync(path.join(root, "schemas", "doc.json"), JSON.stringify({ type: "object", required: ["title"], properties: { title: { type: "string" } } }));
  const inspected = inspectDocumentMetadata({ root, relPath: "docs/page.md", content: "---\nowner: platform\n---\n" }, {
    profileSet: { conflicts: [], profiles: [{ schemaVersion: "context-room.metadata-profile/1", id: "schema-test", version: "1", valid: true, origin: "project", match: ["docs/**/*.md"], schema: { path: "schemas/doc.json" } }] },
  });
  assert.ok(inspected.health.some((issue) => issue.type === "metadata_schema_validation_failed"));
});

test("remote schemas require an explicit pinned local download", () => {
  const inspected = inspectDocumentMetadata({ root: process.cwd(), relPath: "docs/page.md", content: "---\ntitle: Page\n---\n" }, {
    profileSet: { conflicts: [], profiles: [{ schemaVersion: "context-room.metadata-profile/1", id: "remote-test", version: "1", valid: true, origin: "project", match: ["docs/**/*.md"], schema: { url: "https://schemas.example/doc.json", sha256: "a".repeat(64) } }] },
  });
  assert.ok(inspected.health.some((issue) => issue.type === "metadata_schema_download_required"));
});

test("declarative profile lint rules run without executing project code", () => {
  const inspected = inspectDocumentMetadata({ relPath: "docs/page.md", content: "---\nstatus: draft\n---\n" }, {
    profileSet: { conflicts: [], profiles: [{
      schemaVersion: "context-room.metadata-profile/1",
      id: "quality-profile",
      version: "1",
      valid: true,
      origin: "project",
      match: ["docs/**/*.md"],
      lintRules: [{ id: "title-required", path: "title", operator: "required", severity: "warning", message: "Add a title." }],
    }] },
  });
  const issue = inspected.health.find((item) => item.type === "metadata_profile_lint");
  assert.equal(issue.profileId, "quality-profile");
  assert.equal(issue.ruleId, "title-required");
});
