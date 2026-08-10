#!/usr/bin/env node
import assert from "node:assert/strict";
import test from "node:test";

import { renderAppHtml } from "../src/context_room.mjs";

function inlineAppScript(html) {
  const match = String(html).match(/<script>([\s\S]*)<\/script>/);
  assert.ok(match, "expected Context Room HTML to contain an inline app script");
  return match[1];
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker: ${end}`);
  return source.slice(startIndex, endIndex);
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

test("browser markup keeps Markdown structure, line identity, and document links accessible", async () => {
  const html = renderAppHtml();
  const script = inlineAppScript(html);
  const rendererSource = sourceBetween(script, "function renderMarkdownBlocks", "function decorateMarkdownLine")
    + sourceBetween(script, "function renderMarkdownLine", "function wireMarkdownDocLinks");
  const state = {
    selected: "docs/readme.md",
    files: [{ path: "docs/readme.md" }, { path: "docs/guide.md" }],
  };
  const { renderMarkdownBlocks, renderMarkdownLine } = Function(
    "state",
    "escapeHtml",
    rendererSource + "; return { renderMarkdownBlocks, renderMarkdownLine };",
  )(state, escapeHtml);
  const markdown = [
    "# Heading",
    "",
    "- First",
    "- Second",
    "> Quoted",
    "---",
    "[Guide](guide.md)",
    "`guide.md`",
    "guide.md",
  ].join("\n");
  const rendered = renderMarkdownBlocks(markdown, { semantic: true, interactiveLinks: true });

  assert.match(rendered, /<h1 class="markdown-line h1" data-line-index="0"[^>]*><span class="markdown-marker" aria-hidden="true"># <\/span>Heading<\/h1>/);
  assert.match(rendered, /<ul class="markdown-list-group" role="list"><li class="markdown-line list" data-line-index="2"[^>]*>[\s\S]*<li class="markdown-line list" data-line-index="3"/);
  assert.match(rendered, /<blockquote class="markdown-line quote" data-line-index="4"/);
  assert.match(rendered, /class="markdown-line hr" data-line-index="5"[^>]*role="separator" aria-label="Thematic break"/);
  assert.equal((rendered.match(/data-line-index=/g) || []).length, markdown.split("\n").length);
  assert.equal((rendered.match(/<a href="#"[^>]+data-doc-link-path=/g) || []).length, 3);
  assert.match(renderMarkdownLine("# Editor heading", 0), /^<div class="markdown-line h1"/);

  const fenced = renderMarkdownBlocks(["```", "# Code heading", "- Code list", "```"].join("\n"), { semantic: true, interactiveLinks: true });
  assert.doesNotMatch(fenced, /<h1|<li/);
  assert.equal((fenced.match(/data-line-index=/g) || []).length, 4);

  const wireSource = sourceBetween(script, "function wireMarkdownDocLinks", "function wireMarkdownEditorDocLinks");
  const opened = [];
  const wireMarkdownDocLinks = Function(
    "openMarkdownDocLink",
    "isDocLinkModifierEventActive",
    "setStatus",
    wireSource + "; return wireMarkdownDocLinks;",
  )(async (target) => opened.push(target), (event) => Boolean(event.metaKey || event.ctrlKey), () => {});
  const controls = [
    { tagName: "A", dataset: { docLinkResolved: "docs/guide.md", docLinkPath: "guide.md" } },
    { tagName: "SPAN", dataset: { docLinkResolved: "docs/guide.md", docLinkPath: "guide.md" } },
  ].map((control) => ({
    ...control,
    addEventListener(type, handler) {
      assert.equal(type, "click");
      this.click = handler;
    },
  }));
  wireMarkdownDocLinks({ querySelectorAll: () => controls });
  const event = (modifier = false) => ({
    metaKey: modifier,
    ctrlKey: false,
    preventDefault() {},
    stopPropagation() {},
  });
  controls[0].click(event());
  await Promise.resolve();
  assert.deepEqual(opened, ["docs/guide.md"]);
  controls[1].click(event());
  await Promise.resolve();
  assert.deepEqual(opened, ["docs/guide.md"]);
  controls[1].click(event(true));
  await Promise.resolve();
  assert.deepEqual(opened, ["docs/guide.md", "docs/guide.md"]);
});

