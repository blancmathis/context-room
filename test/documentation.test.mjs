import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initializeContextRoomProject, writeDocReviewDecision } from "../src/context_room.mjs";
import {
  buildDocumentationCorpus,
  documentationCapabilities,
  readDocumentation,
  relatedDocumentation,
  resolveDocumentationProjectRoot,
  searchDocumentation,
  traceDocumentation,
} from "../src/documentation.mjs";

const cli = fileURLToPath(new URL("../bin/context-room.mjs", import.meta.url));

function documentationRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-doc-agent-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "docs", "targets"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.md"), `---
context_room:
  kind: index
  scope: test
  status: current
  canonical_for: documentation entry point
  last_verified: 2026-07-22
  sources: [sessions.md]
---

# Documentation

- [Sessions](sessions.md)
- [Target](targets/sessions_target.md)
`);
  fs.writeFileSync(path.join(root, "docs", "sessions.md"), `---
context_room:
  kind: canonical
  scope: test
  status: current
  canonical_for: session expiration
  last_verified: 2026-07-22
  sources: [index.md]
---

# Sessions

## Expiration

Sessions expire after thirty days of inactivity.

## Mobile constraint

Existing mobile clients must stay signed in.
`);
  fs.writeFileSync(path.join(root, "docs", "targets", "sessions_target.md"), `---
context_room:
  kind: canonical
  scope: test
  status: draft
  canonical_for: session rotation target
  last_verified: 2026-07-22
  sources: [../sessions.md]
---

# Session target

## Rotation

Rotate refresh tokens after every use.
`);
  fs.writeFileSync(path.join(root, "docs", "architecture-doc.html"), `<!doctype html>
