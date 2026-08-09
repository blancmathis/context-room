#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  connectSharedContext,
  initializeSharedRepository,
  readSharedConnectionReceipt,
  readSharedProjectConnection,
} from "../src/shared_context.mjs";
import { registerContextHubProject, registerContextHubSharedRepository } from "../src/context_hub.mjs";
import { readContextRoomEvents } from "../src/event_journal.mjs";
import { collectInlinePathReferences } from "../src/doc_metadata.mjs";
import { authorizeOwnerReviewScope, inspectOwnerReviewScope } from "../src/review_authority.mjs";
import {
  buildGlobalDocumentRelationsGraph,
  buildProjectDocumentRelationsGraph,
  layoutDocumentRelationsGraph,
} from "../src/document_graph.mjs";

import {
  AGENT_CONTEXT_DIR,
  AGENT_CONTEXT_FILE,
  CONFIG_DIR,
  CONFIG_FILE,
  DEFAULT_CODEX_REFERENCE_SHORTCUT,
  REVIEW_GATE_FILE,
  GLOBAL_PREFERENCES_FILE,
  DEFAULT_MARKDOWN_TEMPLATES,
  CONCEPT_VISUAL_DOCUMENT_PATTERNS,
  DATA_VISUAL_DOCUMENT_PATTERNS,
  DIAGRAM_VISUAL_DOCUMENT_PATTERNS,
  FILE_THEME_OPTIONS,
  VISUAL_DOCUMENT_PATTERNS,
  WATCH_RULE_MODES,
  WATCH_RULE_MODE_OPTIONS,
  acknowledgeContextHealthIssue,
  appendAgentAnnotation,
  applyMarkdownTemplateToFile,
  buildAgentBrief,
  buildAgentReviewQueue,
  buildContextRoomDoctorReport,
  buildContextRoomReports,
  buildDeletedReviewBatch,
  buildDocQaReport,
  buildDocumentationGraph,
  createStartupSkillFile,
  createContextHubProject,
  createFolder,
  createMarkdownFile,
  createMemoryServer,
  createDefaultProjectConfig,
  computeDocIssues,
  contextRoomProjectResponseAction,
  deleteStartupContextFile,
  deleteMemoryPaths,
  deleteStartupSkill,
  ensureRuntimeGitExcludes,
  explorerWatchFilterMatches,
  healthIssueCategory,
  hubSectionsForRoot,
  inferProjectDocumentationSetup,
  initializeContextRoomProject,
  isAllowedMemoryPath,
  listExplorerDirectories,
  listExplorerFiles,
  listMemoryFiles,
  listStartupContextFiles,
  listStartupHookFiles,
  listStartupSkillFolders,
  normalizeKeyboardShortcut,
  parseWorkspaceNavigationUrl,
  parseDocMetadata,
  readAgentAnnotations,
  readAgentCommand,
  readCollaborationSessionState,
  readContextHealthAcknowledgements,
  readFileDiff,
  readGlobalReviewLedger,
  readGlobalContextRoomPreferences,
  readMemoryFile,
  readMemoryWebappSettings,
  readReviewGateSettings,
  readResolvedContextRoomSettings,
  readReviewBaseFile,
  readStartupContextFile,
  readStartupHookFile,
  readStartupSkillFile,
  renderAppHtml,
  contextRoomWebAssetBundle,
  renderExplorerContextMenuMarkup,
  renderReviewSummary,
  renderTemplateOptionsMarkup,
  resolveDocumentReference,
  resolveDocumentReferenceInDocuments,
  removeFolderWatchRule,
  selectAvailableContextRoomPort,
  shouldReplaceDuplicatedWorkspaceIdentity,
  syncContextRoomAgentContext,
  syncContextRoomGitHooks,
  revertMemoryFile,
  writeDocReviewBaseline,
  writeDeletedReviewBatchDecision,
  writeStartupContextFile,
  writeStartupHookFile,
  workspaceReloadCircuitDecision,
  writeStartupSkillFile,
  writeAgentCommand,
  writeCollaborationSessionState,
  writeDocReviewDecision,
  writeGlobalContextRoomPreferences,
  writeMemoryFile,
  writeMemoryWebappSettings,
  writeFolderWatchRule,
  writeReviewGateSettings,
  watchStateForPath,
} from "../src/context_room.mjs";

const previousSuiteHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
const contextRoomTestHubHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-suite-hub-"));
process.env.CONTEXT_ROOM_HUB_HOME = contextRoomTestHubHome;
test.after(() => {
  if (previousSuiteHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
  else process.env.CONTEXT_ROOM_HUB_HOME = previousSuiteHubHome;
  fs.rmSync(contextRoomTestHubHome, { recursive: true, force: true });
});

function makeRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "context-room-"));
}

function makeFolderWatchRoot({ watchAllow = [] } = {}) {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "direct.md"), "# Direct\n");
  fs.writeFileSync(path.join(root, "docs", "delete.md"), "# Delete\n");
  fs.writeFileSync(path.join(root, "docs", "nested", "existing.md"), "# Existing nested\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  return root;
}

function mutateFolderWatchFixture(root) {
  fs.writeFileSync(path.join(root, "docs", "direct.md"), "# Direct\n\nChanged.\n");
  fs.writeFileSync(path.join(root, "docs", "nested", "existing.md"), "# Existing nested\n\nChanged.\n");
  fs.writeFileSync(path.join(root, "docs", "later-direct.md"), "# Later direct\n");
  fs.mkdirSync(path.join(root, "docs", "later-folder", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "later-folder", "deeper", "later-deep.md"), "# Later deep\n");
}

function extractInlineAppScript(html) {
  const match = html.match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "expected Context Room HTML to contain an inline app script");
  return match[1];
}

test("rendered app inline script parses before the browser boots it", () => {
  const root = makeRoot();
  const script = extractInlineAppScript(renderAppHtml());
  const scriptPath = path.join(root, "context-room-inline.js");

  fs.writeFileSync(scriptPath, script);

  execFileSync(process.execPath, ["--check", scriptPath], { stdio: "pipe" });
  assert.match(script, /function setMode\(mode = "view"\)/);
  assert.doesNotMatch(script, /function setMode\(\)\s*\{\s*state\.mode = "edit"/);
  assert.match(script, /function diffComparableLine\(line\)/);
  assert.match(script, /replace\(\/\^\(\\s\*last_verified\\s\*:\)\.\*\/, "\$1 #"\)/);
  assert.match(script, /replace\(\S+,\s*"\$1#\$2\$3"\)/);
  assert.match(script, /function diffLinesEqual\(leftLine, rightLine\)/);
  assert.match(script, /diffLinesEqual\(left\[i\], right\[j\]\)/);
  assert.match(script, /function reviewIdentityContentForUi\(content\)/);
  assert.match(script, /function onlyIgnoredReviewMetadataChanged\(leftContent, rightContent\)/);
});

test("served web shell keeps CSS and JavaScript in versioned cacheable assets", () => {
  const bundle = contextRoomWebAssetBundle("test-prompt-nonce");
  const secondBundle = contextRoomWebAssetBundle("second-prompt-nonce");
  assert.ok(Buffer.byteLength(bundle.html) < 100_000);
  assert.ok(Buffer.byteLength(bundle.css) > 100_000);
  assert.ok(Buffer.byteLength(bundle.js) > 100_000);
  assert.match(bundle.html, new RegExp(`href="${bundle.cssPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(bundle.html, new RegExp(`src="${bundle.jsPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.doesNotMatch(bundle.html, /<style>/);
  assert.doesNotMatch(bundle.html, /<script>/);
  assert.match(bundle.cssEtag, /^"[a-f0-9]{16}"$/);
  assert.match(bundle.jsEtag, /^"[a-f0-9]{16}"$/);
  assert.equal(secondBundle.cssPath, bundle.cssPath);
  assert.equal(secondBundle.jsPath, bundle.jsPath);
  assert.equal(secondBundle.css, bundle.css);
  assert.equal(secondBundle.js, bundle.js);
  assert.match(bundle.html, /name="context-room-prompt-nonce" content="test-prompt-nonce"/);
  assert.match(secondBundle.html, /name="context-room-prompt-nonce" content="second-prompt-nonce"/);
  assert.doesNotMatch(bundle.js, /test-prompt-nonce|second-prompt-nonce/);
  assert.ok(bundle.cssVariants.gzip.length < bundle.cssVariants.raw.length);
  assert.ok(bundle.cssVariants.brotli.length < bundle.cssVariants.gzip.length);
  assert.ok(bundle.jsVariants.gzip.length < bundle.jsVariants.raw.length);
  assert.ok(bundle.jsVariants.brotli.length < bundle.jsVariants.gzip.length);
});

test("document relations recognize explicit Markdown, HTML, inline-code, and wikilink paths", () => {
  const references = collectInlinePathReferences([
    "[Runbook](guides/runbook.md#deploy)",
    "<a href=\"../architecture/system.html\">Architecture</a>",
    "<img src=\"images/flow.svg\" alt=\"Flow\">",
    "`src/runtime.mjs`",
    "[[notes/operations|Operations]]",
    "[[notes/decisions#accepted]]",
  ].join("\n"));
  assert.deepEqual(references, [
    "guides/runbook.md#deploy",
    "src/runtime.mjs",
    "notes/operations",
    "notes/decisions#accepted",
    "../architecture/system.html",
    "images/flow.svg",
  ]);
});

test("document relations keep accepted, target, pending, proposal, and local-depth layers separate", async () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "images"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "images", "flow.svg"), "<svg/>");
  const documentationGraph = {
    generatedAt: "2026-07-28T00:00:00.000Z",
    nodes: [
      { path: "docs/index.md", label: "Index", metadata: { kind: "index", scope: "atlas", status: "current", canonical_for: "Atlas documentation", sources: ["guide.md"] } },
      { path: "docs/guide.md", label: "Guide", source: "shared-main", metadata: { status: "current", canonical_for: "Atlas guide" } },
      { path: "docs/future_target.md", label: "Future", metadata: { status: "target" } },
    ],
    edges: [
      { from: "doc:docs/index.md", to: "reference:guide.md", type: "references", source: "guide.md" },
      { from: "doc:docs/guide.md", to: "reference:images/flow.svg", type: "declares-source", source: "images/flow.svg" },
    ],
  };
  const contextGraph = {
    freshness: { state: "fresh" },
    resources: [{ id: "instruction:root", kind: "instruction", locator: "AGENTS.md", truthState: "accepted", metadata: { relativePath: "AGENTS.md" } }],
    applications: [{ resourceId: "instruction:root", scope: "project", status: "active", coordinate: { provider: "codex", folder: "." } }],
    relations: [],
  };
  const accepted = buildProjectDocumentRelationsGraph({ root, projectId: "atlas", locationId: "atlas-main", title: "Atlas", documentationGraph, contextGraph });
  assert.ok(accepted.nodes.some((node) => node.path === "docs/index.md"));
  assert.ok(accepted.nodes.some((node) => node.path === "docs/images/flow.svg" && node.kind === "diagram"));
  assert.ok(accepted.nodes.some((node) => node.path === "AGENTS.md" && node.kind === "instruction"));
  assert.equal(accepted.nodes.find((node) => node.path === "docs/guide.md")?.source, "shared-main");
  assert.deepEqual(accepted.nodes.find((node) => node.path === "docs/index.md")?.metadata, {
    contract: "legacy",
    id: "",
    idValid: false,
    dependsOn: [],
    diagramLinks: [],
    truthState: "",
    kind: "index",
    scope: "atlas",
    status: "current",
    canonicalFor: "Atlas documentation",
    sources: ["guide.md"],
  });
  assert.equal(accepted.edges.some((edge) => edge.source === "Atlas documentation"), false);
  assert.ok(!accepted.nodes.some((node) => node.path === "docs/future_target.md"));

  const layered = buildProjectDocumentRelationsGraph({
    root,
    projectId: "atlas",
    locationId: "atlas-main",
    title: "Atlas",
    documentationGraph,
    contextGraph,
    pendingPaths: ["docs/guide.md"],
    layers: ["accepted", "unverified", "target", "proposal"],
    proposals: [{ id: "proposal-1", branch: "proposal/docs", title: "Docs update", files: ["docs/index.md"] }],
  });
  assert.equal(layered.nodes.find((node) => node.path === "docs/guide.md")?.truthState, "unverified");
  assert.ok(layered.nodes.some((node) => node.path === "docs/future_target.md" && node.truthState === "target"));
  assert.ok(layered.nodes.some((node) => node.kind === "proposal" && node.truthState === "proposal"));
  assert.equal(layered.edges.find((edge) => edge.from.endsWith(":docs/guide.md"))?.evidence.truthState, "unverified");

  const local = buildProjectDocumentRelationsGraph({ root, projectId: "atlas", locationId: "atlas-main", scope: "local", centerPath: "docs/index.md", depth: 1, documentationGraph, contextGraph });
  assert.deepEqual(new Set(local.nodes.map((node) => node.path)), new Set(["docs/index.md", "docs/guide.md"]));

  const laidOutA = await layoutDocumentRelationsGraph(accepted);
  const laidOutB = await layoutDocumentRelationsGraph(accepted);
  assert.deepEqual(laidOutA.nodes.map((node) => node.position), laidOutB.nodes.map((node) => node.position));
});

test("document relations resolve stable IDs, dependencies, inverse direction, and Mermaid appearances", () => {
  const graph = buildProjectDocumentRelationsGraph({
    root: makeRoot(),
    projectId: "atlas",
    locationId: "atlas-main",
    layers: ["accepted"],
    includeUnresolved: true,
    documentationGraph: {
      nodes: [
        { path: "docs/product/policy.md", metadata: { contract: "minimal", id: "product.review.policy", idValid: true, dependsOn: [], truthState: "current" } },
        { path: "docs/system/queue.md", metadata: { contract: "minimal", id: "system.review.queue", idValid: true, dependsOn: ["product.review.policy"], truthState: "current" } },
        { path: "docs/system/map.md", metadata: { contract: "minimal", id: "system.review.map", idValid: true, dependsOn: [], truthState: "current", diagramLinks: [{ nodeId: "policy", id: "product.review.policy", anchor: "approval", uri: "cr://product.review.policy#approval" }] } },
      ],
      edges: [{ from: "doc:docs/system/queue.md", to: "reference:cr://product.review.policy#approval", type: "references", source: "cr://product.review.policy#approval" }],
    },
  });
  const policy = graph.nodes.find((node) => node.documentId === "product.review.policy");
  const queue = graph.nodes.find((node) => node.documentId === "system.review.queue");
  const map = graph.nodes.find((node) => node.documentId === "system.review.map");
  assert.ok(graph.edges.some((edge) => edge.from === queue.id && edge.to === policy.id && edge.type === "depends-on"));
  assert.ok(graph.edges.some((edge) => edge.from === queue.id && edge.to === policy.id && edge.type === "references" && edge.evidence.anchor === "approval"));
  assert.ok(graph.edges.some((edge) => edge.from === map.id && edge.to === policy.id && edge.type === "appears-in-diagram"));
  assert.match(policy.id, /^document:atlas:atlas-main:product\.review\.policy$/);
});

test("proposal document resolution prefers the exact pending revision and preserves its truth layer", () => {
  const resolved = resolveDocumentReferenceInDocuments([
    {
      path: "projects/atlas/docs/review.md",
      version: "pending-blob",
      content: "---\ncontext_room:\n  id: product.review.policy\n---\n\n# Pending policy\n",
    },
  ], "cr://product.review.policy#approval", {
    proposal: { id: "proposal-1", head: "pending-head" },
  });

  assert.equal(resolved.path, "projects/atlas/docs/review.md");
  assert.equal(resolved.anchor, "approval");
  assert.equal(resolved.truthState, "proposal");
  assert.equal(resolved.version, "pending-blob");
  assert.equal(resolved.proposal.head, "pending-head");
});

test("document resolution accepts provider-native files outside the documentation graph", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n", "utf8");

  const resolved = resolveDocumentReference(root, "AGENTS.md");

  assert.equal(resolved.path, "AGENTS.md");
  assert.equal(resolved.contract, "provider-native");
  assert.equal(resolved.documentId, "");
});

test("global document relations group registered worktrees and only connect explicit shared origins", () => {
  const graph = buildGlobalDocumentRelationsGraph({
    projects: [
      { id: "atlas", projectKey: "atlas", title: "Atlas", shared: { repository: "shared://team" }, worktrees: [{ id: "atlas-main", root: "/tmp/atlas" }, { id: "atlas-feature", root: "/tmp/atlas-feature" }] },
      { id: "beacon", projectKey: "beacon", title: "Beacon", shared: { repository: "shared://team" }, worktrees: [{ id: "beacon-main", root: "/tmp/beacon" }] },
      { id: "local", projectKey: "local", title: "Local", worktrees: [{ id: "local-main", root: "/tmp/local" }] },
    ],
    projectOrder: ["atlas", "beacon", "local"],
  });
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes.find((node) => node.projectKey === "atlas")?.worktrees.length, 2);
  assert.deepEqual(graph.edges.map((edge) => edge.type), ["shared-origin"]);
});

test("app presents a compact review-first workspace", () => {
  const html = renderAppHtml();
  const asideEnd = html.indexOf("</aside>");
  const mainStart = html.indexOf("<main>", asideEnd);
  const dockStart = html.indexOf('class="workspace-dock"', mainStart);
  const brandStart = html.indexOf('id="brandHome" class="context-room-brand"', dockStart);
  const workspaceSwitchStart = html.indexOf('id="settingsButton" class="dock-button workspace-switch"', dockStart);
  const backStart = html.indexOf('id="back" class="dock-button"', dockStart);

  assert.ok(asideEnd >= 0 && mainStart > asideEnd && dockStart > mainStart);
  assert.ok(brandStart > dockStart && workspaceSwitchStart > brandStart && backStart > workspaceSwitchStart);
  assert.match(html, /id="brandHome" class="context-room-brand" type="button" title="Home" aria-label="Home"/);
  assert.match(html, /\.context-room-brand \{[\s\S]*background: transparent;[\s\S]*cursor: pointer;/);
  assert.match(html, /\.context-room-brand:focus-visible \{[\s\S]*outline:/);
  assert.match(html, /id="workspaceTitle" class="workspace-title">Context Room<\/div>/);
  assert.match(html, /id="settingsButton" class="dock-button workspace-switch"[^>]*>Settings<\/button>/);
  assert.match(html, /\.workspace-switch \{[\s\S]*min-width: 76px;[\s\S]*border-left: 1px solid var\(--line\);[\s\S]*background: transparent;/);
  assert.match(html, /\.workspace-switch:hover \{[\s\S]*color: var\(--label-strong\);/);
  assert.match(html, /el\("settingsButton"\)\.hidden = state\.page !== "hub"/);
  assert.doesNotMatch(html, /id="hub" class="dock-button workspace-switch"/);
  assert.doesNotMatch(html, /Back to Home/);
  assert.doesNotMatch(html, /state\.page === "hub" \? "Settings" : "Home"/);
  assert.match(html, /async function handleBrandHomeAction\(\) \{[\s\S]*if \(state\.page === "hub"\) return;[\s\S]*await waitForReviewFinalizationBeforeNavigation\(\);[\s\S]*goHub\(\);/);
  assert.match(html, /el\("brandHome"\)\.addEventListener\("click", \(\) => handleBrandHomeAction\(\)\.catch/);
  assert.match(html, /el\("settingsButton"\)\.addEventListener\("click", showSettingsPage\)/);
  assert.match(html, /<h2 id="reviewQueueHeading" tabindex="-1">Review queue<\/h2>/);
  assert.match(html, /hubDisclosuresOpen:\s*new Set\(\)/);
  assert.match(html, /data-hub-disclosure=/);
  assert.doesNotMatch(html, /@keyframes workbenchGridDrift/);
  assert.match(html, /QUIET NATIVE WORKBENCH/);
  assert.match(html, /--explorer-width:\s*272px/);
  assert.match(html, /\.context-room-proposal-description-toggle \{[^}]*width: 28px;[^}]*min-width: 28px;[^}]*height: 28px;[^}]*border: 0;[^}]*background: transparent;[^}]*font: 650 11px\/1/);
  assert.match(html, /@media \(max-width: 639px\) \{[\s\S]*\.context-room-proposal-description-toggle \{ width: 40px; min-width: 40px; height: 40px;/);
  assert.match(html, /\.context-room-proposal-description-toggle:hover \{[^}]*background: var\(--native-hover\);[^}]*opacity: 1;/);
  assert.match(html, /\.settings-snoozed-search \{[^}]*display: grid;[^}]*gap: 6px;/);
  assert.equal(
    renderReviewSummary({ changedDocs: 9, needsReview: 2 }),
    '<div class="review-summary-item"><strong>2</strong><span>to review</span></div>' +
      '<div class="review-summary-item"><strong>9</strong><span>changed</span></div>',
  );
});

test("app exposes progressive Document Graph navigation, filters, and accessible list mode", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);
  assert.match(html, /\.workspace-page\[hidden\] \{ display: none !important; \}/);
  assert.match(html, /id="graphOpen"[^>]*aria-label="Open document graph"/);
  assert.match(html, /id="graphPage" class="graph-page workspace-page" hidden/);
  assert.match(html, /id="graphScope"/);
  assert.match(html, /id="graphDepth"/);
  assert.match(html, /id="graphTypeFilter"/);
  assert.match(html, /id="graphRelationFilter"/);
  assert.match(html, /id="graphProposalSelect"/);
  assert.match(html, /id="graphAccessibleList"/);
  assert.match(script, /Open project graph/);
  assert.match(script, /Open local graph/);
  assert.match(script, /\/api\/context-hub\/document-graph/);
  assert.match(script, /graphManualPositions/);
  assert.match(script, /el\("graphAccessibleList"\)\.hidden = !state\.graphListMode/);
  assert.match(script, /state\.page === "graph"/);
});

test("Explorer projects an opened document into explicit Location and Related views", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);

  assert.match(script, /\['location', 'related'\]/);
  assert.match(script, /Depends on/);
  assert.match(script, /Depended on by/);
  assert.match(script, /References/);
  assert.match(script, /Referenced by/);
  assert.match(script, /Appears in diagrams/);
  assert.match(script, /Unresolved/);
  assert.match(script, /relatedProjection\.dependsOn\.length[\s\S]*relatedProjection\.appearsInDiagrams\.length/);
  assert.match(script, /data-explorer-reveal-location/);
  assert.match(script, /data-explorer-open-local-graph/);
  assert.match(script, /scope: "local"/);
  assert.match(script, /depth: "1"/);
  assert.match(script, /layout: "0"/);
  assert.match(script, /if \(!IS_GLOBAL_CONTEXT_ROOM \|\| state\.explorerDocumentView !== "related"/);
  assert.match(script, /explorerDocumentView:\s*state\.explorerDocumentView/);
  assert.match(script, /if \(state\.explorerDocumentView === "related"\) target\.searchParams\.set\("explorerView", "related"\)/);
  assert.match(script, /state\.explorerDocumentView = initialNavigation\.explorerDocumentView/);
  assert.match(script, /\["ArrowLeft", "ArrowRight", "Home", "End"\]/);
  assert.match(script, /data-kind="folder" aria-expanded="' \+ \(expanded \? "true" : "false"\)/);
  assert.match(html, /\.explorer-related-row \{[^}]*min-height: 40px/);
});

test("project links keep the Explorer hierarchy quiet instead of looking like web links", () => {
  const html = renderAppHtml();

  assert.match(html, /\.global-project-row \{[^}]*text-decoration: none;/);
  assert.match(html, /\.global-project-tree-entry \{[^}]*text-decoration: none;/);
});

test("the global Context Room keeps project targeting inside one workspace", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);

  assert.match(html, /body\.global-context-room #singleProjectExplorer,[\s\S]*body\.focused-review-context-room #globalProjectExplorer \{ display: none !important; \}/);
  assert.doesNotMatch(html, /body\.global-context-room #contextHealthPanel \{ display: none !important; \}/);
  assert.match(html, /id="singleProjectExplorer"[\s\S]*id="globalProjectExplorer" class="global-project-explorer" hidden/);
  assert.match(html, /id="globalProjectSearch"[\s\S]*id="globalProjectList"/);
  assert.match(html, /\.shared-proposal-workspace \{ position: fixed; inset: 0 0 0 320px;/);
  assert.match(html, /\.app\.sidebar-collapsed ~ \.shared-proposal-workspace \{ left: 56px; \}/);
  assert.match(html, /id="contextHubCreateProject"[\s\S]*New project/);
  assert.match(html, /id="contextHubCreateSharedDocument"[\s\S]*New shared document/);
  assert.doesNotMatch(html, /id="sharedProposalBrowser"/);
  assert.match(html, /body\.focused-review-context-room \.context-room-review-toolbar \{ grid-template-columns:/);
  assert.match(html, /\.context-hub-review-filter\[hidden\] \{ display: none !important; \}/);
  assert.match(script, /state\.activeProjectLocationId = "";/);
  assert.match(script, /function applyContextHubRequestedProject\(contextHub\)[\s\S]*resolveContextHubProjectSelection\([\s\S]*state\.activeProjectLocationId = requestedLocationId;/);
  assert.match(script, /headers\.set\("x-context-room-target-project", state\.activeProjectLocationId\)/);
  assert.match(script, /async function openContextHubProject\([\s\S]*target\.searchParams\.set\("hub", "1"\)[\s\S]*window\.location\.assign\(target\.toString\(\)\)/);
  assert.match(script, /function currentContextRoomProject\(\)[\s\S]*project\.current[\s\S]*hub\.currentProjectId/);
  assert.match(script, /function contextHubHomeReviewItems\(needle = "", visibility = "active", \{ ignoreUserFilters = false \} = \{\}\)[\s\S]*IS_GLOBAL_CONTEXT_ROOM[\s\S]*ignoreUserFilters \|\| !state\.sharedProposalProject \|\| contextHubItemMatchesProject\(item, \{ projectKey: state\.sharedProposalProject \}\)[\s\S]*currentProject && contextHubItemMatchesProject\(item, currentProject\)/);
  assert.match(script, /function renderGlobalProjectExplorer\(\)[\s\S]*contextHubPrioritizedProjects[\s\S]*data-global-project-key/);
  assert.match(script, /async function openGlobalProjectExplorer\(project\)[\s\S]*state\.globalExplorerMode = "project"[\s\S]*loadGlobalProjectExplorerPage\(project\)/);
  assert.match(script, /function renderGlobalProjectInspection\([\s\S]*const project = workspaceSelectedProject\(\)/);
  assert.match(script, /function selectedGlobalSettingsProject\(\)[\s\S]*return workspaceSelectedProject\(\)/);
  const computerModeHandler = script.match(/if \(mode === "computer"\) \{([\s\S]*?)\n\s*return;\n\s*\}/)?.[1] || "";
  assert.match(computerModeHandler, /state\.globalExplorerMode = "computer"/);
  assert.doesNotMatch(computerModeHandler, /globalExplorerProjectKey\s*=|activeProjectLocationId\s*=|refreshGlobalSettingsScopeFromExplorer/);
  const projectsModeHandler = script.match(/const activeProject = workspaceSelectedProject\(\);([\s\S]*?)\n\s*\}\)\);/)?.[1] || "";
  assert.match(projectsModeHandler, /state\.globalExplorerMode = activeProject \? "project" : "projects"/);
  assert.match(projectsModeHandler, /state\.globalExplorerProjectKey = activeProject\?\.projectKey \|\| ""/);
  assert.match(projectsModeHandler, /loadGlobalProjectExplorerPage\(activeProject\)/);
  assert.doesNotMatch(projectsModeHandler, /activeProjectLocationId\s*=|refreshGlobalSettingsScopeFromExplorer/);
  assert.match(script, /async function loadGlobalProjectExplorerPage\([\s\S]*\/api\/context-hub\/project-explorer\?/);
  assert.match(script, /async function loadComputerExplorer\(targetPath = "", \{ expand = false \} = \{\}\)[\s\S]*\/api\/context-hub\/computer-explorer/);
  assert.match(script, /function renderComputerExplorerNode\(snapshot, depth = 0, needle = ""\)[\s\S]*data-computer-explorer-folder/);
  assert.match(script, /data-computer-explorer-file/);
  assert.match(script, /computerExplorerExpandedFolders\.has\(folderPath\)[\s\S]*computerExplorerExpandedFolders\.delete\(folderPath\)/);
  assert.match(html, /data-global-explorer-mode="projects"[\s\S]*data-global-explorer-mode="computer"/);
  assert.match(html, /id="globalExplorerListLabel">Projects<\/strong>/);
  assert.match(script, /data-global-explorer-back[\s\S]*state\.globalExplorerMode = "projects"/);
  assert.match(html, /id="computerExplorerRoot" type="text"/);
  assert.match(script, /globalProjectList[\s\S]*data-global-project-file[\s\S]*globalProjectSelectedWorktree\(project\)[\s\S]*openContextHubProject\(worktree\?\.id \|\| project\.id, \{ filePath:/);
  assert.match(script, /globalProjectList[\s\S]*addEventListener\("contextmenu"[\s\S]*openGlobalExplorerContextMenu/);
  assert.match(script, /function renderGlobalExplorerContextMenu\(x, y\)[\s\S]*Watch this folder…[\s\S]*View Context health[\s\S]*View startup environment[\s\S]*New file[\s\S]*New folder[\s\S]*Copy path/);
  assert.match(script, /data-global-context-inspect[\s\S]*Inspect agent environment/);
  assert.match(script, /data-context-inspect-environment[\s\S]*openContextEngineInspection/);
  assert.match(script, /data-global-context-health[\s\S]*openGlobalProjectInspection\("health", project\)/);
  assert.match(script, /data-global-context-startup[\s\S]*openGlobalProjectInspection\("startup", project\)/);
  assert.doesNotMatch(script, /searchParams\.set\("(?:startupEnvironment|contextHealth)", "1"\)/);
  assert.doesNotMatch(script, /function contextHubProjectDirectUrl/);
  assert.doesNotMatch(script, /function revealRequested(?:StartupEnvironment|ContextHealth)/);
  assert.match(script, /\/api\/context-hub\/project-explorer\/action/);
  assert.match(script, /function showContextHubCreateProjectDialog\([\s\S]*\/api\/context-hub\/projects/);
  assert.match(script, /function showContextHubCreateSharedDocumentDialog\([\s\S]*\/api\/context-hub\/shared-documents/);
  assert.match(script, /Accepted shared main stays unchanged/);
  assert.match(script, /\/api\/context-hub\/project-inspection\?projectId=/);
  assert.match(script, /data-global-project-shared[\s\S]*state\.sharedProposalProject = sharedButton\.dataset\.globalProjectShared/);
  assert.match(script, /function renderContextHealth\(\)[\s\S]*if \(IS_GLOBAL_CONTEXT_ROOM\) \{[\s\S]*renderGlobalProjectInspection\(panel, holder\);[\s\S]*return;/);
  assert.doesNotMatch(html, /id="toggleContextHealthPanel"/);
  assert.match(script, /function renderGlobalInspectionDisclosure\([\s\S]*<details class="global-project-inspection-disclosure"[\s\S]*<summary>/);
  assert.match(script, /data-global-inspection-disclosure[\s\S]*state\.globalInspectionView === view[\s\S]*state\.globalInspectionView = ""/);
  assert.match(html, /\.global-project-inspection-disclosure\[open\] \.global-project-inspection-disclosure-chevron/);
  assert.match(script, /function renderGlobalProjectInspection\([\s\S]*Select a project in Explorer[\s\S]*Context health[\s\S]*Agent environment/);
  assert.match(script, /heading\.textContent = "Project inspection"/);
  assert.match(script, /Context health and the agent environment for its selected worktree will appear here\./);
  assert.match(script, /project\.mode === "shared" \|\| !worktree\?\.root[\s\S]*no accepted main snapshot is cached/);
  assert.match(script, /project\.mode === "shared" \|\| !worktree\?\.root[\s\S]*This Shared-only project has no local worktree to inspect\./);
  assert.match(script, /project\.mode !== "shared"[\s\S]*No connected local worktree is available to inspect for this project\./);
  assert.doesNotMatch(script, /function renderProjectOverviewBody/);
  assert.doesNotMatch(script, /\/api\/context-hub\/project-overview/);
  assert.doesNotMatch(html, /id="visualDocumentsButton"/);
  assert.match(script, /function renderGlobalInspectionHealth\([\s\S]*Context health filters[\s\S]*context-health-issue-list/);
  assert.match(script, /function renderGlobalInspectionStartup\([\s\S]*Startup context[\s\S]*Startup skills[\s\S]*Startup hooks/);
  assert.match(script, /function renderGlobalInspectionStartup\([\s\S]*data\.effectiveContext[\s\S]*renderEffectiveContextBody/);
  assert.match(html, /id="contextEnginePanel" class="docqa-panel context-engine-panel" hidden/);
  assert.match(html, /id="contextEngineProvider"[\s\S]*Codex[\s\S]*Claude Code[\s\S]*OpenCode/);
  assert.match(script, /async function loadContextEngineInspection\([\s\S]*\/api\/context\/effective/);
  assert.match(script, /data-context-resource-trace[\s\S]*\/api\/context\/" \+ kind/);
  assert.match(script, /Open resource[\s\S]*contextEngineEntryCanOpen/);
  assert.match(script, /function renderGlobalInspectionRow\([\s\S]*global-project-inspection-row-head[\s\S]*global-project-inspection-kind/);
  assert.match(script, /kind: "Context file"[\s\S]*kind: "Skill folder"[\s\S]*kind: "Hook"/);
  assert.match(script, /global-project-inspection-row disabled[\s\S]*Enable it in this project’s settings to inspect its active files/);
  assert.match(html, /\.global-project-inspection-list \{[^}]*gap: 6px/);
  assert.match(html, /\.global-project-inspection-row \{[^}]*border: 1px solid[^}]*border-radius: 9px/);
  assert.match(script, /function renderHubFolders\(\)[\s\S]*visibleSections = sections\.filter\(\(section\) => section && Array\.isArray\(section\.cards\)\)/);
  assert.match(script, /function renderHubFolders\(\)[\s\S]*data-empty=[\s\S]*holder\.hidden = !holder\.innerHTML/);
});

test("app reveals one complete initial frame and keeps recurring refreshes in the background", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);
  const loadFilesSource = script.slice(script.indexOf("async function loadFiles"), script.indexOf("function reconcileMissingSelectedFile"));
  const diskRefreshSource = script.slice(script.indexOf("async function refreshFromDisk"), script.indexOf("function scheduleBackgroundRefresh"));

  assert.match(loadFilesSource, /const reportsRequest = options\.initial && !IS_GLOBAL_CONTEXT_ROOM \? api\("\/api\/reports"\) : null;/);
  assert.match(script, /async function loadInitialDirectSharedContext\(\) \{[\s\S]*const initial = await api\("\/api\/shared-context"\);[\s\S]*if \(!initial\?\.enabled \|\| initial\.mode !== "project"\) return initial;[\s\S]*api\("\/api\/shared-context\/refresh", \{[\s\S]*method: "POST"/);
  assert.match(loadFilesSource, /const sharedRequest = options\.initial && !IS_GLOBAL_CONTEXT_ROOM \? loadInitialDirectSharedContext\(\) : null;/);
  assert.match(loadFilesSource, /const sharedData = await \(sharedRequest \|\| Promise\.resolve\(null\)\);[\s\S]*const reportsRequest/);
  assert.match(loadFilesSource, /IS_GLOBAL_CONTEXT_ROOM[\s\S]*api\("\/api\/health"\)[\s\S]*api\(filesApiPath\(\)\)/);
  assert.match(loadFilesSource, /Promise\.all\(\[filesRequest, api\("\/api\/settings"\)\]\)/);
  assert.doesNotMatch(loadFilesSource, /Promise\.all\(\[api\(filesApiPath\(\)\), api\("\/api\/settings"\)\]\)/);
  assert.match(loadFilesSource, /const restoreRequest = skipsGenericNavigationRestore \? Promise\.resolve\(false\) : restoreNavigationAfterInitialLoad\(\);\s*const restored = await restoreRequest;/);
  assert.match(loadFilesSource, /const restored = await restoreRequest;/);
  assert.doesNotMatch(loadFilesSource, /await reportsRequest/);
  assert.match(loadFilesSource, /else if \(reportsRequest\) applyInitialReportsWhenReady\(reportsRequest\);/);
  assert.match(loadFilesSource, /state\.contextHubReadyPromise = new Promise[\s\S]*applyInitialContextHubWhenReady\(loadInitialContextHubData\(\{ openRequestedProject: true \}\)\)/);
  assert.match(script, /function applyInitialReportsWhenReady\(reportsRequest\) \{[\s\S]*reportsRequest\.then\(\(reports\) => \{[\s\S]*requestAnimationFrame\(\(\) => window\.requestAnimationFrame\(\(\) => \{[\s\S]*applyBackgroundReportPayload\(reports\);[\s\S]*renderAfterBackgroundReportPayload\(\);/);
  assert.match(script, /function renderAfterBackgroundReportPayload\(\) \{[\s\S]*if \(state\.page === "file" && state\.selected && !state\.openingFilePath\) \{[\s\S]*renderViewer\(\);[\s\S]*restoreEditorViewState\(viewState\);/);
  assert.match(script, /function restoreNavigationAfterInitialLoad\(\)[\s\S]*void openRequest\.then\(\(\) => setStatus\("restored"\)\)/);
  assert.doesNotMatch(script, /await selectFile\(persisted\.selectedPath, options\)/);
  assert.match(html, /<body class="app-booting">/);
  assert.match(html, /id="status" class="dock-status"[^>]*title="Starting">Starting…<\/div>/);
  assert.match(script, /setMode\("view"\);\s*initializeWorkspaceDiagnostics\(\);\s*establishWorkspaceIdentity\(\)\.then\(\(\) => \{/);
  assert.doesNotMatch(script, /initializeWorkspaceDiagnostics\(\);\s*finishInitialBoot\(\);/);
  assert.match(script, /const pairingRequest = registerInitialWorkspaceRuntime\(\);[\s\S]*const initialLoad = Promise\.all\(\[loadFiles\(\{ initial: true \}\), graphRequest\]\);[\s\S]*await state\.contextHubReadyPromise;[\s\S]*handleAgentCommand\(pairedCommand\)[\s\S]*IS_HOSTED_CONTEXT_ROOM \? Promise\.all\(\[initialLoad, pairingRequest\]\) : initialLoad;[\s\S]*\.then\(finishInitialBoot\)\.catch/);
  assert.match(script, /IS_HOSTED_CONTEXT_ROOM && document\.body\.classList\.contains\("app-booting"\) && \/\^\(\?:proposal \)\?ready\$\/i\.test/);
  const globalQueueSource = script.slice(script.indexOf("function renderContextRoomGlobalReviewQueue"), script.indexOf("function renderSingleProjectWorktreeSwitch"));
  assert.doesNotMatch(globalQueueSource, /renderGlobalProjectExplorer\(\)/);
  assert.match(html, /body\.app-booting \.app \{ visibility: hidden; opacity: 0; pointer-events: none; \}/);
  assert.match(script, /const reportsPath = "\/api\/reports"/);
  assert.match(script, /readFileForOpen\(path, \{ force: options\.forceReload \}\)/);
  assert.match(diskRefreshSource, /const data = await readSelectedDiskFile\(previousSelected\)/);
  assert.doesNotMatch(diskRefreshSource, /Promise\.all\(\[[\s\S]*readSelectedDiff/);
  assert.match(script, /function startRuntimeEvents\(\)[\s\S]*new EventSource\(contextRoomScopedRequestPath\("\/api\/runtime-events\?"/);
  assert.match(script, /function ensureRuntimeFallback\(\)[\s\S]*60_000/);
  assert.doesNotMatch(script, /setInterval\(\(\) => refreshFromDisk\(\), 2200\)/);
  assert.doesNotMatch(script, /setInterval\(\(\) => scheduleBackgroundRefresh\(\), 5_000\)/);
  assert.doesNotMatch(script, /setInterval\(\(\) => pollAgentCommand\(\)\.catch\(\(\) => \{\}\), 1500\)/);
  assert.doesNotMatch(script, /setInterval\(\(\) => publishSessionState\(\)\.catch\(\(\) => \{\}\), 5_000\)/);
});

test("Context Engine UI uses read-only API adapters and keeps proposal semantics explicit", () => {
  const source = fs.readFileSync(new URL("../src/context_room.mjs", import.meta.url), "utf8");
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);

  assert.match(source, /import\("\.\/context_inventory\.mjs"\)/);
  assert.match(source, /import\("\.\/context_engine\.mjs"\)/);
  assert.match(source, /url\.pathname === "\/api\/context\/effective"/);
  assert.match(source, /url\.pathname === "\/api\/context\/graph"/);
  assert.match(source, /url\.pathname === "\/api\/context\/trace"/);
  assert.match(source, /url\.pathname === "\/api\/context\/impact"/);
  assert.match(source, /url\.pathname === "\/api\/proposal\/context-impact"/);
  assert.match(source, /import\("\.\/agent_cli\.mjs"\)/);
  assert.match(source, /proposalContextImpact\(\{\s*selector: target\?\.head \|\| selector,\s*repository,/);
  assert.doesNotMatch(source, /selectedProposal\?\.files \|\| \[\]\)\.map/);
  assert.doesNotMatch(source, /listExactReviewInvalidations:[\s\S]{0,200}changedFiles\.map/);
  assert.match(script, /Shared Skills delta/);
  assert.match(script, /Existing reviews invalidated/);
  assert.match(source, /semantic conflicts are not evaluated/i);
  assert.match(script, /Semantic conflicts are not evaluated\./);
  assert.match(script, /Review invalidation is exact-revision only\./);
  assert.match(script, /function contextEngineEntryCanOpen\([\s\S]*metadata\?\.relativePath[\s\S]*!relPath\.startsWith\("~"\)/);
  assert.doesNotMatch(script, /allowedPaths.*contextEngine|contextEngine.*allowedPaths/);
});

test("single-project Startup environment resolves through the same Context Core surface", () => {
  const source = fs.readFileSync(new URL("../src/context_room.mjs", import.meta.url), "utf8");
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);

  assert.match(source, /const startupPanels = IS_GLOBAL_CONTEXT_ROOM\s*\? ""\s*: renderSingleProjectStartupEnvironmentPanel\(\);/);
  assert.match(script, /function renderSingleProjectStartupEnvironmentPanel\(\)[\s\S]*data-single-startup-provider/);
  assert.match(script, /async function loadSingleProjectStartupEnvironment\(\)[\s\S]*\/api\/context\/effective\?/);
  assert.match(script, /renderEffectiveContextBody\(state\.singleStartupEffectiveContext, \{ embedded: true \}\)/);
  assert.doesNotMatch(source, /const startupPanels = IS_GLOBAL_CONTEXT_ROOM \? "" : renderStartupContextPanel\(\) \+ renderStartupSkillsPanel\(\) \+ renderStartupHooksPanel\(\);/);
});

test("Shared Skills empty states distinguish project selection from an unconnected project", () => {
  const script = extractInlineAppScript(renderAppHtml());
  assert.match(script, /status\.selectionRequired \? "Select a project in the Explorer\." : "This project is not connected to a shared context\."/);
  assert.match(script, /Choose a project connected to a shared context/);
  assert.match(script, /Connect this project to a shared context before managing shared skill collections/);
});

test("review decisions emitted by the UI API use registered Hub identities", async (t) => {
  const root = makeRoot();
  const hubHome = makeRoot();
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
  });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/guide.md"] });
  const registered = registerContextHubProject(root, {
    title: "Event identity",
    shared: { repository: "https://example.test/shared.git", projectId: "shared-demo" },
  });
  const { server, ownerMutationNonce } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const denied = await fetch(`http://127.0.0.1:${server.address().port}/api/docqa/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "docs/guide.md", status: "verified", expectedContentHash: createHash("sha256").update("# Guide\n").digest("hex") }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "review_authority_nonce_required");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/docqa/review`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ path: "docs/guide.md", status: "verified", expectedContentHash: createHash("sha256").update("# Guide\n").digest("hex") }),
  });
  assert.equal(response.status, 200);

  const [event] = readContextRoomEvents({ types: ["review.decision"] }).events;
  assert.ok(event);
  assert.equal(event.projectId, registered.logicalProjectId);
  assert.equal(event.locationId, registered.id);
  assert.equal(event.sharedProjectId, "shared-demo");
  assert.equal(event.sharedRepository, "https://example.test/shared.git");
  assert.notEqual(event.locationId, path.resolve(root));
});

test("local Shared recovery abandonment is owner-protected and accepts only exact identities", async (t) => {
  const root = makeRoot();
  initializeContextRoomProject(root);
  const calls = [];
  const invalidCalls = [];
  let refreshFails = false;
  const catalog = {
    enabled: true,
    generatedAt: "2026-08-09T10:00:00.000Z",
    projects: [],
    sharedRepositories: [],
    proposals: [],
    items: [],
    repositoryErrors: [],
    summary: {},
  };
  const room = createMemoryServer({
    root,
    contextHubAbandonSharedRecovery(request) {
      calls.push(request);
      return {
        ...request,
        projectId: request.expectedProjectId,
        logicalProjectId: request.expectedLogicalProjectId,
        archivedPath: "/private/recovery/archive.json",
        ...(request.transactionId === "transaction-refresh-failure" ? {
          durabilityWarning: { code: "EIO", message: "internal fsync failure", path: "/private/recovery/archive.json" },
          orphanBindingRemoved: true,
          canonicalSharedCleared: true,
        } : {}),
      };
    },
    contextHubAbandonInvalidSharedRecovery(request) {
      invalidCalls.push(request);
      return {
        ...request,
        revision: request.expectedRevision,
        archivedJournalPath: "/private/recovery/invalid.journal",
        durabilityWarning: { code: "EIO", message: "internal invalid-journal fsync failure" },
      };
    },
    contextHubSnapshotRefresh: () => {
      if (refreshFails) throw new Error("injected refresh failure");
      return catalog;
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => room.server.close((error) => error ? reject(error) : resolve())));
  const endpoint = `http://127.0.0.1:${room.server.address().port}/api/context-hub/shared-recovery/abandon`;
  const exactRequest = {
    transactionId: "transaction-123",
    expectedProjectId: "location-456",
    expectedLogicalProjectId: "project-789",
  };

  const denied = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(exactRequest),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "review_authority_nonce_required");
  assert.equal(calls.length, 0);

  const malformed = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ ...exactRequest, operation: "connect" }),
  });
  assert.equal(malformed.status, 400);
  assert.equal((await malformed.json()).code, "context_hub_shared_recovery_identity_required");
  assert.equal(calls.length, 0);

  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify(exactRequest),
  });
  const payload = await response.json();
  assert.equal(response.status, 200, JSON.stringify(payload));
  assert.deepEqual(calls, [exactRequest]);
  assert.deepEqual(payload.recovery, {
    status: "abandoned",
    kind: "transaction",
    transactionId: exactRequest.transactionId,
    projectId: exactRequest.expectedProjectId,
    logicalProjectId: exactRequest.expectedLogicalProjectId,
  });
  assert.deepEqual(payload.catalog, catalog);
  assert.equal(payload.refreshPending, false);
  assert.equal(JSON.stringify(payload).includes("archivedPath"), false);
  assert.equal(JSON.stringify(payload).includes("/private/recovery"), false);

  const invalidRequest = {
    quarantineId: "quarantine-123",
    expectedRevision: "revision-456",
  };
  const invalidResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify(invalidRequest),
  });
  const invalidPayload = await invalidResponse.json();
  assert.equal(invalidResponse.status, 200, JSON.stringify(invalidPayload));
  assert.deepEqual(invalidCalls, [invalidRequest]);
  assert.deepEqual(invalidPayload.recovery, {
    status: "abandoned",
    kind: "invalid-journal",
    scope: "global",
    quarantineId: invalidRequest.quarantineId,
    revision: invalidRequest.expectedRevision,
    durabilityPending: true,
  });
  assert.deepEqual(invalidPayload.catalog, catalog);
  assert.equal(JSON.stringify(invalidPayload).includes("archivedJournalPath"), false);
  assert.equal(JSON.stringify(invalidPayload).includes("internal invalid-journal fsync failure"), false);
  assert.equal(JSON.stringify(invalidPayload).includes("/private/recovery"), false);

  refreshFails = true;
  const committedRequest = { ...exactRequest, transactionId: "transaction-refresh-failure" };
  const committedResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify(committedRequest),
  });
  const committedPayload = await committedResponse.json();
  assert.equal(committedResponse.status, 200, JSON.stringify(committedPayload));
  assert.equal(committedPayload.refreshPending, true);
  assert.equal(committedPayload.recovery.durabilityPending, true);
  assert.equal(committedPayload.recovery.orphanBindingRemoved, true);
  assert.equal(committedPayload.recovery.canonicalSharedCleared, true);
  assert.equal(Object.hasOwn(committedPayload, "catalog"), false);
  assert.equal(JSON.stringify(committedPayload).includes("internal fsync failure"), false);
  assert.equal(JSON.stringify(committedPayload).includes("/private/recovery"), false);
  assert.deepEqual(calls.at(-1), committedRequest);
});

test("Context Hub live Shared connection and disconnection cover every logical-project root", () => {
  const source = fs.readFileSync(new URL("../src/context_room.mjs", import.meta.url), "utf8");
  const routeStart = source.indexOf('if (req.method === "POST" && url.pathname === "/api/context-hub/project-shared-context")');
  const routeEnd = source.indexOf('if (req.method === "DELETE" && url.pathname === "/api/context-hub/project-shared-context")', routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const connectRoute = source.slice(routeStart, routeEnd);
  const disconnectRouteEnd = source.indexOf('if (req.method === "POST" && url.pathname === "/api/context-hub/reviews/snooze")', routeEnd);
  assert.ok(disconnectRouteEnd > routeEnd);
  const disconnectRoute = source.slice(routeEnd, disconnectRouteEnd);

  assert.match(connectRoute, /requireSyncedShared:\s*true/);
  assert.match(connectRoute, /connectionReceiptId:\s*pending\.sharedTransactionId/);
  assert.match(connectRoute, /projectRoots:\s*pending\.sharedProjectRoots/);
  assert.match(connectRoute, /projectCapabilities:\s*pending\.sharedProjectCapabilities/);
  assert.match(disconnectRoute, /disconnectSharedContext\(project\.root,\s*\{\s*projectRoots:\s*pending\.sharedProjectRoots,\s*projectCapabilities:\s*pending\.sharedProjectCapabilities,\s*\}\)/);
});

test("Context Hub HTTP connect and disconnect synchronize every registered worktree", async (t) => {
  const base = makeRoot();
  const testHome = path.join(base, "home");
  const sharedHome = path.join(testHome, ".context-room", "shared");
  const sharedRemote = path.join(base, "shared.git");
  const sharedSeed = path.join(base, "shared-seed");
  const projectRoot = path.join(base, "project");
  const worktreeRoot = path.join(base, "project-agent");
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.HOME = testHome;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  fs.mkdirSync(testHome, { recursive: true });
  let server = null;
  let ownerMutationNonce = "";
  t.after(async () => {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    const makeWritable = (target) => {
      if (!fs.existsSync(target)) return;
      const stats = fs.lstatSync(target);
      if (stats.isSymbolicLink()) return;
      try { fs.chmodSync(target, stats.isDirectory() ? 0o700 : 0o600); } catch {}
      if (stats.isDirectory()) {
        for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
      }
    };
    makeWritable(base);
    fs.rmSync(base, { recursive: true, force: true });
  });

  execFileSync("git", ["init", "--bare", "--initial-branch=main", sharedRemote], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["clone", sharedRemote, sharedSeed], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: sharedSeed, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: sharedSeed, stdio: "ignore" });
  initializeSharedRepository(sharedSeed, { name: "Worktree receipt fixture" });
  fs.writeFileSync(path.join(sharedSeed, "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  fs.mkdirSync(path.join(sharedSeed, "projects", "demo", "docs"), { recursive: true });
  fs.writeFileSync(path.join(sharedSeed, "projects", "demo", "docs", "README.md"), "# Shared demo\n");
  execFileSync("git", ["add", "."], { cwd: sharedSeed, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initialize shared fixture"], { cwd: sharedSeed, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: sharedSeed, stdio: "ignore" });

  fs.mkdirSync(path.join(projectRoot, "docs"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "docs", "README.md"), "# Local demo\n");
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: projectRoot, stdio: "ignore" });
  initializeContextRoomProject(projectRoot, { title: "Local demo", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initialize local fixture"], { cwd: projectRoot, stdio: "ignore" });
  execFileSync("git", ["worktree", "add", "-b", "test/context-room-worktree-receipts", worktreeRoot], { cwd: projectRoot, stdio: "ignore" });

  const selected = registerContextHubProject(projectRoot);
  const worktree = registerContextHubProject(worktreeRoot);
  assert.equal(worktree.logicalProjectId, selected.logicalProjectId);
  registerContextHubSharedRepository(sharedRemote);

  ({ server, ownerMutationNonce } = createMemoryServer({ root: projectRoot }));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/context-hub/project-shared-context`;
  const headers = {
    "content-type": "application/json",
    "x-context-room-owner-nonce": ownerMutationNonce,
  };
  const connectedResponse = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: selected.id, repository: sharedRemote, sharedProjectId: "demo" }),
  });
  const connectedPayload = await connectedResponse.json();
  assert.equal(connectedResponse.status, 200, JSON.stringify(connectedPayload));
  assert.equal(readSharedProjectConnection(projectRoot)?.projectId, "demo");
  assert.equal(readSharedProjectConnection(worktreeRoot)?.projectId, "demo");

  const receiptFiles = [];
  const collectReceiptFiles = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) collectReceiptFiles(entryPath);
      else if (entry.isFile() && entryPath.includes(`${path.sep}connection-receipts${path.sep}`) && entry.name.endsWith(".json")) receiptFiles.push(entryPath);
    }
  };
  collectReceiptFiles(sharedHome);
  assert.equal(receiptFiles.length, 2);
  const receipts = receiptFiles.map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
  const canonicalProjectRoot = fs.realpathSync(projectRoot);
  const canonicalWorktreeRoot = fs.realpathSync(worktreeRoot);
  assert.deepEqual(new Set(receipts.map((receipt) => receipt.projectRoot)), new Set([canonicalProjectRoot, canonicalWorktreeRoot]));
  assert.equal(new Set(receipts.map((receipt) => receipt.receiptId)).size, 1);
  const [receiptId] = receipts.map((receipt) => receipt.receiptId);
  assert.ok(readSharedConnectionReceipt(canonicalProjectRoot, { repository: sharedRemote, projectId: "demo", receiptId }));
  assert.ok(readSharedConnectionReceipt(canonicalWorktreeRoot, { repository: sharedRemote, projectId: "demo", receiptId }));

  const disconnectedResponse = await fetch(endpoint, {
    method: "DELETE",
    headers,
    body: JSON.stringify({ projectId: selected.id }),
  });
  const disconnectedPayload = await disconnectedResponse.json();
  assert.equal(disconnectedResponse.status, 200, JSON.stringify(disconnectedPayload));
  assert.equal(readSharedProjectConnection(projectRoot), null);
  assert.equal(readSharedProjectConnection(worktreeRoot), null);
});

test("Context Engine read-only APIs resolve through the web server without an import cycle", async (t) => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n");
  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(base + "/api/context/effective?folder=.&provider=codex&allowStale=1");
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(result.schemaVersion, "context-room.context-effective/1");
  assert.equal(result.coordinate.folder, ".");
  assert.equal(result.coordinate.provider, "codex");
  assert.ok(Array.isArray(result.instructions));
  assert.ok(Array.isArray(result.inactive));

  const graphResponse = await fetch(base + "/api/context/graph?folder=.&provider=codex&allowStale=1");
  const graph = await graphResponse.json();
  assert.equal(graphResponse.status, 200);
  assert.equal(graph.schemaVersion, "context-room.context-graph/1");
  const instruction = graph.resources.find((item) => item.kind === "instruction" && item.metadata?.relativePath === "AGENTS.md");
  assert.ok(instruction);

  const target = new URLSearchParams({ folder: ".", provider: "codex", allowStale: "1", selector: instruction.id });
  const [traceResponse, impactResponse] = await Promise.all([
    fetch(base + "/api/context/trace?" + target),
    fetch(base + "/api/context/impact?" + target),
  ]);
  const [trace, impact] = await Promise.all([traceResponse.json(), impactResponse.json()]);
  assert.equal(traceResponse.status, 200);
  assert.equal(trace.status, "ok");
  assert.equal(trace.selected.id, instruction.id);
  assert.equal(impactResponse.status, 200);
  assert.equal(impact.status, "ok");
  assert.equal(impact.resource.id, instruction.id);

  const proposalResponse = await fetch(base + "/api/proposal/context-impact?selector=proposal/example");
  const proposalError = await proposalResponse.json();
  assert.equal(proposalResponse.status, 400);
  assert.match(proposalError.error, /repository is required/i);
});

test("Document Graph API returns a versioned accepted project graph and a bounded local graph", async (t) => {
  const root = makeRoot();
  const indexContent = "---\ncontext_room:\n  id: docs.index\n---\n\n# Index\n\n[Guide](guide.md)\n";
  const guideContent = "---\ncontext_room:\n  id: docs.guide\n---\n\n# Guide\n";
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), indexContent);
  fs.writeFileSync(path.join(root, "docs", "guide.md"), guideContent);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  writeDocReviewDecision(root, "docs/index.md", { status: "verified", expectedContentHash: createHash("sha256").update(indexContent).digest("hex") });
  writeDocReviewDecision(root, "docs/guide.md", { status: "verified", expectedContentHash: createHash("sha256").update(guideContent).digest("hex") });
  writeDocReviewDecision(root, "AGENTS.md", { status: "verified", expectedContentHash: createHash("sha256").update("# Project instructions\n").digest("hex") });
  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const projectResponse = await fetch(base + "/api/context-hub/document-graph?scope=project&layout=0&allowStale=1");
  const projectGraph = await projectResponse.json();
  assert.equal(projectResponse.status, 200);
  assert.equal(projectGraph.schemaVersion, "context-room.document-relations-graph/2");
  assert.deepEqual(projectGraph.layers, ["accepted"]);
  assert.ok(projectGraph.nodes.some((node) => node.path === "AGENTS.md"));
  assert.ok(projectGraph.nodes.some((node) => node.path === "docs/index.md"));
  assert.ok(projectGraph.edges.some((edge) => edge.type === "references"));

  const localResponse = await fetch(base + "/api/context-hub/document-graph?scope=local&path=docs/index.md&depth=1&layout=0&allowStale=1");
  const localGraph = await localResponse.json();
  assert.equal(localResponse.status, 200);
  assert.equal(localGraph.target.scope, "local");
  assert.equal(localGraph.target.depth, 1);
  assert.deepEqual(new Set(localGraph.nodes.map((node) => node.path)), new Set(["docs/index.md", "docs/guide.md"]));

  const inspectionResponse = await fetch(base + "/api/context-hub/document-inspect?path=AGENTS.md");
  const inspection = await inspectionResponse.json();
  assert.equal(inspectionResponse.status, 200);
  assert.equal(inspection.document.contract, "provider-native");
  assert.equal(inspection.trust.contentVerification, "accepted");

  const searchResponse = await fetch(base + "/api/context-hub/document-search?query=Index&limit=1");
  const search = await searchResponse.json();
  assert.equal(searchResponse.status, 200);
  assert.equal(search.schemaVersion, "context-room.document-search/1");
  assert.equal(search.pagination.limit, 1);
  assert.ok(search.items.some((item) => item.path === "docs/index.md"));

  const validationResponse = await fetch(base + "/api/context-hub/document-validate?path=docs/guide.md");
  const validation = await validationResponse.json();
  assert.equal(validationResponse.status, 200);
  assert.equal(validation.schemaVersion, "context-room.document-validation/1");
  assert.equal(validation.valid, true);

  const changedContent = indexContent + "\nUpdated.\n";
  const saveResponse = await fetch(base + "/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      path: "docs/index.md",
      content: changedContent,
      expectedContentHash: createHash("sha256").update(indexContent).digest("hex"),
    }),
  });
  assert.equal(saveResponse.status, 200);
  const refreshedResponse = await fetch(base + "/api/context-hub/document-graph?scope=project&layout=0&allowStale=1");
  const refreshedGraph = await refreshedResponse.json();
  assert.equal(refreshedResponse.status, 200);
  assert.equal(refreshedGraph.nodes.some((node) => node.path === "docs/index.md"), false);
});

test("Shared Skills settings expose local controls and selective imports without replacing unmanaged files", () => {
  const source = fs.readFileSync(new URL("../src/context_room.mjs", import.meta.url), "utf8");
  const script = extractInlineAppScript(renderAppHtml());

  assert.match(script, /data-shared-skills-local-toggle/);
  assert.match(script, /data-shared-skills-local-exclude/);
  assert.match(script, /data-shared-skills-unlink/);
  assert.match(script, /data-shared-skills-import-skill/);
  assert.match(script, /sharedSkillsWizardInclude/);
  assert.match(script, /sharedSkillsWizardExclude/);
  assert.match(script, /Unmanaged files remain untouched/);
  assert.match(script, /technical collisions/);
  const applyProviderSource = script.slice(script.indexOf("async function applySharedSkillProviderSettings"), script.indexOf("async function unassignSharedSkillsFromSettings"));
  assert.match(applyProviderSource, /JSON\.stringify\(\{ projectId: selection\.projectId, providers: globalProviders, projectOverrides \}\)/);
  assert.equal((applyProviderSource.match(/\/api\/shared-skills\/providers/g) || []).length, 1);
  assert.match(source, /setSharedSkillProviderSettings\(projectRoot/);
  assert.doesNotMatch(source, /setSharedSkillProvider(?:Override|Preferences)\(projectRoot/);
});

test("Context Hub project opening returns a truthful pending state while Shared sync continues out of process", async () => {
  const base = makeRoot();
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  const hostRoot = path.join(base, "host");
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.HOME = path.join(base, "home");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(process.env.HOME, ".context-room", "shared");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(hostRoot, { recursive: true });

  let server = null;
  let finishSync = null;
  try {
    execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["clone", remote, seed], { cwd: base, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: seed, stdio: "ignore" });
    initializeSharedRepository(seed, { name: "Pending project sync" });
    fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2) + "\n");
    fs.mkdirSync(path.join(seed, "projects", "demo", "docs"), { recursive: true });
    fs.writeFileSync(path.join(seed, "projects", "demo", "docs", "README.md"), "# Demo\n");
    execFileSync("git", ["add", "."], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "Initialize shared"], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd: seed, stdio: "ignore" });

    initializeContextRoomProject(project, { title: "Demo", allowedPaths: [], watchAllow: [] });
    initializeContextRoomProject(hostRoot, { title: "Host", allowedPaths: [], watchAllow: [] });
    connectSharedContext(project, { repository: remote, projectId: "demo", sync: false });
    const registered = registerContextHubProject(project, {
      title: "Demo",
      shared: { repository: remote, projectId: "demo" },
    });
    const projectSync = new Promise((resolve) => { finishSync = resolve; });
    let snapshotRefreshes = 0;
    ({ server } = createMemoryServer({
      root: hostRoot,
      contextHubProjectSync: () => projectSync,
      contextHubAcceptRefreshTimeoutMs: 25,
      contextHubSnapshotRefresh: async () => {
        snapshotRefreshes += 1;
        return { freshness: { generatedAt: new Date().toISOString() } };
      },
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/context-hub/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: registered.id }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.ok(Date.now() - startedAt < 750, `project opening took ${Date.now() - startedAt} ms`);
    assert.equal(payload.sharedStatus.refreshing, true);
    assert.deepEqual(payload.hubRefresh, { status: "pending" });
    assert.ok(snapshotRefreshes >= 1);

    finishSync({ online: true, revision: "a".repeat(40), fetchError: "" });
    finishSync = null;
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(snapshotRefreshes >= 2, "the completed Shared sync should refresh the persisted Hub snapshot");
  } finally {
    if (finishSync) finishSync({ online: false, revision: "", fetchError: "test cleanup" });
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  }
});

test("Context Hub local project opening does not wait for the follow-up catalogue rebuild", async () => {
  const base = makeRoot();
  const project = path.join(base, "project");
  const hostRoot = path.join(base, "host");
  const previousHome = process.env.HOME;
  process.env.HOME = path.join(base, "home");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(hostRoot, { recursive: true });

  let server = null;
  try {
    initializeContextRoomProject(project, { title: "Local project", allowedPaths: [], watchAllow: [] });
    initializeContextRoomProject(hostRoot, { title: "Host", allowedPaths: [], watchAllow: [] });
    const registered = registerContextHubProject(project, { title: "Local project" });
    ({ server } = createMemoryServer({
      root: hostRoot,
      contextHubSnapshotRefresh: () => new Promise(() => {}),
    }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

    const startedAt = Date.now();
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/context-hub/project`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: registered.id }),
    });
    const payload = await response.json();

    assert.equal(response.status, 201, JSON.stringify(payload));
    assert.ok(Date.now() - startedAt < 750, `local project opening took ${Date.now() - startedAt} ms`);
    assert.deepEqual(payload.hubRefresh, { status: "pending" });
  } finally {
    if (server?.listening) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("Shared Skills provider API applies device defaults and project overrides atomically", async (t) => {
  const base = makeRoot();
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.HOME = path.join(base, "home");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(process.env.HOME, ".context-room", "shared");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });

  execFileSync("git", ["init", "--bare", "--initial-branch=main", remote], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["clone", remote, seed], { cwd: base, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: seed, stdio: "ignore" });
  initializeSharedRepository(seed, { name: "Provider API shared" });
  fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2) + "\n");
  fs.mkdirSync(path.join(seed, "projects", "demo", "docs"), { recursive: true });
  fs.writeFileSync(path.join(seed, "projects", "demo", "docs", "README.md"), "# Demo\n");
  execFileSync("git", ["add", "."], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initialize shared"], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: seed, stdio: "ignore" });
  initializeContextRoomProject(project, { title: "Demo", allowedPaths: [], watchAllow: [] });
  connectSharedContext(project, { repository: remote, projectId: "demo" });

  const { server } = createMemoryServer({ root: project });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const endpoint = `http://127.0.0.1:${server.address().port}/api/shared-skills/providers`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      providers: { codex: "disabled", "claude-code": "enabled", opencode: "enabled" },
      projectOverrides: [{ projectId: "demo", provider: "claude-code", state: "disabled" }],
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.providers.providers.codex, "disabled");
  assert.deepEqual(result.projectOverrides.find((item) => item.projectId === "demo" && item.provider === "claude-code"), {
    projectId: "demo",
    provider: "claude-code",
    state: "disabled",
  });

  const legacyResponse = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "project", provider: "claude-code", state: "inherit" }),
  });
  assert.equal(legacyResponse.status, 200);
});

test("background report and diff endpoints preserve complete results", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupHooks.enabled = false;
  config.startupSkills.enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nUpdated.\n");

  const direct = buildContextRoomReports(root);
  assert.equal(direct.docqa.queue[0].path, "docs/guide.md");
  assert.equal(direct.doctor.docqa.needsReview, 1);

  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const [reportsResponse, diffResponse] = await Promise.all([
    fetch(baseUrl + "/api/reports?fresh=1"),
    fetch(baseUrl + "/api/file/diff?path=" + encodeURIComponent("docs/guide.md")),
  ]);
  const reports = await reportsResponse.json();
  const diff = await diffResponse.json();

  assert.equal(reportsResponse.status, 200);
  assert.equal(reports.docqa.queue[0].path, "docs/guide.md");
  assert.equal(diffResponse.status, 200);
  assert.equal(diff.changed, true);
  assert.match(diff.patch, /Updated\./);

  const sessionResponse = await fetch(baseUrl + "/api/session-state", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page: "hub", view: "hub" }),
  });
  assert.equal(sessionResponse.status, 200);
  const cachedReports = await (await fetch(baseUrl + "/api/reports")).json();
  assert.equal(cachedReports.generatedAt, reports.generatedAt);

  const writeResponse = await fetch(baseUrl + "/api/file", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "docs/guide.md", content: "# Guide\n\nUpdated through the API.\n", expectedContentHash: createHash("sha256").update("# Guide\n\nUpdated.\n").digest("hex") }),
  });
  assert.equal(writeResponse.status, 200);
  const refreshedReports = await (await fetch(baseUrl + "/api/reports")).json();
  assert.notEqual(refreshedReports.generatedAt, cachedReports.generatedAt);
  assert.equal(refreshedReports.docqa.queue[0].path, "docs/guide.md");
  const refreshedDiff = await (await fetch(baseUrl + "/api/file/diff?path=" + encodeURIComponent("docs/guide.md"))).json();
  assert.match(refreshedDiff.patch, /Updated through the API\./);
});

test("background file endpoints preserve safe request errors", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  const { server, waitForShutdown } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await waitForShutdown();
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const forbiddenPath = "~/.hermes/cron/jobs/private.json";

  for (const endpoint of ["/api/file", "/api/file/diff", "/api/file/review-base"]) {
    const response = await fetch(`${baseUrl}${endpoint}?path=${encodeURIComponent(forbiddenPath)}`);
    const body = await response.json();
    assert.equal(response.status, 403, endpoint);
    assert.deepEqual(body, {
      error: `Path not allowed in context room: ${forbiddenPath}`,
      code: "file_path_not_allowed",
      details: { path: forbiddenPath },
    }, endpoint);
  }
});

test("closing one server keeps a same-root server's background workers available", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  const first = createMemoryServer({ root });
  const second = createMemoryServer({ root });
  await new Promise((resolve) => first.server.listen(0, "127.0.0.1", resolve));
  await new Promise((resolve) => second.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    for (const instance of [first, second]) {
      if (instance.server.listening) {
        await new Promise((resolve, reject) => instance.server.close((error) => error ? reject(error) : resolve()));
      }
      await instance.waitForShutdown();
    }
  });

  const secondBaseUrl = `http://127.0.0.1:${second.server.address().port}`;
  assert.equal((await fetch(`${secondBaseUrl}/api/file/diff?path=${encodeURIComponent("docs/guide.md")}`)).status, 200);
  await new Promise((resolve, reject) => first.server.close((error) => error ? reject(error) : resolve()));
  await first.waitForShutdown();

  const [diffResponse, reportsResponse] = await Promise.all([
    fetch(`${secondBaseUrl}/api/file/diff?path=${encodeURIComponent("docs/guide.md")}`),
    fetch(`${secondBaseUrl}/api/reports?fresh=1`),
  ]);
  assert.equal(diffResponse.status, 200);
  assert.equal(reportsResponse.status, 200);
});

test("background file task timeout is retryable and recycles the worker", { timeout: 15_000 }, () => {
  const root = makeRoot();
  const wrapperBin = path.join(root, "bin");
  const markerPath = path.join(root, "blocked-once");
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(wrapperBin);
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperPath = path.join(wrapperBin, "git");
  fs.writeFileSync(wrapperPath, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (!fs.existsSync(process.env.CONTEXT_ROOM_TEST_GIT_BLOCK_MARKER)
	  && args.includes("--no-optional-locks")
	  && args.includes("status")
	  && args.some((arg) => arg === "docs/guide.md" || arg === ":(literal)docs/guide.md")) {
  fs.writeFileSync(process.env.CONTEXT_ROOM_TEST_GIT_BLOCK_MARKER, "blocked\\n");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500);
}
const result = spawnSync(process.env.CONTEXT_ROOM_TEST_REAL_GIT, args, { stdio: "inherit", env: process.env });
if (result.error) throw result.error;
process.exit(result.status == null ? 1 : result.status);
`);
  fs.chmodSync(wrapperPath, 0o755);

  const moduleUrl = new URL("../src/context_room.mjs", import.meta.url).href;
  const probe = `
    const [moduleUrl, root] = process.argv.slice(1);
    const { createMemoryServer } = await import(moduleUrl + "?timeout-probe=" + Date.now());
    const instance = createMemoryServer({ root });
    await new Promise((resolve) => instance.server.listen(0, "127.0.0.1", resolve));
    const baseUrl = "http://127.0.0.1:" + instance.server.address().port;
    const endpoints = ["/api/file/diff", "/api/file/review-base"];
    const call = () => Promise.all(endpoints.map(async (endpoint) => {
      const response = await fetch(baseUrl + endpoint + "?path=" + encodeURIComponent("docs/guide.md"));
      return { endpoint, status: response.status, body: await response.json() };
    }));
    const startedAt = Date.now();
    const first = await call();
    const elapsedMs = Date.now() - startedAt;
    const second = await call();
    await new Promise((resolve, reject) => instance.server.close((error) => error ? reject(error) : resolve()));
    await instance.waitForShutdown();
    process.stdout.write(JSON.stringify({ first, second, elapsedMs }));
  `;
  const output = execFileSync(process.execPath, ["--input-type=module", "--eval", probe, moduleUrl, root], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env,
      NODE_TEST_CONTEXT: "1",
      CONTEXT_ROOM_TEST_BACKGROUND_FILE_TASK_TIMEOUT_MS: "1000",
      CONTEXT_ROOM_TEST_GIT_BLOCK_MARKER: markerPath,
      CONTEXT_ROOM_TEST_REAL_GIT: realGit,
      PATH: `${wrapperBin}${path.delimiter}${process.env.PATH || ""}`,
    },
  });
  const result = JSON.parse(output);
  assert.ok(result.elapsedMs >= 50 && result.elapsedMs < 2_000, result.elapsedMs);
  const timedOut = result.first.filter((response) => response.status === 503);
  assert.ok(timedOut.length >= 1, JSON.stringify(result.first));
  for (const response of timedOut) {
    assert.equal(response.body.code, "background_file_task_timeout", response.endpoint);
    assert.equal(response.body.retryable, true, response.endpoint);
  }
  for (const response of result.first.filter((entry) => entry.status !== 503)) {
    assert.equal(response.status, 200, JSON.stringify(response));
  }
  for (const response of result.second) assert.equal(response.status, 200, JSON.stringify(response));
});

test("workspace registry keeps independent metadata and routes commands to an exact workspace", async (t) => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: [], watchAllow: [] });
  const { server, projectId } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  for (const workspace of [
    { workspaceId: "workspace-one", clientInstanceId: "client-one", projectId: "alpha", locationId: "location-a", view: "file", file: "docs/a.md", visible: true },
    { workspaceId: "workspace-two", clientInstanceId: "client-two", projectId: "beta", locationId: "location-b", view: "settings", visible: false },
  ]) {
    const response = await fetch(baseUrl + "/api/workspaces/register", {
      method: "POST",
      headers: { "content-type": "application/json", origin: baseUrl, "x-context-room-project": projectId },
      body: JSON.stringify(workspace),
    });
    assert.equal(response.status, 200);
  }
  const listed = await (await fetch(baseUrl + "/api/workspaces")).json();
  assert.deepEqual(new Set(listed.workspaces.map((item) => item.workspaceId)), new Set(["workspace-one", "workspace-two"]));
  const commandResponse = await fetch(baseUrl + "/api/workspaces/workspace-one/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action: "navigate", view: "file", path: "docs/a.md", target: { heading: "Purpose" } }),
  });
  assert.equal(commandResponse.status, 200);
  const one = await (await fetch(baseUrl + "/api/workspaces/workspace-one/command")).json();
  const two = await (await fetch(baseUrl + "/api/workspaces/workspace-two/command")).json();
  assert.equal(one.command.path, "docs/a.md");
  assert.deepEqual(one.command.target, { type: "heading", value: "Purpose" });
  assert.equal(two.command, null);
});

test("workspace runtime events deliver commands without periodic polling", async (t) => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: [], watchAllow: [] });
  const { server } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  });
  await fetch(baseUrl + "/api/workspaces/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workspaceId: "workspace-stream", clientInstanceId: "client-stream", view: "hub" }),
  });
  const replayCommandResponse = await fetch(baseUrl + "/api/workspaces/workspace-stream/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "replayed-command", action: "navigate", view: "file", path: "docs/replayed.md" }),
  });
  assert.equal(replayCommandResponse.status, 200);
  const streamResponse = await fetch(baseUrl + "/api/runtime-events?workspace=workspace-stream", { signal: controller.signal });
  assert.equal(streamResponse.status, 200);
  assert.match(streamResponse.headers.get("content-type") || "", /text\/event-stream/);
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let received = "";
  for (let attempt = 0; attempt < 5 && (!received.includes("replayed-command") || !received.includes("event: ready")); attempt += 1) {
    const next = await reader.read();
    if (next.done) break;
    received += decoder.decode(next.value, { stream: true });
  }
  assert.ok(received.indexOf("replayed-command") < received.indexOf("event: ready"), received);
  const commandResponse = await fetch(baseUrl + "/api/workspaces/workspace-stream/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "live-command", action: "navigate", view: "file", path: "docs/a.md" }),
  });
  assert.equal(commandResponse.status, 200);
  for (let attempt = 0; attempt < 5 && !received.includes("live-command"); attempt += 1) {
    const next = await reader.read();
    if (next.done) break;
    received += decoder.decode(next.value, { stream: true });
  }
  assert.match(received, /event: runtime/);
  assert.match(received, /"type":"workspace-command"/);
  assert.match(received, /"workspaceId":"workspace-stream"/);
  await reader.cancel();
});

test("optimistic file writes and review decisions reject unseen revisions", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Original\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/guide.md"] });
  const { server, ownerMutationNonce } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const originalHash = createHash("sha256").update("# Original\n").digest("hex");
  const first = await fetch(baseUrl + "/api/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "docs/guide.md", content: "# First workspace\n", expectedContentHash: originalHash }) });
  assert.equal(first.status, 200);
  const staleSave = await fetch(baseUrl + "/api/file", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: "docs/guide.md", content: "# Stale workspace\n", expectedContentHash: originalHash }) });
  assert.equal(staleSave.status, 409);
  assert.equal((await staleSave.json()).code, "file_revision_conflict");
  const staleReview = await fetch(baseUrl + "/api/docqa/review", { method: "POST", headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce }, body: JSON.stringify({ path: "docs/guide.md", status: "verified", expectedContentHash: originalHash }) });
  assert.equal(staleReview.status, 409);
  assert.equal((await staleReview.json()).code, "review_revision_conflict");
  assert.equal(fs.readFileSync(path.join(root, "docs", "guide.md"), "utf8"), "# First workspace\n");
});

test("default config is project-agnostic and supports cards, nested cards, allowed paths, and watched paths", () => {
  const config = createDefaultProjectConfig({ title: "Demo Project" });

  assert.equal(CONFIG_DIR, ".context-room");
  assert.equal(CONFIG_FILE, ".context-room/config.json");
  assert.equal(config.title, "Demo Project");
  assert.match(config.$schema, /schemas\/config\.schema\.json$/);
  assert.deepEqual(config.watchAllow, []);
  assert.equal("reviewPaths" in config, false);
  assert.equal("reviewAgentInstructions" in config, false);
  assert.equal("appearance" in config, false);
  assert.deepEqual(config.startupSkills.folderNames, [".agents/skills", "skills"]);
  assert.equal(config.startupHooks.enabled, true);
  assert.equal(config.startupHooks.editable, false);
  assert.equal(config.startupHooks.agentHooks, true);
  assert.equal(config.startupHooks.codexHooks, true);
  assert.ok(config.startupHooks.fileNames.includes("pre-commit"));
  assert.ok(config.startupHooks.agentHookSources.some((source) => source.id === "codex" && source.paths.includes(".codex/hooks.json")));
  assert.ok(config.startupHooks.agentHookSources.some((source) => source.id === "claude-code" && source.paths.includes(".claude/settings.json")));
  assert.ok(config.startupHooks.agentHookPaths.includes(".codex/hooks.json"));
  assert.ok(config.startupHooks.agentHookPaths.includes(".claude/settings.json"));
  assert.ok(config.startupHooks.agentHookPaths.includes(".opencode/plugins/"));
  assert.ok(config.startupHooks.codexPaths.includes(".codex/hooks.json"));
  assert.ok(config.startupHooks.managerPaths.includes(".husky/"));
  assert.ok(FILE_THEME_OPTIONS.some((theme) => theme.id === "context-room"));
  assert.ok(config.allowedPaths.includes("docs/"));
  assert.ok(config.allowedPaths.includes("src/"));
  assert.ok(config.hubSections[0].cards.some((card) => card.id === "docs"));
  assert.ok(config.hubSections[0].cards.some((card) => (card.cards || []).length > 0));
});

test("config schema accepts external home paths through exactly one allowed-path branch", () => {
  const schema = JSON.parse(fs.readFileSync(path.resolve("schemas/config.schema.json"), "utf8"));
  const matchesStringSchema = (value, rule) => {
    if (rule.$ref) return matchesStringSchema(value, schema.$defs[rule.$ref.split("/").at(-1)]);
    if (rule.oneOf) return rule.oneOf.filter((branch) => matchesStringSchema(value, branch)).length === 1;
    if (rule.type === "string" && typeof value !== "string") return false;
    if (rule.minLength && value.length < rule.minLength) return false;
    if (rule.pattern && !(new RegExp(rule.pattern).test(value))) return false;
    if (rule.not?.pattern && new RegExp(rule.not.pattern).test(value)) return false;
    return true;
  };
  const homePath = "~/shared-project-docs/";
  const allowedPath = schema.$defs.allowedPath;

  assert.equal(matchesStringSchema(homePath, schema.$defs.projectPath), false);
  assert.equal(matchesStringSchema(homePath, schema.$defs.homePath), true);
  assert.equal(matchesStringSchema(homePath, allowedPath), true);
  assert.equal(schema.properties.allowedPaths.items.$ref, "#/$defs/allowedPath");
  assert.equal(schema.properties.watchAllow.items.$ref, "#/$defs/allowedPath");
  assert.equal(schema.$defs.watchRule.properties.path.$ref, "#/$defs/allowedPath");
  assert.equal(matchesStringSchema(homePath, schema.$defs.watchRule.properties.path), true);
  assert.equal(matchesStringSchema(homePath + "guide.md", schema.$defs.watchRule.properties.files.items), true);
});

test("init writes a reusable project config without LifeOS-specific paths", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Documentation\n");

  const result = initializeContextRoomProject(root, { title: "Demo", preset: "generic" });
  const configPath = path.join(root, CONFIG_FILE);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));

  assert.equal(result.configPath, configPath);
  assert.equal(saved.title, "Demo");
  assert.match(saved.$schema, /schemas\/config\.schema\.json$/);
  assert.ok(saved.allowedPaths.includes("docs/"));
  assert.equal(saved.allowedPaths.includes("src/"), false);
  assert.ok(saved.watchAllow.includes("docs/"));
  assert.equal("appearance" in saved, false);
  assert.equal(JSON.stringify(saved).includes("Life OS"), false);
  assert.equal(JSON.stringify(saved).includes(".lifeos"), false);
  assert.equal(result.agentContextPath, path.join(root, AGENT_CONTEXT_FILE));
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_FILE)), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "README.md")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "features", "codex-prompt-center.md")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "html-visual-documents.md")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "html-visual-patterns.md")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "context-room-visual-components.html")), true);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_DIR, "context-room-data-visual-components.html")), true);
});

test("fresh init infers an EchoDesk-style documentation room without exposing source as editable", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "product"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "decisions"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "research"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "incidents"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "review-docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# EchoDesk\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# EchoDesk agents\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), `---
context_room:
  kind: index
  scope: echodesk
  status: current
  canonical_for: documentation-navigation
  last_verified: 2026-07-19
  sources: [README.md]
---

# EchoDesk documentation
`);
  fs.writeFileSync(path.join(root, "docs", "documentation-system.md"), `---
context_room:
  kind: canonical
  scope: echodesk
  status: current
  canonical_for: documentation-system
  last_verified: 2026-07-19
  sources: [docs/index.md]
---

# Documentation system
`);
  fs.writeFileSync(path.join(root, "docs", "product", "product_target.md"), `---
context_room:
  kind: canonical
  scope: echodesk
  status: draft
  canonical_for: product
  sources: []
---

# Product target
`);
  fs.writeFileSync(path.join(root, "docs", "decisions", "index.md"), "# Decisions\n");
  fs.writeFileSync(path.join(root, "docs", "research", "index.md"), "# Research\n");
  fs.writeFileSync(path.join(root, "docs", "incidents", "index.md"), "# Incidents\n");
  fs.writeFileSync(path.join(root, "skills", "review-docs", "SKILL.md"), "# Review docs\n");
  fs.writeFileSync(path.join(root, "src", "app.mjs"), "export const app = true;\n");

  const inferred = inferProjectDocumentationSetup(root);
  const initialized = initializeContextRoomProject(root, { title: "EchoDesk" });
  const sectionIds = inferred.hubSections.map((section) => section.id);
  const hubIds = inferred.hubSections.flatMap((section) => section.cards.map((card) => card.id));

  assert.deepEqual(inferred.allowedPaths, ["README.md", "AGENTS.md", "docs/", "skills/review-docs/SKILL.md"]);
  assert.deepEqual(inferred.watchAllow, inferred.allowedPaths);
  assert.equal(inferred.allowedPaths.some((relPath) => /^(?:src|lib|app|test|tests|scripts)\//.test(relPath)), false);
  assert.deepEqual(sectionIds, ["start-here", "current-documentation", "target-documentation", "records", "agent-guidance"]);
  assert.ok(inferred.hubSections.every((section) => section.cards.length > 0));
  assert.equal(hubIds.some((id) => ["source", "tests", "scripts", "context"].includes(id)), false);
  assert.equal(initialized.config.startupContext.projectOnly, true);
  assert.equal(initialized.config.startupContext.enabled, true);
  assert.equal(initialized.config.startupSkills.projectOnly, true);
  assert.equal(initialized.config.startupSkills.enabled, true);
  assert.equal(initialized.config.startupHooks.projectOnly, true);
});

test("repeated init preserves intentionally empty owner settings, custom hub sections, and AGENTS bytes", () => {
  const root = makeRoot();
  const agentsBytes = Buffer.from("# Exact agent instructions\r\nKeep these bytes.\r\n", "utf8");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Docs\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), agentsBytes);
  const firstSetup = initializeContextRoomProject(root, { title: "First setup" });
  assert.equal(firstSetup.config.startupSkills.enabled, true);

  const configPath = path.join(root, CONFIG_FILE);
  const ownerConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  ownerConfig.title = "Owner title";
  ownerConfig.allowedPaths = ["AGENTS.md"];
  ownerConfig.watchAllow = [];
  ownerConfig.reviewPaths = [];
  ownerConfig.hubSections = [{
    id: "owner-section",
    title: "Owner section",
    extensionData: { owner: "project" },
    cards: [{ id: "owner-agents", title: "Owner agents", path: "AGENTS.md" }],
  }];
  ownerConfig.extensionData = { setup: "preserve-me" };
  ownerConfig.startupContext.extensionMode = "owner-defined";
  const ownerConfigBytes = Buffer.from(JSON.stringify(ownerConfig, null, 4) + "\r\n", "utf8");
  fs.writeFileSync(configPath, ownerConfigBytes);

  const repeated = initializeContextRoomProject(root);

  assert.equal(repeated.fresh, false);
  assert.equal(repeated.discoverySkipped, true);
  assert.deepEqual(repeated.documentationPaths, []);
  assert.equal(repeated.config.title, "Owner title");
  assert.deepEqual(repeated.config.allowedPaths, ["AGENTS.md"]);
  assert.deepEqual(repeated.config.watchAllow, []);
  assert.deepEqual(repeated.config.reviewPaths, []);
  assert.deepEqual(repeated.config.hubSections.map((section) => section.id), ["owner-section"]);
  assert.deepEqual(repeated.config.hubSections[0].cards.map((card) => card.id), ["owner-agents"]);
  assert.deepEqual(fs.readFileSync(configPath), ownerConfigBytes);
  assert.deepEqual(fs.readFileSync(path.join(root, "AGENTS.md")), agentsBytes);

  initializeContextRoomProject(root, { title: "Amended title" });
  const amended = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.equal(amended.title, "Amended title");
  assert.deepEqual(amended.extensionData, { setup: "preserve-me" });
  assert.equal(amended.startupContext.extensionMode, "owner-defined");
  assert.deepEqual(amended.hubSections[0].extensionData, { owner: "project" });
});

test("empty hub sections remain configured and every section can be removed", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: [], watchAllow: [] });
  const settings = readMemoryWebappSettings(root);

  settings.hubSections = [{ id: "separator", title: "Separator", cards: [] }];
  writeMemoryWebappSettings(root, settings);
  assert.deepEqual(hubSectionsForRoot(root, readMemoryWebappSettings(root)), [
    { id: "separator", title: "Separator", cards: [] },
  ]);

  settings.hubSections = [];
  writeMemoryWebappSettings(root, settings);
  assert.deepEqual(readMemoryWebappSettings(root).hubSections, []);
  assert.deepEqual(hubSectionsForRoot(root, readMemoryWebappSettings(root)), []);
});

test("init refuses malformed project config without overwriting it", () => {
  const root = makeRoot();
  const configPath = path.join(root, CONFIG_FILE);
  const malformed = Buffer.from('{\n  "title": "Broken",\n', "utf8");
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, malformed);

  assert.throws(
    () => initializeContextRoomProject(root, { title: "Replacement" }),
    /Invalid Context Room config JSON/,
  );
  assert.deepEqual(fs.readFileSync(configPath), malformed);
  assert.equal(fs.existsSync(path.join(root, REVIEW_GATE_FILE)), false);
  assert.equal(fs.existsSync(path.join(root, AGENT_CONTEXT_FILE)), false);
});

test("fresh project containment blocks allowed-path symlink escapes while legacy configs remain compatible", () => {
  const external = makeRoot();
  fs.writeFileSync(path.join(external, "guide.md"), "# External guide\n");

  const root = makeRoot();
  fs.symlinkSync(external, path.join(root, "docs"), "dir");
  const initialized = initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  assert.equal(initialized.config.projectOnly, true);
  assert.equal(listMemoryFiles(root).some((file) => file.path === "docs/guide.md"), false);
  assert.equal(listExplorerFiles(root).some((file) => file.path === "docs/guide.md"), false);
  assert.throws(() => readMemoryFile(root, "docs/guide.md"), /symbolic link/);
  assert.throws(() => writeMemoryFile(root, "docs/guide.md", "changed\n"), /symbolic link/);
  assert.throws(() => createMarkdownFile(root, { path: "docs/new.md" }), /symbolic link/);
  assert.throws(() => createFolder(root, { path: "docs/new-folder" }), /symbolic link/);
  assert.throws(() => deleteMemoryPaths(root, ["docs/guide.md"]), /symbolic link/);
  const isolatedSettings = readMemoryWebappSettings(root);
  isolatedSettings.hubSections = [{ id: "docs", title: "Docs", cards: [{ id: "docs", title: "Docs", path: "docs/", autoChildren: true }] }];
  writeMemoryWebappSettings(root, isolatedSettings);
  const isolatedHub = hubSectionsForRoot(root, readMemoryWebappSettings(root));
  assert.deepEqual(isolatedHub[0].cards[0].cards || [], []);
  assert.doesNotMatch(JSON.stringify(isolatedHub), /External guide/);
  const isolatedDoctor = buildContextRoomDoctorReport(root);
  assert.ok(isolatedDoctor.issues.some((issue) => issue.type === "allowed_path_symlink_escape" && issue.path === "docs/"));
  assert.ok(isolatedDoctor.issues.some((issue) => issue.type === "watch_path_symlink_escape" && issue.path === "docs/"));
  assert.ok(isolatedDoctor.issues.some((issue) => issue.type === "hub_path_symlink_escape" && issue.path === "docs/"));
  assert.equal(fs.readFileSync(path.join(external, "guide.md"), "utf8"), "# External guide\n");
  assert.equal(fs.existsSync(path.join(external, "new.md")), false);

  const legacyRoot = makeRoot();
  fs.symlinkSync(external, path.join(legacyRoot, "docs"), "dir");
  fs.mkdirSync(path.join(legacyRoot, CONFIG_DIR), { recursive: true });
  const legacyConfig = {
    title: "Legacy symlink hub",
    allowedPaths: ["docs/"],
    watchAllow: [],
    reviewPaths: [],
    startupContext: { enabled: false, fileNames: [], globalPaths: [] },
    startupSkills: { enabled: false, folderNames: [] },
    startupHooks: { enabled: false, fileNames: [], agentHookSources: [], managerPaths: [] },
  };
  const legacyBytes = Buffer.from(JSON.stringify(legacyConfig, null, 2) + "\n");
  fs.writeFileSync(path.join(legacyRoot, CONFIG_FILE), legacyBytes);

  assert.equal(readMemoryWebappSettings(legacyRoot).projectOnly, false);
  assert.equal(readMemoryFile(legacyRoot, "docs/guide.md").content, "# External guide\n");
  assert.ok(listMemoryFiles(legacyRoot).some((file) => file.path === "docs/guide.md"));
  const repeatedLegacy = initializeContextRoomProject(legacyRoot);
  assert.equal(repeatedLegacy.config.projectOnly, false);
  assert.deepEqual(fs.readFileSync(path.join(legacyRoot, CONFIG_FILE)), legacyBytes);
});

test("settings API preserves fresh and legacy project containment modes", async (t) => {
  const freshRoot = makeRoot();
  initializeContextRoomProject(freshRoot, { allowedPaths: [], watchAllow: [] });
  const freshRoom = createMemoryServer({ root: freshRoot });
  const freshServer = freshRoom.server;
  await new Promise((resolve) => freshServer.listen(0, "127.0.0.1", resolve));
  t.after(() => freshServer.close());
  const freshSettings = readMemoryWebappSettings(freshRoot);
  const freshPayload = { ...freshSettings, title: "Fresh updated" };
  delete freshPayload.projectOnly;
  const freshResponse = await fetch(`http://127.0.0.1:${freshServer.address().port}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": freshRoom.ownerMutationNonce },
    body: JSON.stringify({ settings: freshPayload }),
  });
  assert.equal(freshResponse.status, 200);
  assert.equal((await freshResponse.json()).settings.projectOnly, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(freshRoot, CONFIG_FILE), "utf8")).projectOnly, true);

  const legacyRoot = makeRoot();
  fs.mkdirSync(path.join(legacyRoot, CONFIG_DIR), { recursive: true });
  fs.writeFileSync(path.join(legacyRoot, CONFIG_FILE), JSON.stringify({
    title: "Legacy",
    allowedPaths: [],
    watchAllow: [],
    reviewPaths: [],
  }, null, 2) + "\n");
  const legacyRoom = createMemoryServer({ root: legacyRoot });
  const legacyServer = legacyRoom.server;
  await new Promise((resolve) => legacyServer.listen(0, "127.0.0.1", resolve));
  t.after(() => legacyServer.close());
  const legacySettings = readMemoryWebappSettings(legacyRoot);
  assert.equal(legacySettings.projectOnly, false);
  const legacyPayload = { ...legacySettings, title: "Legacy updated" };
  delete legacyPayload.projectOnly;
  const legacyResponse = await fetch(`http://127.0.0.1:${legacyServer.address().port}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": legacyRoom.ownerMutationNonce },
    body: JSON.stringify({ settings: legacyPayload }),
  });
  assert.equal(legacyResponse.status, 200);
  assert.equal((await legacyResponse.json()).settings.projectOnly, false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(legacyRoot, CONFIG_FILE), "utf8")).projectOnly, false);
});

test("raw config narrowing fails closed until the human owner explicitly saves the reduced scope", async (t) => {
  const root = makeRoot();
  const hubHome = makeRoot();
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
  });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agent instructions\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const initial = readResolvedContextRoomSettings(root);
  assert.ok(initial.watchAllow.includes("docs/"));
  const configPath = path.join(root, CONFIG_FILE);
  const narrowed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  narrowed.allowedPaths = [];
  narrowed.watchAllow = [];
  narrowed.watchRules = [];
  narrowed.startupContext.enabled = false;
  narrowed.startupSkills.enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(narrowed, null, 2) + "\n");

  const effective = readResolvedContextRoomSettings(root);
  assert.ok(effective.watchAllow.includes("docs/"));
  assert.ok(effective.allowedPaths.includes("docs/"));
  assert.equal(effective.startupContext.enabled, true);
  assert.equal(effective.startupSkills.enabled, true);
  assert.ok(buildContextRoomDoctorReport(root).issues.some((issue) => issue.type === "review_authority_tamper" && issue.severity === "critical"));

  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => room.server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${room.server.address().port}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ settings: narrowed }),
  });
  assert.equal(response.status, 200);
  const ownerReduced = readResolvedContextRoomSettings(root);
  assert.equal(ownerReduced.watchAllow.includes("docs/"), false);
  assert.equal(ownerReduced.startupContext.enabled, false);
  assert.equal(ownerReduced.startupSkills.enabled, false);
  assert.equal(buildContextRoomDoctorReport(root).issues.some((issue) => issue.type === "review_authority_tamper"), false);
});

test("direct review-state and ledger forgery is ignored and reported as critical", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Original\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/guide.md"] });
  writeDocReviewDecision(root, "docs/guide.md", { status: "verified", note: "Legitimate owner decision" });
  assert.deepEqual(buildDocQaReport(root).queue, []);

  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Forged\n");
  const forgedHash = createHash("sha256").update("# Forged\n").digest("hex");
  for (const relPath of [".context-room/review-state.json", ".context-room/review-ledger.json"]) {
    const filePath = path.join(root, relPath);
    const forged = JSON.parse(fs.readFileSync(filePath, "utf8"));
    for (const review of Object.values(forged.reviews || {})) {
      review.contentHash = forgedHash;
      review.reviewHash = forgedHash;
      review.reviewedAt = new Date().toISOString();
    }
    fs.writeFileSync(filePath, JSON.stringify(forged, null, 2) + "\n");
  }

  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "docs/guide.md"), true);
  assert.ok(buildContextRoomDoctorReport(root).issues.some((issue) => issue.type === "review_evidence_tamper" && issue.severity === "critical"));
});

test("doctor stays available but closes protected context when both owner authority mirrors are corrupt", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const authorityPath = inspectOwnerReviewScope(root, readMemoryWebappSettings(root)).authorityPath;
  for (const filePath of [authorityPath, authorityPath + ".backup"]) {
    const record = JSON.parse(fs.readFileSync(filePath, "utf8"));
    record.scope.watchAllow = [];
    fs.writeFileSync(filePath, JSON.stringify(record, null, 2) + "\n");
  }

  const doctor = buildContextRoomDoctorReport(root);
  assert.ok(doctor.issues.some((issue) => issue.type === "review_authority_unavailable" && issue.severity === "critical"));
  assert.equal(doctor.settings.allowedPaths, 0);
  assert.equal(doctor.settings.watchAllow, 0);
});

test("setup and direct managed writers reject Context Room state symlink escapes", () => {
  const cases = [
    { relPath: CONFIG_DIR, directory: true },
    { relPath: CONFIG_FILE, content: "{}\n" },
    { relPath: REVIEW_GATE_FILE, content: '{"operations":[]}\n' },
    { relPath: AGENT_CONTEXT_FILE, content: "external guide\n" },
    { relPath: AGENT_CONTEXT_DIR, directory: true },
    { relPath: `${AGENT_CONTEXT_DIR}/agent-configuration.md`, content: "external configuration\n" },
  ];

  for (const fixture of cases) {
    const root = makeRoot();
    const external = makeRoot();
    const linkPath = path.join(root, fixture.relPath);
    fs.mkdirSync(path.dirname(linkPath), { recursive: true });
    const target = fixture.directory ? path.join(external, "target") : path.join(external, path.basename(fixture.relPath));
    if (fixture.directory) fs.mkdirSync(target, { recursive: true });
    else fs.writeFileSync(target, fixture.content);
    const before = fixture.directory ? fs.readdirSync(target) : fs.readFileSync(target);
    fs.symlinkSync(target, linkPath, fixture.directory ? "dir" : "file");

    assert.throws(() => initializeContextRoomProject(root, { title: "Must not escape" }), /symbolic link/);
    if (fixture.directory) assert.deepEqual(fs.readdirSync(target), before);
    else assert.deepEqual(fs.readFileSync(target), before);
  }

  const brokenRoot = makeRoot();
  fs.mkdirSync(path.join(brokenRoot, CONFIG_DIR), { recursive: true });
  const missingTarget = path.join(makeRoot(), "missing-config.json");
  fs.symlinkSync(missingTarget, path.join(brokenRoot, CONFIG_FILE));
  assert.throws(() => initializeContextRoomProject(brokenRoot), /symbolic link/);
  assert.equal(fs.existsSync(missingTarget), false);

  const directConfigRoot = makeRoot();
  const directConfigExternal = path.join(makeRoot(), "config.json");
  fs.writeFileSync(directConfigExternal, "{}\n");
  fs.mkdirSync(path.join(directConfigRoot, CONFIG_DIR), { recursive: true });
  fs.symlinkSync(directConfigExternal, path.join(directConfigRoot, CONFIG_FILE));
  assert.throws(() => writeMemoryWebappSettings(directConfigRoot, createDefaultProjectConfig()), /symbolic link/);

  const directGateRoot = makeRoot();
  const directGateExternal = path.join(makeRoot(), "review-gate.json");
  fs.writeFileSync(directGateExternal, '{"operations":[]}\n');
  fs.mkdirSync(path.join(directGateRoot, CONFIG_DIR), { recursive: true });
  fs.symlinkSync(directGateExternal, path.join(directGateRoot, REVIEW_GATE_FILE));
  assert.throws(() => writeReviewGateSettings(directGateRoot, { operations: [] }), /symbolic link/);

  const directAgentRoot = makeRoot();
  const directAgentExternal = makeRoot();
  fs.mkdirSync(path.join(directAgentRoot, CONFIG_DIR), { recursive: true });
  fs.symlinkSync(directAgentExternal, path.join(directAgentRoot, AGENT_CONTEXT_DIR), "dir");
  assert.throws(() => syncContextRoomAgentContext(directAgentRoot), /symbolic link/);
});

test("managed runtime state rejects internal and external symbolic-link aliases", () => {
  const cases = [
    {
      relPath: ".context-room/review-state.json",
      invoke: (root) => writeDocReviewBaseline(root, "docs/guide.md"),
    },
    {
      relPath: ".context-room/review-baselines",
      directory: true,
      invoke: (root) => writeDocReviewBaseline(root, "docs/guide.md"),
    },
    {
      relPath: ".context-room/review-ledger.json",
      invoke: (root) => writeDocReviewDecision(root, "docs/guide.md", { status: "verified" }),
    },
    {
      relPath: ".context-room/session-state.json",
      invoke: (root) => writeCollaborationSessionState(root, { page: "hub" }),
    },
    {
      relPath: ".context-room/agent-command.json",
      invoke: (root) => writeAgentCommand(root, { action: "navigate", path: "docs/guide.md" }),
    },
    {
      relPath: ".context-room/agent-annotations.json",
      invoke: (root) => appendAgentAnnotation(root, { path: "docs/guide.md", note: "Review this." }),
    },
    {
      relPath: ".context-room/health-acknowledgements.json",
      invoke: (root) => {
        const issue = buildContextRoomDoctorReport(root).issues.find((item) => item.type === "broken_source");
        assert.ok(issue?.key);
        return acknowledgeContextHealthIssue(root, { key: issue.key, note: "Unsafe alias must not be followed." });
      },
    },
    {
      relPath: ".context-room/memory-webapp-backups",
      directory: true,
      invoke: (root) => writeMemoryFile(root, "docs/guide.md", "# Changed guide\n"),
    },
  ];

  for (const fixture of cases) {
    for (const targetKind of ["internal", "external"]) {
      const root = makeRoot();
      fs.mkdirSync(path.join(root, "docs"), { recursive: true });
      const guideContent = `---
context_room:
  kind: canonical
  scope: test
  status: current
  canonical_for: guide
  last_verified: 2026-07-19
  sources: [missing.md]
---

# Guide
`;
      fs.writeFileSync(path.join(root, "docs", "guide.md"), guideContent);
      initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

      const targetBase = targetKind === "internal" ? path.join(root, "docs") : makeRoot();
      const target = path.join(targetBase, fixture.directory ? "runtime-state-target" : "runtime-state-target.json");
      if (fixture.directory) {
        fs.mkdirSync(target, { recursive: true });
        fs.writeFileSync(path.join(target, "sentinel.txt"), "sentinel\n");
      } else {
        fs.writeFileSync(target, '{"sentinel":true}\n');
      }
      const statePath = path.join(root, fixture.relPath);
      try {
        const existing = fs.lstatSync(statePath);
        if (existing.isDirectory()) fs.rmdirSync(statePath);
        else fs.unlinkSync(statePath);
      } catch {}
      fs.mkdirSync(path.dirname(statePath), { recursive: true });
      fs.symlinkSync(target, statePath, fixture.directory ? "dir" : "file");

      assert.throws(() => fixture.invoke(root), /symbolic link/);
      if (fixture.directory) assert.deepEqual(fs.readdirSync(target), ["sentinel.txt"]);
      else assert.equal(fs.readFileSync(target, "utf8"), '{"sentinel":true}\n');
      assert.equal(fs.readFileSync(path.join(root, "docs", "guide.md"), "utf8"), guideContent);
    }
  }
});

test("review decisions preflight the shared ledger before changing local verification state", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const settings = readMemoryWebappSettings(root);
  settings.reviewPaths = ["docs/guide.md"];
  writeMemoryWebappSettings(root, settings);

  const statePath = path.join(root, ".context-room/review-state.json");
  const baselinesPath = path.join(root, ".context-room/review-baselines");
  const ledgerPath = path.join(root, ".context-room/review-ledger.json");
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(baselinesPath), false);
  assert.equal(fs.existsSync(ledgerPath), false);
  assert.ok(buildDocQaReport(root).queue.some((item) => item.path === "docs/guide.md"));

  const externalLedger = path.join(makeRoot(), "review-ledger.json");
  fs.writeFileSync(externalLedger, '{"sentinel":true}\n');
  fs.symlinkSync(externalLedger, ledgerPath);

  assert.throws(() => writeDocReviewDecision(root, "docs/guide.md", { status: "verified" }), /symbolic link/);
  assert.equal(fs.readFileSync(externalLedger, "utf8"), '{"sentinel":true}\n');
  assert.equal(fs.existsSync(statePath), false);
  assert.equal(fs.existsSync(baselinesPath), false);

  fs.unlinkSync(ledgerPath);
  assert.ok(buildDocQaReport(root).queue.some((item) => item.path === "docs/guide.md"));
});

test("destructive startup deletions preserve their source when managed backup preflight fails", () => {
  const cases = [
    {
      sourcePath: "AGENTS.md",
      content: "# Project instructions\n",
      invoke: (root) => {
        const settings = readMemoryWebappSettings(root);
        settings.startupContext = { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] };
        const startup = listStartupContextFiles(root, settings).find((item) => item.startupContext?.fileName === "AGENTS.md" && item.startupContext?.absolutePath === path.join(root, "AGENTS.md"));
        assert.ok(startup);
        return deleteStartupContextFile(root, startup.startupContext.order, settings);
      },
    },
    {
      sourcePath: "skills/alpha/SKILL.md",
      content: "# Alpha skill\n",
      invoke: (root) => {
        const settings = readMemoryWebappSettings(root);
        settings.startupSkills = { enabled: true, projectOnly: true, folderNames: ["skills"] };
        const folder = listStartupSkillFolders(root, settings).find((item) => item.skills.includes("alpha"));
        assert.ok(folder);
        return deleteStartupSkill(root, folder.order, "alpha", settings);
      },
    },
  ];

  for (const fixture of cases) {
    const root = makeRoot();
    const source = path.join(root, fixture.sourcePath);
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, fixture.content);
    initializeContextRoomProject(root);

    const externalBackups = makeRoot();
    fs.writeFileSync(path.join(externalBackups, "sentinel.txt"), "sentinel\n");
    const backupPath = path.join(root, ".context-room/memory-webapp-backups");
    fs.symlinkSync(externalBackups, backupPath, "dir");

    assert.throws(() => fixture.invoke(root), /symbolic link|approved root|unsafe/i);
    assert.equal(fs.readFileSync(source, "utf8"), fixture.content);
    assert.deepEqual(fs.readdirSync(externalBackups), ["sentinel.txt"]);
  }
});

test("invalid project config and review gate fail closed for runtime operations and doctor", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, CONFIG_DIR), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, CONFIG_FILE), JSON.stringify({ allowedPaths: null }) + "\n");

  assert.throws(() => readMemoryWebappSettings(root), /allowedPaths must be an array/);
  assert.throws(() => writeMemoryFile(root, "src/blocked.md", "blocked\n"), /allowedPaths must be an array/);
  assert.throws(() => createMarkdownFile(root, { path: "src/blocked.md" }), /allowedPaths must be an array/);
  assert.throws(() => deleteMemoryPaths(root, ["src/blocked.md"]), /allowedPaths must be an array/);
  const invalidConfigDoctor = buildContextRoomDoctorReport(root);
  assert.equal(invalidConfigDoctor.settings.allowedPaths, 0);
  assert.ok(invalidConfigDoctor.issues.some((issue) => issue.type === "invalid_config" && issue.severity === "critical"));
  assert.equal(fs.existsSync(path.join(root, "src", "blocked.md")), false);

  const emptyConfigRoot = makeRoot();
  fs.mkdirSync(path.join(emptyConfigRoot, CONFIG_DIR), { recursive: true });
  fs.writeFileSync(path.join(emptyConfigRoot, CONFIG_FILE), "{}\n");
  assert.throws(() => readMemoryWebappSettings(emptyConfigRoot), /allowedPaths is required/);
  assert.ok(buildContextRoomDoctorReport(emptyConfigRoot).issues.some((issue) => issue.type === "invalid_config" && issue.severity === "critical"));

  const runtimeRoot = makeRoot();
  fs.mkdirSync(path.join(runtimeRoot, "src"), { recursive: true });
  initializeContextRoomProject(runtimeRoot, { allowedPaths: ["docs/"], watchAllow: [] });
  const { server } = createMemoryServer({ root: runtimeRoot });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  fs.writeFileSync(path.join(runtimeRoot, CONFIG_FILE), JSON.stringify({ allowedPaths: null }) + "\n");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "src/api-blocked.md", content: "blocked\n" }),
  });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: "Context Room could not complete this request.",
    code: "context_room_internal_error",
  });
  assert.equal(fs.existsSync(path.join(runtimeRoot, "src", "api-blocked.md")), false);

  const gateRoot = makeRoot();
  initializeContextRoomProject(gateRoot, { allowedPaths: [], watchAllow: [] });
  fs.writeFileSync(path.join(gateRoot, REVIEW_GATE_FILE), "{broken\n");
  assert.throws(() => readReviewGateSettings(gateRoot), /Invalid Context Room review gate JSON/);
  assert.throws(() => writeReviewGateSettings(gateRoot, { operations: "push" }), /operations must be an array/);
  const gateDoctor = buildContextRoomDoctorReport(gateRoot);
  assert.ok(gateDoctor.issues.some((issue) => issue.type === "invalid_review_gate" && issue.severity === "critical"));
});

test("existing config skips project discovery and preserves its configured scope", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Documentation\n");
  initializeContextRoomProject(root);
  const configPath = path.join(root, CONFIG_FILE);
  const before = fs.readFileSync(configPath);

  fs.mkdirSync(path.join(root, "src", "research"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "research", "late.md"), "# Added after setup\n");
  const repeated = initializeContextRoomProject(root);

  assert.equal(repeated.discoverySkipped, true);
  assert.deepEqual(repeated.documentationPaths, []);
  assert.deepEqual(fs.readFileSync(configPath), before);
  assert.equal(repeated.config.allowedPaths.includes("src/research/late.md"), false);
});

test("explicit setup scope filters inferred hub cards and rejects uncovered watch paths", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "README.md"), "# Project\n");
  fs.writeFileSync(path.join(root, "README_old.md"), "# Old readme\n");
  fs.writeFileSync(path.join(root, "plans.md"), "# Plans\n");
  fs.writeFileSync(path.join(root, "proposals.md"), "# Proposals\n");
  fs.writeFileSync(path.join(root, "roadmap.md"), "# Roadmap\n");
  fs.writeFileSync(path.join(root, "targets.md"), "# Targets\n");
  fs.writeFileSync(path.join(root, "target-audience.md"), "# Target audience\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Documentation\n");

  const initialized = initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const hubPaths = initialized.config.hubSections.flatMap((section) =>
    section.cards.flatMap((card) => [card.path, ...(card.paths || [])].filter(Boolean)),
  );

  assert.deepEqual(initialized.config.allowedPaths, ["docs/"]);
  assert.deepEqual(initialized.config.watchAllow, ["docs/"]);
  assert.ok(hubPaths.length > 0);
  assert.ok(hubPaths.every((relPath) => relPath.startsWith("docs/")));
  assert.equal(buildContextRoomDoctorReport(root).issues.some((issue) => issue.type === "hub_path_not_allowed"), false);

  const before = fs.readFileSync(path.join(root, CONFIG_FILE));
  assert.throws(
    () => initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["README.md"] }),
    /watchAllow path is not covered by allowedPaths: README\.md/,
  );
  assert.deepEqual(fs.readFileSync(path.join(root, CONFIG_FILE)), before);

  const freshRoot = makeRoot();
  fs.mkdirSync(path.join(freshRoot, "docs"), { recursive: true });
  fs.writeFileSync(path.join(freshRoot, "README.md"), "# Fresh\n");
  fs.writeFileSync(path.join(freshRoot, "docs", "index.md"), "# Documentation\n");
  assert.throws(
    () => initializeContextRoomProject(freshRoot, { allowedPaths: ["docs/"], watchAllow: ["README.md"] }),
    /watchAllow path is not covered by allowedPaths: README\.md/,
  );
  assert.equal(fs.existsSync(path.join(freshRoot, CONFIG_FILE)), false);
  assert.equal(fs.existsSync(path.join(freshRoot, AGENT_CONTEXT_FILE)), false);
});

test("documentation inference separates target and record truth without widening executable boundaries", () => {
  const root = makeRoot();
  for (const relPath of [
    "docs/target",
    "docs/research",
    "research",
    "incidents",
    "history",
    "spec",
    "spec/fixtures",
    "vendor/docs",
    "skills/doc-audit/references",
    "skills/doc-audit/scripts",
    "skills/doc-audit/target/doc",
    "src/research",
  ]) fs.mkdirSync(path.join(root, relPath), { recursive: true });

  fs.writeFileSync(path.join(root, "README.md"), "# Project\n");
  fs.writeFileSync(path.join(root, "README_old.md"), "# Old readme\n");
  fs.writeFileSync(path.join(root, "plans.md"), "# Plans\n");
  fs.writeFileSync(path.join(root, "proposals.md"), "# Proposals\n");
  fs.writeFileSync(path.join(root, "roadmap.md"), "# Roadmap\n");
  fs.writeFileSync(path.join(root, "targets.md"), "# Targets\n");
  fs.writeFileSync(path.join(root, "target-audience.md"), "# Target audience\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Documentation\n");
  fs.writeFileSync(path.join(root, "docs", "target", "index.md"), "# Target documentation\n");
  fs.writeFileSync(path.join(root, "docs", "research", "index.md"), "# Research\n");
  fs.writeFileSync(path.join(root, "research", "notes.md"), "# Notes\n");
  fs.writeFileSync(path.join(root, "incidents", "outage.md"), "# Outage\n");
  fs.writeFileSync(path.join(root, "history", "legacy.md"), "# Legacy\n");
  fs.writeFileSync(path.join(root, "docs", "decision-note.md"), `---
context_room:
  kind: decision
  status: historical
---

# Decision note
`);
  fs.writeFileSync(path.join(root, "docs", "invalid-status.md"), `---
context_room:
  kind: canonical
  status: implemented
---

# Invalid status
`);
  fs.writeFileSync(path.join(root, "docs", "missing-status.md"), `---
context_room:
  kind: canonical
---

# Missing status
`);
  fs.writeFileSync(path.join(root, "docs", "draft-guide.md"), `---
context_room:
  kind: procedure
  status: draft
---

# Draft guide
`);
  fs.writeFileSync(path.join(root, "docs", "implemented_target.md"), `---
context_room:
  kind: canonical
  status: current
  canonical_for: implemented-target
  last_verified: 2026-07-19
  sources: []
---

# Implemented target conflict
`);
  fs.writeFileSync(path.join(root, "docs", "research", "current-record.md"), `---
context_room:
  kind: canonical
  status: current
  canonical_for: current-record
  last_verified: 2026-07-19
  sources: []
---

# Current record conflict
`);
  fs.writeFileSync(path.join(root, "docs", "token-budget.md"), "# Sensitive token notes\n");
  fs.writeFileSync(path.join(root, "spec", "model_spec.rb"), "describe 'model' do\nend\n");
  fs.writeFileSync(path.join(root, "spec", "fixtures", "README.md"), "# Fixture documentation\n");
  fs.writeFileSync(path.join(root, "vendor", "docs", "index.md"), "# Vendored docs\n");
  fs.writeFileSync(path.join(root, "vendor", "AGENTS.md"), "# Vendored instructions\n");
  fs.writeFileSync(path.join(root, "skills", "doc-audit", "SKILL.md"), "# Documentation audit\n");
  fs.writeFileSync(path.join(root, "skills", "doc-audit", "references", "guide.md"), "# Skill guide\n");
  fs.writeFileSync(path.join(root, "skills", "doc-audit", "scripts", "run.js"), "export const run = true;\n");
  fs.writeFileSync(path.join(root, "skills", "doc-audit", "target", "doc", "generated.html"), "<h1>Generated</h1>\n");
  fs.writeFileSync(path.join(root, "src", "research", "notes.md"), "# Source research\n");
  fs.writeFileSync(path.join(root, "src", "research", "runner.js"), "export const run = true;\n");

  const inferred = inferProjectDocumentationSetup(root);
  initializeContextRoomProject(root);
  const doctor = buildContextRoomDoctorReport(root);
  const graph = buildDocumentationGraph(root);
  const section = (id) => inferred.hubSections.find((item) => item.id === id);
  const cardPaths = (id) => (section(id)?.cards || []).flatMap((card) => [card.path, ...(card.paths || [])].filter(Boolean));

  assert.deepEqual(inferred.documentationRoots, ["docs/", "history/", "incidents/", "research/"]);
  assert.ok(inferred.documentationFiles.includes("docs/target/index.md"));
  assert.ok(inferred.documentationFiles.includes("skills/doc-audit/SKILL.md"));
  assert.equal(inferred.documentationFiles.includes("vendor/docs/index.md"), false);
  assert.equal(inferred.agentInstructionPaths.includes("vendor/AGENTS.md"), false);
  assert.equal(inferred.documentationRoots.includes("spec/"), false);
  assert.equal(inferred.allowedPaths.includes("skills/"), false);
  assert.equal(inferred.watchAllow.includes("skills/"), false);
  assert.ok(inferred.allowedPaths.includes("skills/doc-audit/SKILL.md"));
  assert.ok(inferred.allowedPaths.includes("skills/doc-audit/references/guide.md"));
  assert.equal(inferred.allowedPaths.includes("skills/doc-audit/scripts/run.js"), false);
  assert.equal(inferred.documentationFiles.includes("skills/doc-audit/target/doc/generated.html"), false);
  assert.equal(inferred.allowedPaths.includes("skills/doc-audit/target/doc/generated.html"), false);
  assert.equal(inferred.documentationRoots.includes("src/research/"), false);
  assert.ok(inferred.exactDocumentationFiles.includes("src/research/notes.md"));
  assert.ok(inferred.allowedPaths.includes("src/research/notes.md"));
  assert.equal(inferred.allowedPaths.includes("src/research/"), false);
  assert.equal(inferred.allowedPaths.includes("src/research/runner.js"), false);
  assert.equal(inferred.documentationFiles.includes("docs/token-budget.md"), false);
  assert.ok(cardPaths("agent-guidance").includes("skills/doc-audit/SKILL.md"));
  assert.ok(cardPaths("agent-guidance").includes("skills/doc-audit/references/guide.md"));
  assert.equal(cardPaths("agent-guidance").includes("skills/"), false);
  assert.equal(doctor.issues.some((issue) => issue.type === "hub_path_not_allowed"), false);
  assert.ok(cardPaths("target-documentation").includes("docs/target/index.md"));
  for (const targetPath of ["plans.md", "proposals.md", "roadmap.md", "targets.md"]) {
    assert.ok(cardPaths("target-documentation").includes(targetPath), `expected target card for ${targetPath}`);
  }
  assert.ok(cardPaths("target-documentation").includes("docs/implemented_target.md"));
  assert.equal(cardPaths("target-documentation").includes("target-audience.md"), false);
  assert.equal(cardPaths("start-here").includes("docs/target/index.md"), false);
  assert.equal(cardPaths("start-here").includes("docs/research/index.md"), false);
  assert.equal(cardPaths("start-here").includes("README_old.md"), false);
  assert.ok(cardPaths("records").includes("docs/research/"));
  assert.ok(cardPaths("records").includes("research/"));
  assert.ok(cardPaths("records").includes("incidents/"));
  assert.ok(cardPaths("records").includes("history/"));
  assert.ok(section("records").cards.some((card) => card.path === "docs/decision-note.md" && !card.autoChildren));
  assert.ok(section("records").cards.some((card) => card.path === "src/research/notes.md" && !card.autoChildren));
  assert.equal(section("records").cards.some((card) => card.path === "src/research/"), false);
  assert.equal(section("records").cards.some((card) => card.path === "docs/"), false);
  assert.ok(cardPaths("documentation-to-classify").includes("docs/invalid-status.md"));
  assert.ok(cardPaths("documentation-to-classify").includes("docs/missing-status.md"));
  assert.ok(cardPaths("documentation-to-classify").includes("docs/draft-guide.md"));
  assert.ok(cardPaths("documentation-to-classify").includes("README_old.md"));
  assert.ok(cardPaths("documentation-to-classify").includes("target-audience.md"));
  assert.equal(cardPaths("target-documentation").includes("docs/draft-guide.md"), false);
  assert.equal(cardPaths("current-documentation").includes("docs/invalid-status.md"), false);
  const inferredCards = inferred.hubSections.flatMap((hubSection) => hubSection.cards);
  assert.ok(inferredCards.every((card) => card.path || card.paths?.length || card.cards?.length));
  assert.equal(inferredCards.some((card) => card.path === "docs/token-budget.md" || card.paths?.includes("docs/token-budget.md")), false);
  const targetNode = graph.nodes.find((node) => node.path === "docs/implemented_target.md");
  const recordNode = graph.nodes.find((node) => node.path === "docs/research/current-record.md");
  assert.equal(targetNode.metadata.status, "");
  assert.equal(targetNode.metadata.truthState, "target");
  assert.equal(recordNode.metadata.status, "");
  assert.equal(recordNode.metadata.truthState, "record");
  assert.ok(graph.healthIssues.some((issue) => issue.type === "target_status_conflict" && issue.path === targetNode.path));
  assert.ok(graph.healthIssues.some((issue) => issue.type === "record_status_conflict" && issue.path === recordNode.path));
  const truthBrief = buildAgentBrief(root, { task: "implemented target current record", limit: 20 });
  assert.match(truthBrief, /docs\/implemented_target\.md \(canonical, target,/);
  assert.match(truthBrief, /docs\/research\/current-record\.md \(canonical, record,/);
  assert.doesNotMatch(truthBrief, /(?:implemented_target|current-record)\.md \(canonical, current,/);
});

test("fresh project-only startup context includes discovered nested and Hermes instructions", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "team"), { recursive: true });
  fs.writeFileSync(path.join(root, ".hermes.md"), "# Hermes instructions\n");
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Documentation\n");
  fs.writeFileSync(path.join(root, "docs", "team", "AGENTS.md"), "# Team instructions\n");
  fs.writeFileSync(path.join(root, "docs", "team", "CLAUDE.md"), "# Claude instructions\n");

  const initialized = initializeContextRoomProject(root);
  const startupFiles = listStartupContextFiles(root, initialized.config);
  const startupPaths = startupFiles.map((file) => file.startupContext.explorerPath);

  assert.equal(initialized.config.startupContext.projectOnly, true);
  assert.ok(initialized.config.startupContext.fileNames.includes(".hermes.md"));
  assert.ok(startupPaths.includes(".hermes.md"));
  assert.ok(startupPaths.includes("docs/team/AGENTS.md"));
  assert.ok(startupPaths.includes("docs/team/CLAUDE.md"));
  assert.ok(startupFiles.every((file) => file.startupContext.source === "project"));
});

test("startup scanners reject symlink escapes in project-only and compatibility modes", () => {
  const root = makeRoot();
  const external = makeRoot();
  fs.mkdirSync(path.join(external, "linked-skills", "external-skill"), { recursive: true });
  fs.writeFileSync(path.join(external, "AGENTS.md"), "# External agents\n");
  fs.writeFileSync(path.join(external, "linked-skills", "external-skill", "SKILL.md"), "# External skill\n");
  fs.writeFileSync(path.join(external, "external-skill.md"), "# Escaped skill\n");
  fs.writeFileSync(path.join(external, "hooks.json"), "{\"hooks\":{}}\n");
  fs.writeFileSync(path.join(external, "escape.sh"), "#!/bin/sh\nexit 0\n");
  fs.writeFileSync(path.join(external, "pre-commit"), "#!/bin/sh\nexit 0\n");

  fs.mkdirSync(path.join(root, "skills", "escaped"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
  fs.symlinkSync(path.join(external, "AGENTS.md"), path.join(root, "AGENTS.md"));
  fs.symlinkSync(path.join(external, "linked-skills"), path.join(root, "linked-skills"), "dir");
  fs.symlinkSync(path.join(external, "external-skill.md"), path.join(root, "skills", "escaped", "SKILL.md"));
  fs.symlinkSync(path.join(external, "hooks.json"), path.join(root, ".codex", "external.json"));
  fs.symlinkSync(path.join(external, "escape.sh"), path.join(root, ".codex", "escape.sh"));
  fs.symlinkSync(path.join(external, "pre-commit"), path.join(root, ".husky", "pre-commit"));
  fs.writeFileSync(path.join(root, ".codex", "hooks.json"), JSON.stringify({
    hooks: { Before: [{ hooks: [{ type: "command", command: ".codex/escape.sh" }] }] },
  }));

  const projectOnly = createDefaultProjectConfig();
  projectOnly.startupContext = { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] };
  projectOnly.startupSkills = { enabled: true, projectOnly: true, folderNames: ["skills", "linked-skills"] };
  projectOnly.startupHooks = {
    ...projectOnly.startupHooks,
    enabled: true,
    editable: true,
    projectOnly: true,
    agentHooks: true,
    gitHooks: false,
    hookManagers: true,
    fileNames: ["pre-commit"],
    agentHookSources: [{ id: "codex", label: "Codex", paths: [".codex/hooks.json", ".codex/external.json"] }],
    managerPaths: [".husky/"],
  };

  assert.deepEqual(listStartupContextFiles(root, projectOnly), []);
  const projectSkills = listStartupSkillFolders(root, projectOnly);
  assert.equal(projectSkills.some((folder) => folder.displayPath.includes("linked-skills")), false);
  assert.equal(projectSkills.flatMap((folder) => folder.skills).includes("escaped"), false);
  const projectHooks = listStartupHookFiles(root, projectOnly);
  assert.deepEqual(projectHooks.map((file) => file.startupHook.fileName), ["hooks.json"]);
  assert.ok(projectHooks.every((file) => fs.realpathSync(file.startupHook.absolutePath).startsWith(fs.realpathSync(root) + path.sep)));
  const inferred = inferProjectDocumentationSetup(root);
  assert.equal(inferred.allowedPaths.some((relPath) => relPath.startsWith("skills/escaped") || relPath.startsWith("linked-skills")), false);

  const compatibility = structuredClone(projectOnly);
  compatibility.startupContext.projectOnly = false;
  compatibility.startupSkills.projectOnly = false;
  assert.equal(listStartupContextFiles(root, compatibility).some((file) => file.startupContext.absolutePath === path.join(root, "AGENTS.md")), false);
  assert.equal(listStartupSkillFolders(root, compatibility).some((folder) => folder.displayPath.includes("linked-skills")), false);
});

test("explicitly empty startup scanner lists stay empty after save and reload", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "# Demo\n");
  fs.writeFileSync(path.join(root, ".codex", "hooks.json"), '{"hooks":{}}\n');
  fs.writeFileSync(path.join(root, ".husky", "pre-commit"), "#!/bin/sh\nexit 0\n");
  initializeContextRoomProject(root);

  const next = readMemoryWebappSettings(root);
  next.startupContext = { enabled: true, projectOnly: true, fileNames: [], globalPaths: [] };
  next.startupSkills = { enabled: true, projectOnly: true, folderNames: [] };
  next.startupHooks = {
    enabled: true,
    editable: false,
    projectOnly: true,
    agentHooks: true,
    codexHooks: true,
    gitHooks: false,
    hookManagers: true,
    fileNames: [],
    agentHookSources: [],
    agentHookPaths: [],
    codexPaths: [],
    managerPaths: [],
  };
  writeMemoryWebappSettings(root, next);

  const saved = readMemoryWebappSettings(root);
  assert.deepEqual(saved.startupContext.fileNames, []);
  assert.deepEqual(saved.startupContext.globalPaths, []);
  assert.deepEqual(saved.startupSkills.folderNames, []);
  assert.deepEqual(saved.startupHooks.fileNames, []);
  assert.deepEqual(saved.startupHooks.agentHookSources, []);
  assert.deepEqual(saved.startupHooks.agentHookPaths, []);
  assert.deepEqual(saved.startupHooks.codexPaths, []);
  assert.deepEqual(saved.startupHooks.managerPaths, []);
  assert.deepEqual(listStartupContextFiles(root), []);
  assert.deepEqual(listStartupSkillFolders(root), []);
  assert.deepEqual(listStartupHookFiles(root), []);
});

test("project-only startup skill resolution ignores an external symlink collision", () => {
  const root = makeRoot();
  const external = makeRoot();
  fs.mkdirSync(path.join(root, "skills"), { recursive: true });
  fs.mkdirSync(path.join(external, "foo"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "foo.md"), "# Local loose skill\n");
  fs.writeFileSync(path.join(external, "foo", "SKILL.md"), "# External collision\n");
  fs.symlinkSync(path.join(external, "foo"), path.join(root, "skills", "foo"), "dir");
  const settings = createDefaultProjectConfig();
  settings.startupSkills = { enabled: true, projectOnly: true, folderNames: ["skills"] };

  const folders = listStartupSkillFolders(root, settings);
  assert.deepEqual(folders.flatMap((folder) => folder.skills), ["foo"]);
  const skill = readStartupSkillFile(root, folders[0].order, "foo", settings);
  assert.equal(skill.content, "# Local loose skill\n");
  writeStartupSkillFile(root, folders[0].order, "foo", "# Updated local skill\n", settings);
  assert.equal(fs.readFileSync(path.join(root, "skills", "foo.md"), "utf8"), "# Updated local skill\n");
  assert.equal(fs.readFileSync(path.join(external, "foo", "SKILL.md"), "utf8"), "# External collision\n");
});

test("generated agent guide includes repository setup instructions and the canonical configuration guide", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "index.md"), "# Docs\n");

  const initialized = initializeContextRoomProject(root);
  const guide = fs.readFileSync(initialized.agentContextPath, "utf8");
  const copiedConfiguration = path.join(root, AGENT_CONTEXT_DIR, "agent-configuration.md");
  const canonicalConfiguration = fs.readFileSync(new URL("../docs/agent-configuration.md", import.meta.url));

  assert.match(guide, /## Set Up This Repository/);
  assert.match(guide, /`context-room setup`, `context-room init`, and `context-room start`/);
  assert.match(guide, /Read the root README, every applicable `AGENTS\.md`/);
  assert.match(guide, /Do not copy paths or state from another Context Room/);
  assert.match(guide, /second separate, unambiguous yes/i);
  assert.equal(fs.existsSync(copiedConfiguration), true);
  assert.deepEqual(fs.readFileSync(copiedConfiguration), canonicalConfiguration);

  for (const generatedPath of initialized.agentContextPath
    ? [initialized.agentContextPath, ...fs.readdirSync(path.join(root, AGENT_CONTEXT_DIR))
      .filter((fileName) => /[.]md$/i.test(fileName))
      .map((fileName) => path.join(root, AGENT_CONTEXT_DIR, fileName))]
    : []) {
    const content = fs.readFileSync(generatedPath, "utf8");
    for (const match of content.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
      const href = match[1].trim().replace(/^<|>$/g, "").split("#")[0];
      if (!href || /^(?:[a-z]+:|\/)/i.test(href)) continue;
      assert.equal(fs.existsSync(path.resolve(path.dirname(generatedPath), href)), true, `${generatedPath} has broken link ${href}`);
    }
  }
});

test("available port selection skips an occupied room while strict selection rejects it", async (t) => {
  const occupied = net.createServer();
  await new Promise((resolve, reject) => {
    occupied.once("error", reject);
    occupied.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => occupied.close(resolve)));
  const occupiedPort = occupied.address().port;

  const selected = await selectAvailableContextRoomPort(occupiedPort, { maxAttempts: 20 });

  assert.ok(selected > occupiedPort);
  await assert.rejects(
    selectAvailableContextRoomPort(occupiedPort, { allowFallback: false }),
    new RegExp(`port ${occupiedPort} is already in use`, "i"),
  );
});

test("agent HTML context uses a stable project path and refreshes generated copies", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const entryPath = path.join(root, AGENT_CONTEXT_FILE);
  const legacyEntryPath = path.join(root, AGENT_CONTEXT_DIR, "README.md");
  const patternsPath = path.join(root, AGENT_CONTEXT_DIR, "html-visual-patterns.md");
  const canonicalPatterns = fs.readFileSync(new URL("../docs/features/html-visual-patterns.md", import.meta.url), "utf8");
  const relocatedPatterns = canonicalPatterns.replaceAll("../context-room-", "context-room-");

  const entry = fs.readFileSync(entryPath, "utf8");
  assert.match(entry, /generated by Context Room/i);
  assert.match(entry, /## Workflow/);
  assert.match(entry, /## Choose The Visual/);
  assert.match(entry, /## Build The Document/);
  assert.match(entry, /## Interaction/);
  assert.match(entry, /## Theme Contract/);
  assert.match(entry, /automatically follows the active Context Room app theme/);
  assert.match(entry, /--cr-bg/);
  assert.match(entry, /Do not hard-code a page palette/);
  assert.match(entry, /## Where To Find HTML Examples/);
  assert.match(entry, /\.context-room\/agent-context\/context-room-visual-components\.html/);
  assert.match(entry, /\.context-room\/agent-context\/context-room-data-visual-components\.html/);
  assert.match(entry, /## Quality Gate/);
  assert.match(entry, /\[HTML visual patterns\]\(agent-context\/html-visual-patterns\.md\)/);
  assert.match(fs.readFileSync(legacyEntryPath, "utf8"), /\.context-room\/README\.md/);
  assert.equal(fs.readFileSync(patternsPath, "utf8"), relocatedPatterns);

  fs.writeFileSync(patternsPath, "stale generated copy\n", "utf8");
  const refreshed = syncContextRoomAgentContext(root);

  assert.equal(refreshed.entryPath, entryPath);
  assert.equal(refreshed.updated, 1);
  assert.equal(fs.readFileSync(patternsPath, "utf8"), relocatedPatterns);
  for (const generatedPath of refreshed.files.filter((filePath) => filePath.endsWith(".md"))) {
    const content = fs.readFileSync(generatedPath, "utf8");
    for (const match of content.matchAll(/\]\(([^)]+)\)/g)) {
      const destination = match[1];
      if (/^(?:https?:|mailto:|#)/.test(destination)) continue;
      const localDestination = destination.split("#", 1)[0];
      assert.equal(
        fs.existsSync(path.resolve(path.dirname(generatedPath), localDestination)),
        true,
        `${path.relative(root, generatedPath)} has a broken generated link to ${destination}`,
      );
    }
  }
  const promptGuide = fs.readFileSync(
    path.join(root, AGENT_CONTEXT_DIR, "features", "codex-prompt-center.md"),
    "utf8",
  );
  assert.match(promptGuide, /https:\/\/unpkg\.com\/context-room@latest\/schemas\/codex-prompt-catalog-v1\.schema\.json/);
  assert.match(promptGuide, /https:\/\/unpkg\.com\/context-room@latest\/docs\/features\/context-hub\.md/);
});

test("allowed paths are driven by project config", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/", "README.md"], watchAllow: ["docs/"] });
  const settings = readMemoryWebappSettings(root);

  assert.equal(isAllowedMemoryPath("docs/guide.md", settings), true);
  assert.equal(isAllowedMemoryPath("README.md", settings), true);
  assert.equal(isAllowedMemoryPath("src/private.js", settings), false);
  assert.equal(isAllowedMemoryPath("../secret.md", settings), false);
});

test("Context Hub creates and registers a new documentation-ready project inside Computer Explorer", async (t) => {
  const computerRoot = makeRoot();
  const parent = path.join(computerRoot, "projects");
  fs.mkdirSync(parent);

  const created = createContextHubProject({
    computerRoot,
    parent,
    folderName: "atlas",
    title: "Atlas",
  });

  assert.equal(created.projectRoot, fs.realpathSync(path.join(parent, "atlas")));
  assert.equal(created.registered.title, "Atlas");
  assert.equal(fs.statSync(path.join(created.projectRoot, "docs")).isDirectory(), true);
  const settings = readMemoryWebappSettings(created.projectRoot);
  assert.deepEqual(settings.allowedPaths, ["docs/"]);
  assert.deepEqual(settings.watchAllow, ["docs/"]);
  assert.throws(() => createContextHubProject({ computerRoot, parent, folderName: "atlas", title: "Atlas" }), /already exists/);
  assert.throws(() => createContextHubProject({ computerRoot, parent: path.dirname(computerRoot), folderName: "escape", title: "Escape" }), /inside the configured Computer Explorer root/);

  const hostRoot = makeRoot();
  const preferencesPath = path.join(makeRoot(), "preferences.json");
  initializeContextRoomProject(hostRoot, { allowedPaths: [], watchAllow: [] });
  writeGlobalContextRoomPreferences({ explorer: { computerRoot } }, preferencesPath);
  const { server } = createMemoryServer({ root: hostRoot, globalPreferencesPath: preferencesPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/context-hub/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ parent, folderName: "beacon", title: "Beacon" }),
  });
  const apiCreated = await response.json();
  assert.equal(response.status, 201, JSON.stringify(apiCreated));
  assert.equal(apiCreated.projectRoot, fs.realpathSync(path.join(parent, "beacon")));
  assert.equal(apiCreated.catalog.projects.some((project) => (
    project.root === apiCreated.projectRoot
    || (project.worktrees || []).some((worktree) => worktree.root === apiCreated.projectRoot)
  )), true, JSON.stringify(apiCreated.catalog.projects));
});

test("appearance, sound, and shortcut preferences are shared across Context Rooms and stay out of project config", async (t) => {
  const firstRoot = makeRoot();
  const secondRoot = makeRoot();
  const preferencesPath = path.join(makeRoot(), "preferences.json");
  initializeContextRoomProject(firstRoot, { allowedPaths: ["docs/"] });
  initializeContextRoomProject(secondRoot, { allowedPaths: ["docs/"] });

  assert.equal(GLOBAL_PREFERENCES_FILE, "~/.context-room/preferences.json");
  assert.equal(readGlobalContextRoomPreferences(preferencesPath).appearance.colorMode, "system");
  assert.equal(readGlobalContextRoomPreferences(preferencesPath).appearance.autoOpenGitDiff, true);
  assert.equal(readGlobalContextRoomPreferences(preferencesPath).appearance.showHiddenFiles, true);
  assert.equal(readGlobalContextRoomPreferences(preferencesPath).shortcuts.codexReference, DEFAULT_CODEX_REFERENCE_SHORTCUT);
  assert.deepEqual(readGlobalContextRoomPreferences(preferencesPath).sounds, { enabled: true, volume: 0.35 });
  assert.equal(readGlobalContextRoomPreferences(preferencesPath).explorer.computerRoot, os.homedir());
  writeGlobalContextRoomPreferences({
    appearance: { fileTheme: "dracula", colorMode: "dark", autoOpenGitDiff: false, showHiddenFiles: false },
    shortcuts: { codexReference: "Mod+Alt+K" },
    sounds: { enabled: false, volume: 0.6 },
    explorer: { computerRoot: firstRoot },
  }, preferencesPath);
  assert.deepEqual(readResolvedContextRoomSettings(firstRoot, { preferencesPath }).appearance, { fileTheme: "dracula", colorMode: "dark", autoOpenGitDiff: false, showHiddenFiles: false });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).appearance, { fileTheme: "dracula", colorMode: "dark", autoOpenGitDiff: false, showHiddenFiles: false });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).shortcuts, { codexReference: "Mod+Alt+K" });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).sounds, { enabled: false, volume: 0.6 });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).explorer, { computerRoot: firstRoot });

  const { server, ownerMutationNonce } = createMemoryServer({ root: firstRoot, globalPreferencesPath: preferencesPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ settings: { ...readMemoryWebappSettings(firstRoot), appearance: { fileTheme: "github-dark", colorMode: "light", autoOpenGitDiff: false, showHiddenFiles: true }, shortcuts: { codexReference: "Mod+Shift+R" }, sounds: { enabled: true, volume: 0.2 }, explorer: { computerRoot: secondRoot } } }),
  });
  const payload = await response.json();
  const savedProject = JSON.parse(fs.readFileSync(path.join(firstRoot, CONFIG_FILE), "utf8"));

  assert.equal(response.status, 200);
  assert.deepEqual(payload.settings.appearance, { fileTheme: "github-dark", colorMode: "light", autoOpenGitDiff: false, showHiddenFiles: true });
  assert.deepEqual(payload.settings.shortcuts, { codexReference: "Mod+Shift+R" });
  assert.deepEqual(payload.settings.sounds, { enabled: true, volume: 0.2 });
  assert.deepEqual(payload.settings.explorer, { computerRoot: secondRoot });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).appearance, { fileTheme: "github-dark", colorMode: "light", autoOpenGitDiff: false, showHiddenFiles: true });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).shortcuts, { codexReference: "Mod+Shift+R" });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).sounds, { enabled: true, volume: 0.2 });
  assert.deepEqual(readResolvedContextRoomSettings(secondRoot, { preferencesPath }).explorer, { computerRoot: secondRoot });
  assert.equal("appearance" in savedProject, false);
  assert.equal("shortcuts" in savedProject, false);
  assert.equal("sounds" in savedProject, false);
  assert.equal("explorer" in savedProject, false);
  assert.equal(normalizeKeyboardShortcut("Command + shift + l"), "Mod+Shift+L");
  assert.equal(normalizeKeyboardShortcut(""), "");
  assert.equal(normalizeKeyboardShortcut("L"), DEFAULT_CODEX_REFERENCE_SHORTCUT);
});

test("sound preferences migrate legacy files and clamp volume safely", () => {
  const preferencesPath = path.join(makeRoot(), "preferences.json");
  fs.writeFileSync(preferencesPath, JSON.stringify({
    appearance: { fileTheme: "context-room" },
    shortcuts: { codexReference: "Mod+Shift+L" },
  }));
  assert.deepEqual(readGlobalContextRoomPreferences(preferencesPath).sounds, { enabled: true, volume: 0.35 });
  assert.deepEqual(writeGlobalContextRoomPreferences({ sounds: { enabled: false, volume: 4 } }, preferencesPath).sounds, { enabled: false, volume: 1 });
  assert.deepEqual(writeGlobalContextRoomPreferences({ sounds: { volume: -2 } }, preferencesPath).sounds, { enabled: false, volume: 0 });
  assert.deepEqual(writeGlobalContextRoomPreferences({ sounds: { volume: "not-a-number" } }, preferencesPath).sounds, { enabled: false, volume: 0.35 });
});

test("Computer Explorer browses one configured root lazily and cannot escape it", async (t) => {
  const root = makeRoot();
  const computerRoot = makeRoot();
  const preferencesPath = path.join(makeRoot(), "preferences.json");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  fs.mkdirSync(path.join(computerRoot, "Project A"));
  fs.writeFileSync(path.join(computerRoot, "notes.txt"), "hello\n");
  fs.writeFileSync(path.join(computerRoot, ".hidden.txt"), "hidden\n");
  writeGlobalContextRoomPreferences({
    appearance: { showHiddenFiles: false },
    explorer: { computerRoot },
  }, preferencesPath);
  const { server } = createMemoryServer({ root, globalPreferencesPath: preferencesPath });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${base}/api/context-hub/computer-explorer`);
  const payload = await response.json();
  assert.equal(response.status, 200);
  assert.equal(payload.root, computerRoot);
  assert.deepEqual(payload.entries.map((entry) => [entry.name, entry.kind]), [["Project A", "directory"], ["notes.txt", "file"]]);

  const childResponse = await fetch(`${base}/api/context-hub/computer-explorer?path=${encodeURIComponent(path.join(computerRoot, "Project A"))}`);
  const childPayload = await childResponse.json();
  assert.equal(childResponse.status, 200);
  assert.equal(childPayload.parent, computerRoot);

  const outsideResponse = await fetch(`${base}/api/context-hub/computer-explorer?path=${encodeURIComponent(path.dirname(computerRoot))}`);
  assert.equal(outsideResponse.status, 403);
});

test("review gates are owner-local, sanitized, and separate from project config", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  assert.deepEqual(readReviewGateSettings(root), { operations: [] });
  const saved = writeReviewGateSettings(root, { operations: ["push", "merge", "push", "unknown"] });
  const projectConfig = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));
  const mode = fs.statSync(path.join(root, REVIEW_GATE_FILE)).mode & 0o777;

  assert.deepEqual(saved, { operations: ["push", "merge"] });
  assert.deepEqual(readReviewGateSettings(root), saved);
  assert.equal("reviewGate" in projectConfig, false);
  assert.equal(mode, 0o600);
});

test("managed config and review-gate writes publish atomic single-link replacements", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { title: "Atomic before", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const gatePath = path.join(root, REVIEW_GATE_FILE);
  const beforeConfig = fs.lstatSync(configPath, { bigint: true });
  const beforeGate = fs.lstatSync(gatePath, { bigint: true });

  writeMemoryWebappSettings(root, { ...readMemoryWebappSettings(root), title: "Atomic after" });
  writeReviewGateSettings(root, { operations: ["push"] });

  const afterConfig = fs.lstatSync(configPath, { bigint: true });
  const afterGate = fs.lstatSync(gatePath, { bigint: true });
  assert.notEqual(afterConfig.ino, beforeConfig.ino);
  assert.notEqual(afterGate.ino, beforeGate.ino);
  assert.equal(afterConfig.nlink, 1n);
  assert.equal(afterGate.nlink, 1n);
  assert.equal(Number(afterGate.mode & 0o777n), 0o600);
  assert.equal(fs.readdirSync(path.join(root, CONFIG_DIR)).some((name) => name.startsWith(".context-room-control-")), false);
});

test("settings API cannot change the owner review gate through project settings", async (t) => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  writeReviewGateSettings(root, { operations: ["push"] });
  const { server, ownerMutationNonce } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const projectResponse = await fetch(`${base}/api/settings`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ settings: { ...readMemoryWebappSettings(root), reviewGate: { operations: ["commit"] } } }),
  });
  const projectPayload = await projectResponse.json();
  const ownerResponse = await fetch(`${base}/api/review-gate`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ reviewGate: { operations: ["merge", "pull-request"] } }),
  });
  const ownerPayload = await ownerResponse.json();

  assert.equal(projectResponse.status, 200);
  assert.deepEqual(projectPayload.settings.reviewGate.operations, ["push"]);
  assert.equal(ownerResponse.status, 200);
  assert.deepEqual(ownerPayload.reviewGate.operations, ["merge", "pull-request"]);
  assert.deepEqual(readReviewGateSettings(root).operations, ["merge", "pull-request"]);
});

test("a running local server rejects project-root replacement between settings resolution and publication", async () => {
  for (const fixture of [
    {
      fileName: "config.json",
      endpoint: "/api/settings",
      body: (settings) => ({ settings: { ...settings, title: "Must not reach replacement root" } }),
    },
    {
      fileName: "review-gate.json",
      endpoint: "/api/review-gate",
      body: () => ({ reviewGate: { operations: ["merge"] } }),
    },
  ]) {
    const targetRoot = makeRoot();
    const replacementRoot = makeRoot();
    initializeContextRoomProject(targetRoot, { title: "Pinned target", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
    initializeContextRoomProject(replacementRoot, { title: "Replacement", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
    const settings = readMemoryWebappSettings(targetRoot);
    const canonicalTarget = fs.realpathSync(targetRoot);
    const canonicalReplacement = fs.realpathSync(replacementRoot);
    const retiredRoot = `${canonicalTarget}-retired`;
    const replacementControl = path.join(canonicalReplacement, ".context-room", fixture.fileName);
    const replacementBytes = fs.readFileSync(replacementControl);
    let swapped = false;
    const room = createMemoryServer({
      root: targetRoot,
      beforeManagedControlMutation: ({ path: controlPath }) => {
        if (swapped || controlPath !== `.context-room/${fixture.fileName}`) return;
        swapped = true;
        fs.renameSync(canonicalTarget, retiredRoot);
        fs.renameSync(canonicalReplacement, canonicalTarget);
      },
    });
    await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
    try {
      const response = await fetch(`http://127.0.0.1:${room.server.address().port}${fixture.endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-context-room-project": room.projectId,
          "x-context-room-owner-nonce": room.ownerMutationNonce,
        },
        body: JSON.stringify(fixture.body(settings)),
      });
      assert.equal(swapped, true);
      assert.equal(response.status, 409, await response.text());
      assert.deepEqual(fs.readFileSync(path.join(canonicalTarget, ".context-room", fixture.fileName)), replacementBytes);
    } finally {
      await new Promise((resolve) => room.server.close(resolve));
    }
  }
});

test("file listing follows project config and does not inject Hermes/LifeOS files by default", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(root, "src/app.js"), "console.log('private');\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const paths = listMemoryFiles(root).map((file) => file.path);

  assert.deepEqual(paths, ["docs/guide.md"]);
  assert.equal(paths.some((item) => item.includes("~/.hermes")), false);
  assert.equal(paths.some((item) => item.includes(".lifeos")), false);
});

test("document snapshots can reuse file content without adding it to normal listing payloads", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\nAccepted context.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const regular = listMemoryFiles(root).find((file) => file.path === "docs/guide.md");
  const snapshot = listMemoryFiles(root, { includeContent: true }).find((file) => file.path === "docs/guide.md");

  assert.equal(Object.hasOwn(regular, "content"), false);
  assert.equal(snapshot.content, "# Guide\n\nAccepted context.\n");
});

test("HTML documents are listed as visual documents", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "map.html"), "<!doctype html><html><body><h1>Map</h1></body></html>\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const file = listMemoryFiles(root).find((item) => item.path === "docs/map.html");

  assert.equal(file?.kind, "html");
  assert.equal(file?.exists, true);
});

test("Explorer lists image assets and diagram sources without treating binary files as editable text", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8Y6WQAAAABJRU5ErkJggg==", "base64");
  fs.writeFileSync(path.join(root, "docs", "process.png"), png);
  fs.writeFileSync(path.join(root, "docs", "architecture.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><path d="M0 0h10v10H0z"/></svg>');
  fs.writeFileSync(path.join(root, "docs", "flow.mmd"), "flowchart LR\n  A --> B\n");
  fs.writeFileSync(path.join(root, "docs", "system.drawio"), "<mxfile><diagram>project</diagram></mxfile>\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const allowed = listMemoryFiles(root);
  const explorer = listExplorerFiles(root);
  const pngEntry = explorer.find((file) => file.path === "docs/process.png");
  const svgEntry = explorer.find((file) => file.path === "docs/architecture.svg");
  const mermaidEntry = explorer.find((file) => file.path === "docs/flow.mmd");
  const drawioEntry = explorer.find((file) => file.path === "docs/system.drawio");
  const openedPng = readMemoryFile(root, "docs/process.png");
  const openedSvg = readMemoryFile(root, "docs/architecture.svg");

  assert.equal(allowed.some((file) => file.path === "docs/process.png"), false);
  assert.equal(allowed.some((file) => file.path === "docs/architecture.svg"), false);
  assert.equal(pngEntry?.kind, "image");
  assert.equal(svgEntry?.kind, "diagram");
  assert.equal(pngEntry?.readOnly, true);
  assert.equal(svgEntry?.readOnly, true);
  assert.equal(mermaidEntry?.kind, "diagram-source");
  assert.equal(drawioEntry?.kind, "diagram-source");
  assert.equal(openedPng.mimeType, "image/png");
  assert.equal(openedPng.dataUrl, "data:image/png;base64," + png.toString("base64"));
  assert.equal(openedPng.readOnly, true);
  assert.equal(openedSvg.mimeType, "image/svg+xml");
  assert.match(openedSvg.dataUrl, /^data:image\/svg\+xml;base64,/);
  assert.match(readMemoryFile(root, "docs/flow.mmd").content, /flowchart LR/);
});

test("explorer listing can show project files outside watched docs as read-only", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  fs.writeFileSync(path.join(root, "src", "app.ts"), "export const app = true;\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "hidden.ts"), "export const hidden = true;\n");
  fs.writeFileSync(path.join(root, ".env.example"), "TOKEN=example\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const files = listExplorerFiles(root);
  const guide = files.find((file) => file.path === "docs/guide.md");
  const code = files.find((file) => file.path === "src/app.ts");

  assert.equal(guide?.readOnly, false);
  assert.equal(code?.readOnly, true);
  assert.equal(files.some((file) => file.path === "node_modules/pkg/hidden.ts"), false);
  assert.equal(files.some((file) => file.path === ".env.example"), true);
});

test("explorer shows safe hidden files by default and can hide them globally", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, ".git"));
  fs.mkdirSync(path.join(root, "node_modules", "pkg"), { recursive: true });
  fs.mkdirSync(path.join(root, ".hidden-folder"));
  fs.writeFileSync(path.join(root, ".gitignore"), "dist/\n");
  fs.writeFileSync(path.join(root, ".hidden-folder", "notes.md"), "# Hidden notes\n");
  fs.writeFileSync(path.join(root, ".git", "config"), "[core]\n");
  fs.writeFileSync(path.join(root, "node_modules", "pkg", "index.js"), "export {};\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const shown = listExplorerFiles(root);
  const hidden = listExplorerFiles(root, { showHiddenFiles: false });

  assert.ok(shown.some((file) => file.path === ".gitignore"));
  assert.ok(shown.some((file) => file.path === ".hidden-folder/notes.md"));
  assert.ok(shown.some((file) => file.path === ".context-room/config.json" && file.readOnly));
  assert.ok(shown.some((file) => file.path === ".context-room/README.md" && file.readOnly));
  assert.equal(shown.some((file) => file.path.startsWith(".git/")), false);
  assert.equal(shown.some((file) => file.path.startsWith("node_modules/")), false);
  assert.equal(hidden.some((file) => file.path.split("/").some((part) => part.startsWith("."))), false);
});

test("explorer lists env files as redacted sensitive files without exposing values", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, ".env"), "DATABASE_URL=postgres://secret\nexport API_TOKEN=super-secret-token\n# ignored\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const files = listExplorerFiles(root);
  const env = files.find((file) => file.path === ".env");
  const read = readMemoryFile(root, ".env");

  assert.equal(env?.readOnly, true);
  assert.equal(env?.sensitive, true);
  assert.equal(env?.redacted, true);
  assert.equal(read.readOnly, true);
  assert.equal(read.sensitive, true);
  assert.equal(read.redacted, true);
  assert.match(read.content, /DATABASE_URL/);
  assert.match(read.content, /API_TOKEN/);
  assert.doesNotMatch(read.content, /postgres:\/\/secret/);
  assert.doesNotMatch(read.content, /super-secret-token/);
});

test("startup context scanner lists configured agent files from ancestors to root", () => {
  const base = makeRoot();
  const parent = path.join(base, "parent");
  const root = path.join(parent, "project");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(base, "AGENTS.md"), "# Global Agents\n");
  fs.writeFileSync(path.join(parent, "CLAUDE.md"), "# Parent Claude\n");
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project Agents\n");
  initializeContextRoomProject(root, {
    allowedPaths: ["docs/"],
    watchAllow: [],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupContext = { enabled: true, fileNames: ["AGENTS.md", "CLAUDE.md"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const files = listStartupContextFiles(root);
  const memoryFiles = listMemoryFiles(root);
  const opened = readStartupContextFile(root, 2);
  const written = writeStartupContextFile(root, 2, "# Updated Claude\n");
  const rewritten = readStartupContextFile(root, 2);
  const deleted = deleteStartupContextFile(root, 2);

  assert.deepEqual(files.map((file) => file.startupContext.fileName), ["AGENTS.md", "CLAUDE.md", "AGENTS.md"]);
  assert.deepEqual(files.map((file) => file.startupContext.order), [1, 2, 3]);
  assert.equal(files[0].category, "0 · startup context");
  assert.match(files[0].startupContext.displayPath, /AGENTS\.md$/);
  assert.equal(files[0].startupContext.kind, "startup-context");
  assert.equal(files[2].startupContext.explorerPath, "AGENTS.md");
  assert.equal(memoryFiles.some((file) => file.startupContext), false);
  assert.equal(opened.content, "# Parent Claude\n");
  assert.equal(opened.startupContext.fileName, "CLAUDE.md");
  assert.equal(opened.startupContext.explorerPath, opened.startupContext.displayPath);
  assert.equal(written.contentHash, rewritten.contentHash);
  assert.equal(deleted.deleted, true);
  assert.equal(deleted.path, opened.startupContext.displayPath);
  assert.equal(fs.existsSync(path.join(parent, "CLAUDE.md")), false);
  assert.ok(fs.existsSync(path.join(root, deleted.backupPath)));
  assert.equal(fs.readFileSync(path.join(root, deleted.backupPath), "utf8"), "# Updated Claude\n");
});

test("startup context scanner includes explicit global agent instruction paths", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    const root = path.join(home, "work", "project");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "AGENTS.md"), "# Codex Agents\n");
    fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project Agents\n");
    initializeContextRoomProject(root, {
      allowedPaths: ["docs/"],
      watchAllow: [],
    });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext = {
      enabled: true,
      fileNames: ["AGENTS.md"],
      globalPaths: ["~/.codex/AGENTS.md"],
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const files = listStartupContextFiles(root);
    const opened = readStartupContextFile(root, 1);

    assert.deepEqual(files.map((file) => file.startupContext.displayPath), ["~/.codex/AGENTS.md", "~/work/project/AGENTS.md"]);
    assert.deepEqual(files.map((file) => file.startupContext.explorerPath), ["~/.codex/AGENTS.md", "AGENTS.md"]);
    assert.equal(files[0].startupContext.source, "global");
    assert.equal(files[1].startupContext.source, "ancestor");
    assert.equal(opened.content, "# Codex Agents\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("opened startup context files can be exposed and selected in the explorer", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const parent = path.join(base, "parent");
    const root = path.join(parent, "project");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(parent, "AGENTS.md"), "# Parent Agents\n");
    initializeContextRoomProject(root, {
      allowedPaths: ["docs/"],
      watchAllow: [],
    });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext = { enabled: true, fileNames: ["AGENTS.md"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const opened = readStartupContextFile(root, 1);
    const files = listMemoryFiles(root, { externalRoots: [opened.startupContext.displayPath] });

    assert.equal(opened.startupContext.kind, "startup-context");
    assert.equal(opened.startupContext.displayPath, "~/parent/AGENTS.md");
    assert.equal(opened.startupContext.explorerPath, "~/parent/AGENTS.md");
    assert.ok(files.some((file) => file.path === opened.startupContext.displayPath));
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("doc QA tracks startup context changes with an internal baseline", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const parent = path.join(base, "parent");
    const root = path.join(parent, "project");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(parent, "AGENTS.md"), "# Parent Agents\n");
    initializeContextRoomProject(root, {
      allowedPaths: ["docs/"],
      watchAllow: [],
    });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext = { enabled: true, fileNames: ["AGENTS.md"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const initial = buildDocQaReport(root);
    writeDocReviewDecision(root, "~/parent/AGENTS.md", { status: "verified", note: "startup context reviewed" });
    fs.writeFileSync(path.join(parent, "AGENTS.md"), "# Parent Agents\n\nNew global rule.\n");
    const changed = buildDocQaReport(root);
    const review = readReviewBaseFile(root, "~/parent/AGENTS.md");
    const baseline = writeDocReviewBaseline(root, "~/parent/AGENTS.md", { note: "inline review applied" });
    const afterBaseline = buildDocQaReport(root);

    assert.equal(initial.summary.needsReview, 1);
    assert.equal(initial.queue[0].reviewRequired, true);
    assert.equal(changed.summary.needsReview, 1);
    assert.equal(changed.summary.changedDocs, 1);
    assert.equal(changed.queue[0].path, "~/parent/AGENTS.md");
    assert.equal(changed.queue[0].internalChange, true);
    assert.equal(changed.queue[0].startupContext.order, 1);
    assert.equal(changed.queue[0].gitStatus.trim(), "M");
    assert.equal(review.available, true);
    assert.equal(review.baseline, "review");
    assert.equal(review.changeKind, "modified");
    assert.equal(review.baseContent, "# Parent Agents\n");
    assert.equal(review.currentContent, "# Parent Agents\n\nNew global rule.\n");
    assert.match(baseline.baselinePath, /\.context-room\/review-baselines\/external\/home\/parent\/AGENTS\.md\.baseline$/);
    assert.equal(afterBaseline.summary.needsReview, 0);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup context observation preserves changes made before the first human decision", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const parent = path.join(base, "parent");
    const root = path.join(parent, "project");
    const agentsPath = path.join(parent, "AGENTS.md");
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(agentsPath, "# Parent Agents\n");
    initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext = { enabled: true, fileNames: ["AGENTS.md"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const initial = buildDocQaReport(root).queue.find((entry) => entry.path === "~/parent/AGENTS.md");
    assert.ok(initial);
    assert.equal(initial.initialReview, true);
    assert.equal(initial.gitStatus, "");

    fs.writeFileSync(agentsPath, "# Parent Agents\n\nChanged before review.\n");
    const changed = buildDocQaReport(root).queue.find((entry) => entry.path === "~/parent/AGENTS.md");
    const review = readReviewBaseFile(root, "~/parent/AGENTS.md");
    assert.ok(changed);
    assert.equal(changed.initialReview, false);
    assert.equal(changed.gitStatus, "M");
    assert.equal(review.available, true);
    assert.equal(review.baseContent, "# Parent Agents\n");
    assert.equal(review.currentContent, "# Parent Agents\n\nChanged before review.\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup skills scanner lists configured skill folders from ancestors to root", () => {
  const base = makeRoot();
  const parent = path.join(base, "parent");
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(base, ".codex", "skills", "global-skill"), { recursive: true });
  fs.mkdirSync(path.join(base, ".codex", "skills", ".system", "skill-creator"), { recursive: true });
  fs.mkdirSync(path.join(base, ".codex", "skills", ".system", "skill-installer"), { recursive: true });
  fs.mkdirSync(path.join(parent, ".agents", "skills", "parent-skill"), { recursive: true });
  fs.mkdirSync(path.join(root, ".codex", "skills", "project-skill"), { recursive: true });
  fs.writeFileSync(path.join(base, ".codex", "skills", "global-skill", "SKILL.md"), "# Global\n");
  fs.writeFileSync(path.join(base, ".codex", "skills", ".system", "skill-creator", "SKILL.md"), "# Creator\n");
  fs.writeFileSync(path.join(base, ".codex", "skills", ".system", "skill-installer", "SKILL.md"), "# Installer\n");
  fs.writeFileSync(path.join(parent, ".agents", "skills", "parent-skill", "SKILL.md"), "# Parent\n");
  fs.writeFileSync(path.join(root, ".codex", "skills", "project-skill", "SKILL.md"), "# Project\n");
  initializeContextRoomProject(root, {
    allowedPaths: ["docs/"],
    watchAllow: [],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupSkills = { enabled: true, folderNames: [".codex/skills", ".agents/skills"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const folders = listStartupSkillFolders(root);
  const systemFolder = folders.find((folder) => folder.folderName === ".codex/skills/.system");
  const parentOrder = folders.find((folder) => folder.folderName === ".agents/skills")?.order;
  const openedSystem = readStartupSkillFile(root, systemFolder.order, "skill-installer");
  const opened = readStartupSkillFile(root, parentOrder, "parent-skill");
  const written = writeStartupSkillFile(root, parentOrder, "parent-skill", "# Parent Updated\n");
  const created = createStartupSkillFile(root, parentOrder, "Review Docs");
  fs.mkdirSync(path.join(parent, ".agents", "skills", "review-docs", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(parent, ".agents", "skills", "review-docs", "scripts", "check.sh"), "echo ok\n");
  const createdSkillFileExists = fs.existsSync(path.join(parent, ".agents", "skills", "review-docs", "SKILL.md"));
  const deleted = deleteStartupSkill(root, parentOrder, "review-docs");

  assert.deepEqual(folders.map((folder) => folder.folderName), [".codex/skills", ".codex/skills/.system", ".agents/skills", ".codex/skills"]);
  assert.deepEqual(folders.map((folder) => folder.order), [1, 2, 3, 4]);
  assert.deepEqual(folders.map((folder) => folder.skills), [["global-skill"], ["skill-creator", "skill-installer"], ["parent-skill"], ["project-skill"]]);
  assert.match(folders[0].displayPath, /\.codex\/skills$/);
  assert.equal(systemFolder.readOnly, true);
  assert.equal(openedSystem.content, "# Installer\n");
  assert.equal(openedSystem.startupContext.readOnly, true);
  assert.match(openedSystem.startupContext.displayPath, /\.codex\/skills\/\.system\/skill-installer\/SKILL\.md$/);
  assert.throws(() => writeStartupSkillFile(root, systemFolder.order, "skill-installer", "# Mutate\n"), /read-only/);
  assert.throws(() => createStartupSkillFile(root, systemFolder.order, "new-system-skill"), /read-only/);
  assert.throws(() => deleteStartupSkill(root, systemFolder.order, "skill-installer"), /read-only/);
  assert.equal(opened.content, "# Parent\n");
  assert.equal(opened.startupContext.readOnly, false);
  assert.equal(opened.startupContext.kind, "startup-skill");
  assert.equal(opened.startupContext.skillName, "parent-skill");
  assert.match(opened.startupContext.displayPath, /parent-skill\/SKILL\.md$/);
  assert.equal(opened.startupContext.explorerPath, opened.startupContext.displayPath);
  assert.equal(written.contentHash, readStartupSkillFile(root, parentOrder, "parent-skill").contentHash);
  assert.equal(fs.readFileSync(path.join(parent, ".agents", "skills", "parent-skill", "SKILL.md"), "utf8"), "# Parent Updated\n");
  assert.equal(created.startupContext.skillName, "review-docs");
  assert.match(created.content, /name: review-docs/);
  assert.equal(createdSkillFileExists, true);
  assert.equal(deleted.deleted, true);
  assert.match(deleted.backupPath, /\.context-room\/memory-webapp-backups/);
  assert.equal(fs.readFileSync(path.join(root, deleted.backupPath, "scripts", "check.sh"), "utf8"), "echo ok\n");
  assert.equal(fs.existsSync(path.join(parent, ".agents", "skills", "review-docs")), false);
});

test("doc QA requires review for every discovered startup skill and tracks later content changes", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const root = path.join(base, "project");
    const skillPath = path.join(base, ".codex", "skills", "documentation-excellence", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(skillPath, "# Documentation Excellence\n");
    initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext.enabled = false;
    config.startupSkills = { enabled: true, folderNames: [".codex/skills"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const initial = buildDocQaReport(root);
    const item = initial.queue.find((entry) => entry.path.endsWith("/documentation-excellence/SKILL.md"));
    assert.ok(item);
    assert.equal(item.reviewRequired, true);
    assert.equal(item.gitStatus, "");
    assert.equal(item.initialReview, true);
    assert.equal(item.startupContext.kind, "startup-skill");
    assert.equal(item.startupContext.skillName, "documentation-excellence");

    writeDocReviewDecision(root, item.path, { status: "needs_changes", note: "request changes" });
    assert.equal(fs.readFileSync(skillPath, "utf8"), "# Documentation Excellence\n");
    const requestedChanges = buildDocQaReport(root).queue.find((entry) => entry.path === item.path);
    assert.ok(requestedChanges);
    assert.equal(requestedChanges.review.status, "needs_changes");
    assert.equal(requestedChanges.initialReview, false);

    writeDocReviewDecision(root, item.path, { status: "verified", note: "skill reviewed" });
    assert.equal(buildDocQaReport(root).queue.some((entry) => entry.path === item.path), false);

    fs.writeFileSync(skillPath, "# Documentation Excellence\n\nChanged.\n");
    const changed = buildDocQaReport(root);
    const changedItem = changed.queue.find((entry) => entry.path === item.path);
    const review = readReviewBaseFile(root, item.path);
    assert.ok(changedItem);
    assert.equal(changedItem.gitStatus, "M");
    assert.equal(changedItem.initialReview, false);
    assert.equal(changedItem.internalChange, true);
    assert.equal(review.available, true);
    assert.equal(review.baseContent, "# Documentation Excellence\n");
    assert.equal(review.currentContent, "# Documentation Excellence\n\nChanged.\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup skill observation preserves changes made before the first human decision", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const root = path.join(base, "project");
    const skillPath = path.join(base, ".codex", "skills", "documentation-excellence", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(skillPath, "# Documentation Excellence\n");
    initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext.enabled = false;
    config.startupSkills = { enabled: true, folderNames: [".codex/skills"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const initial = buildDocQaReport(root).queue.find((entry) => entry.path.endsWith("/documentation-excellence/SKILL.md"));
    assert.ok(initial);
    assert.equal(initial.initialReview, true);
    assert.equal(initial.gitStatus, "");

    fs.writeFileSync(skillPath, "# Documentation Excellence\n\nChanged before review.\n");
    const changed = buildDocQaReport(root).queue.find((entry) => entry.path === initial.path);
    const review = readReviewBaseFile(root, initial.path);
    assert.ok(changed);
    assert.equal(changed.initialReview, false);
    assert.equal(changed.gitStatus, "M");
    assert.equal(review.available, true);
    assert.equal(review.baseContent, "# Documentation Excellence\n");
    assert.equal(review.currentContent, "# Documentation Excellence\n\nChanged before review.\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("a recovered startup skill baseline restores its real review diff without accepting the document", async () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const root = path.join(base, "project");
    const skillPath = path.join(base, ".codex", "skills", "documentation-excellence", "SKILL.md");
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(skillPath, "# Documentation Excellence\n\nAfter.\n");
    initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupContext.enabled = false;
    config.startupSkills = { enabled: true, folderNames: [".codex/skills"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const contextRoom = await import("../src/context_room.mjs");
    assert.equal(typeof contextRoom.writeDocReviewBaselineContent, "function");
    contextRoom.writeDocReviewBaselineContent(
      root,
      "~/.codex/skills/documentation-excellence/SKILL.md",
      "# Documentation Excellence\n\nBefore.\n",
      { note: "recovered pre-edit content" },
    );

    const item = buildDocQaReport(root).queue.find((entry) => entry.path.endsWith("/documentation-excellence/SKILL.md"));
    const review = readReviewBaseFile(root, item.path);
    assert.ok(item);
    assert.equal(item.initialReview, false);
    assert.equal(item.gitStatus, "M");
    assert.equal(item.review?.status, undefined);
    assert.equal(review.available, true);
    assert.equal(review.baseContent, "# Documentation Excellence\n\nBefore.\n");
    assert.equal(review.currentContent, "# Documentation Excellence\n\nAfter.\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("doc QA automatically requires every project AGENTS.md without duplicate queue entries", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "website", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Root agents\n");
  fs.writeFileSync(path.join(root, "website", "AGENTS.md"), "# Website agents\n");
  fs.writeFileSync(path.join(root, "website", "nested", "AGENTS.md"), "# Nested agents\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupContext.enabled = false;
  config.startupSkills.enabled = false;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const initial = buildDocQaReport(root);
  const agentItems = initial.queue.filter((entry) => entry.path.endsWith("AGENTS.md"));
  assert.deepEqual(agentItems.map((entry) => entry.path).sort(), ["AGENTS.md", "website/AGENTS.md", "website/nested/AGENTS.md"]);
  assert.equal(new Set(agentItems.map((entry) => entry.path)).size, 3);
  for (const item of agentItems) writeDocReviewDecision(root, item.path, { status: "verified", note: "instructions reviewed" });
  assert.equal(buildDocQaReport(root).queue.some((entry) => entry.path.endsWith("AGENTS.md")), false);

  fs.writeFileSync(path.join(root, "website", "AGENTS.md"), "# Website agents\n\nChanged.\n");
  const changed = buildDocQaReport(root).queue.filter((entry) => entry.path.endsWith("AGENTS.md"));
  assert.deepEqual(changed.map((entry) => entry.path), ["website/AGENTS.md"]);
});

test("doc QA shows a repo startup skill only once when Git review already covers it", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  const skillPath = path.join(root, ".codex", "skills", "investigate", "SKILL.md");
  fs.mkdirSync(path.dirname(skillPath), { recursive: true });
  fs.writeFileSync(skillPath, "# Investigate\n");
  initializeContextRoomProject(root, { allowedPaths: [".codex/skills/"], watchAllow: [".codex/skills/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupContext.enabled = false;
  config.startupSkills = { enabled: true, folderNames: [".codex/skills"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const matches = buildDocQaReport(root).queue.filter((entry) => entry.path === ".codex/skills/investigate/SKILL.md");
  assert.equal(matches.length, 1);
  assert.equal(matches[0].gitStatus, "??");
});

test("startup skill folders can be exposed in the explorer for file and folder creation", () => {
  const originalHome = process.env.HOME;
  const base = makeRoot();
  process.env.HOME = base;
  try {
    const root = path.join(base, "project");
    const skillRootAbs = path.join(base, ".agents", "skills", "edit-me");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(path.join(skillRootAbs, "docs"), { recursive: true });
    fs.writeFileSync(path.join(skillRootAbs, "SKILL.md"), "# Edit Me\n");
    fs.writeFileSync(path.join(skillRootAbs, "docs", "guide.md"), "# Guide\n");
    initializeContextRoomProject(root, {
      allowedPaths: ["docs/"],
      watchAllow: [],
    });
    const configPath = path.join(root, CONFIG_FILE);
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.startupSkills = { enabled: true, folderNames: [".agents/skills"] };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

    const opened = readStartupSkillFile(root, 1, "edit-me");
    const skillRoot = opened.startupContext.folder + "/edit-me";
    const files = listMemoryFiles(root, { externalRoots: [skillRoot] });
    const createdFile = createMarkdownFile(root, { path: skillRoot + "/notes.md", title: "Notes", applyTemplate: false });
    const createdFolder = createFolder(root, { path: skillRoot + "/references" });

    assert.equal(opened.startupContext.fileName, "edit-me/SKILL.md");
    assert.equal(opened.startupContext.explorerPath, skillRoot + "/SKILL.md");
    assert.ok(files.some((file) => file.path === skillRoot + "/SKILL.md"));
    assert.ok(files.some((file) => file.path === skillRoot + "/docs/guide.md"));
    assert.equal(createdFile.path, skillRoot + "/notes.md");
    assert.equal(createdFolder.path, skillRoot + "/references/");
    assert.equal(fs.existsSync(path.join(skillRootAbs, "notes.md")), true);
    assert.equal(fs.existsSync(path.join(skillRootAbs, "references")), true);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("startup hooks scanner lists Git hooks and hook-manager files", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const gitHooksDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(gitHooksDir, "pre-commit"), "#!/bin/sh\n# Run secret checks\n# Run type checks\necho git hook\n");
  fs.chmodSync(path.join(gitHooksDir, "pre-commit"), 0o755);
  fs.mkdirSync(path.join(root, ".husky"), { recursive: true });
  fs.writeFileSync(path.join(root, ".husky", "pre-push"), "#!/bin/sh\necho husky\n");
  fs.chmodSync(path.join(root, ".husky", "pre-push"), 0o755);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ "lint-staged": { "*.js": "eslint" } }, null, 2) + "\n");
  execFileSync("git", ["add", ".husky/pre-push", "package.json"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupHooks = {
    enabled: true,
    editable: false,
    gitHooks: true,
    hookManagers: true,
    fileNames: ["pre-commit", "pre-push"],
    managerPaths: [".husky/", "package.json"],
  };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const hooks = listStartupHookFiles(root);
  const gitHook = hooks.find((file) => file.startupHook.source === "git-hooks");
  const huskyHook = hooks.find((file) => file.startupHook.source === "husky");
  const packageHook = hooks.find((file) => file.startupHook.source === "package-hooks");
  const opened = readStartupHookFile(root, gitHook.startupHook.order);

  assert.equal(hooks.length, 3);
  assert.equal(gitHook.startupHook.fileName, "pre-commit");
  assert.equal(gitHook.startupHook.label, "Git pre-commit hook");
  assert.equal(gitHook.startupHook.description, "Run secret checks · Run type checks");
  assert.equal(gitHook.startupHook.executable, true);
  assert.equal(gitHook.startupHook.tracked, false);
  assert.equal(gitHook.startupHook.readOnly, true);
  assert.equal(huskyHook.startupHook.fileName, "pre-push");
  assert.equal(huskyHook.startupHook.tracked, true);
  assert.equal(packageHook.startupHook.fileName, "package.json");
  assert.match(opened.content, /git hook/);
  assert.equal(opened.startupContext.kind, "startup-hook");
  assert.throws(() => writeStartupHookFile(root, gitHook.startupHook.order, "#!/bin/sh\necho blocked\n"), /editing is disabled/);

  config.startupHooks.editable = true;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const written = writeStartupHookFile(root, huskyHook.startupHook.order, "#!/bin/sh\necho updated\n");
  assert.equal(readStartupHookFile(root, huskyHook.startupHook.order).content, "#!/bin/sh\necho updated\n");
  assert.equal(written.startupContext.readOnly, false);

  const graph = buildDocumentationGraph(root);
  assert.equal(graph.summary.startupHooks, 3);
  assert.ok(graph.startupHooks.some((file) => file.startupContext.source === "git-hooks"));
});

test("startup hooks scanner lists agent hooks from Codex, Claude Code, and OpenCode", () => {
  const repo = makeRoot();
  const root = path.join(repo, "project");
  fs.mkdirSync(root, { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.mkdirSync(path.join(repo, ".codex", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".codex", "hooks", "protect.py"), "#!/usr/bin/env python3\n\"\"\"Protect risky tool calls before execution.\"\"\"\nprint('protect')\n");
  fs.writeFileSync(path.join(repo, ".codex", "hooks.json"), JSON.stringify({
    hooks: {
      PreToolUse: [{
        hooks: [{
          type: "command",
          command: "/bin/sh -lc 'repo_root=$(git rev-parse --show-toplevel); exec /usr/bin/python3 \"$repo_root/.codex/hooks/protect.py\"'",
          timeout: 5,
        }],
      }],
    },
  }, null, 2) + "\n");
  fs.mkdirSync(path.join(repo, ".claude", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".claude", "hooks", "audit.sh"), "#!/bin/sh\n# Check Claude Code edits\necho audit\n");
  fs.writeFileSync(path.join(repo, ".claude", "settings.json"), JSON.stringify({
    hooks: {
      PostToolUse: [{
        hooks: [{
          type: "command",
          command: ".claude/hooks/audit.sh",
        }],
      }],
    },
  }, null, 2) + "\n");
  fs.mkdirSync(path.join(repo, ".opencode", "plugins"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".opencode", "plugins", "policy.ts"), "/** Checks OpenCode tool activity. */\nexport default {}\n");
  execFileSync("git", ["add", ".codex/hooks.json", ".codex/hooks/protect.py", ".claude/settings.json", ".claude/hooks/audit.sh", ".opencode/plugins/policy.ts"], { cwd: repo, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupHooks.projectOnly = false;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const hooks = listStartupHookFiles(root);
  const codexConfig = hooks.find((file) => file.startupHook.source === "codex-agent-hooks");
  const codexScript = hooks.find((file) => file.startupHook.source === "codex-agent-hook-script");
  const claudeConfig = hooks.find((file) => file.startupHook.source === "claude-agent-hooks");
  const claudeScript = hooks.find((file) => file.startupHook.source === "claude-agent-hook-script");
  const opencodePlugin = hooks.find((file) => file.startupHook.source === "opencode-agent-plugin");

  assert.ok(codexConfig);
  assert.ok(codexScript);
  assert.ok(claudeConfig);
  assert.ok(claudeScript);
  assert.ok(opencodePlugin);
  assert.equal(codexConfig.startupHook.provider, "codex");
  assert.equal(claudeConfig.startupHook.provider, "claude");
  assert.equal(opencodePlugin.startupHook.provider, "opencode");
  assert.equal(codexConfig.startupHook.tracked, true);
  assert.equal(codexConfig.startupHook.event, "hooks.json");
  assert.match(codexConfig.startupHook.description, /Defines Codex hook events/);
  assert.equal(codexScript.startupHook.tracked, true);
  assert.equal(codexScript.startupHook.event, "PreToolUse");
  assert.equal(codexScript.startupHook.label, "PreToolUse · protect.py");
  assert.equal(codexScript.startupHook.description, "Protect risky tool calls before execution.");
  assert.equal(codexScript.startupHook.commandSummary, "runs .codex/hooks/protect.py");
  assert.equal(claudeScript.startupHook.event, "PostToolUse");
  assert.equal(claudeScript.startupHook.commandSummary, "runs .claude/hooks/audit.sh");
  assert.equal(opencodePlugin.startupHook.label, "OpenCode hooks · policy.ts");
  assert.equal(opencodePlugin.startupHook.description, "Checks OpenCode tool activity.");
  assert.match(readStartupHookFile(root, codexScript.startupHook.order).content, /protect/);
});

test("startup context virtual files stay out of the explorer tree", () => {
  const html = renderAppHtml();

  assert.match(html, /api\("\/api\/startup-context"\)/);
  assert.match(html, /api\("\/api\/startup-skills"\)/);
  assert.match(html, /api\("\/api\/startup-hooks"\)/);
  assert.match(html, /api\("\/api\/startup-hooks\/file\?order="/);
  assert.match(html, /api\("\/api\/startup-skills\/file\?folder="/);
  assert.match(html, /api\("\/api\/startup-skills\/create"/);
  assert.match(html, /api\("\/api\/startup-skills\/delete"/);
  assert.match(html, /function renderStartupSkillsPanel\(\)/);
  assert.match(html, /function renderStartupHooksPanel\(\)/);
  assert.match(html, /function selectStartupSkillFile\(folderOrder, skillName, options = \{\}\)/);
  assert.match(html, /function selectStartupHookFile\(order, options = \{\}\)/);
  assert.match(html, /const selectedPath = startupContextSelectedExplorerPath\(data\.startupContext\);[\s\S]*const finalPath = selectedPath \|\| selectedKey;[\s\S]*state\.selected = finalPath;/);
  assert.match(html, /const finalPath = startupSkillSelectedExplorerPath\(data\.startupContext\) \|\| selectedKey;/);
  assert.match(html, /function createStartupSkillFromPanel\(folderOrder\)/);
  assert.match(html, /function submitStartupSkillCreateForm\(folderOrder\)/);
  assert.match(html, /function cancelStartupSkillCreate\(\)/);
  assert.match(html, /function deleteStartupSkillFromPanel\(folderOrder, skillName\)/);
  assert.match(html, /addEventListener\("contextmenu", \(event\) => openStartupContextContextMenu\(event, button\.dataset\.startupOrder\)\)/);
  assert.match(html, /function openStartupContextContextMenu\(event, order\)/);
  assert.match(html, /data-startup-context-delete/);
  assert.match(html, /async function deleteStartupContextFromPanel\(order\)/);
  assert.match(html, /api\("\/api\/startup-context\/delete"/);
  assert.match(html, /function filesApiPath\(\)/);
  assert.match(html, /startupContextOrder/);
  assert.match(html, /function activateStartupSkillExplorer\(folderOrder, skillName, startupContext = null\)/);
  assert.match(html, /function activateStartupContextExplorer\(startupContext = null\)/);
  assert.match(html, /function startupContextSelectedExplorerPath\(startupContext = state\.selectedStartupContext\)/);
  assert.match(html, /startupContext\.explorerPath/);
  assert.match(html, /function revealActiveStartupContextExplorer\(\)/);
  assert.match(html, /function startupSkillSelectedExplorerPath\(startupContext = state\.selectedStartupContext\)/);
  assert.match(html, /function revealActiveStartupSkillExplorer\(\)/);
  assert.match(html, /function expandAndRevealExplorerPath\(path\)/);
  assert.doesNotMatch(html, /function isPathInsideActiveStartupSkill/);
  assert.doesNotMatch(html, /state\.activeStartupSkillExplorer = null;\s*state\.selected = selectedKey;\s*state\.openingFilePath = selectedKey;\s*state\.selectedStartupContext = pendingFile/);
  assert.match(html, /activeStartupSkillExplorer: null/);
  assert.match(html, /activeStartupContextExplorer: null/);
  assert.match(html, /Startup skills/);
  assert.match(html, /Startup hooks/);
  assert.match(html, /startupHooksHelpOpen: false/);
  assert.match(html, /startupHookFilter: "all"/);
  assert.match(html, /data-startup-hooks-help/);
  assert.match(html, /data-startup-hook-filter/);
  assert.match(html, /function setStartupHookFilter\(filter = "all"\)/);
  assert.match(html, /function startupHookKind\(hook = \{\}\)/);
  assert.match(html, /startupHookFilterLabel\(kind = "all", files = \[\]\)/);
  assert.match(html, /function startupHookFilterOptions\(files = \[\]/);
  assert.match(html, /state\.startupHooksHelpOpen = Boolean\(event\.currentTarget\.open\)/);
  assert.match(html, /Agent hook sources and related hooks/);
  assert.match(html, /Agent hook sources/);
  assert.match(html, /Codex/);
  assert.match(html, /Claude Code/);
  assert.match(html, /OpenCode/);
  assert.match(html, /Common agent events/);
  assert.match(html, /Before tool use/);
  assert.match(html, /After tool use/);
  assert.match(html, /User prompt/);
  assert.match(html, /Session start\/stop/);
  assert.match(html, /Config and plugins/);
  assert.match(html, /Git hooks/);
  assert.match(html, /Hook managers/);
  assert.match(html, /Examples include Husky/);
  assert.match(html, /class="startup-hook-kind/);
  assert.match(html, /\.startup-hook-filter/);
  assert.match(html, /startupSkillFolders: \[\]/);
  assert.match(html, /startupHookFiles: \[\]/);
  assert.match(html, /data-startup-skill-name/);
  assert.match(html, /data-startup-skill-delete/);
  assert.match(html, /data-startup-skill-create-folder/);
  assert.match(html, /data-startup-skill-create-form/);
  assert.match(html, /data-startup-skill-create-input/);
  assert.match(html, /startup-context-item startup-skill-folder readonly/);
  assert.match(html, /\.startup-skill-button\s*\{[^}]*padding:\s*5px 8px/);
  assert.match(html, /\.startup-skill-delete\s*\{[^}]*position:\s*absolute;[^}]*top:\s*-7px;[^}]*right:\s*-7px;[^}]*background:\s*rgba\(139,211,255,0\.14\);[^}]*pointer-events:\s*none;[^}]*display:\s*grid;[^}]*place-items:\s*center/);
  assert.match(html, /\.startup-skill-pill:hover \.startup-skill-delete[^}]*pointer-events:\s*auto/);
  assert.doesNotMatch(html, /\.startup-skill-pill:hover[^}]*grid-template-columns/);
  assert.match(html, /\.startup-skill-add/);
  assert.match(html, /id="startupSkillsEnabled"/);
  assert.match(html, /id="startupHooksEnabled"/);
  assert.match(html, /id="startupHooksEditable"/);
  assert.match(html, /id="startupAgentHooks"/);
  assert.match(html, /id="startupAgentHookSources"/);
  assert.match(html, /Name \| config path \| plugin folder/);
  assert.match(html, /data-startup-order/);
  assert.match(html, /data-startup-hook-order/);
  assert.doesNotMatch(html, /data-startup-file/);
  assert.doesNotMatch(html, /@startup-context/);
  assert.doesNotMatch(html, /\$startup-context/);
});

test("CLI init and doctor work in a fresh project", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");

  const cli = path.resolve("bin/context-room.mjs");
  execFileSync(process.execPath, [cli, "init", "--title", "CLI Demo", "--watch", "docs/"], { cwd: root, stdio: "pipe" });
  const doctor = execFileSync(process.execPath, [cli, "doctor"], { cwd: root, encoding: "utf8" });
  const saved = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), "utf8"));

  assert.equal(saved.title, "CLI Demo");
  assert.deepEqual(saved.watchAllow, ["docs/"]);
  assert.match(doctor, /Context Room OK/);
});

test("init adds Context Room runtime files to local Git excludes", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const result = ensureRuntimeGitExcludes(root);
  const excludePath = result.path || execFileSync("git", ["rev-parse", "--git-dir"], { cwd: root, encoding: "utf8" }).trim() + "/info/exclude";
  const exclude = fs.readFileSync(path.isAbsolute(excludePath) ? excludePath : path.join(root, excludePath), "utf8");

  assert.match(exclude, /Context Room runtime state/);
  assert.match(exclude, /\.context-room\/review-ledger\.json/);
  assert.match(exclude, /\.context-room\/session-state\.json/);
  assert.match(exclude, /\.context-room\/agent-command\.json/);
  assert.match(exclude, /\.context-room\/agent-annotations\.json/);
  assert.match(exclude, /\.context-room\/health-acknowledgements\.json/);
  assert.match(exclude, /\.context-room\/review-gate\.json/);
  assert.match(exclude, /\.context-room\/README\.md/);
  assert.match(exclude, /\.context-room\/agent-context\//);
  assert.match(exclude, /\.context-room\/review-baselines\//);
});

test("runtime Git excludes are scoped when Context Room root is a Git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "project");
  fs.mkdirSync(root);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const gitDir = execFileSync("git", ["rev-parse", "--git-dir"], { cwd: repo, encoding: "utf8" }).trim();
  const exclude = fs.readFileSync(path.join(repo, gitDir, "info", "exclude"), "utf8");

  assert.match(exclude, /project\/\.context-room\/session-state\.json/);
  assert.match(exclude, /project\/\.context-room\/agent-command\.json/);
  assert.match(exclude, /project\/\.context-room\/README\.md/);
  assert.match(exclude, /^\.context-room\/review-ledger\.json$/m);
  assert.match(exclude, /project\/\.context-room\/review-baselines\//);
  assert.match(exclude, /project\/\.context-room\/memory-webapp-backups\//);
});

test("CLI guard is non-blocking unless strict mode is explicit", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nAgent change.\n");

  const cli = path.resolve("bin/context-room.mjs");
  const advisoryOutput = execFileSync(process.execPath, [cli, "guard"], { cwd: root, encoding: "utf8" });
  assert.match(advisoryOutput, /found watched documentation changes/);
  assert.match(advisoryOutput, /did not block/);
  assert.doesNotMatch(advisoryOutput, /blocked this commit/);
  assert.match(advisoryOutput, /README\.md/);

  const reviewOnlyOutput = execFileSync(process.execPath, [cli, "guard", "--profile", "review-only"], { cwd: root, encoding: "utf8" });
  assert.match(reviewOnlyOutput, /found watched documentation changes/);
  assert.match(reviewOnlyOutput, /review-only guard found issues but did not block/);
  assert.doesNotMatch(reviewOnlyOutput, /blocked this commit/);

  assert.throws(
    () => execFileSync(process.execPath, [cli, "guard", "--profile", "strict"], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Context Room guard blocked this commit/);
      assert.match(output, /need human review/);
      assert.match(output, /Open the Context Room webapp for the user/);
      assert.match(output, /show the Changed files to review queue/);
      assert.match(output, /Agents must not mark files verified on the user's behalf/);
      assert.match(output, /README\.md/);
      return true;
    },
  );

  writeReviewGateSettings(root, { operations: ["push"] });
  const commitGateOutput = execFileSync(process.execPath, [cli, "guard", "--operation", "commit"], { cwd: root, encoding: "utf8" });
  assert.match(commitGateOutput, /did not block/);
  assert.throws(
    () => execFileSync(process.execPath, [cli, "guard", "--operation", "push"], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Context Room guard blocked this push/);
      assert.match(output, /README\.md/);
      return true;
    },
  );

  writeDocReviewDecision(root, "README.md", { status: "verified", note: "test baseline" });
  const output = execFileSync(process.execPath, [cli, "guard", "--profile", "review-only"], { cwd: root, encoding: "utf8" });
  assert.match(output, /No unverified watched documentation changes/);

  const unverified = writeDocReviewDecision(root, "README.md", { status: "unverified", note: "undo" });
  assert.equal(unverified.status, "unverified");
  assert.throws(
    () => execFileSync(process.execPath, [cli, "guard", "--profile", "strict"], { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Context Room guard blocked this commit/);
      assert.match(output, /README\.md/);
      return true;
    },
  );

  writeReviewGateSettings(root, { operations: ["commit"] });
  execFileSync(process.execPath, [cli, "install-hooks"], { cwd: root, encoding: "utf8" });
  const hook = fs.readFileSync(path.join(root, ".git", "hooks", "pre-commit"), "utf8");
  assert.match(hook, /Managed by Context Room review gate/);
  assert.match(hook, /--operation 'commit'/);
  assert.doesNotMatch(hook, /--profile advisory/);
});

test("review gate hook sync installs selected local operations and preserves custom hooks", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const hooksDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim();
  const customCommitHook = "#!/bin/sh\necho custom\n";
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), customCommitHook, { mode: 0o755 });

  const first = syncContextRoomGitHooks(root, { policy: { operations: ["commit", "push", "merge", "pull-request"] } });

  assert.deepEqual(first.conflicts, ["pre-commit"]);
  assert.deepEqual(first.installed, ["pre-push", "pre-merge-commit"]);
  assert.deepEqual(first.externalOperations, ["merge", "pull-request"]);
  assert.equal(fs.readFileSync(path.join(hooksDir, "pre-commit"), "utf8"), customCommitHook);
  assert.match(fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8"), /--operation 'push'/);
  assert.match(fs.readFileSync(path.join(hooksDir, "pre-merge-commit"), "utf8"), /--operation 'merge'/);
  assert.match(fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8"), /git rev-parse --show-toplevel/);
  assert.match(fs.readFileSync(path.join(hooksDir, "pre-push"), "utf8"), /--hook/);

  const second = syncContextRoomGitHooks(root, { policy: { operations: [] } });
  assert.deepEqual(second.removed, []);
  assert.equal(fs.existsSync(path.join(hooksDir, "pre-push")), true);
  assert.equal(fs.existsSync(path.join(hooksDir, "pre-merge-commit")), true);
  assert.equal(fs.readFileSync(path.join(hooksDir, "pre-commit"), "utf8"), customCommitHook);
});

test("review gate hook sync refuses linked hook targets without writing through them", () => {
  const root = makeRoot();
  const outside = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const hooksDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim();
  const outsideTarget = path.join(outside, "must-not-be-created");
  const linkedHook = path.join(hooksDir, "pre-push");
  fs.symlinkSync(outsideTarget, linkedHook);

  assert.throws(
    () => syncContextRoomGitHooks(root, { policy: { operations: ["push"] } }),
    (error) => error?.code === "managed_context_room_state_unsafe",
  );
  assert.equal(fs.existsSync(outsideTarget), false);
  assert.equal(fs.lstatSync(linkedHook).isSymbolicLink(), true);
});

test("review gate hook sync makes an old Context Room pre-commit hook inert when commit is deselected", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const hooksDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim();
  fs.writeFileSync(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nnode \"/tmp/context-room.mjs\" guard --root \"/tmp/project\" --profile strict\n", { mode: 0o755 });

  const result = syncContextRoomGitHooks(root, { policy: { operations: ["push"] } });
  const migrated = fs.readFileSync(path.join(hooksDir, "pre-commit"), "utf8");

  assert.deepEqual(result.updated, ["pre-commit"]);
  assert.match(migrated, /Managed by Context Room review gate/);
  assert.match(migrated, /--operation 'commit' --hook/);
  assert.doesNotMatch(migrated, /--profile strict/);
});

test("push-only gate allows a code commit while a watched doc waits, then blocks pre-push", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 1;\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["README.md", "src/"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  writeReviewGateSettings(root, { operations: ["push"] });
  syncContextRoomGitHooks(root);

  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nNeeds human review.\n");
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const value = 2;\n");
  execFileSync("git", ["add", "src/app.js"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "change code"], { cwd: root, stdio: "pipe" });

  const hooksDir = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-path", "hooks"], { cwd: root, encoding: "utf8" }).trim();
  assert.equal(fs.existsSync(path.join(hooksDir, "pre-commit")), false);
  assert.throws(
    () => execFileSync(path.join(hooksDir, "pre-push"), { cwd: root, encoding: "utf8", stdio: "pipe" }),
    (error) => {
      const output = `${error.stdout || ""}${error.stderr || ""}`;
      assert.match(output, /Context Room guard blocked this push/);
      assert.match(output, /README\.md/);
      return true;
    },
  );
});

test("shared review ledger verifies the same absolute path and content across rooms", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nShared review.\n");

  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);
  const verified = writeDocReviewDecision(root, "README.md", { status: "verified", note: "global proof" });
  const ledger = readGlobalReviewLedger(root);
  const entries = Object.values(ledger.reviews);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].absolutePath, fs.realpathSync(path.join(root, "README.md")));
  assert.equal(entries[0].contentHash, verified.contentHash);

  fs.unlinkSync(path.join(root, ".context-room", "review-ledger.json"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), false);
  assert.equal(Object.values(readGlobalReviewLedger(root).reviews).length, 1);

  fs.unlinkSync(path.join(root, ".context-room", "review-state.json"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), false);

  writeDocReviewDecision(root, "README.md", { status: "unverified" });
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);
});

test("accepted dependency changes require targeted human revalidation", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  const dependencyPath = path.join(root, "docs", "trust.md");
  const dependentPath = path.join(root, "docs", "review.md");
  const dependencyV1 = "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nHuman approval.\n";
  const dependencyV2 = "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nExact human approval.\n";
  const dependent = "---\ncontext_room:\n  id: product.review\n  depends_on:\n    - strategy.trust\n---\n\n# Review\n\nReview the current version.\n";
  fs.writeFileSync(dependencyPath, dependencyV1);
  fs.writeFileSync(dependentPath, dependent);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  writeDocReviewDecision(root, "docs/trust.md", { status: "verified" });
  const firstDependentReview = writeDocReviewDecision(root, "docs/review.md", { status: "verified" });
  assert.equal(firstDependentReview.dependencyVersions["strategy.trust"], createHash("sha256").update(dependencyV1).digest("hex"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "docs/review.md"), false);

  fs.writeFileSync(dependencyPath, dependencyV2);
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "docs/review.md"), false);
  writeDocReviewDecision(root, "docs/trust.md", { status: "verified" });

  const invalidated = buildDocQaReport(root).queue.find((item) => item.path === "docs/review.md");
  assert.ok(invalidated);
  assert.equal(invalidated.reviewReason, "dependency-changed");
  assert.equal(invalidated.dependencyChanges.length, 1);
  assert.equal(invalidated.dependencyChanges[0].documentId, "strategy.trust");
  assert.ok(buildContextRoomDoctorReport(root).issues.some((issue) => issue.type === "dependency_review_required" && issue.path === "docs/review.md"));
  assert.throws(
    () => writeDocReviewDecision(root, "docs/review.md", {
      status: "verified",
      expectedDependencyVersions: firstDependentReview.dependencyVersions,
    }),
    (error) => error?.statusCode === 409 && error?.code === "review_revision_conflict",
  );

  writeDocReviewDecision(root, "docs/review.md", {
    status: "verified",
    expectedDependencyVersions: invalidated.dependencyVersions,
  });
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "docs/review.md"), false);
});

test("watched HTML changes enter the review queue", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const filePath = path.join(root, "docs", "ideas.html");
  fs.writeFileSync(filePath, "<!doctype html><html><body><h1>Ideas</h1></body></html>\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(filePath, "<!doctype html><html><body><h1>Ideas</h1><p>New direction.</p></body></html>\n");

  const item = buildDocQaReport(root).queue.find((entry) => entry.path === "docs/ideas.html");

  assert.ok(item);
  assert.notEqual(item.gitStatus.trim(), "");
  assert.equal(item.reviewRequired, false);
});

test("last_verified-only edits invalidate both local and global exact-hash trust", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const contentFor = (date, body = "Stable truth.") => `---\ncontext_room:\n  kind: canonical\n  scope: demo\n  status: current\n  canonical_for: guide\n  last_verified: ${date}\n  sources: []\n---\n\n# Guide\n\n${body}\n`;
  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-07"));
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  writeDocReviewDecision(root, "README.md", { status: "verified" });

  const reviewStatePath = path.join(root, ".context-room", "review-state.json");
  const ledgerPath = path.join(root, ".context-room", "review-ledger.json");
  const legacyState = JSON.parse(fs.readFileSync(reviewStatePath, "utf8"));
  delete legacyState.reviews["README.md"].reviewHash;
  delete legacyState.reviews["README.md"].baselineReviewHash;
  fs.writeFileSync(reviewStatePath, JSON.stringify(legacyState, null, 2) + "\n");
  const legacyLedger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  for (const review of Object.values(legacyLedger.reviews)) delete review.reviewHash;
  fs.writeFileSync(ledgerPath, JSON.stringify(legacyLedger, null, 2) + "\n");

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-09"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);

  writeDocReviewDecision(root, "README.md", { status: "verified" });
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), false);

  fs.unlinkSync(reviewStatePath);
  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-10"));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-10", "Changed truth."));
  assert.equal(buildDocQaReport(root).queue.some((item) => item.path === "README.md"), true);
});

test("last_verified-only Git edits require review until the current hash is trusted", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const contentFor = (date, body = "Stable truth.") => `---\ncontext_room:\n  kind: canonical\n  scope: demo\n  status: current\n  canonical_for: guide\n  last_verified: ${date}\n  sources: []\n---\n\n# Guide\n\n${body}\n`;
  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-07"));
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-09"));
  const initialReview = buildDocQaReport(root);
  assert.equal(initialReview.queue.length, 1);
  assert.equal(initialReview.queue[0].reviewReason, "unverified-current");

  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["README.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const requiredReview = buildDocQaReport(root);
  assert.equal(requiredReview.queue.length, 1);
  assert.equal(requiredReview.queue[0].reviewRequired, true);
  assert.equal(requiredReview.queue[0].gitStatus, "");
  assert.equal(requiredReview.summary.changedDocs, 0);
  assert.equal(requiredReview.summary.requiredReview, 1);

  fs.writeFileSync(path.join(root, "README.md"), contentFor("2026-07-09", "Changed truth."));
  assert.notEqual(buildDocQaReport(root).queue[0].gitStatus.trim(), "");
});

test("a watched document stays reviewed only for its exact current content hash", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nVersion one.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/guide.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });

  const initial = buildDocQaReport(root);
  assert.equal(initial.queue[0].reviewReason, "unverified-current");
  writeDocReviewDecision(root, "docs/guide.md", { status: "verified", note: "reviewed" });
  assert.deepEqual(buildDocQaReport(root).queue, []);

  fs.chmodSync(path.join(root, "docs", "guide.md"), 0o755);
  const modeChanged = buildDocQaReport(root);
  assert.equal(modeChanged.queue.length, 1);
  assert.equal(modeChanged.queue[0].path, "docs/guide.md");
  assert.equal(modeChanged.queue[0].reviewReason, "unverified-current");
  assert.equal(modeChanged.reviewedPaths.includes("docs/guide.md"), false);
  assert.equal(modeChanged.pendingPaths.includes("docs/guide.md"), true);
  fs.chmodSync(path.join(root, "docs", "guide.md"), 0o644);
  assert.deepEqual(buildDocQaReport(root).queue, []);

  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nVersion two.\n");
  execFileSync("git", ["add", "docs/guide.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "update guide"], { cwd: root, stdio: "ignore" });
  const committedChange = buildDocQaReport(root);
  assert.equal(committedChange.queue.length, 1);
  assert.equal(committedChange.queue[0].path, "docs/guide.md");
  assert.equal(committedChange.queue[0].gitStatus, "");
  assert.equal(committedChange.queue[0].reviewReason, "unverified-current");
});

test("human Settings save migrates allowed legacy reviewPaths without widening allowedPaths", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });
  const configPath = path.join(root, CONFIG_FILE);
  const legacy = JSON.parse(fs.readFileSync(configPath, "utf8"));
  legacy.watchAllow = [];
  legacy.watchRules = [{ path: "docs/", mode: "direct-current", files: [] }];
  legacy.reviewPaths = ["docs/guide.md", "outside.md"];
  legacy.reviewAgentInstructions = false;
  fs.writeFileSync(configPath, JSON.stringify(legacy, null, 2) + "\n");

  const room = createMemoryServer({ root });
  const server = room.server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const current = await (await fetch(baseUrl + "/api/settings")).json();
  assert.ok(current.settings.watchAllow.includes("docs/guide.md"));
  assert.deepEqual(current.settings.watchRules, legacy.watchRules);
  assert.equal("reviewPaths" in current.settings, false);

  const response = await fetch(baseUrl + "/api/settings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ settings: current.settings }),
  });
  assert.equal(response.status, 200);
  const saved = JSON.parse(fs.readFileSync(configPath, "utf8"));
  assert.deepEqual(saved.allowedPaths, ["docs/"]);
  assert.ok(saved.watchAllow.includes("docs/guide.md"));
  assert.deepEqual(saved.watchRules, legacy.watchRules);
  assert.equal(saved.watchAllow.includes("outside.md"), false);
  assert.equal("reviewPaths" in saved, false);
  assert.equal("reviewAgentInstructions" in saved, false);
  assert.ok(buildContextRoomDoctorReport(root, { settings: legacy }).issues.some((issue) => issue.type === "legacy_review_path_not_allowed" && issue.path === "outside.md"));
});

test("collaboration state, commands, annotations, and queue are agent-safe", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\n## Purpose\nKeep humans in control.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const session = writeCollaborationSessionState(root, {
    page: "file",
    openFile: "docs/guide.md",
    selectedPath: "docs/guide.md",
    visibleHeading: "## Purpose",
    scrollPercent: 42,
    pendingMiniDiffs: 2,
    gitDiffOpen: true,
    explorerFilter: "watched",
    dirty: false,
  });
  assert.equal(session.openFile, "docs/guide.md");
  assert.equal(readCollaborationSessionState(root).visibleHeading, "## Purpose");

  const foreignRoot = makeRoot();
  fs.writeFileSync(path.join(root, CONFIG_DIR, "session-state.json"), JSON.stringify({
    version: 1,
    root: foreignRoot,
    page: "file",
    selectedPath: "other-project/private.md",
    pathFilters: ["other-project/"],
  }, null, 2) + "\n");
  const rejectedForeignSession = readCollaborationSessionState(root);
  assert.equal(rejectedForeignSession.root, path.resolve(root));
  assert.equal(rejectedForeignSession.selectedPath, null);
  assert.deepEqual(rejectedForeignSession.pathFilters, []);

  const command = writeAgentCommand(root, { view: "file", path: "docs/guide.md", targetType: "heading", targetValue: "Purpose" });
  assert.equal(command.path, "docs/guide.md");
  assert.deepEqual(readAgentCommand(root).command.target, { type: "heading", value: "Purpose" });

  const annotation = appendAgentAnnotation(root, { path: "docs/guide.md", target: "Purpose", targetType: "heading", note: "Ask the user to verify this section." });
  const annotations = readAgentAnnotations(root, "docs/guide.md").annotations;
  assert.equal(annotations.length, 1);
  assert.equal(annotations[0].id, annotation.id);
  assert.equal(annotations[0].resolved, false);

  const queue = buildAgentReviewQueue(root);
  assert.match(queue.note, /Human verification must happen/);
  assert.ok(Array.isArray(queue.queue));
});

test("CLI agent commands expose workspace targeting and annotations while reviews use the canonical review family", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const cli = path.resolve("bin/context-room.mjs");

  const annotation = JSON.parse(execFileSync(process.execPath, [cli, "agent", "annotate", "--root", root, "--path", "docs/guide.md", "--note", "Review this with the user."], { encoding: "utf8" }));
  assert.equal(annotation.annotation.path, "docs/guide.md");

  const reviews = JSON.parse(execFileSync(process.execPath, [cli, "review", "list", "--root", root, "--format=json"], { encoding: "utf8" }));
  assert.equal(reviews.command, "review.list");
  assert.ok(Array.isArray(reviews.data.queue));

  const rootHelp = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
  assert.doesNotMatch(rootHelp, /context-room agent state/);
  assert.doesNotMatch(rootHelp, /context-room workspace list/);
  const allHelp = execFileSync(process.execPath, [cli, "--help", "--all"], { encoding: "utf8" });
  assert.doesNotMatch(allHelp, /context-room workspace list/);
  assert.match(allHelp, /context-room ui list/);
  assert.doesNotMatch(allHelp, /context-room agent state/);
});

test("folder watch defaults and legacy watchAllow folders both stay recursive and live", () => {
  const defaultRoot = makeFolderWatchRoot();
  const defaultResult = writeFolderWatchRule(defaultRoot, { path: "docs" });

  assert.equal(defaultResult.rule.mode, "recursive-live");
  assert.equal(defaultResult.rule.path, "docs/");
  assert.equal(Object.hasOwn(defaultResult.rule, "files"), false);
  assert.deepEqual(defaultResult.settings.watchAllow, []);

  mutateFolderWatchFixture(defaultRoot);
  const defaultDeep = buildDocQaReport(defaultRoot).queue.find((item) => item.path === "docs/later-folder/deeper/later-deep.md");
  assert.equal(defaultDeep?.gitStatus, "??");

  const legacyRoot = makeFolderWatchRoot({ watchAllow: ["docs/"] });
  mutateFolderWatchFixture(legacyRoot);
  const legacySettings = readMemoryWebappSettings(legacyRoot);
  const legacyDeep = buildDocQaReport(legacyRoot).queue.find((item) => item.path === "docs/later-folder/deeper/later-deep.md");

  assert.deepEqual(legacySettings.watchAllow, ["docs/"]);
  assert.deepEqual(legacySettings.watchRules, []);
  assert.equal(watchStateForPath("docs/later-folder/deeper/later-deep.md", legacySettings), "watched-inherited");
  assert.equal(legacyDeep?.gitStatus, "??");
});

test("folder watch modes enforce recursive, direct, current, and future queue boundaries", () => {
  const cases = [
    {
      mode: "recursive-live",
      expected: [
        "docs/delete.md",
        "docs/direct.md",
        "docs/later-direct.md",
        "docs/later-folder/deeper/later-deep.md",
        "docs/nested/existing.md",
      ],
      snapshot: null,
    },
    {
      mode: "recursive-current",
      expected: ["docs/delete.md", "docs/direct.md", "docs/nested/existing.md"],
      snapshot: ["docs/delete.md", "docs/direct.md", "docs/nested/existing.md"],
    },
    {
      mode: "direct-current",
      expected: ["docs/delete.md", "docs/direct.md"],
      snapshot: ["docs/delete.md", "docs/direct.md"],
    },
    {
      mode: "direct-live",
      expected: ["docs/delete.md", "docs/direct.md", "docs/later-direct.md"],
      snapshot: null,
    },
  ];

  assert.deepEqual(WATCH_RULE_MODES, cases.map((item) => item.mode));
  for (const fixture of cases) {
    const root = makeFolderWatchRoot();
    const result = writeFolderWatchRule(root, { path: "docs/", mode: fixture.mode });
    if (fixture.snapshot) assert.deepEqual(result.rule.files, fixture.snapshot, `${fixture.mode} should freeze the intended current files`);
    else assert.equal(Object.hasOwn(result.rule, "files"), false, `${fixture.mode} should remain live instead of storing a snapshot`);

    mutateFolderWatchFixture(root);
    const queue = buildDocQaReport(root).queue;
    const paths = queue.map((item) => item.path).sort((left, right) => left.localeCompare(right, "en"));
    assert.deepEqual(paths, fixture.expected, `${fixture.mode} should expose only its selected folder scope`);

    const laterDirect = queue.find((item) => item.path === "docs/later-direct.md");
    const laterDeep = queue.find((item) => item.path === "docs/later-folder/deeper/later-deep.md");
    assert.equal(Boolean(laterDirect), fixture.mode === "recursive-live" || fixture.mode === "direct-live", `${fixture.mode} future-file behavior`);
    assert.equal(Boolean(laterDeep), fixture.mode === "recursive-live", `${fixture.mode} recursive future-file behavior`);
    if (laterDirect) assert.equal(laterDirect.gitStatus, "??");
    if (laterDeep) assert.equal(laterDeep.gitStatus, "??");
  }
});

test("external allowed folders use all four watch modes and baseline-backed review", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    const cases = [
      {
        mode: "recursive-live",
        initial: ["direct.md", "nested/existing.md"],
        changed: ["direct.md", "later-direct.md", "later-folder/deeper/later-deep.md", "nested/existing.md"],
        snapshot: ["direct.md", "nested/existing.md"],
      },
      {
        mode: "recursive-current",
        initial: ["direct.md", "nested/existing.md"],
        changed: ["direct.md", "nested/existing.md"],
        snapshot: ["direct.md", "nested/existing.md"],
      },
      {
        mode: "direct-current",
        initial: ["direct.md"],
        changed: ["direct.md"],
        snapshot: ["direct.md"],
      },
      {
        mode: "direct-live",
        initial: ["direct.md"],
        changed: ["direct.md", "later-direct.md"],
        snapshot: ["direct.md"],
      },
    ];

    for (const fixture of cases) {
      const suffix = fixture.mode.replaceAll("-", "_");
      const root = path.join(home, `project_${suffix}`);
      const externalRoot = path.join(home, `shared_${suffix}`);
      const virtualRoot = `~/shared_${suffix}/`;
      fs.mkdirSync(path.join(externalRoot, "nested"), { recursive: true });
      fs.mkdirSync(root, { recursive: true });
      fs.writeFileSync(path.join(externalRoot, "direct.md"), "# Direct\n");
      fs.writeFileSync(path.join(externalRoot, "nested", "existing.md"), "# Existing nested\n");
      initializeContextRoomProject(root, { allowedPaths: [virtualRoot], watchAllow: [] });

      assert.equal(isAllowedMemoryPath(`${virtualRoot}direct.md`, readMemoryWebappSettings(root)), true);
      const watched = writeFolderWatchRule(root, { path: virtualRoot, mode: fixture.mode });
      const expectedSnapshot = fixture.snapshot.map((relPath) => virtualRoot + relPath);
      if (fixture.mode.endsWith("-current")) assert.deepEqual(watched.rule.files, expectedSnapshot);
      else assert.equal("files" in watched.rule, false);

      const initial = buildDocQaReport(root).queue.filter((item) => item.externalWatch);
      assert.deepEqual(
        initial.map((item) => item.path).sort((left, right) => left.localeCompare(right, "en")),
        fixture.initial.map((relPath) => virtualRoot + relPath),
      );
      assert.ok(initial.every((item) => item.gitStatus === "??" && item.initialReview), `${fixture.mode} should label first-seen external files as new first reviews`);
      for (const item of initial) writeDocReviewDecision(root, item.path, { status: "verified", note: "external fixture reviewed" });
      assert.equal(buildDocQaReport(root).queue.some((item) => item.externalWatch), false);

      fs.writeFileSync(path.join(externalRoot, "direct.md"), "# Direct\n\nChanged.\n");
      fs.writeFileSync(path.join(externalRoot, "nested", "existing.md"), "# Existing nested\n\nChanged.\n");
      fs.writeFileSync(path.join(externalRoot, "later-direct.md"), "# Later direct\n");
      fs.mkdirSync(path.join(externalRoot, "later-folder", "deeper"), { recursive: true });
      fs.writeFileSync(path.join(externalRoot, "later-folder", "deeper", "later-deep.md"), "# Later deep\n");

      const changed = buildDocQaReport(root).queue.filter((item) => item.externalWatch);
      assert.deepEqual(
        changed.map((item) => item.path).sort((left, right) => left.localeCompare(right, "en")),
        fixture.changed.map((relPath) => virtualRoot + relPath),
      );
      assert.equal(changed.find((item) => item.path === virtualRoot + "direct.md")?.gitStatus, "M");
      const newDirect = changed.find((item) => item.path === virtualRoot + "later-direct.md");
      if (fixture.mode === "recursive-live" || fixture.mode === "direct-live") {
        assert.equal(newDirect?.gitStatus, "??");
        assert.equal(newDirect?.initialReview, true);
      } else {
        assert.equal(newDirect, undefined);
      }
      assert.equal(changed.some((item) => item.path === virtualRoot + "later-folder/deeper/later-deep.md"), fixture.mode === "recursive-live");

      const reviewBase = readReviewBaseFile(root, virtualRoot + "direct.md");
      assert.equal(reviewBase.available, true);
      assert.equal(reviewBase.baseline, "review");
      assert.equal(reviewBase.baseContent, "# Direct\n");
      assert.equal(reviewBase.currentContent, "# Direct\n\nChanged.\n");
      assert.equal(reviewBase.changeKind, "modified");
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("external allowed roots reject symlink escapes while an explicit symlink root remains authorized", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    const root = path.join(home, "project");
    const explicitRoot = path.join(home, "explicit-project");
    const shared = path.join(home, "shared");
    const outside = path.join(home, "outside");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(explicitRoot, { recursive: true });
    fs.mkdirSync(shared, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(shared, "guide.md"), "# Guide\n");
    fs.writeFileSync(path.join(outside, "outside.md"), "outside content\n");
    fs.symlinkSync(outside, path.join(shared, "escape"), "dir");
    fs.symlinkSync(path.join(outside, "outside.md"), path.join(shared, "linked.md"), "file");
    initializeContextRoomProject(root, { allowedPaths: ["~/shared/"], watchAllow: [] });

    const settings = readMemoryWebappSettings(root);
    assert.equal(isAllowedMemoryPath("~/shared/guide.md", settings), true);
    assert.equal(isAllowedMemoryPath("~/shared/escape/outside.md", settings), false);
    assert.equal(isAllowedMemoryPath("~/shared/linked.md", settings), false);
    assert.equal(readMemoryFile(root, "~/shared/guide.md").content, "# Guide\n");
    assert.throws(() => readMemoryFile(root, "~/shared/escape/outside.md"), /Path not allowed/);
    assert.throws(() => readMemoryFile(root, "~/shared/linked.md"), /Path not allowed/);
    assert.throws(() => writeMemoryFile(root, "~/shared/escape/outside.md", "overwritten\n"), /Path not allowed/);
    assert.throws(() => writeMemoryFile(root, "~/shared/linked.md", "overwritten\n"), /Path not allowed/);
    assert.equal(fs.readFileSync(path.join(outside, "outside.md"), "utf8"), "outside content\n");

    const legitimateWrite = writeMemoryFile(root, "~/shared/guide.md", "# Updated guide\n");
    assert.equal(legitimateWrite.path, "~/shared/guide.md");
    assert.equal(fs.readFileSync(path.join(shared, "guide.md"), "utf8"), "# Updated guide\n");

    initializeContextRoomProject(explicitRoot, { allowedPaths: ["~/shared/escape/"], watchAllow: [] });
    const explicitSettings = readMemoryWebappSettings(explicitRoot);
    assert.equal(isAllowedMemoryPath("~/shared/escape/outside.md", explicitSettings), true);
    assert.equal(readMemoryFile(explicitRoot, "~/shared/escape/outside.md").content, "outside content\n");
    writeMemoryFile(explicitRoot, "~/shared/escape/authorized.md", "explicitly authorized\n");
    assert.equal(fs.readFileSync(path.join(outside, "authorized.md"), "utf8"), "explicitly authorized\n");
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("external folder traversal, deletion, and watch snapshots stay inside the configured real root", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    const root = path.join(home, "project");
    const shared = path.join(home, "shared");
    const outside = path.join(home, "outside");
    fs.mkdirSync(path.join(shared, "nested"), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(shared, "direct.md"), "# Direct\n");
    fs.writeFileSync(path.join(shared, "delete-me.md"), "# Delete me\n");
    fs.writeFileSync(path.join(shared, "nested", "inside.md"), "# Inside\n");
    fs.writeFileSync(path.join(outside, "outside.md"), "# Outside\n");
    fs.symlinkSync(outside, path.join(shared, "escape"), "dir");
    fs.symlinkSync(path.join(outside, "outside.md"), path.join(shared, "linked.md"), "file");
    initializeContextRoomProject(root, { allowedPaths: ["~/shared/"], watchAllow: [] });

    const listedPaths = listMemoryFiles(root).map((file) => file.path);
    assert.deepEqual(
      listedPaths.filter((filePath) => filePath.startsWith("~/shared/")).sort((left, right) => left.localeCompare(right, "en")),
      ["~/shared/delete-me.md", "~/shared/direct.md", "~/shared/nested/inside.md"],
    );
    const directories = listExplorerDirectories(root).map((directory) => directory.path);
    assert.equal(directories.includes("~/shared/nested/"), true);
    assert.equal(directories.some((directory) => directory.startsWith("~/shared/escape")), false);

    const watched = writeFolderWatchRule(root, { path: "~/shared/", mode: "recursive-current" });
    assert.deepEqual(watched.rule.files, ["~/shared/delete-me.md", "~/shared/direct.md", "~/shared/nested/inside.md"]);
    assert.throws(
      () => writeFolderWatchRule(root, { path: "~/shared/escape/", mode: "recursive-current" }),
      /not covered by allowedPaths/,
    );

    assert.throws(() => deleteMemoryPaths(root, ["~/shared/escape/outside.md"]), /Path not allowed/);
    assert.throws(() => deleteMemoryPaths(root, ["~/shared/escape/"]), /Path not allowed/);
    assert.throws(() => deleteMemoryPaths(root, ["~/shared/linked.md"]), /Path not allowed/);
    assert.equal(fs.readFileSync(path.join(outside, "outside.md"), "utf8"), "# Outside\n");
    assert.equal(fs.existsSync(path.join(shared, "escape")), true);
    assert.equal(fs.existsSync(path.join(shared, "linked.md")), true);

    const deleted = deleteMemoryPaths(root, ["~/shared/delete-me.md"]);
    assert.deepEqual(deleted.deleted, ["~/shared/delete-me.md"]);
    assert.equal(fs.existsSync(path.join(shared, "delete-me.md")), false);
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("external watched deletions retain their reviewed baseline and unauthorized home paths stay closed", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    const root = path.join(home, "project");
    const externalRoot = path.join(home, "shared");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.writeFileSync(path.join(externalRoot, "delete.md"), "# Delete me\n");
    initializeContextRoomProject(root, { allowedPaths: ["~/shared/"], watchAllow: [] });
    writeFolderWatchRule(root, { path: "~/shared/", mode: "recursive-live" });
    writeDocReviewDecision(root, "~/shared/delete.md", { status: "verified", note: "external fixture reviewed" });

    fs.unlinkSync(path.join(externalRoot, "delete.md"));
    const deletionReport = buildDocQaReport(root);
    const deletion = deletionReport.queue.find((item) => item.path === "~/shared/delete.md");
    const reviewBase = readReviewBaseFile(root, "~/shared/delete.md");
    assert.equal(deletion?.gitStatus, "D");
    assert.equal(deletion?.resourceState, "absent");
    assert.equal(deletionReport.summary.deletedDocs, 1);
    assert.equal(deletionReport.summary.protectedDeletedDocs, 0);
    assert.equal(reviewBase.available, true);
    assert.equal(reviewBase.changeKind, "deleted");
    assert.equal(reviewBase.baseContent, "# Delete me\n");
    assert.equal(reviewBase.currentContent, "");

    writeDocReviewDecision(root, deletion.path, {
      status: "verified",
      note: "external deletion reviewed",
      expectedResourceState: deletion.resourceState,
      expectedResourceVersion: deletion.resourceVersion,
    });
    const afterDeletionReview = buildDocQaReport(root);
    assert.equal(afterDeletionReview.queue.some((item) => item.path === "~/shared/delete.md"), false);
    assert.equal(afterDeletionReview.summary.deletedDocs, 0);

    const doctor = buildContextRoomDoctorReport(root);
    assert.equal(doctor.issues.some((issue) => issue.severity === "high" && issue.type.startsWith("watch_rule")), false);

    const closedRoot = path.join(home, "closed-project");
    fs.mkdirSync(path.join(closedRoot, "docs"), { recursive: true });
    initializeContextRoomProject(closedRoot, { allowedPaths: ["docs/"], watchAllow: [] });
    assert.equal(isAllowedMemoryPath("~/shared/delete.md", readMemoryWebappSettings(closedRoot)), false);
    assert.equal(listMemoryFiles(closedRoot).some((file) => file.path.startsWith("~/shared/")), false);
    assert.throws(
      () => writeFolderWatchRule(closedRoot, { path: "~/shared/", mode: "recursive-live" }),
      /not covered by allowedPaths/,
    );
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("external watched files deleted before their first decision remain queued in live and current modes", () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  try {
    for (const mode of WATCH_RULE_MODES) {
      const suffix = mode.replaceAll("-", "_");
      const root = path.join(home, `project_${suffix}`);
      const externalRoot = path.join(home, `shared_${suffix}`);
      const virtualRoot = `~/shared_${suffix}/`;
      const watchedPath = virtualRoot + "pending.md";
      const snapshotOnlyPath = virtualRoot + "deleted-before-observation.md";
      fs.mkdirSync(root, { recursive: true });
      fs.mkdirSync(externalRoot, { recursive: true });
      fs.writeFileSync(path.join(externalRoot, "pending.md"), "# Pending review\n");
      if (mode.endsWith("-current")) {
        fs.writeFileSync(path.join(externalRoot, "deleted-before-observation.md"), "# Snapshot only\n");
      }
      initializeContextRoomProject(root, { allowedPaths: [virtualRoot], watchAllow: [] });
      writeFolderWatchRule(root, { path: virtualRoot, mode });
      if (mode.endsWith("-current")) {
        fs.unlinkSync(path.join(externalRoot, "deleted-before-observation.md"));
      }

      const initialQueue = buildDocQaReport(root).queue;
      const initial = initialQueue.find((item) => item.path === watchedPath);
      assert.equal(initial?.gitStatus, "??", `${mode} should queue the first-seen file`);
      assert.equal(initial?.initialReview, true, `${mode} should require a first human decision`);
      if (mode.endsWith("-current")) {
        assert.equal(initialQueue.find((item) => item.path === snapshotOnlyPath)?.gitStatus, "D", `${mode} should retain a snapshotted file deleted before observation`);
      }

      fs.unlinkSync(path.join(externalRoot, "pending.md"));
      const deleted = buildDocQaReport(root).queue.find((item) => item.path === watchedPath);
      const reviewBase = readReviewBaseFile(root, watchedPath);
      assert.equal(deleted?.gitStatus, "D", `${mode} should retain the observed deletion`);
      assert.equal(deleted?.resourceState, "absent");
      assert.equal(typeof deleted?.resourceVersion, "string");
      assert.equal(reviewBase.baseContent, "# Pending review\n");
      assert.equal(reviewBase.currentContent, "");
      assert.equal(reviewBase.changeKind, "deleted");
    }
  } finally {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("external watched file changes invalidate cached reports", async () => {
  const originalHome = process.env.HOME;
  const home = makeRoot();
  process.env.HOME = home;
  let server = null;
  try {
    const root = path.join(home, "project");
    const externalRoot = path.join(home, "shared");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(externalRoot, { recursive: true });
    fs.writeFileSync(path.join(externalRoot, "guide.md"), "# Guide\n");
    initializeContextRoomProject(root, { allowedPaths: ["~/shared/"], watchAllow: [] });
    writeFolderWatchRule(root, { path: "~/shared/", mode: "recursive-live" });
    writeDocReviewDecision(root, "~/shared/guide.md", { status: "verified", note: "external fixture reviewed" });

    ({ server } = createMemoryServer({ root }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const initial = await (await fetch(baseUrl + "/api/reports")).json();
    assert.equal(initial.docqa.queue.some((item) => item.path === "~/shared/guide.md"), false);

    await new Promise((resolve) => setTimeout(resolve, 300));
    fs.writeFileSync(path.join(externalRoot, "guide.md"), "# Guide\n\nChanged outside the repo.\n");
    let refreshed = initial;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && refreshed.generatedAt === initial.generatedAt) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      refreshed = await (await fetch(baseUrl + "/api/reports")).json();
    }
    assert.notEqual(refreshed.generatedAt, initial.generatedAt);
    assert.equal(refreshed.docqa.queue.find((item) => item.path === "~/shared/guide.md")?.gitStatus, "M");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("short-lived watched files cannot crash background invalidation", async () => {
  const originalHome = process.env.HOME;
  const home = fs.realpathSync(makeRoot());
  process.env.HOME = home;
  let server = null;
  const originalStatSync = fs.statSync;
  try {
    const root = path.join(home, "project");
    const gitRoot = path.join(root, ".git");
    const ignoredLockPath = path.join(gitRoot, "index.lock");
    const transientPath = path.join(gitRoot, "context-room-transient.lock");
    fs.mkdirSync(gitRoot, { recursive: true });
    initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: [] });

    ({ server } = createMemoryServer({ root }));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const initial = await (await fetch(baseUrl + "/api/reports")).json();
    await new Promise((resolve) => setTimeout(resolve, 300));

    let ignoredLockStatObserved = false;
    let transientStatObserved = false;
    fs.statSync = (...args) => {
      const target = path.resolve(String(args[0]));
      if (target === ignoredLockPath) ignoredLockStatObserved = true;
      if (target === transientPath) {
        transientStatObserved = true;
        const error = new Error(`ENOENT: no such file or directory, stat '${transientPath}'`);
        error.code = "ENOENT";
        throw error;
      }
      return originalStatSync(...args);
    };

    fs.writeFileSync(ignoredLockPath, "");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(ignoredLockStatObserved, false);

    fs.writeFileSync(transientPath, "");
    let refreshed = initial;
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline && (!transientStatObserved || refreshed.generatedAt === initial.generatedAt)) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      refreshed = await (await fetch(baseUrl + "/api/reports")).json();
    }
    assert.equal(transientStatObserved, true);
    assert.notEqual(refreshed.generatedAt, initial.generatedAt);
  } finally {
    fs.statSync = originalStatSync;
    if (server) await new Promise((resolve) => server.close(resolve));
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }
});

test("current-only folder watch snapshots keep later files out but retain tracked deletions", () => {
  const root = makeFolderWatchRoot();
  const result = writeFolderWatchRule(root, { path: "docs/", mode: "recursive-current" });
  assert.ok(result.rule.files.includes("docs/delete.md"));

  fs.unlinkSync(path.join(root, "docs", "delete.md"));
  fs.writeFileSync(path.join(root, "docs", "later.md"), "# Later\n");
  const report = buildDocQaReport(root);
  const deletion = report.queue.find((item) => item.path === "docs/delete.md");

  assert.equal(deletion?.gitStatus.trim(), "D");
  assert.equal(report.queue.some((item) => item.path === "docs/later.md"), false);
  assert.equal(watchStateForPath("docs/delete.md", readMemoryWebappSettings(root)), "watched-inherited");
});

test("the human owner may authorize a most-specific child rule that narrows a broad legacy parent", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "narrow", "deeper"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "outside.md"), "# Outside\n");
  fs.writeFileSync(path.join(root, "docs", "narrow", "direct.md"), "# Direct\n");
  fs.writeFileSync(path.join(root, "docs", "narrow", "deeper", "deep.md"), "# Deep\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });

  writeFolderWatchRule(root, { path: "docs/narrow/", mode: "direct-live" });
  authorizeOwnerReviewScope(root, readMemoryWebappSettings(root), { actor: "test-human-owner" });
  fs.writeFileSync(path.join(root, "docs", "outside.md"), "# Outside\n\nChanged.\n");
  fs.writeFileSync(path.join(root, "docs", "narrow", "direct.md"), "# Direct\n\nChanged.\n");
  fs.writeFileSync(path.join(root, "docs", "narrow", "deeper", "deep.md"), "# Deep\n\nChanged.\n");

  const settings = readMemoryWebappSettings(root);
  const queuePaths = buildDocQaReport(root).queue.map((item) => item.path).sort((left, right) => left.localeCompare(right, "en"));
  assert.deepEqual(settings.watchAllow, ["docs/"]);
  assert.deepEqual(queuePaths, ["docs/narrow/direct.md", "docs/outside.md"]);
  assert.equal(watchStateForPath("docs/outside.md", settings), "watched-inherited");
  assert.equal(watchStateForPath("docs/narrow/direct.md", settings), "watched-inherited");
  assert.equal(watchStateForPath("docs/narrow/deeper/deep.md", settings), "");
  assert.equal(explorerWatchFilterMatches("docs/narrow/deeper/deep.md", "watched", settings), false);
  assert.equal(explorerWatchFilterMatches("docs/narrow/deeper/deep.md", "unwatched", settings), true);
});

test("watch state and Explorer filters honor current-file snapshots", () => {
  const settings = {
    watchAllow: [],
    watchRules: [{ path: "docs/", mode: "recursive-current", files: ["docs/direct.md"] }],
  };

  assert.equal(watchStateForPath("docs", settings), "watched");
  assert.equal(watchStateForPath("docs/direct.md", settings), "watched-inherited");
  assert.equal(watchStateForPath("docs/later.md", settings), "");
  assert.equal(explorerWatchFilterMatches("docs/direct.md", "watched", settings), true);
  assert.equal(explorerWatchFilterMatches("docs/direct.md", "unwatched", settings), false);
  assert.equal(explorerWatchFilterMatches("docs/later.md", "watched", settings), false);
  assert.equal(explorerWatchFilterMatches("docs/later.md", "unwatched", settings), true);
  assert.equal(explorerWatchFilterMatches("docs/later.md", "all", settings), true);
});

test("folder watch helpers and API add, replace, expose, and remove structured rules", async (t) => {
  const root = makeFolderWatchRoot({ watchAllow: ["docs/"] });
  const direct = writeFolderWatchRule(root, { path: "docs/", mode: "recursive-current" });
  assert.deepEqual(direct.settings.watchAllow, []);
  assert.deepEqual(direct.rule.files, ["docs/delete.md", "docs/direct.md", "docs/nested/existing.md"]);
  assert.equal(removeFolderWatchRule(root, { path: "docs" }).removed, true);
  assert.deepEqual(readMemoryWebappSettings(root).watchRules, []);

  const { server, ownerMutationNonce } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const addResponse = await fetch(baseUrl + "/api/watch-rule", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ path: "docs/", mode: "direct-current" }),
  });
  const added = await addResponse.json();
  assert.equal(addResponse.status, 200);
  assert.equal(added.rule.mode, "direct-current");
  assert.equal(added.matchedFiles, 2);
  assert.deepEqual(added.rule.files, ["docs/delete.md", "docs/direct.md"]);

  const settingsResponse = await fetch(baseUrl + "/api/settings");
  const settingsPayload = await settingsResponse.json();
  assert.equal(settingsResponse.status, 200);
  assert.deepEqual(settingsPayload.settings.watchRules, [added.rule]);

  const removeResponse = await fetch(baseUrl + "/api/watch-rule", {
    method: "DELETE",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ path: "docs" }),
  });
  const removed = await removeResponse.json();
  assert.equal(removeResponse.status, 200);
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.settings.watchRules, []);
  assert.deepEqual(readMemoryWebappSettings(root).watchRules, []);
});

test("doctor accepts legacy settings objects that predate structured watch rules", () => {
  const root = makeRoot();
  const legacySettings = createDefaultProjectConfig();
  delete legacySettings.watchRules;

  const report = buildContextRoomDoctorReport(root, {
    settings: legacySettings,
    graph: { healthIssues: [], summary: {} },
    docqa: { summary: {} },
  });

  assert.equal(report.settings.watchRules, 0);
});

test("doctor distinguishes missing and non-directory project folder watch rules without invalidating deleted snapshots", () => {
  const root = makeFolderWatchRoot();
  const currentOnly = writeFolderWatchRule(root, { path: "docs/", mode: "recursive-current" });
  fs.writeFileSync(path.join(root, "docs", "not-a-folder"), "This is a file.\n");
  fs.unlinkSync(path.join(root, "docs", "delete.md"));
  writeMemoryWebappSettings(root, {
    ...currentOnly.settings,
    watchRules: [
      ...currentOnly.settings.watchRules,
      { path: "docs/missing/", mode: "recursive-live" },
      { path: "docs/not-a-folder/", mode: "direct-live" },
    ],
  });

  const report = buildContextRoomDoctorReport(root);
  const missing = report.issues.find((issue) => issue.type === "watch_rule_path_missing" && issue.path === "docs/missing/");
  const notDirectory = report.issues.find((issue) => issue.type === "watch_rule_path_not_directory" && issue.path === "docs/not-a-folder/");
  const deletion = buildDocQaReport(root).queue.find((item) => item.path === "docs/delete.md");

  assert.equal(missing?.severity, "medium");
  assert.match(missing?.message || "", /does not exist/);
  assert.equal(notDirectory?.severity, "high");
  assert.match(notDirectory?.message || "", /not a directory/);
  assert.equal(report.issues.some((issue) => issue.path === "docs/delete.md" && issue.type.startsWith("watch_rule_path_")), false);
  assert.equal(deletion?.gitStatus.trim(), "D");
});

test("invalid folder watch modes, paths, and snapshot members never mutate config", () => {
  const root = makeFolderWatchRoot();
  const configPath = path.join(root, CONFIG_FILE);
  const initialSettings = readMemoryWebappSettings(root);
  const initialConfig = fs.readFileSync(configPath, "utf8");
  const expectUnchanged = (operation, pattern) => {
    assert.throws(operation, pattern);
    assert.equal(fs.readFileSync(configPath, "utf8"), initialConfig);
  };

  expectUnchanged(() => writeFolderWatchRule(root, { path: "docs/", mode: "sometimes" }), /must be one of/);
  expectUnchanged(() => writeFolderWatchRule(root, { path: "..\/docs", mode: "recursive-live" }), /safe relative/);
  expectUnchanged(() => writeFolderWatchRule(root, { path: "src/", mode: "recursive-live" }), /not covered by allowedPaths/);
  expectUnchanged(() => writeMemoryWebappSettings(root, {
    ...initialSettings,
    watchRules: [{ path: "docs/", mode: "recursive-current" }],
  }), /files is required/);
  expectUnchanged(() => writeMemoryWebappSettings(root, {
    ...initialSettings,
    watchRules: [{ path: "docs/", mode: "recursive-current", files: ["outside.md"] }],
  }), /is outside docs\//);
  expectUnchanged(() => writeMemoryWebappSettings(root, {
    ...initialSettings,
    watchRules: [{ path: "docs/", mode: "direct-current", files: ["docs/nested/existing.md"] }],
  }), /not a direct child/);
  expectUnchanged(() => writeMemoryWebappSettings(root, {
    ...initialSettings,
    watchRules: [{ path: "docs/", mode: "recursive-current", files: ["..\/private.md"] }],
  }), /not a safe relative path/);
});

test("doc QA detects watched changes when context root is a git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "example-app");
  fs.mkdirSync(root);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n");
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md"], watchAllow: ["AGENTS.md"] });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n\nUpdated routing.\n");

  const report = buildDocQaReport(root);

  assert.equal(report.summary.changedDocs, 1);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(report.queue[0].path, "AGENTS.md");
  assert.equal(report.queue[0].gitStatus.trim(), "M");
});

test("doc QA reports Git renames as a single renamed review item", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "agent-bridge.md"), "# Agent Bridge\n\nCLI contract.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["mv", "docs/agent-bridge.md", "docs/agent-cli.md"], { cwd: root, stdio: "ignore" });

  const report = buildDocQaReport(root);
  const item = report.queue[0];
  const reviewBase = readReviewBaseFile(root, "docs/agent-cli.md");
  const diff = readFileDiff(root, "docs/agent-cli.md");

  assert.equal(report.summary.changedDocs, 1);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(item.path, "docs/agent-cli.md");
  assert.equal(item.oldPath, "docs/agent-bridge.md");
  assert.equal(item.gitStatus.trim(), "R");
  assert.equal(reviewBase.changeKind, "renamed");
  assert.equal(reviewBase.oldPath, "docs/agent-bridge.md");
  assert.equal(reviewBase.baseContent, "# Agent Bridge\n\nCLI contract.\n");
  assert.match(diff.patch, /rename from docs\/agent-bridge\.md/);
  assert.match(diff.patch, /rename to docs\/agent-cli\.md/);
});

test("doc QA infers unstaged filesystem renames before Git reports R status", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "agent-bridge.md"), "# Agent Bridge\n\nThe agent bridge lets coding agents open docs through the CLI.\n\n## Rules\n\n- Agents can navigate and annotate.\n- Humans verify the review queue.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.renameSync(path.join(root, "docs", "agent-bridge.md"), path.join(root, "docs", "agent-cli.md"));
  fs.writeFileSync(path.join(root, "docs", "agent-cli.md"), "# Agent CLI\n\nThe agent CLI lets coding agents open docs through the CLI.\n\n## Rules\n\n- Agents can navigate and annotate.\n- Humans verify the review queue.\n");

  const report = buildDocQaReport(root);
  const reviewBase = readReviewBaseFile(root, "docs/agent-cli.md");
  const diff = readFileDiff(root, "docs/agent-cli.md");

  assert.equal(report.summary.changedDocs, 1);
  assert.equal(report.summary.needsReview, 1);
  assert.equal(report.queue[0].path, "docs/agent-cli.md");
  assert.equal(report.queue[0].oldPath, "docs/agent-bridge.md");
  assert.equal(report.queue[0].gitStatus.trim(), "R");
  assert.equal(report.queue.some((item) => item.path === "docs/agent-bridge.md"), false);
  assert.equal(reviewBase.changeKind, "renamed");
  assert.equal(reviewBase.oldPath, "docs/agent-bridge.md");
  assert.match(reviewBase.baseContent, /# Agent Bridge/);
  assert.match(diff.patch, /rename from docs\/agent-bridge\.md/);
  assert.match(diff.patch, /rename to docs\/agent-cli\.md/);
});

test("doc QA infers review-baseline renames for untracked verified docs", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "--allow-empty", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "app-overview.md"), "---\ncontext_room:\n  kind: canonical\n  scope: context-room\n  status: current\n  canonical_for: app overview\n---\n\n# App Overview\n\nContext Room maps docs and source files.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"], reviewPaths: ["docs/"] });
  writeDocReviewBaseline(root, "docs/app-overview.md", { note: "verified from Context Room review queue" });

  fs.renameSync(path.join(root, "docs", "app-overview.md"), path.join(root, "docs", "product-overview.md"));
  fs.writeFileSync(path.join(root, "docs", "product-overview.md"), "---\ncontext_room:\n  kind: canonical\n  scope: context-room\n  status: current\n  canonical_for: product overview\n---\n\n# Product Overview\n\nContext Room maps docs and source files.\n");

  const report = buildDocQaReport(root);
  const item = report.queue.find((entry) => entry.path === "docs/product-overview.md");
  const reviewBase = readReviewBaseFile(root, "docs/product-overview.md");
  const diff = readFileDiff(root, "docs/product-overview.md");
  const deletionBatch = buildDeletedReviewBatch(root);

  assert.ok(item);
  assert.equal(item.oldPath, "docs/app-overview.md");
  assert.equal(item.gitStatus.trim(), "R");
  assert.equal(report.queue.some((entry) => entry.path === "docs/app-overview.md"), false);
  assert.equal(deletionBatch.items.some((entry) => entry.path === "docs/app-overview.md"), false);
  assert.equal(reviewBase.changeKind, "renamed");
  assert.equal(reviewBase.oldPath, "docs/app-overview.md");
  assert.match(reviewBase.baseContent, /# App Overview/);
  assert.match(diff.patch, /rename from docs\/app-overview\.md/);
  assert.match(diff.patch, /rename to docs\/product-overview\.md/);
});

test("batch deletion review records absent resources and revalidates every selected path", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/alpha.md"), "# Alpha\n\nLegacy alpha instructions.\n");
  fs.writeFileSync(path.join(root, "docs/beta.md"), "---\ncontext_room:\n  kind: canonical\n  scope: demo\n  status: current\n  canonical_for: beta\n  sources: []\n---\n\n# Beta\n\nLegacy beta instructions.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/alpha.md"));
  fs.unlinkSync(path.join(root, "docs/beta.md"));
  fs.writeFileSync(path.join(root, "docs/reworked.md"), "# Reworked\n\nConsolidated architecture and fresh workflow.\n");

  const before = buildDocQaReport(root);
  const batch = buildDeletedReviewBatch(root);

  assert.equal(before.summary.deletedDocs, 2);
  assert.equal(before.summary.protectedDeletedDocs, 1);
  assert.equal(batch.count, 2);
  assert.equal(batch.protectedCount, 1);
  assert.deepEqual(batch.items.map((item) => item.path).sort(), ["docs/alpha.md", "docs/beta.md"]);

  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["docs/alpha.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  const reclassifiedBatch = buildDeletedReviewBatch(root);
  assert.equal(reclassifiedBatch.key, batch.key, "legacy reviewPaths no longer changes deletion classification or ordering");
  assert.equal(reclassifiedBatch.protectedCount, 1);
  config.reviewPaths = [];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const result = writeDeletedReviewBatchDecision(root, ["docs/alpha.md", "docs/beta.md", "docs/reworked.md"], { protectedAcknowledged: true });
  assert.deepEqual(result.confirmed.sort(), ["docs/alpha.md", "docs/beta.md"]);
  assert.equal(result.protectedConfirmed, 1);
  assert.deepEqual(result.skipped, [{ path: "docs/reworked.md", reason: "not_pending_deletion" }]);

  const localState = JSON.parse(fs.readFileSync(path.join(root, ".context-room/review-state.json"), "utf8"));
  assert.equal(localState.reviews["docs/alpha.md"].resourceState, "absent");
  assert.equal(localState.reviews["docs/beta.md"].resourceState, "absent");
  assert.match(localState.reviews["docs/alpha.md"].resourceVersion, /^git-path:[a-f0-9]{40,64}$/);
  assert.equal(Object.values(readGlobalReviewLedger(root).reviews).filter((review) => review.resourceState === "absent").length, 2);
  const after = buildDocQaReport(root);
  assert.equal(after.summary.deletedDocs, 0);
  assert.equal(after.queue.some((item) => item.path === "docs/reworked.md"), true);

  buildDocQaReport(root, {
    files: [{
      path: "docs/alpha.md",
      exists: true,
      content: "# Stale worker snapshot\n",
      contentHash: createHash("sha256").update("# Stale worker snapshot\n").digest("hex"),
      bytes: 24,
      updatedAt: new Date().toISOString(),
    }],
  });
  const afterStaleSnapshot = JSON.parse(fs.readFileSync(path.join(root, ".context-room/review-state.json"), "utf8"));
  assert.equal(afterStaleSnapshot.reviews["docs/alpha.md"].resourceState, "absent", "a stale present-file snapshot must not clear a physically absent receipt");
  assert.equal(
    Object.values(readGlobalReviewLedger(root).reviews).some((review) => review.relPath === "docs/alpha.md" && review.resourceState === "absent"),
    true,
    "the global absent receipt must also survive a stale present-file snapshot",
  );

  fs.writeFileSync(path.join(root, "docs/alpha.md"), "# Alpha\n\nLegacy alpha instructions.\n");
  buildDocQaReport(root);
  const afterPhysicalRestore = JSON.parse(fs.readFileSync(path.join(root, ".context-room/review-state.json"), "utf8"));
  assert.equal(afterPhysicalRestore.reviews["docs/alpha.md"], undefined, "a physically recreated file must clear its absent receipt");
  assert.equal(
    Object.values(readGlobalReviewLedger(root).reviews).some((review) => review.relPath === "docs/alpha.md" && review.resourceState === "absent"),
    false,
    "the global absent receipt must be cleared after physical recreation",
  );
  fs.unlinkSync(path.join(root, "docs/alpha.md"));
  const deletedAfterRestore = buildDocQaReport(root);
  assert.equal(deletedAfterRestore.queue.some((item) => item.path === "docs/alpha.md"), true, "restoring a path clears its earlier absent-resource review");

  fs.writeFileSync(path.join(root, "docs/alpha.md"), "");
  const recreated = buildDocQaReport(root);
  assert.equal(recreated.queue.some((item) => item.path === "docs/alpha.md"), true, "a present empty file must not inherit an absent-resource review");
  execFileSync("git", ["add", "docs/alpha.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "recreate alpha"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/alpha.md"));
  const deletedAgain = buildDocQaReport(root);
  assert.equal(deletedAgain.queue.some((item) => item.path === "docs/alpha.md"), true, "a later deletion at the same path must receive a new review");
});

test("deleted review batch exposes the full set beyond the eighty-item queue cap", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  for (let index = 0; index < 85; index += 1) {
    fs.writeFileSync(path.join(root, "docs", "legacy-" + String(index).padStart(2, "0") + ".md"), "# Legacy " + index + "\n\nOld source " + index + ".\n");
  }
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  for (const file of fs.readdirSync(path.join(root, "docs"))) fs.unlinkSync(path.join(root, "docs", file));

  const report = buildDocQaReport(root);
  const batch = buildDeletedReviewBatch(root);

  assert.equal(report.summary.deletedDocs, 85);
  assert.equal(report.queue.length, 80);
  assert.equal(report.pendingPaths.length, 85);
  assert.equal(batch.count, 85);
  assert.equal(batch.items.length, 85);
});

test("deleted review batch protects paths whose historical content cannot be inspected safely", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/large.md"), "# Large\n\n" + "x".repeat(760_000));
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/large.md"));

  const batch = buildDeletedReviewBatch(root);

  assert.equal(batch.count, 1);
  assert.equal(batch.protectedCount, 1);
  assert.equal(batch.items[0].contentUnavailable, true);
});

test("unmerged deletion conflicts stay individual and out of the deletion batch", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const settings = readMemoryWebappSettings(root);
  const report = buildDocQaReport(root, {
    gitStatuses: new Map([["docs/conflict.md", { path: "docs/conflict.md", status: "DD", oldPath: null }]]),
    gitHeadContents: new Map([["docs/conflict.md", "# Conflicted deletion\n"]]),
    settings,
    reviewState: { version: 1, reviews: {} },
    files: [],
    startupFiles: [],
  });

  assert.equal(report.summary.deletedDocs, 0);
  assert.equal(report.queue.length, 1);
  assert.equal(report.queue[0].path, "docs/conflict.md");
  assert.equal(report.queue[0].batchDeletion, false);
  assert.equal(report.queue[0].issues[0].type, "git_conflict");
});

test("deleted review batch applies its cap after filtering already confirmed removals", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  const paths = [];
  for (let index = 0; index < 5002; index += 1) {
    const relPath = "docs/legacy-" + String(index).padStart(4, "0") + ".md";
    paths.push(relPath);
    fs.writeFileSync(path.join(root, relPath), "# Legacy " + index + "\n");
  }
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  for (const relPath of paths) fs.unlinkSync(path.join(root, relPath));

  const emptyHash = createHash("sha256").update("").digest("hex");
  const reviews = Object.fromEntries(paths.slice(0, 5000).map((relPath) => [relPath, {
    status: "verified",
    contentHash: emptyHash,
    reviewHash: emptyHash,
    resourceState: "absent",
    resourceVersion: "git-path:" + revision,
  }]));
  fs.writeFileSync(path.join(root, ".context-room/review-state.json"), JSON.stringify({ version: 1, reviews }) + "\n");

  const batch = buildDeletedReviewBatch(root);

  assert.equal(batch.count, 2);
  assert.equal(batch.truncated, false);
  assert.deepEqual(batch.items.map((item) => item.path), paths.slice(5000));
});

test("deleted review batch API lists and confirms the current server-validated set", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"));
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/one.md"), "# One\n\nFirst old doc.\n");
  fs.writeFileSync(path.join(root, "docs/two.md"), "# Two\n\nSecond old doc.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.unlinkSync(path.join(root, "docs/one.md"));
  fs.unlinkSync(path.join(root, "docs/two.md"));
  const { server, ownerMutationNonce } = createMemoryServer({ root });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const listed = await (await fetch(baseUrl + "/api/docqa/review-deletions")).json();
  assert.equal(listed.count, 2);

  const firstConfirmation = await fetch(baseUrl + "/api/docqa/review-deletions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ paths: ["docs/two.md"], key: listed.key }),
  });
  assert.equal(firstConfirmation.status, 200);
  const staleResponse = await fetch(baseUrl + "/api/docqa/review-deletions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ paths: ["docs/one.md"], key: listed.key, protectedAcknowledged: true }),
  });
  assert.equal(staleResponse.status, 409);
  assert.match((await staleResponse.json()).error, /changed since this batch was loaded/);

  const relisted = await (await fetch(baseUrl + "/api/docqa/review-deletions")).json();
  assert.notEqual(relisted.key, listed.key);
  assert.equal(relisted.count, 1);

  const confirmed = await (await fetch(baseUrl + "/api/docqa/review-deletions", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": ownerMutationNonce },
    body: JSON.stringify({ paths: ["docs/one.md", "docs/missing.md"], key: relisted.key, protectedAcknowledged: true }),
  })).json();
  assert.deepEqual(confirmed.confirmed, ["docs/one.md"]);
  assert.deepEqual(confirmed.skipped, [{ path: "docs/missing.md", reason: "not_pending_deletion" }]);
  assert.equal(confirmed.docqa.summary.deletedDocs, 0);

  const remaining = await (await fetch(baseUrl + "/api/docqa/review-deletions")).json();
  assert.deepEqual(remaining.items, []);
});

test("doc QA review queue follows a human docs verification order", () => {
  const root = makeRoot();
  const files = [
    ["AGENTS.md", "agents", "root-agent-routing"],
    ["docs/INDEX.md", "index", "global-docs-navigation"],
    ["docs/PRODUCT.md", "canonical", "global-product"],
    ["website/docs/INDEX.md", "index", "website-docs-navigation"],
    ["website/docs/PRODUCT.md", "canonical", "website-product"],
    ["our_agentic_system/AGENTS.md", "agents", "runtime-agent-routing"],
    ["our_agentic_system/docs/INDEX.md", "index", "runtime-docs-navigation"],
    ["our_agentic_system/docs/PRODUCT.md", "canonical", "runtime-product"],
    [".codex/skills/README.md", "index", "project-skill-routing"],
  ];
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  for (const [relPath, kind, canonicalFor] of files) {
    fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root, relPath), `---
context_room:
  kind: ${kind}
  scope: test
  status: current
  canonical_for: ${canonicalFor}
  last_verified: 2026-06-30
  sources: []
---

# ${relPath}
`);
  }
  initializeContextRoomProject(root, {
    allowedPaths: ["AGENTS.md", "docs/", "website/docs/", "our_agentic_system/AGENTS.md", "our_agentic_system/docs/", ".codex/skills/"],
    watchAllow: ["AGENTS.md", "docs/", "website/docs/", "our_agentic_system/AGENTS.md", "our_agentic_system/docs/", ".codex/skills/"],
  });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  for (const [relPath] of files) fs.appendFileSync(path.join(root, relPath), "\nUpdated.\n");

  const report = buildDocQaReport(root);

  assert.deepEqual(report.queue.map((item) => item.path), files.map(([relPath]) => relPath));
});

test("legacy reviewPaths join the watched scope without defining queue order", () => {
  const root = makeRoot();
  const files = ["AGENTS.md", "docs/PRODUCT.md", "website/docs/PRODUCT.md"];
  for (const relPath of files) {
    fs.mkdirSync(path.dirname(path.join(root, relPath)), { recursive: true });
    fs.writeFileSync(path.join(root, relPath), `# ${relPath}\n`);
  }
  const reviewPaths = ["website/docs/PRODUCT.md", "AGENTS.md", "docs/PRODUCT.md"];
  initializeContextRoomProject(root, {
    allowedPaths: ["AGENTS.md", "docs/", "website/docs/"],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = reviewPaths;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const report = buildDocQaReport(root);

  assert.deepEqual(report.queue.map((item) => item.path), ["AGENTS.md", "docs/PRODUCT.md", "website/docs/PRODUCT.md"]);
  assert.ok(report.queue.every((item) => item.reviewReason === "unverified-current"));
});

test("legacy reviewAgentInstructions cannot exempt implicit AGENTS.md review", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "verification"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agent instructions\n");
  fs.writeFileSync(path.join(root, "docs", "verification", "README.md"), "# Verification\n");
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md", "docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewAgentInstructions = false;
  config.reviewPaths = ["docs/verification/README.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const report = buildDocQaReport(root);

  assert.deepEqual(report.queue.map((item) => item.path), ["AGENTS.md", "docs/verification/README.md"]);
});

test("reader questions do not become unresolved TODO markers", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const filePath = path.join(root, "docs", "system-map.html");
  fs.writeFileSync(filePath, "<!doctype html><html><body><h1>Map</h1><h2>Question: what does the system own?</h2></body></html>\n");
  initializeContextRoomProject(root, {
    allowedPaths: ["docs/"],
  });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["docs/system-map.html"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const readerQuestion = buildDocQaReport(root).queue[0];
  assert.equal(readerQuestion.issues.some((issue) => issue.type === "todo"), false);

  fs.appendFileSync(filePath, "\n<!-- QUESTION -->\n");
  const unresolvedMarker = buildDocQaReport(root).queue[0];
  assert.equal(unresolvedMarker.issues.some((issue) => issue.type === "todo"), true);
});

test("doc QA can require human review for unchanged important docs", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md", "docs/"], watchAllow: [] });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  fs.writeFileSync(path.join(root, "docs", "INDEX.md"), "# Index\n");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.reviewPaths = ["AGENTS.md", "docs/INDEX.md"];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const report = buildDocQaReport(root);

  assert.deepEqual(report.queue.map((item) => item.path), ["AGENTS.md", "docs/INDEX.md"]);
  assert.equal(report.summary.changedDocs, 0);
  assert.equal(report.summary.needsReview, 2);
  assert.equal(report.summary.requiredReview, 2);
  assert.equal(report.queue[0].reviewRequired, true);

  writeDocReviewDecision(root, "AGENTS.md", { status: "verified" });
  const afterOneReview = buildDocQaReport(root);
  assert.deepEqual(afterOneReview.queue.map((item) => item.path), ["docs/INDEX.md"]);

  writeDocReviewDecision(root, "docs/INDEX.md", { status: "verified" });
  const afterAllReviews = buildDocQaReport(root);
  assert.deepEqual(afterAllReviews.queue.map((item) => item.path), []);
});

test("revertMemoryFile restores tracked changes in a git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "example-app");
  fs.mkdirSync(root);
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n");
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md"], watchAllow: ["AGENTS.md"] });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  writeDocReviewDecision(root, "AGENTS.md", { status: "verified", note: "instructions reviewed" });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# AGENTS\n\nUpdated routing.\n");

  const result = revertMemoryFile(root, "AGENTS.md");

  assert.equal(result.reverted, true);
  assert.equal(result.deleted, false);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# AGENTS\n");
  assert.equal(buildDocQaReport(root).summary.needsReview, 0);
});

test("revertMemoryFile removes untracked new files", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "README.md", CONFIG_FILE], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/new.md"), "# New\n");

  const result = revertMemoryFile(root, "docs/new.md");

  assert.equal(result.reverted, true);
  assert.equal(result.deleted, true);
  assert.equal(fs.existsSync(path.join(root, "docs/new.md")), false);
});

test("file diff renders new untracked watched docs as a Git new-file patch", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  execFileSync("git", ["add", "README.md"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs/new.md"), "# New doc\n\nAgent-written docs.\n");

  const diff = readFileDiff(root, "docs/new.md");

  assert.equal(diff.available, true);
  assert.equal(diff.changed, true);
  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 0);
  assert.match(diff.patch, /new file mode/);
  assert.match(diff.patch, /\+Agent-written docs\./);
});

test("file diff counts tracked patch lines without a second Git diff", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nOld.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nNew.\n\nExtra.\n");

  const diff = readFileDiff(root, "docs/guide.md");

  assert.equal(diff.additions, 3);
  assert.equal(diff.deletions, 1);
  assert.match(diff.patch, /\+Extra\./);
});

test("file diff skips repository-wide work outside Git", () => {
  const root = makeRoot();
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n");
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md"], watchAllow: ["AGENTS.md"] });

  const diff = readFileDiff(root, "AGENTS.md");
  const cachedStart = performance.now();
  const cachedDiff = readFileDiff(root, "AGENTS.md");

  assert.equal(diff.available, false);
  assert.equal(diff.changed, false);
  assert.match(diff.reason, /outside a Git repository/);
  assert.equal(cachedDiff.available, false);
  assert.ok(performance.now() - cachedStart < 250, "negative Git lookup should be cached");
  assert.match(readFileDiff.toString(), /if \(!gitTopLevelRoot\(root\)\)/);
});

test("review base reads HEAD content for changed files from a git subdirectory", () => {
  const repo = makeRoot();
  const root = path.join(repo, "example-app");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\nOriginal.\n");
  fs.writeFileSync(path.join(root, "docs/old.md"), "# Old\n\nRemove me.\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "docs/guide.md"), "# Guide\n\nUpdated.\n");
  fs.writeFileSync(path.join(root, "docs/new.md"), "# New\n\nDraft.\n");
  fs.unlinkSync(path.join(root, "docs/old.md"));

  const modified = readReviewBaseFile(root, "docs/guide.md");
  const added = readReviewBaseFile(root, "docs/new.md");
  const deleted = readReviewBaseFile(root, "docs/old.md");

  assert.equal(modified.available, true);
  assert.equal(modified.changeKind, "modified");
  assert.equal(modified.baseContent, "# Guide\n\nOriginal.\n");
  assert.equal(modified.currentContent, "# Guide\n\nUpdated.\n");
  assert.equal(added.available, true);
  assert.equal(added.changeKind, "added");
  assert.equal(added.baseContent, "");
  assert.equal(added.currentContent, "# New\n\nDraft.\n");
  assert.equal(deleted.available, true);
  assert.equal(deleted.changeKind, "deleted");
  assert.equal(deleted.baseContent, "# Old\n\nRemove me.\n");
  assert.equal(deleted.currentContent, "");
});

test("review base prefers the last inline review baseline over HEAD", () => {
  const root = makeRoot();
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "context-room@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Room Test"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n");
  initializeContextRoomProject(root, { allowedPaths: ["README.md"], watchAllow: ["README.md"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nAlready reviewed.\n");

  const baseline = writeDocReviewBaseline(root, "README.md", { note: "inline review applied" });
  const unchanged = readReviewBaseFile(root, "README.md");
  const reportAfterInlineBaseline = buildDocQaReport(root);
  fs.writeFileSync(path.join(root, "README.md"), "# Demo\n\nAlready reviewed.\n\nNew small edit.\n");
  const next = readReviewBaseFile(root, "README.md");

  assert.match(baseline.baselinePath, /\.context-room\/review-baselines\/README\.md\.baseline$/);
  assert.equal(unchanged.baseline, "review");
  assert.equal(unchanged.changeKind, "unchanged");
  assert.equal(unchanged.baseContent, unchanged.currentContent);
  assert.equal(reportAfterInlineBaseline.queue.some((item) => item.path === "README.md"), false);
  assert.equal(next.baseline, "review");
  assert.equal(next.changeKind, "modified");
  assert.equal(next.baseContent, "# Demo\n\nAlready reviewed.\n");
  assert.equal(next.currentContent, "# Demo\n\nAlready reviewed.\n\nNew small edit.\n");
});

test("default config exposes scoped context and simple markdown templates without a writing guide", () => {
  const config = createDefaultProjectConfig({ title: "Docs Demo" });

  assert.ok(config.allowedPaths.includes("context/"));
  assert.ok(config.hubSections[0].cards.some((card) => card.id === "context"));
  assert.equal("bestPractices" in config, false);
  assert.ok(Array.isArray(config.markdownTemplates));
  assert.equal(config.markdownTemplates[0]?.id, "blank");
  assert.ok(config.markdownTemplates.some((template) => template.id === "context-golden"));

  const blank = DEFAULT_MARKDOWN_TEMPLATES.find((template) => template.id === "blank");
  assert.ok(blank);
  assert.equal(blank.title, "Blank");
  assert.equal(blank.content, "");

  const golden = DEFAULT_MARKDOWN_TEMPLATES.find((template) => template.id === "context-golden");
  assert.ok(golden);
  assert.match(golden.content, /context_room:/);
  assert.match(golden.content, /id: \{\{id_yaml\}\}/);
  assert.match(golden.content, /\{\{depends_on_block\}\}/);
  assert.match(golden.content, /# \{\{title\}\}/);
  assert.match(golden.content, /## Summary/);
  assert.match(golden.content, /## Defines/);
  assert.match(golden.content, /## Does not define/);
  assert.match(golden.content, /## Key facts/);
  assert.match(golden.content, /## References/);
  assert.ok(golden.content.length < 1100, "golden template should stay simple enough to read quickly");

  const html = renderAppHtml();
  assert.doesNotMatch(html, /Writing guide/i);
  assert.doesNotMatch(html, /Docs best practices/i);
  assert.doesNotMatch(html, /bestPractices/);
});

test("createMarkdownFile writes a new empty allowed markdown file", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["context/"] });
  fs.mkdirSync(path.join(root, "context"));

  const result = createMarkdownFile(root, { path: "context/architecture.md", title: "Architecture", templateId: "context-golden" });

  const content = fs.readFileSync(path.join(root, "context/architecture.md"), "utf8");
  assert.equal(result.path, "context/architecture.md");
  assert.equal(result.existed, false);
  assert.equal(content, "");
});

test("createMarkdownFile can create where clicked by registering the exact new file", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  fs.mkdirSync(path.join(root, "website"), { recursive: true });

  const result = createMarkdownFile(root, { path: "website/test.md", title: "Test" });
  const rootResult = createMarkdownFile(root, { path: "root-note.md", title: "Root note" });
  const settings = readMemoryWebappSettings(root);

  assert.equal(result.path, "website/test.md");
  assert.equal(rootResult.path, "root-note.md");
  assert.equal(fs.readFileSync(path.join(root, "website", "test.md"), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(root, "root-note.md"), "utf8"), "");
  assert.ok(settings.allowedPaths.includes("website/test.md"));
  assert.ok(settings.allowedPaths.includes("root-note.md"));
  assert.ok(settings.watchAllow.includes("website/test.md"));
  assert.ok(settings.watchAllow.includes("root-note.md"));
  assert.equal(settings.allowedPaths.includes("website/"), false);
});

test("createMarkdownFile can write a structured doc from metadata-aware templates", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  fs.mkdirSync(path.join(root, "docs"));

  const result = createMarkdownFile(root, {
    path: "docs/billing.md",
    title: "Billing",
    templateId: "context-golden",
    applyTemplate: true,
    metadata: {
      id: "product.billing",
      depends_on: ["strategy.pricing"],
    },
  });

  const content = fs.readFileSync(path.join(root, "docs/billing.md"), "utf8");
  const metadata = parseDocMetadata(content, result.path);

  assert.equal(result.path, "docs/billing.md");
  assert.equal(metadata.present, true);
  assert.equal(metadata.contract, "minimal");
  assert.equal(metadata.id, "product.billing");
  assert.deepEqual(metadata.dependsOn, ["strategy.pricing"]);
  assert.match(content, /# Billing/);
});

test("createMarkdownFile refuses non-markdown paths and existing files", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["context/"] });
  fs.mkdirSync(path.join(root, "context"));
  fs.writeFileSync(path.join(root, "context/current.md"), "# Current\n");

  assert.throws(
    () => createMarkdownFile(root, { path: "context/current.md", title: "Current", templateId: "context-golden" }),
    /already exists/,
  );
  assert.throws(
    () => createMarkdownFile(root, { path: "context/data.json", title: "Data", templateId: "context-golden" }),
    /Markdown/,
  );
  assert.throws(
    () => createMarkdownFile(root, { path: ".context-room/private.md", title: "Private", templateId: "context-golden" }),
    /not allowed/,
  );
});

test("createFolder writes folders where clicked by registering the exact new folder", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });

  const result = createFolder(root, { path: "docs/new-section" });
  const outside = createFolder(root, { path: "website/new-section" });
  const settings = readMemoryWebappSettings(root);

  assert.equal(result.path, "docs/new-section/");
  assert.equal(outside.path, "website/new-section/");
  assert.equal(fs.statSync(path.join(root, "docs/new-section")).isDirectory(), true);
  assert.equal(fs.statSync(path.join(root, "website/new-section")).isDirectory(), true);
  assert.ok(settings.allowedPaths.includes("website/new-section/"));
  assert.ok(settings.watchAllow.includes("website/new-section/"));
  assert.equal(settings.allowedPaths.includes("website/"), false);
  fs.writeFileSync(path.join(root, "docs/current.md"), "# Current\n");
  assert.throws(() => createFolder(root, { path: "docs/current.md" }), /already exists/);
  assert.throws(() => createFolder(root, { path: ".context-room/new-section" }), /not allowed/);
});

test("folder creation keeps the same owner authority through a symlink project alias", async (t) => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const alias = `${root}-alias`;
  fs.symlinkSync(root, alias, "dir");
  t.after(() => { try { fs.unlinkSync(alias); } catch {} });
  const room = createMemoryServer({ root: alias });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());

  const response = await fetch(`http://127.0.0.1:${room.server.address().port}/api/folder/create`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ path: "docs/from-alias" }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.statSync(path.join(root, "docs", "from-alias")).isDirectory(), true);
});

test("deleteMemoryPaths follows project-configured allowed paths", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["project-docs/"] });
  fs.mkdirSync(path.join(root, "project-docs"));
  fs.writeFileSync(path.join(root, "project-docs/current.md"), "# Current\n");

  const result = deleteMemoryPaths(root, ["project-docs/current.md"]);

  assert.deepEqual(result.deleted, ["project-docs/current.md"]);
  assert.equal(fs.existsSync(path.join(root, "project-docs/current.md")), false);
});

test("applyMarkdownTemplateToFile fills an existing empty markdown file only", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["context/"] });
  fs.mkdirSync(path.join(root, "context"));
  fs.writeFileSync(path.join(root, "context/empty.md"), "");
  fs.writeFileSync(path.join(root, "context/current.md"), "# Current\n");

  const result = applyMarkdownTemplateToFile(root, {
    path: "context/empty.md",
    title: "Empty",
    templateId: "context-golden",
  });

  const content = fs.readFileSync(path.join(root, "context/empty.md"), "utf8");
  assert.equal(result.path, "context/empty.md");
  assert.equal(result.existed, true);
  assert.match(content, /^---/);
  assert.match(content, /context_room:/);
  assert.match(content, /id: context\.empty/);
  assert.match(content, /# Empty/);
  assert.match(content, /## Key facts/);

  assert.throws(
    () => applyMarkdownTemplateToFile(root, { path: "context/current.md", title: "Current", templateId: "context-golden" }),
    /not empty/,
  );
});

test("markdown templates can be kept hidden from the apply-template selector", () => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.markdownTemplates = [
    { id: "blank", title: "Blank", description: "Start empty", content: "", enabled: true },
    { id: "published", title: "Published", description: "Ready to use", content: "# {{title}}\n", enabled: true },
    { id: "draft", title: "Draft", description: "Still being developed", content: "# Draft\n", enabled: false },
  ];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const settings = readMemoryWebappSettings(root);
  assert.equal(settings.markdownTemplates.length, 3);
  assert.equal(settings.markdownTemplates.find((template) => template.id === "blank")?.content, "");
  assert.equal(settings.markdownTemplates.find((template) => template.id === "draft")?.enabled, false);

  const html = renderTemplateOptionsMarkup(settings.markdownTemplates);
  assert.match(html, /Blank/);
  assert.match(html, /Published/);
  assert.doesNotMatch(html, /Draft/);
});

test("file template selector applies templates immediately while content is untouched", () => {
  const html = renderAppHtml();

  assert.match(html, /data-empty-template-select/);
  assert.doesNotMatch(html, /data-apply-template/);
  assert.doesNotMatch(html, /Use template/);
  assert.match(html, /function renderFileTemplateOptions\(selectedId = ""\)/);
  assert.match(html, /Choose template\.\.\./);
  assert.match(html, /function templateStateForContent\(text\)/);
  assert.match(html, /const blank = templates\.find\(\(template\) => template\.id === "blank"\);/);
  assert.match(html, /return \{ selectedId: blank\?\.id \|\| "" \};/);
  assert.match(html, /templates\.find\(\(template\) => renderTemplateForSelectedPath\(template\.id\) === current\)/);
  assert.match(html, /function renderTemplateForSelectedPath\(templateId\)/);
  assert.match(html, /function applySelectedTemplateToEditor\(templateId\)/);
  assert.match(html, /if \(!templateId\) return;/);
  assert.match(html, /state\.dirty = rendered !== state\.saved/);
  assert.match(html, /\[data-empty-template-select\]"\)\?\.addEventListener\("change", \(event\) => applySelectedTemplateToEditor\(event\.currentTarget\.value\)\)/);
});

test("documentation graph reports metadata, broken sources, and duplicate canonical docs", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "billing.ts"), "export const billing = true;\n");
  fs.writeFileSync(path.join(root, "docs", "billing.md"), `---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: [src/billing.ts]
---

# Billing
`);
  fs.writeFileSync(path.join(root, "docs", "billing-copy.md"), `---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: [src/missing.ts]
---

# Billing Copy
`);
  fs.writeFileSync(path.join(root, "docs", "plain.md"), "# Plain\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/", "src/"], watchAllow: ["docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.hubSections = [{ id: "docs", title: "Docs", cards: [{ id: "docs", title: "Docs", path: "docs/" }] }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");

  const graph = buildDocumentationGraph(root);

  assert.equal(graph.summary.docs, 3);
  assert.equal(graph.nodes.find((node) => node.path === "docs/billing.md")?.metadata.present, true);
  assert.ok(graph.healthIssues.some((issue) => issue.type === "broken_source" && issue.path === "docs/billing-copy.md"));
  assert.ok(graph.healthIssues.some((issue) => issue.type === "duplicate_canonical" && issue.path === "docs/billing.md"));
  assert.equal(graph.summary.missingMetadata, 1);
  assert.equal(graph.healthIssues.some((issue) => issue.type === "missing_metadata" && issue.path === "docs/plain.md"), false);
});

test("invalid or missing metadata status is never treated as current truth", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const doc = (statusLine) => `---
context_room:
  kind: canonical
  scope: project
${statusLine}
  canonical_for: topic
  sources: []
---

# Topic
`;
  fs.writeFileSync(path.join(root, "docs", "topic-current.md"), doc("  status: current\n  last_verified: 2026-07-19"));
  fs.writeFileSync(path.join(root, "docs", "topic-invalid.md"), doc("  status: implemented"));
  fs.writeFileSync(path.join(root, "docs", "topic-missing.md"), doc(""));
  initializeContextRoomProject(root);

  const graph = buildDocumentationGraph(root);
  const invalid = graph.nodes.find((node) => node.path === "docs/topic-invalid.md");
  const missing = graph.nodes.find((node) => node.path === "docs/topic-missing.md");
  const invalidIssues = computeDocIssues({
    path: invalid.path,
    content: fs.readFileSync(path.join(root, invalid.path), "utf8"),
    gitStatus: "M",
    metadata: invalid.metadata,
  });
  const briefReadFirst = buildAgentBrief(root, { task: "topic", limit: 1 })
    .split("## Read First\n")[1]
    .split("\n## Review Warnings")[0];
  const allTopicBrief = buildAgentBrief(root, { task: "topic", limit: 3 })
    .split("## Read First\n")[1]
    .split("\n## Review Warnings")[0];

  assert.equal(invalid.metadata.statusValid, false);
  assert.equal(missing.metadata.statusValid, false);
  assert.equal(invalid.metadata.status, "");
  assert.equal(missing.metadata.status, "");
  assert.ok(graph.healthIssues.some((issue) => issue.type === "invalid_metadata_status" && issue.path === invalid.path));
  assert.ok(graph.healthIssues.some((issue) => issue.type === "invalid_metadata_status" && issue.path === missing.path));
  assert.equal(graph.healthIssues.some((issue) => issue.type === "duplicate_canonical"), false);
  assert.ok(invalidIssues.some((issue) => issue.type === "invalid_metadata_status" && issue.severity === "high"));
  assert.equal(invalidIssues.some((issue) => issue.type === "missing_last_verified"), false);
  assert.match(briefReadFirst, /docs\/topic-current\.md/);
  assert.doesNotMatch(briefReadFirst, /docs\/topic-(?:invalid|missing)\.md/);
  assert.match(allTopicBrief, /docs\/topic-invalid\.md \(canonical, unclassified,/);
  assert.match(allTopicBrief, /docs\/topic-missing\.md \(canonical, unclassified,/);
  assert.doesNotMatch(allTopicBrief, /topic-(?:invalid|missing)\.md \(canonical, current,/);
});

test("legacy target status is accepted without high-severity metadata diagnostics", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "future.md"), `---
context_room:
  kind: canonical
  scope: project
  status: target
  canonical_for: future
  sources: []
---

# Future
`);
  initializeContextRoomProject(root);

  const graph = buildDocumentationGraph(root);
  const node = graph.nodes.find((item) => item.path === "docs/future.md");
  assert.equal(node.metadata.statusValid, true);
  assert.equal(node.metadata.status, "target");
  assert.equal(node.metadata.truthState, "target");
  assert.equal(graph.healthIssues.some((issue) => issue.path === node.path && ["invalid_metadata_status", "target_status_conflict"].includes(issue.type)), false);
});

test("path truth classifies invalid target and record docs while current routing indexes stay current", () => {
  const root = makeRoot();
  for (const relPath of ["docs/target", "docs/decisions", "docs/research", "docs/incidents"]) {
    fs.mkdirSync(path.join(root, relPath), { recursive: true });
  }
  const metadataDoc = ({ kind = "canonical", status = null, canonicalFor = "topic" } = {}) => `---
context_room:
  kind: ${kind}
  scope: echodesk
${status === null ? "" : `  status: ${status}\n`}  canonical_for: ${canonicalFor}
  last_verified: 2026-07-19
  sources: []
---

# Topic
`;
  fs.writeFileSync(path.join(root, "docs", "roadmap.md"), metadataDoc({ status: "implemented", canonicalFor: "roadmap" }));
  fs.writeFileSync(path.join(root, "docs", "target", "missing.md"), metadataDoc({ canonicalFor: "target-missing" }));
  fs.writeFileSync(path.join(root, "docs", "research", "invalid.md"), metadataDoc({ status: "implemented", canonicalFor: "research-invalid" }));
  fs.writeFileSync(path.join(root, "docs", "incidents", "missing.md"), metadataDoc({ canonicalFor: "incident-missing" }));
  for (const directory of ["target", "decisions", "research", "incidents"]) {
    fs.writeFileSync(path.join(root, "docs", directory, "index.md"), metadataDoc({ kind: "index", status: "current", canonicalFor: `${directory}-index` }));
  }
  fs.writeFileSync(path.join(root, "docs", "research", "current-record.md"), metadataDoc({ status: "current", canonicalFor: "record-current" }));
  fs.writeFileSync(path.join(root, "research.md"), "# Research notes\n");
  fs.writeFileSync(path.join(root, "incident-report.md"), "# Incident report\n");

  const initialized = initializeContextRoomProject(root);
  const graph = buildDocumentationGraph(root);
  const node = (relPath) => graph.nodes.find((item) => item.path === relPath);
  const hubPaths = (id) => (initialized.config.hubSections.find((section) => section.id === id)?.cards || [])
    .flatMap((card) => [card.path, ...(card.paths || [])].filter(Boolean));

  for (const relPath of ["docs/roadmap.md", "docs/target/missing.md"]) {
    assert.equal(node(relPath).metadata.truthState, "target");
    assert.notEqual(node(relPath).metadata.status, "current");
  }
  for (const relPath of ["docs/research/invalid.md", "docs/incidents/missing.md", "research.md", "incident-report.md"]) {
    assert.equal(node(relPath).metadata.truthState, "record");
    assert.notEqual(node(relPath).metadata.status, "current");
  }
  for (const relPath of ["docs/target/index.md", "docs/decisions/index.md", "docs/research/index.md", "docs/incidents/index.md"]) {
    assert.equal(node(relPath).metadata.kind, "index");
    assert.equal(node(relPath).metadata.status, "current");
    assert.equal(node(relPath).metadata.truthState, "current");
    assert.equal(graph.healthIssues.some((issue) => issue.path === relPath && ["target_status_conflict", "record_status_conflict"].includes(issue.type)), false);
  }
  const currentRecord = node("docs/research/current-record.md");
  assert.equal(currentRecord.metadata.status, "");
  assert.equal(currentRecord.metadata.truthState, "record");
  assert.ok(graph.healthIssues.some((issue) => issue.path === currentRecord.path && issue.type === "record_status_conflict"));
  for (const relPath of ["docs/roadmap.md", "docs/research/invalid.md", "docs/incidents/missing.md"]) {
    assert.ok(graph.healthIssues.some((issue) => issue.path === relPath && issue.type === "invalid_metadata_status"));
  }
  assert.ok(hubPaths("target-documentation").includes("docs/roadmap.md"));
  assert.ok(hubPaths("target-documentation").includes("docs/target/index.md"));
  assert.ok(hubPaths("records").includes("docs/decisions/"));
  assert.ok(hubPaths("records").includes("docs/research/"));
  assert.ok(hubPaths("records").includes("docs/incidents/"));
  assert.ok(hubPaths("records").includes("research.md"));
  assert.ok(hubPaths("records").includes("incident-report.md"));
  const brief = buildAgentBrief(root, { task: "roadmap research incidents index", limit: 30 });
  assert.match(brief, /docs\/roadmap\.md \(canonical, target,/);
  assert.match(brief, /docs\/research\/invalid\.md \(canonical, record,/);
  assert.match(brief, /docs\/research\/index\.md \(index, current,/);
  assert.doesNotMatch(brief, /docs\/research\/current-record\.md \(canonical, current,/);
});

test("documentation graph resolves inline references from project sub-roots", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "projects", "demo-project", "website", "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "projects", "demo-project", "website", "docs", "PRODUCT.md"), "# Product\n");
  fs.writeFileSync(path.join(root, "projects", "demo-project", "website", "docs", "DEPLOYMENT.md"), `---
context_room:
  kind: procedure
  scope: demo-project
  status: current
  canonical_for: deployment
  last_verified: 2026-06-26
  sources: []
---

See \`docs/PRODUCT.md\`.
`);
  initializeContextRoomProject(root, {
    allowedPaths: ["projects/demo-project/website/docs/"],
    watchAllow: ["projects/demo-project/website/docs/"],
  });

  const graph = buildDocumentationGraph(root);

  assert.equal(graph.healthIssues.some((issue) => issue.type === "broken_reference" && issue.path === "projects/demo-project/website/docs/DEPLOYMENT.md"), false);
});

test("documentation graph accepts generated and owner-optional runtime references without hiding real broken paths", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "runtime-contract.md"), `---
context_room:
  kind: canonical
  scope: demo
  status: current
  canonical_for: runtime-contract
  last_verified: 2026-08-08
  sources: []
---

Read \`.context-room/README.md\` and preserve \`.context-room/review-gate.json\`.
The unrelated \`.context-room/missing.json\` and \`docs/missing.md\` do not exist.
`);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  fs.rmSync(path.join(root, AGENT_CONTEXT_FILE));

  const issues = buildDocumentationGraph(root).healthIssues.filter((issue) => issue.path === "docs/runtime-contract.md");

  assert.equal(issues.some((issue) => issue.type === "broken_reference" && issue.message.includes(".context-room/README.md")), false);
  assert.equal(issues.some((issue) => issue.type === "broken_reference" && issue.message.includes(".context-room/review-gate.json")), false);
  assert.equal(issues.some((issue) => issue.type === "broken_reference" && issue.message.includes(".context-room/missing.json")), true);
  assert.equal(issues.some((issue) => issue.type === "broken_reference" && issue.message.includes("docs/missing.md")), true);
});

test("documentation graph ignores non-context-room YAML frontmatter", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "skill.md"), `---
name: docs-sync
description: >
  A normal skill or static-site frontmatter block can use YAML features that
  Context Room does not parse.
---

# Skill
`);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const metadata = parseDocMetadata(fs.readFileSync(path.join(root, "docs", "skill.md"), "utf8"), "docs/skill.md");
  const graph = buildDocumentationGraph(root);

  assert.equal(metadata.present, false);
  assert.equal(metadata.parseError, "");
  assert.equal(parseDocMetadata("# Product agents page\n", "docs/features/agents.md").kind, "canonical");
  assert.equal(parseDocMetadata("# Agent instructions\n", "AGENTS.md").kind, "agents");
  assert.equal(graph.healthIssues.some((issue) => issue.type === "metadata_parse_error"), false);
  assert.equal(graph.healthIssues.some((issue) => issue.type === "duplicate_canonical"), false);
});

test("documentation graph treats sidecars as metadata and reports unavailable visual renderers", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "architecture.png"), "image");
  fs.writeFileSync(path.join(root, "docs", "architecture.png.meta.yaml"), "title: Architecture\n");
  fs.writeFileSync(path.join(root, "docs", "missing.png.meta.json"), JSON.stringify({ title: "Missing" }));
  fs.writeFileSync(path.join(root, "docs", "system.puml"), "@startuml\nAlice -> Bob\n@enduml\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const graph = buildDocumentationGraph(root);

  assert.equal(graph.nodes.some((node) => node.path === "docs/architecture.png.meta.yaml"), false);
  assert.equal(graph.nodes.find((node) => node.path === "docs/architecture.png")?.metadata.generic.raw.title, "Architecture");
  assert.ok(graph.healthIssues.some((issue) => issue.type === "orphan_metadata_sidecar" && issue.path === "docs/missing.png.meta.json"));
  assert.ok(graph.healthIssues.some((issue) => issue.type === "document_renderer_unavailable" && issue.path === "docs/system.puml"));
});

test("doctor report and deterministic brief summarize the context graph", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), `---
context_room:
  kind: agents
  scope: project
  status: current
  canonical_for: startup
  last_verified: 2026-06-26
  sources: []
---

# Agents
`);
  fs.writeFileSync(path.join(root, "docs", "billing.md"), `---
context_room:
  kind: canonical
  scope: website
  status: current
  canonical_for: billing
  last_verified: 2026-06-26
  sources: []
---

# Billing
`);
  initializeContextRoomProject(root, { allowedPaths: ["AGENTS.md", "docs/"], watchAllow: ["AGENTS.md", "docs/"] });
  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.startupContext = { enabled: true, fileNames: ["AGENTS.md"] };
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  writeDocReviewDecision(root, "AGENTS.md", { status: "verified", note: "instructions reviewed" });

  const doctor = buildContextRoomDoctorReport(root);
  const brief = buildAgentBrief(root, { task: "update billing docs", limit: 4 });

  assert.equal(doctor.graph.docs, 2);
  assert.match(brief, /Startup Context/);
  assert.match(brief, /AGENTS\.md/);
  assert.match(brief, /docs\/billing\.md/);
  assert.match(brief, /1 watched changed file\(s\) still need review/);
});

test("doctor report keeps acknowledged health issues visible but marked", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "plain.md"), `---
context_room:
  kind: canonical
  scope: docs
  status: current
  canonical_for: plain
  last_verified: 2026-06-26
  sources: [missing.md]
---

# Plain
`);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const before = buildContextRoomDoctorReport(root);
  const issue = before.issues.find((item) => item.type === "broken_source" && item.path === "docs/plain.md");
  assert.ok(issue?.key);
  assert.equal(issue.acknowledged, false);
  assert.equal(issue.category, "references");

  const result = acknowledgeContextHealthIssue(root, { key: issue.key, note: "Known docs gap" });
  const saved = readContextHealthAcknowledgements(root);
  const after = buildContextRoomDoctorReport(root);
  const acknowledged = after.issues.find((item) => item.key === issue.key);

  assert.equal(result.issue.acknowledged, true);
  assert.equal(saved.issues[issue.key].note, "Known docs gap");
  assert.equal(acknowledged?.acknowledged, true);
  assert.equal(after.acknowledgedIssues, 1);
  assert.ok(after.issues.some((item) => item.type === "broken_source" && item.path === "docs/plain.md"));
});

test("context health categories cover every filter area and configuration issues can be marked OK", () => {
  assert.equal(healthIssueCategory({ type: "invalid_config" }), "configuration");
  assert.equal(healthIssueCategory({ type: "missing_sources" }), "documentation");
  assert.equal(healthIssueCategory({ type: "broken_reference" }), "references");
  assert.equal(healthIssueCategory({ type: "git_conflict" }), "review");
  assert.equal(healthIssueCategory({ type: "startup_skill_review_required" }), "startup");
  assert.equal(healthIssueCategory({ type: "external_startup_hook" }), "hooks");

  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  fs.writeFileSync(path.join(root, CONFIG_FILE), "{ invalid json\n");
  const before = buildContextRoomDoctorReport(root);
  const issue = before.issues.find((item) => item.type === "invalid_config");
  assert.equal(issue?.category, "configuration");
  const result = acknowledgeContextHealthIssue(root, { key: issue.key, note: "Owner reviewed the invalid config." });
  assert.equal(result.issue.acknowledged, true);
  assert.equal(buildContextRoomDoctorReport(root).issues.find((item) => item.key === issue.key)?.acknowledged, true);
});

test("explorer context menu renders action choices and keeps creation forms hidden", () => {
  const html = renderExplorerContextMenuMarkup({
    targetPath: "docs/guide.md",
    directory: "docs",
    selectionCount: 2,
    templates: DEFAULT_MARKDOWN_TEMPLATES,
  });

  assert.match(html, /data-context-watch/);
  assert.match(html, /data-context-action-list/);
  assert.match(html, /data-context-new-file/);
  assert.match(html, /data-context-new-folder/);
  assert.match(html, /data-context-select/);
  assert.match(html, /data-context-delete/);
  assert.match(html, /Watch/);
  assert.match(html, /New file/);
  assert.match(html, /New folder/);
  assert.match(html, /Select/);
  assert.match(html, /Delete/);
  assert.match(html, /2 selected/);
  assert.match(html, /data-context-new-file-form hidden/);
  assert.match(html, /data-context-new-folder-form hidden/);
  assert.doesNotMatch(html, /contextMarkdownPath/);
  assert.doesNotMatch(html, /docs\/new-document\.md/);
  assert.doesNotMatch(html, /contextMarkdownTemplate/);
  assert.doesNotMatch(html, /<select/);
  assert.doesNotMatch(html, /Golden context file/);
  assert.match(html, /aria-label="Cancel"/);
  assert.match(html, />Cancel</);
  assert.match(html, /id="contextCreateMarkdown" class="primary"/);
  assert.match(html, /id="contextMarkdownError" class="explorer-context-error" hidden/);
  assert.match(html, /id="contextCreateFolder" class="primary"/);
  assert.match(html, /explorer-context-actions form-actions/);
  assert.match(html, /<label class="explorer-context-label" for="contextMarkdownTitle">Name<\/label>/);
  assert.match(html, /<label class="explorer-context-label" for="contextFolderPath">Path<\/label>/);
});

test("explorer folder watch menu renders all four modes with recursive live as the default", () => {
  const menu = renderExplorerContextMenuMarkup({
    targetPath: "docs",
    targetKind: "folder",
    directory: "docs",
  });

  assert.match(menu, /data-context-watch>Watch this folder…<\/button>/);
  assert.match(menu, /data-context-watch-mode-form hidden/);
  assert.match(menu, /role="radiogroup" aria-label="Folder watch mode"/);
  assert.deepEqual(WATCH_RULE_MODE_OPTIONS.map((option) => option.id), WATCH_RULE_MODES);
  for (const option of WATCH_RULE_MODE_OPTIONS) {
    assert.match(menu, new RegExp(`value="${option.id}"`));
    assert.ok(menu.includes(option.label));
    assert.ok(menu.includes(option.description));
  }
  assert.equal((menu.match(/\schecked/g) || []).length, 1);
  assert.match(menu, /value="recursive-live" checked/);
  assert.match(menu, /id="contextCancelWatchMode"/);
  assert.match(menu, /id="contextApplyWatchMode" class="primary"/);

  const existingStructuredRule = renderExplorerContextMenuMarkup({
    targetPath: "docs",
    targetKind: "folder",
    directory: "docs",
    settings: {
      watchAllow: [],
      watchRules: [{ path: "docs/", mode: "direct-current", files: [] }],
    },
  });
  assert.equal((existingStructuredRule.match(/\schecked/g) || []).length, 1);
  assert.match(existingStructuredRule, /value="direct-current" checked/);

  const existingLegacyRule = renderExplorerContextMenuMarkup({
    targetPath: "docs",
    targetKind: "folder",
    directory: "docs",
    settings: { watchAllow: ["docs/"], watchRules: [] },
  });
  assert.match(existingLegacyRule, /value="recursive-live" checked/);
});

test("folder watch dialogs restore failed actions and keep keyboard focus contained", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const contextApplySource = script.slice(script.indexOf("async function applyExplorerFolderWatchMode"), script.indexOf("async function deleteExplorerContextTarget"));
  const bulkDialogSource = script.slice(script.indexOf("function showFolderWatchModeDialog"), script.indexOf("function linesFromTextarea"));

  assert.match(script, /renderWatchModeOptions\("contextWatchMode", exactUiFolderWatchMode/);
  assert.match(contextApplySource, /catch \(error\)/);
  assert.match(contextApplySource, /button\.disabled = false;/);
  assert.match(contextApplySource, /button\.textContent = "Watch";/);
  assert.match(bulkDialogSource, /event\.key === "Escape"/);
  assert.match(bulkDialogSource, /event\.key !== "Tab"/);
  assert.match(bulkDialogSource, /document\.addEventListener\("keydown", onKeydown\)/);
  assert.match(bulkDialogSource, /document\.removeEventListener\("keydown", onKeydown\)/);
  assert.match(bulkDialogSource, /returnFocus\?\.isConnected/);
});

test("empty allowed folders remain explorable and expose all four watch modes", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "empty"), { recursive: true });
  initializeContextRoomProject(root, { allowedPaths: ["docs/empty/"], watchAllow: [] });

  assert.deepEqual(listExplorerDirectories(root), [{ path: "docs/empty/" }]);
  assert.equal(listExplorerFiles(root).some((file) => file.path.startsWith("docs/empty/")), false);

  const menu = renderExplorerContextMenuMarkup({
    targetPath: "docs/empty",
    targetKind: "folder",
    directory: "docs/empty",
  });
  for (const mode of WATCH_RULE_MODES) assert.match(menu, new RegExp(`value="${mode}"`));
  assert.match(menu, /value="recursive-live" checked/);
});

test("explorer rendering uses a cache and delegated tree events", () => {
  const html = renderAppHtml();

  assert.match(html, /explorerRenderKey:\s*""/);
  assert.match(html, /function explorerRenderKey\(files\)/);
  assert.match(html, /function explorerWatchCounts\(\)/);
  assert.match(html, /function renderExplorerEmptyState\(\)/);
  assert.match(html, /data-watch-label="all"/);
  assert.match(html, /data-watch-label="watched"/);
  assert.match(html, /No not-watched files in this project\./);
  assert.match(html, /if \(!force && state\.explorerRenderKey === nextKey\)/);
  assert.doesNotMatch(html, /if \(state\.explorerWatchFilter !== "all"\) expandExplorerFilterResults\(\);/);
  assert.match(html, /function wireExplorerTreeEvents\(\)/);
  assert.match(html, /holder\.dataset\.wired === "true"/);
  assert.match(html, /holder\.addEventListener\("click", \(event\) =>/);
  assert.match(html, /holder\.addEventListener\("contextmenu", \(event\) =>/);
  assert.match(html, /function scheduleExplorerSearchRender\(\)[\s\S]*requestAnimationFrame/);
  assert.match(html, /addEventListener\("input", \(\) => \{ markUserActive\(\); state\.pathFilters = \[\]; scheduleExplorerSearchRender\(\); \}\)/);
  assert.doesNotMatch(html, /document\.querySelectorAll\("\\[data-file-path\\]"\)\.forEach\(\(button\) => \{\s*button\.addEventListener\("click"/);
});

test("explorer empty-space context menu targets the project root for creation", () => {
  const menu = renderExplorerContextMenuMarkup({
    targetPath: "",
    directory: "",
    selectionCount: 1,
    templates: DEFAULT_MARKDOWN_TEMPLATES,
  });
  const html = renderAppHtml();

  assert.match(menu, /project root/);
  assert.match(menu, /New file[\s\S]*<code>project root<\/code>/);
  assert.match(menu, /data-context-new-file/);
  assert.match(menu, /data-context-new-folder/);
  assert.doesNotMatch(menu, /data-context-watch/);
  assert.doesNotMatch(menu, /data-context-select/);
  assert.doesNotMatch(menu, /data-context-delete/);
  assert.match(html, /function openExplorerEmptyContextMenu\(event\)/);
  assert.match(html, /document\.querySelector\("aside"\)\?\.addEventListener\("contextmenu", openExplorerEmptyContextMenu\)/);
  assert.match(html, /openExplorerContextMenu\(event, \{ kind: "folder", path: "" \}\)/);
});

test("explorer explicit folder context menu keeps the clicked folder target", () => {
  const menu = renderExplorerContextMenuMarkup({
    targetPath: "website/docs",
    directory: "website/docs",
    settings: {
      ...readMemoryWebappSettings(makeRoot()),
      allowedPaths: ["docs/", "website/docs/"],
    },
  });
  const html = renderAppHtml();

  assert.match(menu, /data-context-new-file/);
  assert.match(menu, /data-context-new-folder/);
  assert.match(menu, /New file[\s\S]*<code>website\/docs<\/code>/);
  assert.doesNotMatch(menu, /New file[\s\S]*<code>docs<\/code>/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(target = state\.explorerContextTarget\) \{[\s\S]*return directory;/);
});

test("explorer folder context menu offers creation without broadening the folder allowlist", () => {
  const menu = renderExplorerContextMenuMarkup({
    targetPath: "website",
    directory: "website",
    settings: {
      ...readMemoryWebappSettings(makeRoot()),
      allowedPaths: ["docs/", "website/docs/"],
    },
  });
  const html = renderAppHtml();
  const actionList = menu.match(/<div class="explorer-context-actions menu-actions" data-context-action-list>([\s\S]*?)<\/div>/)?.[1] || "";

  assert.match(menu, /Actions[\s\S]*<code>website<\/code>/);
  assert.match(actionList, /data-context-new-file/);
  assert.match(actionList, /data-context-new-folder/);
  assert.match(actionList, /data-context-watch/);
  assert.match(actionList, /data-context-select/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(/);
});

test("explorer new file creates markdown directly before opening it", () => {
  const html = renderAppHtml();
  const createMarkdownFn = html.match(/async function createMarkdownFromContextMenu\(\) \{[\s\S]*?\n\}/)?.[0] || "";

  assert.match(html, /id="newDocPage" class="settings-page workspace-page" hidden/);
  assert.match(html, /function showNewDocPage\(/);
  assert.match(html, /function renderNewDocPanel\(/);
  assert.match(html, /placeholder="File name"/);
  assert.match(html, /data-structured-doc-form/);
  assert.match(html, /id="markdownCreateFolder" type="hidden"/);
  assert.match(html, /id="markdownCreateFolderDisplay"/);
  assert.match(html, /class="locked-folder-display"/);
  assert.match(html, /id="markdownCreateFileName"/);
  assert.match(html, /id="markdownCreatePath" type="hidden"/);
  assert.match(html, /id="markdownCreatePathPreview"/);
  assert.match(html, /function pathFolderLabel\(/);
  assert.match(html, /function updateStructuredMarkdownPath\(/);
  assert.match(createMarkdownFn, /api\("\/api\/markdown\/create"/);
  assert.match(createMarkdownFn, /const directory = markdownCreateDirectoryForTarget\(\);/);
  assert.match(createMarkdownFn, /applyTemplate: true/);
  assert.match(createMarkdownFn, /templateId: "context-golden"/);
  assert.match(createMarkdownFn, /metadata: \{ id: documentIdForUiPath\(relPath\), depends_on: \[\] \}/);
  assert.match(createMarkdownFn, /await loadFiles\(\);[\s\S]*await selectFile\(result\.path, \{ revealInExplorer: true \}\)/);
  assert.doesNotMatch(createMarkdownFn, /showNewDocPage/);
  assert.match(html, /function submitMarkdownFromContextMenu\(\)/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(/);
  assert.match(html, /function markdownCreateDirectoryForTarget\(target = state\.explorerContextTarget\) \{[\s\S]*return directory;/);
  assert.doesNotMatch(html, /function firstAllowedMarkdownCreateDirectory\(/);
  assert.doesNotMatch(html, /function isAllowedUiMemoryPath\(/);
  assert.match(html, /button\.textContent = "Creating\.\.\."/);
  assert.match(html, /function setContextMarkdownError\(message\)/);
  assert.match(html, /\.explorer-context-error\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--danger\) 10%, transparent\);[^}]*color:\s*var\(--danger-fg\)/);
  assert.doesNotMatch(html, /function createStructuredMarkdownFromHub/);
  assert.doesNotMatch(html, /<select id="markdownCreateFolder"/);
  assert.doesNotMatch(html, /id="markdownCreateFolderButton"/);
  assert.doesNotMatch(html, /id="markdownCreateFolderEntry"/);
  assert.doesNotMatch(html, /id="markdownCreateFolderMenu"/);
  assert.doesNotMatch(html, /<label for="markdownCreatePath">Path<\/label><input id="markdownCreatePath"/);
});

test("app CSS keeps hidden context menu forms hidden despite form display rules", () => {
  const html = renderAppHtml();

  assert.match(html, /data-template-enabled/);
  assert.match(html, /Show in selector/);
  assert.match(html, /\.explorer-context-form\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-actions\[hidden\]\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.explorer-context-menu \{[^}]*width:\s*min\(248px,/);
  assert.match(html, /\.explorer-context-actions\.form-actions\s*\{\s*grid-template-columns:\s*1fr 1fr/);
  assert.match(html, /\.explorer-context-menu \.explorer-context-actions button\s*\{[^}]*padding:\s*8px 10px/);
  assert.match(html, /\.tree\s*\{[^}]*min-height:\s*180px/);
  assert.match(html, /select option\s*\{\s*color:\s*#111827;\s*background:\s*#ffffff;\s*\}/);
  assert.match(html, /select option:checked\s*\{\s*color:\s*#07101e;\s*background:\s*#93c5fd;\s*\}/);
  assert.match(html, /\.markdown-create\s*\{[^}]*grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.path-picker-main\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.35fr\) minmax\(220px, 0\.65fr\)/);
  assert.match(html, /\.locked-folder-display\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\) auto/);
  assert.match(html, /\.locked-folder-display code\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(html, /\.path-picker-preview\s*\{[^}]*background:\s*rgba\(139,211,255,0\.06\)/);
  assert.match(html, /\.app\.sidebar-collapsed \.sidebar-copy,[^}]*\.app\.sidebar-collapsed \.watch-filter-row,[^}]*\.app\.sidebar-collapsed \.selection-bar,[^}]*opacity:\s*0/);
  assert.doesNotMatch(html, /\.app\.sidebar-collapsed \.sidebar-copy,\s*\.app\.sidebar-collapsed \.workspace-dock/);
  assert.match(html, /@media \(min-width: 981px\) \{[\s\S]*\.app\.sidebar-collapsed \.sidebar-head\s*\{[^}]*justify-content:\s*center[^}]*\}[\s\S]*\.app\.sidebar-collapsed \.sidebar-copy\s*\{\s*display:\s*none;\s*\}[\s\S]*\.app\.sidebar-collapsed \.sidebar-toggle\s*\{[^}]*position:\s*static[^}]*margin:\s*0 auto/);
  assert.match(html, /\.app\.sidebar-collapsed \.graph-open\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.sidebar-actions\s*\{[^}]*display:\s*flex;[^}]*gap:\s*2px/);
  assert.match(html, /<div class="sidebar-actions">\s*<button id="graphOpen"[\s\S]*?<button id="sidebarToggle"/);
  assert.match(html, /@media \(max-width: 980px\) \{[\s\S]*\.app\.sidebar-collapsed \.sidebar-copy,[^}]*\.app\.sidebar-collapsed \.watch-filter-row,[^}]*\.app\.sidebar-collapsed \.selection-bar,[^}]*opacity:\s*0/);
});

test("app CSS keeps hub sections stacked and cards responsive", () => {
  const html = renderAppHtml();
  const hubFoldersRule = html.match(/\.hub-folders\s*\{[^}]*\}/)?.[0] || "";

  assert.doesNotMatch(hubFoldersRule, /grid-template-columns/);
  assert.doesNotMatch(html, /@media \(max-width: 1200px\)\s*\{[^}]*\.hub-folders[^}]*grid-template-columns:\s*1fr 1fr/);
  assert.match(html, /\.hub-section-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit, minmax\(min\(100%, 260px\), 1fr\)\)/);
  assert.match(html, /\.hub-section\[data-empty="true"\] \.hub-section-grid\s*\{\s*min-height:\s*1px/);
  assert.match(html, /\.hub-folder-card\s*\{[^}]*min-width:\s*0;[^}]*overflow:\s*hidden/);
  assert.match(html, /\.hub-folder-card-main\s*\{[^}]*min-height:\s*132px;[^}]*padding:\s*var\(--space-5\)/);
  assert.match(html, /\.hub-folder-card strong\s*\{[^}]*letter-spacing:\s*0;[^}]*overflow-wrap:\s*anywhere/);
  assert.match(html, /\.hub-folder-meta code\s*\{\s*flex:\s*1 1 auto;\s*\}/);
  assert.match(html, /function renderHubSectionHeading\(section\)/);
  assert.match(html, /class="hub-section-origin-label">Project</);
  assert.match(html, /const accessibleOrigin = "Project " \+ \(project\.title \|\| project\.id\) \+ \(location \? ", worktree " \+ location : ""\)/);
  assert.match(html, /\.hub-section-heading\s*\{[^}]*justify-content:\s*space-between/);
  assert.match(html, /@media \(max-width: 639px\)[\s\S]*\.hub-section-heading\s*\{[^}]*flex-direction:\s*column/);
});

test("quiet native workbench removes decorative card spotlights", () => {
  const html = renderAppHtml();

  assert.doesNotMatch(html, /--spotlight-x:\s*50%/);
  assert.doesNotMatch(html, /SPOTLIGHT_CARD_SELECTOR/);
  assert.doesNotMatch(html, /function updateCardSpotlight/);
  assert.doesNotMatch(html, /refreshCardSpotlightAfterScroll/);
  assert.match(html, /\.launch-card::before,[\s\S]*\.conflict-card::before \{ display: none !important; \}/);
  assert.doesNotMatch(html, /will-change:\s*transform/);
  assert.doesNotMatch(html, /backface-visibility:\s*hidden/);
});

test("quiet native workbench keeps one gutter authority across empty, inspector, and dialog surfaces", () => {
  const html = renderAppHtml();

  assert.match(html, /\.hub-folders:empty\s*\{\s*display:\s*none/);
  assert.match(html, /\.global-project-inspection\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);[^}]*padding:\s*12px var\(--inspector-gutter\)/);
  assert.match(html, /\.global-project-inspection-summary,[\s\S]*?\.global-project-inspection-disclosure\s*\{[^}]*min-width:\s*0;[^}]*width:\s*100%/);
  assert.match(html, /\.global-project-inspection-disclosure > summary,[\s\S]*?\.global-project-inspection-disclosure-body\s*\{\s*padding-inline:\s*0/);
  assert.match(html, /\.confirm-backdrop(?:,\s*\.shared-context-help-backdrop)?\s*\{\s*padding:\s*var\(--dialog-gutter\)/);
  assert.match(html, /\.confirm-dialog\s*\{\s*padding:\s*var\(--dialog-gutter\)/);
});

test("rendered app supports selectable file themes and colored markdown reading", () => {
  const html = renderAppHtml();
  const source = fs.readFileSync(new URL("../src/context_room.mjs", import.meta.url), "utf8");

  assert.match(html, /data-file-theme="context-room"/);
  assert.match(html, /const FILE_THEMES = \[/);
  assert.match(html, /"vscode-dark"/);
  assert.match(html, /"dracula"/);
  assert.match(html, /id="fileTheme"/);
  assert.match(html, /data-line-number="' \+ \(index \+ 1\) \+ '"/);
  assert.match(html, /\.file-panel \.doc-editor\.markdown-view \.markdown-line::before \{ content: attr\(data-line-number\)/);
  assert.match(html, /\.file-panel \.doc-editor\.markdown-view, \.file-panel \.markdown-editor-input \{ padding-left: 36px; \}/);
  assert.match(html, /font-variant-numeric: tabular-nums/);
  assert.match(html, />App theme<\/label>/);
  assert.match(html, /id="autoOpenGitDiff"/);
  assert.match(html, /<strong>Auto-open Git diff<\/strong>/);
  assert.match(html, /id="showHiddenFiles"/);
  assert.match(html, /<strong>Show hidden files<\/strong>/);
  assert.match(html, /Display safe dotfiles and \.context-room in every Explorer\./);
  assert.match(html, /class="settings-shell"/);
  assert.match(html, /function renderSettingsTabs\(items = \[\]\)/);
  assert.match(html, /role="tablist" aria-label="Settings categories"/);
  assert.match(html, /data-settings-section-target="' \+ escapeHtml\(item\.id\)/);
  assert.match(html, /function renderSettingsSection\(\{ id, kicker, title, copy, scope/);
  assert.match(html, /'<section id="settings-section-' \+ sectionId/);
  assert.match(html, /id:\s*"review"[\s\S]*kicker:\s*"Review"[\s\S]*title:\s*showGlobalProjectPicker \? "Global review overview" : "Review rules"/);
  assert.match(html, /title:\s*"Documents to review"/);
  assert.doesNotMatch(html, /title:\s*"Always require review"/);
  assert.match(html, /title:\s*"Agent CLI guide"/);
  assert.match(html, /Give this to your agent/);
  assert.match(html, /context-room ask/);
  assert.match(html, /data-copy-agent-cli-prompt/);
  assert.match(html, /What remains human-owned/);
  assert.match(html, /Advanced capabilities/);
  assert.match(html, /Keep the root workflow small/);
  assert.match(html, /Send a complete research brief and receive an implementation-ready answer from accepted project documentation/i);
  assert.doesNotMatch(html, /events --follow --since/);
  assert.match(html, /Create a clearly described shared proposal, list open proposals, or restore an exact proposal worktree/);
  assert.match(html, /Ask:<\/strong> research accepted project documentation from a complete task-specific brief, not keywords/);
  assert.match(html, /Edit:<\/strong> create, list, or open shared proposal worktrees without making review decisions/);
  assert.match(html, /Accepting or rejecting each file awaiting review/);
  assert.match(html, /the human explicitly puts the selected result on main or rejects the exact proposal/);
  assert.doesNotMatch(html, /Changing the owner-controlled Git review gate\./);
  assert.match(html, /globalReviewBody = '[^']*<code>ask<\/code>[^']*static command inventory/);
  assert.doesNotMatch(html, /capabilities --intent/);
  assert.match(html, /Your agent can add or widen one explicit rule with/);
  assert.match(html, /context-room watch set/);
  assert.match(html, /Only you can narrow or remove review coverage/);
  assert.match(html, /Human verification remains yours/);
  assert.match(html, /title:\s*"Protect Git actions"/);
  assert.match(html, /title: showGlobalProjectPicker \? "Global review overview" : "Review rules"/);
  assert.match(html, /status: globalReviewCounts\.local \+ " local files", scope: "All projects", body: renderGlobalProjectSettingsGate\("Watched documents and folder modes"\)/);
  assert.match(html, /Select a local project in the Explorer\./);
  assert.doesNotMatch(html, /data-open-selected-project-settings/);
  assert.match(html, /function activeSettingsForPanel\(\)/);
  assert.match(html, /function selectedGlobalSettingsProject\(\) \{[\s\S]*if \(IS_GLOBAL_CONTEXT_ROOM\) return workspaceSelectedProject\(\);[\s\S]*if \(IS_LOCAL\) return currentContextRoomProject\(\);[\s\S]*return null;/);
  assert.match(html, /function selectedProjectSharedContext\(\)[\s\S]*selectedGlobalProjectSettingsContext\(\)/);
  assert.match(html, /loadGlobalProjectSettings\(project/);
  assert.match(html, /api\("\/api\/context-hub\/project-settings\?projectId="/);
  assert.match(html, /api\("\/api\/context-hub\/preferences"/);
  assert.match(source, /url\.pathname === "\/api\/context-hub\/project-settings"/);
  assert.match(source, /writeMemoryWebappSettings\(project\.root, projectInput, \{\s*migrateLegacyReview: true,\s*expectedRootIdentity: project\.rootIdentity,\s*beforeMutation: beforeManagedControlMutation,\s*\}\)/);
  assert.match(html, /function applyContextHubSnapshot\(catalog, ticket\) \{[\s\S]*state\.contextHub = sanitizeHostedHubCatalog\(catalog\);[\s\S]*return true;/);
  assert.match(html, /applyContextHubSnapshot\(contextHub, ticket\)[\s\S]*if \(state\.page === "settings" && !state\.settingsDirtyGroups\.size\) renderSettingsPanel\(\);/);
  assert.match(html, /Block Git operations while review is pending/);
  assert.match(html, /data-review-gate-operation value="commit"/);
  assert.match(html, /data-review-gate-operation value="push"/);
  assert.match(html, /data-review-gate-operation value="pull-request"/);
  assert.match(html, /data-review-gate-operation value="merge"/);
  assert.match(html, /Owner control/);
  assert.match(html, /cannot be changed through the agent CLI/);
  assert.match(html, /Git has no local hook for creating a pull request/);
  assert.match(html, /api\("\/api\/review-gate"/);
  assert.match(html, /document\.querySelectorAll\("\[data-review-gate-operation\]:checked"\)/);
  assert.match(html, /\.review-gate-options\s*\{[^}]*grid-template-columns:\s*repeat\(4/);
  assert.match(html, /id:\s*"startup"[\s\S]*kicker:\s*"Startup"[\s\S]*title:\s*"Agent startup environment"/);
  assert.match(html, /title:\s*"Agent instructions"/);
  assert.match(html, /title:\s*"Local skill discovery"/);
  assert.match(html, /Shared skills are different: they keep reviewed canonical skills/);
  assert.match(html, /id:\s*"appearance"[\s\S]*kicker:\s*"Appearance"[\s\S]*title:\s*"Interface preferences"/);
  assert.match(html, /copy:\s*"Personal preferences shared by every Context Room on this computer\."/);
  assert.match(html, /scope:\s*"All rooms"/);
  assert.match(html, /id:\s*"templates"[\s\S]*kicker:\s*"Templates"[\s\S]*title:\s*showGlobalProjectPicker \? "Project document templates" : "Markdown document templates"/);
  assert.match(html, /id:\s*"hub"[\s\S]*kicker:\s*"Hub"[\s\S]*title:\s*"Hub organization"[\s\S]*Priority is device-wide; sections remain project-owned/);
  assert.match(html, /No Home sections yet\. Add one to create a labeled separator or a group of project links\./);
  assert.match(html, /data-remove-section title="Remove this section">Delete section</);
  assert.match(html, /\.hub-section-editor-summary"\)\.forEach\(\(summary\) => summary\.addEventListener\("contextmenu"/);
  assert.match(html, /function openHubSectionSettingsContextMenu\(event, section\)[\s\S]*data-settings-delete-section>Delete section/);
  assert.match(html, /id:\s*"codex-prompts"[\s\S]*kicker:\s*"Codex prompts"[\s\S]*title:\s*"Codex Prompt Center"/);
  assert.match(html, /\{ id: "project", label: "Project", scope: "Project \+ Device" \}/);
  assert.match(html, /\{ id: "review-trust", label: "Review and trust", scope: "Human" \}/);
  assert.match(html, /\{ id: "agent-environment", label: "Agent environment", scope: "Project \+ Shared" \}/);
  assert.match(html, /\{ id: "preferences", label: "Preferences", scope: "Device" \}/);
  assert.match(html, /\{ id: "advanced-extensions", label: "Advanced extensions", scope: "Device" \}/);
  assert.match(html, /id="openCodexPromptCenter"/);
  assert.match(html, /openContextRoomView\("codex-prompts", \{ returnTo: "settings" \}\)/);
  assert.match(html, /\.settings-section-head\s*\{[^}]*display:\s*flex/);
  assert.match(html, /\.settings-tabs\s*\{[^}]*position:\s*sticky/);
  assert.match(html, /\.settings-tab\[aria-selected="true"\]/);
  assert.match(html, /\.settings-section\[hidden\]\s*\{\s*display:\s*none;/);
  assert.doesNotMatch(html, /settings-section collapsible/);
  assert.match(html, /\.template-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.hub-section-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /\.hub-card-editor:not\(\[open\]\) > :not\(summary\)\s*\{\s*display:\s*none;\s*\}/);
  assert.match(html, /function activateSettingsSection\(sectionId, options = \{\}\)/);
  assert.match(html, /function wireSettingsTabs\(root\)/);
  assert.match(html, /id="settingsSearch"[^>]*role="combobox"/);
  assert.match(html, /id="settingsSearchResults"[^>]*role="listbox"/);
  assert.match(html, /const SETTINGS_SEARCH_ITEMS = \[/);
  assert.match(html, /function matchingSettingsSearchItems\(query\)/);
  assert.match(html, /function openSettingsSearchItem\(itemId\)/);
  assert.match(html, /const target = \(item\.target \? el\(item\.target\) : null\) \|\| disclosure\?\.querySelector\("summary"\);/);
  assert.match(html, /target\?\.focus\(\{ preventScroll: true \}\);[\s\S]*status\.textContent = "Opened " \+ item\.label;/);
  assert.match(html, /No settings found\. Try a familiar word/);
  assert.match(html, /event\.key === "ArrowDown" \|\| event\.key === "ArrowUp"/);
  assert.match(html, /function renderSettingsDisclosure/);
  assert.match(html, /data-settings-disclosure=/);
  assert.match(html, /<summary><span class="settings-disclosure-chevron" aria-hidden="true"><span>›<\/span><\/span>'\s*\+\s*'<span class="settings-disclosure-summary">/);
  assert.match(html, /\.settings-disclosure > summary\s*\{[^}]*grid-template-columns:\s*16px minmax\(0, 1fr\)[^}]*align-items:\s*start/);
  assert.match(html, /\.settings-disclosure-chevron\s*\{[^}]*width:\s*16px;[^}]*height:\s*16px;[^}]*align-self:\s*start;[^}]*margin-top:\s*1px/);
  assert.match(html, /\.settings-disclosure-body\s*\{[^}]*padding:\s*var\(--space-2\) 0 var\(--space-5\) calc\(var\(--space-4\) \+ var\(--space-2\)\)/);
  assert.match(html, /settingsDisclosureState/);
  assert.match(html, /version: 6/);
  assert.match(html, /\[1, 2, 3, 4, 5, 6\]\.includes\(raw\.version\)/);
  assert.match(html, /paneLayout:/);
  assert.match(html, /id="sidebarResizer" class="sidebar-resizer"/);
  assert.match(html, /Unsaved changes/);
  assert.match(html, /setting group/);
  assert.match(html, /function refreshSharedSkillLocationsSettingsPanel\(\)/);
  assert.match(html, /wireSharedSkillLocationsSettingsActions\(panel\)/);
  assert.match(html, /\["ArrowRight", "ArrowDown"\]/);
  assert.match(html, /settingsSection: normalizeSettingsSectionId\(state\.settingsSection\)/);
  assert.match(html, /state\.settingsSection = persisted\.settingsSection/);
  assert.match(html, /activateSettingsSection\(state\.settingsSection, \{ resetScroll: false \}\)/);
  assert.match(html, /Reference in Codex shortcut/);
  assert.match(html, /id="codexReferenceShortcut"/);
  assert.match(html, /id="interfaceSoundsEnabled"/);
  assert.match(html, /id="interfaceSoundsVolume" type="range"/);
  assert.match(html, /data-sound-preview="interaction"/);
  assert.match(html, /A soft, compact click responds to buttons/);
  assert.match(html, />Button click</);
  assert.match(html, /data-sound-preview="review-complete"/);
  assert.match(html, /data-sound-preview="all-clear"/);
  assert.match(html, /data-sound-preview="proposal-accepted"/);
  assert.match(html, /data-sound-preview="attention"/);
  assert.match(html, /Previews work even while interface sounds are muted\./);
  assert.match(html, /function wireShortcutRecorder\(\)/);
  assert.match(html, /Choose one clear scope, make the change, then save once\./);
  assert.match(html, /\.settings-toggle\s*\{[^}]*grid-template-columns:\s*auto minmax\(0, 1fr\)/);
  assert.match(html, /\.settings-shell \{[^}]*grid-template-rows:\s*auto minmax\(0, 1fr\) auto/);
  assert.match(html, /\.settings-footer\s*\{[^}]*position:\s*static/);
  assert.match(html, /button\.save-pending, \.file-action\.save-pending/);
  assert.match(html, /button\.save-confirmed, \.file-action\.save-confirmed/);
  assert.match(html, /@keyframes savePendingSweep/);
  assert.match(html, /@keyframes saveConfirmPulse/);
  assert.match(html, /class="settings-theme-preview"/);
  assert.match(html, /id="settingsThemePreviewName"/);
  assert.match(html, /SETTINGS_THEME_PREVIEW_DOC/);
  assert.match(html, /function normalizeFileThemeId\(wanted\)/);
  assert.match(html, /function applyFileTheme\(themeId = currentFileThemeId\(\), colorMode = currentColorModePreference\(\)\)/);
  assert.match(html, /document\.documentElement\.dataset\.appTheme = clean;/);
  assert.match(html, /document\.documentElement\.dataset\.colorMode = mode;/);
  assert.match(html, /function previewSelectedFileTheme\(\)/);
  assert.match(html, /el\("fileTheme"\)\?\.addEventListener\("change", previewSelectedFileTheme\)/);
  assert.match(html, /id="colorMode"/);
  assert.match(html, /el\("colorMode"\)\?\.addEventListener\("change", previewSelectedFileTheme\)/);
  assert.match(html, /function markButtonSaving\(button, label = "Saving\.\.\."\)/);
  assert.match(html, /function restoreButtonLabel\(button\)/);
  assert.match(html, /function flashSavedButton\(button, label = "Saved"\)/);
  assert.match(html, /markButtonSaving\(saveButton\)/);
  assert.match(html, /flashSavedButton\(el\("saveSettings"\), "Saved"\)/);
  assert.match(html, /flashSavedButton\(document\.querySelector\("\[data-file-save\]"\), "Saved"\)/);
  assert.match(html, /el\("saveSettings"\)\?\.addEventListener\("click", \(\) => saveSettings\(\)\.catch\(\(error\) => setStatus\(error\.message\)\)\)/);
  assert.match(html, /function autoOpenGitDiffEnabled\(\)/);
  assert.match(html, /function collapsedByGitDiffPreference\(diff\)/);
  assert.match(html, /autoOpenGitDiff:\s*el\("autoOpenGitDiff"\)\?\.checked !== false/);
  assert.match(html, /showHiddenFiles:\s*el\("showHiddenFiles"\)\?\.checked !== false/);
  assert.match(html, /const sounds = \{[\s\S]*enabled:\s*el\("interfaceSoundsEnabled"\)\?\.checked !== false/);
  assert.match(html, /state\.files = filesData\.files \|\| state\.files;[\s\S]*renderFiles\(\);/);
  assert.doesNotMatch(html, /autoAdvanceReview/);
  assert.doesNotMatch(html, /Auto-open next review/);
  assert.match(html, /renderFileThemeOptions\(appearance\.fileTheme\)/);
  assert.match(html, /:root\[data-file-theme="dracula"\]\s*\{[\s\S]*--bg:\s*#282a36;[\s\S]*--panel:/);
  assert.match(html, /:root\[data-file-theme="light-plus"\]\s*\{[\s\S]*color-scheme:\s*light;[\s\S]*--bg:\s*#f6f8fa;[\s\S]*--on-accent:\s*#ffffff/);
  assert.doesNotMatch(html, /@keyframes starDrift|@keyframes nebulaPulse|@keyframes workbenchGridDrift/);
  assert.match(html, /QUIET NATIVE WORKBENCH/);
  assert.match(html, /--native-titlebar-height:\s*46px/);
  assert.match(html, /grid-template-columns:\s*var\(--explorer-width\) minmax\(0, 1fr\)/);
  assert.match(html, /font-family:\s*-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif/);
  assert.match(html, /aside\s*\{[^}]*background:\s*var\(--surface-sidebar\)/);
  assert.doesNotMatch(html, /const SPOTLIGHT_CARD_SELECTOR/);
  assert.match(html, /--space-1:\s*4px;[\s\S]*--space-6:\s*24px;[\s\S]*--page-padding:\s*var\(--space-6\)/);
  assert.match(html, /\.workspace-dock\s*\{[^}]*display:\s*flex;[^}]*padding:\s*5px var\(--workbench-gutter-compact\);[^}]*background:\s*transparent/);
  assert.match(html, /\.dock-button\s*\{[^}]*min-width:\s*var\(--control-height\);[^}]*min-height:\s*var\(--control-height\);[^}]*padding:\s*0 var\(--space-3\)/);
  assert.match(html, /\.workspace-dock \.dock-button\[hidden\]\s*\{\s*display:\s*none !important;\s*\}/);
  assert.match(html, /id="gitDiffToggle" class="dock-button diff-dock-button" type="button" title="Show Git diff" hidden>Show Git diff<\/button>/);
  assert.match(html, /\.dock-button\.diff-dock-button\s*\{[^}]*margin-left:\s*var\(--space-1\);[^}]*padding:\s*0 var\(--space-3\)/);
  assert.match(html, /const gitDiffButton = el\("gitDiffToggle"\)/);
  assert.match(html, /gitDiffButton\.textContent = state\.diffCollapsed \? "Show Git diff" : "Hide Git diff"/);
  assert.match(html, /el\("gitDiffToggle"\)\.addEventListener\("click", \(\) => \{[\s\S]*setDiffCollapsed\(!state\.diffCollapsed\);[\s\S]*\}\);/);
  assert.doesNotMatch(html, /class="diff-toggle" type="button" data-show-diff/);
  assert.match(html, /function renderMarkdownLineView\(text, options = \{\}\)/);
  assert.match(html, /id="docReader" class="doc-editor markdown-view"/);
  assert.match(html, /function renderMarkdownEditor\(text, filePath = state\.selected\)/);
  assert.match(html, /id="docHighlighter" class="doc-editor markdown-view markdown-editor-highlight"/);
  assert.match(html, /function usePlainTextSurface\(filePath, text\)/);
  assert.match(html, /!String\(filePath \|\| ""\)\.toLowerCase\(\)\.endsWith\("\.md"\)/);
  assert.match(html, /value\.length > 120_000/);
  assert.match(html, /function renderDocumentEditor\(text, filePath = state\.selected\)/);
  assert.match(html, /id="docEditor" class="doc-editor plain-text-editor" aria-label="' \+ escapeHtml\(documentEditorAccessibleName\(filePath\)\) \+ '"/);
  assert.match(html, /id="docEditor" class="doc-editor markdown-editor-input" aria-label="' \+ escapeHtml\(documentEditorAccessibleName\(filePath\)\) \+ '"/);
  assert.match(html, /<h1 class="file-title">' \+ escapeHtml\(file\.label \|\| "Document"\) \+ '<\/h1>/);
  assert.match(html, /\.plain-text-editor\s*\{[^}]*display:\s*block/);
  assert.match(html, /data-heading-text/);
  assert.match(html, /\.markdown-line\.h1\s*\{[^}]*color:\s*var\(--file-h1\)/);
  assert.match(html, /\.markdown-inline-code/);
  assert.match(html, /\.markdown-path\s*\{[^}]*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-path\[data-doc-link-path\]\s*\{[^}]*cursor:\s*inherit[^}]*background-image:\s*linear-gradient/);
  assert.match(html, /\.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]\s*\{[^}]*cursor:\s*pointer[^}]*background-color/);
  assert.match(html, /\.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]:hover, \.doc-link-modifier-active \.markdown-path\[data-doc-link-path\]\.doc-link-hover-target\s*\{[^}]*animation:\s*docLinkClickableSweep/);
  assert.match(html, /@keyframes docLinkClickableSweep/);
  assert.match(html, /\.markdown-doc-link\s*\{[^}]*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-inline-code\.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.viewer a\.path-link\s*\{[^}]*cursor:\s*inherit/);
  assert.match(html, /\.doc-link-modifier-active \.viewer a\.path-link:hover\s*\{[^}]*cursor:\s*pointer/);
  assert.match(html, /\.markdown-editor-shell\s*\{[^}]*isolation:\s*isolate/);
  assert.match(html, /\.markdown-editor-highlight\s*\{[^}]*z-index:\s*1;[^}]*pointer-events:\s*none;[^}]*user-select:\s*none/);
  assert.match(html, /\.markdown-editor-input\s*\{[^}]*position:\s*absolute;[^}]*z-index:\s*3;[^}]*pointer-events:\s*auto;[^}]*cursor:\s*text;[^}]*-webkit-text-fill-color:\s*transparent !important/);
  assert.match(html, /\.markdown-editor-input\s*\{[^}]*overflow-wrap:\s*break-word;[^}]*word-break:\s*normal;/);
  assert.match(html, /\.markdown-editor-input\.doc-link-hover\s*\{\s*cursor:\s*pointer;\s*\}/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\s*\{[^}]*padding:\s*0;[^}]*font-size:\s*inherit/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\s*\{[^}]*overflow-wrap:\s*break-word;[^}]*word-break:\s*normal;/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.h1\s*\{\s*color:\s*var\(--file-h1\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.h2\s*\{\s*color:\s*var\(--file-h2\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.list\s*\{\s*padding-left:\s*0/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-line\.list \.markdown-marker, \.markdown-editor-highlight \.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-inline-code\s*\{\s*color:\s*var\(--file-code\)/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-inline-code\.markdown-path\s*\{\s*color:\s*var\(--file-list\)/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-line\s*\{[^}]*padding:\s*0;[^}]*font-size:\s*inherit/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-line\.h1, \.external-review-doc\.editor-metrics \.markdown-line\.h2, \.external-review-doc\.editor-metrics \.markdown-line\.h3, \.external-review-doc\.editor-metrics \.markdown-line\.h4\s*\{[^}]*border:\s*0/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-line\.list\s*\{\s*padding-left:\s*0/);
  assert.match(html, /\.external-review-doc\.editor-metrics \.markdown-inline-code\s*\{\s*color:\s*var\(--file-code\);[^}]*background:\s*transparent/);
  assert.doesNotMatch(html, /\.external-review-doc \.markdown-line\s*\{[^}]*padding:\s*0/);
  assert.doesNotMatch(html, /\.external-review-doc \.markdown-line\.list\s*\{\s*padding-left:\s*0/);
  assert.doesNotMatch(html, /\.external-review-final-lines \.markdown-line\.h1, \.external-review-line-content \.markdown-line\.h1/);
  assert.match(html, /function decorateMarkdownLine\(rendered, decoration\)/);
  assert.match(html, /lineDecorations/);
  assert.match(html, /data-review-marker/);
  assert.match(html, /data-final-line-index/);
  assert.match(html, /\.external-review-line \{[^}]*position:\s*relative/);
  assert.doesNotMatch(html, /\.external-review-line \{[^}]*grid-template-columns/);
  assert.match(html, /\.external-review-line::before \{[^}]*content:\s*attr\(data-review-marker\)/);
  assert.match(html, /\.external-review-token\.add \{[^}]*background:\s*rgba\(48,215,111,0\.32\)/);
  assert.match(html, /\.external-review-token\.del \{[^}]*background:\s*rgba\(255,86,117,0\.3\)/);
  assert.match(html, /\.external-review-block\.change \{[^}]*margin:\s*0;[^}]*padding:\s*0;[^}]*box-shadow:\s*inset 2px 0 0/);
  assert.match(html, /function isMarkdownPathToken\(value\)/);
  assert.match(html, /function resolveDocLinkPath\(rawTarget\)/);
  assert.match(html, /function markdownDocLinkAttributes\(rawTarget, options = \{\}\)/);
  assert.match(html, /data-doc-link-path/);
  assert.match(html, /data-doc-link-resolved/);
  assert.match(html, /Ctrl\/Cmd-click to open/);
  assert.match(html, /function wireMarkdownDocLinks\(root = document\)/);
  assert.match(html, /const keyboardAccessibleLink = element\.tagName === "A";[\s\S]*if \(!keyboardAccessibleLink && !isDocLinkModifierEventActive\(event\)\) return;/);
  assert.match(html, /function wireMarkdownEditorDocLinks\(editor\)/);
  assert.match(html, /function markdownDocLinkAtPoint\(clientX, clientY\)/);
  assert.match(html, /function markdownDocLinkElementAtPoint\(clientX, clientY\)/);
  assert.match(html, /function updateMarkdownEditorDocLinkHover\(editor, event\)/);
  assert.match(html, /function clearMarkdownEditorDocLinkHover\(editor = el\("docEditor"\)\)/);
  assert.match(html, /editor\.addEventListener\("pointermove", \(event\) => updateMarkdownEditorDocLinkHover\(editor, event\), \{ passive: true \}\)/);
  assert.match(html, /editor\.addEventListener\("pointerleave", \(\) => clearMarkdownEditorDocLinkHover\(editor\), \{ passive: true \}\)/);
  assert.match(html, /highlighter\.style\.pointerEvents = "auto";[\s\S]*editor\.style\.pointerEvents = "none";/);
  assert.match(html, /if \(!state\.docLinkModifierActive\) \{[\s\S]*clearMarkdownEditorDocLinkHover\(editor\);[\s\S]*return;/);
  assert.match(html, /editor\.classList\.toggle\("doc-link-hover", Boolean\(target\)\)/);
  assert.match(html, /target\.classList\.add\("doc-link-hover-target"\)/);
  assert.match(html, /document\.elementsFromPoint\(clientX, clientY\)/);
  assert.match(html, /markdownDocLinkAtPoint\(event\.clientX, event\.clientY\) \|\| markdownDocLinkAtOffset/);
  assert.match(html, /function markdownDocLinkAtOffset\(text, offset\)/);
  assert.match(html, /wireMarkdownDocLinks\(\);/);
  assert.match(html, /wireMarkdownEditorDocLinks\(docEditor\);/);
  assert.match(html, /function setDocLinkModifierActive\(active\)/);
  assert.match(html, /if \(state\.docLinkModifierActive === next\) return;/);
  assert.match(html, /state\.docLinkModifierActive = next;/);
  assert.match(html, /document\.documentElement\.classList\.toggle\("doc-link-modifier-active", next\)/);
  assert.match(html, /if \(!next\) clearMarkdownEditorDocLinkHover\(\);/);
  assert.match(html, /function isMacPlatform\(\)/);
  assert.match(html, /function isDocLinkModifierEventActive\(event\)/);
  assert.match(html, /return isMacPlatform\(\) \? Boolean\(event\.metaKey\) : Boolean\(event\.ctrlKey\);/);
  assert.match(html, /setDocLinkModifierActive\(isDocLinkModifierEventActive\(event\)\)/);
  assert.match(html, /document\.addEventListener\("keyup", \(event\) => setDocLinkModifierActive\(isDocLinkModifierEventActive\(event\)\)\)/);
  assert.match(html, /if \(!isDocLinkModifierEventActive\(event\)\) return;/);
  assert.match(html, /openMarkdownDocLink\(target\)/);
  assert.match(html, /selectFile\(resolved, \{ revealInExplorer: true \}\)/);
  assert.match(html, /const className = 'markdown-inline-code' \+ \(isMarkdownPathToken\(token\) \? ' markdown-path' : ''\);/);
  assert.match(html, /if \(options\.interactiveLinks && docLinkAttrs\) return '<a href="#" class="' \+ className/);
  assert.match(html, /function updateMarkdownEditorHighlight\(text, options = \{\}\)/);
  assert.match(html, /state\.markdownHighlightFrame = window\.requestAnimationFrame/);
  assert.match(html, /function renderMarkdownEditorHighlightNow\(text\)/);
  assert.match(html, /\.markdown-editor-shell\[data-source-mode="false"\] \.markdown-editor-highlight\s*\{[^}]*pointer-events:\s*none;[^}]*user-select:\s*none/);
  assert.match(html, /\.markdown-editor-shell\[data-source-mode="false"\] \.markdown-editor-input\s*\{\s*pointer-events:\s*auto/);
  assert.match(html, /addEventListener\("pointerdown", enterMarkdownEditorAtPoint\)/);
  assert.match(html, /addEventListener\("pointermove", extendMarkdownEditorPointerSelection\)/);
  assert.match(html, /addEventListener\("pointerup", finishMarkdownEditorPointerSelection\)/);
  assert.match(html, /function markdownEditorSourceOffsetAtPoint\(clientX, clientY\)/);
  assert.match(html, /function markdownEditorWordRange\(value, offset\)/);
  assert.match(html, /function markdownEditorLineRange\(value, offset\)/);
  assert.match(html, /setSelectionRange\([\s\S]*safeFocus < safeAnchor \? "backward" : "forward"/);
  assert.match(html, /addEventListener\("beforeinput", \(event\) => captureMarkdownEditorHistory\(docEditor, event\)\)/);
  assert.match(html, /function handleMarkdownEditorHistoryShortcut\(event, editor\)/);
  assert.match(html, /const undo = key === "z" && !event\.shiftKey;/);
  assert.match(html, /const redo = \(key === "z" && event\.shiftKey\)/);
  assert.match(html, /function applyMarkdownEditorHistory\(editor, direction\)/);
  assert.match(html, /destination\.push\(markdownEditorHistorySnapshot\(editor\)\)/);
  assert.match(html, /editor\.setSelectionRange\(snapshot\.selectionStart, snapshot\.selectionEnd, snapshot\.selectionDirection\)/);
  assert.doesNotMatch(html, /data-markdown-source-toggle/);
  assert.match(html, /function markdownSourceOffsetForRenderedOffset\(sourceLine, renderedOffset\)/);
  assert.match(html, /function markdownRenderedOffsetForSourceOffset\(sourceLine, sourceOffset\)/);
  assert.match(html, /function updateMarkdownEditorVisualSelection\(\)/);
  assert.match(html, /id="markdownEditorCaret"/);
  assert.match(html, /highlighter\.scrollTop = editor\.scrollTop;/);
  assert.match(html, /highlighter\.scrollLeft = editor\.scrollLeft;/);
  assert.match(html, /if \(options\.sourceFaithful && docLinkAttrs\) \{/);
  assert.match(html, /class="markdown-link-label"/);
  assert.match(html, /class="markdown-link-target"/);
  assert.match(html, /\.markdown-editor-highlight \.markdown-link-target\s*\{[^}]*color:\s*color-mix/);
  assert.match(html, /state\.markdownHighlightLastText = docEditor\.value;/);
  assert.doesNotMatch(html, /syncMarkdownEditorHighlight/);
  assert.match(html, /function syncMarkdownEditorScroll\(\)/);
  assert.match(html, /function scrollMarkdownViewToNeedle\(needle, type = "text"\)/);
  assert.match(html, /function visibleMarkdownReader\(\)/);
  assert.match(html, /const reader = el\("docReader"\) \|\| el\("docHighlighter"\);/);
  assert.match(html, /visibleMarkdownReader\(\) \|\| activeEditor\(\) \|\| el\("viewer"\)/);
});

test("Settings search matches aliases, technical names, scopes, and advanced groups", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const source = script.slice(
    script.indexOf("const SETTINGS_SEARCH_ITEMS ="),
    script.indexOf("function renderSettingsSearchResults"),
  );
  const { matchingSettingsSearchItems } = Function(
    source + "; return { matchingSettingsSearchItems };",
  )();

  assert.equal(matchingSettingsSearchItems("watch folders")[0].group, "review-documents");
  assert.equal(matchingSettingsSearchItems("AGENTS.md")[0].group, "startup-context");
  assert.equal(matchingSettingsSearchItems("provider conflicts")[0].section, "shared-skills");
  assert.equal(matchingSettingsSearchItems("device prompt restart")[0].group, "codex-prompts-editor");
  assert.equal(matchingSettingsSearchItems("definitely absent").length, 0);
  assert.ok(matchingSettingsSearchItems("git gate").some((item) => item.group === "review-protection"));
});

test("normal and startup files open directly editable while review mode owns verification", () => {
  const html = renderAppHtml();

  assert.match(html, /async function selectFile\(path, options = \{\}\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /async function selectStartupContextFile\(order, options = \{\}\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /async function selectStartupSkillFile\(folderOrder, skillName, options = \{\}\)[\s\S]*state\.dirty = false;\s*state\.mode = "edit";/);
  assert.match(html, /state\.mode === "edit"\s*\?\s*renderMarkdownEditor\(text\)/);
  assert.match(html, /writeSelectedDiskFile\(content\)/);
  assert.match(html, /api\("\/api\/startup-context\/file", \{/);
  assert.match(html, /api\("\/api\/startup-skills\/file", \{/);
  assert.match(html, /reviewAction: reviewActionForSelectedFile\(\)/);
  assert.match(html, /deletable: !isStartupFile && !state\.selectedReadOnly/);
  assert.match(html, /el\("viewer"\)\.hidden = false;\s*el\("editor"\)\.hidden = true;\s*renderPlanetSystem\(\);/);
  assert.doesNotMatch(html, /data-file-mode-toggle/);
});

test("selected text opens a floating compact Codex file mention action", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);
  const pureSource = script.slice(
    script.indexOf("function codexReferenceLineNumber"),
    script.indexOf("function currentCodexReferencePath"),
  );
  const helpers = Function(
    pureSource + "; return { codexReferenceLineRange, buildCompactCodexReferenceText };",
  )();

  assert.deepEqual(helpers.codexReferenceLineRange("alpha\nbeta\ngamma", 6, 10), { startLine: 2, endLine: 2 });
  assert.deepEqual(helpers.codexReferenceLineRange("alpha\nbeta\ngamma", 6, 11), { startLine: 2, endLine: 2 });
  assert.deepEqual(helpers.codexReferenceLineRange("alpha\nbeta\ngamma", 2, 13), { startLine: 1, endLine: 3 });
  const prompt = helpers.buildCompactCodexReferenceText({
    path: "docs/guide.md",
    startLine: 2,
    endLine: 3,
    text: "Selected line\nAnother line",
    dirty: true,
  });
  assert.match(prompt, /^@docs\/guide\.md L2–3 · unsaved/);
  assert.match(prompt, /> Selected line\n> Another line/);

  assert.match(html, /id="codexReferencePopover" class="codex-reference-popover"/);
  assert.match(html, /data-codex-reference-line/);
  assert.match(html, /positionCodexReferenceAction/);
  assert.match(html, /markdownReferenceSelectionRect/);
  assert.match(html, /plainTextReferenceSelectionRect/);
  assert.doesNotMatch(html, /data-codex-reference disabled/);
  assert.match(html, /dirty: editor\.value !== state\.saved/);
  assert.match(html, /api\("\/api\/codex\/reference", \{/);
  assert.match(html, /selectedText: reference\.dirty \? reference\.text : ""/);
  assert.match(html, /navigator\.clipboard\?\.writeText/);
  assert.match(html, /document\.execCommand\("copy"\)/);
  assert.match(html, /result\.nativeMention \? "Linked" : "Added"/);
  assert.match(html, /handleCodexReferenceShortcut/);
  assert.match(html, /keyboardEventMatchesShortcut/);
  assert.match(html, /DEFAULT_CODEX_REFERENCE_SHORTCUT/);
  assert.doesNotMatch(html, /domCodexReferenceSelection|exactCodexReferenceLineRange/);
  assert.doesNotMatch(html, /codex:\/\/threads\/new|openCodexReferenceComposer/);
  assert.doesNotMatch(pureSource, /turn\/start|saveCurrent\(/);
});

test("Codex reference API resolves an allowed file and delegates a compact reference", async (t) => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/guide.md"), "alpha\nbeta\ngamma\n", "utf8");
  fs.writeFileSync(path.join(root, "README.md"), "# Read only\n", "utf8");
  fs.writeFileSync(path.join(root, ".env"), "SECRET=hidden\n", "utf8");
  const inserted = [];
  const { server } = createMemoryServer({
    root,
    codexReferenceInsert: async (reference) => {
      inserted.push(reference);
      return { inserted: true, nativeMention: true, activeThreadKey: "thread-1", preservedDraft: true };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(base + "/api/codex/reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "docs/guide.md", startLine: 2, endLine: 3, selectedText: "beta\ngamma", dirty: true }),
  });
  const payload = await response.json();
  const readOnlyResponse = await fetch(base + "/api/codex/reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "README.md", startLine: 1, endLine: 1, dirty: false }),
  });
  const sensitiveResponse = await fetch(base + "/api/codex/reference", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: ".env", startLine: 1, endLine: 1, dirty: false }),
  });

  assert.equal(response.status, 200);
  assert.equal(payload.nativeMention, true);
  const canonicalRoot = fs.realpathSync(root);
  assert.deepEqual(inserted, [{
    absolutePath: path.join(canonicalRoot, "docs/guide.md"),
    displayPath: "docs/guide.md",
    startLine: 2,
    endLine: 3,
    selectedText: "beta\ngamma",
    dirty: true,
  }, {
    absolutePath: path.join(canonicalRoot, "README.md"),
    displayPath: "README.md",
    startLine: 1,
    endLine: 1,
    selectedText: "",
    dirty: false,
  }]);
  assert.equal(readOnlyResponse.status, 200);
  assert.equal(sensitiveResponse.status, 403);
});

test("Codex composer API inserts only validated text through the injected local bridge", async (t) => {
  const root = makeRoot();
  initializeContextRoomProject(root, { allowedPaths: ["docs/"] });
  const inserted = [];
  const { server } = createMemoryServer({
    root,
    codexComposerInsert: async (text) => {
      inserted.push(text);
      return { inserted: true, activeThreadKey: "thread-1", preservedDraft: true };
    },
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const base = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(base + "/api/codex/composer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Reference\n\nRequest:\n" }),
  });
  const payload = await response.json();
  const missingResponse = await fetch(base + "/api/codex/composer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(payload, { inserted: true, activeThreadKey: "thread-1", preservedDraft: true });
  assert.deepEqual(inserted, ["Reference\n\nRequest:\n"]);
  assert.equal(missingResponse.status, 400);
});

test("browser refresh restores the last Context Room page", () => {
  const html = renderAppHtml();

  assert.match(html, /WORKSPACE_NAVIGATION_STATE_STORAGE_PREFIX = "context-room:workspace-navigation:"/);
  assert.match(html, /function navigationStorageKey\(root = state\.root\)/);
  assert.match(html, /window\.sessionStorage\?\.setItem\(key, JSON\.stringify/);
  assert.match(html, /function establishWorkspaceIdentity\(\)/);
  assert.match(html, /workspace-conflict/);
  assert.match(html, /function establishWorkspaceIdentity\(\)[\s\S]*replaceDuplicatedWorkspaceIdentity[\s\S]*state\.workspaceIdentityReady = true;[\s\S]*syncWorkspaceUrl\(\);/);
  assert.doesNotMatch(html, /await new Promise\(\(resolve\) => window\.setTimeout\(resolve, 90\)\)/);
  assert.match(html, /function syncWorkspaceUrl\(\{ push = false \} = \{\}\)[\s\S]*if \(url\.href === window\.location\.href\) \{[\s\S]*state\.workspaceSyncedUrl = url\.href;[\s\S]*return;[\s\S]*window\.history\[push \? "pushState" : "replaceState"\]/);
  assert.match(html, /state\.workspaceSyncedUrl = url\.href;[\s\S]*window\.history\[push \? "pushState" : "replaceState"\]/);
  assert.match(html, /window\.addEventListener\("popstate", \(\) => \{[\s\S]*if \(!state\.workspaceIdentityReady\) return;[\s\S]*window\.location\.href === state\.workspaceSyncedUrl\) return;[\s\S]*applyWorkspaceUrlState\(\{ reason: "history" \}\)/);
  assert.doesNotMatch(html, /window\.addEventListener\("popstate",[\s\S]{0,300}window\.location\.reload\(\)/);
  assert.match(html, /function handleWorkspaceBeforeUnload\(event\)[\s\S]*persistNavigationState\(\{ syncUrl: false \}\);[\s\S]*beginWorkspaceUnload\(\);[\s\S]*event\.preventDefault\(\);/);
  assert.match(html, /function syncWorkspaceBeforeUnloadGuard\(\)[\s\S]*shouldListen = Boolean\(state\.dirty\);[\s\S]*"addEventListener" : "removeEventListener"[\s\S]*"beforeunload", handleWorkspaceBeforeUnload/);
  assert.doesNotMatch(html, /window\.addEventListener\("beforeunload"/);
  assert.match(html, /window\.addEventListener\("pagehide", handleWorkspacePageHide\);/);
  assert.match(html, /function handleWorkspacePageHide\(event\)[\s\S]*persistNavigationState\(\{ syncUrl: false \}\);[\s\S]*stopWorkspaceRuntime\(\{ suspended: event\?\.persisted === true \}\);/);
  assert.match(html, /function beginWorkspaceUnload\(\)[\s\S]*state\.workspaceUnloadPending = true;[\s\S]*quiesceWorkspaceBackgroundActivity\(\);[\s\S]*state\.workspaceUnloadPending = false;[\s\S]*settleWorkspaceUnload\("cancelled"\);[\s\S]*refreshWorkspaceRuntimeAfterLifecycle\("unload-cancelled"\)[\s\S]*}, 250\);/);
  assert.match(html, /function stopWorkspaceRuntime\(\{ suspended = false \} = \{\}\)[\s\S]*state\.workspaceRuntimeSuspended = Boolean\(suspended\);[\s\S]*settleWorkspaceUnload\(state\.workspaceRuntimeSuspended \? "suspended" : "stopped"\);[\s\S]*state\.workspaceChannel\?\.close\(\);/);
  assert.match(html, /function resumeWorkspaceRuntime\(\)[\s\S]*settleWorkspaceRestore\("restored"\);[\s\S]*state\.startWorkspaceChannel\?\.\(\);[\s\S]*if \(state\.workspaceInitialRegistrationPending\) return true;[\s\S]*refreshWorkspaceRuntimeAfterLifecycle\("page-restore"/);
  assert.match(html, /document\.addEventListener\("visibilitychange", \(\) => \{[\s\S]*workspaceVisibilityTimer[\s\S]*document\.visibilityState === "visible"[\s\S]*publishSessionState\(\{ allowHidden: true \}\)/);
  assert.match(html, /window\.addEventListener\("pageshow", \(event\) => \{[\s\S]*event\.persisted[\s\S]*resumeWorkspaceRuntime\(\);/);
  assert.doesNotMatch(html, /function handleWorkspaceBeforeUnload\(event\)[\s\S]{0,500}\/api\/workspaces\/register/);
  assert.match(html, /async function completeWorkspacePairing\(\)[\s\S]*const fragment = workspaceFragmentValues\(\);[\s\S]*await publishSessionState\(\{ allowHidden: true, required: true \}\);[\s\S]*clearWorkspacePairingFragment\(\);/);
  assert.match(html, /function ensureWorkspaceRuntimeRegistration\(\)[\s\S]*completeWorkspacePairing\(\)\.then[\s\S]*startWorkspaceRuntimeAfterRegistration\(pairedCommand\)/);
  assert.match(html, /function startWorkspaceRuntimeAfterRegistration\(pairedCommand = null\)[\s\S]*state\.workspaceRuntimeRegistrationRequired = false;[\s\S]*state\.workspaceDeferredCommandId = pairedCommand\?\.id[\s\S]*startAgentCommandPolling\(\);[\s\S]*startRuntimeEvents\(\);/);
  assert.match(html, /if \(outcome === "suspended"\)[\s\S]*waitForWorkspaceRestoreResolution\(\)[\s\S]*restoreOutcome !== "restored"/);
  assert.match(html, /command\.id === state\.workspaceDeferredCommandId/);
  assert.match(html, /const visible = document\.visibilityState === "visible";\s*const focused = visible && document\.hasFocus\(\);/);
  assert.match(html, /async function publishSessionState\(\{ allowHidden = false, required = false \} = \{\}\)[\s\S]*document\.visibilityState !== "visible" && !allowHidden/);
  assert.match(html, /function startWorkspacePresenceDrain\(\)[\s\S]*workspacePresenceQueued[\s\S]*workspacePresenceActive[\s\S]*await api\("\/api\/workspaces\/register"/);
  assert.match(html, /window\.addEventListener\("blur", \(\) => \{[\s\S]*publishSessionState\(\{ allowHidden: true \}\)/);
  assert.match(html, /if \(state\.projectId\) headers\.set\("x-context-room-project", state\.projectId\);/);
  assert.match(html, /if \(responseAction === "initialize"\) state\.projectId = responseProjectId;/);
  assert.match(html, /function handleContextRoomProjectChange\([\s\S]*if \(IS_GLOBAL_CONTEXT_ROOM\)[\s\S]*loadFiles\(\{ identityRefresh: true \}\)/);
  assert.match(html, /function requestExceptionalWorkspaceReload\([\s\S]*workspaceReloadCircuitDecision/);
  assert.match(html, /function showWorkspaceRecovery\([\s\S]*Retry once/);
  assert.match(html, /searchText: el\("search"\)\?\.value \|\| ""/);
  assert.match(html, /root: state\.root,\s*projectId: state\.projectId,/);
  assert.match(html, /if \(!raw\.root \|\| !raw\.projectId\) return null;/);
  assert.match(html, /if \(raw\.root !== root\) return null;/);
  assert.match(html, /if \(!state\.projectId \|\| raw\.projectId !== state\.projectId\) return null;/);
  assert.match(html, /const pathFilters = rawPathFilters\.filter\(\(filter\) => state\.files\.some\(\(file\) => pathMatchesFilter\(file\.path, filter\)\)\);/);
  assert.match(html, /el\("search"\)\.value = persisted\.searchText \|\| folderFilterSearchQuery\(state\.pathFilters\);/);
  assert.match(html, /function acceptContextRoomRoot\(nextRoot\)[\s\S]*if \(!state\.root\) \{[\s\S]*state\.root = nextRoot;[\s\S]*if \(state\.root === nextRoot\) return;[\s\S]*if \(IS_GLOBAL_CONTEXT_ROOM\) \{[\s\S]*state\.root = nextRoot;[\s\S]*handleContextRoomProjectChange\(\{ reason: "server-root-changed" \}\);/);
  assert.match(html, /acceptContextRoomRoot\(data\.root\);/);
  assert.match(html, /const hasDirectContextHubTarget = Boolean\(requestedReviewFile \|\| requestedHubCard \|\| requestedStartupOrder \|\| state\.sharedContext\?\.mode === "review"\);/);
  assert.match(html, /if \(options\.initial && IS_GLOBAL_CONTEXT_ROOM\) \{[\s\S]*await state\.contextHubReadyPromise;[\s\S]*renderGlobalProjectExplorer\(\);/);
  assert.match(html, /const restoreRequest = skipsGenericNavigationRestore \? Promise\.resolve\(false\) : restoreNavigationAfterInitialLoad\(\);/);
  assert.match(html, /const restored = await restoreRequest;/);
  assert.match(html, /if \(restored\) \{[\s\S]*scheduleSessionStatePush\(\);[\s\S]*return;/);
  assert.match(html, /openRequest = selectFile\(persisted\.selectedPath, options\);/);
  assert.match(html, /openRequest = selectStartupContextFile\(startup\.order, options\);/);
  assert.match(html, /void openRequest\.then\(\(\) => setStatus\("restored"\)\)/);
  assert.match(html, /showSettingsPage\(\);[\s\S]*return true;/);
  assert.match(html, /restorePersistedViewState\(options\.restoreViewState\);/);
  assert.match(html, /if \(typeof options\.diffCollapsed === "boolean"\) state\.diffCollapsed = options\.diffCollapsed;/);
  assert.match(html, /Object\.defineProperty\(state, "dirty",[\s\S]*syncWorkspaceBeforeUnloadGuard\(\);/);
});

test("workspace URL restoration parses every supported destination without browser state", () => {
  const target = parseWorkspaceNavigationUrl("http://127.0.0.1:4319/?hub=1&workspace=workspace_123&project=hicharlie-wt&view=settings&settings=shared-skills&folder=apps%2Fcalls&file=apps%2Fcalls%2FAGENTS.md&proposal=proposal_123");
  assert.deepEqual(target, {
    workspaceId: "workspace_123",
    projectId: "hicharlie-wt",
    view: "settings",
    folder: "apps/calls",
    search: "",
    file: "apps/calls/AGENTS.md",
    proposal: "proposal_123",
    settingsSection: "shared-skills",
    explorerDocumentView: "location",
    graphScope: "global",
    graphDepth: 1,
    graphLayers: [],
    graphTypes: [],
    graphRelations: [],
    graphNode: "",
    graphIncludeUnresolved: false,
    graphShowOrphans: true,
    graphShowArrows: false,
    graphCamera: { x: 0, y: 0, scale: 1 },
  });
  assert.equal(parseWorkspaceNavigationUrl("/?view=unknown").view, "hub");
  assert.equal(parseWorkspaceNavigationUrl("/?view=hub").view, "hub");
  assert.equal(parseWorkspaceNavigationUrl("/?view=file&file=README.md").view, "file");
  assert.equal(parseWorkspaceNavigationUrl("/?view=proposal&proposal=p1").view, "proposal");
  assert.deepEqual(parseWorkspaceNavigationUrl("/?view=graph&graphScope=local&graphDepth=3&graphLayers=accepted,target&graphTypes=instruction&graphRelations=applies-to&graphNode=file%3AAGENTS.md&graphUnresolved=1&graphOrphans=0&graphArrows=1&graphCamera=12.5,-4,1.75"), {
    workspaceId: "",
    projectId: "",
    view: "graph",
    folder: "",
    search: "",
    file: "",
    proposal: "",
    settingsSection: "",
    explorerDocumentView: "location",
    graphScope: "local",
    graphDepth: 3,
    graphLayers: ["accepted", "target"],
    graphTypes: ["instruction"],
    graphRelations: ["applies-to"],
    graphNode: "file:AGENTS.md",
    graphIncludeUnresolved: true,
    graphShowOrphans: false,
    graphShowArrows: true,
    graphCamera: { x: 12.5, y: -4, scale: 1.75 },
  });
  assert.equal(parseWorkspaceNavigationUrl("/?view=file&file=README.md&explorerView=related").explorerDocumentView, "related");
});

test("workspace reload circuit permits one exceptional retry and blocks the second", () => {
  const first = workspaceReloadCircuitDecision("", 10_000, 5_000);
  const second = workspaceReloadCircuitDecision(first.value, 10_400, 5_000);
  const expired = workspaceReloadCircuitDecision(first.value, 16_000, 5_000);
  assert.equal(first.allowed, true);
  assert.equal(second.allowed, false);
  assert.equal(expired.allowed, true);
});

test("duplicated workspace identity is replaced exactly once", () => {
  const message = { type: "workspace-conflict", workspaceId: "workspace_123", requester: "client_123" };
  assert.equal(shouldReplaceDuplicatedWorkspaceIdentity({ message, requestedWorkspaceId: "workspace_123", clientInstanceId: "client_123" }), true);
  assert.equal(shouldReplaceDuplicatedWorkspaceIdentity({ message, requestedWorkspaceId: "workspace_123", clientInstanceId: "client_123", alreadyResolved: true }), false);
  assert.equal(shouldReplaceDuplicatedWorkspaceIdentity({ message: { ...message, requester: "other" }, requestedWorkspaceId: "workspace_123", clientInstanceId: "client_123" }), false);
});

test("stale project responses refresh global workspaces without accepting old data", () => {
  assert.equal(contextRoomProjectResponseAction({ expectedProjectId: "old", responseProjectId: "old", globalRoom: true }), "accept");
  assert.equal(contextRoomProjectResponseAction({ expectedProjectId: "", responseProjectId: "host", globalRoom: true }), "initialize");
  assert.equal(contextRoomProjectResponseAction({ expectedProjectId: "old", responseProjectId: "new", globalRoom: true }), "refresh-in-place");
  assert.equal(contextRoomProjectResponseAction({ expectedProjectId: "old", responseProjectId: "new", globalRoom: false }), "exceptional-reload");
});

test("every top-level workspace page owns reliable bounded scrolling", () => {
  const html = renderAppHtml();

  assert.match(html, /\.editor-shell \{[^}]*width: 100%;[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow: hidden;/);
  assert.match(html, /\.workspace-page \{[^}]*height: 100%;[^}]*min-height: 0;[^}]*overflow-x: hidden;[^}]*overflow-y: auto;[^}]*overscroll-behavior: contain;[^}]*scrollbar-gutter: stable;/);
  assert.match(html, /id="home" class="docqa-home workspace-page"/);
  assert.match(html, /id="proposalReviewPage" class="proposal-review-page workspace-page"/);
  assert.match(html, /id="settingsPage" class="settings-page workspace-page"/);
  assert.match(html, /id="newDocPage" class="settings-page workspace-page"/);
});

test("file opening renders loading and retry states instead of a blank document", () => {
  const html = renderAppHtml();

  assert.match(html, /fileLoadError: null/);
  assert.match(html, /state\.fileLoadError = null;/);
  assert.match(html, /const openingFile = state\.openingFilePath === state\.selected && state\.fileContentReadyPath !== state\.selected;/);
  assert.match(html, /const loadingFile = openingFile;/);
  assert.match(html, /const loadError = state\.fileLoadError\?\.path === state\.selected/);
  assert.match(html, /function renderFileLoadingState\(file = \{\}\)/);
  assert.match(html, /function renderFileActionsLoading\(\)/);
  assert.match(html, /file-actions file-actions-loading/);
  assert.match(html, /@keyframes fileActionLoadingPulse/);
  assert.match(html, /Opening file\.\.\./);
  assert.match(html, /function renderFileLoadError\(error = \{\}\)/);
  assert.match(html, /Could not open this file/);
  assert.match(html, /file-load-state error" role="alert"/);
  assert.match(html, /data-file-retry/);
  assert.match(html, /function retrySelectedFileLoad\(\)[\s\S]*retry\.kind === "hosted-review"[\s\S]*retry\.kind === "startup-context"[\s\S]*retry\.kind === "startup-skill"[\s\S]*retry\.kind === "startup-hook"/);
  assert.match(html, /kind: "startup-context",[\s\S]*renderViewer\(\);/);
  assert.match(html, /kind: "startup-skill",[\s\S]*renderViewer\(\);/);
  assert.match(html, /kind: "startup-hook",[\s\S]*renderViewer\(\);/);
  assert.match(html, /kind: "hosted-review",[\s\S]*renderViewer\(\);/);
  assert.match(html, /state\.fileLoadError = \{ path, message: error\.message \|\| "Failed to open file\." \};/);
  assert.match(html, /updateExplorerSelectedFile\(previousSelected, path\)/);
  assert.match(html, /function reconcileMissingSelectedFile\(\)/);
  assert.match(html, /function clearMissingSelectedFile\(stalePath = state\.selected\)/);
  assert.match(html, /function canReviewMissingFile\(path\)/);
  assert.match(html, /return state\.files\.some\(\(file\) => file\.path === path\) \|\| canReviewMissingFile\(path\);/);
  assert.match(html, /item\.path === path && !item\.oldPath/);
  assert.match(html, /clearReviewSession\(stalePath\)/);
  assert.match(html, /state\.page = "hub";/);
  assert.match(html, /function showHome\(\) \{[\s\S]*setStatus\("ready"\);\s*scheduleSessionStatePush\(\);/);
  assert.match(html, /function validSessionSelectedPath\(\)/);
  assert.match(html, /function selectedFileExists\(path = state\.selected\)/);
  assert.match(html, /if \(state\.selected && path !== state\.selected && !selectedFileExists\(\)\) reconcileMissingSelectedFile\(\);/);
  assert.match(html, /if \(!data\.exists && !canReviewMissingFile\(previousSelected\)\) \{/);
  assert.match(html, /if \(reconcileMissingSelectedFile\(\)\) \{/);
  assert.match(html, /openFile: state\.selectedStartupContext \? state\.selectedStartupContext\.displayPath : validSelected/);
  assert.match(html, /selectedPath: validSelected/);
  assert.doesNotMatch(html, /renderFiles\(\);\s*if \(options\.revealInExplorer\)/);
});

test("Shared UI copy distinguishes incomplete coverage, offline cache state, and acceptance state", () => {
  const html = renderAppHtml();

  assert.match(html, /Some Shared repositories could not be checked\. The proposals shown below may be incomplete\./);
  assert.match(html, /unconfirmedReviewMarkup \+ \(queueMarkup/);
  assert.match(html, /Main offline · cached @/);
  assert.match(html, /Main offline · no cached snapshot/);
  assert.match(html, /shared context offline · no cached snapshot available/);
  assert.match(html, /accepted: "Acceptance recorded · main unconfirmed"/);
  assert.doesNotMatch(html, /Pull request ready/);
});

test("interface sound engine synthesizes every cue and honors mute, preview, and volume", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const source = script.slice(
    script.indexOf("function currentContextRoomSoundSettings"),
    script.indexOf("const PLANET_GROUPS"),
  );
  const calls = { oscillators: 0, oscillatorFrequencies: [], linearAttacks: 0, noiseSources: 0, convolvers: 0 };
  const audioParam = () => ({
    setValueAtTime() {},
    linearRampToValueAtTime() {},
    exponentialRampToValueAtTime() {},
  });
  class MockAudioContext {
    constructor() {
      this.currentTime = 1;
      this.sampleRate = 1000;
      this.state = "running";
      this.destination = {};
    }
    createOscillator() {
      calls.oscillators += 1;
      const frequency = audioParam();
      frequency.setValueAtTime = (value) => calls.oscillatorFrequencies.push(value);
      return { connect() {}, start() {}, stop() {}, frequency, type: "sine" };
    }
    createGain() {
      const gain = audioParam();
      gain.linearRampToValueAtTime = () => { calls.linearAttacks += 1; };
      return { connect() {}, gain };
    }
    createBiquadFilter() {
      return { connect() {}, frequency: audioParam(), Q: audioParam(), type: "lowpass" };
    }
    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData(channel) { return data[channel]; } };
    }
    createBufferSource() {
      calls.noiseSources += 1;
      return { buffer: null, connect() {}, start() {}, stop() {} };
    }
    createConvolver() {
      calls.convolvers += 1;
      return { buffer: null, connect() {} };
    }
    resume() {
      this.state = "running";
      return Promise.resolve();
    }
  }
  const state = { settings: { sounds: { enabled: true, volume: 0.35 } } };
  const volumeInput = { value: "50" };
  const volumeOutput = { value: "" };
  const el = (id) => id === "interfaceSoundsVolume" ? volumeInput : id === "interfaceSoundsVolumeValue" ? volumeOutput : null;
  const harness = Function(
    "state",
    "window",
    "el",
    "calls",
    `let contextRoomAudioContext = null;
     let contextRoomAudioUnlocked = false;
     let contextRoomReverbImpulse = null;
     let contextRoomInteractionVariant = 0;
     ${source}
     return { playContextRoomSound, unlockContextRoomAudio, updateSoundVolumePreview };`,
  )(state, { AudioContext: MockAudioContext }, el, calls);

  assert.equal(harness.playContextRoomSound("review-complete"), false);
  harness.unlockContextRoomAudio();
  for (const cue of ["interaction", "review-complete", "all-clear", "proposal-accepted", "attention"]) {
    assert.equal(harness.playContextRoomSound(cue), true);
  }
  assert.equal(calls.oscillators, 14);
  assert.ok(calls.oscillatorFrequencies[0] >= 485 && calls.oscillatorFrequencies[0] <= 505);
  assert.ok(calls.oscillatorFrequencies[1] >= 240 && calls.oscillatorFrequencies[1] <= 255);
  assert.equal(calls.linearAttacks, 2);
  assert.equal(calls.noiseSources, 1);
  assert.equal(calls.convolvers, 4);

  state.settings.sounds.enabled = false;
  assert.equal(harness.playContextRoomSound("review-complete"), false);
  assert.equal(calls.oscillators, 14);
  assert.equal(harness.playContextRoomSound("review-complete", { preview: true }), true);
  assert.equal(calls.oscillators, 17);

  state.settings.sounds.enabled = true;
  state.settings.sounds.volume = 0;
  volumeInput.value = "0";
  assert.equal(harness.playContextRoomSound("attention"), false);
  assert.equal(harness.playContextRoomSound("all-clear", { preview: true }), false);
  volumeInput.value = "65";
  harness.updateSoundVolumePreview();
  assert.equal(volumeOutput.value, "65%");
});

test("interface sounds add restrained button feedback and richer cues only for meaningful outcomes", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const interactionSource = script.slice(script.indexOf("function playContextRoomButtonBeat"), script.indexOf("function updateSoundVolumePreview"));
  const reviewSource = script.slice(script.indexOf("async function applyReviewDecision"), script.indexOf("async function advanceAfterInlineReviewRemoval"));
  const conflictSource = script.slice(script.indexOf("async function checkSelectedFileConflict"), script.indexOf("async function applyExternalChange"));
  const saveSource = script.slice(script.indexOf("async function saveCurrent"), script.indexOf("async function refreshFromDisk"));

  assert.match(interactionSource, /target\?\.closest\?\.\("button"\)/);
  assert.match(interactionSource, /button\.disabled/);
  assert.match(interactionSource, /button\.closest\("\[data-sound-preview\]"\)/);
  assert.match(interactionSource, /contextRoomLastInteractionSoundAt < 35/);
  assert.match(interactionSource, /playContextRoomSound\("interaction"\)/);
  assert.match(script, /frequency: 493\.88 \* pitch/);
  assert.match(script, /frequency: 246\.94 \* pitch/);
  assert.match(script, /new AudioContextCtor\(\{ latencyHint: "interactive" \}\)/);
  assert.match(script, /cue === "interaction" \? 1600 : 2600/);
  assert.match(script, /cue === "interaction" \? Math\.min\(1, sounds\.volume \* 1\.35\) : sounds\.volume/);
  assert.match(script, /document\.addEventListener\("click", playContextRoomButtonBeat\)/);
  assert.match(reviewSource, /const reviewCompleted = normalizedStatus === "verified"/);
  assert.match(reviewSource, /playContextRoomSound\(reviewQueueCleared \? "all-clear" : "review-complete"\)/);
  assert.doesNotMatch(reviewSource, /proposalFinalization|proposal-accepted/);
  assert.match(script, /async function completeSharedProposalAcceptance\([\s\S]*playContextRoomSound\("proposal-accepted"\)/);
  assert.match(conflictSource, /const existingConflict = activeFileConflict\(\);[\s\S]*if \(existingConflict && existingConflict\.diskHash === data\.contentHash[\s\S]*return true;[\s\S]*playContextRoomSound\("attention"\)/);
  assert.doesNotMatch(saveSource, /playContextRoomSound/);
});

test("HTML files open as sandboxed visual previews without source editing", () => {
  const html = renderAppHtml();

  assert.match(html, /function isHtmlDocumentPath\(filePath\)/);
  assert.match(html, /function sanitizedHtmlPreviewDocument\(source\)/);
  assert.match(html, /doc\.querySelectorAll\("script, iframe, frame, object, embed, base"\)/);
  assert.match(html, /Content-Security-Policy/);
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'/);
  assert.match(html, /function contextRoomVisualDocumentStyles\(\)/);
  assert.match(html, /getComputedStyle\(document\.documentElement\)/);
  assert.match(html, /\["--cr-bg", token\("--file-bg"/);
  assert.match(html, /\.cr-comparison/);
  assert.match(html, /\.cr-flow/);
  assert.match(html, /\.cr-flow \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(html, /@media \(max-width: 760px\)[^\n]*\.cr-flow \{ grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(html, /\.cr-metrics/);
  assert.match(html, /\.cr-callout/);
  assert.match(html, /theme\.setAttribute\("data-context-room-visual-system", currentFileThemeId\(\)\)/);
  assert.match(html, /doc\.documentElement\.dataset\.contextRoomTheme = currentFileThemeId\(\)/);
  assert.match(html, /function applyFileTheme\(themeId = currentFileThemeId\(\), colorMode = currentColorModePreference\(\)\)[\s\S]*document\.querySelector\("iframe\.html-preview-frame"\)[\s\S]*renderViewer\(\);/);
  assert.match(html, /function renderHtmlDocumentPreview\(text, filePath = state\.selected\)/);
  assert.match(html, /class="html-preview-frame" sandbox="allow-same-origin" referrerpolicy="no-referrer"/);
  assert.match(html, /isHtmlDocument\s*\? renderHtmlDocumentPreview\(text, file\.path\)/);
  assert.match(html, /externalChange[\s\S]*isHtmlDocument[\s\S]*renderHtmlDocumentPreview\(externalChange\.diskContent \|\| "", file\.path\)/);
  assert.match(html, /const visualHtmlReview = isHtmlDocumentPath\(change\.path\);/);
  assert.match(html, /const jumpAction = summary\.pending && !visualHtmlReview/);
  assert.match(html, /const bulkActions = summary\.pending\s*\?/);
  assert.match(html, /savable: !isHtmlDocument/);
  assert.match(html, /savable \? '<button class="file-action primary"/);
});

test("image and exported diagram files open in a fitted read-only visual preview", () => {
  const html = renderAppHtml();

  assert.match(html, /function isImageDocumentPath\(filePath\)/);
  assert.match(html, /function renderImageDocumentPreview\(asset, filePath = state\.selected\)/);
  assert.match(html, /class="image-preview-stage/);
  assert.match(html, /data-image-size-toggle/);
  assert.match(html, /image\.naturalWidth \+ " × " \+ image\.naturalHeight/);
  assert.match(html, /isImageDocument\s*\? renderImageDocumentPreview\(state\.selectedVisualAsset, file\.path\)/);
  assert.match(html, /savable: !isHtmlDocument && !isImageDocument/);
  assert.match(html, /isImageDocumentPath\(path\) \? Promise\.resolve\(null\)/);
});

test("recurring theme refresh keeps an unchanged HTML preview iframe alive", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const themeSource = script.slice(script.indexOf("function currentFileThemeId"), script.indexOf("function previewSelectedFileTheme"));
  const settingsSource = script.slice(script.indexOf("function applySettingsPayload"), script.indexOf("function backgroundReportRenderKey"));
  const document = {
    documentElement: { dataset: { fileTheme: "context-room", appTheme: "context-room", colorMode: "dark", colorPreference: "system" } },
    frame: { id: "interactive-preview" },
    querySelector(selector) {
      return selector === "iframe.html-preview-frame" ? this.frame : null;
    },
  };
  const state = {
    settings: { appearance: { fileTheme: "context-room", colorMode: "system" } },
    availableHubCards: [],
    hubFolders: [],
    rootHubSections: [],
    hubSections: [],
    selected: "docs/interactive.html",
    openingFilePath: null,
  };
  const harness = Function(
    "state",
    "document",
    "FILE_THEMES",
    "DEFAULT_FILE_THEME",
    "isHtmlDocumentPath",
    "captureEditorViewState",
    "restoreEditorViewState",
    `let renderViewer = () => {};
    ` + themeSource + settingsSource + `
      let renderCount = 0;
      renderViewer = () => {
        renderCount += 1;
        document.frame = { id: "replacement-" + renderCount };
      };
      return {
        applySettingsPayload,
        renderCount: () => renderCount,
      };
    `,
  )(
    state,
    document,
    FILE_THEME_OPTIONS,
    "context-room",
    (filePath) => /\.html?$/i.test(filePath),
    () => ({ path: state.selected }),
    () => {},
  );

  const originalFrame = document.frame;
  harness.applySettingsPayload({ settings: { appearance: { fileTheme: "context-room" } } });
  assert.strictEqual(document.frame, originalFrame);
  assert.equal(harness.renderCount(), 0);

  harness.applySettingsPayload({ settings: { appearance: { fileTheme: "light-plus" } } });
  assert.notStrictEqual(document.frame, originalFrame);
  assert.equal(harness.renderCount(), 1);
});

test("visual HTML library keeps forty data patterns and exposes five distinct diagram templates", () => {
  const html = renderAppHtml();
  const conceptCatalog = fs.readFileSync(new URL("../docs/context-room-visual-components.html", import.meta.url), "utf8");
  const dataCatalog = fs.readFileSync(new URL("../docs/context-room-data-visual-components.html", import.meta.url), "utf8");
  const reference = fs.readFileSync(new URL("../docs/features/html-visual-patterns.md", import.meta.url), "utf8");
  const groups = VISUAL_DOCUMENT_PATTERNS.reduce((result, pattern) => {
    (result[pattern.group] ||= []).push(pattern);
    return result;
  }, {});
  const conceptCatalogIds = [...conceptCatalog.matchAll(/data-pattern="([^"]+)"/g)].map((match) => match[1]);
  const dataCatalogIds = [...dataCatalog.matchAll(/data-pattern="([^"]+)"/g)].map((match) => match[1]);
  const conceptPanels = conceptCatalog.split('<article class="pattern-panel"').slice(1);

  assert.equal(DIAGRAM_VISUAL_DOCUMENT_PATTERNS.length, 5);
  assert.strictEqual(CONCEPT_VISUAL_DOCUMENT_PATTERNS, DIAGRAM_VISUAL_DOCUMENT_PATTERNS);
  assert.equal(DATA_VISUAL_DOCUMENT_PATTERNS.length, 40);
  assert.equal(VISUAL_DOCUMENT_PATTERNS.length, 45);
  assert.equal(new Set(VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.id)).size, 45);
  assert.equal(new Set(VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.className)).size, 45);
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([group, patterns]) => [group, patterns.length])), {
    "data-summary": 10,
    "data-comparison": 10,
    "data-chart": 10,
    "data-structure": 10,
    diagram: 5,
  });
  assert.deepEqual(conceptCatalogIds, DIAGRAM_VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.id));
  assert.deepEqual(dataCatalogIds, DATA_VISUAL_DOCUMENT_PATTERNS.map((pattern) => pattern.id));
  assert.equal((conceptCatalog.match(/type="radio"/g) || []).length, 5);
  assert.ok((conceptCatalog.match(/<details\b/g) || []).length >= 5);
  assert.equal((conceptCatalog.match(/pattern-demo cr-diagram-scroll" tabindex="0"/g) || []).length, 5);
  assert.match(conceptCatalog, /--cr-cols: 16/);
  assert.match(conceptCatalog, /min-width: 1480px/);
  assert.match(conceptCatalog, /max-height: 720px/);
  assert.equal(conceptPanels.length, 5);
  for (const panel of conceptPanels) {
    assert.ok((panel.match(/class="cr-diagram-node"/g) || []).length >= 10);
    assert.equal((panel.match(/class="example-brief"/g) || []).length, 1);
    assert.equal((panel.match(/class="example-reading"/g) || []).length, 1);
  }
  assert.match(conceptCatalog, /#view-system:checked ~ \.pattern-panels \[data-panel="system"\]/);
  assert.match(conceptCatalog, /#view-reasoning:focus-visible ~ \.pattern-tabs label\[for="view-reasoning"\]/);
  assert.ok(html.includes("details.cr-diagram-node > summary"));
  assert.ok(html.includes(".cr-diagram-node:has(> summary:focus-visible)"));
  for (const pattern of VISUAL_DOCUMENT_PATTERNS) {
    assert.ok(html.includes("." + pattern.className), `missing injected styles for ${pattern.className}`);
    assert.ok(reference.includes("`." + pattern.className), `missing reference for ${pattern.className}`);
  }
  for (const catalog of [conceptCatalog, dataCatalog]) {
    assert.doesNotMatch(catalog, /<script\b/i);
    assert.doesNotMatch(catalog, /\b(?:src|href)=["']https?:/i);
  }
});

test("file opening shows content before secondary dependencies and keeps actions stable", () => {
  const html = renderAppHtml();
  const selectFileFn = html.match(/async function selectFile\(path, options = \{\}\) \{[\s\S]*?\n\}\n\nasync function selectStartupContextFile/)?.[0] || "";

  assert.match(selectFileFn, /const fileRequest = readFileForOpen\(path, \{ force: options\.forceReload \}\);/);
  assert.match(selectFileFn, /const annotationsRequest = settleUiRequest\(loadAnnotationsForPath\(path\)\);/);
  assert.match(selectFileFn, /const diffRequest = settleUiRequest\(readDiffForOpen\(path, \{ force: options\.forceReload \}\)\);/);
  assert.match(selectFileFn, /const reviewBaseRequest = options\.reviewMode[\s\S]*settleUiRequest\(readSelectedReviewBase\(path\)\)/);
  assert.match(selectFileFn, /const data = await fileRequest;[\s\S]*state\.fileContentReadyPath = path;\s*renderViewer\(\);[\s\S]*void annotationsRequest\.then/);
  assert.doesNotMatch(selectFileFn, /await annotationsRequest/);
  assert.match(selectFileFn, /state\.fileContentReadyPath = path;\s*renderViewer\(\);\s*restorePersistedViewState\(options\.restoreViewState\);/);
  assert.match(selectFileFn, /setStatus\("open · loading Git diff\.\.\."\);/);
  assert.match(selectFileFn, /const \[diffResult, reviewBaseResult\] = await Promise\.all\(\[diffRequest, reviewBaseRequest\]\);/);
  assert.match(selectFileFn, /const \[diffResult, reviewBaseResult\] = await Promise\.all\(\[diffRequest, reviewBaseRequest\]\);[\s\S]*?finishOpen\(diffResult, reviewBaseResult\);/);
  assert.doesNotMatch(selectFileFn, /finishOpen\(null, null\)/);
  assert.doesNotMatch(selectFileFn, /diffRequest\.then/);
  assert.doesNotMatch(selectFileFn, /await loadAnnotationsForPath\(path\)[\s\S]*renderViewer\(\);[\s\S]*const loadDiff/);
  assert.match(selectFileFn, /const contentViewState = captureEditorViewState\(\);/);
  assert.match(selectFileFn, /state\.openingFilePath = null;\s*state\.fileContentReadyPath = null;/);
  assert.match(selectFileFn, /restoreEditorViewState\(contentViewState\);/);
  assert.match(html, /function applyChangedFileInlineReview\(path, diff, review, requestId = state\.selectionRequest\)/);
  assert.match(html, /return applyChangedFileInlineReview\(path, diff, review, requestId\);/);
  assert.match(html, /\[data-file-path\], \[data-review-path\], \[data-hub-file\]/);
  assert.match(html, /const diffPromise = isImageDocumentPath\(path\) \? Promise\.resolve\(null\) : api\("\/api\/file\/diff\?path=" \+ encodeURIComponent\(path\)\);/);
  assert.match(html, /if \(isImageDocumentPath\(path\)\) return Promise\.resolve\(null\);/);
  assert.match(html, /document\.addEventListener\("pointerover", \(event\) => schedulePrefetchPathFromTarget\(event\.target\)/);
  assert.match(html, /workspaceDock\?\.setAttribute\("aria-busy", fileOpening \? "true" : "false"\);/);
  assert.doesNotMatch(html, /\.workspace-dock\.file-opening\s*\{[^}]*visibility:\s*hidden/);
});

test("verification actions are limited to files opened from the review queue", () => {
  const html = renderAppHtml();

  assert.match(html, /reviewModePath: null, reviewModeStatus: null/);
  assert.match(html, /openReviewQueueItem\(item\)\.catch\(\(error\) => setStatus\(error\.message\)\)/);
  assert.match(html, /await selectStartupContextFile\(item\.startupContext\.order, \{ reviewMode: true \}\);/);
  assert.match(html, /await selectStartupSkillFile\(folder, skill, \{ reviewMode: true \}\);/);
  assert.match(html, /await selectFile\(item\.path, \{ reviewMode: true \}\);/);
  assert.match(html, /state\.reviewModePath = options\.reviewMode \? path : null;/);
  assert.match(html, /state\.reviewModePath = options\.reviewMode \? finalPath : null;/);
  assert.match(html, /renderFileActionButtons\(\{ reviewAction: reviewActionForSelectedFile\(\), secondaryReviewAction: secondaryReviewActionForSelectedFile\(\), nextReviewAction: nextReviewActionForSelectedFile\(\)/);
  assert.match(html, /function reviewActionForSelectedFile\(\)/);
  assert.match(html, /if \(!state\.selected \|\| state\.reviewModePath !== state\.selected\) return null;/);
  assert.match(html, /if \(state\.reviewModeStatus === "verified"\) return null;/);
  assert.match(html, /const reviewItem = state\.docqa\?\.queue\?\.find\(\(item\) => item\.path === state\.selected\);/);
  assert.match(html, /if \(!reviewItem\?\.reviewRequired \|\| String\(reviewItem\.gitStatus \|\| ""\)\.trim\(\)\) return null;/);
  assert.doesNotMatch(html, /label: "Mark unverified"/);
  assert.doesNotMatch(html, />Mark unverified</);
  assert.match(html, /function nextReviewActionForSelectedFile\(\)/);
  assert.match(html, /return nextReviewItemForManualAdvance\(\) \? \{ label: "Next review" \} : null;/);
  assert.doesNotMatch(html, /state\.reviewModeStatus !== "verified"/);
  assert.match(html, /data-file-review-decision/);
  assert.match(html, /data-next-review/);
  assert.match(html, /openNextReviewManually\(\)\.catch\(\(error\) => setStatus\(error\.message\)\)/);
  assert.match(html, /requestReviewDecision\(state\.selected, event\.currentTarget\.dataset\.fileReviewDecision\)/);
  assert.doesNotMatch(html, /VERIFY_CONFIRM_STORAGE_KEY/);
  assert.doesNotMatch(html, /Do not ask again/);
  assert.match(html, /function showHumanReviewDecisionDialog\(/);
  assert.match(html, /HUMAN_REVIEW_DOUBLE_CONFIRMATION_POLICY/);
  assert.match(html, /const checkboxLabel = "If an agent is operating, the user separately confirmed this exact action a second time"/);
  assert.match(html, /checkboxLabel: additionalAcknowledgement \? checkboxLabel/);
  assert.match(html, /checkboxRequired: true/);
  const singleFileDecisionSource = html.slice(html.indexOf("async function requestReviewDecision"), html.indexOf("async function verifyCurrentFile"));
  assert.doesNotMatch(singleFileDecisionSource, /showHumanReviewDecisionDialog/);
  assert.match(singleFileDecisionSource, /await applyReviewDecision\(path, normalizedStatus\)/);
  assert.match(html, /<strong>First review<\/strong> <span>No previous baseline exists for this first review\./);
  assert.match(html, /label: "Accept document"/);
  assert.match(html, /label: "Request changes"/);
  assert.match(html, /if \(!reviewActionForSelectedFile\(\)\) return;/);
  assert.match(html, /applyReviewDecision\(path, normalizedStatus\)/);
  assert.match(html, /function requestContextRoomReviewRejection\(ids\) \{[\s\S]*showHumanReviewDecisionDialog\(/);
  assert.match(html, /function requestDeletionReviewBatchConfirmation\(\) \{[\s\S]*showHumanReviewDecisionDialog\(/);
  const externalApplySource = html.slice(html.indexOf("function requestApplyExternalChange"), html.indexOf("async function rejectExternalChange"));
  assert.doesNotMatch(externalApplySource, /showHumanReviewDecisionDialog/);
  assert.match(externalApplySource, /applyExternalChange\(\)/);
  assert.match(externalApplySource, /rejectExternalChange\(change\.path\)/);
  assert.match(html, /const previousQueue = options\.previousQueue \|\| state\.docqa\?\.queue \|\| \[\];/);
  assert.match(html, /function nextReviewItemAfter\(previousQueue = \[\], currentPath = null, nextQueue = \[\]\)/);
  assert.match(html, /function nextReviewItemForManualAdvance\(\) \{[\s\S]*return nextReviewItemAfter\(queue, state\.reviewModePath \|\| state\.selected \|\| state\.selectedReview, queue\);/);
  assert.match(html, /async function waitForReviewFinalizationBeforeNavigation\(\)/);
  assert.match(html, /async function openNextReviewManually\(\) \{\s*await waitForReviewFinalizationBeforeNavigation\(\);/);
  assert.match(html, /async function handleBrandHomeAction\(\)[\s\S]*await waitForReviewFinalizationBeforeNavigation\(\);\s*goHub\(\);/);
  assert.match(html, /async function selectFile\(path, options = \{\}\) \{[\s\S]*await waitForReviewFinalizationBeforeNavigation\(\);/);
  assert.match(html, /async function advanceAfterInlineReviewRemoval\(path, previousQueue, statusWhenDone\)/);
  assert.doesNotMatch(html, /file verified · next doc open/);
  assert.doesNotMatch(html, /review applied · next doc open/);
  assert.match(html, /status === "unverified"/);
  assert.doesNotMatch(html, /selectedFileNeedsReview/);
  assert.doesNotMatch(html, /data-file-verify/);
});

test("review queue groups removed files into a selectable human-confirmed batch", () => {
  const html = renderAppHtml();

  assert.match(html, /const groupDeletions = Number\(s\.deletedDocs \|\| 0\) > 1 \|\| state\.deletionBatchItems\.length > 0;/);
  assert.match(html, /item\.resourceState === "absent"/);
  assert.match(html, /item\.batchDeletion === true/);
  assert.match(html, /queue\.filter\(\(item\) => !isDeletedReviewQueueItem\(item\)\)/);
  assert.match(html, /data-review-deletion-batch/);
  assert.match(html, /Files removed together/);
  assert.match(html, /review this cleanup as one change set/);
  assert.match(html, /data-review-deletion-path/);
  assert.match(html, /data-review-deletion-select-all/);
  assert.match(html, /data-review-deletion-confirm/);
  assert.match(html, /preserveSelection \? previousSelection\.has\(item\.path\) : !item\.protected/);
  assert.match(html, /additionalAcknowledgement: protectedCount \? "I also reviewed the protected paths\." : ""/);
  assert.match(html, /function showHumanReviewDecisionDialog\([\s\S]*checkboxRequired: true/);
  assert.match(html, /checkboxRequired \? ' disabled' : ''/);
  assert.match(html, /if \(checkboxRequired\) checkbox\?\.addEventListener\("change"[\s\S]*confirmButton\.disabled = !event\.currentTarget\.checked/);
  assert.match(html, /state\.deletionBatchKey !== String\(s\.deletedReviewKey \|\| ""\)/);
  assert.match(html, /const restoreDeletionBatchFocus = Boolean\(loadedBatchChanged/);
  assert.match(html, /if \(restoreDeletionBatchFocus\) document\.querySelector\("\[data-review-deletion-batch\] > summary"\)\?\.focus\(\);/);
  assert.match(html, /details\?\.setAttribute\("aria-busy", "true"\)/);
  assert.match(html, /if \(state\.deletionBatchLoading\) return;/);
  assert.match(html, /\.review-deletion-body button, \.review-deletion-body input/);
  assert.match(html, /deletedReviewKey: state\.deletionBatchKey/);
  assert.match(html, /data-review-deletion-retry/);
  assert.match(html, /data-review-deletion-batch' \+ detailsOpen \+ detailsBusy/);
  assert.match(html, /data-review-deletion-select-all' \+ controlsDisabled/);
  assert.match(html, /api\("\/api\/docqa\/review-deletions"\)/);
  assert.match(html, /const batchKey = state\.deletionBatchKey;/);
  assert.match(html, /method: "POST"[\s\S]*JSON\.stringify\(\{ paths, key: batchKey, protectedAcknowledged \}\)/);
  assert.match(html, /onConfirm: \(\{ checked \}\) => confirmDeletionReviewBatch/);
  assert.match(html, /These files are already absent\. This records that their removal was intentional; it does not delete files\./);
  assert.match(html, /if \(result\.docqa\) state\.docqa = result\.docqa;/);
  assert.match(html, /backdrop\.querySelector\(checkboxRequired \? "\[data-confirm-checkbox\]" : "\[data-confirm-accept\]"\)\?\.focus\(\);/);
  assert.match(html, /if \(restoreFocus && returnFocus\?\.isConnected\) returnFocus\.focus\(\);/);
  assert.match(html, /appShell\?\.setAttribute\("inert", ""\)/);
  assert.match(html, /if \(event\.key !== "Tab"\) return;/);
  assert.match(html, /document\.querySelector\("\[data-review-deletion-batch\] > summary"\) \|\| el\("reviewQueueHeading"\)/);
  assert.match(html, /state\.deletionBatchItems\.find\(\(item\) => item\.path === path\)/);
  assert.match(html, /\.review-deletion-batch \{[^}]*border-left: 3px solid var\(--danger\)/);
});

test("the explorer persists its state and only its own controls can change it", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);
  const responsiveSource = script.slice(
    script.indexOf("function syncResponsiveSidebar"),
    script.indexOf("function syncSidebarToggleIcon"),
  );
  const localResponsiveSource = responsiveSource.slice(
    responsiveSource.indexOf("const collapsed = isExplorerCollapsed();"),
  );
  const collapseSource = script.slice(
    script.indexOf("function applyExplorerCollapsed"),
    script.indexOf("function setExplorerCollapsedFromUser"),
  );
  const focusSource = script.slice(
    script.indexOf("function focusExplorer"),
    script.indexOf("function homeAction"),
  );

  assert.match(html, /explorerCollapsed: typeof raw\.explorerCollapsed === "boolean" \? raw\.explorerCollapsed : null/);
  assert.match(html, /explorerCollapsed: state\.explorerNavigationOverride === null[\s\S]*isExplorerCollapsed\(\)[\s\S]*Boolean\(state\.explorerStoredCollapsed\)/);
  assert.match(html, /if \(options\.initial\) restoreExplorerStateAfterInitialLoad\(\);/);
  assert.match(html, /function restoreExplorerStateAfterInitialLoad\(\)[\s\S]*navigationMode === "collapsed"[\s\S]*navigationMode === "expanded"[\s\S]*applyExplorerCollapsed\(state\.explorerNavigationOverride \?\? storedCollapsed\);/);
  assert.match(collapseSource, /syncResponsiveSidebar\(\);/);
  assert.match(html, /el\("sidebarToggle"\)\.addEventListener\("click", \(\) => \{[\s\S]*setExplorerCollapsedFromUser\(!isExplorerCollapsed\(\)\);[\s\S]*restoreFocusAfterExplorerClose\(\)/);
  assert.match(html, /el\("explorerOpen"\)\?\.addEventListener\("click", \(event\) => \{[\s\S]*state\.explorerReturnFocus = event\.currentTarget;[\s\S]*setExplorerCollapsedFromUser\(false\);[\s\S]*focusExplorerAfterOpen\(\)/);
  assert.match(html, /function contextRoomProposalReviewUrl\([\s\S]*searchParams\.set\("explorer", \(isExplorerDrawerViewport\(\) \|\| isExplorerCollapsed\(\)\) \? "collapsed" : "expanded"\)/);
  assert.match(html, /function openContextHubProject\([\s\S]*searchParams\.set\("explorer", \(isExplorerDrawerViewport\(\) \|\| isExplorerCollapsed\(\)\) \? "collapsed" : "expanded"\)/);
  assert.match(html, /id="explorerEdgeTrigger" class="explorer-edge-trigger"/);
  assert.match(html, /\.app\.sidebar-collapsed:not\(\.explorer-edge-peek\) \.explorer-edge-trigger/);
  assert.match(html, /\.app\.sidebar-collapsed\.explorer-edge-peek > main \{ grid-column: 2; \}/);
  assert.match(html, /function setExplorerEdgePeek\(open\)[\s\S]*classList\.toggle\("explorer-edge-peek"/);
  assert.match(html, /explorerEdgeTrigger"\)\?\.addEventListener\("pointerenter", \(\) => setExplorerEdgePeek\(true\)\)/);
  assert.match(html, /document\.addEventListener\("pointermove", revealExplorerFromLeftEdge, \{ passive: true \}\)/);
  assert.match(html, /pointerleave", \(\) => \{[\s\S]*setExplorerEdgePeek\(false\)/);
  assert.match(html, /event\.clientX > state\.explorerWidth \+ 12\) setExplorerEdgePeek\(false\)/);
  assert.doesNotMatch(html, /explorerEdgePeekCloseTimer|scheduleExplorerEdgePeekClose/);
  assert.match(html, /function setExplorerCollapsedFromUser\(collapsed\)[\s\S]*state\.explorerNavigationOverride = null;[\s\S]*state\.explorerStoredCollapsed = Boolean\(collapsed\);/);
  assert.match(responsiveSource, /if \(IS_HOSTED_CONTEXT_ROOM\) \{[\s\S]*classList\.add\("sidebar-collapsed"\)[\s\S]*return;/);
  assert.doesNotMatch(localResponsiveSource, /sidebar-collapsed/);
  assert.doesNotMatch(focusSource, /classList\.(?:add|remove|toggle)\("sidebar-collapsed"/);
  assert.doesNotMatch(html, /openSidebarIfCollapsed|collapseSidebarOnNarrow|mobileSidebarTouched/);
  assert.match(html, /if \(options\.revealInExplorer && !isExplorerCollapsed\(\)\) scrollExplorerToPath\(path\);/);
  assert.match(html, /const overlayOpen = !desktop && !collapsed;[\s\S]*main\.inert = overlayOpen;[\s\S]*main\.setAttribute\("aria-hidden", "true"\)/);
  assert.match(html, /event\.key === "Escape"[\s\S]*setExplorerCollapsedFromUser\(true\);[\s\S]*restoreFocusAfterExplorerClose\(\)/);
  assert.match(html, /event\.key === "Tab"[\s\S]*explorerFocusableElements\(\)/);
  assert.match(html, /aria-pressed="' \+ String\(filter === value\) \+ '" data-global-project-watch-filter/);
});

test("responsive Explorer uses one shared mobile, drawer, and desktop contract", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);
  const viewportSource = script.slice(
    script.indexOf("const EXPLORER_MOBILE_MAX_WIDTH"),
    script.indexOf("function restoreExplorerStateAfterInitialLoad"),
  );
  const explorerViewportMode = Function(viewportSource + "\nreturn explorerViewportMode;")();
  const drawerCssStart = html.lastIndexOf("@media (max-width: 980px)");
  const mobileCssStart = html.lastIndexOf("@media (max-width: 639px)");
  const drawerCss = html.slice(drawerCssStart, mobileCssStart);

  assert.deepEqual(
    [390, 639, 640, 899, 900, 920, 980, 981, 1024, 1440].map((width) => explorerViewportMode(width)),
    ["mobile", "mobile", "drawer", "drawer", "drawer", "drawer", "drawer", "desktop", "desktop", "desktop"],
  );
  assert.match(html, /@media \(min-width: 981px\) and \(hover: hover\) and \(pointer: fine\)/);
  assert.doesNotMatch(html, /height:\s*min\(62dvh, 560px\)/);
  assert.doesNotMatch(html, /height:\s*min\(66dvh, 560px\)/);
  assert.doesNotMatch(script, /max-width:\s*899px|min-width:\s*900px/);

  assert.match(
    drawerCss,
    /@media \(max-width: 980px\) \{[\s\S]*?\.app, \.app\.sidebar-collapsed \{[^}]*height:\s*100dvh;[^}]*padding-top:\s*0;[^}]*overflow:\s*hidden;[^}]*\}[\s\S]*?main \{[^}]*height:\s*100dvh;[^}]*padding:\s*0;[^}]*\}[\s\S]*?\.app > aside \{[^}]*height:\s*calc\(100dvh - var\(--native-titlebar-height\)\);[^}]*max-height:\s*none;[^}]*border-bottom:\s*0;[\s\S]*?\.app\.sidebar-collapsed \.workspace-dock \{\s*padding-left:\s*48px;\s*\}/,
  );
  assert.match(
    html,
    /@media \(max-width: 639px\) \{[\s\S]*?\.app\.explorer-expanded > aside \{[^}]*height:\s*100dvh;[^}]*max-height:\s*none;[^}]*border-radius:\s*0;[^}]*transform:\s*translateX\(0\);[^}]*pointer-events:\s*auto;/,
  );
  assert.doesNotMatch(drawerCss, /\.context-room-brand strong[^}]*display:\s*none/);
  assert.match(html, /\.context-room-brand \{[^}]*flex:\s*0 0 auto/);
  assert.match(html, /\.diff-panel > \.diff-header, \.file-panel > header \{ flex:\s*0 0 auto; \}/);
  assert.match(html, /\.dock-status \{[\s\S]*?flex:\s*0 1 220px;[\s\S]*?text-overflow:\s*ellipsis;/);
  assert.doesNotMatch(html, /\.dock-status \{[^}]*clip:\s*rect/);
  assert.match(html, /--workbench-gutter:\s*var\(--space-5\)/);
  assert.match(html, /--workbench-gutter-compact:\s*var\(--space-3\)/);
  assert.match(html, /\.settings-page \.settings-card > \.settings-page-header \{[^}]*padding:\s*16px var\(--workbench-gutter\)/);
});

test("quiet workbench spacing uses semantic gutters instead of competing surface values", () => {
  const html = renderAppHtml();

  assert.match(html, /--workbench-gutter:\s*var\(--space-5\)/);
  assert.match(html, /--workbench-gutter-compact:\s*var\(--space-3\)/);
  assert.match(html, /--explorer-gutter:\s*var\(--space-2\)/);
  assert.match(html, /--inspector-gutter:\s*var\(--space-4\)/);
  assert.match(html, /--dialog-gutter:\s*var\(--space-5\)/);
  assert.match(html, /\.workspace-dock \{[^}]*padding:\s*5px var\(--workbench-gutter-compact\)/);
  assert.match(html, /@media \(max-width: 639px\) \{[\s\S]*?\.workspace-dock \{[^}]*padding-right:\s*var\(--workbench-gutter-compact\)/);
  assert.match(html, /\.context-hub-review-toolbar, \.context-room-review-toolbar \{[^}]*padding:\s*7px var\(--workbench-gutter\)/);
  assert.match(html, /\.review-item, \.context-room-proposal-row, \.context-hub-review-item \{[^}]*padding:\s*10px var\(--workbench-gutter\)/);
  assert.match(html, /\.settings-search input \{[^}]*padding:\s*8px 40px 8px var\(--workbench-gutter-compact\)/);
  assert.match(html, /\.settings-search-control \{ position:\s*relative; \}/);
  assert.match(html, /\.settings-search-icon \{[^}]*right:\s*var\(--workbench-gutter-compact\)/);
  assert.match(html, /<svg class="ui-icon settings-search-icon" aria-hidden="true"><use href="#cr-icon-search"><\/use><\/svg>/);
  assert.match(html, /\.sr-only \{[^}]*position:\s*absolute !important;[^}]*width:\s*1px !important;/);
  assert.match(html, /\.diff-header, \.file-panel header \{[^}]*padding:\s*8px var\(--workbench-gutter\)/);
  assert.match(html, /\.proposal-review-empty \{[^}]*padding-inline:\s*var\(--workbench-gutter\)/);
  assert.match(html, /\.document-context-head \{[^}]*padding:\s*12px var\(--inspector-gutter\)/);
  assert.match(html, /\.document-context-body \{[^}]*padding:\s*8px var\(--inspector-gutter\) 24px/);
  assert.match(html, /#contextHealthPanel > header \{[^}]*padding-inline:\s*var\(--inspector-gutter\)/);
  assert.match(html, /\.global-project-inspection \{[^}]*padding:\s*12px var\(--inspector-gutter\)/);
  assert.match(html, /\.graph-filterbar \{[^}]*flex-wrap:\s*nowrap;[^}]*padding:\s*6px var\(--workbench-gutter\);[^}]*overflow-x:\s*auto/);
  assert.match(html, /\.sidebar-head \{[^}]*padding:\s*0 0 8px/);
  assert.match(html, /\.app\.sidebar-collapsed \.sidebar-head \{[^}]*padding:\s*0 0 8px/);
  assert.doesNotMatch(html, /(?:^|\n)\s*aside \{/);
  assert.doesNotMatch(html, /\.app\.sidebar-collapsed aside/);
  assert.match(html, /\.app\.sidebar-collapsed > aside \{[^}]*transform:\s*translateX\(-105%\)/);
  assert.match(html, /@media \(max-width: 639px\) \{[\s\S]*?--dialog-gutter:\s*var\(--space-3\)/);
  assert.match(html, /@media \(max-width: 639px\) \{[\s\S]*?--inspector-gutter:\s*var\(--space-3\)/);
  assert.match(html, /@media \(max-width: 639px\) \{[\s\S]*?\.hub-disclosure summary, \.docqa-disclosure summary,[\s\S]*?\.hub-disclosure-body \{ padding-inline:\s*var\(--workbench-gutter-compact\)/);
  assert.match(html, /@media \(max-width: 639px\) \{[\s\S]*?\.graph-list-row \{[^}]*padding-inline:\s*var\(--workbench-gutter-compact\)/);
});

test("workbench accessibility polish keeps status, labels, menus, tabs, and modal focus explicit", () => {
  const html = renderAppHtml();

  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  assert.match(html, /--surface:\s*var\(--panel\)/);
  assert.match(html, /--surface-hover:/);
  assert.match(html, /--label:\s*var\(--text-soft\)/);
  assert.match(html, /--warning:\s*var\(--warn\)/);
  assert.match(html, /id="status" class="dock-status" role="status" aria-live="polite" aria-atomic="true"/);
  assert.match(html, /function setStatus\(text\) \{[\s\S]*status\.title = text;/);
  assert.match(html, /aria-expanded="' \+ String\(open\) \+ '" aria-label="' \+ escapeHtml\(selectionMode \?[\s\S]*: \(open \? "Collapse " : "Expand "\) \+ node\.name \+ " folder"\)/);
  assert.doesNotMatch(html, /title="ouvrir\/fermer"/);
  for (const id of ["startupContextFileNames", "startupContextGlobalPaths", "startupSkillFolderNames", "startupHookFileNames", "startupHookManagerPaths", "startupAgentHookSources"]) {
    assert.match(html, new RegExp('<label class="settings-input-label" for="' + id + '">'));
  }
  assert.match(html, /id="explorerContextMenu" class="explorer-context-menu" role="menu"/);
  assert.match(html, /function prepareExplorerContextMenu\([\s\S]*item\.setAttribute\("role", "menuitem"\)/);
  assert.match(html, /event\.key === "ContextMenu" \|\| \(event\.shiftKey && event\.key === "F10"\)/);
  assert.match(html, /function closeSharedSkillsWizard\(\{ restoreFocus = true \} = \{\}\)[\s\S]*removeAttribute\("inert"\)[\s\S]*returnFocus\.focus\(\)/);
  assert.match(html, /sharedSkillsWizard"\)\?\.addEventListener\("keydown"[\s\S]*event\.key !== "Tab"[\s\S]*last\.focus\(\)/);
  assert.match(html, /role="tabpanel" aria-labelledby="settings-tab-/);
  assert.match(html, /metadata-tab-interpreted[\s\S]*role="tabpanel" aria-labelledby="metadata-tab-interpreted"/);
  assert.match(html, /class="review-all-clear" role="status"/);
  assert.match(html, /class="context-health-clear" role="status"/);
  assert.match(html, /\.tree button, \.global-project-row, \.global-project-tree-entry \{ min-height:\s*44px; \}/);
  assert.match(html, /prefers-reduced-motion:[\s\S]*\.boot-indicator, \.context-room-proposal-opening-indicator \{ animation:\s*none !important;/);
});

test("context health supports full refresh, acknowledged results, and simple filters", () => {
  const html = renderAppHtml();
  const script = extractInlineAppScript(html);
  const promptSource = script.slice(
    script.indexOf("function buildContextHealthCodexPrompt"),
    script.indexOf("async function sendContextHealthIssuesToCodex"),
  );
  const { buildContextHealthCodexPrompt } = Function(
    promptSource + "; return { buildContextHealthCodexPrompt };",
  )();
  const prompt = buildContextHealthCodexPrompt([
    { severity: "high", path: "docs/INDEX.md", message: "Broken canonical link." },
    { severity: "medium", message: "Missing metadata." },
  ], "/tmp/example-project");

  assert.match(html, /id="contextHealthPanel" class="docqa-panel">/);
  assert.match(html, /id="refreshContextHealth"[^>]*>Refresh all<\/button>/);
  assert.match(html, /id="sendContextHealthToCodex"[^>]*><span aria-hidden="true">@<\/span> Fix in Codex<\/button>/);
  assert.doesNotMatch(html, /shown only when checks need attention/);
  assert.match(html, /contextHealthStatusFilter: "open"/);
  assert.match(html, /contextHealthSeverityFilter: "triggered"/);
  assert.match(html, /contextHealthCategoryFilter: "all"/);
  assert.match(html, /data-health-filter=/);
  assert.match(html, /Open \+ OK/);
  assert.match(html, /All severities/);
  assert.match(html, /All areas/);
  assert.match(html, /function contextHealthIssueMatchesFilters\(issue\)/);
  assert.match(html, /function refreshContextHealthAnalysis\(\)/);
  assert.match(html, /api\("\/api\/reports\?fresh=1"\)/);
  assert.match(html, /state\.contextHealthStatusFilter = "all";/);
  assert.match(html, /state\.contextHealthSeverityFilter = "all";/);
  assert.match(html, /state\.contextHealthCategoryFilter = "all";/);
  assert.match(html, /panel\.hidden = false;/);
  assert.match(html, /issues\.map\(renderContextHealthIssue\)/);
  assert.doesNotMatch(html, /issues\.slice\(0, 5\)/);
  assert.match(html, /context-health-ok-badge/);
  assert.match(html, /data-health-ack/);
  assert.match(html, /api\("\/api\/doctor\/ack"/);
  assert.match(html, /function acknowledgeContextHealthIssueFromPanel\(key\)/);
  assert.match(html, /Fix " \+ issues\.length \+ " in Codex/);
  assert.match(html, /api\("\/api\/codex\/composer", \{/);
  assert.match(html, /function sendContextHealthIssuesToCodex\(\)/);
  assert.match(html, /fix prompt added to the active Codex composer · review it before sending/);
  assert.match(html, /el\("sendContextHealthToCodex"\)\?\.addEventListener/);
  assert.match(prompt, /Fix the valid Context Room health issues listed below\./);
  assert.match(prompt, /Project root: \/tmp\/example-project/);
  assert.match(prompt, /1\. \[high\] docs\/INDEX\.md: Broken canonical link\./);
  assert.match(prompt, /2\. \[medium\] Missing metadata\./);
  assert.match(prompt, /Do not mark issues OK merely to hide them\./);
  assert.doesNotMatch(promptSource, /turn\/start|submit/);
  assert.doesNotMatch(html, /<span>no metadata<\/span>/);
  assert.doesNotMatch(html, /Context health is clean\./);
});

test("review queue opens changed files with the inline segment review engine", () => {
  const html = renderAppHtml();

  assert.match(html, /\/api\/file\/review-base\?path=/);
  assert.match(html, /data-startup-review-order/);
  assert.match(html, /async function startChangedFileInlineReview\(path, diff, requestId = state\.selectionRequest\)/);
  assert.match(html, /if \(options\.reviewMode && diff\.changed && reviewBaseResult\?\.value\) \{\s*applyChangedFileInlineReview\(path, diff, reviewBaseResult\.value, requestId\);/);
  assert.match(html, /if \(options\.reviewMode\) await startChangedFileInlineReview\(finalPath, \{ changed: true \}, requestId\)/);
  assert.match(html, /source: "review"/);
  assert.match(html, /reviewSessions: \{\}/);
  assert.match(html, /const baseContent = typeof review\.baseContent === "string" \? review\.baseContent : "";/);
  assert.match(html, /const previousSession = state\.reviewSessions\?\.\[path\] \|\| null;/);
  assert.match(html, /previousSession\.baseContent === baseContent/);
  assert.match(html, /previousSession\.diskContent === diskContent/);
  assert.match(html, /reviewDecisions,\s*};/);
  assert.match(html, /changeKind: review\.changeKind \|\| "modified"/);
  assert.match(html, /function externalReviewBaseContent\(change = activeExternalChange\(\)\)/);
  assert.match(html, /function rememberActiveReviewSession\(\)/);
  assert.match(html, /state\.reviewSessions\[change\.path\] = \{/);
  assert.match(html, /function clearReviewSession\(path\)/);
  assert.match(html, /function resetExternalChangeState\(options = \{\}\)/);
  assert.match(html, /if \(options\.discardReview\) clearReviewSession\(path\);/);
  assert.match(html, /const pathLine = item\.oldPath/);
  assert.match(html, /escapeHtml\(item\.oldPath\) \+ " -> " \+ escapeHtml\(item\.path\)/);
  assert.match(html, /async function recordSelectedReviewBaseline\(path = state\.selected, note = ""\)/);
  assert.match(html, /function selectedStartupContextReviewPath\(path = state\.selected\)/);
  assert.match(html, /\/api\/docqa\/review-baseline/);
  assert.match(html, /const shouldRecordReviewBaseline = change\.source === "review" \|\| change\.source === "disk";/);
  assert.match(html, /if \(shouldRecordReviewBaseline\) await recordSelectedReviewBaseline\(change\.path, "inline review applied"\);/);
  assert.match(html, /const previousQueue = state\.docqa\?\.queue \|\| \[\];/);
  assert.match(html, /await applyReviewDecision\(change\.path, "verified", \{ previousQueue \}\);/);
  assert.match(html, /await advanceAfterInlineReviewRemoval\(change\.path, previousQueue, "new file rejected · no more docs to review"\);/);
  assert.match(html, /nextReviewAction: nextReviewActionForSelectedFile\(\)/);
  assert.match(html, /replaceExternalReviewActionsInPlace\(merged\);/);
  assert.match(html, /renderExternalReviewDocument\(externalReviewBaseContent\(externalChange\), externalChange\.diskContent \|\| ""\)/);
  assert.match(html, /buildExternalReviewBlocks\(externalReviewBaseContent\(change\), change\.diskContent \|\| "", change\.reviewDecisions/);
  assert.match(html, /computeExternalReviewContent\(blocks, externalReviewBaseContent\(change\), change\.diskContent \|\| ""\)/);
  assert.match(html, /const change = state\.externalChange;/);
  assert.match(html, /const ignoredMetadataOnly = onlyIgnoredReviewMetadataChanged\(baseContent, diskContent\);/);
  assert.match(html, /if \(baseContent === diskContent \|\| ignoredMetadataOnly\) \{/);
  assert.match(html, /last_verified synced · ready for verification/);
  assert.match(html, /no unresolved diff blocks · mark the file verified when ready/);
  assert.match(html, /review\.changeKind === "renamed" \? "renamed file waiting for review"/);
  assert.match(html, /if \(activeExternalChange\(\)\?\.source === "review"\) \{[\s\S]*state\.selectedDiff = await readSelectedDiff\(previousSelected\);[\s\S]*return;[\s\S]*\}/);
  assert.doesNotMatch(html, /function activeBlockingExternalChange\(\)/);
  assert.doesNotMatch(html, /function blockPendingExternalChange\(/);
  assert.doesNotMatch(html, /shouldAutoReloadCleanStartupDiskChange/);
  assert.doesNotMatch(html, /external startup file reloaded from disk/);
  assert.match(html, /state\.externalChange = \{\s*path: previousSelected,\s*source: "disk",/);
  assert.match(html, /setStatus\("file changed on disk · review before applying"\);/);
});

test("save preserves the editor scroll position after rerendering", () => {
  const html = renderAppHtml();

  assert.match(html, /const viewState = captureEditorViewState\(\);/);
  assert.match(html, /renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /function isScrollableY\(element\)/);
  assert.match(html, /function activeDocumentScrollTarget\(\)/);
  assert.match(html, /const documentSurface = document\.querySelector\("\.external-review-doc"\) \|\| el\("docEditor"\) \|\| el\("docHighlighter"\) \|\| el\("docReader"\);/);
  assert.match(html, /if \(isScrollableY\(documentSurface\)\) return documentSurface;/);
  assert.match(html, /if \(isScrollableY\(el\("viewer"\)\)\) return el\("viewer"\);/);
  assert.match(html, /function externalReviewBlockElement\(blockId\)/);
  assert.match(html, /function shiftScrollForElement\(element, delta\)/);
  assert.match(html, /userScrollIntentAt: 0/);
  assert.match(html, /function markUserScrollIntent\(\)/);
  assert.match(html, /function isScrollIntentKey\(event\)/);
  assert.match(html, /document\.addEventListener\("wheel", markUserScrollIntent/);
  assert.match(html, /document\.addEventListener\("touchmove", markUserScrollIntent/);
  assert.match(html, /function setDiffCollapsed\(collapsed\)/);
  assert.match(html, /function wireFileActionButtons\(root = document\)/);
  assert.match(html, /setDiffCollapsed\(true\)/);
  assert.match(html, /setDiffCollapsed\(false\)/);
  assert.match(html, /function updateExternalReviewBlockInPlace\(blocks, blockId, viewState\)/);
  assert.match(html, /function wireExternalReviewDecisionButtons\(root = document\)/);
  assert.match(html, /requestExternalReviewBlockDecision\(event\.currentTarget\.dataset\.externalBlockDecision, event\.currentTarget\.dataset\.externalBlockId\)/);
  assert.match(html, /captureEditorViewState\(\{ anchorBlockId: blockId \}\)/);
  assert.match(html, /viewState\.visualAnchor = captureMarkdownVisualAnchor\(\);/);
  assert.match(html, /event\.stopPropagation\(\)/);
  assert.match(html, /anchorTop/);
  assert.match(html, /document\.querySelector\("\.external-review-doc"\)/);
  assert.match(html, /\.external-review-doc\s*\{[^}]*overflow-anchor:\s*none/);
  assert.match(html, /snapshot\.documentScrollTarget === "docReader"/);
  assert.match(html, /documentScrollTop/);
  assert.match(html, /documentViewportTop/);
  assert.match(html, /editorScrollTop/);
  assert.match(html, /viewerScrollTop/);
  assert.match(html, /windowScrollY/);
  assert.match(html, /const editor = snapshot\.textAnchor \? \(el\("docEditor"\) \|\| activeEditor\(\)\) : \(snapshot\.editorId \? el\(snapshot\.editorId\) : activeEditor\(\)\);/);
  assert.doesNotMatch(html, /snapshot\.editorId === "docEditor" \? el\("docEditor"\) : activeEditor\(\)/);
  assert.match(html, /function scrollEditorToTextAnchor\(editor, snapshot\)/);
  assert.match(html, /const restoredTextAnchor = scrollEditorToTextAnchor\(editor, snapshot\);/);
  assert.match(html, /window\.requestAnimationFrame\(apply\)/);
  assert.match(html, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*window\.requestAnimationFrame\(apply\)/);
  assert.match(html, /window\.setTimeout\(apply, 0\)/);
});

test("inline review distinguishes layout scroll from user scroll", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const source = script.slice(
    script.indexOf("function captureInlineReviewScrollSnapshot"),
    script.indexOf("function captureMarkdownVisualAnchor"),
  );
  const state = { userScrollIntentAt: 10 };
  const currentScroll = {
    path: "docs/guide.md",
    documentScrollTop: 420,
    documentScrollLeft: 0,
    editorScrollTop: 420,
    editorScrollLeft: 0,
    viewerScrollTop: 420,
    viewerScrollLeft: 0,
    windowScrollX: 0,
    windowScrollY: 0,
  };
  const helpers = Function(
    "state",
    "captureEditorViewState",
    source + "; return { rememberInlineReviewLiveScrollIfChanged };",
  )(state, () => ({ ...currentScroll }));
  const transitionStart = { ...currentScroll, documentScrollTop: 240, editorScrollTop: 240, viewerScrollTop: 240, userScrollIntentAt: 10 };
  const viewState = { path: "docs/guide.md", anchorBlockId: "change-1" };

  assert.equal(helpers.rememberInlineReviewLiveScrollIfChanged(viewState, transitionStart), false);
  assert.equal(viewState.userScrolledDuringInlineReview, undefined);

  state.userScrollIntentAt = 11;
  assert.equal(helpers.rememberInlineReviewLiveScrollIfChanged(viewState, transitionStart), true);
  assert.equal(viewState.userScrolledDuringInlineReview, true);
  assert.equal(viewState.liveScrollState.documentScrollTop, 420);
});

test("Ctrl or Cmd S saves the selected dirty file", () => {
  const html = renderAppHtml();

  assert.match(html, /function isSaveShortcut\(event\)/);
  assert.match(html, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(html, /String\(event\.key \|\| ""\)\.toLowerCase\(\) === "s"/);
  assert.match(html, /function handleSaveShortcut\(event\)/);
  assert.match(html, /event\.preventDefault\(\);/);
  assert.match(html, /if \(!state\.dirty\) \{/);
  assert.match(html, /setStatus\("no changes to save"\)/);
  assert.match(html, /saveCurrent\(\)\.catch\(\(error\) => setStatus\(error\.message\)\)/);
  assert.match(html, /if \(handleSaveShortcut\(event\)\) return;/);
});

test("rendered app exposes agent collaboration hooks without human review bypass", () => {
  const html = renderAppHtml();

  assert.match(html, /id="agentToast"/);
  assert.match(html, /function buildSessionStatePayload\(\)/);
  assert.match(html, /function activeEditorCaretLineIndex\(editor\)/);
  assert.match(html, /api\("\/api\/workspaces\/register"/);
  assert.match(html, /AGENT_COMMAND_ACK_STORAGE_PREFIX = "context-room:last-agent-command-id:"/);
  assert.match(html, /function agentCommandAckStorageKey\(\)[\s\S]*AGENT_COMMAND_ACK_STORAGE_PREFIX \+ state\.workspaceId/);
  assert.match(html, /AGENT_COMMAND_MAX_AGE_MS = 60_000/);
  assert.match(html, /function startAgentCommandPolling\(\)/);
  assert.match(html, /api\("\/api\/workspaces\/" \+ encodeURIComponent\(state\.workspaceId\) \+ "\/command"\)/);
  assert.match(html, /state\.lastAgentCommandId = readLastAgentCommandId\(\);/);
  assert.match(html, /if \(isStaleAgentCommand\(command\)\) \{[\s\S]*rememberAgentCommandId\(command\.id\);[\s\S]*return;[\s\S]*\}/);
  assert.match(html, /function rememberAgentCommandId\(id\)/);
  assert.match(html, /function isStaleAgentCommand\(command\)/);
  assert.match(html, /function executeAgentCommand\(command\)/);
  assert.match(html, /const navigated = await applyWorkspaceUrlState[\s\S]*if \(!navigated\)[\s\S]*throw new Error\(state\.workspaceLastNavigationError \|\| "Agent navigation failed"\)[\s\S]*if \(command\?\.id\) rememberAgentCommandId\(command\.id\);/);
  assert.match(html, /openSharedProposal\(proposal\.branch, proposal\.repositoryId \|\| proposal\.repository \|\| "", \{ file: target\.file \|\| "" \}\)/);
  assert.match(html, /function applyAgentScrollTarget\(command\)/);
  assert.match(html, /function renderAgentAnnotations\(path\)/);
  assert.match(html, /api\("\/api\/agent\/annotations\?path="/);
  assert.match(html, /api\("\/api\/agent\/annotations\/resolve"/);
  assert.match(html, /\.agent-annotation/);
  assert.match(html, /\.agent-toast/);
  assert.doesNotMatch(html, /agent\/verify/);
  assert.doesNotMatch(html, /agent[\s\S]{0,120}\/api\/docqa\/review/);
});

test("disk changes stay pending for review instead of silently reloading the open file", () => {
  const html = renderAppHtml();

  assert.match(html, /externalChange: null/);
  assert.match(html, /openingFilePath: null/);
  assert.match(html, /function activeExternalChange\(\)/);
  assert.match(html, /external-review-doc/);
  assert.match(html, /external-review-block change/);
  assert.match(html, /external-review-line/);
  assert.match(html, /Document with file changes highlighted/);
  assert.match(html, /data-external-block-decision="accept"/);
  assert.match(html, /data-external-block-decision="reject"/);
  assert.match(html, /data-external-block-id/);
  assert.match(html, /data-external-review-all="accept"/);
  assert.match(html, /data-external-review-all="reject"/);
  assert.match(html, /data-external-review-jump="first"/);
  assert.match(html, />OK<\/button>/);
  assert.match(html, />x<\/button>/);
  assert.match(html, />First change<\/button>/);
  assert.match(html, />Accept all<\/button>/);
  assert.match(html, />Reject all<\/button>/);
  assert.match(html, /const bulkActions = summary\.pending\s*\?/);
  assert.doesNotMatch(html, /const bulkActions = summary\.pending &&/);
  assert.match(html, /buildExternalReviewBlocks/);
  assert.match(html, /chooseExternalReviewBlock/);
  assert.match(html, /function chooseAllExternalReviewBlocks\(decision\)/);
  assert.match(html, /function wireExternalReviewAllButtons\(root = document\)/);
  assert.match(html, /requestAllExternalReviewBlocksDecision\(event\.currentTarget\.dataset\.externalReviewAll\)/);
  assert.match(html, /function wireExternalReviewJumpButtons\(root = document\)/);
  assert.match(html, /if \(focusFirstExternalReviewChange\(\)\) setStatus\("showing first change"\);/);
  assert.match(html, /updateExternalReviewBlockInPlace\(blocks, blockId, viewState\)/);
  assert.match(html, /renderExternalReviewBlock\(block, \{ finalLineStart: externalReviewFinalLineStart\(blocks, blockId\) \}\)/);
  assert.match(html, /function updateExternalReviewDocumentInPlace\(blocks\)/);
  assert.match(html, /doc\.innerHTML = renderExternalReviewBlocks\(blocks\);/);
  assert.match(html, /function refreshExternalReviewFinalLineIndexes\(blocks\)/);
  assert.match(html, /refreshExternalReviewFinalLineIndexes\(blocks\);/);
  assert.match(html, /const settlePromise = updatedInPlace[\s\S]*settleExternalReviewBlocks\(\[blockId\], viewState, \{ restoreScroll: false \}\)/);
  assert.match(html, /if \(pending\.length\)[\s\S]*await finalizeExternalReview\(settlePromise, blocks, viewState\);/);
  assert.match(html, /const previousDecisions = \{ \.\.\.\(change\.reviewDecisions \|\| \{\}\) \};/);
  assert.match(html, /function restoreExternalReviewAfterSaveFailure\(change, previousDecisions, error\)/);
  assert.match(html, /change\.reviewDecisions = \{ \.\.\.\(previousDecisions \|\| \{\}\) \};/);
  assert.match(html, /review not saved · /);
  assert.match(html, /const updatedInPlace = updateExternalReviewBlockInPlace\(blocks, blockId, viewState\);[\s\S]*if \(!updatedInPlace\) renderViewer\(\);\s*else updateExternalReviewActionsInPlace\(change\);\s*updateHeader\(\);/);
  assert.match(html, /actions\.outerHTML = renderExternalReviewActions\(change, \{ fileActionOptions: externalReviewFileActionOptions\(\) \}\);/);
  assert.match(html, /wireExternalReviewJumpButtons\(document\.querySelector\("\.file-panel > header"\) \|\| document\);/);
  assert.match(html, /externalReviewRowsForDecision/);
  assert.match(html, /function renderExternalReviewFinalLines\(rows, options = \{\}\)/);
  assert.match(html, /function renderExternalReviewBlocks\(blocks\)/);
  assert.match(html, /function externalReviewFinalLineStart\(blocks, blockId\)/);
  assert.match(html, /function finalLineDecorations\(rows, finalLineStart = null\)/);
  assert.match(html, /external-review-block context markdown-view[\s\S]*renderMarkdownLines\(block\.rows\.map\(\(row\) => row\.line\)\.join\("\\n"\), \{ lineDecorations: finalLineDecorations\(block\.rows, options\.finalLineStart\), interactiveLinks: true \}\)/);
  assert.match(html, /external-review-final-lines markdown-view/);
  assert.match(html, /external-review-block context resolved/);
  assert.match(html, /external-review-block context resolved [^"]*empty/);
  assert.match(html, /external-review-lines markdown-view/);
  assert.doesNotMatch(html, /external-review-line-content markdown-view/);
  assert.match(html, /renderMarkdownLines\(text, \{ lineDecorations, interactiveLinks: true \}\)/);
  assert.match(html, /function externalReviewIntralineRows\(rows\)/);
  assert.match(html, /function buildIntralineTokenDiff\(beforeText, afterText\)/);
  assert.match(html, /function renderIntralineSegments\(segments, changeType\)/);
  assert.match(html, /intralineHtml:\s*intraline\?\.html \|\| ""/);
  assert.match(html, /intraline-superseded/);
  assert.match(html, /intraline-merged/);
  assert.match(html, /if \(!decoration\.intralineHtml\) return decorated;/);
  assert.doesNotMatch(html, /external-review-resolved-label/);
  assert.doesNotMatch(html, /external-review-placeholder/);
  assert.doesNotMatch(html, /Change rejected/);
  assert.doesNotMatch(html, /Change accepted/);
  assert.match(html, /computeExternalReviewContent/);
  assert.match(html, /renderExternalReviewDocument/);
  assert.match(html, /const metricClass = " editor-metrics";/);
  assert.match(html, /doc-editor external-review-doc' \+ metricClass/);
  assert.match(html, /renderExternalReviewActions/);
  assert.match(html, /const pendingLabel = summary\.pending \? summary\.pending \+ " left" : "saving\.\.\.";/);
  assert.doesNotMatch(html, /const pendingLabel = summary\.pending \? summary\.pending \+ " left" : "reviewed";/);
  assert.match(html, /const bulkActions = summary\.pending\s*\?/);
  assert.match(html, /function updateExternalReviewActionsInPlace\(change = activeExternalChange\(\)\)/);
  assert.match(html, /function renderFileActionItems\(/);
  assert.match(html, /function externalReviewFileActionOptions\(\)/);
  assert.match(html, /renderExternalReviewActions\(externalChange, \{ fileActionOptions: externalReviewFileActionOptions\(\) \}\)/);
  assert.match(html, /blockedByConflict:\s*true/);
  assert.doesNotMatch(html, /summary\.pending && \(visualHtmlReview \|\| summary\.pending > 1 \|\| summary\.pendingLines > 1\)/);
  assert.match(html, /pendingBlock && \(row\.type === "add" \|\| row\.type === "del"\)/);
  assert.match(html, /state\.externalChange = \{[\s\S]*reviewDecisions: \{\},[\s\S]*\};\s*state\.selectedDiff = diff;\s*state\.diffCollapsed = true;/);
  assert.match(html, /state\.openingFilePath = path;[\s\S]*state\.savedHash = data\.contentHash;[\s\S]*state\.openingFilePath = null;/);
  assert.match(html, /if \(state\.openingFilePath === state\.selected \|\| state\.savedHash == null\) return;/);
  assert.match(html, /function editorBufferHasUnsavedChanges\(\) \{[\s\S]*editor\.value !== state\.saved/);
  assert.match(html, /function syncEditorDirtyState\(\) \{[\s\S]*state\.dirty = editorBufferHasUnsavedChanges\(\);/);
  assert.match(html, /if \(!state\.selected \|\| state\.selectedReadOnly \|\| !syncEditorDirtyState\(\) \|\| state\.openingFilePath === state\.selected \|\| state\.savedHash == null\) return false;/);
  assert.match(html, /state\.saved = content;\s*state\.savedHash = result\.contentHash;[\s\S]*syncEditorDirtyState\(\);/);
  assert.match(html, /const viewState = captureEditorViewState\(\);[\s\S]*state\.externalChange = \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /const previousHeight = current\.getBoundingClientRect\(\)\.height;/);
  assert.match(html, /next\.style\.minHeight = Math\.ceil\(previousHeight\) \+ "px"/);
  assert.match(html, /function waitForInlineReviewTransition\(settlePromise = null\)/);
  assert.match(html, /await waitForInlineReviewTransition\(settlePromise\)/);
  assert.match(html, /reviewFinalizationPromise: null/);
  assert.match(html, /async function finalizeExternalReview\(settlePromise, blocks, viewState\)/);
  assert.match(html, /state\.reviewFinalizationPromise = finalization;/);
  assert.match(html, /await saveExternalReviewDecision\(blocks, viewState\);/);
  assert.match(html, /if \(state\.reviewFinalizationPromise === finalization\) \{\s*state\.reviewFinalizationPromise = null;/);
  assert.match(html, /function externalReviewTextAnchor\(blocks, blockId, mergedText\)/);
  assert.match(html, /viewState\.textAnchor = externalReviewTextAnchor\(blocks, viewState\.anchorBlockId, merged\);/);
  assert.match(html, /function textOffsetForLineIndex\(lines, lineIndex\)/);
  assert.match(html, /function finishExternalReviewPanelInPlace\(viewState\)/);
  assert.match(html, /if \(!finishExternalReviewPanelInPlace\(viewState\)\) \{[\s\S]*renderViewer\(\);\s*restoreEditorViewState\(viewState\);/);
  assert.match(html, /function finalizeExternalReviewPanelInPlace\(viewState\)/);
  assert.match(html, /const visualAnchor = captureMarkdownVisualAnchor\(doc\);/);
  assert.match(html, /const restoreState = inlineReviewRestoreViewState\(viewState\);/);
  assert.match(html, /doc\.outerHTML = state\.mode === "edit" \? renderMarkdownEditor\(text\) : renderMarkdownLineView\(text\);/);
  assert.match(html, /restoreFinalReviewViewport\(visualAnchor, restoreState\);/);
  assert.match(html, /function restoreFinalReviewViewport\(visualAnchor, restoreState\)/);
  assert.match(html, /window\.requestAnimationFrame\(\(\) => \{[\s\S]*window\.requestAnimationFrame\(apply\)/);
  assert.match(html, /function replaceExternalReviewActionsInPlace\(text = ""\)/);
  assert.match(html, /replaceExternalReviewActionsInPlace\(text\);/);
  assert.match(html, /function wireRenderedMarkdownEditor\(\)/);
  assert.match(html, /function settleFinishedExternalReview\(viewState\)/);
  assert.doesNotMatch(html, /doc\.classList\.add\("settled"\)/);
  assert.match(html, /function settleExternalReviewBlocks\(blocksOrIds, viewState, options = \{\}\)/);
  assert.match(html, /const restoreScroll = options\.restoreScroll !== false/);
  assert.match(html, /!block\.classList\.contains\("settling"\) && !block\.classList\.contains\("settled"\)/);
  assert.match(html, /block\.classList\.add\("settled"\)/);
  assert.match(html, /settleFinishedExternalReview\(viewState\)\.then/);
  assert.match(html, /if \(!activeExternalChange\(\) && document\.querySelector\("\.external-review-doc"\)\) \{[\s\S]*finalizeExternalReviewPanelInPlace\(viewState\);/);
  assert.match(html, /\.external-review-block\.resolved\.settling\s*\{[^}]*height 180ms ease[^}]*min-height 180ms ease/);
  assert.match(html, /block\.classList\.add\("settling"\)/);
  assert.match(html, /const targetHeight = naturalExternalReviewBlockHeight\(block\);/);
  assert.match(html, /function naturalExternalReviewBlockHeight\(block\)/);
  assert.match(html, /const parent = block\.parentElement \|\| document\.body;/);
  assert.match(html, /parent\.appendChild\(clone\);/);
  assert.doesNotMatch(html, /document\.body\.appendChild\(clone\);/);
  assert.match(html, /const anchorTop = typeof viewState\?\.anchorTop === "number" \? viewState\.anchorTop : anchor \? anchor\.getBoundingClientRect\(\)\.top : null;/);
  assert.match(html, /shiftScrollForElement\(anchor, anchor\.getBoundingClientRect\(\)\.top - anchorTop\);/);
  assert.match(html, /const transitionScrollStart = captureInlineReviewScrollSnapshot\(viewState\);/);
  assert.match(html, /const scrolledDuringTransition = rememberInlineReviewLiveScrollIfChanged\(viewState, transitionScrollStart\);/);
  assert.match(html, /if \(!scrolledDuringTransition\) \{[\s\S]*restoreEditorViewState\(viewState\);[\s\S]*\}/);
  assert.match(html, /function captureInlineReviewScrollSnapshot\(viewState = null\)/);
  assert.match(html, /function inlineReviewScrollChangedSince\(snapshot\)/);
  assert.match(html, /function rememberInlineReviewLiveScrollIfChanged\(viewState, snapshot\)/);
  assert.match(html, /const userRequestedScroll = \(state\.userScrollIntentAt \|\| 0\) > \(snapshot\?\.userScrollIntentAt \|\| 0\);/);
  assert.match(html, /!viewState \|\| !userRequestedScroll \|\| !inlineReviewScrollChangedSince\(snapshot\)/);
  assert.match(html, /viewState\.userScrolledDuringInlineReview = true;/);
  assert.match(html, /viewState\.liveScrollState = captureEditorViewState/);
  assert.match(html, /function inlineReviewRestoreViewState\(viewState\)/);
  assert.match(html, /viewState\.liveScrollState \|\| captureEditorViewState/);
  assert.match(html, /function captureMarkdownVisualAnchor\(root = null\)/);
  assert.match(html, /visibleLines\.find\(\(line\) => line\.textContent\.trim\(\) && !line\.closest\("\.external-review-block\.change"\)\)/);
  assert.match(html, /lineText: visibleLine\.textContent \|\| ""/);
  assert.match(html, /function restoreExternalReviewVisualAnchor\(anchor\)/);
  assert.match(html, /function restoreInlineReviewViewport\(viewState\)/);
  assert.match(html, /scroller\.scrollTop = Math\.max\(0, \(viewState\.documentScrollTop \|\| 0\) \+ topDelta\)/);
  assert.match(html, /data-final-line-index/);
  assert.match(html, /visibleLine\.dataset\.finalLineIndex \|\| visibleLine\.dataset\.lineIndex/);
  assert.match(html, /function restoreMarkdownVisualAnchor\(anchor\)/);
  assert.match(html, /root\.querySelector\('\.markdown-line\[data-line-index="/);
  assert.match(html, /clone\.classList\.remove\("settling"\);[\s\S]*clone\.classList\.add\("settled"\);/);
  assert.match(html, /function waitForExternalReviewBlockSettle\(block\)/);
  assert.match(html, /event\.target === block && event\.propertyName === "height"/);
  assert.match(html, /window\.setTimeout\(finish, 350\)/);
  assert.doesNotMatch(html, /height 2s ease|window\.setTimeout\(finish, 2400\)/);
  assert.match(html, /function restoreEditorViewState\(snapshot, options = \{\}\)/);
  assert.match(html, /const deferred = options\.deferred !== false;/);
  assert.match(html, /if \(!deferred\) return;[\s\S]*window\.requestAnimationFrame/);
  assert.doesNotMatch(html, /\.external-review-doc\.settled \.external-review-block\.resolved/);
  assert.match(html, /\.external-review-block\.resolved\.settled\.empty\s*\{[^}]*min-height:\s*0/);
  assert.match(html, /resetExternalChangeState\(change\.source === "review" \? \{ discardReview: true \} : \{\}\);\s*\/\/ Returning from inline review should keep[\s\S]*state\.diffCollapsed = true;/);
  assert.match(html, /const diskContentAlreadyCurrent = merged === \(change\.diskContent \|\| ""\);/);
  assert.match(html, /!diskContentAlreadyCurrent && \(state\.selectedReadOnly \|\| state\.selectedStartupContext\?\.readOnly\)/);
  assert.match(html, /read-only file · rejecting reviewed changes requires write access/);
  assert.match(html, /diskContentAlreadyCurrent\s*\? \{ contentHash: change\.diskHash \|\| state\.savedHash, backupPath: "" \}\s*:\s*await writeSelectedDiskFile\(merged, change\.path\)/);
  assert.match(html, /applyReviewDecision\(change\.path, "verified", \{ previousQueue, viewState \}\)/);
  assert.match(html, /const finalizedInPlace = options\.viewState \? finalizeExternalReviewPanelInPlace\(options\.viewState\) : false;/);
  assert.match(html, /if \(!restoreInlineReviewViewport\(viewState\) && anchor && typeof anchorTop === "number"\)/);
  assert.match(html, /block\.decision === "accept"[\s\S]*row\.type !== "del"/);
  assert.match(html, /block\.decision === "reject"[\s\S]*row\.type !== "add"/);
  assert.doesNotMatch(html, /external-review-block\.accept \.external-review-line\.del/);
  assert.match(html, /external-review-final-lines markdown-view/);
  assert.match(html, /external-review-lines markdown-view/);
  assert.doesNotMatch(html, /external-review-line-content markdown-view/);
  assert.doesNotMatch(html, /external-change-panel/);
  assert.match(html, /file changed on disk · review before applying/);
  assert.doesNotMatch(html, /blockPendingExternalChange/);
  assert.match(html, /async function goHistory\(delta\) \{[\s\S]*await waitForReviewFinalizationBeforeNavigation\(\);[\s\S]*await selectFile/);
  assert.match(html, /const hasHomeHistory = state\.page === "hub" && state\.historyIndex >= 0;/);
  assert.match(html, /const nextIndex = state\.page === "hub" && delta < 0 \? state\.historyIndex : state\.historyIndex \+ delta;/);
  assert.match(html, /el\("back"\)\.disabled = onHome \? state\.historyIndex < 0 : state\.historyIndex <= 0;/);
  assert.match(html, /function goHub\(\) \{[\s\S]*resetExternalChangeState\(\);[\s\S]*showHome\(\);/);
  assert.match(html, /function firstExternalReviewChangeBlockId\(\)/);
  assert.match(html, /return externalReviewChangeElements\(\)\[0\]\?\.dataset\.externalReviewBlock \|\| "";/);
  assert.match(html, /function focusFirstExternalReviewChange\(\)/);
  assert.match(html, /function focusExternalReviewChange\(blockId\)/);
  assert.match(html, /function closestExternalReviewChangeElement\(\)/);
  assert.match(html, /target\.scrollIntoView\(\{ behavior: "smooth", block: "center", inline: "nearest" \}\)/);
  assert.match(html, /\.external-review-block\.attention/);
  assert.match(html, /@keyframes externalReviewAttention/);
  assert.match(html, /if \(syncEditorDirtyState\(\)\) \{\s*const conflictDetected = await checkSelectedFileConflict\(\);\s*if \(conflictDetected \|\| syncEditorDirtyState\(\)\) return;\s*\}/);
  assert.match(html, /if \(onlyIgnoredReviewMetadataChanged\(state\.saved \|\| "", data\.content\)\) \{/);
  assert.match(html, /setStatus\("last_verified synced"\);/);
  assert.doesNotMatch(html, /activeBlockingExternalChange/);
  assert.match(html, /apply or reject before saving/);
  assert.doesNotMatch(html, /setStatus\("reloaded from disk"\);\n  \} catch \(error\) \{\n    setStatus\(error\.message\);\n  \}\n\}/);
});

test("saved startup skill with stale dirty state treats a later disk edit as external review, not a conflict", async () => {
  const script = extractInlineAppScript(renderAppHtml());
  const selectionSource = script.slice(
    script.indexOf("function activeFileConflict"),
    script.indexOf("async function readSelectedDiff"),
  );
  const conflictSource = script.slice(
    script.indexOf("function scheduleConflictCheck"),
    script.indexOf("async function applyExternalChange"),
  );
  const refreshSource = script.slice(
    script.indexOf("async function refreshFromDisk"),
    script.indexOf("function scheduleBackgroundRefresh"),
  );
  const editor = { value: "Saved by the user.\n" };
  const state = {
    selected: "~/.codex/skills/documentation-excellence/SKILL.md",
    selectedReadOnly: false,
    selectedStartupContext: {
      kind: "startup-skill",
      order: "0:documentation-excellence",
      skillName: "documentation-excellence",
    },
    openingFilePath: null,
    saved: editor.value,
    savedHash: "saved-hash",
    dirty: true,
    refreshInFlight: false,
    externalChange: null,
    fileConflict: null,
    conflictCompare: false,
    conflictMergeText: null,
    conflictMergeKey: "",
    conflictMergeMode: "auto",
    selectedDiff: null,
    diffCollapsed: false,
    lastDiffRefreshAt: 0,
  };
  const requests = [];
  const statuses = [];
  const harness = Function(
    "state",
    "document",
    "window",
    "IS_HOSTED_REVIEW",
    "api",
    "activeEditor",
    "el",
    "selectedFileExists",
    "readSelectedDiff",
    "canReviewMissingFile",
    "clearMissingSelectedFile",
    "renderFiles",
    "showHome",
    "scheduleSessionStatePush",
    "onlyIgnoredReviewMetadataChanged",
    "captureEditorViewState",
    "resetConflictState",
    "resetExternalChangeState",
    "renderViewer",
    "restoreEditorViewState",
    "updateHeader",
    "updatePreview",
    "playContextRoomSound",
    "setStatus",
    selectionSource + conflictSource + refreshSource + "; return { refreshFromDisk };",
  )(
    state,
    { hidden: false },
    { clearTimeout() {}, setTimeout() {} },
    false,
    async (requestPath) => {
      requests.push(requestPath);
      if (state.selectedStartupContext) {
        assert.match(requestPath, /^\/api\/startup-skills\/file\?folder=0&skill=documentation-excellence$/);
        return { exists: true, content: "Changed by an agent.\n", contentHash: "disk-hash", updatedAt: "now" };
      }
      assert.equal(requestPath, "/api/file?path=docs%2Fguide.md");
      return { exists: true, content: "Changed on disk.\n", contentHash: "regular-disk-hash", updatedAt: "later" };
    },
    () => editor,
    () => editor,
    () => true,
    async () => ({ available: false, changed: false }),
    () => false,
    () => {},
    () => {},
    () => {},
    () => {},
    () => false,
    () => ({ scrollTop: 0 }),
    () => { state.fileConflict = null; },
    () => { state.externalChange = null; },
    () => {},
    () => {},
    () => {},
    () => {},
    () => false,
    (status) => statuses.push(status),
  );

  await harness.refreshFromDisk();

  assert.ok(requests.length >= 1);
  assert.equal(state.dirty, false);
  assert.equal(state.fileConflict, null);
  assert.equal(state.externalChange?.source, "disk");
  assert.equal(state.externalChange?.baseContent, "Saved by the user.\n");
  assert.equal(state.externalChange?.diskContent, "Changed by an agent.\n");
  assert.equal(statuses.at(-1), "file changed on disk · review before applying");

  requests.length = 0;
  statuses.length = 0;
  editor.value = "Unsaved user edit.\n";
  Object.assign(state, {
    selected: "docs/guide.md",
    selectedStartupContext: null,
    saved: "Saved regular file.\n",
    savedHash: "regular-saved-hash",
    dirty: false,
    externalChange: null,
    fileConflict: null,
    selectedDiff: null,
  });

  await harness.refreshFromDisk();

  assert.ok(requests.length >= 1);
  assert.equal(state.dirty, true);
  assert.equal(state.externalChange, null);
  assert.equal(state.fileConflict?.path, "docs/guide.md");
  assert.equal(state.fileConflict?.diskContent, "Changed on disk.\n");
  assert.equal(statuses.at(-1), "file changed on disk · resolve conflict before saving");
});

test("inline review highlights only changed paragraph fragments", () => {
  const script = extractInlineAppScript(renderAppHtml());
  const source = script.slice(
    script.indexOf("function renderExternalReviewRows"),
    script.indexOf("function renderExternalReviewFinalLines"),
  );
  const renderMarkdownInline = (text) => text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  const renderMarkdownLines = (text, { lineDecorations }) => text.split("\n").map((line, index) => {
    const decoration = lineDecorations[index];
    return '<div class="' + decoration.className + '">' + (decoration.intralineHtml || line) + "</div>";
  }).join("");
  const helpers = Function(
    "renderMarkdownInline",
    "renderMarkdownLines",
    "finalLineIndexForRow",
    source + "; return { renderExternalReviewRows, externalReviewIntralineRows, buildIntralineTokenDiff, renderIntralineSegments, renderMergedIntralineSegments, shouldMergeIntralineDiff };",
  )(renderMarkdownInline, renderMarkdownLines, () => null);

  const insertion = helpers.buildIntralineTokenDiff(
    "The shared key is canonical.",
    "The shared key is canonical. A date-only edit is omitted.",
  );
  assert.ok(insertion.similarity >= 0.34);
  assert.equal(insertion.deletedWords, 0);
  assert.ok(insertion.changeRatio > 0.25);
  assert.equal(helpers.shouldMergeIntralineDiff(insertion), true);
  assert.equal(helpers.renderIntralineSegments(insertion.before, "del"), "The shared key is canonical.");
  assert.match(
    helpers.renderIntralineSegments(insertion.after, "add"),
    /The shared key is canonical\.<span class="external-review-token add"> A date-only edit is omitted\.<\/span>/,
  );
  const insertionRows = helpers.externalReviewIntralineRows([
    { type: "del", line: "The shared key is canonical." },
    { type: "add", line: "The shared key is canonical. A date-only edit is omitted." },
  ]);
  assert.equal(insertionRows.get(0).hidden, true);
  assert.equal(insertionRows.get(1).merged, true);
  assert.equal(insertionRows.get(1).kind, "addition");
  const insertionHtml = helpers.renderExternalReviewRows([
    { type: "del", line: "The shared key is canonical." },
    { type: "add", line: "The shared key is canonical. A date-only edit is omitted." },
  ]);
  assert.match(insertionHtml, /external-review-line del intraline-superseded/);
  assert.match(insertionHtml, /external-review-line add intraline-merged/);
  assert.match(insertionHtml, /<span class="external-review-token add"> A date-only edit is omitted\.<\/span>/);

  const replacement = helpers.buildIntralineTokenDiff(
    "Keep the **clear rule** here.",
    "Keep the **short rule** here.",
  );
  assert.match(
    helpers.renderIntralineSegments(replacement.before, "del"),
    /<span class="external-review-token del"><strong>clear rule<\/strong><\/span>/,
  );
  assert.match(
    helpers.renderIntralineSegments(replacement.after, "add"),
    /<span class="external-review-token add"><strong>short rule<\/strong><\/span>/,
  );
  const replacementRows = helpers.externalReviewIntralineRows([
    { type: "del", line: "Keep the **clear rule** here." },
    { type: "add", line: "Keep the **short rule** here." },
  ]);
  assert.equal(replacementRows.get(0).hidden, true);
  assert.equal(replacementRows.get(1).merged, true);
  assert.equal(replacementRows.get(1).kind, "mixed");
  const replacementHtml = helpers.renderExternalReviewRows([
    { type: "del", line: "Keep the **clear rule** here." },
    { type: "add", line: "Keep the **short rule** here." },
  ]);
  assert.match(replacementHtml, /external-review-line add intraline-merged intraline-mixed/);
  assert.match(replacementHtml, /external-review-token del"><strong>clear rule<\/strong>/);
  assert.match(replacementHtml, /external-review-token add"><strong>short rule<\/strong>/);

  const deletionRows = helpers.externalReviewIntralineRows([
    { type: "del", line: "Keep this obsolete detail here." },
    { type: "add", line: "Keep this detail here." },
  ]);
  assert.equal(deletionRows.get(0).hidden, true);
  assert.equal(deletionRows.get(1).merged, true);
  assert.equal(deletionRows.get(1).kind, "removal");
  const deletionHtml = helpers.renderExternalReviewRows([
    { type: "del", line: "Keep this obsolete detail here." },
    { type: "add", line: "Keep this detail here." },
  ]);
  assert.match(deletionHtml, /external-review-line add intraline-merged intraline-removal/);
  assert.match(deletionHtml, /Keep this <span class="external-review-token del">obsolete <\/span>detail here\./);

  const shared = "Clear reviews keep the reader oriented while preserving enough surrounding context to understand every proposed documentation change";
  const largeBefore = shared + " with many old words that make the previous paragraph needlessly long and difficult to scan for a reviewer.";
  const largeAfter = shared + " with several new terms that make the revised paragraph direct and much easier to verify during review.";
  const largeDiff = helpers.buildIntralineTokenDiff(largeBefore, largeAfter);
  assert.ok(largeDiff.similarity >= 0.34);
  assert.ok(largeDiff.changeRatio > 0.25);
  assert.ok(largeDiff.deletedWords > 0);
  assert.ok(largeDiff.addedWords > 0);
  assert.equal(helpers.shouldMergeIntralineDiff(largeDiff), false);
  const largeRows = helpers.externalReviewIntralineRows([
    { type: "del", line: largeBefore },
    { type: "add", line: largeAfter },
  ]);
  assert.equal(largeRows.get(0).hidden, undefined);
  assert.equal(largeRows.get(0).split, true);
  assert.equal(largeRows.get(1).split, true);
  const largeHtml = helpers.renderExternalReviewRows([
    { type: "del", line: largeBefore },
    { type: "add", line: largeAfter },
  ]);
  assert.equal((largeHtml.match(/intraline-split/g) || []).length, 2);
  assert.match(largeHtml, /external-review-token del/);
  assert.match(largeHtml, /external-review-token add/);

  const longShared = Array.from({ length: 75 }, (_item, index) => "stable" + index).join(" ");
  const longBefore = longShared + " " + Array.from({ length: 12 }, (_item, index) => "old" + index).join(" ");
  const longAfter = longShared + " " + Array.from({ length: 12 }, (_item, index) => "new" + index).join(" ");
  const longDiff = helpers.buildIntralineTokenDiff(longBefore, longAfter);
  assert.ok(longDiff.deletedWords + longDiff.addedWords > 20);
  assert.ok(longDiff.changeRatio < 0.25);
  assert.equal(helpers.shouldMergeIntralineDiff(longDiff), true);
  const longRows = helpers.externalReviewIntralineRows([
    { type: "del", line: longBefore },
    { type: "add", line: longAfter },
  ]);
  assert.equal(longRows.get(0).hidden, true);
  assert.equal(longRows.get(1).merged, true);
});

test("hub child cards expand inline without replacing root sections", () => {
  const html = renderAppHtml();

  assert.match(html, /\.hub-folder-card\.expanded\s*\{[^}]*grid-column:\s*1 \/ -1/);
  assert.match(html, /function renderHubFolderChildren\(folder, activeIds\)/);
  assert.match(html, /const sections = Array\.isArray\(state\.rootHubSections\) \? state\.rootHubSections/);
  assert.doesNotMatch(html, /holder\.innerHTML = renderHubBreadcrumb\(\) \+ sections/);
  assert.doesNotMatch(html, /const nextSections = hubSectionViewForCard/);
});

test("hub folder cards can infer child cards from allowed folders", () => {
  const root = makeRoot();
  fs.mkdirSync(path.join(root, "docs", "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "a.md"), "# A\n");
  fs.writeFileSync(path.join(root, "docs", "b.md"), "# B\n");
  fs.writeFileSync(path.join(root, "docs", "nested", "c.md"), "# C\n");
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const configPath = path.join(root, CONFIG_FILE);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.hubSections = [{
    id: "docs",
    title: "Docs",
    cards: [{
      id: "docs-card",
      title: "Docs",
      description: "Project docs.",
      path: "docs/",
      autoChildren: true,
      enabled: true,
    }],
  }];
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");

  const sections = hubSectionsForRoot(root, readMemoryWebappSettings(root));
  const card = sections[0].cards[0];

  assert.deepEqual(card.cards.map((child) => child.title), ["nested", "a.md", "b.md"]);
  assert.equal(card.cards[0].autoChildren, true);
  assert.deepEqual(card.cards[0].cards.map((child) => child.title), ["c.md"]);
  assert.equal(card.cards[1].path, "docs/a.md");
});

test("hub cards open direct file paths without filtering folders", () => {
  const html = renderAppHtml();

  assert.match(html, /\[data-hub-file\]/);
  assert.match(html, /selectFile\(button\.dataset\.hubFile\)/);
  assert.match(html, /data-hub-file="[^"]*directFilePath/);
  assert.match(html, /data-hub-folders="[^"]*paths\.join/);
  assert.match(html, /async function activateContextHubCard/);
  assert.match(html, /if \(directFilePath\) \{[\s\S]*await selectFile\(directFilePath\)/);
  assert.match(html, /if \(children\.length\) \{[\s\S]*openHubPath\(card\.id\)/);
  assert.match(html, /if \(paths\.length\) \{[\s\S]*filterFolders\(paths\)/);
});

test("stale project identities cannot write session state after a port is reused", async (t) => {
  const firstRoot = makeRoot();
  const secondRoot = makeRoot();
  for (const root of [firstRoot, secondRoot]) {
    fs.mkdirSync(path.join(root, "docs"));
    fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n");
    initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  }

  let activeServer = null;
  const closeActiveServer = async () => {
    const server = activeServer;
    activeServer = null;
    if (!server?.listening) return;
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  t.after(closeActiveServer);

  const firstRoom = createMemoryServer({ root: firstRoot });
  activeServer = firstRoom.server;
  await new Promise((resolve) => activeServer.listen(0, "127.0.0.1", resolve));
  const port = activeServer.address().port;
  const firstHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
  const firstProjectId = firstHealth.headers.get("x-context-room-project");
  assert.equal(firstHealth.status, 200);
  assert.equal(firstProjectId, firstRoom.projectId);
  await closeActiveServer();

  const secondRoom = createMemoryServer({ root: secondRoot });
  activeServer = secondRoom.server;
  await new Promise((resolve) => activeServer.listen(port, "127.0.0.1", resolve));
  const secondHealth = await fetch(`http://127.0.0.1:${port}/api/health`);
  const secondProjectId = secondHealth.headers.get("x-context-room-project");
  assert.equal(secondHealth.status, 200);
  assert.equal(secondProjectId, secondRoom.projectId);
  assert.notEqual(secondProjectId, firstProjectId);

  const secondSessionPath = path.join(secondRoot, CONFIG_DIR, "session-state.json");
  const legacyBrowserResponse = await fetch(`http://127.0.0.1:${port}/api/session-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify({ page: "hub", pathFilters: ["old-browser/docs/"] }),
  });
  const legacyBrowserPayload = await legacyBrowserResponse.json();
  assert.equal(legacyBrowserResponse.status, 409);
  assert.equal(legacyBrowserPayload.code, "context_room_project_identity_required");
  assert.equal(fs.existsSync(secondSessionPath), false);

  const staleResponse = await fetch(`http://127.0.0.1:${port}/api/session-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": firstProjectId,
    },
    body: JSON.stringify({ page: "hub", pathFilters: ["other-project/docs/"] }),
  });
  const stalePayload = await staleResponse.json();
  assert.equal(staleResponse.status, 409);
  assert.equal(stalePayload.code, "context_room_project_changed");
  assert.equal(stalePayload.projectId, secondProjectId);
  assert.equal(fs.existsSync(secondSessionPath), false);
  assert.deepEqual(readCollaborationSessionState(secondRoot).pathFilters, []);

  const acceptedResponse = await fetch(`http://127.0.0.1:${port}/api/session-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": secondProjectId,
    },
    body: JSON.stringify({ page: "hub", pathFilters: ["docs/"] }),
  });
  assert.equal(acceptedResponse.status, 200);
  assert.deepEqual(readCollaborationSessionState(secondRoot).pathFilters, ["docs/"]);
  await closeActiveServer();

  const restartedRoom = createMemoryServer({ root: secondRoot });
  assert.equal(restartedRoom.projectId, secondProjectId);
  activeServer = restartedRoom.server;
  await new Promise((resolve) => activeServer.listen(port, "127.0.0.1", resolve));
  let restartedResponse;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      restartedResponse = await fetch(`http://127.0.0.1:${port}/api/session-state`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-context-room-project": secondProjectId,
        },
        body: JSON.stringify({ page: "file", selectedPath: "docs/guide.md", pathFilters: ["docs/"] }),
      });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
    }
  }
  assert.equal(restartedResponse.status, 200);
  assert.equal(readCollaborationSessionState(secondRoot).selectedPath, "docs/guide.md");
});