test("browser markup exposes live feedback and explicit control state", () => {
  const html = renderAppHtml();
  const script = inlineAppScript(html);
  const mermaidSource = sourceBetween(script, "function mermaidViewModeButtons", "function renderStandaloneMermaidDocument");
  const mermaidViewModeButtons = Function(mermaidSource + "; return mermaidViewModeButtons;")();
  const buttons = mermaidViewModeButtons("source");

  assert.equal((buttons.match(/aria-pressed="true"/g) || []).length, 1);
  assert.equal((buttons.match(/aria-pressed="false"/g) || []).length, 2);
  assert.match(buttons, /data-mermaid-view="source" class="active" aria-pressed="true"/);
  assert.match(script, /item\.setAttribute\("aria-pressed", String\(active\)\)/);
  assert.match(html, /id="agentToast" class="agent-toast" role="status" aria-live="polite" aria-atomic="true" hidden/);
  assert.match(script, /<textarea data-conflict-merge-editor aria-label="Edit merged document result" spellcheck="false">/);
});

test("Context Hub keyboard navigation focuses the rerendered current card", () => {
  const script = inlineAppScript(renderAppHtml());
  assert.match(script, /data-codex-prompt-target=.*?aria-current="true"/);
  assert.match(script, /data-context-hub-item=.*?aria-current="true"/);

  const selectionSource = sourceBetween(script, "function focusContextHubListItem", "function contextRoomHubReturnUrl");
  const keyboardSource = sourceBetween(
    script,
    'document.addEventListener("keydown", (event) => {\n  if (!state.sharedProposalWorkspaceOpen)',
    'document.querySelectorAll("[data-home-action]").forEach',
  );
  const state = {
    sharedProposalWorkspaceOpen: true,
    contextHubView: "project-manager",
    contextHubSelection: "first",
    sharedContextBusy: false,
  };
  const itemIds = ["first", "second"];
  const makeButtons = (generation) => itemIds.map((id) => ({
    dataset: { contextHubItem: id },
    generation,
    focusCount: 0,
    focus() { this.focusCount += 1; },
  }));
  let buttons = makeButtons("stale");
  const staleSecond = buttons[1];
  let keydown;
  let renderCount = 0;
  const document = {
    activeElement: { tagName: "BODY" },
    addEventListener(type, handler) {
      if (type === "keydown") keydown = handler;
    },
    querySelectorAll(selector) {
      assert.equal(selector, "[data-context-hub-item]");
      return buttons;
    },
    querySelector(selector) {
      const id = selector.match(/data-context-hub-item="([^"]+)"/)?.[1];
      return buttons.find((button) => button.dataset.contextHubItem === id) || null;
    },
  };
  Function(
    "state",
    "contextHubVisibleItems",
    "renderSharedProposalWorkspace",
    "document",
    "CSS",
    "selectCodexPromptTarget",
    "setStatus",
    selectionSource + keyboardSource,
  )(
    state,
    () => itemIds.map((id) => ({ id })),
    () => {
      renderCount += 1;
      buttons = makeButtons("fresh");
    },
    document,
    { escape: (value) => value },
    async () => {},
    () => {},
  );

  let prevented = false;
  keydown({ key: "j", preventDefault() { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(renderCount, 1);
  assert.equal(state.contextHubSelection, "second");
  assert.equal(staleSecond.focusCount, 0);
  assert.equal(buttons[1].generation, "fresh");
  assert.equal(buttons[1].focusCount, 1);
});

test("local Shared recovery is explicit, accessible, and honest about abandonment effects", () => {
  const html = renderAppHtml();
  const script = inlineAppScript(html);
  const recoverySource = sourceBetween(
    script,
    "function contextHubProjectSharedRecovery",
    "function contextHubProjectSourceBadges",
  );
  const state = { sharedRecoveryBusy: "" };
  const { contextHubCatalogWithoutSharedRecovery, renderContextHubSharedRecoveryNotice, renderContextHubGlobalSharedRecoveryNotice } = Function(
    "state",
    "IS_HOSTED_CONTEXT_ROOM",
    "escapeHtml",
    recoverySource + "; return { contextHubCatalogWithoutSharedRecovery, renderContextHubSharedRecoveryNotice, renderContextHubGlobalSharedRecoveryNotice };",
  )(state, false, escapeHtml);
  const project = {
    id: "project-location",
    projectKey: "local:project-logical",
    title: "Atlas <unsafe>",
    sharedRecovery: {
      status: "recovery-required",
      transactionId: "transaction-exact-123456789",
      operation: "connect",
      projectId: "project-location",
      logicalProjectId: "project-logical",
      createdAt: "2026-08-09T08:00:00.000Z",
      message: "Conflict <script>alert(1)</script>",
    },
  };
  const markup = renderContextHubSharedRecoveryNotice(project);

  assert.match(html, /id="contextHubSharedRecovery" hidden/);
  assert.match(html, /id="contextHubGlobalSharedRecovery" class="context-hub-global-recovery" hidden/);
  assert.match(script, /workspace\.dataset\.globalRecovery = String\(Boolean\(globalRecoveryMarkup\)\)/);
  assert.match(script, /"sharedRecovery", "sharedRecoveries", "sharedRecoveryIssues"/);
  assert.match(markup, /role="status" aria-label="Recovery required"/);
  assert.match(markup, />Recovery required</);
  assert.match(markup, />Abandon recovery</);
  assert.match(markup, /data-transaction-id="transaction-exact-123456789"/);
  assert.match(markup, /data-expected-project-id="project-location"/);
  assert.match(markup, /data-expected-logical-project-id="project-logical"/);
  assert.match(markup, /Context Hub normally leaves its canonical project state and Shared binding unchanged\./);
  assert.match(markup, /If every recorded project root is gone, it removes only the exact orphaned Shared binding and clears the matching Hub Shared field\./);
  assert.match(markup, /Git files and history remain unchanged; reconnect explicitly afterward\./);
  assert.match(markup, /aria-label="Abandon recovery for Atlas &lt;unsafe&gt;"/);
  assert.doesNotMatch(markup, /<script>/);

  state.sharedRecoveryBusy = project.sharedRecovery.transactionId;
  const busyMarkup = renderContextHubSharedRecoveryNotice(project);
  assert.match(busyMarkup, /disabled aria-busy="true"/);
  assert.match(busyMarkup, />Archiving…</);

  const invalidRecovery = {
    status: "recovery-required",
    scope: "global",
    kind: "invalid-journal",
    quarantineId: "quarantine-exact-123",
    revision: "revision-exact-456",
    quarantinedAt: "2026-08-09T09:00:00.000Z",
    message: "Unreadable journal <unsafe>",
  };
  state.sharedRecoveryBusy = "";
  const globalMarkup = renderContextHubGlobalSharedRecoveryNotice(invalidRecovery);
  assert.match(globalMarkup, /role="status" aria-label="Global recovery required"/);
  assert.match(globalMarkup, /data-recovery-kind="invalid-journal"/);
  assert.match(globalMarkup, /data-quarantine-id="quarantine-exact-123"/);
  assert.match(globalMarkup, /data-expected-revision="revision-exact-456"/);
  assert.match(globalMarkup, /Context Hub keeps its canonical registry, Shared remains unchanged, and blocked local project and Shared mutations can resume afterward\./);
  assert.doesNotMatch(globalMarkup, /<unsafe>/);

  state.contextHub = {
    sharedRecoveryIssues: [invalidRecovery, {
      ...invalidRecovery,
      quarantineId: "quarantine-exact-789",
      revision: "revision-exact-999",
    }],
    projects: [],
  };
  const multiGlobalMarkup = renderContextHubGlobalSharedRecoveryNotice();
  assert.match(multiGlobalMarkup, /1 other unreadable record will still block local project and Shared mutations until it is reviewed\./);
  assert.doesNotMatch(multiGlobalMarkup, /mutations can resume afterward/);

  const catalog = {
    sharedRecoveryIssues: [invalidRecovery],
    projects: [{
      ...project,
      shared: { repository: "shared.git", projectId: "demo" },
      sharedRecoveries: [project.sharedRecovery],
      worktrees: [{ id: "worktree", shared: { repository: "shared.git", projectId: "demo" }, sharedRecovery: project.sharedRecovery }],
    }, {
      id: "global-project",
      sharedRecovery: invalidRecovery,
      worktrees: [{ id: "global-worktree", sharedRecovery: invalidRecovery }],
    }],
  };
  const withoutTransaction = contextHubCatalogWithoutSharedRecovery(catalog, project.sharedRecovery);
  assert.equal(withoutTransaction.projects[0].sharedRecovery, null);
  assert.deepEqual(withoutTransaction.projects[0].sharedRecoveries, []);
  assert.equal(withoutTransaction.projects[0].worktrees[0].sharedRecovery, null);
  assert.equal(withoutTransaction.projects[0].shared.projectId, "demo");
  assert.equal(withoutTransaction.sharedRecoveryIssues.length, 1);
  const withoutOrphan = contextHubCatalogWithoutSharedRecovery(catalog, {
    ...project.sharedRecovery,
    canonicalSharedCleared: true,
  });
  assert.equal(withoutOrphan.projects[0].shared, null);
  assert.equal(withoutOrphan.projects[0].worktrees[0].shared, null);
  const withoutInvalid = contextHubCatalogWithoutSharedRecovery(catalog, invalidRecovery);
  assert.deepEqual(withoutInvalid.sharedRecoveryIssues, []);
  assert.equal(withoutInvalid.projects[1].sharedRecovery, null);
  assert.equal(withoutInvalid.projects[1].worktrees[0].sharedRecovery, null);
  assert.equal(catalog.projects[0].sharedRecovery, project.sharedRecovery, "optimistic cleanup must not mutate the cached catalogue in place");
  assert.match(script, /applyContextHubMutationCatalog\(contextHubCatalogWithoutSharedRecovery\(nextCatalog, result\.recovery \|\| recovery\)\)/);
  assert.match(script, /workspaceUpdate\("shared-recovery-archived"\)/);
  assert.match(script, /archive durability confirmation pending/);
  assert.match(script, /refreshContextHubUi\(\)\.catch\(\(\) => setStatus\(pendingStatus \+ " · retry refresh when ready"\)\)/);

  const hostedRenderer = Function(
    "state",
    "IS_HOSTED_CONTEXT_ROOM",
    "escapeHtml",
    recoverySource + "; return renderContextHubSharedRecoveryNotice;",
  )(state, true, escapeHtml);
  assert.equal(hostedRenderer(project), "");
  assert.match(script, /Context Hub keeps the current canonical state unless every recorded project root is gone/);
  assert.match(script, /in that orphan-only case it removes the exact Shared binding and clears the matching Hub Shared field/);
  assert.match(script, /Git files and repository history remain unchanged\. Automatic recovery stops, and you must reconnect this project explicitly afterward\./);
  assert.match(script, /Context Hub keeps its current canonical registry\. Shared files and Git state remain unchanged\. Project and Shared mutations can resume afterward\./);
  assert.match(script, /other unreadable recovery record/);
  assert.match(script, /project and Shared mutations stay blocked until/);
});

test("Context Hub ignores stale snapshots after a newer request or mutation", () => {
  const script = inlineAppScript(renderAppHtml());
  const helperSource = sourceBetween(
    script,
    "function beginContextHubSnapshotRequest",
    "function enforceHostedHubSourceFilters",
  );
  const state = {
    contextHub: null,
    contextHubSnapshotRequestGeneration: 0,
    contextHubMutationGeneration: 0,
    contextHubReviewQueueReady: false,
  };
  const {
    beginContextHubSnapshotRequest,
    applyContextHubSnapshot,
    applyContextHubMutationCatalog,
  } = Function(
    "state",
    "sanitizeHostedHubCatalog",
    helperSource + "; return { beginContextHubSnapshotRequest, applyContextHubSnapshot, applyContextHubMutationCatalog };",
  )(state, (catalog) => ({ ...catalog }));

  const first = beginContextHubSnapshotRequest();
  const second = beginContextHubSnapshotRequest();
  assert.equal(applyContextHubSnapshot({ revision: "old-request" }, first), false);
  assert.equal(applyContextHubSnapshot({ revision: "latest-request" }, second), true);
  assert.equal(state.contextHub.revision, "latest-request");

  const pendingBeforeMutation = beginContextHubSnapshotRequest();
  applyContextHubMutationCatalog({ revision: "archived-recovery" });
  assert.equal(state.contextHubReviewQueueReady, true);
  assert.equal(applyContextHubSnapshot({ revision: "stale-before-archive" }, pendingBeforeMutation), false);
  assert.equal(state.contextHub.revision, "archived-recovery");

  const afterMutation = beginContextHubSnapshotRequest();
  assert.equal(applyContextHubSnapshot({ revision: "fresh-after-archive" }, afterMutation), true);
  assert.equal(state.contextHub.revision, "fresh-after-archive");
});

test("Settings drafts and modal boundaries survive asynchronous UI work", () => {
  const script = inlineAppScript(renderAppHtml());
  const backgroundRenderSource = sourceBetween(
    script,
    "function renderAfterBackgroundReportPayload",
    "function applyInitialReportsWhenReady",
  );
  const initialHubSource = sourceBetween(
    script,
    "function applyInitialContextHubWhenReady",
    "async function loadInitialContextHubData",
  );
  assert.match(backgroundRenderSource, /state\.page === "settings"[\s\S]*!state\.settingsDirtyGroups\.size[\s\S]*renderSettingsPanel\(\)/);
  assert.match(initialHubSource, /state\.page === "settings" && !state\.settingsDirtyGroups\.size/);

  const isolationSource = sourceBetween(
    script,
    "function isolateContextRoomModalBackground",
    "function openContextHubProjectPicker",
  );
  const makeNode = (attributes = {}) => {
    const values = new Map(Object.entries(attributes));
    return {
      hasAttribute: (name) => values.has(name),
      getAttribute: (name) => values.get(name) ?? null,
      setAttribute: (name, value) => values.set(name, String(value)),
      removeAttribute: (name) => values.delete(name),
    };
  };
  const app = makeNode({ "aria-hidden": "false" });
  const workspace = makeNode({ inert: "" });
  const picker = makeNode();
  const wizard = makeNode();
  const nodes = { sharedProposalWorkspace: workspace, contextHubProjectPicker: picker, sharedSkillsWizard: wizard };
  const isolateContextRoomModalBackground = Function(
    "document",
    "el",
    isolationSource + "; return isolateContextRoomModalBackground;",
  )({ querySelector: (selector) => selector === ".app" ? app : null }, (id) => nodes[id] || null);
  const release = isolateContextRoomModalBackground(picker);
  assert.equal(app.hasAttribute("inert"), true);
  assert.equal(app.getAttribute("aria-hidden"), "true");
  assert.equal(workspace.hasAttribute("inert"), true);
  assert.equal(workspace.getAttribute("aria-hidden"), "true");
  assert.equal(picker.hasAttribute("inert"), false);
  release();
  release();
  assert.equal(app.hasAttribute("inert"), false);
  assert.equal(app.getAttribute("aria-hidden"), "false");
  assert.equal(workspace.hasAttribute("inert"), true);
  assert.equal(workspace.getAttribute("aria-hidden"), null);

  const confirmSource = sourceBetween(script, "function showConfirmDialog", "function showContextHubCreationDialog");
  const creationSource = sourceBetween(script, "function showContextHubCreationDialog", "function applyContextHubCreationCatalog");
  const creationHandlersSource = sourceBetween(script, "function showContextHubCreateProjectDialog", "function showHumanReviewDecisionDialog");
  assert.match(confirmSource, /state\.activeModalClose\?\.\(\{ restoreFocus: false \}\)/);
  assert.match(confirmSource, /releaseBackgroundIsolation = isolateContextRoomModalBackground\(backdrop\)/);
  assert.doesNotMatch(confirmSource, /querySelector\("\.confirm-backdrop"\)\?\.remove/);
  assert.match(creationSource, /requestController = new AbortController\(\)/);
  assert.match(creationSource, /onSubmit\(values, \{ signal: requestController\.signal, isCurrent \}\)/);
  assert.match(creationSource, /requestController\?\.abort\(\)/);
  assert.match(creationSource, /if \(error\?\.name === "AbortError" \|\| !isCurrent\(\)\) return/);
  assert.equal((creationHandlersSource.match(/if \(!isCurrent\(\)\) return;/g) || []).length, 3);
  assert.equal((creationHandlersSource.match(/\bsignal,/g) || []).length, 6);
});