<html><body><h1>Architecture</h1><section><h2 id="boundary">Documentation boundary</h2><p>The documentation agent reads documentation only.</p></section></body></html>
`);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  writeDocReviewDecision(root, "docs/index.md", { status: "verified" });
  writeDocReviewDecision(root, "docs/sessions.md", { status: "verified" });
  writeDocReviewDecision(root, "docs/targets/sessions_target.md", { status: "verified" });
  writeDocReviewDecision(root, "docs/architecture-doc.html", { status: "verified" });
  return root;
}

test("documentation CLI corpus is section-aware and includes semantic HTML text", (t) => {
  const root = documentationRoot(t);
  const corpus = buildDocumentationCorpus(root);
  const capabilities = documentationCapabilities(root, { corpus });

  assert.equal(corpus.documents.length, 4);
  assert.ok(capabilities.corpus.canonicalSubjects.includes("session expiration"));
  assert.equal(capabilities.corpus.sources.local, 4);
  assert.ok(corpus.documents.find((document) => document.path === "docs/architecture-doc.html")
    .sections.some((section) => section.heading === "Documentation boundary"));
});

test("documentation search, read, related, and trace preserve truth and provenance", (t) => {
  const root = documentationRoot(t);
  const search = searchDocumentation(root, "mobile clients signed in", { limit: 3, budget: 500 });
  assert.equal(search.results[0].selector, "docs/sessions.md#mobile-constraint");
  assert.equal(search.results[0].truthState, "current");
  assert.match(search.results[0].contentHash, /^[a-f0-9]{64}$/);
  assert.equal(search.groups[0].id, "canonical-current");
  assert.ok(search.results[0].rankingReasons.length > 0);

  const read = readDocumentation(root, "docs/sessions.md#expiration", { budget: 300 });
  assert.match(read.content, /thirty days of inactivity/);
  assert.equal(read.truncated, false);
  assert.equal(read.truthState, "current");

  const related = relatedDocumentation(root, "docs/sessions.md");
  assert.ok(related.incoming.some((item) => item.path === "docs/index.md"));
  assert.ok(related.outgoing.some((item) => item.resolvedPath === "docs/index.md"));

  const trace = traceDocumentation(root, "docs/targets/sessions_target.md#rotation");
  assert.equal(trace.truthState, "target");
  assert.equal(trace.canonicalFor, "session rotation target");
  assert.match(trace.contentHash, /^[a-f0-9]{64}$/);
});

test("documentation search supports structured metadata and truth filters", (t) => {
  const root = documentationRoot(t);
  const result = searchDocumentation(root, "meta.context_room.canonical_for:session truth:current", { limit: 5, budget: 500 });
  assert.equal(result.results[0].path, "docs/sessions.md");
  assert.deepEqual(result.filters.structured.map((item) => item.key), ["meta.context_room.canonical_for", "truth"]);
});

test("documentation commands resolve stable IDs and expose direct dependency relations", (t) => {
  const root = documentationRoot(t);
  fs.writeFileSync(path.join(root, "docs", "trust.md"), "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nHuman control.\n");
  fs.writeFileSync(path.join(root, "docs", "review.md"), "---\ncontext_room:\n  id: product.review\n  depends_on:\n    - strategy.trust\n---\n\n# Review\n\nSee [trust](cr://strategy.trust).\n");
  writeDocReviewDecision(root, "docs/trust.md", { status: "verified" });
  writeDocReviewDecision(root, "docs/review.md", { status: "verified" });

  const read = readDocumentation(root, "cr://product.review");
  assert.equal(read.path, "docs/review.md");
  assert.equal(read.documentId, "product.review");
  const related = relatedDocumentation(root, "strategy.trust");
  assert.ok(related.dependedOnBy.some((item) => item.documentId === "product.review"));
  const trace = traceDocumentation(root, "product.review");
  assert.deepEqual(trace.dependsOn, ["strategy.trust"]);
});

test("documentation project root resolves from a nested cwd", (t) => {
  const root = documentationRoot(t);
  const nested = path.join(root, "docs", "targets");
  assert.equal(resolveDocumentationProjectRoot(nested), root);
});

test("accepted-only corpus excludes unverified documents and ignores proposal overlays", (t) => {
  const root = documentationRoot(t);
  fs.writeFileSync(path.join(root, "docs", "unverified.md"), "# Unverified\n\nThis must stay unavailable.\n");
  const corpus = buildDocumentationCorpus(root, {
    acceptedOnly: true,
    sessionId: "ignored-session",
    proposalOverlay: { sessionId: "ignored-session", proposals: [{ branch: "proposal/demo/ignored", head: "a".repeat(40) }] },
  });
  assert.equal(corpus.access.acceptedOnly, true);
  assert.equal(corpus.session, null);
  assert.equal(corpus.documents.some((document) => document.path === "docs/unverified.md"), false);
  assert.equal(corpus.documents.every((document) => document.reviewStatus === "accepted"), true);
  assert.equal(corpus.documents.some((document) => document.truthState === "proposal" || document.source === "session-proposal"), false);
});

test("accepted-only documentation CLI stays functional with project and Context Room home made read-only", { timeout: 30_000 }, (t) => {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-doc-readonly-home-"));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-doc-readonly-root-"));
  t.after(() => {
    for (const target of [isolatedHome, root]) {
      try {
        for (const entry of fs.readdirSync(target, { recursive: true }).reverse()) {
          try { fs.chmodSync(path.join(target, entry), 0o700); } catch {}
        }
        fs.chmodSync(target, 0o700);
      } catch {}
      fs.rmSync(target, { recursive: true, force: true });
    }
  });
  const contextRoomModule = new URL("../src/context_room.mjs", import.meta.url).href;
  const docAgentModule = new URL("../src/documentation.mjs", import.meta.url).href;
  const script = `
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initializeContextRoomProject, writeDocReviewDecision } from ${JSON.stringify(contextRoomModule)};
import { buildDocumentationCorpus } from ${JSON.stringify(docAgentModule)};

const [root, cli] = process.argv.slice(1);
fs.mkdirSync(path.join(root, "docs"), { recursive: true });
fs.writeFileSync(path.join(root, "docs", "accepted.md"), "---\\ncontext_room:\\n  id: product.accepted-rule\\n---\\n\\n# Accepted rule\\n\\nThe immutable accepted rule is readable.\\n");
initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
writeDocReviewDecision(root, "docs/accepted.md", { status: "verified" });
const corpus = buildDocumentationCorpus(root, { acceptedOnly: true });
if (corpus.documents.length !== 1) throw new Error("fixture corpus is not accepted");

