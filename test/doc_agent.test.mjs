import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { initializeContextRoomProject, writeDocReviewDecision } from "../src/context_room.mjs";
import {
  buildDocumentationAgentPrompt,
  buildDocumentationCorpus,
  documentationCapabilities,
  readDocumentation,
  relatedDocumentation,
  renderDocumentationPacket,
  resolveDocumentationProjectRoot,
  runDocumentationAgent,
  searchDocumentation,
  traceDocumentation,
} from "../src/doc_agent.mjs";

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

const packet = {
  summary: "Session expiration is documented with one mobile compatibility constraint.",
  currentFacts: [{ claim: "Sessions expire after thirty days.", excerpt: "Sessions expire after thirty days of inactivity.", path: "docs/sessions.md", section: "Sessions > Expiration", truthState: "current", revision: "abc123", contentHash: "1111111111111111111111111111111111111111111111111111111111111111" }],
  constraints: [{ claim: "Existing mobile clients must stay signed in.", excerpt: "Existing mobile clients must stay signed in.", path: "docs/sessions.md", section: "Sessions > Mobile constraint", truthState: "current", revision: "abc123", contentHash: "2222222222222222222222222222222222222222222222222222222222222222" }],
  decisions: [],
  targetDifferences: [{ claim: "Refresh-token rotation is target behavior.", excerpt: "Rotate refresh tokens after every use.", path: "docs/targets/sessions_target.md", section: "Session target > Rotation", truthState: "target", revision: "abc123", contentHash: "3333333333333333333333333333333333333333333333333333333333333333" }],
  unknowns: [],
  conflicts: [],
  optionalReads: [{ path: "docs/index.md", section: "Documentation", reason: "Project documentation route." }],
  coverage: { project: "fixture", docsRevision: "abc123", scope: "standard", sourcesExamined: 3, pathsExamined: ["docs/sessions.md", "docs/targets/sessions_target.md", "docs/index.md"] },
};

function packetForRoot(root) {
  const expiration = readDocumentation(root, "docs/sessions.md#expiration", { budget: 300 });
  const mobile = readDocumentation(root, "docs/sessions.md#mobile-constraint", { budget: 300 });
  const rotation = readDocumentation(root, "docs/targets/sessions_target.md#rotation", { budget: 300 });
  return {
    ...structuredClone(packet),
    currentFacts: [{ claim: "Sessions expire after thirty days.", excerpt: "Sessions expire after thirty days of inactivity.", path: expiration.path, section: expiration.section, truthState: expiration.truthState, revision: expiration.revision, contentHash: expiration.contentHash }],
    constraints: [{ claim: "Existing mobile clients must stay signed in.", excerpt: "Existing mobile clients must stay signed in.", path: mobile.path, section: mobile.section, truthState: mobile.truthState, revision: mobile.revision, contentHash: mobile.contentHash }],
    targetDifferences: [{ claim: "Refresh-token rotation is target behavior.", excerpt: "Rotate refresh tokens after every use.", path: rotation.path, section: rotation.section, truthState: rotation.truthState, revision: rotation.revision, contentHash: rotation.contentHash }],
  };
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
  assert.equal(corpus.documents.some((document) => document.truthState === "proposal" || document.source === "session-proposal"), false);
});

test("documentation agent prompt limits research to docs and forbids self-improvement", (t) => {
  const root = documentationRoot(t);
  const cliPath = path.join(root, "bin", "context-room.mjs");
  const prompt = buildDocumentationAgentPrompt({
    root,
    cliPath,
    task: "Change session expiration",
    goal: "Keep mobile users signed in",
    files: ["src/auth/session.ts"],
    depth: "standard",
    budget: 900,
  });

  assert.match(prompt, /research documentation, not source code/i);
  assert.match(prompt, /Never open or search source code, tests, runtime configuration/i);
  assert.match(prompt, /Do not modify files, create proposals, suggest CLI improvements/i);
  assert.match(prompt, /src\/auth\/session\.ts/);
  assert.match(prompt, /Start with a focused search/);
  assert.doesNotMatch(prompt, /docs .* capabilities/);
  assert.match(prompt, /approximately 900 tokens/);
  assert.match(prompt, /One evidence item must cite exactly one section/);
  assert.match(prompt, /Use targetDifferences only for differences explicitly supported by target documentation/);
  assert.match(prompt, /short, exact, contiguous excerpt/);
  assert.match(prompt, /accepted-only corpus/);
  assert.doesNotMatch(prompt, /pendingSessionChanges/);
  assert.doesNotMatch(prompt, /search --status proposal/);
});

test("documentation agent launches a fresh read-only Codex exec for every call", (t) => {
  const root = documentationRoot(t);
  const cliPath = path.join(root, "bin", "context-room.mjs");
  const currentPacket = packetForRoot(root);
  let invocation = null;
  const result = runDocumentationAgent({
    root,
    cliPath,
    task: "Explain session expiration",
    codexBin: "/test/codex",
    spawnSyncImpl(command, args, options) {
      invocation = { command, args, options };
      return { status: 0, signal: null, stdout: JSON.stringify(currentPacket), stderr: "" };
    },
  });

  assert.equal(result.packet.summary, currentPacket.summary);
  assert.match(result.packet.coverage.docsRevision, /^[a-f0-9]{64}$/);
  assert.equal(invocation.command, "/test/codex");
  assert.deepEqual(invocation.args.slice(0, 7), ["-C", root, "--sandbox", "read-only", "--ask-for-approval", "never", "exec"]);
  assert.ok(invocation.args.includes("--ephemeral"));
  assert.ok(invocation.args.includes("--ignore-user-config"));
  assert.ok(invocation.args.includes("--output-schema"));
  assert.equal(invocation.options.env.CONTEXT_ROOM_DOC_AGENT, "1");
  assert.equal(invocation.options.env.CONTEXT_ROOM_DOC_ACCEPTED_ONLY, "1");
  assert.equal(invocation.options.env.CONTEXT_ROOM_DOC_SESSION, "");
  assert.equal(invocation.options.env.CONTEXT_ROOM_DOC_PROPOSALS, "");
  assert.match(invocation.options.input, /Explain session expiration/);
  assert.doesNotMatch(invocation.options.input, /proposal head|pendingSessionChanges/);
});