const lockTree = (target) => {
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) lockTree(child);
    else fs.chmodSync(child, 0o400);
  }
  fs.chmodSync(target, 0o500);
};
const unlockTree = (target) => {
  fs.chmodSync(target, 0o700);
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    const child = path.join(target, entry.name);
    if (entry.isDirectory()) unlockTree(child);
    else fs.chmodSync(child, 0o600);
  }
};

lockTree(process.env.HOME);
lockTree(root);
try {
  const result = spawnSync(process.execPath, [cli, "docs", "search", "immutable accepted rule", "--root=" + root, "--status=current", "--limit=2", "--budget=300"], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      CONTEXT_ROOM_DOC_ACCEPTED_ONLY: "1",
      CONTEXT_ROOM_DOC_EXPECTED_REVISION: corpus.revision.acceptedCorpus,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr || "read-only docs command failed");
  const output = JSON.parse(result.stdout);
  if (output.results.length !== 1 || output.results[0].path !== "docs/accepted.md") {
    throw new Error("read-only docs command did not return the accepted document");
  }
} finally {
  unlockTree(root);
  unlockTree(process.env.HOME);
}
`;
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script, root, cli], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: isolatedHome, CONTEXT_ROOM_HOME: "" },
  });
  assert.equal(result.status, 0, result.stderr);
});

test("CLI exposes the internal docs toolbox from a nested project directory", (t) => {
  const root = documentationRoot(t);
  const nested = path.join(root, "docs", "targets");
  const result = spawnSync(process.execPath, [cli, "docs", "search", "mobile clients", "--limit=2", "--budget=400"], {
    cwd: nested,
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.results[0].selector, "docs/sessions.md#mobile-constraint");
  assert.equal(output.results[0].truthState, "current");
});

test("CLI exposes compact generic document inspection primitives", (t) => {
  const root = documentationRoot(t);
  for (const command of ["inspect", "metadata", "links", "backlinks", "dependencies", "validate"]) {
    const result = spawnSync(process.execPath, [cli, "docs", command, "docs/sessions.md", "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.parse(result.stdout).schemaVersion, /^context-room\.docs-/);
  }
});

test("ordinary reads keep the accepted local content and metadata while a replacement waits for review", (t) => {
  const root = documentationRoot(t);
  const before = readDocumentation(root, "docs/sessions.md#expiration");
  fs.writeFileSync(path.join(root, "docs/sessions.md"), "# Unaccepted replacement\n\nUNACCEPTED_SECRET_TEXT\n");
  fs.writeFileSync(path.join(root, "docs/new.md"), "# New unaccepted\n\nUNACCEPTED_NEW_TEXT\n");
  const corpus = buildDocumentationCorpus(root);
  assert.equal(corpus.access.acceptedOnly, true);
  const read = readDocumentation(root, "docs/sessions.md#expiration", { corpus });
  assert.equal(read.content, before.content);
  assert.equal(read.contentHash, before.contentHash);
  assert.equal(JSON.stringify(corpus).includes("UNACCEPTED_SECRET_TEXT"), false);
  assert.equal(JSON.stringify(corpus).includes("UNACCEPTED_NEW_TEXT"), false);
  fs.unlinkSync(path.join(root, "docs/sessions.md"));
  assert.equal(readDocumentation(root, "docs/sessions.md#expiration").content, before.content);
});

test("accepted documents without front matter remain searchable", (t) => {
  const root = documentationRoot(t);
  fs.writeFileSync(path.join(root, "docs/plain.md"), "# Plain document\n\nA rare platypus runs onboarding.\n");
  writeDocReviewDecision(root, "docs/plain.md", { status: "verified" });
  const result = searchDocumentation(root, "rare platypus");
  assert.equal(result.results[0].path, "docs/plain.md");
});

test("the removed researcher directs agents to deterministic commands without invoking a model", (t) => {
  const root = documentationRoot(t);
  const result = spawnSync(process.execPath, [cli, "ask", "Find the session rules", `--root=${root}`, "--format=json"], { encoding: "utf8", env: { ...process.env, CODEX_BIN: "/unavailable/codex" } });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stderr).error.code, "removed-command");
  assert.match(JSON.parse(result.stderr).error.message, /docs search/);
  assert.equal(fs.existsSync(path.join(root, ".context-room", "doc-agent")), false);
});