test("cold agent packet exposes deterministic coverage without promoting target documentation", (t) => {
  const root = documentationRoot(t);
  const currentPacket = packetForRoot(root);
  const result = runDocumentationAgent({
    root,
    cliPath: path.join(root, "bin", "context-room.mjs"),
    task: "Explain session expiration to an agent with no prior project context",
    files: ["src/auth/session.ts"],
    codexBin: "/test/codex",
    spawnSyncImpl() {
      return { status: 0, signal: null, stdout: JSON.stringify(currentPacket), stderr: "" };
    },
  });

  assert.equal(result.packet.coverage.schemaVersion, "context-room.context-coverage/2");
  assert.equal(result.packet.coverage.candidateUniverse.acceptedCurrent, 2);
  assert.equal(result.packet.coverage.candidateUniverse.target, 1);
  assert.ok(result.packet.coverage.included.paths.includes("docs/sessions.md"));
  assert.equal(result.packet.coverage.included.paths.includes("docs/targets/sessions_target.md"), false);
  assert.ok(result.packet.coverage.included.evidencePaths.includes("docs/targets/sessions_target.md"));
  assert.ok(result.packet.coverage.obligations.some((item) => item.id === "working-file:src/auth/session.ts"));
  assert.ok(result.packet.coverage.limitations.some((item) => /proposal content is unavailable/i.test(item)));
  assert.equal("proposals" in result.packet.coverage.candidateUniverse, false);
  assert.equal(result.packet.currentFacts.every((item) => item.truthState === "current"), true);
});

test("documentation agent rejects a proof that joins several content hashes", (t) => {
  const root = documentationRoot(t);
  const invalid = packetForRoot(root);
  invalid.currentFacts[0].contentHash = `${invalid.currentFacts[0].contentHash};${invalid.constraints[0].contentHash}`;

  assert.throws(() => runDocumentationAgent({
    root,
    cliPath: path.join(root, "bin", "context-room.mjs"),
    task: "Explain session expiration",
    codexBin: "/test/codex",
    spawnSyncImpl() {
      return { status: 0, signal: null, stdout: JSON.stringify(invalid), stderr: "" };
    },
  }), /invalid content hash/);
});

test("documentation agent rejects excerpts that were not copied exactly from the accepted section", (t) => {
  const root = documentationRoot(t);
  const invalid = packetForRoot(root);
  invalid.currentFacts[0].excerpt = "A paraphrase that does not exist in the document.";

  assert.throws(() => runDocumentationAgent({
    root,
    cliPath: path.join(root, "bin", "context-room.mjs"),
    task: "Explain session expiration",
    codexBin: "/test/codex",
    spawnSyncImpl() {
      return { status: 0, signal: null, stdout: JSON.stringify(invalid), stderr: "" };
    },
  }), /not an exact section quote/);
});

test("documentation agent keeps proposal evidence out of accepted truth fields", (t) => {
  const root = documentationRoot(t);
  const invalid = packetForRoot(root);
  invalid.currentFacts[0].truthState = "proposal";
  invalid.currentFacts[0].path = "_session-proposals/proposal/demo/change/projects/demo/docs/sessions.md";

  assert.throws(() => runDocumentationAgent({
    root,
    cliPath: path.join(root, "bin", "context-room.mjs"),
    task: "Explain session expiration",
    codexBin: "/test/codex",
    spawnSyncImpl() {
      return { status: 0, signal: null, stdout: JSON.stringify(invalid), stderr: "" };
    },
  }), /contains unmerged proposal evidence/);
});

test("documentation packet renderer keeps evidence and coverage compact", () => {
  const rendered = renderDocumentationPacket(packet);
  assert.match(rendered, /Sessions expire after thirty days/);
  assert.match(rendered, /> Sessions expire after thirty days of inactivity\./);
  assert.match(rendered, /Coverage: 3 sources · abc123/);
  assert.doesNotMatch(rendered, /docs\/sessions\.md/);
  assert.doesNotMatch(rendered, /111111111111/);
  assert.doesNotMatch(rendered, /Pending changes/);
  assert.doesNotMatch(rendered, /retrieval improvement/i);
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

test("CLI context ask delegates one structured request to Codex", (t) => {
  const root = documentationRoot(t);
  const currentPacket = packetForRoot(root);
  const fakeCodex = path.join(root, "fake-codex.mjs");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (!prompt.includes("Explain session expiration") || !process.argv.includes("--ephemeral")) process.exit(9);
  process.stdout.write(${JSON.stringify(JSON.stringify(currentPacket))});
});
`);
  fs.chmodSync(fakeCodex, 0o755);
  const result = spawnSync(process.execPath, [cli, "context", "ask", "Explain session expiration", `--root=${root}`, "--json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CONTEXT_ROOM_CODEX_BIN: fakeCodex, NODE_TEST_CONTEXT: "1" },
  });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.summary, currentPacket.summary);
  assert.match(output.coverage.docsRevision, /^[a-f0-9]{64}$/);
});
