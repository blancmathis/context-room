import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";

import {
  acceptSharedReview,
  abandonInvalidSharedDisconnectTransaction,
  acceptedProposalCommitMessage,
  checkSharedGitHubSecurity,
  connectSharedContext,
  createSharedProposal,
  detectSharedProject,
  disconnectSharedContext,
  ensureSharedProposal,
  initializeSharedRepository,
  importSharedInstructions,
  importSharedSkills,
  linkSharedSkillLocation,
  listRegisteredSharedProjectLocations,
  listRegisteredSharedRepositories,
  listSharedProposalWorkspaces,
  listSharedDisconnectRecoveryIssues,
  listRegisteredSharedBindings,
  listSharedRepositoryProposals,
  listSharedProposals,
  materializeSharedRepositoryReview,
  materializeSharedReview,
  previewSharedSkillAssignment,
  previewSharedInstructionAssignment,
  proposeSharedDocumentationFile,
  proposeSharedInstructionAssignment,
  proposeSharedInstructionUnassignment,
  proposeSharedSkillAssignment,
  proposeSharedSkillUnassignment,
  publishSharedProposal,
  publishSharedRepositoryProposal,
  openSharedProposalWorkspace,
  openSharedRepositoryProposalWorkspace,
  readSharedMainRevision,
  readSharedProjectConnection,
  readSharedSkillLocalState,
  recoverSharedContextTransactions,
  reconcileSharedSkillLocations,
  reconcileSharedInstructionLocations,
  rejectSharedRepositoryProposal,
  resolveSharedDocumentationTarget,
  resolveSharedSessionProposals,
  secureSharedGitHubRepository,
  sharedContextStatus,
  sharedSkillProviderPreferences,
  sharedSkillLocationsStatus,
  sharedInstructionLocationsStatus,
  setSharedSkillLocationOverride,
  setSharedSkillProviderOverride,
  setSharedSkillProviderPreferences,
  setSharedSkillProviderSettings,
  sharedSkillEffectiveProjection,
  syncSharedContext,
  diffSharedMainRevisions,
  diffSharedProposalRevisions,
  diffSharedSkillLocationsRevisions,
  listSharedMainAcceptances,
  unlinkSharedSkillLocation,
} from "../src/shared_context.mjs";
import {
  buildDocumentationCorpus,
  readDocumentation,
  runDocumentationAgent,
  searchDocumentation,
} from "../src/doc_agent.mjs";
import {
  buildDocQaReport,
  initializeContextRoomProject,
  contextHubUiState,
  createMemoryServer,
  deleteMemoryPaths,
  listExplorerFiles,
  readFileDiff,
  readMemoryFile,
  readMemoryWebappSettings,
  renderAppHtml,
  revertMemoryFile,
  writeDocReviewDecision,
  writeMemoryFile,
} from "../src/context_room.mjs";
import {
  contextRoomEventJournalPath,
  readContextRoomEvents,
} from "../src/event_journal.mjs";
import { contextHubRepositoryIdentity, registerContextHubSharedRepository } from "../src/context_hub.mjs";
import {
  authorizeOwnerTrustedState,
  inspectOwnerProposalDecisions,
  inspectOwnerTrustedState,
} from "../src/review_authority.mjs";
import { filesystemProcessIdentity } from "../src/filesystem_lock.mjs";

const cli = fileURLToPath(new URL("../bin/context-room.mjs", import.meta.url));

test("shared proposal review keeps navigation and explicit completion in the proposal workspace", () => {
  const html = renderAppHtml();
  assert.match(html, /class="workspace-chrome"/);
  assert.match(html, /class="shared-context-heading"/);
  assert.match(html, />Choose proposal</);
  assert.match(html, /id="sharedProposalSelect"/);
  assert.doesNotMatch(html, /id="sharedProposalBrowser"/);
  assert.match(html, /id="sharedProposalWorkspace"/);
  assert.doesNotMatch(html, /id="contextHubOpen"/);
  assert.doesNotMatch(html, /id="contextHubHome"/);
  assert.match(html, /id="sharedProposalWorkspaceHeading">Context Room</);
  assert.match(html, /class="context-room-brand"/);
  assert.doesNotMatch(html, /data-context-room-view=/);
  assert.doesNotMatch(html, /contextRoomReviewHistory|Review history|contextHubHistoryItems|localReviewHistory/);
  assert.match(html, /id="contextHubManageProjects"/);
  assert.match(html, /id="sharedProposalWorkspaceClose"/);
  assert.ok(html.indexOf("Review queue") < html.indexOf("<h2>Context health</h2>"));
  assert.match(html, /data-context-hub-project-picker-trigger="room-home"/);
  assert.match(html, /contextHubProjectPickerLabel/);
  assert.match(html, /id="contextHubProjectPickerSearch"/);
  assert.match(html, /id="sharedSkillsWizard"/);
  assert.match(html, /Shared skills setup/);
  assert.match(html, /Link this skill location to shared/);
  assert.match(html, /Use these skills in/);
  assert.match(html, /Every registered project in this shared/);
  assert.match(html, /data-shared-provider-global/);
  assert.match(html, /data-shared-provider-project/);
  assert.match(html, /Control both Shared Skills and Shared Instructions/);
  assert.match(html, /Select a project in the Explorer/);
  assert.match(html, /How shared skills work/);
  assert.match(html, /Collections and assignments/);
  assert.match(html, /Local destinations and conflicts/);
  assert.match(html, /Shared resources/);
  assert.match(html, /Projects and shared contexts/);
  assert.match(html, /What is a Shared Context\?/);
  assert.match(html, /data-settings-help-trigger/);
  assert.match(html, /aria-haspopup="dialog"/);
  assert.match(html, /role="dialog" aria-modal="true"/);
  assert.match(html, /One canonical source/);
  assert.match(html, /Shared Skills/);
  assert.match(html, /Shared Instructions/);
  assert.match(html, /Hooks stay local/);
  assert.match(html, /human accepts or rejects its files/);
  assert.match(html, /\.context-room\/shared-repository\.json/);
  assert.match(html, /skill-locations\.json/);
  assert.match(html, /instruction-locations\.json/);
  assert.match(html, /never replaces unmanaged files or links/);
  assert.match(html, /showSharedContextHelpDialog/);
  assert.match(html, /data-shared-context-help-close/);
  assert.doesNotMatch(html, /data-settings-disclosure="project-shared-explainer"/);
  assert.match(html, /Shared repositories/);
  assert.match(html, /Selected project connection/);
  assert.match(html, /data-add-shared-repository/);
  assert.match(html, /state\.sharedContextManagerRepositoryDraft = event\.currentTarget\.value/);
  assert.match(html, /escapeHtml\(state\.sharedContextManagerRepositoryDraft \|\| ''\)/);
  assert.match(html, /state\.sharedContextManagerRepositoryDraft = "";\s+applySharedContextManagerCatalog/);
  assert.match(html, /data-connect-shared-context/);
  assert.match(html, /\/api\/context-hub\/shared-repositories/);
  assert.match(html, /\/api\/context-hub\/project-shared-context/);
  assert.match(html, /How shared instructions work/);
  assert.match(html, /Import or update instruction files/);
  assert.match(html, /Use these instructions in/);
  assert.match(html, /AGENTS\.md, AGENTS\.override\.md, CLAUDE\.md/);
  assert.match(html, /Active in provider/);
  assert.match(html, /Installed but not discovered/);
  assert.match(html, /Requires provider configuration/);
  assert.match(html, /Unmanaged conflict/);
  assert.match(html, /\/api\/shared-instructions\/locations/);
  assert.match(html, /\/api\/shared-instructions\/import\/preview/);
  assert.match(html, /data-shared-instructions-reconcile/);
  assert.match(html, /Context Room exposes them to Codex, Claude Code, OpenCode, or a custom folder through managed links instead of copies/);
  assert.match(html, /shared-skills-provider-columns/);
  assert.match(html, /Device default/);
  assert.match(html, /Project override/);
  assert.match(html, /Enabled here/);
  assert.match(html, /\/api\/shared-skills\/assignments\/preview/);
  assert.match(html, /provider-disabled/);
  assert.match(html, /\/api\/shared-skills\/locations/);
  assert.match(html, /function contextHubProjectPickerChoices/);
  assert.match(html, /id="contextRoomReviewSourceFilter"/);
  assert.match(html, /id="contextRoomReviewSearch"/);
  assert.match(html, /data-context-room-review/);
  assert.match(html, /visibleReviews = renderedReviews\.slice\(0, CONTEXT_HUB_HOME_REVIEW_LIMIT\)/);
  assert.match(html, /const visibleEntries = entries\.slice\(0, Math\.max\(40, Number\(state\.proposalReviewVisibleCount \|\| 40\)\)\)/);
  assert.match(html, /data-proposal-review-more/);
  assert.match(html, /const overviewFiles = files\.slice\(0, 12\)/);
  assert.match(html, /workspaceHead\.dataset\.view = state\.contextHubView/);
  assert.match(html, /x-context-room-target-project/);
  assert.match(html, /target\.searchParams\.set\("hub", "1"\)/);
  assert.match(html, /assignWorkspaceLocation\(target\.toString\(\)\)/);
  assert.match(html, /hubCard/);
  assert.match(html, />All sources</);
  assert.doesNotMatch(html, />Local \+ shared</);
  assert.match(html, /function contextHubReviewItems/);
  assert.doesNotMatch(html, /contextHubHomeProjectFrame/);
  assert.doesNotMatch(html, /context-room-project-home-height/);
  assert.match(html, /reviewTarget: item\.localReview/);
  assert.match(html, /startupKind/);
  assert.match(html, /Local files use the project review queue directly/);
  assert.match(html, /\/api\/context-hub\/review/);
  assert.match(html, /id="sharedProposalSearch"/);
  assert.match(html, /id="sharedProposalOverviewDescription"/);
  assert.match(html, /id="sharedProposalOverviewRecapLabel"/);
  assert.match(html, /Agent recap · updated with the latest publish/);
  assert.match(html, /id="sharedProposalFiles"/);
  assert.match(html, /id="sharedProposalOpenReview"/);
  assert.match(html, /id="proposalReviewPage"/);
  assert.match(html, /id="proposalReviewPage" class="proposal-review-page workspace-page"/);
  assert.match(html, /id="proposalReviewFiles"/);
  assert.match(html, /function showProposalReview\(\{ preparingItem = null \} = \{\}\)/);
  assert.match(html, /function renderProposalReviewPage\(\)/);
  assert.match(html, /function contextRoomHubReturnUrl\(url\)/);
  assert.match(html, /function contextRoomProposalReviewUrl\(url\)/);
  assert.match(html, /target\.searchParams\.set\("returnTo", contextRoomHubReturnUrl\(window\.location\.href\)\)/);
  assert.match(html, /function contextRoomProposalReviewUrl\(url\) \{[\s\S]*?target\.searchParams\.set\("view", "proposal"\);[\s\S]*?target\.searchParams\.delete\("file"\);[\s\S]*?target\.searchParams\.delete\("select"\);/);
  assert.match(html, /target\.origin === window\.location\.origin/);
  assert.match(html, /searchParams\.set\("view", "hub"\)/);
  assert.match(html, /searchParams\.delete\("proposal"\)/);
  assert.match(html, /searchParams\.delete\("returnTo"\)/);
  assert.doesNotMatch(html, /target\.searchParams\.set\("file", firstReviewFile\)/);
  assert.match(html, /function contextRoomProposalFileUrl\(url, filePath\)/);
  assert.match(html, /state\.contextRoomPreparedReview = result/);
  assert.match(html, /if \(queuedFile\) \{[\s\S]*?assignWorkspaceLocation\(contextRoomProposalFileUrl\(result\.url, queuedFile\)\);[\s\S]*?return true;[\s\S]*?\}[\s\S]*?assignWorkspaceLocation\(contextRoomProposalReviewUrl\(result\.url\)\);/);
  assert.match(html, /assignWorkspaceLocation\(contextRoomProposalFileUrl\(prepared\.url, filePath\)\)/);
  assert.match(html, /const requestedReviewFile = initialQuery\?\.get\("file"\) \|\| ""/);
  assert.match(html, /state\.sharedContext\?\.mode === "review"\) \{\s*showProposalReview\(\)/);
  assert.match(html, /expectedHead: item\.head \|\| undefined/);
  assert.match(html, /state\.contextRoomOpeningProposalId = item\.id \|\| sharedProposalKey\(item\)/);
  assert.match(html, /Opening review…/);
  assert.match(html, /Checking revision and review authority…/);
  assert.match(html, /<strong>Verifying<\/strong>/);
  assert.doesNotMatch(html, /Preparing exact review…/);
  assert.match(html, /const pendingPaths = new Set\(state\.docqa\?\.pendingPaths/);
  assert.match(html, /const reviewedPaths = new Set\(state\.docqa\?\.reviewedPaths/);
  assert.match(html, /const reviewed = IS_HOSTED_REVIEW \? hostedEntry\?\.reviewed === true : Boolean\(!preview && state\.docqa && reviewedPaths\.has\(filePath\)\) \|\| Boolean\(preview && previewDocqa && previewReviewedPaths\.has\(filePath\)\)/);
  assert.doesNotMatch(html, /reviewed: Boolean\([^\n]*!pendingPaths\.has/);
  assert.match(html, /const queueCount = shared\?\.mode === "review" \? unprovenProposalCount : reportedQueueCount/);
  assert.match(html, /Review work is still pending\. Clear the filters or refresh to show it\./);
  assert.match(html, /function contextRoomReturnUrl\(\)/);
  assert.match(html, /Back to main Context Room/);
  assert.doesNotMatch(html, /\/?embedded=1/);
  assert.doesNotMatch(html, /state\.sharedReviewRooms/);
  assert.match(html, /id="sharedProposalReview"/);
  assert.match(html, /id="proposalDockBack"/);
  assert.match(html, /id="proposalDockAccept"/);
  assert.match(html, /id="proposalDockReject"/);
  assert.match(html, /Put on main/);
  assert.match(html, /Reject proposal/);
  assert.match(html, /Open review/);
  assert.match(html, /const wasOpen = state\.sharedProposalWorkspaceOpen/);
  assert.doesNotMatch(html, /Accept proposal/);
  assert.doesNotMatch(html, /Prepare pull request|Open pull request|Accepted branch ready/);
  assert.match(html, /if \(shared\?\.mode === "review" \|\| proposalPreview\) \{\s*controls\.hidden = true;/);
  assert.match(html, /backButton\.hidden = !inProposalContext \|\| onProposalPage/);
  assert.doesNotMatch(html, /acceptButton\.hidden = true/);
  assert.doesNotMatch(html, /finalizes the proposal automatically after the last file decision/);
  assert.match(html, /function requestSharedProposalAcceptance/);
  assert.match(html, /function requestSharedProposalRejection/);
  assert.match(html, /\/api\/shared-context\/accept/);
  assert.match(html, /\/api\/shared-context\/reject-challenge/);
  assert.match(html, /\/api\/shared-context\/reject/);
  assert.doesNotMatch(html, /class="proposal-review-file-select"/);
  assert.doesNotMatch(html, /type="checkbox" data-proposal-review-select/);
  assert.match(html, /toolbar\.hidden = !selected\.length/);
  assert.match(html, /proposalReviewFiles"\)\?\.addEventListener\("contextmenu"/);
  assert.match(html, /proposalReviewFiles"\)\?\.addEventListener\("pointerdown"/);
  assert.match(html, /PROPOSAL_REVIEW_LONG_PRESS_MS/);
  assert.match(html, /function contextRoomProposalSelectionUrl\(url, filePath\)/);
  assert.match(html, /Review status is still loading\. Try again when the row shows Review\./);
  assert.match(html, /reviewStateLoading \? "Verifying…"/);
  assert.doesNotMatch(html, /"Selecting…"/);
  assert.doesNotMatch(html, /state\.contextRoomQueuedProposalSelection = filePath/);
  assert.doesNotMatch(html, /entry\.selectable \|\| preparing \? " Right-click or press and hold to select\."/);
  assert.match(html, /if \(!entry \|\| \(!entry\.selectable && !entry\.reviewed\)\) return;/);
  assert.match(html, /timer: window\.setTimeout\(\(\) => \{[\s\S]*?selectOrQueueProposalReviewFile\(entry\.path\)/);
  assert.match(html, /const requestedProposalSelection = normalizeUiPath\(initialQuery\?\.get\("select"\) \|\| ""\)/);
  assert.match(html, /state\.proposalSelectedFiles\.add\(requestedProposalSelection\)/);
  assert.match(html, /proposalSelectionUrl\.searchParams\.delete\("select"\)/);
  assert.match(html, /selectOrQueueProposalReviewFile\(button\.dataset\.proposalReviewPath\)/);
  assert.match(html, /const previewDocqa = state\.contextRoomPreparedReview\?\.docqa \|\| null/);
  assert.match(html, /This file is already Reviewed, so it cannot be selected again\. Selection only applies to files still marked Review\. Open the file normally to inspect it\./);
  assert.match(html, /state\.proposalSelectionNotice = PROPOSAL_REVIEW_ALREADY_REVIEWED_NOTICE;\s*renderProposalReviewPage\(\);\s*setStatus\(PROPOSAL_REVIEW_ALREADY_REVIEWED_MESSAGE\)/);
  assert.match(html, /state\.proposalActionError \|\| authorityMessage \|\| state\.proposalSelectionNotice/);
  assert.match(html, /Right-click or press and hold to select/);
  assert.match(html, /data-proposal-review-selected/);
  assert.match(html, /Accept selected/);
  assert.match(html, /Reject selected/);
  assert.match(html, /data-proposal-unreview-path/);
  assert.match(html, /function requestSharedProposalFileUnreview/);
  assert.match(html, /\/api\/shared-context\/unreview-file/);
  assert.match(html, /Accepted shared main and the proposal branch remain unchanged/);
  assert.match(html, /Created|Modified|Deleted|Renamed|Copied|Dependency review/);
  assert.doesNotMatch(html, /\.proposal-review-file-open\s*\{[^}]*display:\s*contents/);
  assert.match(html, /\.proposal-review-file-open\s*\{[^}]*display:\s*grid/);
  assert.match(html, /el\("proposalDockBack"\)\?\.addEventListener\("click", \(\) => showProposalReview\(\)\)/);
});

test("recoverable proposal authority warnings stay inspectable without enabling acceptance", () => {
  const html = renderAppHtml();

  assert.match(html, /function contextRoomProposalIsOpenable\(item\)/);
  assert.match(html, /filter\(\(item\) => contextRoomProposalIsOpenable\(\{ \.\.\.item, type: "shared" \}\)\)/);
  assert.match(html, /function contextRoomProposalBlockedState\(item\)/);
  assert.match(html, /contextRoomProposalBlockedState\(item\)\?\.phase === "recovery_required"\) return \{ key: "critical", label: "Recovery required" \}/);
  assert.match(html, /state\.proposalAuthorityStatus/);
  assert.match(html, /acceptButton\.hidden = !actionable \|\| queueCount > 0 \|\| Boolean\(state\.proposalAuthorityStatus\)/);
  assert.match(html, /state\.proposalAuthorityMessage/);
});

test("accepted proposal commit records the human reviewer identity", () => {
  const review = {
    proposal: "proposal/demo/example",
    proposalHead: "a".repeat(40),
    sessionId: "thread-123",
    projectId: "demo",
    proposalFiles: [],
    reviewRoot: "/tmp/review",
  };
  const message = acceptedProposalCommitMessage(review, "Accept reviewed docs", {
    sub: "mathis",
    email: "mathis@example.test",
  });
  assert.match(message, /Context-Room-Reviewed-By: mathis/);
  assert.match(message, /Context-Room-Reviewer-Email: mathis@example\.test/);
});

test("proposal publication rebases onto fresh main and persists rebase conflicts", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const clean = createSharedProposal(fixture.project, { title: "Clean rebase", branch: "proposal/demo/clean-rebase" });
  configureGit(clean.root);
  writeFile(clean.root, "projects/demo/docs/README.md", "# Demo\n\nProposal text.\n");
  publishSharedProposal(fixture.project, { proposal: clean.branch });
  writeFile(fixture.seed, "projects/demo/docs/OTHER.md", "# Other\n\nAdvanced main.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance main elsewhere"]);
  git(fixture.seed, ["push", "origin", "main"]);
  writeFile(clean.root, "projects/demo/docs/README.md", "# Demo\n\nProposal text updated.\n");
  const rebased = publishSharedProposal(fixture.project, { proposal: clean.branch, description: "Update the proposal after main advanced." });
  assert.equal(rebased.rebased, true);
  assert.equal(rebased.semanticReviewRequired, true);
  const remote = listSharedProposals(fixture.project).find((item) => item.branch === clean.branch);
  assert.equal(remote.semanticReviewRequired, true);

  const conflict = createSharedProposal(fixture.project, { title: "Conflict rebase", branch: "proposal/demo/conflict-rebase" });
  configureGit(conflict.root);
  writeFile(conflict.root, "projects/demo/docs/README.md", "# Demo\n\nProposal conflict.\n");
  writeFile(fixture.seed, "projects/demo/docs/README.md", "# Demo\n\nMain conflict.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Create main conflict"]);
  git(fixture.seed, ["push", "origin", "main"]);
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: conflict.branch }), /Proposal rebase conflict/);
  const workspace = listSharedProposalWorkspaces(fixture.project).find((item) => item.branch === conflict.branch);
  assert.equal(Boolean(workspace.conflict), true);
});

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: options.stdio || ["ignore", "pipe", "pipe"] }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "shared-context@example.test"]);
  git(root, ["config", "user.name", "Shared Context Test"]);
}

function writeFile(root, relPath, content) {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

async function withSharedAnchoredChildPreload(t, name, source, env, action) {
  const preload = path.join(os.tmpdir(), `${name}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);
  fs.writeFileSync(preload, source, "utf8");
  t.after(() => { try { fs.unlinkSync(preload); } catch {} });
  const keys = ["NODE_OPTIONS", ...Object.keys(env || {})];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_OPTIONS = [previous.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
  for (const [key, value] of Object.entries(env || {})) process.env[key] = String(value);
  try {
    return await action();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test("GitHub security setup installs and verifies a no-bypass pull-request ruleset", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-github-security-"));
  const repository = path.join(base, "shared");
  const fakeBin = path.join(base, "bin");
  const statePath = path.join(base, "ruleset.json");
  const keyStatePath = path.join(base, "deploy-key.json");
  const sharedHome = path.join(base, "shared-home");
  fs.mkdirSync(repository, { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  initializeSharedRepository(repository, { name: "Secure shared context" });
  git(repository, ["init", "--initial-branch=main"]);
  git(repository, ["remote", "add", "origin", "git@github.com:Acme/shared-context.git"]);
  const fakeGh = path.join(fakeBin, "gh");
  fs.writeFileSync(fakeGh, `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const endpoint = args[1] || "";
const methodIndex = args.indexOf("--method");
const method = methodIndex >= 0 ? args[methodIndex + 1] : "GET";
const statePath = process.env.FAKE_GH_STATE;
const keyStatePath = process.env.FAKE_GH_KEY_STATE;
const current = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : [];
const currentKey = fs.existsSync(keyStatePath) ? JSON.parse(fs.readFileSync(keyStatePath, "utf8")) : null;
if (/\\/keys/.test(endpoint) && method === "POST") {
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  const saved = { ...body, id: 84 };
  fs.writeFileSync(keyStatePath, JSON.stringify(saved));
  process.stdout.write(JSON.stringify(saved));
} else if (/\\/keys/.test(endpoint)) {
  process.stdout.write(JSON.stringify(currentKey ? [currentKey] : []));
} else if (method === "POST" || method === "PUT") {
  const body = JSON.parse(fs.readFileSync(0, "utf8"));
  const match = endpoint.match(/\\/rulesets\\/(\\d+)/);
  const id = match ? Number(match[1]) : 42 + current.length;
  const saved = { ...body, id, _links: { html: { href: "https://github.com/Acme/shared-context/rules/" + id } } };
  const next = current.filter((item) => item.id !== id);
  next.push(saved);
  fs.writeFileSync(statePath, JSON.stringify(next));
  process.stdout.write(JSON.stringify(saved));
} else if (/\\/rulesets\\/\\d+/.test(endpoint)) {
  const id = Number(endpoint.match(/\\/rulesets\\/(\\d+)/)[1]);
  process.stdout.write(JSON.stringify(current.find((item) => item.id === id) || null));
} else {
  process.stdout.write(JSON.stringify(current.map((item) => ({ id: item.id, name: item.name }))));
}
`, "utf8");
  fs.chmodSync(fakeGh, 0o755);
  const previousPath = process.env.PATH;
  const previousState = process.env.FAKE_GH_STATE;
  const previousKeyState = process.env.FAKE_GH_KEY_STATE;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.PATH = `${fakeBin}:${previousPath}`;
  process.env.FAKE_GH_STATE = statePath;
  process.env.FAKE_GH_KEY_STATE = keyStatePath;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousState === undefined) delete process.env.FAKE_GH_STATE;
    else process.env.FAKE_GH_STATE = previousState;
    if (previousKeyState === undefined) delete process.env.FAKE_GH_KEY_STATE;
    else process.env.FAKE_GH_KEY_STATE = previousKeyState;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });

  const secured = secureSharedGitHubRepository(repository);
  assert.equal(secured.verified, true);
  assert.equal(secured.rulesetCreated, true);
  assert.equal(secured.createdRulesets, 4);
  assert.equal(Object.values(secured.checks).every(Boolean), true);
  const rulesets = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(rulesets.length, 4);
  assert.equal(rulesets.every((ruleset) => ruleset.bypass_actors.length === 0), true);
  const mainRuleset = rulesets.find((ruleset) => ruleset.name === "Context Room: protect main");
  const proposalRuleset = rulesets.find((ruleset) => ruleset.name === "Context Room: protect proposal review refs");
  const rejectedRuleset = rulesets.find((ruleset) => ruleset.name === "Context Room: protect rejected review refs");
  const stateRuleset = rulesets.find((ruleset) => ruleset.name === "Context Room: protect state review refs");
  const pullRequestRule = mainRuleset.rules.find((rule) => rule.type === "pull_request");
  assert.equal(pullRequestRule.parameters.required_approving_review_count, 1);
  assert.equal(pullRequestRule.parameters.dismiss_stale_reviews_on_push, true);
  assert.equal(pullRequestRule.parameters.require_last_push_approval, true);
  assert.deepEqual(proposalRuleset.conditions.ref_name.include, ["refs/heads/proposal/**/*"]);
  assert.deepEqual(proposalRuleset.rules.map((rule) => rule.type), ["deletion"]);
  assert.deepEqual(rejectedRuleset.conditions.ref_name.include, ["refs/heads/rejected/**/*"]);
  assert.deepEqual(rejectedRuleset.rules.map((rule) => rule.type), ["deletion", "non_fast_forward", "update"]);
  assert.deepEqual(stateRuleset.conditions.ref_name.include, ["refs/heads/context-room-state/*"]);
  assert.deepEqual(stateRuleset.rules.map((rule) => rule.type), ["deletion", "non_fast_forward"]);
  const deployKey = JSON.parse(fs.readFileSync(keyStatePath, "utf8"));
  assert.equal(deployKey.read_only, false);
  assert.equal(git(repository, ["remote", "get-url", "origin"]), "git@github.com:Acme/shared-context.git");
  assert.match(git(repository, ["config", "--get", "core.sshCommand"]), /agent_ed25519/);
  assert.equal(checkSharedGitHubSecurity(repository).verified, true);
});

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-shared-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  fs.mkdirSync(project, { recursive: true });
  git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(base, ["clone", remote, seed], { stdio: "ignore" });
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Fixture Shared Context" });
  writeFile(seed, "projects.json", JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  writeFile(seed, "projects/demo/skills/demo-workflow/SKILL.md", "---\nname: demo-workflow\ndescription: Demo project workflow.\n---\n\n# Demo workflow\n");
  writeFile(seed, "projects/demo/skills/demo-workflow/scripts/run.sh", "#!/bin/sh\nprintf 'demo\\n'\n");
  fs.chmodSync(path.join(seed, "projects/demo/skills/demo-workflow/scripts/run.sh"), 0o755);
  writeFile(seed, "skills/global/global-workflow/SKILL.md", "---\nname: global-workflow\ndescription: Demo global workflow.\n---\n\n# Global workflow\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared context"]);
  git(seed, ["push", "origin", "main"]);
  initializeContextRoomProject(project, { title: "Demo", allowedPaths: ["README.md"], watchAllow: [] });
  return { base, remote, seed, project };
}

function rawHttpRequest(url, { method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method, headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        statusCode: response.statusCode || 0,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    request.once("error", reject);
    request.end();
  });
}

function withSharedHome(t, fixture) {
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  const home = path.join(fixture.base, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(home, ".context-room", "shared");
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(home, ".context-room", "hub");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
  });
}

async function waitForPath(filePath, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(filePath), true, message);
}

function spawnSharedBindingProcess(fixture, spec = {}) {
  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const identity = randomUUID();
  const ready = path.join(fixture.base, `shared-binding-${identity}.ready`);
  const done = path.join(fixture.base, `shared-binding-${identity}.done`);
  const holdReady = path.join(fixture.base, `shared-binding-${identity}.hold-ready`);
  const holdRelease = path.join(fixture.base, `shared-binding-${identity}.hold-release`);
  const source = `
    import fs from "node:fs";
    import path from "node:path";
    const [moduleUrl, rawSpec] = process.argv.slice(1);
    const spec = JSON.parse(rawSpec);
    const originalWriteFileSync = fs.writeFileSync.bind(fs);
    const originalRenameSync = fs.renameSync.bind(fs);
    let registryWriteHeld = false;
    if (spec.pauseRegistryWrite) {
      fs.renameSync = (source, destination) => {
        if (!registryWriteHeld && typeof destination === "string" && path.resolve(destination) === path.resolve(spec.registryPath)) {
          registryWriteHeld = true;
          originalWriteFileSync(spec.holdReady, "ready");
          const wait = new Int32Array(new SharedArrayBuffer(4));
          while (!fs.existsSync(spec.holdRelease)) Atomics.wait(wait, 0, 0, 10);
        }
        return originalRenameSync(source, destination);
      };
    }
    if (spec.disconnectPausePhase) {
      const configuredRenameSync = fs.renameSync.bind(fs);
      const originalUnlinkSync = fs.unlinkSync.bind(fs);
      const pause = () => {
        originalWriteFileSync(spec.holdReady, "ready");
        const wait = new Int32Array(new SharedArrayBuffer(4));
        while (!fs.existsSync(spec.holdRelease)) Atomics.wait(wait, 0, 0, 10);
      };
      const physicalLeaf = (value) => {
        const resolved = path.resolve(String(value));
        try { return path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved)); }
        catch { return resolved; }
      };
      fs.unlinkSync = (target) => {
        const result = originalUnlinkSync(target);
        if (spec.disconnectPausePhase === "link-unlink" && physicalLeaf(target) === physicalLeaf(spec.disconnectSkillLink)) pause();
        return result;
      };
      fs.renameSync = (source, destination) => {
        const result = configuredRenameSync(source, destination);
        const resolved = path.resolve(String(destination));
        if (
          (spec.disconnectPausePhase === "owner-write" && resolved === path.resolve(spec.managedRegistryPath))
          || (spec.disconnectPausePhase === "link-registry-write" && resolved === path.resolve(spec.disconnectSkillRegistry))
          || (spec.disconnectPausePhase === "binding-write" && resolved === path.resolve(spec.registryPath))
        ) pause();
        return result;
      };
    }
    const api = await import(moduleUrl);
    originalWriteFileSync(spec.ready, "ready");
    if (spec.gate) {
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(spec.gate)) Atomics.wait(wait, 0, 0, 10);
    }
    try {
      const result = spec.action === "disconnect"
        ? api.disconnectSharedContext(spec.project)
        : spec.action === "detect"
          ? api.detectSharedProject(spec.project, {
              repository: spec.repository,
              projectId: spec.projectId || "demo",
            })
          : api.connectSharedContext(spec.project, {
            repository: spec.repository,
            projectId: spec.projectId || "demo",
            sync: spec.sync !== false,
          });
      originalWriteFileSync(spec.done, "done");
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      originalWriteFileSync(spec.done, "done");
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: error.code || "", message: error.message },
      }));
    }
  `;
  const childSpec = {
    ...spec,
    ready,
    done,
    holdReady,
    holdRelease,
    registryPath: path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "registry.json"),
    managedRegistryPath: path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "managed-destinations.json"),
  };
  let child = null;
  const result = new Promise((resolve, reject) => {
    child = spawn(process.execPath, ["--input-type=module", "-e", source, moduleUrl, JSON.stringify(childSpec)], {
      env: { ...process.env, ...(spec.env || {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `shared binding child exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); }
      catch { reject(new Error(`Invalid shared binding child output: ${stdout || stderr}`)); }
    });
  });
  return { ready, done, holdReady, holdRelease, child, result };
}

function runTerminalDecisionProcess(spec) {
  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const source = `
    const [moduleUrl, rawSpec] = process.argv.slice(1);
    const api = await import(moduleUrl);
    const spec = JSON.parse(rawSpec);
    try {
      const result = spec.action === "accept"
        ? api.acceptSharedReview(spec.reviewRoot, { message: spec.message || "Accept terminal race" })
        : api.rejectSharedRepositoryProposal(spec.repository, {
            proposal: spec.proposal,
            expectedHead: spec.proposalHead,
            actor: spec.actor || "terminal-race-owner",
          });
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: {
          code: error.code || "",
          statusCode: error.statusCode || 0,
          message: error.message,
          details: error.details || null,
        },
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, moduleUrl, JSON.stringify(spec)], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `terminal decision child exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); }
      catch { reject(new Error(`Invalid terminal decision child output: ${stdout || stderr}`)); }
    });
  });
}

function stallGitCommand(t, fixture, command) {
  const realGit = String(execFileSync("which", ["git"], { encoding: "utf8" })).trim();
  const fakeBin = path.join(fixture.base, `fake-git-${command}-${Date.now()}`);
  const fakeGit = path.join(fakeBin, "git");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(fakeGit, `#!/bin/sh\nif [ "$1" = ${JSON.stringify(command)} ]; then\n  exec sleep 10\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`, "utf8");
  fs.chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.env.PATH = previousPath;
  };
  process.env.PATH = `${fakeBin}:${previousPath}`;
  t.after(restore);
  return restore;
}

function traceGitCommands(t, fixture) {
  const realGit = String(execFileSync("which", ["git"], { encoding: "utf8" })).trim();
  const fakeBin = path.join(fixture.base, `fake-git-trace-${Date.now()}`);
  const fakeGit = path.join(fakeBin, "git");
  const tracePath = path.join(fakeBin, "commands.jsonl");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(fakeGit, `#!/usr/bin/env node
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CONTEXT_ROOM_TEST_GIT_TRACE, JSON.stringify(args) + "\\n");
const result = spawnSync(${JSON.stringify(realGit)}, args, { stdio: ["inherit", "inherit", "inherit"] });
if (result.error) {
  process.stderr.write(String(result.error.message || result.error) + "\\n");
  process.exit(127);
}
process.exit(Number.isInteger(result.status) ? result.status : 1);
`, "utf8");
  fs.chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  const previousTrace = process.env.CONTEXT_ROOM_TEST_GIT_TRACE;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  process.env.CONTEXT_ROOM_TEST_GIT_TRACE = tracePath;
  const restore = () => {
    process.env.PATH = previousPath;
    if (previousTrace === undefined) delete process.env.CONTEXT_ROOM_TEST_GIT_TRACE;
    else process.env.CONTEXT_ROOM_TEST_GIT_TRACE = previousTrace;
  };
  t.after(restore);
  return {
    read() {
      return fs.readFileSync(tracePath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    },
    restore,
  };
}

function failGitMergeTree(t, fixture) {
  const realGit = String(execFileSync("which", ["git"], { encoding: "utf8" })).trim();
  const fakeBin = path.join(fixture.base, `fake-git-merge-tree-${Date.now()}`);
  const fakeGit = path.join(fakeBin, "git");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "merge-tree" ]; then
  printf '%s\n' 'controlled merge-tree failure' >&2
  exit 2
fi
exec ${JSON.stringify(realGit)} "$@"
`, "utf8");
  fs.chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  const restore = () => { process.env.PATH = previousPath; };
  t.after(restore);
  return restore;
}

async function runGatedProposalProcesses(fixture, specs) {
  const gate = path.join(fixture.base, `proposal-registry-${randomUUID()}.gate`);
  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const source = `
    import fs from "node:fs";
    import path from "node:path";
    const [rawSpec, ready, gate, moduleUrl] = process.argv.slice(1);
    const spec = JSON.parse(rawSpec);
    fs.writeFileSync(ready, "ready");
    const wait = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 10);
    if (spec.fixedNow) {
      const NativeDate = globalThis.Date;
      globalThis.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [spec.fixedNow])); }
        static now() { return NativeDate.now(); }
      };
    }
    try {
      const api = await import(moduleUrl);
      if (spec.connect) {
        api.connectSharedContext(spec.project, {
          repository: spec.repository,
          projectId: spec.projectId || "demo",
        });
      }
      let result;
      if (spec.action === "publish") {
        result = api.publishSharedProposal(spec.project, { proposal: spec.branch });
      } else {
        const proposal = api.createSharedProposal(spec.project, {
            title: spec.title,
            description: spec.description || "",
            scope: spec.scope || "project",
            sessionId: spec.sessionId || "",
          });
        if (spec.action === "create-publish") {
          const target = path.join(proposal.root, spec.file);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, spec.content || "# Concurrent proposal\\n", "utf8");
          const published = api.publishSharedProposal(spec.project, {
            proposal: proposal.branch,
            author: { name: "Context Room test", email: "context-room-test@local.invalid" },
          });
          result = { proposal, published };
        } else {
          result = proposal;
        }
      }
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: error.code || "", message: error.message },
      }));
    }
  `;
  const children = specs.map((spec, index) => {
    const ready = path.join(fixture.base, `proposal-registry-${index}-${randomUUID()}.ready`);
    const result = new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", source, JSON.stringify(spec), ready, gate, moduleUrl], {
        env: {
          ...process.env,
          ...(spec.home ? { HOME: spec.home } : {}),
          ...(spec.sharedHome ? { CONTEXT_ROOM_SHARED_HOME: spec.sharedHome } : {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", (code) => {
        if (code !== 0) reject(new Error(stderr || `proposal registry child exited ${code}`));
        else {
          try { resolve(JSON.parse(stdout || "{}")); }
          catch { reject(new Error(`Invalid proposal registry child output: ${stdout || stderr}`)); }
        }
      });
    });
    return { ready, result };
  });
  const readyDeadline = Date.now() + 10_000;
  while (children.some((child) => !fs.existsSync(child.ready)) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (children.some((child) => !fs.existsSync(child.ready))) {
    fs.writeFileSync(gate, "go");
    await Promise.allSettled(children.map((child) => child.result));
    throw new Error("Concurrent proposal children did not reach the start gate");
  }
  fs.writeFileSync(gate, "go");
  return Promise.all(children.map((child) => child.result));
}

test("Context Hub exposes an offline Shared project as a cached snapshot", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const online = contextHubUiState(fixture.project, { refreshShared: true, force: true });
  const onlineProject = online.projects.find((project) => project.shared?.projectId === "demo");
  assert.equal(onlineProject?.sharedStatus?.online, true);
  assert.match(onlineProject?.sharedStatus?.revision || "", /^[a-f0-9]{40}$/);

  fs.renameSync(fixture.remote, fixture.remote + ".offline");
  const offline = contextHubUiState(fixture.project, { refreshShared: true, force: true });
  const offlineProject = offline.projects.find((project) => project.shared?.projectId === "demo");
  assert.equal(offlineProject?.sharedStatus?.online, false);
  assert.equal(offlineProject?.sharedStatus?.revision, onlineProject.sharedStatus.revision);
  assert.match(offlineProject?.sharedStatus?.fetchError || "", /fetch|repository|remote|exist/i);
});

test("Context Hub deduplicates equivalent Shared transports across its registry and local bindings", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  registerContextHubSharedRepository(`file://${fixture.remote}`);

  const hub = contextHubUiState(fixture.project, { refreshShared: true, force: true });
  assert.equal(hub.sharedRepositories.length, 1);
  assert.equal(hub.summary.sharedRepositories, 1);
  assert.equal(hub.projects.filter((project) => project.shared?.projectId === "demo").length, 1);
  assert.equal(hub.projects.find((project) => project.shared?.projectId === "demo")?.sharedProposalCount, 0);
});

test("Context Hub isolates two Shared repositories when one falls back to its offline cache", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const secondRemote = path.join(fixture.base, "second-remote.git");
  git(fixture.base, ["clone", "--bare", fixture.seed, secondRemote], { stdio: "ignore" });
  registerContextHubSharedRepository(fixture.remote);
  registerContextHubSharedRepository(secondRemote);
  const firstRepositoryIdentity = contextHubRepositoryIdentity(fixture.remote);
  const secondRepositoryIdentity = contextHubRepositoryIdentity(secondRemote);

  const online = contextHubUiState(fixture.project, { refreshShared: true, force: true });
  assert.equal(online.sharedRepositories.length, 2);
  assert.equal(online.sharedRepositories.every((repository) => repository.status?.online === true), true);

  fs.renameSync(secondRemote, `${secondRemote}.offline`);
  const mixed = contextHubUiState(fixture.project, { refreshShared: true, force: true });
  assert.equal(mixed.sharedRepositories.length, 2);
  assert.equal(mixed.repositoryErrors.length, 0);
  assert.equal(mixed.sharedRepositories.find((repository) => (
    contextHubRepositoryIdentity(repository.repository) === firstRepositoryIdentity
  ))?.status?.online, true);
  assert.equal(mixed.sharedRepositories.find((repository) => (
    contextHubRepositoryIdentity(repository.repository) === secondRepositoryIdentity
  ))?.status?.online, false);
  const duplicatedProjectIds = mixed.projects.filter((project) => project.shared?.projectId === "demo");
  assert.equal(duplicatedProjectIds.length, 2);
  assert.equal(new Set(duplicatedProjectIds.map((project) => project.projectKey)).size, 2);
});

function sharedAcceptanceLockPath(review) {
  const identity = `${review.metadata.repository}\0${review.metadata.proposal}\0${review.metadata.proposalHead}`;
  const lockKey = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  return path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "locks", `accept-${lockKey}.lock`);
}

function sharedReviewRepositoryCheckout(review) {
  return path.join(path.dirname(path.dirname(path.resolve(review.reviewRoot))), "repository");
}

function sharedAcceptanceChild(reviewRoot, { timeout = 2_000 } = {}) {
  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const source = `
    import { acceptSharedReview } from ${JSON.stringify(moduleUrl)};
    try {
      const result = acceptSharedReview(process.argv[1], { message: "Accept from child" });
      process.stdout.write(JSON.stringify({ result }) + "\\n");
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: { code: error.code || "", message: error.message, retryable: error.retryable === true } }) + "\\n");
    }
  `;
  return spawnSync(process.execPath, ["--input-type=module", "-e", source, reviewRoot], {
    encoding: "utf8",
    timeout,
    env: { ...process.env },
  });
}

function withIsolatedEventJournal(t, fixture) {
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  const hubHome = path.join(fixture.base, "event-journal");
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
  });
  return hubHome;
}

function rewriteAsLegacyReviewWithoutResourceMode(reviewRoot, filePath) {
  const statePath = path.join(reviewRoot, ".context-room", "review-state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  if (state.reviews?.[filePath]) delete state.reviews[filePath].resourceMode;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  authorizeOwnerTrustedState(reviewRoot, "review-state", { version: 2, reviews: state.reviews || {} }, { actor: "legacy-test-fixture" });
  const ledgerPath = path.join(reviewRoot, ".context-room", "review-ledger.json");
  if (fs.existsSync(ledgerPath)) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
    for (const entry of Object.values(ledger.reviews || {})) delete entry.resourceMode;
    fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2) + "\n", "utf8");
    authorizeOwnerTrustedState(reviewRoot, "review-ledger", { version: 2, reviews: ledger.reviews || {} }, { actor: "legacy-test-fixture" });
  }
}

test("disconnecting a shared context clears only the local binding and project configuration", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  assert.equal(listRegisteredSharedBindings(fixture.remote).length, 1);
  assert.equal(readSharedProjectConnection(fixture.project).projectId, "demo");

  const result = disconnectSharedContext(fixture.project);
  assert.equal(result.disconnected, true);
  assert.equal(listRegisteredSharedBindings(fixture.remote).length, 0);
  assert.equal(readSharedProjectConnection(fixture.project), null);
  assert.equal(fs.existsSync(fixture.remote), true);
});

test("equivalent GitHub transports reuse one Shared binding, cache, and disconnect lifecycle", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const gitConfig = path.join(fixture.base, "alias-gitconfig");
  const httpsRepository = "https://github.com/Peerlab/context-room-alias-fixture.git";
  const sshRepository = "git@github.com:peerlab/context-room-alias-fixture.git";
  const rewriteKey = `url.file://${fixture.remote}.insteadOf`;
  git(fixture.base, ["config", "--file", gitConfig, rewriteKey, httpsRepository]);
  git(fixture.base, ["config", "--file", gitConfig, "--add", rewriteKey, sshRepository]);
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
  });

  const secondRoot = path.join(fixture.base, "second-project");
  fs.mkdirSync(secondRoot, { recursive: true });
  initializeContextRoomProject(secondRoot, { title: "Second demo", allowedPaths: [], watchAllow: [] });

  const first = connectSharedContext(fixture.project, { repository: httpsRepository, projectId: "demo" });
  const initialOrigin = git(path.join(first.cacheRoot, "repository"), ["remote", "get-url", "origin"]);
  const repeated = connectSharedContext(fixture.project, { repository: sshRepository, projectId: "demo" });
  assert.equal(repeated.cacheRoot, first.cacheRoot);
  assert.equal(listRegisteredSharedBindings(sshRepository).length, 1);

  const second = connectSharedContext(secondRoot, { repository: sshRepository, projectId: "demo" });
  assert.equal(second.cacheRoot, first.cacheRoot);
  assert.equal(readSharedProjectConnection(fixture.project).repository, httpsRepository);
  assert.equal(readSharedProjectConnection(secondRoot).repository, httpsRepository);
  assert.deepEqual(listRegisteredSharedRepositories(), [httpsRepository]);
  assert.equal(listRegisteredSharedBindings(httpsRepository).length, 2);
  assert.equal(listRegisteredSharedBindings(sshRepository).length, 2);
  assert.equal(listRegisteredSharedProjectLocations(sshRepository).length, 2);
  const repositoryCaches = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .filter((name) => fs.existsSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, name, "repository", ".git")));
  assert.equal(repositoryCaches.length, 1);
  assert.equal(git(path.join(first.cacheRoot, "repository"), ["remote", "get-url", "origin"]), initialOrigin);

  const deviceLink = path.join(process.env.HOME, ".agents", "skills", "global-workflow");
  assert.equal(fs.lstatSync(deviceLink).isSymbolicLink(), true);
  assert.equal(disconnectSharedContext(fixture.project).disconnected, true);
  assert.equal(fs.lstatSync(deviceLink).isSymbolicLink(), true, "the remaining alias-equivalent binding keeps device links");
  assert.equal(listRegisteredSharedBindings(sshRepository).length, 1);
  assert.equal(readSharedProjectConnection(secondRoot).repository, httpsRepository);

  assert.equal(disconnectSharedContext(secondRoot).disconnected, true);
  assert.equal(fs.existsSync(deviceLink), false);
  assert.deepEqual(listRegisteredSharedRepositories(), []);
  assert.deepEqual(listRegisteredSharedBindings(sshRepository), []);
  assert.equal(fs.existsSync(first.cacheRoot), true, "disconnect does not delete the recoverable Shared cache");
});

test("cross-process Shared connects preserve bindings for different repositories", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const secondRemote = path.join(fixture.base, "second-remote.git");
  git(fixture.base, ["clone", "--bare", fixture.seed, secondRemote], { stdio: "ignore" });
  const secondProject = path.join(fixture.base, "second-project");
  fs.mkdirSync(secondProject, { recursive: true });
  initializeContextRoomProject(secondProject, { title: "Second", allowedPaths: [], watchAllow: [] });

  const first = spawnSharedBindingProcess(fixture, {
    action: "connect",
    project: fixture.project,
    repository: fixture.remote,
    projectId: "demo",
    sync: false,
    pauseRegistryWrite: true,
  });
  await waitForPath(first.holdReady, "the first connect should hold the registry transaction before writing");
  const second = spawnSharedBindingProcess(fixture, {
    action: "connect",
    project: secondProject,
    repository: secondRemote,
    projectId: "demo",
    sync: false,
  });
  await waitForPath(second.ready, "the second connect process should start");
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fs.existsSync(second.done), false, "the second connect waits for the registry transaction");
  } finally {
    fs.writeFileSync(first.holdRelease, "release");
  }
  const outcomes = await Promise.all([first.result, second.result]);
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  assert.equal(listRegisteredSharedBindings(fixture.remote).length, 1);
  assert.equal(listRegisteredSharedBindings(secondRemote).length, 1);
  assert.equal(listRegisteredSharedBindings().length, 2);
});

test("cross-process Shared connect and disconnect preserve the surviving binding", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo", sync: false });
  const secondRemote = path.join(fixture.base, "second-remote.git");
  git(fixture.base, ["clone", "--bare", fixture.seed, secondRemote], { stdio: "ignore" });
  const secondProject = path.join(fixture.base, "second-project");
  fs.mkdirSync(secondProject, { recursive: true });
  initializeContextRoomProject(secondProject, { title: "Second", allowedPaths: [], watchAllow: [] });

  const disconnecting = spawnSharedBindingProcess(fixture, {
    action: "disconnect",
    project: fixture.project,
    pauseRegistryWrite: true,
  });
  await waitForPath(disconnecting.holdReady, "disconnect should hold the registry transaction before writing");
  const connecting = spawnSharedBindingProcess(fixture, {
    action: "connect",
    project: secondProject,
    repository: secondRemote,
    projectId: "demo",
    sync: false,
  });
  await waitForPath(connecting.ready, "the concurrent connect process should start");
  try {
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.equal(fs.existsSync(connecting.done), false, "connect waits until disconnect commits its registry transaction");
  } finally {
    fs.writeFileSync(disconnecting.holdRelease, "release");
  }
  const outcomes = await Promise.all([disconnecting.result, connecting.result]);
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  assert.equal(readSharedProjectConnection(fixture.project), null);
  assert.equal(readSharedProjectConnection(secondProject)?.repository, secondRemote);
  assert.equal(listRegisteredSharedBindings().length, 1);
});

test("cross-process first connects through canonical aliases perform exactly one clone", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const secondProject = path.join(fixture.base, "second-project");
  fs.mkdirSync(secondProject, { recursive: true });
  initializeContextRoomProject(secondProject, { title: "Second", allowedPaths: [], watchAllow: [] });
  const gate = path.join(fixture.base, "shared-clone.gate");
  const cloneLog = path.join(fixture.base, "shared-clone.log");
  const fakeBin = path.join(fixture.base, "fake-git-clone");
  const fakeGit = path.join(fakeBin, "git");
  const realGit = String(execFileSync("which", ["git"], { encoding: "utf8" })).trim();
  const gitConfig = path.join(fixture.base, "alias-gitconfig");
  const httpsRepository = "https://github.com/Peerlab/context-room-concurrent-clone.git";
  const sshRepository = "git@github.com:peerlab/context-room-concurrent-clone.git";
  const rewriteKey = `url.file://${fixture.remote}.insteadOf`;
  git(fixture.base, ["config", "--file", gitConfig, rewriteKey, httpsRepository]);
  git(fixture.base, ["config", "--file", gitConfig, "--add", rewriteKey, sshRepository]);
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(fakeGit, `#!/bin/sh\nif [ "$1" = "clone" ]; then\n  printf 'clone\\n' >> "$CONTEXT_ROOM_CLONE_LOG"\n  sleep 0.2\nfi\nexec ${JSON.stringify(realGit)} "$@"\n`, "utf8");
  fs.chmodSync(fakeGit, 0o755);
  const childEnv = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    CONTEXT_ROOM_CLONE_LOG: cloneLog,
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const children = [
    { project: fixture.project, repository: httpsRepository },
    { project: secondProject, repository: sshRepository },
  ].map(({ project, repository }) => spawnSharedBindingProcess(fixture, {
    action: "connect",
    project,
    repository,
    projectId: "demo",
    sync: false,
    gate,
    env: childEnv,
  }));
  await Promise.all(children.map((child, index) => waitForPath(child.ready, `clone child ${index + 1} should reach the start gate`)));
  fs.writeFileSync(gate, "go");
  const outcomes = await Promise.all(children.map((child) => child.result));
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  assert.equal(fs.readFileSync(cloneLog, "utf8").trim().split("\n").length, 1);
  assert.equal(listRegisteredSharedBindings(httpsRepository).length, 2);
  assert.equal(listRegisteredSharedBindings(sshRepository).length, 2);
  assert.equal(listRegisteredSharedRepositories().length, 1);
  const repositoryCaches = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .filter((name) => fs.existsSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, name, "repository", ".git")));
  assert.equal(repositoryCaches.length, 1);
});

test("cross-process Shared-only alias discovery reuses the canonical cache without a binding", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const secondProject = path.join(fixture.base, "second-project");
  fs.mkdirSync(secondProject, { recursive: true });
  initializeContextRoomProject(secondProject, { title: "Second", allowedPaths: [], watchAllow: [] });
  const gitConfig = path.join(fixture.base, "shared-only-alias-gitconfig");
  const httpsRepository = "https://github.com/Peerlab/context-room-shared-only-clone.git";
  const sshRepository = "git@github.com:peerlab/context-room-shared-only-clone.git";
  const rewriteKey = `url.file://${fixture.remote}.insteadOf`;
  git(fixture.base, ["config", "--file", gitConfig, rewriteKey, httpsRepository]);
  git(fixture.base, ["config", "--file", gitConfig, "--add", rewriteKey, sshRepository]);
  const gate = path.join(fixture.base, "shared-only-clone.gate");
  const childEnv = { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: "1" };
  const children = [
    { project: fixture.project, repository: httpsRepository },
    { project: secondProject, repository: sshRepository },
  ].map(({ project, repository }) => spawnSharedBindingProcess(fixture, {
    action: "detect",
    project,
    repository,
    projectId: "demo",
    gate,
    env: childEnv,
  }));
  await Promise.all(children.map((child, index) => waitForPath(child.ready, `Shared-only child ${index + 1} should reach the start gate`)));
  fs.writeFileSync(gate, "go");
  const outcomes = await Promise.all(children.map((child) => child.result));
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  assert.deepEqual(listRegisteredSharedRepositories(), []);
  assert.deepEqual(listRegisteredSharedBindings(), []);
  const repositoryCaches = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .filter((name) => fs.existsSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, name, "repository", ".git")));
  assert.equal(repositoryCaches.length, 1);
});

test("Shared registry and canonical clone locks recover abandoned owners", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const locksRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "locks");
  const registryLock = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "registry.json.lock");
  const repositoryIdentity = contextHubRepositoryIdentity(fixture.remote);
  const repositoryLock = path.join(locksRoot, `repository-${createHash("sha256").update(repositoryIdentity).digest("hex").slice(0, 24)}.lock`);
  fs.mkdirSync(locksRoot, { recursive: true });
  const abandoned = JSON.stringify({
    pid: 2_147_483_647,
    threadId: 0,
    ownerInstanceId: "",
    kind: "owner",
    token: randomUUID(),
    acquiredAt: new Date(Date.now() - 60_000).toISOString(),
  }) + "\n";
  for (const lockPath of [registryLock, repositoryLock]) {
    fs.writeFileSync(lockPath, abandoned, { mode: 0o600 });
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, stale, stale);
  }

  const connected = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo", sync: false });
  assert.equal(connected.connected, true);
  assert.equal(fs.existsSync(registryLock), false);
  assert.equal(fs.existsSync(repositoryLock), false);
  assert.equal(listRegisteredSharedBindings(fixture.remote).length, 1);
});

test("failed disconnect restores link registries, managed ownership, bindings, and links exactly", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const connected = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const skillRegistry = fs.readdirSync(path.join(connected.cacheRoot, "skill-links"))
    .map((name) => path.join(connected.cacheRoot, "skill-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  const instructionRegistry = fs.readdirSync(path.join(connected.cacheRoot, "instruction-links"))
    .filter((name) => name !== "device.json")
    .map((name) => path.join(connected.cacheRoot, "instruction-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  const managedRegistry = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "managed-destinations.json");
  const configPath = path.join(fixture.project, ".context-room", "config.json");
  const projectLink = path.join(fixture.project, ".agents", "skills", "demo-workflow");
  assert.ok(skillRegistry);
  assert.ok(instructionRegistry);
  assert.equal(fs.lstatSync(projectLink).isSymbolicLink(), true);
  assert.ok(JSON.parse(fs.readFileSync(skillRegistry, "utf8")).links.length > 0);

  fs.writeFileSync(instructionRegistry, "{ malformed instruction registry\n", "utf8");
  const before = new Map([skillRegistry, instructionRegistry, managedRegistry, configPath].map((filePath) => [filePath, {
    content: fs.readFileSync(filePath),
    mode: fs.statSync(filePath).mode & 0o777,
  }]));
  const linkTarget = fs.realpathSync(projectLink);

  assert.throws(() => disconnectSharedContext(fixture.project), /JSON|Unexpected token|Expected property name/);
  for (const [filePath, snapshot] of before) {
    assert.deepEqual(fs.readFileSync(filePath), snapshot.content, `${filePath} content should roll back exactly`);
    assert.equal(fs.statSync(filePath).mode & 0o777, snapshot.mode, `${filePath} mode should roll back exactly`);
  }
  assert.equal(fs.lstatSync(projectLink).isSymbolicLink(), true);
  assert.equal(fs.realpathSync(projectLink), linkTarget);
  assert.equal(readSharedProjectConnection(fixture.project)?.repository, fixture.remote);
  assert.equal(listRegisteredSharedBindings(fixture.remote).length, 1);
});

test("disconnect crash recovery removes no link, owner, registry, or binding phase partially", { timeout: 60_000 }, async (t) => {
  for (const phase of ["link-unlink", "owner-write", "link-registry-write", "binding-write"]) {
    const fixture = makeFixture();
    withSharedHome(t, fixture);
    const connected = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
    const skillLink = path.join(fixture.project, ".agents", "skills", "demo-workflow");
    const globalLink = path.join(process.env.HOME, ".agents", "skills", "global-workflow");
    const skillRegistry = fs.readdirSync(path.join(connected.cacheRoot, "skill-links"))
      .map((name) => path.join(connected.cacheRoot, "skill-links", name))
      .find((candidate) => candidate.endsWith(".json"));
    const child = spawnSharedBindingProcess(fixture, {
      action: "disconnect",
      project: fixture.project,
      disconnectPausePhase: phase,
      disconnectSkillLink: skillLink,
      disconnectSkillRegistry: skillRegistry,
    });
    await Promise.race([
      waitForPath(child.holdReady, `disconnect should reach ${phase}`),
      child.result.then((outcome) => {
        throw new Error(`disconnect completed before ${phase}: ${JSON.stringify(outcome)}`);
      }),
    ]);
    child.child.kill("SIGKILL");
    await child.result.catch(() => null);

    const journalRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "transactions", "disconnect");
    assert.equal(fs.readdirSync(journalRoot).some((name) => name.endsWith(".json")), true, `${phase} must leave a durable journal`);
    const stale = new Date(Date.now() - 60_000);
    const registryLock = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "registry.json.lock");
    if (fs.existsSync(registryLock)) fs.utimesSync(registryLock, stale, stale);
    const locksRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "locks");
    if (fs.existsSync(locksRoot)) {
      for (const name of fs.readdirSync(locksRoot)) {
        const lockPath = path.join(locksRoot, name);
        const stats = fs.lstatSync(lockPath);
        if (stats.isFile()) {
          fs.utimesSync(lockPath, stale, stale);
          continue;
        }
        const ownerPath = path.join(lockPath, "owner.json");
        if (!fs.existsSync(ownerPath)) continue;
        const owner = JSON.parse(fs.readFileSync(ownerPath, "utf8"));
        fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 2_147_483_647, createdAt: stale.toISOString() }, null, 2) + "\n", "utf8");
      }
    }

    const recovery = recoverSharedContextTransactions();
    assert.equal(recovery.recovered.length, 1, `${phase} must recover exactly one transaction`);
    const retry = disconnectSharedContext(fixture.project);
    assert.equal(retry.disconnected, phase !== "binding-write", `${phase} commit point must be deterministic`);
    assert.equal(readSharedProjectConnection(fixture.project), null);
    assert.equal(listRegisteredSharedBindings(fixture.remote).length, 0);
    assert.equal(fs.existsSync(skillLink), false);
    assert.equal(fs.existsSync(globalLink), false);
    const owners = JSON.parse(fs.readFileSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "managed-destinations.json"), "utf8"));
    assert.deepEqual(owners.destinations || {}, {}, `${phase} must leave no ghost owner`);
    assert.equal(fs.existsSync(journalRoot) && fs.readdirSync(journalRoot).length > 0, false);
  }
});

test("disconnect recovery quarantines a journal when its checkout is replaced before rollback", { timeout: 20_000 }, async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const connected = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const skillLink = path.join(fixture.project, ".agents", "skills", "demo-workflow");
  const skillRegistry = fs.readdirSync(path.join(connected.cacheRoot, "skill-links"))
    .map((name) => path.join(connected.cacheRoot, "skill-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  const child = spawnSharedBindingProcess(fixture, {
    action: "disconnect",
    project: fixture.project,
    disconnectPausePhase: "link-unlink",
    disconnectSkillLink: skillLink,
    disconnectSkillRegistry: skillRegistry,
  });
  await Promise.race([
    waitForPath(child.holdReady, "disconnect should reach its first durable mutation"),
    child.result.then((outcome) => {
      throw new Error(`disconnect completed before replacement: ${JSON.stringify(outcome)}`);
    }),
  ]);
  child.child.kill("SIGKILL");
  await child.result.catch(() => null);

  const archived = path.join(fixture.base, "original-project-after-crash");
  fs.renameSync(fixture.project, archived);
  fs.mkdirSync(path.dirname(skillLink), { recursive: true });
  fs.writeFileSync(skillLink, "replacement bytes must survive recovery\n", "utf8");
  const replacementBefore = fs.readFileSync(skillLink);
  const registryLock = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "registry.json.lock");
  if (fs.existsSync(registryLock)) {
    const stale = new Date(Date.now() - 60_000);
    fs.utimesSync(registryLock, stale, stale);
  }

  assert.throws(
    () => recoverSharedContextTransactions(),
    (error) => error?.code === "shared-disconnect-recovery-required",
  );
  assert.deepEqual(fs.readFileSync(skillLink), replacementBefore);
  const [issue] = listSharedDisconnectRecoveryIssues();
  assert.equal(issue?.recoverySystem, "shared-disconnect");
  assert.match(issue?.message || "", /capability|changed/i);
  const acknowledged = abandonInvalidSharedDisconnectTransaction({
    quarantineId: issue.quarantineId,
    expectedRevision: issue.revision,
  });
  assert.equal(acknowledged.abandoned, true);
  assert.deepEqual(listSharedDisconnectRecoveryIssues(), []);
});

test("disconnect then reconnect at the same revision restores Shared Skills and Instructions", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Shared reconnect instructions\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team", title: "Team instructions", path: "instructions/team" }],
    assignments: [{
      id: "team-project",
      collectionId: "team",
      scope: "project",
      projectIds: ["demo"],
      files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
    }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add reconnect instruction fixture"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const first = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const skillLink = path.join(fixture.project, ".agents", "skills", "demo-workflow");
  const instructionLink = path.join(fixture.project, "AGENTS.md");
  const skillRegistry = fs.readdirSync(path.join(first.cacheRoot, "skill-links"))
    .map((name) => path.join(first.cacheRoot, "skill-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  const instructionRegistry = fs.readdirSync(path.join(first.cacheRoot, "instruction-links"))
    .filter((name) => name !== "device.json")
    .map((name) => path.join(first.cacheRoot, "instruction-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  const firstSkillLinks = JSON.parse(fs.readFileSync(skillRegistry, "utf8")).links.length;
  const firstInstructionLinks = JSON.parse(fs.readFileSync(instructionRegistry, "utf8")).links.length;
  assert.equal(fs.lstatSync(skillLink).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(instructionLink).isSymbolicLink(), true);
  assert.ok(firstSkillLinks > 0);
  assert.ok(firstInstructionLinks > 0);

  assert.equal(disconnectSharedContext(fixture.project).disconnected, true);
  assert.equal(fs.existsSync(skillLink), false);
  assert.equal(fs.existsSync(instructionLink), false);
  assert.equal(JSON.parse(fs.readFileSync(skillRegistry, "utf8")).revision, "");
  assert.equal(JSON.parse(fs.readFileSync(instructionRegistry, "utf8")).revision, "");

  const second = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  assert.equal(second.revision, first.revision);
  assert.equal(fs.lstatSync(skillLink).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(instructionLink).isSymbolicLink(), true);
  assert.equal(JSON.parse(fs.readFileSync(skillRegistry, "utf8")).links.length, firstSkillLinks);
  assert.equal(JSON.parse(fs.readFileSync(instructionRegistry, "utf8")).links.length, firstInstructionLinks);
});

test("primary edit creates, lists, and reopens an exact shared proposal worktree", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const env = { ...process.env };
  const description = "Clarify the complete onboarding sequence, ownership boundaries, failure handling, and verification steps in the accepted documentation.";

  let result = spawnSync(process.execPath, [cli, "edit", "create", description, `--root=${fixture.project}`, "--session=editing-session", "--contract=v2", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout).data;
  assert.equal(created.description, description);
  assert.match(created.proposal.branch, /^proposal\/demo\//);
  assert.equal(fs.existsSync(created.editRoot), true);

  const nestedProjectFolder = path.join(fixture.project, "docs", "work");
  fs.mkdirSync(nestedProjectFolder, { recursive: true });
  result = spawnSync(process.execPath, [cli, "edit", "list", "--contract=v2", "--format=json"], { cwd: nestedProjectFolder, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const listed = JSON.parse(result.stdout).data;
  assert.equal(listed.proposals.length, 1);
  assert.equal(listed.proposals[0].branch, created.proposal.branch);
  assert.equal(listed.proposals[0].description, description);

  result = spawnSync(process.execPath, [cli, "edit", "open", created.proposal.branch, "--contract=v2", "--format=json"], { cwd: fixture.base, encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const reopened = JSON.parse(result.stdout).data;
  assert.equal(reopened.proposal.branch, created.proposal.branch);
  assert.equal(reopened.editRoot, created.editRoot);
  assert.equal(reopened.proposal.reused, true);

  result = spawnSync(process.execPath, [cli, "edit", "create", "Document a separate onboarding change with its own complete scope and verification steps.", `--root=${fixture.project}`, "--session=editing-session", "--contract=v2", "--format=json"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const second = JSON.parse(result.stdout).data;
  assert.notEqual(second.proposal.branch, created.proposal.branch);
});

test("concurrent proposal creation preserves every registry entry, worktree, and branch", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const outcomes = await runGatedProposalProcesses(fixture, [
    { action: "create", project: fixture.project, title: "Concurrent registry alpha" },
    { action: "create", project: fixture.project, title: "Concurrent registry beta" },
  ]);
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  const proposals = outcomes.map((outcome) => outcome.result);
  assert.equal(new Set(proposals.map((proposal) => proposal.branch)).size, 2);

  const registryFile = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .map((name) => path.join(process.env.CONTEXT_ROOM_SHARED_HOME, name, "proposals.json"))
    .find((candidate) => fs.existsSync(candidate));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  assert.deepEqual(new Set(Object.keys(registry.proposals)), new Set(proposals.map((proposal) => proposal.branch)));
  const checkout = path.join(path.dirname(registryFile), "repository");
  const registeredWorktrees = new Set(git(checkout, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => fs.realpathSync(line.slice("worktree ".length))));
  for (const proposal of proposals) {
    assert.equal(fs.existsSync(proposal.root), true);
    assert.equal(registeredWorktrees.has(fs.realpathSync(proposal.root)), true);
    assert.notEqual(git(checkout, ["branch", "--list", proposal.branch]), "");
  }
});

test("same-title proposals created in the same second receive distinct safe branch identities", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const fixedNow = "2026-08-08T12:34:56.000Z";

  const outcomes = await runGatedProposalProcesses(fixture, [
    { action: "create", project: fixture.project, title: "Same title", fixedNow },
    { action: "create", project: fixture.project, title: "Same title", fixedNow },
  ]);
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  const branches = outcomes.map((outcome) => outcome.result.branch);
  assert.equal(new Set(branches).size, 2);
  for (const branch of branches) {
    assert.match(branch, /^proposal\/demo\/20260808123456-same-title-[a-f0-9]{32}(?:-\d+)?$/);
  }
});

test("concurrent proposal publication preserves both registry and observation updates", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const first = createSharedProposal(fixture.project, { title: "Publish registry alpha" });
  const second = createSharedProposal(fixture.project, { title: "Publish registry beta" });
  configureGit(first.root);
  configureGit(second.root);
  writeFile(first.root, "projects/demo/docs/concurrent-alpha.md", "# Concurrent alpha\n");
  writeFile(second.root, "projects/demo/docs/concurrent-beta.md", "# Concurrent beta\n");

  const outcomes = await runGatedProposalProcesses(fixture, [
    { action: "publish", project: fixture.project, branch: first.branch },
    { action: "publish", project: fixture.project, branch: second.branch },
  ]);
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  const publishedByBranch = new Map(outcomes.map((outcome) => [outcome.result.branch, outcome.result]));
  const registryFile = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .map((name) => path.join(process.env.CONTEXT_ROOM_SHARED_HOME, name, "proposals.json"))
    .find((candidate) => fs.existsSync(candidate));
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  const observations = JSON.parse(fs.readFileSync(path.join(path.dirname(registryFile), "proposal-observations.json"), "utf8"));
  for (const proposal of [first, second]) {
    const published = publishedByBranch.get(proposal.branch);
    assert.ok(published);
    assert.equal(registry.proposals[proposal.branch].lastPublishedHead, published.head);
    assert.equal(observations.proposals[proposal.branch].head, published.head);
    assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0], published.head);
  }
});

test("same-title same-second proposals remain unique across independent Shared homes", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const secondProject = path.join(fixture.base, "second-project");
  fs.mkdirSync(secondProject, { recursive: true });
  initializeContextRoomProject(secondProject, { title: "Demo 2", allowedPaths: ["README.md"], watchAllow: [] });
  const firstHome = path.join(fixture.base, "machine-a", "home");
  const secondHome = path.join(fixture.base, "machine-b", "home");
  fs.mkdirSync(firstHome, { recursive: true });
  fs.mkdirSync(secondHome, { recursive: true });
  const firstSharedHome = path.join(firstHome, ".context-room", "shared");
  const secondSharedHome = path.join(secondHome, ".context-room", "shared");
  const fixedNow = "2026-08-08T20:15:30.000Z";

  const outcomes = await runGatedProposalProcesses(fixture, [
    {
      action: "create-publish",
      connect: true,
      project: fixture.project,
      repository: fixture.remote,
      title: "Cross device title",
      file: "projects/demo/docs/machine-a.md",
      content: "# Machine A\n",
      fixedNow,
      home: firstHome,
      sharedHome: firstSharedHome,
    },
    {
      action: "create-publish",
      connect: true,
      project: secondProject,
      repository: fixture.remote,
      title: "Cross device title",
      file: "projects/demo/docs/machine-b.md",
      content: "# Machine B\n",
      fixedNow,
      home: secondHome,
      sharedHome: secondSharedHome,
    },
  ]);
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  const branches = outcomes.map((outcome) => outcome.result.proposal.branch);
  assert.equal(new Set(branches).size, 2);
  for (const [index, branch] of branches.entries()) {
    assert.match(branch, /^proposal\/demo\/20260808201530-cross-device-title-[a-f0-9]{32}(?:-\d+)?$/);
    assert.equal(
      git(fixture.seed, ["ls-remote", "--heads", "origin", branch]).split(/\s+/)[0],
      outcomes[index].result.published.head,
    );
  }
});

test("shared main primitives follow the configured remote branch and ignore proposal-only commits", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-shared-trunk-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  git(base, ["init", "--bare", "--initial-branch=trunk", remote], { stdio: "ignore" });
  git(base, ["clone", remote, seed], { stdio: "ignore" });
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Trunk shared context", defaultBranch: "trunk" });
  writeFile(seed, "projects.json", JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Accepted one\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize trunk"]);
  git(seed, ["push", "origin", "trunk"]);
  const first = git(seed, ["rev-parse", "HEAD"]);
  withSharedHome(t, { base });

  git(seed, ["switch", "-c", "proposal/demo/not-effective"]);
  writeFile(seed, "projects/demo/docs/README.md", "# Proposal only\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Proposal only"]);
  git(seed, ["push", "origin", "proposal/demo/not-effective"]);
  assert.equal(readSharedMainRevision(remote, { refresh: true }).revision, first);

  git(seed, ["switch", "trunk"]);
  writeFile(seed, "projects/demo/docs/README.md", "# Accepted two\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Direct human update"]);
  git(seed, ["push", "origin", "trunk"]);
  const second = git(seed, ["rev-parse", "HEAD"]);
  const main = readSharedMainRevision(remote, { refresh: true });
  const diff = diffSharedMainRevisions(remote, { fromRevision: first, toRevision: second, projectId: "demo" });
  assert.equal(main.defaultBranch, "trunk");
  assert.equal(main.revision, second);
  assert.equal(diff.commitCount, 1);
  assert.deepEqual(diff.applicablePaths, ["projects/demo/docs/README.md"]);
  assert.equal(diff.transitions[0].acceptance, null);
  assert.throws(
    () => diffSharedMainRevisions(remote, { fromRevision: second, toRevision: first }),
    (error) => error.code === "shared-history-diverged",
  );
});

test("shared main trailers remain historical evidence without authorizing completion on another device", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const proposalHead = "a".repeat(40);
  writeFile(fixture.seed, "projects/demo/docs/README.md", "# Accepted elsewhere\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", `Accept elsewhere\n\nContext-Room-Proposal: proposal/demo/elsewhere\nContext-Room-Proposal-Head: ${proposalHead}\nContext-Room-Project: demo`]);
  git(fixture.seed, ["push", "origin", "main"]);
  const accepted = listSharedMainAcceptances(fixture.remote, { refresh: true });
  const historical = accepted.find((item) => item.proposal === "proposal/demo/elsewhere" && item.proposalHead === proposalHead);
  assert.ok(historical, "trailer evidence remains inspectable for historical reconciliation");
  assert.equal(historical.merged, false, "trailers alone must not authorize a merged classification");
});

test("shared main acceptance indexing scans first-parent trailers once without per-commit diff work", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const proposal = "proposal/demo/trailer-index";
  const olderHead = "a".repeat(40);
  const latestHead = "b".repeat(40);
  git(fixture.seed, [
    "commit",
    "--allow-empty",
    "-m",
    `Older candidate\n\nContext-Room-Proposal: ${proposal}\nContext-Room-Proposal-Head: ${olderHead}\nContext-Room-Project: demo\nContext-Room-Session: older-session`,
  ]);
  git(fixture.seed, [
    "commit",
    "--allow-empty",
    "-m",
    "Ignore incomplete acceptance\n\nContext-Room-Proposal: proposal/demo/incomplete",
  ]);
  git(fixture.seed, [
    "commit",
    "--allow-empty",
    "-m",
    `Ignore invalid acceptance metadata\n\nContext-Room-Proposal: proposal/demo/invalid-project\nContext-Room-Proposal-Head: ${"c".repeat(40)}\nContext-Room-Project: invalid_project`,
  ]);
  git(fixture.seed, [
    "commit",
    "--allow-empty",
    "-m",
    `Latest candidate\n\nContext-Room-Proposal: ${proposal}\nContext-Room-Proposal-Head: ${latestHead}\nContext-Room-Project: demo\nContext-Room-Session: latest-session`,
  ]);
  git(fixture.seed, ["push", "origin", "main"]);
  readSharedMainRevision(fixture.remote, { refresh: true });

  const traced = traceGitCommands(t, fixture);
  const acceptances = listSharedMainAcceptances(fixture.remote, { refresh: false });
  traced.restore();

  const indexed = acceptances.find((item) => item.proposal === proposal);
  assert.ok(indexed);
  assert.equal(indexed.proposalHead, latestHead, "newest first-parent candidate remains the branch-level result");
  assert.equal(indexed.sessionId, "latest-session");
  assert.equal(acceptances.some((item) => item.proposal === "proposal/demo/incomplete"), false);
  assert.equal(acceptances.some((item) => item.proposal === "proposal/demo/invalid-project"), false);

  const commands = traced.read();
  const trailerHistoryScans = commands.filter((args) => (
    args[0] === "log"
    && args.includes("--first-parent")
    && args.some((arg) => arg.includes("%(trailers:only)"))
  ));
  const legacyHistoryScans = commands.filter((args) => args[0] === "rev-list" && args.includes("--first-parent"));
  const perCommitDiffs = commands.filter((args) => args[0] === "diff" && args[1] === "--name-only" && args[2] === "-z");
  const perCommitMetadata = commands.filter((args) => (
    args[0] === "show"
    && args[1] === "-s"
    && args.some((arg) => arg.startsWith("--format=%cI%x00%an%x00%ae%x00%s"))
  ));
  assert.equal(trailerHistoryScans.length, 1, "candidate history is read by one trailer-only first-parent scan");
  assert.equal(legacyHistoryScans.length, 0, "candidate indexing no longer enumerates commits for individual inspection");
  assert.equal(perCommitDiffs.length, 1, "only the current main snapshot is diffed; history candidates are not");
  assert.equal(perCommitMetadata.length, 1, "only the current main snapshot is materialized; history candidates are not");
});

test("integrated proposal content stays out of the queue even when matching main trailers include an unreviewed extra change", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Keep tainted main evidence visible",
    branch: "proposal/demo/keep-tainted-main-evidence-visible",
  });
  configureGit(proposal.root);
  const reviewedContent = "# Demo\n\nOnly this proposal change may be accepted.\n";
  writeFile(proposal.root, "projects/demo/docs/README.md", reviewedContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  materializeSharedReview(fixture.project, { proposal: proposal.branch });

  writeFile(fixture.seed, "projects/demo/docs/README.md", reviewedContent);
  writeFile(fixture.seed, "projects/demo/docs/UNREVIEWED-EXTRA.md", "# Never reviewed\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, [
    "commit",
    "-m",
    `Tainted main acceptance\n\nContext-Room-Proposal: ${proposal.branch}\nContext-Room-Proposal-Head: ${published.head}\nContext-Room-Project: demo`,
  ]);
  git(fixture.seed, ["push", "origin", "main"]);

  assert.equal(listSharedProposals(fixture.project).some((item) => item.branch === proposal.branch), false);

  const hub = contextHubUiState(fixture.project, { refreshShared: true, force: true });
  assert.equal(
    hub.proposals.some((item) => item.branch === proposal.branch),
    false,
    "the Hub queue follows integrated content while exact terminal actions still validate authority separately",
  );
});

test("a delivery receipt cannot mark a proposal merged when its commit is not on remote main", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Unverified delivery receipt",
    branch: "proposal/demo/unverified-delivery-receipt",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nNot on main.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  fs.writeFileSync(authorityPath, JSON.stringify({
    ...authority,
    acceptedAt: "2026-08-07T08:00:00.000Z",
    accepted: {
      accepted: true,
      delivery: "main",
      deliveryVerified: true,
      proposal: proposal.branch,
      proposalHead: published.head,
      previousMain: review.metadata.baseRevision,
      commit: published.head,
      defaultBranch: "main",
      actor: null,
    },
  }, null, 2) + "\n", "utf8");

  const listed = listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch);
  assert.equal(listed.reviewStatus, "accepted");
  assert.equal(listed.reviewActivity.accepted.merged, false);
  git(fixture.seed, ["fetch", "origin", proposal.branch]);
  assert.equal(
    spawnSync("git", ["merge-base", "--is-ancestor", published.head, "origin/main"], { cwd: fixture.seed }).status,
    1,
  );
  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    (error) => error?.code === "shared-delivery-unverified",
  );
});

test("a delivery receipt cannot mark a proposal merged when the main commit lacks the exact proposal trailers", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Mismatched delivery receipt",
    branch: "proposal/demo/mismatched-delivery-receipt",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nProposed but not accepted.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  const remoteMain = readSharedMainRevision(fixture.remote, { refresh: true }).revision;
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  fs.writeFileSync(authorityPath, JSON.stringify({
    ...authority,
    acceptedAt: "2026-08-07T08:00:00.000Z",
    accepted: {
      accepted: true,
      delivery: "main",
      deliveryVerified: true,
      proposal: proposal.branch,
      proposalHead: published.head,
      previousMain: review.metadata.baseRevision,
      commit: remoteMain,
      verifiedRemoteHead: remoteMain,
      defaultBranch: "main",
      actor: null,
    },
  }, null, 2) + "\n", "utf8");

  assert.doesNotMatch(git(fixture.seed, ["show", "-s", "--format=%B", remoteMain]), /Context-Room-Proposal:/);
  const listed = listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch);
  assert.equal(listed.reviewStatus, "accepted");
  assert.equal(listed.reviewActivity.accepted.merged, false);
  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    (error) => error?.code === "shared-acceptance-receipt-invalid",
  );
});

test("shared acceptance reconciles an exact pushed commit after verification failed before the receipt", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const repository = "https://github.com/context-room-tests/recover-accepted-delivery.git";
  const gitConfig = path.join(fixture.base, "recover-accepted-delivery.gitconfig");
  const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  const rewriteRepositoryTo = (remote) => {
    fs.writeFileSync(gitConfig, `[url "${remote}"]\n\tinsteadOf = ${repository}\n`, "utf8");
  };
  rewriteRepositoryTo(fixture.remote);
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  t.after(() => {
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
  });
  const ephemeralRemote = path.join(fixture.base, "ephemeral-remote.git");
  fs.symlinkSync(fixture.remote, ephemeralRemote, "dir");
  connectSharedContext(fixture.project, { repository, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Recover accepted delivery",
    branch: "proposal/demo/recover-accepted-delivery",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted despite a transient verification outage.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact proposal file reviewed",
  });

  const postReceive = path.join(fixture.remote, "hooks", "post-receive");
  fs.writeFileSync(postReceive, `#!/bin/sh\nrm -f ${JSON.stringify(ephemeralRemote)}\n`, "utf8");
  fs.chmodSync(postReceive, 0o755);
  rewriteRepositoryTo(ephemeralRemote);
  const push = {
    token: "test-installation-token",
    expiresAt: "2099-08-07T23:59:59Z",
    url: repository,
  };

  assert.throws(
    () => acceptSharedReview(review.reviewRoot, { message: "Accept recoverable delivery", push }),
    (error) => error?.code === "shared-delivery-unverified",
  );
  assert.equal(fs.existsSync(ephemeralRemote), false);
  const pushedHead = git(fixture.remote, ["rev-parse", "refs/heads/main"]);
  assert.equal(git(fixture.remote, ["rev-list", "--count", `${review.metadata.baseRevision}..${pushedHead}`]), "1");
  const pushedMessage = git(fixture.remote, ["show", "-s", "--format=%B", pushedHead]);
  assert.match(pushedMessage, new RegExp(`^Context-Room-Proposal: ${proposal.branch}$`, "m"));
  assert.match(pushedMessage, new RegExp(`^Context-Room-Proposal-Head: ${published.head}$`, "m"));
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  assert.equal(Boolean(JSON.parse(fs.readFileSync(authorityPath, "utf8")).accepted), false);

  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]), "");
  fs.symlinkSync(fixture.remote, ephemeralRemote, "dir");
  const reconciled = acceptSharedReview(review.reviewRoot, { message: "Accept recoverable delivery", push });
  assert.equal(reconciled.accepted, true);
  assert.equal(reconciled.deliveryVerified, true);
  assert.equal(reconciled.commit, pushedHead);
  assert.equal(reconciled.verifiedRemoteHead, pushedHead);
  assert.equal(fs.existsSync(ephemeralRemote), true, "retry must not push a second commit");
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), pushedHead);
  assert.equal(git(fixture.remote, ["rev-list", "--count", `${review.metadata.baseRevision}..refs/heads/main`]), "1");
});

test("shared acceptance never reconciles matching trailers when the commit contains an unreviewed extra change", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject tainted acceptance recovery",
    branch: "proposal/demo/reject-tainted-acceptance-recovery",
  });
  configureGit(proposal.root);
  const reviewedContent = "# Demo\n\nOnly this reviewed change may be accepted.\n";
  writeFile(proposal.root, "projects/demo/docs/README.md", reviewedContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed exact proposal file",
  });

  writeFile(fixture.seed, "projects/demo/docs/README.md", reviewedContent);
  writeFile(fixture.seed, "projects/demo/docs/UNREVIEWED-EXTRA.md", "# This file was never reviewed\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, [
    "commit",
    "-m",
    `Tainted acceptance recovery\n\nContext-Room-Proposal: ${proposal.branch}\nContext-Room-Proposal-Head: ${published.head}\nContext-Room-Project: demo`,
  ]);
  git(fixture.seed, ["push", "origin", "main"]);
  const taintedCommit = git(fixture.seed, ["rev-parse", "HEAD"]);
  assert.match(
    git(fixture.seed, ["diff-tree", "--no-commit-id", "--name-only", "-r", taintedCommit]),
    /^projects\/demo\/docs\/UNREVIEWED-EXTRA\.md$/m,
  );

  let recovered;
  try {
    recovered = acceptSharedReview(review.reviewRoot, { message: "Do not reconcile tainted delivery" });
  } catch {
    // Failing closed is also valid: the invariant is that this commit is never accepted.
  }
  assert.equal(
    recovered?.commit === taintedCommit,
    false,
    "matching proposal trailers must not reconcile a commit whose tree differs from the exact reviewed result",
  );
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  assert.notEqual(
    authority.accepted?.commit,
    taintedCommit,
    "the tainted commit must not be persisted as the accepted proposal receipt",
  );
});

test("an integrated proposal stays out of the queue while a tainted delivery receipt remains invalid", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject tainted acceptance receipt",
    branch: "proposal/demo/reject-tainted-acceptance-receipt",
  });
  configureGit(proposal.root);
  const reviewedContent = "# Demo\n\nOnly this reviewed change may be accepted.\n";
  writeFile(proposal.root, "projects/demo/docs/README.md", reviewedContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed exact proposal file",
  });

  writeFile(fixture.seed, "projects/demo/docs/README.md", reviewedContent);
  writeFile(fixture.seed, "projects/demo/docs/UNREVIEWED-EXTRA.md", "# This file was never reviewed\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, [
    "commit",
    "-m",
    `Tainted acceptance receipt\n\nContext-Room-Proposal: ${proposal.branch}\nContext-Room-Proposal-Head: ${published.head}\nContext-Room-Project: demo`,
  ]);
  git(fixture.seed, ["push", "origin", "main"]);
  const taintedCommit = git(fixture.seed, ["rev-parse", "HEAD"]);
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  fs.writeFileSync(authorityPath, JSON.stringify({
    ...authority,
    acceptedAt: "2026-08-07T08:00:00.000Z",
    accepted: {
      accepted: true,
      delivery: "main",
      deliveryVerified: true,
      proposal: proposal.branch,
      proposalHead: published.head,
      previousMain: review.metadata.baseRevision,
      commit: taintedCommit,
      verifiedRemoteHead: taintedCommit,
      defaultBranch: "main",
      actor: null,
    },
  }, null, 2) + "\n", "utf8");

  assert.equal(listSharedProposals(fixture.project).some((item) => item.branch === proposal.branch), false);
  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    (error) => error?.code === "shared-acceptance-receipt-invalid",
  );
});

test("shared acceptance rejects an executable-bit change made after the file decision", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject mode tampering after review",
    branch: "proposal/demo/reject-mode-tampering",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nReviewed content with a stable mode.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  const reviewedPath = path.join(review.reviewRoot, "projects/demo/docs/README.md");
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed before executable-bit tampering",
  });
  const signedReviewState = JSON.parse(fs.readFileSync(path.join(review.reviewRoot, ".context-room", "review-state.json"), "utf8"));
  assert.equal(signedReviewState.reviews["projects/demo/docs/README.md"].resourceMode, "100644");
  assert.equal(inspectOwnerTrustedState(review.reviewRoot, "review-state", signedReviewState).trusted, true);

  fs.chmodSync(reviewedPath, 0o755);
  assert.match(git(review.reviewRoot, ["diff", "--summary"]), /mode change 100644 => 100755/);
  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    /mode|review evidence|stale/i,
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), review.metadata.baseRevision);
});

test("legacy review evidence remains valid when content identifies one unambiguous Git mode", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Accept safe legacy review mode",
    branch: "proposal/demo/accept-safe-legacy-mode",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nLegacy content uniquely identifies its reviewed mode.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Legacy decision with an unambiguous mode",
  });
  rewriteAsLegacyReviewWithoutResourceMode(review.reviewRoot, "projects/demo/docs/README.md");

  const accepted = acceptSharedReview(review.reviewRoot);
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.deliveryVerified, true);
});

test("legacy review evidence refuses an ambiguous mode-only proposal", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject ambiguous legacy mode",
    branch: "proposal/demo/reject-ambiguous-legacy-mode",
  });
  configureGit(proposal.root);
  fs.chmodSync(path.join(proposal.root, "projects/demo/docs/README.md"), 0o755);
  assert.match(git(proposal.root, ["diff", "--summary"]), /mode change 100644 => 100755/);
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Legacy mode-only decision",
  });
  rewriteAsLegacyReviewWithoutResourceMode(review.reviewRoot, "projects/demo/docs/README.md");

  const report = buildDocQaReport(review.reviewRoot);
  assert.equal(report.pendingPaths.includes("projects/demo/docs/README.md"), true, JSON.stringify({ pendingPaths: report.pendingPaths, reviewedPaths: report.reviewedPaths, queue: report.queue }));
  assert.equal(report.reviewedPaths.includes("projects/demo/docs/README.md"), false, JSON.stringify({ pendingPaths: report.pendingPaths, reviewedPaths: report.reviewedPaths, queue: report.queue }));

  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    /mode|review evidence|stale/i,
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), review.metadata.baseRevision);
});

test("shared acceptance never reconciles a dangling symlink as a reviewed deletion", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject dangling symlink recovery",
    branch: "proposal/demo/reject-dangling-symlink-recovery",
  });
  configureGit(proposal.root);
  fs.unlinkSync(path.join(proposal.root, "projects/demo/docs/README.md"));
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed exact deletion",
  });
  const reviewedPath = path.join(review.reviewRoot, "projects/demo/docs/README.md");
  fs.mkdirSync(path.dirname(reviewedPath), { recursive: true });
  fs.symlinkSync("missing-target.md", reviewedPath);

  fs.unlinkSync(path.join(fixture.seed, "projects/demo/docs/README.md"));
  fs.symlinkSync("missing-target.md", path.join(fixture.seed, "projects/demo/docs/README.md"));
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, [
    "commit",
    "-m",
    `Tainted dangling symlink recovery\n\nContext-Room-Proposal: ${proposal.branch}\nContext-Room-Proposal-Head: ${published.head}\nContext-Room-Project: demo`,
  ]);
  git(fixture.seed, ["push", "origin", "main"]);
  const taintedCommit = git(fixture.seed, ["rev-parse", "HEAD"]);

  let recovered;
  try {
    recovered = acceptSharedReview(review.reviewRoot);
  } catch {
    // Failing closed is valid; accepting the symlink is not.
  }
  assert.equal(recovered?.commit === taintedCommit, false);
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const authority = JSON.parse(fs.readFileSync(authorityPath, "utf8"));
  assert.notEqual(authority.accepted?.commit, taintedCommit);
});

test("shared acceptance persists its post-push receipt through an atomic replacement", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Persist acceptance atomically",
    branch: "proposal/demo/persist-acceptance-atomically",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nPersist this accepted result atomically.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact result reviewed",
  });
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const originalRenameSync = fs.renameSync;
  let atomicReplacementObserved = false;
  fs.renameSync = (source, destination) => {
    if (path.resolve(destination) === path.resolve(authorityPath) && String(source).startsWith(`${authorityPath}.`)) {
      atomicReplacementObserved = true;
    }
    return originalRenameSync(source, destination);
  };
  let accepted;
  try {
    accepted = acceptSharedReview(review.reviewRoot);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(accepted.accepted, true);
  assert.equal(atomicReplacementObserved, true, "the durable receipt must replace the authority file atomically");
  assert.equal(JSON.parse(fs.readFileSync(authorityPath, "utf8")).accepted.commit, accepted.commit);
});

test("shared acceptance refuses a post-commit hook descendant outside the exact reviewed tree", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject post-commit tree injection",
    branch: "proposal/demo/reject-post-commit-tree-injection",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nOnly this reviewed tree may be accepted.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact tree reviewed",
  });

  const checkout = sharedReviewRepositoryCheckout(review);
  const hooks = path.join(checkout, ".git", "hooks");
  const hook = path.join(hooks, "post-commit");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh
guard="$(git rev-parse --git-path context-room-taint-once)"
if [ -f "$guard" ]; then exit 0; fi
: > "$guard"
mkdir -p projects/demo/docs
printf '# Unreviewed hook child\\n' > projects/demo/docs/UNREVIEWED-HOOK.md
git add projects/demo/docs/UNREVIEWED-HOOK.md
git -c user.name='Hook' -c user.email='hook@example.test' commit --no-verify -m 'Unreviewed hook child'
`, "utf8");
  fs.chmodSync(hook, 0o755);

  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    /exact reviewed result|reviewed tree/i,
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), review.metadata.baseRevision);
});

test("shared acceptance refuses a pre-commit hook file injected into the terminal commit", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject pre-commit tree injection",
    branch: "proposal/demo/reject-pre-commit-tree-injection",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nOnly the reviewed file belongs in the terminal commit.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact terminal tree reviewed",
  });

  const checkout = sharedReviewRepositoryCheckout(review);
  const hooks = path.join(checkout, ".git", "hooks");
  const hook = path.join(hooks, "pre-commit");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh
guard="$(git rev-parse --git-path context-room-precommit-taint-once)"
if [ -f "$guard" ]; then exit 0; fi
: > "$guard"
mkdir -p projects/demo/docs
printf '# Unreviewed pre-commit injection\\n' > projects/demo/docs/UNREVIEWED-PRECOMMIT.md
git add projects/demo/docs/UNREVIEWED-PRECOMMIT.md
`, "utf8");
  fs.chmodSync(hook, 0o755);

  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    (error) => error?.code === "shared-acceptance-tree-mismatch",
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), review.metadata.baseRevision);
});

test("an active acceptance lease fails fast with a retryable busy response", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Fail fast under active acceptance lease",
    branch: "proposal/demo/fail-fast-active-lease",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nWait for the active owner.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", { status: "verified", note: "Reviewed" });

  const lock = sharedAcceptanceLockPath(review);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: 42,
    host: "another-live-qm-instance",
    token: "foreign-owner",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    proposal: review.metadata.proposal,
    proposalHead: review.metadata.proposalHead,
  }, null, 2) + "\n", "utf8");
  t.after(() => fs.rmSync(lock, { recursive: true, force: true }));

  const startedAt = Date.now();
  const child = sharedAcceptanceChild(review.reviewRoot, { timeout: 1_000 });
  const elapsed = Date.now() - startedAt;
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const response = JSON.parse(child.stdout.trim());
  assert.equal(response.error?.code, "shared-terminal-decision-busy");
  assert.equal(response.error?.retryable, true);
  assert.ok(elapsed < 750, `busy response should be fail-fast, took ${elapsed} ms`);

  fs.rmSync(lock, { recursive: true, force: true });
  const livePid = process.pid;
  const liveProcessIdentity = filesystemProcessIdentity(livePid);
  assert.notEqual(liveProcessIdentity, "", "the test platform must expose the current process generation");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: livePid,
    host: os.hostname(),
    token: "live-process-generation",
    processIdentity: liveProcessIdentity,
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    proposal: review.metadata.proposal,
    proposalHead: review.metadata.proposalHead,
  }, null, 2) + "\n", "utf8");
  const liveGeneration = sharedAcceptanceChild(review.reviewRoot, { timeout: 1_000 });
  assert.equal(liveGeneration.status, 0, liveGeneration.stderr || liveGeneration.error?.message);
  const liveGenerationResponse = JSON.parse(liveGeneration.stdout.trim());
  assert.equal(liveGenerationResponse.error?.code, "shared-terminal-decision-busy");
  assert.equal(fs.existsSync(lock), true, "an expired lease from the same live process generation stays exclusive");
});

test("a stale acceptance lease from a retired host is reclaimed", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Recover retired instance lease",
    branch: "proposal/demo/recover-retired-instance-lease",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nRecover this stale lease.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", { status: "verified", note: "Reviewed" });

  const lock = sharedAcceptanceLockPath(review);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: 42,
    host: "retired-qm-instance",
    token: "stale-owner",
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    proposal: review.metadata.proposal,
    proposalHead: review.metadata.proposalHead,
  }, null, 2) + "\n", "utf8");

  const child = sharedAcceptanceChild(review.reviewRoot, { timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  const response = JSON.parse(child.stdout.trim());
  assert.equal(response.result?.accepted, true, response.error?.message);
  assert.equal(response.result?.deliveryVerified, true);
  assert.equal(fs.existsSync(lock), false);
});

test("a stale ownerless or malformed acceptance lease is reclaimed", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Recover incomplete acceptance lease",
    branch: "proposal/demo/recover-incomplete-acceptance-lease",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nRecover incomplete lock ownership.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", { status: "verified", note: "Reviewed" });

  const lock = sharedAcceptanceLockPath(review);
  const staleTime = new Date(Date.now() - 30 * 60_000);
  fs.mkdirSync(lock, { recursive: true });
  fs.utimesSync(lock, staleTime, staleTime);
  let child = sharedAcceptanceChild(review.reviewRoot, { timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  let response = JSON.parse(child.stdout.trim());
  assert.equal(response.result?.accepted, true, response.error?.message);
  assert.equal(fs.existsSync(lock), false);

  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: 1,
    host: os.hostname(),
    token: "expired-legacy-pid-one",
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    proposal: review.metadata.proposal,
    proposalHead: review.metadata.proposalHead,
  }, null, 2) + "\n", "utf8");
  child = sharedAcceptanceChild(review.reviewRoot, { timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  response = JSON.parse(child.stdout.trim());
  assert.equal(response.result?.accepted, true, response.error?.message);
  assert.equal(fs.existsSync(lock), false, "an expired legacy PID 1 lease must not block forever");

  const reusedPid = process.pid;
  const reusedProcessIdentity = filesystemProcessIdentity(reusedPid);
  assert.notEqual(reusedProcessIdentity, "", "the test platform must expose the current process generation");
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: reusedPid,
    host: os.hostname(),
    token: "reused-process-generation",
    processIdentity: `${reusedProcessIdentity}:retired`,
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    proposal: review.metadata.proposal,
    proposalHead: review.metadata.proposalHead,
  }, null, 2) + "\n", "utf8");
  child = sharedAcceptanceChild(review.reviewRoot, { timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  response = JSON.parse(child.stdout.trim());
  assert.equal(response.result?.accepted, true, response.error?.message);
  assert.equal(fs.existsSync(lock), false, "a reused PID generation must not inherit the previous owner's lease");

  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), "{not-json", "utf8");
  fs.utimesSync(lock, staleTime, staleTime);
  child = sharedAcceptanceChild(review.reviewRoot, { timeout: 5_000 });
  assert.equal(child.status, 0, child.stderr || child.error?.message);
  response = JSON.parse(child.stdout.trim());
  assert.equal(response.result?.accepted, true, response.error?.message);
  assert.equal(fs.existsSync(lock), false);
});

test("a rejected push recovers an exact competing acceptance from remote main", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Recover exact competing delivery",
    branch: "proposal/demo/recover-exact-competing-delivery",
  });
  configureGit(proposal.root);
  const reviewedContent = "# Demo\n\nAccept this result once across instances.\n";
  writeFile(proposal.root, "projects/demo/docs/README.md", reviewedContent);
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact competing result reviewed",
  });

  writeFile(fixture.seed, "projects/demo/docs/README.md", reviewedContent);
  git(fixture.seed, ["add", "projects/demo/docs/README.md"]);
  git(fixture.seed, ["commit", "-m", acceptedProposalCommitMessage(review.metadata, "Competing exact acceptance")]);
  const competingCommit = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", `${competingCommit}:refs/context-room-tests/competing-acceptance`]);
  git(fixture.seed, ["fetch", "origin", proposal.branch]);
  const proposalTree = git(fixture.seed, ["rev-parse", `${review.metadata.proposalHead}^{tree}`]);
  const competingState = git(fixture.seed, [
    "commit-tree",
    proposalTree,
    "-p",
    review.metadata.proposalHead,
    "-m",
    `Context Room terminal proposal decision: accepted\n\nContext-Room-Terminal-Decision: accepted\nContext-Room-Proposal: ${review.metadata.proposal}\nContext-Room-Proposal-Head: ${review.metadata.proposalHead}\nContext-Room-Accepted-Commit: ${competingCommit}`,
  ]);
  git(fixture.seed, ["push", "origin", `${competingState}:refs/context-room-tests/competing-state`]);
  const competingStateRef = `refs/heads/context-room-state/${createHash("sha256").update(review.metadata.proposal).digest("hex")}`;

  const checkout = sharedReviewRepositoryCheckout(review);
  const hooks = path.join(checkout, ".git", "hooks");
  const hook = path.join(hooks, "pre-push");
  const competingPushGuard = path.join(fixture.base, "context-room-competing-push-once");
  fs.mkdirSync(hooks, { recursive: true });
  fs.writeFileSync(hook, `#!/bin/sh
guard=${JSON.stringify(competingPushGuard)}
if [ -f "$guard" ]; then exit 0; fi
: > "$guard"
git --git-dir=${JSON.stringify(fixture.remote)} fetch ${JSON.stringify(fixture.seed)} ${competingCommit}
git --git-dir=${JSON.stringify(fixture.remote)} update-ref refs/heads/main ${competingCommit} ${review.metadata.baseRevision}
git --git-dir=${JSON.stringify(fixture.remote)} update-ref ${competingStateRef} ${competingState} ${review.metadata.proposalHead}
`, "utf8");
  fs.chmodSync(hook, 0o755);

  const accepted = acceptSharedReview(review.reviewRoot, { message: "Acceptance racing another instance" });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.deliveryVerified, true);
  assert.equal(accepted.commit, competingCommit);
  assert.equal(accepted.verifiedRemoteHead, competingCommit);
  assert.equal(git(fixture.remote, ["rev-list", "--count", `${review.metadata.baseRevision}..refs/heads/main`]), "1");
});

test("concurrent shared acceptance attempts serialize and recover the same delivered commit", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  withIsolatedEventJournal(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Serialize concurrent acceptance",
    branch: "proposal/demo/serialize-concurrent-acceptance",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccept exactly once under concurrency.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact concurrent result reviewed",
  });
  const contentionStarted = path.join(fixture.base, "acceptance-contention-started");
  const releaseContention = path.join(fixture.base, "release-acceptance-contention");
  t.after(() => fs.writeFileSync(releaseContention, "release\n", "utf8"));
  const postReceive = path.join(fixture.remote, "hooks", "post-receive");
  fs.writeFileSync(postReceive, `#!/bin/sh
: > ${JSON.stringify(contentionStarted)}
while [ ! -f ${JSON.stringify(releaseContention)} ]; do sleep 0.05; done
`, "utf8");
  fs.chmodSync(postReceive, 0o755);

  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const source = `
    import { acceptSharedReview } from ${JSON.stringify(moduleUrl)};
    try {
      const actor = process.argv[2];
      const result = acceptSharedReview(process.argv[1], {
        message: "Accept concurrent delivery",
        actor: { sub: actor, email: actor + "@example.test" },
      });
      process.stdout.write(JSON.stringify(result) + "\\n");
    } catch (error) {
      process.stderr.write(JSON.stringify({ code: error.code || "", message: error.message }) + "\\n");
      process.exitCode = 1;
    }
  `;
  const runAttempt = (actor) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, review.reviewRoot, actor], {
      cwd: fixture.project,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });

  const firstAttemptPromise = runAttempt("reviewer-alpha");
  const contentionDeadline = Date.now() + 5_000;
  while (!fs.existsSync(contentionStarted) && Date.now() < contentionDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(fs.existsSync(contentionStarted), true, "the first acceptance must hold its lease before the contender starts");
  const busyAttempt = await runAttempt("reviewer-beta");
  assert.equal(busyAttempt.code, 1, busyAttempt.stderr);
  assert.equal(JSON.parse(busyAttempt.stderr.trim()).code, "shared-terminal-decision-busy");
  fs.writeFileSync(releaseContention, "release\n", "utf8");
  const successfulAttempt = await firstAttemptPromise;
  assert.equal(successfulAttempt.code, 0, successfulAttempt.stderr);
  const delivered = JSON.parse(successfulAttempt.stdout.trim());
  assert.equal(delivered.accepted, true);
  const retried = acceptSharedReview(review.reviewRoot, {
    message: "Retry concurrent delivery",
    actor: { sub: "reviewer-retry", email: "reviewer-retry@example.test" },
  });
  assert.equal(retried.accepted, true);
  assert.equal(retried.commit, delivered.commit, "a busy caller retry must recover the one delivered commit");
  assert.equal(git(fixture.remote, ["rev-list", "--count", `${review.metadata.baseRevision}..refs/heads/main`]), "1");
});

test("shared acceptance retry after a lost browser response revalidates the delivered receipt without another commit or push", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  withIsolatedEventJournal(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Retry accepted delivery",
    branch: "proposal/demo/retry-accepted-delivery",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted before the browser lost its response.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact proposal file reviewed",
  });

  const pushLog = path.join(fixture.base, "accepted-pushes.log");
  const postReceive = path.join(fixture.remote, "hooks", "post-receive");
  fs.writeFileSync(postReceive, `#!/bin/sh\nprintf 'push\\n' >> ${JSON.stringify(pushLog)}\n`, "utf8");
  fs.chmodSync(postReceive, 0o755);

  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept retryable delivery" });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.deliveryVerified, true);
  assert.equal(accepted.proposalHead, published.head);
  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const receipt = JSON.parse(fs.readFileSync(authorityPath, "utf8")).accepted;
  assert.equal(receipt.commit, accepted.commit, "the successful acceptance must be durable before the response is lost");
  assert.equal(fs.readFileSync(pushLog, "utf8"), "push\n");
  const authorityAfterAcceptance = fs.readFileSync(authorityPath, "utf8");
  const journalAfterAcceptance = fs.readFileSync(contextRoomEventJournalPath(), "utf8");

  const retry = acceptSharedReview(review.reviewRoot, { message: "Accept retryable delivery" });
  assert.equal(retry.accepted, true);
  assert.equal(retry.deliveryVerified, true);
  assert.equal(retry.commit, accepted.commit);
  assert.equal(retry.verifiedRemoteHead, accepted.verifiedRemoteHead);
  assert.equal(retry.defaultBranch, accepted.defaultBranch);
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), accepted.verifiedRemoteHead);
  assert.equal(git(fixture.remote, ["rev-list", "--count", `${review.metadata.baseRevision}..refs/heads/main`]), "1");
  assert.equal(fs.readFileSync(pushLog, "utf8"), "push\n", "retry must not push again");
  assert.equal(fs.readFileSync(authorityPath, "utf8"), authorityAfterAcceptance, "retry must not rewrite the receipt");
  assert.equal(fs.readFileSync(contextRoomEventJournalPath(), "utf8"), journalAfterAcceptance, "retry must not append another event");
});

test("direct shared main commits expose dependent reviews when no dependency proof exists", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "projects/demo/docs/trust.md", "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n");
  writeFile(fixture.seed, "projects/demo/docs/review.md", "---\ncontext_room:\n  id: product.review\n  depends_on:\n    - strategy.trust\n---\n\n# Review\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add dependent documentation"]);
  git(fixture.seed, ["push", "origin", "main"]);
  writeFile(fixture.seed, "projects/demo/docs/trust.md", "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nUpdated.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Direct human trust update"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const main = readSharedMainRevision(fixture.remote, { refresh: true });
  assert.equal(main.commit.dependencyProof, null);
  assert.deepEqual(main.commit.dependencyReviewRequired, [{
    path: "projects/demo/docs/review.md",
    documentId: "product.review",
    dependencies: ["strategy.trust"],
  }]);
});

test("dependency proofs suppress review only for the exact current blob and Git mode", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const trustPath = "projects/demo/docs/TRUST.md";
  const blobDependentPath = "projects/demo/docs/BLOB-DEPENDENT.md";
  const modeDependentPath = "projects/demo/docs/MODE-DEPENDENT.md";
  const trustBase = "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nBase.\n";
  const blobDependentBase = "---\ncontext_room:\n  id: product.blob-dependent\n  depends_on:\n    - strategy.trust\n---\n\n# Blob dependent\n\nReviewed old blob.\n";
  const modeDependentBase = "---\ncontext_room:\n  id: product.mode-dependent\n  depends_on:\n    - strategy.trust\n---\n\n# Mode dependent\n\nReviewed old mode.\n";
  writeFile(fixture.seed, trustPath, trustBase);
  writeFile(fixture.seed, blobDependentPath, blobDependentBase);
  writeFile(fixture.seed, modeDependentPath, modeDependentBase);
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add exact dependency proof fixtures"]);
  git(fixture.seed, ["push", "origin", "main"]);
  const staleProof = {
    version: 1,
    documents: [
      {
        path: blobDependentPath,
        blob: git(fixture.seed, ["rev-parse", `HEAD:${blobDependentPath}`]),
        mode: "100644",
        contentHash: createHash("sha256").update(blobDependentBase).digest("hex"),
        dependencies: {},
      },
      {
        path: modeDependentPath,
        blob: git(fixture.seed, ["rev-parse", `HEAD:${modeDependentPath}`]),
        mode: "100644",
        contentHash: createHash("sha256").update(modeDependentBase).digest("hex"),
        dependencies: {},
      },
    ],
  };

  writeFile(
    fixture.seed,
    blobDependentPath,
    blobDependentBase.replace("Reviewed old blob.", "New accepted main blob."),
  );
  fs.chmodSync(path.join(fixture.seed, modeDependentPath), 0o755);
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance dependent blob and mode before trust"]);
  git(fixture.seed, ["push", "origin", "main"]);

  writeFile(fixture.seed, trustPath, trustBase.replace("Base.", "Changed."));
  git(fixture.seed, ["add", trustPath]);
  git(fixture.seed, [
    "commit",
    "-m",
    `Change trust with stale dependency evidence\n\nContext-Room-Dependency-Proof: ${Buffer.from(JSON.stringify(staleProof), "utf8").toString("base64url")}`,
  ]);
  git(fixture.seed, ["push", "origin", "main"]);

  const main = readSharedMainRevision(fixture.remote, { refresh: true });
  assert.deepEqual(
    main.commit.dependencyReviewRequired.map((item) => item.path).sort(),
    [blobDependentPath, modeDependentPath].sort(),
  );
  assert.match(main.commit.dependencyProofError, /BLOB-DEPENDENT\.md.*blob/i);
  assert.match(main.commit.dependencyProofError, /MODE-DEPENDENT\.md.*mode/i);
});

test("proposal revision diff reports exact published A M D R changes without treating them as accepted", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const baseRevision = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["switch", "-c", "proposal/demo/exact-impact"]);
  git(fixture.seed, ["mv", "projects/demo/docs/README.md", "projects/demo/docs/GUIDE.md"]);
  writeFile(fixture.seed, "projects/demo/docs/NEW.md", "# New\n");
  writeFile(fixture.seed, "skills/global/global-workflow/SKILL.md", "# Modified global skill\n");
  fs.rmSync(path.join(fixture.seed, "projects/demo/skills/demo-workflow/scripts/run.sh"));
  git(fixture.seed, ["add", "-A"]);
  git(fixture.seed, ["commit", "-m", "Publish exact impact"]);
  git(fixture.seed, ["push", "origin", "proposal/demo/exact-impact"]);
  const proposalHead = git(fixture.seed, ["rev-parse", "HEAD"]);

  const impact = diffSharedProposalRevisions(fixture.remote, { fromRevision: baseRevision, toRevision: proposalHead });
  assert.equal(impact.truthState, "proposal");
  assert.equal(impact.accepted, false);
  assert.equal(impact.rebaseRequired, false);
  assert.equal(impact.hasConflict, false);
  assert.deepEqual(new Set(impact.changes.map((change) => change.status)), new Set(["A", "D", "M", "R"]));
  assert.equal(impact.changes.some((change) => change.status === "R" && change.fromPath.endsWith("README.md") && change.path.endsWith("GUIDE.md")), true);
});

test("Shared Skills revision diff is logical, exact, and never materializes proposal links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "project-demo", title: "Demo skills", path: "projects/demo/skills" }],
    assignments: [{ id: "project-demo-codex", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex"], include: ["*"], exclude: [] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "skill-locations.json"]);
  git(fixture.seed, ["commit", "-m", "Declare accepted skills"]);
  git(fixture.seed, ["push", "origin", "main"]);
  const baseRevision = git(fixture.seed, ["rev-parse", "HEAD"]);

  git(fixture.seed, ["switch", "-c", "proposal/skills/provider-expansion"]);
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "project-demo", title: "Demo skills", path: "projects/demo/skills" }],
    assignments: [{ id: "project-demo-codex", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex", "claude-code"], include: ["*"], exclude: [] }],
  }, null, 2) + "\n");
  writeFile(fixture.seed, "projects/demo/skills/call-quality/SKILL.md", "# Call quality\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Expand shared skill providers"]);
  git(fixture.seed, ["push", "origin", "proposal/skills/provider-expansion"]);
  const proposalHead = git(fixture.seed, ["rev-parse", "HEAD"]);

  const diff = diffSharedSkillLocationsRevisions(fixture.remote, { fromRevision: baseRevision, toRevision: proposalHead });
  assert.equal(diff.fromTruthState, "accepted");
  assert.equal(diff.toTruthState, "proposal");
  assert.equal(diff.materializedLocalState, false);
  assert.equal(diff.collectionChanges.some((change) => change.id === "project-demo" && change.after.skills.includes("call-quality")), true);
  assert.equal(diff.assignmentChanges.some((change) => change.id === "project-demo-codex" && change.after.providers.includes("claude-code")), true);
  assert.deepEqual(diff.providersAffected, ["claude-code", "codex"]);
  assert.equal(diff.logicalDestinations.some((destination) => destination.provider === "claude-code" && destination.destination === "project-provider"), true);
  assert.equal(diff.repositoryChanges.some((change) => change.path === "skill-locations.json"), true);
  assert.equal(fs.existsSync(path.join(fixture.project, ".claude/skills/call-quality")), false);
});

test("accepted Shared Instructions project arbitrary Markdown instruction files without replacing unmanaged files", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Shared Codex instructions\n");
  writeFile(fixture.seed, "instructions/team/CLAUDE.md", "# Shared Claude instructions\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team", title: "Team instructions", path: "instructions/team" }],
    assignments: [{
      id: "team-project",
      collectionId: "team",
      scope: "project",
      projectIds: ["demo"],
      files: [
        { source: "AGENTS.md", target: "AGENTS.md", providers: ["codex", "opencode"] },
        { source: "CLAUDE.md", target: "CLAUDE.md", providers: ["claude-code"] },
      ],
    }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add shared instructions"]);
  git(fixture.seed, ["push", "origin", "main"]);

  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  assert.equal(fs.lstatSync(path.join(fixture.project, "AGENTS.md")).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(fixture.project, "AGENTS.md"), "utf8"), "# Shared Codex instructions\n");
  assert.equal(fs.lstatSync(path.join(fixture.project, "CLAUDE.md")).isSymbolicLink(), true);
  const status = sharedInstructionLocationsStatus(fixture.project, { refresh: false });
  assert.equal(status.collections[0].fileCount, 2);
  assert.equal(status.assignments[0].files.length, 2);
  assert.equal(status.links.every((item) => item.status === "ready"), true);

  fs.unlinkSync(path.join(fixture.project, "AGENTS.md"));
  fs.writeFileSync(path.join(fixture.project, "AGENTS.md"), "# Local owner file\n", "utf8");
  reconcileSharedInstructionLocations(fixture.project);
  assert.equal(fs.readFileSync(path.join(fixture.project, "AGENTS.md"), "utf8"), "# Local owner file\n");
  assert.equal(sharedInstructionLocationsStatus(fixture.project, { refresh: false }).links.some((item) => item.relativeTarget === "AGENTS.md" && item.status === "conflict"), true);

  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team", title: "Team instructions", path: "instructions/team" }],
    assignments: [],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "instruction-locations.json"]);
  git(fixture.seed, ["commit", "-m", "Remove shared instruction assignment"]);
  git(fixture.seed, ["push", "origin", "main"]);
  reconcileSharedInstructionLocations(fixture.project);
  assert.equal(fs.existsSync(path.join(fixture.project, "CLAUDE.md")), false);
  assert.equal(fs.readFileSync(path.join(fixture.project, "AGENTS.md"), "utf8"), "# Local owner file\n");
});

test("Shared Instructions distinguish installed links from provider activation and obey local provider preferences", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "instructions/team/CALL.md", "# Call instructions\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team", title: "Team", path: "instructions/team" }],
    assignments: [{ id: "team-project", collectionId: "team", scope: "project", projectIds: ["demo"], files: [{ source: "CALL.md", target: "CALL.md", providers: ["codex"] }] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add arbitrary instruction target"]);
  git(fixture.seed, ["push", "origin", "main"]);

  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  let link = sharedInstructionLocationsStatus(fixture.project, { refresh: false }).links.find((item) => item.relativeTarget === "CALL.md");
  assert.equal(link.materializationStatus, "installed");
  assert.equal(link.activationStatus, "inactive");
  assert.equal(fs.lstatSync(path.join(fixture.project, "CALL.md")).isSymbolicLink(), true);

  writeFile(fixture.project, ".codex/config.toml", 'project_doc_fallback_filenames = ["CALL.md"]\n');
  reconcileSharedInstructionLocations(fixture.project, { provider: "codex" });
  link = sharedInstructionLocationsStatus(fixture.project, { refresh: false }).links.find((item) => item.relativeTarget === "CALL.md");
  assert.equal(link.activationStatus, "configured");

  fs.writeFileSync(path.join(fixture.project, "AGENTS.md"), "# Native instructions take precedence\n", "utf8");
  reconcileSharedInstructionLocations(fixture.project, { provider: "codex" });
  link = sharedInstructionLocationsStatus(fixture.project, { refresh: false }).links.find((item) => item.relativeTarget === "CALL.md");
  assert.equal(link.activationStatus, "shadowed");
  assert.match(link.activationReason, /AGENTS\.md before configured fallback/);

  setSharedSkillProviderSettings(fixture.project, { projectOverrides: { codex: "disabled" } });
  link = sharedInstructionLocationsStatus(fixture.project, { refresh: false }).links.find((item) => item.relativeTarget === "CALL.md");
  assert.equal(link.status, "provider-disabled");
  assert.equal(fs.existsSync(path.join(fixture.project, "CALL.md")), false);
});

test("provider-targeted Shared Instructions reconcile leaves other provider links on their previous snapshot", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Codex v1\n");
  writeFile(fixture.seed, "instructions/team/CLAUDE.md", "# Claude v1\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team", title: "Team", path: "instructions/team" }],
    assignments: [{
      id: "team-project",
      collectionId: "team",
      scope: "project",
      projectIds: ["demo"],
      files: [
        { source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] },
        { source: "CLAUDE.md", target: "CLAUDE.md", providers: ["claude-code"] },
      ],
    }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add provider instructions"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const codexDestination = path.join(fixture.project, "AGENTS.md");
  const claudeDestination = path.join(fixture.project, "CLAUDE.md");
  const oldCodexTarget = fs.realpathSync(codexDestination);
  const oldClaudeTarget = fs.realpathSync(claudeDestination);

  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Codex v2\n");
  writeFile(fixture.seed, "instructions/team/CLAUDE.md", "# Claude v2\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Update provider instructions"]);
  git(fixture.seed, ["push", "origin", "main"]);

  reconcileSharedInstructionLocations(fixture.project, { allowOffline: false, provider: "codex" });
  assert.notEqual(fs.realpathSync(codexDestination), oldCodexTarget);
  assert.equal(fs.realpathSync(claudeDestination), oldClaudeTarget);
  reconcileSharedInstructionLocations(fixture.project, { allowOffline: false, provider: "claude-code" });
  assert.notEqual(fs.realpathSync(claudeDestination), oldClaudeTarget);
});

test("Shared Instructions reconciliations serialize and recover an abandoned destination lock", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Shared instructions\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team", title: "Team", path: "instructions/team" }],
    assignments: [{ id: "team-project", collectionId: "team", scope: "project", projectIds: ["demo"], files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add shared instructions"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const destination = path.resolve(fixture.project, "AGENTS.md");
  const registryPath = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "managed-destinations.json");
  const lockKey = createHash("sha256").update(registryPath).digest("hex").slice(0, 24);
  const lock = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "locks", `${lockKey}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: 2_147_483_647, createdAt: new Date(Date.now() - 60_000).toISOString(), destination: registryPath }));
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Updated shared instructions\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Update shared instructions"]);
  git(fixture.seed, ["push", "origin", "main"]);
  fs.unlinkSync(destination);
  reconcileSharedInstructionLocations(fixture.project, { allowOffline: false, provider: "codex" });
  assert.equal(fs.existsSync(lock), false);

  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const source = `import { reconcileSharedInstructionLocations } from ${JSON.stringify(moduleUrl)}; reconcileSharedInstructionLocations(process.argv[1], { provider: "codex" });`;
  const run = () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, fixture.project], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code) => code === 0 ? resolve() : reject(new Error(stderr || `reconcile exited ${code}`)));
  });
  await Promise.all([run(), run()]);
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  assert.match(fs.realpathSync(destination), /snapshots\/.*\/instructions\/team\/AGENTS\.md$/);
});

test("accepted instruction imports archive an unchanged source that is also the provider destination", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const localInstruction = path.join(fixture.project, "AGENTS.md");
  fs.writeFileSync(localInstruction, "# Imported agent instructions\n", "utf8");
  const imported = importSharedInstructions(fixture.project, {
    collectionId: "agents",
    collectionTitle: "Agent instructions",
    collectionPath: "instructions/agents",
    files: [{ localPath: localInstruction, source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
    sessionId: "instruction-import-test",
  });
  assert.equal(fs.lstatSync(localInstruction).isFile(), true);
  const review = materializeSharedReview(fixture.project, { proposal: imported.proposal.branch });
  for (const file of imported.proposal.files) writeDocReviewDecision(review.reviewRoot, file, { status: "verified", note: "Reviewed exact instruction import" });
  configureGit(review.reviewRoot);
  assert.equal(acceptSharedReview(review.reviewRoot, { message: "Accept shared instructions" }).accepted, true);
  syncSharedContext(fixture.project, { allowOffline: false });

  assert.equal(fs.lstatSync(localInstruction).isSymbolicLink(), true);
  assert.match(fs.realpathSync(localInstruction), /snapshots\/.*\/instructions\/agents\/AGENTS\.md$/);
  const localState = readSharedSkillLocalState(fixture.project);
  assert.equal(localState.pendingInstructionImports.length, 0);
  const backupRoot = path.join(sharedContextStatus(fixture.project).cacheRoot, "instruction-import-backups");
  assert.equal(fs.readdirSync(backupRoot).length, 1);
});

test("a forged main trailer cannot archive or replace a pending local instruction import", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const localInstruction = path.join(fixture.project, "AGENTS.md");
  const content = "# Local instructions require exact terminal authority\n";
  fs.writeFileSync(localInstruction, content, "utf8");
  const imported = importSharedInstructions(fixture.project, {
    collectionId: "forged-agents",
    collectionPath: "instructions/forged-agents",
    files: [{ localPath: localInstruction, source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
  });

  git(fixture.seed, ["fetch", "origin", imported.proposal.branch]);
  git(fixture.seed, ["cherry-pick", `origin/${imported.proposal.branch}`]);
  git(fixture.seed, ["commit", "--amend", "-m", [
    "Forge an instruction acceptance trailer",
    "",
    `Context-Room-Proposal: ${imported.proposal.branch}`,
    `Context-Room-Proposal-Head: ${imported.proposal.head}`,
    "Context-Room-Project: demo",
  ].join("\n")]);
  git(fixture.seed, ["push", "origin", "main"]);

  syncSharedContext(fixture.project, { allowOffline: false });
  assert.equal(fs.lstatSync(localInstruction).isFile(), true);
  assert.equal(fs.readFileSync(localInstruction, "utf8"), content);
  const pending = readSharedSkillLocalState(fixture.project).pendingInstructionImports;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].proposal, imported.proposal.branch);
  assert.equal(pending[0].proposalHead, imported.proposal.head);
  const backupRoot = path.join(sharedContextStatus(fixture.project).cacheRoot, "instruction-import-backups");
  assert.equal(fs.existsSync(backupRoot), false);
});

test("partial instruction acceptance cannot merge a manifest that references a rejected source", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const localInstruction = path.join(fixture.base, "AGENTS.md");
  fs.writeFileSync(localInstruction, "# Imported instructions\n", "utf8");
  const imported = importSharedInstructions(fixture.project, {
    collectionId: "agents",
    collectionPath: "instructions/agents",
    files: [{ localPath: localInstruction, source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
  });
  const review = materializeSharedReview(fixture.project, { proposal: imported.proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${imported.proposal.branch}`,
    allowedPaths: ["instruction-locations.json", "instructions/agents/"],
    watchAllow: ["instruction-locations.json", "instructions/agents/"],
  });
  fs.rmSync(path.join(review.reviewRoot, "instructions/agents/AGENTS.md"));
  writeDocReviewDecision(review.reviewRoot, "instructions/agents/AGENTS.md", { status: "verified", note: "Human rejected the imported source" });
  writeDocReviewDecision(review.reviewRoot, "instruction-locations.json", { status: "verified", note: "Manifest selected without its source" });
  configureGit(review.reviewRoot);
  assert.throws(() => acceptSharedReview(review.reviewRoot), /references a missing accepted file/);
  assert.throws(() => git(fixture.seed, ["show", "origin/main:instruction-locations.json"]));
});

test("an instruction import source changed after preview is never archived or replaced", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const localInstruction = path.join(fixture.project, "AGENTS.md");
  fs.writeFileSync(localInstruction, "# Previewed instructions\n", "utf8");
  const imported = importSharedInstructions(fixture.project, {
    collectionId: "agents",
    collectionPath: "instructions/agents",
    files: [{ localPath: localInstruction, source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
  });
  fs.writeFileSync(localInstruction, "# Newer local instructions\n", "utf8");
  const review = materializeSharedReview(fixture.project, { proposal: imported.proposal.branch });
  for (const file of imported.proposal.files) writeDocReviewDecision(review.reviewRoot, file, { status: "verified", note: "Reviewed import" });
  configureGit(review.reviewRoot);
  assert.equal(acceptSharedReview(review.reviewRoot).accepted, true);
  syncSharedContext(fixture.project, { allowOffline: false });

  assert.equal(fs.lstatSync(localInstruction).isFile(), true);
  assert.equal(fs.readFileSync(localInstruction, "utf8"), "# Newer local instructions\n");
  const localState = readSharedSkillLocalState(fixture.project);
  assert.equal(localState.pendingInstructionImports[0].error, "import-source-changed");
  assert.equal(sharedInstructionLocationsStatus(fixture.project, { refresh: false }).links.some((item) => item.materializationStatus === "unmanaged-conflict"), true);
});

test("an accepted instruction import waits for its provider before replacing the local destination", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  setSharedSkillProviderSettings(fixture.project, { projectOverrides: { codex: "disabled" } });
  const localInstruction = path.join(fixture.project, "AGENTS.md");
  fs.writeFileSync(localInstruction, "# Deferred agent instructions\n", "utf8");
  const imported = importSharedInstructions(fixture.project, {
    collectionId: "agents",
    collectionPath: "instructions/agents",
    files: [{ localPath: localInstruction, source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
  });
  const review = materializeSharedReview(fixture.project, { proposal: imported.proposal.branch });
  for (const file of imported.proposal.files) writeDocReviewDecision(review.reviewRoot, file, { status: "verified", note: "Reviewed deferred import" });
  configureGit(review.reviewRoot);
  assert.equal(acceptSharedReview(review.reviewRoot).accepted, true);
  syncSharedContext(fixture.project, { allowOffline: false });

  assert.equal(fs.lstatSync(localInstruction).isFile(), true);
  assert.equal(readSharedSkillLocalState(fixture.project).pendingInstructionImports[0].error, "provider-disabled");

  setSharedSkillProviderSettings(fixture.project, { projectOverrides: { codex: "enabled" } });
  assert.equal(fs.lstatSync(localInstruction).isSymbolicLink(), true);
  assert.equal(readSharedSkillLocalState(fixture.project).pendingInstructionImports.length, 0);
});

test("Shared Instructions assignment and import changes stay proposal-only until human acceptance", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Team\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({ version: 1, collections: [{ id: "team", title: "Team", path: "instructions/team" }], assignments: [] }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add instruction collection"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const preview = previewSharedInstructionAssignment(fixture.project, {
    collectionId: "team",
    scope: "project",
    projectIds: ["demo"],
    files: [{ source: "AGENTS.md", target: "apps/calls/AGENTS.md", providers: ["codex"] }],
  });
  assert.equal(preview.proposalRequired, true);
  assert.equal(preview.mappings[0].activationStatus, "active");
  assert.equal(preview.mappings[0].materializationStatus, "pending");
  assert.equal(preview.mappings[0].localBehavior.includes("managed link"), true);
  const proposed = proposeSharedInstructionAssignment(fixture.project, {
    collectionId: "team",
    scope: "project",
    projectIds: ["demo"],
    files: preview.assignment.files,
  });
  assert.match(proposed.proposal.branch, /^proposal\/instructions\//);
  assert.equal(fs.existsSync(path.join(fixture.project, "apps/calls/AGENTS.md")), false);

  const localClaude = path.join(fixture.base, "CALL.md");
  fs.writeFileSync(localClaude, "# Call agent instructions\n", "utf8");
  const imported = importSharedInstructions(fixture.project, {
    collectionId: "calls",
    collectionTitle: "Call instructions",
    files: [{ localPath: localClaude, source: "CALL.md", target: "apps/calls/CALL.md", providers: ["claude-code"] }],
  });
  assert.match(imported.proposal.branch, /^proposal\/instructions\//);
  assert.equal(fs.existsSync(path.join(fixture.project, "apps/calls/CALL.md")), false);
});

test("shared instructions CLI uses machine-readable preview and exact apply", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Team\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({ version: 1, collections: [{ id: "team", title: "Team", path: "instructions/team" }], assignments: [] }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add instruction collection"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const mappings = path.join(fixture.base, "instruction-mappings.json");
  fs.writeFileSync(mappings, JSON.stringify([{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }]), "utf8");
  const runInstructions = (args) => JSON.parse(execFileSync(process.execPath, [cli, "shared", "instructions", ...args, "--root", fixture.project, "--format", "json"], { encoding: "utf8", env: { ...process.env, NODE_TEST_CONTEXT: "1" } })).data;
  const status = runInstructions(["status"]);
  assert.equal(status.collections[0].id, "team");
  const reconcilePlan = runInstructions(["reconcile", "--provider", "codex"]);
  assert.equal(reconcilePlan.input.provider, "codex");
  assert.equal(reconcilePlan.preview.provider, "codex");
  const reconciled = runInstructions(["reconcile", "--apply", reconcilePlan.planId, "--provider", "codex"]);
  assert.equal(reconciled.result.provider, "codex");
  const plan = runInstructions(["assign", "--collection", "team", "--files", mappings, "--scope", "project", "--projects", "demo"]);
  assert.equal(plan.proposalRequired, true);
  assert.equal(plan.preview.assignment.files[0].target, "AGENTS.md");
  const applied = runInstructions(["assign", "--apply", plan.planId]);
  assert.equal(applied.result.proposal.scope, "instructions");
  assert.match(applied.result.proposal.branch, /^proposal\/instructions\//);
  assert.equal(fs.existsSync(path.join(fixture.project, "AGENTS.md")), false);
});

test("shared setup publishes an exact main snapshot and safe global/project skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const synced = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  assert.equal(readSharedProjectConnection(fixture.project).projectId, "demo");
  assert.equal(sharedContextStatus(fixture.project).revision, synced.revision);
  assert.equal(fs.readFileSync(path.join(synced.current, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nInitial.\n");
  assert.equal(fs.statSync(path.join(synced.current, "projects/demo/docs/README.md")).mode & 0o222, 0);

  const globalLink = path.join(process.env.HOME, ".agents/skills/global-workflow");
  const projectLink = path.join(fixture.project, ".agents/skills/demo-workflow");
  assert.equal(fs.lstatSync(globalLink).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(projectLink).isSymbolicLink(), true);
  assert.match(fs.realpathSync(globalLink), /snapshots\/[a-f0-9]{40}\/skills\/global\/global-workflow$/);
  assert.match(fs.realpathSync(projectLink), /snapshots\/[a-f0-9]{40}\/projects\/demo\/skills\/demo-workflow$/);
  assert.notEqual(fs.statSync(path.join(projectLink, "scripts/run.sh")).mode & 0o111, 0);
  assert.equal(fs.statSync(path.join(projectLink, "SKILL.md")).mode & 0o222, 0);

  const settings = readMemoryWebappSettings(fixture.project);
  assert.equal(settings.readOnlyPaths.length, 3);
  const sharedDoc = listExplorerFiles(fixture.project).find((file) => file.path.endsWith("/projects/demo/docs/README.md"));
  assert.equal(sharedDoc?.readOnly, true);
  assert.throws(() => writeMemoryFile(fixture.project, sharedDoc.path, "changed\n"), /read-only/);
});

test("project rooms expose only shared collections assigned to their project", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [
      { id: "demo", title: "Demo" },
      { id: "orbit", title: "Orbit" },
    ],
  }, null, 2) + "\n");
  writeFile(fixture.seed, "collections/demo/demo-only/SKILL.md", "# Demo only\n");
  writeFile(fixture.seed, "collections/orbit/orbit-private/SKILL.md", "# Orbit private\n");
  writeFile(fixture.seed, "instructions/demo/AGENTS.md", "# Demo instructions\n");
  writeFile(fixture.seed, "instructions/orbit/AGENTS.md", "# Orbit private instructions\n");
  writeFile(fixture.seed, "projects/orbit/docs/README.md", "# Orbit\n");
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [
      { id: "demo-only", title: "Demo only", path: "collections/demo" },
      { id: "orbit-private", title: "Orbit private", path: "collections/orbit" },
    ],
    assignments: [
      { id: "demo-only-codex", collectionId: "demo-only", scope: "project", projectIds: ["demo"], providers: ["codex"], include: ["*"], exclude: [] },
      { id: "orbit-private-codex", collectionId: "orbit-private", scope: "project", projectIds: ["orbit"], providers: ["codex"], include: ["*"], exclude: [] },
    ],
  }, null, 2) + "\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [
      { id: "demo-instructions", title: "Demo instructions", path: "instructions/demo" },
      { id: "orbit-instructions", title: "Orbit instructions", path: "instructions/orbit" },
    ],
    assignments: [
      { id: "demo-instructions-codex", collectionId: "demo-instructions", scope: "project", projectIds: ["demo"], files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }] },
      { id: "orbit-instructions-codex", collectionId: "orbit-instructions", scope: "project", projectIds: ["orbit"], files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }] },
    ],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add project-scoped shared collections"]);
  git(fixture.seed, ["push", "origin", "main"]);

  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const settings = readMemoryWebappSettings(fixture.project);
  for (const paths of [settings.allowedPaths, settings.readOnlyPaths]) {
    assert.equal(paths.some((item) => item.endsWith("/collections/demo/")), true);
    assert.equal(paths.some((item) => item.endsWith("/instructions/demo/")), true);
    assert.equal(paths.some((item) => item.endsWith("/collections/orbit/")), false);
    assert.equal(paths.some((item) => item.endsWith("/instructions/orbit/")), false);
  }
  const room = JSON.parse(fs.readFileSync(path.join(fixture.project, ".context-room/config.json"), "utf8"));
  const sharedCards = room.hubSections.find((section) => section.id === "shared-context").cards;
  assert.equal(sharedCards.some((card) => card.id === "shared-skill-collection-demo-only"), true);
  assert.equal(sharedCards.some((card) => card.id === "shared-instruction-collection-demo-instructions"), true);
  assert.equal(sharedCards.some((card) => card.id.includes("orbit")), false);

  const sharedOnly = resolveSharedDocumentationTarget(fixture.remote, { projectId: "demo" });
  assert.equal(sharedOnly.roots.some((item) => item.repositoryPath === "collections/demo"), true);
  assert.equal(sharedOnly.roots.some((item) => item.repositoryPath === "instructions/demo"), true);
  assert.equal(sharedOnly.roots.some((item) => item.repositoryPath.includes("orbit")), false);
});

test("legacy shared skills are synthesized and unmanaged collisions remain untouched", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const unmanaged = path.join(fixture.project, ".agents/skills/demo-workflow");
  const legacyUnmanaged = path.join(fixture.project, ".codex/skills/legacy-owner/SKILL.md");
  writeFile(fixture.project, ".agents/skills/demo-workflow/SKILL.md", "# Local owner copy\n");
  writeFile(fixture.project, ".codex/skills/legacy-owner/SKILL.md", "# Legacy local owner\n");

  const synced = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const status = sharedSkillLocationsStatus(fixture.project, { refresh: false });

  assert.equal(status.legacy, true);
  assert.equal(status.collections.some((collection) => collection.id === "project-demo"), true);
  assert.equal(status.destinations.some((destination) => destination.status === "conflict"), true);
  assert.equal(fs.lstatSync(unmanaged).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(unmanaged, "SKILL.md"), "utf8"), "# Local owner copy\n");
  assert.equal(fs.readFileSync(legacyUnmanaged, "utf8"), "# Legacy local owner\n");
  assert.equal(fs.existsSync(path.join(synced.current, "projects/demo/docs/README.md")), true);
});

test("managed Codex links migrate atomically and remain installed when the official destination is blocked", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const officialLink = path.join(fixture.project, ".agents/skills/demo-workflow");
  const legacyLink = path.join(fixture.project, ".codex/skills/demo-workflow");
  const target = fs.realpathSync(officialLink);
  fs.rmSync(officialLink);
  fs.mkdirSync(path.dirname(legacyLink), { recursive: true });
  fs.symlinkSync(target, legacyLink);

  const projectKey = createHash("sha256").update(fs.realpathSync(fixture.project)).digest("hex").slice(0, 16);
  const repositoryCache = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && fs.existsSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, entry.name, "skill-links")))?.name;
  assert.ok(repositoryCache);
  const registryPath = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, repositoryCache, "skill-links", `${projectKey}.json`);
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  for (const link of registry.links) {
    if (link.provider !== "codex" || link.name !== "demo-workflow") continue;
    link.link = legacyLink;
    link.destination = path.dirname(legacyLink);
  }
  for (const destination of registry.destinations) {
    if (destination.provider !== "codex" || destination.scope !== "project") continue;
    destination.destination = path.dirname(legacyLink);
    for (const link of destination.links || []) {
      if (link.name !== "demo-workflow") continue;
      link.link = legacyLink;
      link.destination = path.dirname(legacyLink);
    }
  }
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

  writeFile(fixture.project, ".agents/skills/demo-workflow/SKILL.md", "# Unmanaged official destination\n");
  const synced = syncSharedContext(fixture.project, { allowOffline: false, forceReconcile: true });

  assert.equal(fs.lstatSync(legacyLink).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(path.join(officialLink, "SKILL.md"), "utf8"), "# Unmanaged official destination\n");
  assert.ok(synced.skillMigrations.some((migration) => migration.provider === "codex" && migration.status === "blocked" && migration.previousDestination === path.dirname(legacyLink)));
});

test("two shared contexts never resolve a same-name device skill by implicit priority", (t) => {
  const first = makeFixture();
  const second = makeFixture();
  withSharedHome(t, first);
  const firstSync = connectSharedContext(first.project, { repository: first.remote, projectId: "demo" });
  const deviceLink = path.join(process.env.HOME, ".agents/skills/global-workflow");
  const firstTarget = fs.realpathSync(deviceLink);

  const secondSync = connectSharedContext(second.project, { repository: second.remote, projectId: "demo" });
  const secondStatus = sharedSkillLocationsStatus(second.project, { refresh: false });

  assert.equal(secondStatus.destinations.some((destination) => destination.scope === "device" && destination.status === "conflict"), true);
  assert.equal(secondStatus.conflicts.some((conflict) => conflict.owner?.repository === first.remote || String(conflict.reason || "").includes(first.remote)), true);
  assert.equal(fs.realpathSync(deviceLink), firstTarget);
  assert.equal(fs.existsSync(path.join(firstSync.current, "projects/demo/docs/README.md")), true);
  assert.equal(fs.existsSync(path.join(secondSync.current, "projects/demo/docs/README.md")), true);
});

test("two shared contexts expose both owners for one device instruction destination", (t) => {
  const first = makeFixture();
  const second = makeFixture();
  withSharedHome(t, first);
  for (const fixture of [first, second]) {
    writeFile(fixture.seed, "instructions/team/AGENTS.md", `# ${path.basename(fixture.base)} instructions\n`);
    writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
      version: 1,
      collections: [{ id: "team", title: "Team", path: "instructions/team" }],
      assignments: [{ id: "team-device", collectionId: "team", scope: "device", projectIds: [], files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }] }],
    }, null, 2) + "\n");
    git(fixture.seed, ["add", "."]);
    git(fixture.seed, ["commit", "-m", "Add device instructions"]);
    git(fixture.seed, ["push", "origin", "main"]);
  }

  connectSharedContext(first.project, { repository: first.remote, projectId: "demo" });
  const destination = path.join(process.env.HOME, ".codex", "AGENTS.md");
  const firstTarget = fs.realpathSync(destination);
  connectSharedContext(second.project, { repository: second.remote, projectId: "demo" });
  const conflicted = sharedInstructionLocationsStatus(second.project, { refresh: false }).links.find((item) => item.destination === destination);

  assert.equal(conflicted.materializationStatus, "shared-owner-conflict");
  assert.equal(conflicted.owner.repository, first.remote);
  assert.equal(fs.realpathSync(destination), firstTarget);
});

test("two isolated machines keep provider preferences local and receive instructions only after accepted main advances", (t) => {
  const fixture = makeFixture();
  const projectB = path.join(fixture.base, "project-b");
  fs.mkdirSync(projectB, { recursive: true });
  initializeContextRoomProject(projectB, { title: "Demo B", allowedPaths: ["README.md"], watchAllow: [] });
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Shared agents\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({ version: 1, collections: [{ id: "team", title: "Team", path: "instructions/team" }], assignments: [] }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add instruction collection"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const originalHome = process.env.HOME;
  const originalSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const homeA = path.join(fixture.base, "machine-a");
  const homeB = path.join(fixture.base, "machine-b");
  const useMachine = (home) => {
    fs.mkdirSync(home, { recursive: true });
    process.env.HOME = home;
    process.env.CONTEXT_ROOM_SHARED_HOME = path.join(home, ".context-room", "shared");
  };
  t.after(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = originalSharedHome;
  });

  useMachine(homeA);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  setSharedSkillProviderSettings(fixture.project, { projectOverrides: { codex: "disabled" } });
  const proposed = proposeSharedInstructionAssignment(fixture.project, {
    collectionId: "team",
    scope: "project",
    projectIds: ["demo"],
    files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
  });
  assert.equal(sharedInstructionLocationsStatus(fixture.project, { refresh: false }).assignments.length, 0);

  useMachine(homeB);
  connectSharedContext(projectB, { repository: fixture.remote, projectId: "demo" });
  assert.equal(sharedSkillProviderPreferences().providers.codex, "enabled");
  assert.equal(sharedInstructionLocationsStatus(projectB, { refresh: false }).assignments.length, 0);

  useMachine(homeA);
  const review = materializeSharedReview(fixture.project, { proposal: proposed.proposal.branch });
  for (const file of proposed.proposal.files) writeDocReviewDecision(review.reviewRoot, file, { status: "verified", note: "Reviewed on machine A" });
  configureGit(review.reviewRoot);
  assert.equal(acceptSharedReview(review.reviewRoot).accepted, true);
  syncSharedContext(fixture.project, { allowOffline: false });
  assert.equal(fs.existsSync(path.join(fixture.project, "AGENTS.md")), false);

  useMachine(homeB);
  syncSharedContext(projectB, { allowOffline: false });
  assert.equal(fs.lstatSync(path.join(projectB, "AGENTS.md")).isSymbolicLink(), true);
  const acceptedTarget = fs.realpathSync(path.join(projectB, "AGENTS.md"));
  const offlineRemote = `${fixture.remote}.offline`;
  fs.renameSync(fixture.remote, offlineRemote);
  try {
    const offline = syncSharedContext(projectB, { allowOffline: true });
    assert.equal(offline.online, false);
    assert.equal(fs.realpathSync(path.join(projectB, "AGENTS.md")), acceptedTarget);
  } finally {
    fs.renameSync(offlineRemote, fixture.remote);
  }
});

test("custom shared skill locations link and unlink only managed symlinks", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({ version: 1, collections: [{ id: "global", title: "Global skills", path: "skills/global" }, { id: "project-demo", title: "Demo skills", path: "projects/demo/skills" }], assignments: [{ id: "global-all", collectionId: "global", scope: "device", providers: ["opencode"], include: ["*"], exclude: [] }, { id: "project-demo-all", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex", "claude-code"], include: ["*"], exclude: [] }] }, null, 2) + "\n");
  git(fixture.seed, ["add", "skill-locations.json"]);
  git(fixture.seed, ["commit", "-m", "Declare provider assignments"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const destination = path.join(fixture.base, "custom-skills");

  const linked = linkSharedSkillLocation(fixture.project, {
    collectionId: "project-demo",
    provider: "custom",
    scope: "project",
    destination,
  });
  const link = path.join(destination, "demo-workflow");
  assert.equal(linked.status.destinations.some((item) => item.destination === destination && item.status === "ready"), true);
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  const cliStatus = JSON.parse(execFileSync(process.execPath, [cli, "shared", "skills", "status", "--root", fixture.project], { encoding: "utf8" }));
  assert.equal(cliStatus.collections.some((collection) => collection.id === "project-demo"), true);
  const overridden = setSharedSkillLocationOverride(fixture.project, { assignmentId: "project-demo-all", disabled: true });
  assert.equal(overridden.status.destinations.some((item) => item.assignmentId === "project-demo-all" && item.status === "local-override"), true);
  assert.equal(fs.existsSync(path.join(fixture.project, ".agents/skills/demo-workflow")), false);
  setSharedSkillLocationOverride(fixture.project, { assignmentId: "project-demo-all", disabled: false });

  const mount = linked.mount;
  unlinkSharedSkillLocation(fixture.project, { id: mount.id });
  assert.equal(fs.existsSync(link), false);

  const claude = linkSharedSkillLocation(fixture.project, { assignmentId: "project-demo-all", collectionId: "project-demo", provider: "claude-code", scope: "project", destination: path.join(fixture.base, "claude-skills") });
  assert.equal(fs.lstatSync(path.join(fixture.base, "claude-skills/demo-workflow")).isSymbolicLink(), true);
  unlinkSharedSkillLocation(fixture.project, { id: claude.mount.id });
  const opencode = linkSharedSkillLocation(fixture.project, { assignmentId: "global-all", collectionId: "global", provider: "opencode", scope: "device", destination: path.join(fixture.base, "opencode-skills") });
  assert.equal(fs.lstatSync(path.join(fixture.base, "opencode-skills/global-workflow")).isSymbolicLink(), true);
  unlinkSharedSkillLocation(fixture.project, { id: opencode.mount.id });
});

test("provider-targeted reconciliation leaves other provider destinations untouched and local overrides are versioned", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "project-demo", title: "Demo skills", path: "projects/demo/skills" }],
    assignments: [{ id: "project-demo-all", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex", "claude-code"], include: ["*"], exclude: [] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "skill-locations.json"]);
  git(fixture.seed, ["commit", "-m", "Declare two providers"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const codexLink = path.join(fixture.project, ".agents/skills/demo-workflow");
  const claudeLink = path.join(fixture.project, ".claude/skills/demo-workflow");
  fs.unlinkSync(codexLink);
  fs.unlinkSync(claudeLink);

  const reconciled = reconcileSharedSkillLocations(fixture.project, { provider: "codex" });
  assert.equal(reconciled.provider, "codex");
  assert.equal(fs.lstatSync(codexLink).isSymbolicLink(), true);
  assert.equal(fs.existsSync(claudeLink), false);

  setSharedSkillLocationOverride(fixture.project, { assignmentId: "project-demo-all", exclude: ["demo-workflow"] });
  const local = readSharedSkillLocalState(fixture.project);
  const projection = sharedSkillEffectiveProjection(fixture.project, { provider: "codex" });
  assert.equal(local.version, 3);
  assert.deepEqual(local.overrides[0].exclude, ["demo-workflow"]);
  assert.equal(projection.destinations[0].filters.localExclude.includes("demo-workflow"), true);
  const localStatePath = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME).find((name) => /^[a-f0-9]{16}$/.test(name)), "shared-resources-local.json");
  assert.equal(fs.statSync(localStatePath).mode & 0o077, 0);

  setSharedSkillLocationOverride(fixture.project, { assignmentId: "project-demo-all", disabled: false, exclude: [] });
  assert.equal(readSharedSkillLocalState(fixture.project).overrides.length, 0);
});

test("provider settings validate and apply device preferences with project overrides as one local operation", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "project-demo", title: "Demo skills", path: "projects/demo/skills" }],
    assignments: [{ id: "project-demo-all", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex", "claude-code"], include: ["*"], exclude: [] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "skill-locations.json"]);
  git(fixture.seed, ["commit", "-m", "Declare provider settings"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const result = setSharedSkillProviderSettings(fixture.project, {
    providers: { codex: "disabled" },
    projectOverrides: { "claude-code": "disabled" },
  });
  assert.deepEqual(result.affectedProviders.sort(), ["claude-code", "codex"]);
  assert.equal(sharedSkillProviderPreferences().providers.codex, "disabled");
  assert.equal(readSharedSkillLocalState(fixture.project).providerOverrides.some((item) => item.projectId === "demo" && item.provider === "claude-code" && item.state === "disabled"), true);
  assert.equal(fs.existsSync(path.join(fixture.project, ".agents/skills/demo-workflow")), false);
  assert.equal(fs.existsSync(path.join(fixture.project, ".claude/skills/demo-workflow")), false);

  const beforeGlobal = sharedSkillProviderPreferences();
  const beforeLocal = readSharedSkillLocalState(fixture.project);
  assert.throws(
    () => setSharedSkillProviderSettings(fixture.project, { providers: { imaginary: "disabled" }, projectOverrides: { codex: "enabled" } }),
    /Unknown shared skill provider/,
  );
  assert.deepEqual(sharedSkillProviderPreferences(), beforeGlobal);
  assert.deepEqual(readSharedSkillLocalState(fixture.project), beforeLocal);
});

test("Shared Resources v3 reads Skills v2 and migrates it only on the first local mutation", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const repositoryDirectory = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && /^[a-f0-9]{16}$/.test(entry.name))?.name;
  assert.ok(repositoryDirectory);
  const cacheRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, repositoryDirectory);
  const legacyPath = path.join(cacheRoot, "skill-locations-local.json");
  const currentPath = path.join(cacheRoot, "shared-resources-local.json");
  fs.rmSync(currentPath, { force: true });
  fs.writeFileSync(legacyPath, JSON.stringify({
    version: 2,
    mounts: [],
    overrides: [{ assignmentId: "project-demo-codex", projectId: "demo", disabled: false, exclude: ["demo-workflow"] }],
    providerOverrides: [],
    pendingImports: [],
  }, null, 2) + "\n", { mode: 0o600 });

  const compatible = readSharedSkillLocalState(fixture.project);
  assert.equal(compatible.version, 3);
  assert.deepEqual(compatible.overrides[0].exclude, ["demo-workflow"]);
  assert.equal(fs.existsSync(currentPath), false);

  setSharedSkillProviderOverride(fixture.project, { provider: "codex", state: "enabled" });
  const migrated = JSON.parse(fs.readFileSync(currentPath, "utf8"));
  assert.equal(migrated.version, 3);
  assert.deepEqual(migrated.skillOverrides[0].exclude, ["demo-workflow"]);
  assert.deepEqual(migrated.pendingInstructionImports, []);
  const schema = JSON.parse(fs.readFileSync(new URL("../schemas/shared-resource-local-state.schema.json", import.meta.url), "utf8"));
  const validate = new Ajv2020({ allErrors: true }).compile(schema);
  assert.equal(validate(migrated), true, JSON.stringify(validate.errors));
});

test("provider settings roll back both local files when reconciliation fails", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  setSharedSkillProviderSettings(fixture.project, { providers: { codex: "disabled" }, projectOverrides: { codex: "disabled" } });
  const beforeGlobal = sharedSkillProviderPreferences();
  const beforeLocal = readSharedSkillLocalState(fixture.project);
  fs.writeFileSync(path.join(fixture.project, ".context-room/config.json"), "{ invalid json", "utf8");

  assert.throws(
    () => setSharedSkillProviderSettings(fixture.project, { providers: { codex: "enabled" }, projectOverrides: { codex: "enabled" } }),
  );
  assert.deepEqual(sharedSkillProviderPreferences(), beforeGlobal);
  assert.deepEqual(readSharedSkillLocalState(fixture.project), beforeLocal);
});

test("shared skills CLI separates assignment proposals from local destination links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "project-demo", title: "Demo skills", path: "projects/demo/skills" }],
    assignments: [{ id: "project-demo-codex", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex"], include: ["*"], exclude: [] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "skill-locations.json"]);
  git(fixture.seed, ["commit", "-m", "Declare accepted skill assignment"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const cliEnv = { ...process.env, NODE_TEST_CONTEXT: "1", CODEX_THREAD_ID: "" };
  const runSkills = (args) => JSON.parse(execFileSync(process.execPath, [cli, "shared", "skills", ...args, "--root", fixture.project], { encoding: "utf8", env: cliEnv })).data;
  const assignPlan = runSkills(["assign", "--collection", "project-demo", "--assignment", "project-demo-team", "--providers", "claude-code,opencode", "--scope", "shared", "--description", "Share demo skills with every registered project."]);
  assert.equal(assignPlan.proposalRequired, true);
  assert.equal(assignPlan.preview.assignment.scope, "shared");
  const assign = runSkills(["assign", "--apply", assignPlan.planId]);
  assert.equal(assign.result.proposal.scope, "skills");
  assert.match(assign.result.proposal.branch, /^proposal\//);
  assert.equal(fs.existsSync(path.join(fixture.project, ".claude/skills/demo-workflow")), false);

  const destination = path.join(fixture.base, "cli-skills");
  const linkPlan = runSkills(["link", "--assignment", "project-demo-codex", "--provider", "custom", "--destination", destination]);
  assert.equal(linkPlan.localOnly, true);
  const linked = runSkills(["link", "--apply", linkPlan.planId]);
  assert.equal(fs.lstatSync(path.join(destination, "demo-workflow")).isSymbolicLink(), true);
  const unlinkPlan = runSkills(["unlink", "--id", linked.result.mount.id]);
  runSkills(["unlink", "--apply", unlinkPlan.planId]);
  assert.equal(fs.existsSync(path.join(destination, "demo-workflow")), false);

  const unassignPlan = runSkills(["unassign", "--assignment", "project-demo-codex", "--description", "Remove the accepted Codex assignment."]);
  assert.equal(unassignPlan.proposalRequired, true);
  const unassign = runSkills(["unassign", "--apply", unassignPlan.planId]);
  assert.equal(unassign.result.proposal.scope, "skills");
  assert.match(unassign.result.proposal.branch, /^proposal\//);
  assert.equal(unassign.result.collectionRemoved, true);
  assert.equal(fs.lstatSync(path.join(fixture.project, ".agents/skills/demo-workflow")).isSymbolicLink(), true);
});

test("shared scope reaches every registered project location and never discovers an unregistered root", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const catalog = JSON.parse(fs.readFileSync(path.join(fixture.seed, "projects.json"), "utf8"));
  catalog.projects.push({ id: "other", title: "Other" });
  writeFile(fixture.seed, "projects.json", JSON.stringify(catalog, null, 2) + "\n");
  writeFile(fixture.seed, "projects/other/docs/README.md", "# Other\n");
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({ version: 1, collections: [{ id: "team", title: "Team", path: "skills/global" }], assignments: [{ id: "team-shared", collectionId: "team", scope: "shared", providers: ["codex"], include: ["*"], exclude: [] }] }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add shared scope assignment"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const otherRoot = path.join(fixture.base, "other-project");
  const unregisteredRoot = path.join(fixture.base, "not-registered");
  fs.mkdirSync(otherRoot, { recursive: true });
  fs.mkdirSync(unregisteredRoot, { recursive: true });
  initializeContextRoomProject(otherRoot, { title: "Other" });
  initializeContextRoomProject(unregisteredRoot, { title: "Not registered" });
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  connectSharedContext(otherRoot, { repository: fixture.remote, projectId: "other" });
  syncSharedContext(fixture.project, { allowOffline: false });

  const preview = previewSharedSkillAssignment(fixture.project, { collectionId: "team", scope: "shared", providers: ["codex"] });
  assert.deepEqual(preview.affectedLocations.sort(), [fs.realpathSync(fixture.project), fs.realpathSync(otherRoot)].sort());

  assert.equal(fs.lstatSync(path.join(fixture.project, ".agents/skills/global-workflow")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(otherRoot, ".agents/skills/global-workflow")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(unregisteredRoot, ".agents/skills/global-workflow")), false);
});

test("device assignments materialize one physical provider link across registered worktrees", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const secondRoot = path.join(fixture.base, "demo-second-worktree");
  fs.mkdirSync(secondRoot, { recursive: true });
  initializeContextRoomProject(secondRoot, { title: "Demo second" });
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  connectSharedContext(secondRoot, { repository: fixture.remote, projectId: "demo" });
  syncSharedContext(fixture.project, { allowOffline: false });

  const deviceDirectory = path.join(process.env.HOME, ".agents/skills");
  assert.equal(fs.readdirSync(deviceDirectory).filter((name) => name === "global-workflow").length, 1);
  assert.equal(sharedSkillLocationsStatus(fixture.project, { refresh: false }).destinations.filter((item) => item.scope === "device" && item.provider === "codex").length, 1);
});

test("provider preferences remove only managed links and project overrides take precedence", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const managed = path.join(fixture.project, ".agents/skills/demo-workflow");
  const unmanaged = path.join(fixture.project, ".claude/skills/local-owner/SKILL.md");
  writeFile(fixture.project, ".claude/skills/local-owner/SKILL.md", "# Local owner\n");

  const disabled = setSharedSkillProviderPreferences(fixture.project, { providers: { codex: "disabled" } });
  assert.equal(disabled.status.destinations.every((item) => item.provider !== "codex" || item.status === "provider-disabled"), true);
  assert.equal(fs.existsSync(managed), false);
  assert.equal(fs.readFileSync(unmanaged, "utf8"), "# Local owner\n");

  const enabled = setSharedSkillProviderOverride(fixture.project, { provider: "codex", state: "enabled" });
  assert.equal(enabled.status.projectProviderOverrides.codex, "enabled");
  assert.equal(fs.lstatSync(managed).isSymbolicLink(), true);
  setSharedSkillProviderOverride(fixture.project, { provider: "codex", state: "inherit" });
  assert.equal(fs.existsSync(managed), false);
});

test("assignment and unassignment changes publish skills proposals without local mutations", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const preview = previewSharedSkillAssignment(fixture.project, { collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex", "claude-code"] });
  assert.equal(preview.proposalRequired, true);
  const assigned = proposeSharedSkillAssignment(fixture.project, { ...preview.assignment, title: "Assign demo skills", description: "Assign the accepted demo collection to Codex and Claude Code.", sessionId: "assignment-proposal" });
  assert.equal(assigned.localFilesChanged, false);
  git(fixture.seed, ["fetch", "origin", assigned.proposal.branch]);
  const assignedManifest = JSON.parse(git(fixture.seed, ["show", `origin/${assigned.proposal.branch}:skill-locations.json`]));
  assert.deepEqual(assignedManifest.assignments.find((item) => item.id === preview.assignment.id).providers, ["codex", "claude-code"]);

  const unassigned = proposeSharedSkillUnassignment(fixture.project, { assignmentId: "project-demo-codex", title: "Unassign legacy demo skills", description: "Remove the legacy project assignment through a skills proposal.", sessionId: "unassignment-proposal" });
  git(fixture.seed, ["fetch", "origin", unassigned.proposal.branch]);
  const unassignedManifest = JSON.parse(git(fixture.seed, ["show", `origin/${unassigned.proposal.branch}:skill-locations.json`]));
  assert.equal(unassignedManifest.assignments.some((item) => item.id === "project-demo-codex"), false);
  assert.equal(unassignedManifest.collections.some((item) => item.id === "project-demo"), false);
});

test("skill import stays local until its skills proposal is accepted, then archives originals and links the snapshot", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const localSkills = path.join(fixture.base, "incoming-skills");
  writeFile(localSkills, "team-review/SKILL.md", "---\nname: team-review\ndescription: Shared review workflow.\n---\n\n# Team review\n");

  const imported = importSharedSkills(fixture.project, {
    sourceDirectory: localSkills,
    collectionId: "team-skills",
    collectionTitle: "Team skills",
    collectionPath: "skills/team",
    skills: ["team-review"],
    providers: ["codex"],
    destination: localSkills,
    sessionId: "skills-import-test",
  });
  assert.equal(imported.localFilesChanged, false);
  assert.equal(fs.lstatSync(path.join(localSkills, "team-review")).isDirectory(), true);
  assert.match(imported.proposal.branch, /^proposal\/skills\//);
  git(fixture.seed, ["fetch", "origin", imported.proposal.branch]);
  assert.equal(git(fixture.seed, ["show", `origin/${imported.proposal.branch}:skills/team/team-review/SKILL.md`]).includes("Team review"), true);
  assert.throws(() => git(fixture.seed, ["show", "origin/main:skill-locations.json"]));

  const review = materializeSharedReview(fixture.project, { proposal: imported.proposal.branch });
  for (const file of imported.proposal.files) writeDocReviewDecision(review.reviewRoot, file, { status: "verified", note: "Reviewed exact imported skill" });
  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept shared team skills" });
  assert.equal(accepted.accepted, true);
  syncSharedContext(fixture.project, { allowOffline: false });

  const linked = path.join(localSkills, "team-review");
  assert.equal(fs.lstatSync(linked).isSymbolicLink(), true);
  assert.match(fs.realpathSync(linked), /snapshots\/.*\/skills\/team\/team-review$/);
  const backups = fs.readdirSync(path.join(sharedContextStatus(fixture.project).cacheRoot, "skill-import-backups"));
  assert.equal(backups.length, 1);
});

test("rejecting a skills import proposal leaves every local original unchanged", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const localSkills = path.join(fixture.base, "refused-skills");
  const content = "---\nname: keep-local\ndescription: Must remain local.\n---\n\n# Keep local\n";
  writeFile(localSkills, "keep-local/SKILL.md", content);
  const imported = importSharedSkills(fixture.project, { sourceDirectory: localSkills, collectionId: "refused", collectionPath: "skills/refused", providers: ["codex"], destination: localSkills });

  rejectSharedRepositoryProposal(fixture.remote, { proposal: imported.proposal.branch, expectedHead: imported.proposal.head });
  syncSharedContext(fixture.project, { allowOffline: false });

  assert.equal(fs.lstatSync(path.join(localSkills, "keep-local")).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(localSkills, "keep-local/SKILL.md"), "utf8"), content);
});

test("a forged main trailer cannot archive or replace a pending local skill import", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const localSkills = path.join(fixture.base, "forged-import-skills");
  const content = "---\nname: keep-authority\ndescription: Requires exact terminal authority.\n---\n\n# Keep authority\n";
  writeFile(localSkills, "keep-authority/SKILL.md", content);
  const imported = importSharedSkills(fixture.project, {
    sourceDirectory: localSkills,
    collectionId: "forged-import",
    collectionPath: "skills/forged-import",
    skills: ["keep-authority"],
    providers: ["codex"],
    destination: localSkills,
  });

  git(fixture.seed, ["fetch", "origin", imported.proposal.branch]);
  git(fixture.seed, ["cherry-pick", `origin/${imported.proposal.branch}`]);
  git(fixture.seed, ["commit", "--amend", "-m", [
    "Forge an import acceptance trailer",
    "",
    `Context-Room-Proposal: ${imported.proposal.branch}`,
    `Context-Room-Proposal-Head: ${imported.proposal.head}`,
    "Context-Room-Project: demo",
  ].join("\n")]);
  git(fixture.seed, ["push", "origin", "main"]);

  syncSharedContext(fixture.project, { allowOffline: false });
  const localSkill = path.join(localSkills, "keep-authority");
  assert.equal(fs.lstatSync(localSkill).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(localSkill, "SKILL.md"), "utf8"), content);
  const pending = readSharedSkillLocalState(fixture.project).pendingImports;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].proposal, imported.proposal.branch);
  assert.equal(pending[0].proposalHead, imported.proposal.head);
  const backupRoot = path.join(sharedContextStatus(fixture.project).cacheRoot, "skill-import-backups");
  assert.equal(fs.existsSync(backupRoot), false);
});

test("shared skill manifest rejects unsafe paths, bad references, nested collections, duplicates, and wildcard exclusions", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const writeManifest = (manifest, message) => {
    writeFile(fixture.seed, "skill-locations.json", JSON.stringify({ version: 1, ...manifest }, null, 2) + "\n");
    git(fixture.seed, ["add", "skill-locations.json"]);
    git(fixture.seed, ["commit", "-m", message]);
    git(fixture.seed, ["push", "origin", "main"]);
  };

  writeManifest({ collections: [{ id: "unsafe", title: "Unsafe", path: "../skills" }], assignments: [] }, "Unsafe skill path");
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), /safe repository-relative path/);

  writeManifest({ collections: [{ id: "one", title: "One", path: "skills/one" }], assignments: [{ id: "bad-ref", collectionId: "missing", scope: "device", providers: ["codex"] }] }, "Bad collection reference");
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), /unknown collection/);

  writeManifest({ collections: [{ id: "one", title: "One", path: "skills/one" }, { id: "nested", title: "Nested", path: "skills/one/nested" }], assignments: [] }, "Nested collections");
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), /must not overlap/);

  writeManifest({ collections: [{ id: "same", title: "One", path: "skills/one" }, { id: "same", title: "Two", path: "skills/two" }], assignments: [] }, "Duplicate collections");
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), /Duplicate shared skill collection id/);

  writeManifest({ collections: [{ id: "one", title: "One", path: "skills/one" }], assignments: [{ id: "bad-exclude", collectionId: "one", scope: "device", providers: ["codex"], include: ["*"], exclude: ["*"] }] }, "Invalid wildcard exclusion");
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), /cannot exclude \*/);

  writeManifest({ collections: [{ id: "one", title: "One", path: "skills/one" }], assignments: [{ id: "bad-provider", collectionId: "one", scope: "device", providers: ["unknown-agent"] }] }, "Unsupported provider");
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), /unsupported provider/);

  writeManifest({ collections: [{ id: "one", title: "One", path: "skills/one" }], assignments: [{ id: "missing-projects", collectionId: "one", scope: "project", providers: ["codex"] }] }, "Missing project ids");
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), /must declare projectIds/);
});

test("shared skill and instruction collection trees must remain disjoint", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "shared-collections/team/demo/SKILL.md", "# Team skill\n");
  writeFile(fixture.seed, "shared-collections/team/instructions/AGENTS.md", "# Team instructions\n");
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team-skills", title: "Team skills", path: "shared-collections/team" }],
    assignments: [{ id: "team-skills-demo", collectionId: "team-skills", scope: "project", projectIds: ["demo"], providers: ["codex"], include: ["*"], exclude: [] }],
  }, null, 2) + "\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team-instructions", title: "Team instructions", path: "shared-collections/team/instructions" }],
    assignments: [{ id: "team-instructions-demo", collectionId: "team-instructions", scope: "project", projectIds: ["demo"], files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Overlap shared collection trees"]);
  git(fixture.seed, ["push", "origin", "main"]);

  assert.throws(
    () => connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" }),
    /Shared skill collection team-skills overlaps shared instruction collection team-instructions/,
  );
});

test("explicit skill collections cannot overlap the always-visible global skills root", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "skill-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "private-global", title: "Private global", path: "skills/global/private" }],
    assignments: [{ id: "private-global-demo", collectionId: "private-global", scope: "project", projectIds: ["demo"], providers: ["codex"], include: ["*"], exclude: [] }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "skill-locations.json"]);
  git(fixture.seed, ["commit", "-m", "Overlap global skills root"]);
  git(fixture.seed, ["push", "origin", "main"]);

  assert.throws(
    () => connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" }),
    /Shared skill collection private-global overlaps always-visible global skills without a shared or device assignment/,
  );
});

test("instruction collections under project roots require assignment to that visible project", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "projects/demo/docs/instructions/AGENTS.md", "# Hidden instructions\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "project-docs", title: "Project docs", path: "projects/demo/docs/instructions" }],
    assignments: [],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Overlap project docs root"]);
  git(fixture.seed, ["push", "origin", "main"]);

  assert.throws(
    () => connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" }),
    /Shared instruction collection project-docs overlaps an always-visible root without an assignment for demo/,
  );
});

test("a failed first sync rolls back the approved binding, current snapshot, and skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  fs.writeFileSync(path.join(fixture.project, ".context-room/config.json"), "{ invalid json\n", "utf8");

  assert.throws(
    () => connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" }),
    /JSON/,
  );
  assert.equal(readSharedProjectConnection(fixture.project), null);
  assert.equal(fs.existsSync(path.join(process.env.HOME, ".agents/skills/global-workflow")), false);
  assert.equal(fs.existsSync(path.join(fixture.project, ".agents/skills/demo-workflow")), false);
  const cacheDirectory = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .find((entry) => /^[a-f0-9]{16}$/.test(entry));
  assert.ok(cacheDirectory);
  assert.equal(fs.existsSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, cacheDirectory, "current")), false);
});

test("Shared sync rolls back current, config, owners, registries, and links after every reconciliation publication phase", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const initial = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const skillLink = path.join(fixture.project, ".agents", "skills", "demo-workflow");
  const instructionLink = path.join(fixture.project, "AGENTS.md");
  const skillRegistry = fs.readdirSync(path.join(initial.cacheRoot, "skill-links"))
    .map((name) => path.join(initial.cacheRoot, "skill-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  const instructionRegistry = fs.readdirSync(path.join(initial.cacheRoot, "instruction-links"))
    .filter((name) => name !== "device.json")
    .map((name) => path.join(initial.cacheRoot, "instruction-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  const ownerRegistry = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "managed-destinations.json");
  const statePath = path.join(initial.cacheRoot, "state.json");
  const currentPath = path.join(initial.cacheRoot, "current");
  const configPath = path.join(fixture.project, ".context-room", "config.json");
  const trackedFiles = [skillRegistry, instructionRegistry, ownerRegistry, statePath, configPath];
  const baseline = new Map(trackedFiles.map((filePath) => [filePath, {
    content: fs.readFileSync(filePath),
    mode: fs.statSync(filePath).mode & 0o777,
  }]));
  const baselineCurrent = fs.realpathSync(currentPath);
  const baselineSkillTarget = fs.realpathSync(skillLink);

  writeFile(fixture.seed, "projects/demo/skills/demo-workflow/SKILL.md", "---\nname: demo-workflow\ndescription: Demo project workflow v2.\n---\n\n# Demo workflow v2\n");
  writeFile(fixture.seed, "instructions/team/AGENTS.md", "# Shared instructions v2\n");
  writeFile(fixture.seed, "instruction-locations.json", JSON.stringify({
    version: 1,
    collections: [{ id: "team", title: "Team", path: "instructions/team" }],
    assignments: [{
      id: "team-demo",
      collectionId: "team",
      scope: "project",
      projectIds: ["demo"],
      files: [{ source: "AGENTS.md", target: "AGENTS.md", providers: ["codex"] }],
    }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance every Shared reconciliation phase"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const assertBaseline = () => {
    assert.equal(fs.realpathSync(currentPath), baselineCurrent);
    assert.equal(fs.realpathSync(skillLink), baselineSkillTarget);
    assert.equal(fs.existsSync(instructionLink), false);
    for (const [filePath, snapshot] of baseline) {
      assert.deepEqual(fs.readFileSync(filePath), snapshot.content, `${filePath} content must roll back exactly`);
      assert.equal(fs.statSync(filePath).mode & 0o777, snapshot.mode, `${filePath} mode must roll back exactly`);
    }
  };
  const originalWriteFileSync = fs.writeFileSync.bind(fs);
  const originalRenameSync = fs.renameSync.bind(fs);
  const phases = [
    {
      name: "skill-registry",
      install() {
        fs.writeFileSync = (filePath, content, options) => {
          if (path.resolve(String(filePath)) === path.resolve(skillRegistry)) {
            originalWriteFileSync(filePath, "{ partial skill registry\n", options);
            throw new Error("injected skill registry failure");
          }
          return originalWriteFileSync(filePath, content, options);
        };
      },
    },
    {
      name: "instruction-registry",
      install() {
        fs.renameSync = (source, destination) => {
          const result = originalRenameSync(source, destination);
          if (path.resolve(String(destination)) === path.resolve(instructionRegistry)) throw new Error("injected instruction registry failure");
          return result;
        };
      },
    },
    {
      name: "state",
      install() {
        fs.renameSync = (source, destination) => {
          const result = originalRenameSync(source, destination);
          if (path.resolve(String(destination)) === path.resolve(statePath)) throw new Error("injected state publication failure");
          return result;
        };
      },
    },
  ];
  for (const phase of phases) {
    phase.install();
    try {
      assert.throws(() => syncSharedContext(fixture.project, { allowOffline: false }), new RegExp(`injected ${phase.name.replace("-", " ")}`));
    } finally {
      fs.writeFileSync = originalWriteFileSync;
      fs.renameSync = originalRenameSync;
    }
    assertBaseline();
  }

  const synced = syncSharedContext(fixture.project, { allowOffline: false });
  assert.notEqual(synced.revision, initial.revision);
  assert.notEqual(fs.realpathSync(skillLink), baselineSkillTarget);
  assert.equal(fs.lstatSync(instructionLink).isSymbolicLink(), true);
});

test("rebinding replaces only the previously managed paths and skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const first = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const projectLink = path.join(fixture.project, ".agents/skills/demo-workflow");
  const firstTarget = fs.realpathSync(projectLink);
  const secondRemote = path.join(fixture.base, "second-remote.git");
  git(fixture.base, ["clone", "--bare", fixture.seed, secondRemote], { stdio: "ignore" });

  assert.equal(disconnectSharedContext(fixture.project).disconnected, true);
  const second = connectSharedContext(fixture.project, { repository: secondRemote, projectId: "demo" });
  const secondTarget = fs.realpathSync(projectLink);
  assert.notEqual(secondTarget, firstTarget);
  assert.equal(secondTarget.includes(`/${path.basename(second.cacheRoot)}/snapshots/`), true);
  assert.equal(readSharedProjectConnection(fixture.project).repository, secondRemote);

  const settings = readMemoryWebappSettings(fixture.project);
  const firstCacheId = path.basename(first.cacheRoot);
  const secondCacheId = path.basename(second.cacheRoot);
  assert.equal(settings.allowedPaths.some((item) => item.includes(`/shared/${firstCacheId}/current/`)), false);
  assert.equal(settings.readOnlyPaths.some((item) => item.includes(`/shared/${firstCacheId}/current/`)), false);
  assert.equal(settings.allowedPaths.filter((item) => item.includes(`/shared/${secondCacheId}/current/`)).length, 3);
});

test("shared sync advances current atomically and keeps an explicit offline snapshot", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const initial = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  writeFile(fixture.seed, "projects/demo/docs/README.md", "# Demo\n\nUpdated.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Update docs"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const updated = syncSharedContext(fixture.project, { allowOffline: false });
  assert.notEqual(updated.revision, initial.revision);
  assert.equal(fs.readFileSync(path.join(updated.current, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nUpdated.\n");

  fs.renameSync(fixture.remote, fixture.remote + ".offline");
  const offline = syncSharedContext(fixture.project, { allowOffline: true });
  assert.equal(offline.online, false);
  assert.equal(offline.revision, updated.revision);
  assert.match(offline.fetchError, /remote|repository|read/i);
});

test("shared repository refresh bounds a stalled Git fetch", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  stallGitCommand(t, fixture, "fetch");

  const assertFetchTimeout = (operation) => {
    const startedAt = Date.now();
    assert.throws(operation, (error) => {
      assert.equal(error.code, "shared-git-timeout");
      assert.equal(error.retryable, true);
      assert.match(error.message, /Git fetch timed out after 50 ms/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 1_000, "stalled Git fetch should be terminated within the configured budget");
  };

  assertFetchTimeout(() => listSharedRepositoryProposals(fixture.remote, { allowOffline: false, timeoutMs: 50 }));
  assertFetchTimeout(() => syncSharedContext(fixture.project, { allowOffline: false, timeoutMs: 50 }));
  assertFetchTimeout(() => readSharedMainRevision(fixture.remote, { refresh: true, timeoutMs: 50 }));
});

test("proposal publication bounds a stalled Git push and remains retryable", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Bound proposal push",
    branch: "proposal/demo/bound-proposal-push",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nBound proposal push.\n");
  const restoreGit = stallGitCommand(t, fixture, "push");

  const startedAt = Date.now();
  assert.throws(
    () => publishSharedProposal(fixture.project, { proposal: proposal.branch, timeoutMs: 1_000 }),
    (error) => {
      assert.equal(error.code, "shared-git-timeout");
      assert.equal(error.retryable, true);
      assert.match(error.message, /Git push timed out after 1000 ms/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 9_000, "stalled proposal push should be terminated before the fake 10-second push completes");
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]), "");

  restoreGit();
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch, timeoutMs: 3_000 });
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0], published.head);
});

test("proposal rejection bounds a stalled archive push without recording a terminal decision", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Bound rejection push",
    branch: "proposal/demo/bound-rejection-push",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nBound rejection push.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const rejectionBranch = `rejected/demo/bound-rejection-push-${published.head.slice(0, 12)}`;
  const restoreGit = stallGitCommand(t, fixture, "push");

  const startedAt = Date.now();
  assert.throws(
    () => rejectSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
      timeoutMs: 1_000,
    }),
    (error) => {
      assert.equal(error.code, "shared-git-timeout");
      assert.equal(error.retryable, true);
      assert.match(error.message, /Git push timed out after 1000 ms/);
      return true;
    },
  );
  assert.ok(Date.now() - startedAt < 9_000, "stalled rejection push should be terminated before the fake 10-second push completes");
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", rejectionBranch]), "");
  assert.equal(fs.existsSync(proposal.root), true);
  assert.equal(listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals.some((item) => item.branch === proposal.branch), true);

  restoreGit();
  const rejected = rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
    timeoutMs: 3_000,
  });
  assert.equal(rejected.rejected, true);
});

test("proposal branches stay scoped and partial acceptance reaches newer non-conflicting main", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Clarify demo",
    description: "Clarify the accepted and rejected sentences in the demo documentation.",
    branch: "proposal/demo/clarify-demo",
    sessionId: "task-clarify-123",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted sentence.\n\nRejected sentence.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch, message: "Clarify demo docs" });
  assert.equal(published.files.includes("projects/demo/docs/README.md"), true);
  const listed = listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch);
  assert.equal(listed.head, published.head);
  assert.equal(listed.title, "Clarify demo");
  assert.equal(listed.description, "Clarify the accepted and rejected sentences in the demo documentation.");
  assert.equal(listed.sessionId, "task-clarify-123");
  assert.deepEqual(listed.files, ["projects/demo/docs/README.md"]);
  assert.equal(listed.fileCount, 1);

  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.equal(review.metadata.sessionId, "task-clarify-123");
  const reopenedReview = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.equal(reopenedReview.reused, true);
  assert.equal(fs.realpathSync(reopenedReview.reviewRoot), fs.realpathSync(review.reviewRoot));
  writeFile(review.reviewRoot, "projects/demo/docs/README.md", "# Demo\n\nAccepted sentence.\n");
  initializeContextRoomProject(review.reviewRoot, {
    allowedPaths: ["projects/demo/docs/"],
    watchAllow: ["projects/demo/docs/"],
  });
  const pendingReport = buildDocQaReport(review.reviewRoot);
  assert.deepEqual(pendingReport.reviewedPaths, []);
  assert.deepEqual(pendingReport.pendingPaths, ["projects/demo/docs/README.md"]);
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", { status: "verified", note: "Exact proposal file reviewed" });
  const reviewedReport = buildDocQaReport(review.reviewRoot);
  assert.deepEqual(reviewedReport.pendingPaths, []);
  assert.deepEqual(reviewedReport.reviewedPaths, ["projects/demo/docs/README.md"]);

  writeFile(fixture.seed, "projects/demo/docs/OTHER.md", "# Other\n\nAlready accepted on main.\n");
  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance main independently"]);
  git(fixture.seed, ["push", "origin", "main"]);

  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept selected demo changes" });
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.delivery, "main");
  assert.equal(accepted.defaultBranch, "main");
  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(fs.readFileSync(path.join(fixture.seed, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nAccepted sentence.\n");
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/OTHER.md")), true);
  assert.equal(
    git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]),
    "# Demo\n\nAccepted sentence.",
  );
  assert.equal(
    git(fixture.seed, ["show", "origin/main:projects/demo/docs/OTHER.md"]),
    "# Other\n\nAlready accepted on main.",
  );
  const retried = acceptSharedReview(review.reviewRoot);
  assert.equal(retried.accepted, true);
  assert.equal(retried.deliveryVerified, true);
  assert.equal(retried.commit, accepted.commit);
});

test("whole-file review evidence expires when accepted main changes the same reviewed path", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const relativePath = "projects/demo/docs/README.md";
  const baseContent = "# Demo\n\nParagraph A.\n\nParagraph B.\n\nParagraph C.\n";
  writeFile(fixture.seed, relativePath, baseContent);
  git(fixture.seed, ["add", relativePath]);
  git(fixture.seed, ["commit", "-m", "Add independently mergeable paragraphs"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const proposal = createSharedProposal(fixture.project, {
    title: "Review one exact whole file",
    branch: "proposal/demo/exact-whole-file-main-drift",
  });
  configureGit(proposal.root);
  const reviewedContent = "# Demo\n\nProposal A reviewed.\n\nParagraph B.\n\nParagraph C.\n";
  writeFile(proposal.root, relativePath, reviewedContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, {
    proposal: proposal.branch,
    expectedHead: published.head,
  });
  initializeContextRoomProject(review.reviewRoot, {
    title: "Exact whole-file review",
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });
  writeDocReviewDecision(review.reviewRoot, relativePath, {
    status: "verified",
    note: "Reviewed the exact proposal file before main advanced",
  });

  const mainContent = "# Demo\n\nParagraph A.\n\nParagraph B.\n\nMain C accepted later.\n";
  writeFile(fixture.seed, relativePath, mainContent);
  git(fixture.seed, ["add", relativePath]);
  git(fixture.seed, ["commit", "-m", "Advance the same file on accepted main"]);
  git(fixture.seed, ["push", "origin", "main"]);
  const advancedMain = git(fixture.seed, ["rev-parse", "HEAD"]);

  assert.throws(
    () => acceptSharedReview(review.reviewRoot, { message: "Refuse stale whole-file evidence" }),
    (error) => {
      assert.equal(error.code, "shared-review-base-stale");
      assert.equal(error.statusCode, 409);
      assert.equal(error.retryable, true);
      assert.deepEqual(error.details.paths, [relativePath]);
      assert.equal(error.details.reviewedBase, review.metadata.baseRevision);
      assert.equal(error.details.currentMain, advancedMain);
      return true;
    },
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), advancedMain);
  assert.equal(git(fixture.remote, ["show", `refs/heads/main:${relativePath}`]), mainContent.trim());

  const refreshed = materializeSharedReview(fixture.project, {
    proposal: proposal.branch,
    expectedHead: published.head,
  });
  assert.notEqual(refreshed.reviewRoot, review.reviewRoot);
  assert.equal(refreshed.metadata.baseRevision, advancedMain);
  assert.equal(
    fs.readFileSync(path.join(refreshed.reviewRoot, relativePath), "utf8"),
    "# Demo\n\nProposal A reviewed.\n\nParagraph B.\n\nMain C accepted later.\n",
  );
});

test("shared proposal reviews include unchanged direct dependents", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "projects/demo/docs/TRUST.md", "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nHuman approval.\n");
  writeFile(fixture.seed, "projects/demo/docs/REVIEW.md", "---\ncontext_room:\n  id: product.review\n  depends_on:\n    - strategy.trust\n---\n\n# Review\n\nApply trust policy.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add dependent docs"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const proposal = createSharedProposal(fixture.project, {
    title: "Tighten trust",
    description: "Change the accepted trust rule and require dependent review.",
    branch: "proposal/demo/tighten-trust",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/TRUST.md", "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nExact human approval.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch, message: "Tighten trust" });

  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.deepEqual(review.metadata.dependencyReviews, [{
    path: "projects/demo/docs/REVIEW.md",
    documentId: "product.review",
    dependencies: ["strategy.trust"],
  }]);
  assert.deepEqual(review.metadata.proposalFiles.sort(), [
    "projects/demo/docs/REVIEW.md",
    "projects/demo/docs/TRUST.md",
  ]);
  assert.deepEqual(review.metadata.proposalChanges, [
    {
      path: "projects/demo/docs/TRUST.md",
      status: "M",
      fromPath: null,
      score: null,
      reviewKind: "proposal-change",
    },
    {
      path: "projects/demo/docs/REVIEW.md",
      status: null,
      fromPath: null,
      score: null,
      reviewKind: "dependency-review",
    },
  ]);
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/TRUST.md", { status: "verified", note: "Reviewed changed trust state" });
  configureGit(review.reviewRoot);
  assert.throws(
    () => acceptSharedReview(review.reviewRoot, { message: "Attempt incomplete dependency acceptance" }),
    /projects\/demo\/docs\/REVIEW\.md/,
  );
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/REVIEW.md", { status: "verified", note: "Reviewed exact dependent state" });
  acceptSharedReview(review.reviewRoot, { message: "Accept reviewed dependency update" });
  const main = readSharedMainRevision(fixture.remote, { refresh: true });
  assert.equal(main.commit.dependencyReviewRequired.length, 0);
  const dependentProof = main.commit.dependencyProof.documents.find((item) => item.path === "projects/demo/docs/REVIEW.md");
  assert.match(dependentProof.blob, /^[a-f0-9]{40}$/);
  assert.equal(dependentProof.mode, "100644");
  assert.equal(main.commit.dependencyProofError, "");
});

test("shared acceptance uses a deterministic command-local Git identity", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Service identity", branch: "proposal/demo/service-identity" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted without ambient Git identity.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", { status: "verified", note: "Exact proposal file reviewed" });

  const emptyGlobalConfig = path.join(fixture.base, "empty-global-gitconfig");
  const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  try {
    const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept with Context Room identity" });
    assert.equal(accepted.accepted, true);
  } finally {
    if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
  }
  assert.equal(fs.existsSync(emptyGlobalConfig), false);
  git(fixture.seed, ["fetch", "origin"]);
  assert.equal(git(fixture.seed, ["show", "-s", "--format=%an <%ae>", "origin/main"]), "Context Room <context-room@localhost>");
});

test("proposal updates require and expose fresh descriptive metadata, and expire an earlier review", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  assert.throws(
    () => execFileSync(process.execPath, [cli, "shared", "propose", "--root", fixture.project, "--title", "Missing description"], { encoding: "utf8" }),
    (error) => /--description is required when creating a proposal/.test(String(error.stderr || "")),
  );
  const proposal = createSharedProposal(fixture.project, {
    title: "Change",
    description: "Describe the first proposal version.",
    branch: "proposal/demo/change",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nFirst proposal.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.equal(listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch).reviewStatus, "in_review");

  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nChanged proposal.\n");
  assert.throws(
    () => publishSharedProposal(fixture.project, { proposal: proposal.branch, message: "Change proposal after review" }),
    /--description is required whenever a published proposal is updated/,
  );
  const republished = publishSharedProposal(fixture.project, {
    proposal: proposal.branch,
    title: "Change demo guidance",
    description: "The updated proposal now replaces the first sentence with the final guidance.",
    message: "Change proposal after review",
  });
  const listed = listSharedProposals(fixture.project).find((item) => item.branch === proposal.branch);
  assert.equal(listed.head, republished.head);
  assert.equal(listed.title, "Change demo guidance");
  assert.equal(listed.description, "The updated proposal now replaces the first sentence with the final guidance.");
  assert.equal(listed.reviewStatus, "updated");
  assert.equal(listed.updatedSinceReview, true);
  assert.throws(() => acceptSharedReview(review.reviewRoot), /Proposal changed after review/);
});

test("session-scoped proposal ensure reuses one workspace per project or global scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const first = ensureSharedProposal(fixture.project, {
    title: "Document the session",
    description: "Summarize every documentation change from this working session.",
    sessionId: "session-docs-123",
  });
  writeFile(first.root, "projects/demo/docs/README.md", "# Demo\n\nStill being edited.\n");
  const reused = ensureSharedProposal(fixture.project, {
    title: "A later message in the same session",
    description: "This input must not create another proposal workspace.",
    sessionId: "session-docs-123",
  });
  assert.equal(first.reused, false);
  assert.equal(reused.reused, true);
  assert.equal(reused.branch, first.branch);
  assert.equal(reused.root, first.root);
  assert.equal(fs.readFileSync(path.join(reused.root, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nStill being edited.\n");

  const global = ensureSharedProposal(fixture.project, {
    title: "Update the global workflow",
    description: "Keep global skills in a separate proposal with the same session identity.",
    scope: "global",
    sessionId: "session-docs-123",
  });
  assert.equal(global.reused, false);
  assert.notEqual(global.branch, first.branch);
  assert.match(global.branch, /^proposal\/global\//);
});

test("a published session proposal can be rehydrated after its local workspace is removed", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = ensureSharedProposal(fixture.project, {
    title: "Resume on another checkout",
    description: "Publish a proposal that can be attached again from its commit metadata.",
    sessionId: "session-resume-123",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nPublished session proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const sharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const registryPath = fs.readdirSync(sharedHome)
    .map((entry) => path.join(sharedHome, entry, "proposals.json"))
    .find((candidate) => fs.existsSync(candidate));
  const checkout = path.join(path.dirname(registryPath), "repository");
  git(checkout, ["worktree", "remove", "--force", proposal.root]);
  const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));
  delete registry.proposals[proposal.branch];
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2) + "\n");

  const resumed = ensureSharedProposal(fixture.project, {
    title: "Ignored because the remote proposal is authoritative",
    description: "Ignored until the proposal is republished with a fresh cumulative description.",
    sessionId: "session-resume-123",
  });
  assert.equal(resumed.reused, true);
  assert.equal(resumed.branch, proposal.branch);
  assert.equal(git(resumed.root, ["rev-parse", "HEAD"]), published.head);
  assert.equal(fs.readFileSync(path.join(resumed.root, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nPublished session proposal.\n");

  const review = materializeSharedReview(fixture.project, { proposal: resumed.branch, expectedHead: published.head });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", { status: "verified", note: "Reviewed before terminal reuse check" });
  assert.equal(acceptSharedReview(review.reviewRoot).accepted, true);
  const afterAcceptance = ensureSharedProposal(fixture.project, {
    title: "Start fresh after terminal acceptance",
    description: "A terminal proposal from this session must never be reopened or reused.",
    sessionId: "session-resume-123",
  });
  assert.equal(afterAcceptance.reused, false);
  assert.notEqual(afterAcceptance.branch, proposal.branch);
});

test("a shared-only repository can open an exact proposal workspace without local bindings or skill reconciliation", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const baseRevision = git(fixture.seed, ["rev-parse", "main"]);
  const branch = "proposal/demo/repository-only-open";
  git(fixture.seed, ["switch", "-c", branch]);
  writeFile(fixture.seed, "projects/demo/docs/README.md", "# Demo\n\nRepository-only proposal.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", `Open from the shared repository\n\nContext-Room-Title: Repository-only proposal\nContext-Room-Project: demo\nContext-Room-Base: ${baseRevision}`]);
  const proposalHead = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", branch]);
  git(fixture.seed, ["switch", "main"]);

  assert.deepEqual(listRegisteredSharedBindings(fixture.remote), []);
  assert.equal(fs.existsSync(path.join(process.env.HOME, ".agents/skills/global-workflow")), false);
  assert.equal(fs.existsSync(path.join(fixture.project, ".agents/skills/demo-workflow")), false);

  const opened = openSharedRepositoryProposalWorkspace(fixture.remote, { proposal: branch });
  assert.equal(opened.branch, branch);
  assert.equal(opened.head, proposalHead);
  assert.equal(opened.baseRevision, baseRevision);
  assert.equal(opened.projectId, "demo");
  assert.equal(opened.reused, true);
  assert.equal(fs.readFileSync(path.join(opened.root, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nRepository-only proposal.\n");
  configureGit(opened.root);
  writeFile(opened.root, "projects/demo/docs/README.md", "# Demo\n\nRepository-only proposal updated.\n");
  const republished = publishSharedRepositoryProposal(fixture.remote, {
    proposal: branch,
    expectedHead: opened.head,
    description: "Update the repository-only proposal without a local project binding.",
  });
  assert.notEqual(republished.head, proposalHead);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", branch]).split(/\s+/)[0], republished.head);
  assert.deepEqual(listRegisteredSharedBindings(fixture.remote), []);
  assert.equal(fs.existsSync(path.join(process.env.HOME, ".agents/skills/global-workflow")), false);
  assert.equal(fs.existsSync(path.join(fixture.project, ".agents/skills/demo-workflow")), false);
});

test("publishing an opened proposal refuses a remotely advanced head before mutating the worktree", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Guard opened proposal head",
    branch: "proposal/demo/guard-opened-head",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nInitial proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const opened = openSharedRepositoryProposalWorkspace(fixture.remote, { proposal: proposal.branch });

  git(fixture.seed, ["fetch", "origin", proposal.branch]);
  git(fixture.seed, ["switch", "--detach", `origin/${proposal.branch}`]);
  writeFile(fixture.seed, "projects/demo/docs/EXTERNAL.md", "# External proposal update\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance proposal elsewhere"]);
  const externalHead = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", `HEAD:refs/heads/${proposal.branch}`]);
  git(fixture.seed, ["switch", "main"]);
  writeFile(fixture.seed, "projects/demo/docs/MAIN.md", "# Main advanced too\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Advance main after opening proposal"]);
  git(fixture.seed, ["push", "origin", "main"]);

  writeFile(opened.root, "projects/demo/docs/README.md", "# Demo\n\nLocal stale update.\n");
  const localHead = git(opened.root, ["rev-parse", "HEAD"]);
  assert.equal(localHead, published.head);
  assert.throws(
    () => publishSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: opened.head,
      description: "Attempt to publish from the stale opened handle.",
    }),
    (error) => {
      assert.equal(error.code, "shared-proposal-stale");
      assert.equal(error.retryable, true);
      assert.equal(error.details.expectedHead, opened.head);
      assert.equal(error.details.actualHead, externalHead);
      return true;
    },
  );
  assert.equal(git(opened.root, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(opened.root, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0], externalHead);
});

test("an explicit absent proposal head is an atomic publish precondition", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Guard initially absent proposal head",
    branch: "proposal/demo/guard-absent-head",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nInitial proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nA stale absent-head handle must not publish.\n");
  const localHead = git(proposal.root, ["rev-parse", "HEAD"]);

  assert.throws(
    () => publishSharedProposal(fixture.project, {
      proposal: proposal.branch,
      expectedHead: "",
    }),
    (error) => {
      assert.equal(error.code, "shared-proposal-stale");
      assert.equal(error.retryable, true);
      assert.equal(error.details.expectedHead, "");
      assert.equal(error.details.actualHead, published.head);
      return true;
    },
  );
  assert.equal(git(proposal.root, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(proposal.root, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0], published.head);
});

test("publishing refuses a remotely rejected terminal proposal before mutating the worktree", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Guard terminal proposal",
    branch: "proposal/demo/guard-terminal",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nPublished proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const localHome = process.env.HOME;
  const localSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const rejectingHome = path.join(fixture.base, "remote-rejecting-owner");
  process.env.HOME = rejectingHome;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(rejectingHome, ".context-room", "shared");
  try {
    rejectSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
      actor: "terminal-publish-guard-owner",
    });
  } finally {
    process.env.HOME = localHome;
    process.env.CONTEXT_ROOM_SHARED_HOME = localSharedHome;
  }
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAttempted terminal update.\n");
  const localHead = git(proposal.root, ["rev-parse", "HEAD"]);

  assert.throws(
    () => publishSharedProposal(fixture.project, {
      proposal: proposal.branch,
      expectedHead: published.head,
      description: "Attempt to republish a rejected proposal.",
    }),
    (error) => {
      assert.equal(error.code, "shared-proposal-terminal");
      assert.equal(error.details.reviewStatus, "rejected");
      return true;
    },
  );
  assert.equal(git(proposal.root, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(proposal.root, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0], published.head);
});

test("opening refuses a remotely rejected terminal proposal", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Guard rejected proposal open",
    branch: "proposal/demo/guard-rejected-open",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nPublished proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
  });

  assert.throws(
    () => openSharedRepositoryProposalWorkspace(fixture.remote, { proposal: proposal.branch }),
    (error) => {
      assert.equal(error.code, "shared-proposal-terminal");
      assert.equal(error.details.proposalHead, published.head);
      assert.equal(error.details.reviewStatus, "rejected");
      return true;
    },
  );
});

test("documentation tools keep proposal inspection explicit while context ask remains accepted-only", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const projectProposal = ensureSharedProposal(fixture.project, {
    title: "Document pending session behavior",
    description: "Add one pending project document and delete one accepted project document.",
    sessionId: "session-overlay-a",
  });
  configureGit(projectProposal.root);
  writeFile(projectProposal.root, "projects/demo/docs/PENDING.md", "# Pending session\n\nPending session alpha.\n");
  fs.rmSync(path.join(projectProposal.root, "projects/demo/docs/README.md"));
  publishSharedProposal(fixture.project, { proposal: projectProposal.branch });

  const globalProposal = ensureSharedProposal(fixture.project, {
    title: "Update global workflow",
    description: "Add pending global guidance for this same documentation session.",
    scope: "global",
    sessionId: "session-overlay-a",
  });
  configureGit(globalProposal.root);
  writeFile(globalProposal.root, "skills/global/global-workflow/SKILL.md", "---\nname: global-workflow\ndescription: Demo global workflow.\n---\n\n# Global workflow\n\nGlobal pending alpha.\n");
  publishSharedProposal(fixture.project, { proposal: globalProposal.branch });

  const otherSession = ensureSharedProposal(fixture.project, {
    title: "Another session",
    description: "This proposal must remain invisible to session overlay A.",
    sessionId: "session-overlay-b",
  });
  configureGit(otherSession.root);
  writeFile(otherSession.root, "projects/demo/docs/OTHER-SESSION.md", "# Other session\n\nInvisible session beta.\n");
  publishSharedProposal(fixture.project, { proposal: otherSession.branch });

  const corpus = buildDocumentationCorpus(fixture.project, { sessionId: "session-overlay-a" });
  assert.equal(corpus.session.id, "session-overlay-a");
  assert.equal(corpus.session.proposals.length, 2);
  assert.ok(corpus.documents.some((document) => document.source === "shared-accepted" && document.repositoryPath === undefined));
  assert.equal(corpus.documents.some((document) => /OTHER-SESSION/.test(document.repositoryPath || "")), false);

  const defaultSearch = searchDocumentation(fixture.project, "Pending session alpha", { sessionId: "session-overlay-a" });
  assert.equal(defaultSearch.results.some((result) => result.truthState === "proposal"), false);
  const pendingSearch = searchDocumentation(fixture.project, "Pending session alpha", { sessionId: "session-overlay-a", status: "proposal" });
  assert.equal(pendingSearch.results[0].repositoryPath, "projects/demo/docs/PENDING.md");
  assert.equal(pendingSearch.results[0].proposal.sessionId, "session-overlay-a");
  assert.equal(pendingSearch.results[0].proposal.head, pendingSearch.results[0].revision);
  const deletion = searchDocumentation(fixture.project, "Deleted in session proposal", { sessionId: "session-overlay-a", status: "proposal" });
  assert.equal(deletion.results[0].repositoryPath, "projects/demo/docs/README.md");
  assert.equal(deletion.results[0].deleted, true);

  const frozen = resolveSharedSessionProposals(fixture.project, { sessionId: "session-overlay-a" });
  const acceptedOnlyCorpus = buildDocumentationCorpus(fixture.project, {
    acceptedOnly: true,
    sessionId: "session-overlay-a",
    proposalOverlay: frozen,
  });
  assert.equal(acceptedOnlyCorpus.access.acceptedOnly, true);
  assert.equal(acceptedOnlyCorpus.session, null);
  assert.equal(acceptedOnlyCorpus.documents.some((document) => document.truthState === "proposal" || document.source === "session-proposal"), false);
  const connectedAcceptedDocument = acceptedOnlyCorpus.documents.find((document) => document.source === "shared-accepted" && /Initial\./.test(document.rawContent || ""));
  assert.ok(connectedAcceptedDocument);
  const acceptedRead = readDocumentation(fixture.project, `${connectedAcceptedDocument.path}#demo`, { corpus: acceptedOnlyCorpus });
  const acceptedPacket = {
    summary: "The accepted shared documentation still contains the initial guidance.",
    currentFacts: [{
      claim: "The accepted guidance remains initial.",
      excerpt: "Initial.",
      path: acceptedRead.path,
      section: acceptedRead.section,
      truthState: acceptedRead.truthState,
      revision: acceptedRead.revision,
      contentHash: acceptedRead.contentHash,
    }],
    constraints: [],
    decisions: [],
    targetDifferences: [],
    unknowns: [],
    conflicts: [],
    optionalReads: [],
    coverage: { project: "demo", docsRevision: "replaced", scope: "standard", sourcesExamined: 1, pathsExamined: [acceptedRead.path] },
  };
  let researchInvocation = null;
  const researched = runDocumentationAgent({
    root: fixture.project,
    cliPath: cli,
    task: "Read only accepted documentation",
    sessionId: "session-overlay-a",
    proposalOverlay: frozen,
    codexBin: "/test/codex",
    spawnSyncImpl(command, args, options) {
      researchInvocation = { command, args, options };
      return { status: 0, signal: null, stdout: JSON.stringify(acceptedPacket), stderr: "" };
    },
  });
  assert.equal(researched.packet.currentFacts[0].excerpt, "Initial.");
  assert.equal(researchInvocation.options.env.CONTEXT_ROOM_DOC_ACCEPTED_ONLY, "1");
  assert.equal(researchInvocation.options.env.CONTEXT_ROOM_DOC_SESSION, "");
  assert.equal(researchInvocation.options.env.CONTEXT_ROOM_DOC_PROPOSALS, "");

  writeFile(projectProposal.root, "projects/demo/docs/PENDING.md", "# Pending session\n\nPending session alpha, second head.\n");
  publishSharedProposal(fixture.project, {
    proposal: projectProposal.branch,
    description: "Keep the deletion and replace the pending project guidance with its second version.",
  });
  const frozenCorpus = buildDocumentationCorpus(fixture.project, { sessionId: "session-overlay-a", proposalOverlay: frozen });
  const frozenPath = frozenCorpus.documents.find((document) => document.repositoryPath === "projects/demo/docs/PENDING.md").path;
  assert.doesNotMatch(readDocumentation(fixture.project, frozenPath, { corpus: frozenCorpus }).content, /second head/);
  const liveCorpus = buildDocumentationCorpus(fixture.project, { sessionId: "session-overlay-a" });
  const livePath = liveCorpus.documents.find((document) => document.repositoryPath === "projects/demo/docs/PENDING.md").path;
  assert.match(readDocumentation(fixture.project, livePath, { corpus: liveCorpus }).content, /second head/);

  const sharedOnlyRoot = path.join(fixture.base, "shared-only-cwd");
  fs.mkdirSync(sharedOnlyRoot, { recursive: true });
  const sharedOnlyOptions = {
    repository: fixture.remote,
    projectId: "demo",
    sessionId: "session-overlay-a",
  };
  const sharedOnlyCorpus = buildDocumentationCorpus(sharedOnlyRoot, sharedOnlyOptions);
  assert.equal(sharedOnlyCorpus.target.mode, "shared-only");
  assert.equal(sharedOnlyCorpus.target.projectId, "demo");
  assert.equal(sharedOnlyCorpus.revision.local, "not-applicable");
  assert.equal(sharedOnlyCorpus.revision.shared, sharedOnlyCorpus.session.proposals[0].baseRevision);
  assert.equal(sharedOnlyCorpus.documents.some((document) => document.path === "projects/demo/docs/README.md" && document.source === "shared-accepted"), true);
  assert.equal(sharedOnlyCorpus.documents.some((document) => document.path === "projects/demo/skills/demo-workflow/SKILL.md"), true);
  assert.equal(sharedOnlyCorpus.documents.some((document) => document.path === "skills/global/global-workflow/SKILL.md"), true);
  assert.equal(sharedOnlyCorpus.documents.some((document) => /OTHER-SESSION/.test(document.repositoryPath || "")), false);
  assert.equal(fs.existsSync(path.join(sharedOnlyRoot, ".context-room")), false);
  const sharedOnlyDefault = searchDocumentation(sharedOnlyRoot, "Pending session alpha", sharedOnlyOptions);
  assert.equal(sharedOnlyDefault.results.some((result) => result.truthState === "proposal"), false);
  const sharedOnlyPending = searchDocumentation(sharedOnlyRoot, "second head", { ...sharedOnlyOptions, status: "proposal" });
  assert.equal(sharedOnlyPending.results[0].repositoryPath, "projects/demo/docs/PENDING.md");
  const sharedOnlyAcceptedCorpus = buildDocumentationCorpus(sharedOnlyRoot, {
    repository: fixture.remote,
    projectId: "demo",
    acceptedOnly: true,
  });
  const sharedOnlyAcceptedRead = readDocumentation(sharedOnlyRoot, "projects/demo/docs/README.md#demo", { corpus: sharedOnlyAcceptedCorpus });
  const sharedOnlyPacket = {
    ...structuredClone(acceptedPacket),
    currentFacts: [{
      claim: "The accepted guidance remains initial.",
      excerpt: "Initial.",
      path: sharedOnlyAcceptedRead.path,
      section: sharedOnlyAcceptedRead.section,
      truthState: sharedOnlyAcceptedRead.truthState,
      revision: sharedOnlyAcceptedRead.revision,
      contentHash: sharedOnlyAcceptedRead.contentHash,
    }],
    coverage: { project: "demo", docsRevision: "replaced", scope: "standard", sourcesExamined: 1, pathsExamined: [sharedOnlyAcceptedRead.path] },
  };

  const fakeCodex = path.join(fixture.base, "shared-only-codex.mjs");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (!prompt.includes("--repository") || !prompt.includes("--project") || !process.env.CONTEXT_ROOM_DOC_ACCEPTED_REVISION || process.env.CONTEXT_ROOM_DOC_ACCEPTED_ONLY !== "1" || process.env.CONTEXT_ROOM_DOC_PROPOSALS) process.exit(9);
  process.stdout.write(${JSON.stringify(JSON.stringify(sharedOnlyPacket))});
});
`, "utf8");
  fs.chmodSync(fakeCodex, 0o755);
  const sharedOnlyCli = spawnSync(process.execPath, [
    cli,
    "context", "ask", "Read the accepted shared documentation",
    `--repository=${fixture.remote}`,
    "--project=demo",
    "--json",
  ], {
    cwd: sharedOnlyRoot,
    encoding: "utf8",
    env: { ...process.env, CONTEXT_ROOM_CODEX_BIN: fakeCodex, NODE_TEST_CONTEXT: "1" },
  });
  assert.equal(sharedOnlyCli.status, 0, sharedOnlyCli.stderr);
  assert.equal(JSON.parse(sharedOnlyCli.stdout).currentFacts[0].excerpt, "Initial.");
  assert.equal(fs.existsSync(path.join(sharedOnlyRoot, ".context-room")), false);

  const rejectedSessionFlag = spawnSync(process.execPath, [
    cli,
    "context", "ask", "Do not expose proposals",
    `--repository=${fixture.remote}`,
    "--project=demo",
    "--session=session-overlay-a",
  ], { cwd: sharedOnlyRoot, encoding: "utf8" });
  assert.equal(rejectedSessionFlag.status, 2);
  assert.match(rejectedSessionFlag.stderr, /accepted-only/);
});

test("a registered shared repository can be browsed and reviewed without a local project connection", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Shared-only review",
    description: "Review this proposal directly from the global Context Hub.",
    branch: "proposal/demo/shared-only",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nShared-only review.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const repositoryState = listSharedRepositoryProposals(fixture.remote, { allowOffline: false });
  assert.equal(repositoryState.projects.some((project) => project.id === "demo"), true);
  assert.equal(repositoryState.proposals.some((item) => item.branch === proposal.branch && item.head === published.head), true);
  const review = materializeSharedRepositoryReview(fixture.remote, { proposal: proposal.branch });
  assert.equal(review.metadata.proposalHead, published.head);
  assert.equal(review.metadata.repository, fixture.remote);
});

test("a shared repository review materializes a tracked gitkeep deletion", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  writeFile(fixture.seed, "projects/demo/docs/.gitkeep", "");
  git(fixture.seed, ["add", "projects/demo/docs/.gitkeep"]);
  git(fixture.seed, ["commit", "-m", "Track the documentation placeholder"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const proposal = createSharedProposal(fixture.project, {
    title: "Replace the documentation placeholder",
    description: "Remove the placeholder once reviewed documentation exists.",
    branch: "proposal/demo/remove-gitkeep",
  });
  configureGit(proposal.root);
  fs.unlinkSync(path.join(proposal.root, "projects/demo/docs/.gitkeep"));
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nReviewed documentation replaces the placeholder.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const review = materializeSharedRepositoryReview(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
  });
  assert.deepEqual(
    review.metadata.proposalChanges.find((change) => change.path === "projects/demo/docs/.gitkeep"),
    {
      path: "projects/demo/docs/.gitkeep",
      status: "D",
      fromPath: null,
      score: null,
      reviewKind: "proposal-change",
    },
  );
  assert.equal(review.metadata.proposalFiles.includes("projects/demo/docs/.gitkeep"), true);
  assert.equal(fs.existsSync(path.join(review.reviewRoot, "projects/demo/docs/.gitkeep")), false);

  initializeContextRoomProject(review.reviewRoot, {
    title: "Review · proposal/demo/remove-gitkeep",
    allowedPaths: ["projects/demo/docs/"],
    watchAllow: ["projects/demo/docs/"],
  });
  const deletedFile = readMemoryFile(review.reviewRoot, "projects/demo/docs/.gitkeep", { readOnly: true });
  assert.equal(deletedFile.exists, false);
  assert.equal(deletedFile.content, "");

  const deletedDiff = readFileDiff(review.reviewRoot, "projects/demo/docs/.gitkeep", { readOnly: true });
  assert.equal(deletedDiff.changed, true);
  assert.equal(deletedDiff.currentExists, false);
  assert.match(deletedDiff.patch, /deleted file mode 100644/);
});

test("a shared-only project can create a Markdown document as a published proposal", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);

  const created = proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "product/principles",
    title: "Product principles",
    description: "Define the durable product principles and boundaries future implementation must preserve.",
  });

  assert.equal(created.documentPath, "product/principles.md");
  assert.equal(created.repositoryPath, "projects/demo/docs/product/principles.md");
  assert.match(created.proposal.branch, /^proposal\/demo\//);
  assert.deepEqual(created.proposal.files, ["projects/demo/docs/product/principles.md"]);
  const proposed = git(fixture.base, ["--git-dir", fixture.remote, "show", `refs/heads/${created.proposal.branch}:${created.repositoryPath}`]);
  assert.match(proposed, /id: demo\.docs\.product\.principles/);
  assert.match(proposed, /# Product principles/);
  assert.notEqual(spawnSync("git", ["--git-dir", fixture.remote, "cat-file", "-e", `refs/heads/main:${created.repositoryPath}`]).status, 0);
  assert.throws(() => proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "../escape.md",
    title: "Escape",
    description: "This invalid path must never leave the shared project documentation root.",
  }), /safe repository-relative path/);
  assert.throws(() => proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "product/principles.txt",
    title: "Wrong format",
    description: "This invalid format must not create a shared documentation proposal.",
  }), /must use the \.md extension/);

  const room = createMemoryServer({ root: fixture.project });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => room.server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${room.server.address().port}`;
  const repositoryResponse = await fetch(baseUrl + "/api/context-hub/shared-repositories", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ repository: fixture.remote }),
  });
  assert.equal(repositoryResponse.status, 201, JSON.stringify(await repositoryResponse.json()));
  const apiResponse = await fetch(baseUrl + "/api/context-hub/shared-documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      repository: fixture.remote,
      projectId: "demo",
      path: "operations/runbook.md",
      title: "Operations runbook",
      description: "Define the shared operating sequence, owner boundaries, and recovery checks.",
    }),
  });
  const apiCreated = await apiResponse.json();
  assert.equal(apiResponse.status, 201, JSON.stringify(apiCreated));
  assert.equal(apiCreated.repositoryPath, "projects/demo/docs/operations/runbook.md");
  assert.equal(apiCreated.catalog.projects.some((project) => project.shared?.projectId === "demo"), true);
});

test("shared document creation refuses symlinked proposal parents without publishing or escaping", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const external = path.join(fixture.base, "external-sentinel");
  const sentinel = path.join(external, "sentinel.md");
  fs.mkdirSync(external, { recursive: true, mode: 0o750 });
  fs.writeFileSync(sentinel, "external sentinel\n", { mode: 0o640 });
  const beforeBytes = fs.readFileSync(sentinel);
  const before = fs.statSync(sentinel, { bigint: true });

  listSharedRepositoryProposals(fixture.remote, { allowOffline: false });
  const cacheRoot = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(process.env.CONTEXT_ROOM_SHARED_HOME, entry.name))
    .find((candidate) => fs.existsSync(path.join(candidate, "repository/.git")));
  assert.ok(cacheRoot, "the Shared repository cache must exist");
  const checkout = path.join(cacheRoot, "repository");
  const postCheckout = path.join(checkout, ".git", "hooks", "post-checkout");
  fs.writeFileSync(postCheckout, `#!/bin/sh
proposal_root="$(git rev-parse --show-toplevel)" || exit 1
if [ "$proposal_root" = ${JSON.stringify(checkout)} ]; then exit 0; fi
mkdir -p "$proposal_root/projects/demo/docs"
ln -s ${JSON.stringify(external)} "$proposal_root/projects/demo/docs/proposal-escape"
`, "utf8");
  fs.chmodSync(postCheckout, 0o755);
  assert.throws(() => proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "proposal-escape/attempt.md",
    title: "Proposal escape",
    description: "This controlled worktree tamper must be rejected and cleaned before publication.",
  }), /symbolic-link parent/);

  const after = fs.statSync(sentinel, { bigint: true });
  assert.deepEqual(fs.readFileSync(sentinel), beforeBytes);
  assert.equal(after.mode, before.mode);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(fs.existsSync(path.join(external, "attempt.md")), false);
  const registry = JSON.parse(fs.readFileSync(path.join(cacheRoot, "proposals.json"), "utf8"));
  assert.deepEqual(registry.proposals, {});
  assert.doesNotMatch(git(checkout, ["worktree", "list", "--porcelain"]), /\/proposals\//);
  assert.equal(git(checkout, ["branch", "--list", "proposal/demo/*"]), "");
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", "refs/heads/proposal/demo/*"]), "");
});

test("shared document creation stages bytes before revalidating a concurrently moved parent", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const external = path.join(fixture.base, "external-race");
  const sentinel = path.join(external, "sentinel.md");
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(sentinel, "race sentinel\n", { mode: 0o640 });
  const beforeBytes = fs.readFileSync(sentinel);
  const before = fs.statSync(sentinel, { bigint: true });
  const beforeExternal = fs.statSync(external, { bigint: true });
  const beforeEntries = fs.readdirSync(external);
  listSharedRepositoryProposals(fixture.remote, { allowOffline: false });
  const cacheRoot = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(process.env.CONTEXT_ROOM_SHARED_HOME, entry.name))
    .find((candidate) => fs.existsSync(path.join(candidate, "repository/.git")));
  assert.ok(cacheRoot);

  const originalWriteFileSync = fs.writeFileSync;
  let moved = false;
  fs.writeFileSync = function interceptedWrite(file, content, ...args) {
    if (!moved && typeof file === "number" && String(content).includes("# Parent race")) {
      const proposalsRoot = path.join(cacheRoot, "proposals");
      const proposalRoot = fs.readdirSync(proposalsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(proposalsRoot, entry.name))
        .find((candidate) => fs.existsSync(path.join(candidate, "projects/demo/docs/race-parent")));
      assert.ok(proposalRoot, "the proposal parent must exist before staged bytes are written");
      const targetParent = path.join(proposalRoot, "projects/demo/docs/race-parent");
      fs.renameSync(targetParent, `${targetParent}-held`);
      fs.symlinkSync(external, targetParent);
      moved = true;
    }
    return originalWriteFileSync.call(this, file, content, ...args);
  };
  try {
    assert.throws(() => proposeSharedDocumentationFile(fixture.remote, {
      projectId: "demo",
      path: "race-parent/attempt.md",
      title: "Parent race",
      description: "Move the validated destination parent at the exact staged-write boundary.",
    }), /parent changed during file creation/);
  } finally {
    fs.writeFileSync = originalWriteFileSync;
  }

  assert.equal(moved, true);
  assert.equal(fs.existsSync(path.join(external, "attempt.md")), false);
  const after = fs.statSync(sentinel, { bigint: true });
  const afterExternal = fs.statSync(external, { bigint: true });
  assert.deepEqual(fs.readFileSync(sentinel), beforeBytes);
  assert.equal(after.mode, before.mode);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(afterExternal.mode, beforeExternal.mode);
  assert.equal(afterExternal.dev, beforeExternal.dev);
  assert.equal(afterExternal.ino, beforeExternal.ino);
  assert.deepEqual(fs.readdirSync(external), beforeEntries);
  const registry = JSON.parse(fs.readFileSync(path.join(cacheRoot, "proposals.json"), "utf8"));
  assert.deepEqual(registry.proposals, {});
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", "refs/heads/proposal/demo/*"]), "");
  assert.deepEqual(fs.readdirSync(path.join(cacheRoot, "staging")), []);
});

test("failed unsafe-proposal cleanup preserves its registry entry for explicit recovery", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  listSharedRepositoryProposals(fixture.remote, { allowOffline: false });
  const cacheRoot = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(process.env.CONTEXT_ROOM_SHARED_HOME, entry.name))
    .find((candidate) => fs.existsSync(path.join(candidate, "repository/.git")));
  assert.ok(cacheRoot);
  const checkout = path.join(cacheRoot, "repository");
  const external = path.join(fixture.base, "cleanup-external");
  fs.mkdirSync(external, { recursive: true });
  const postCheckout = path.join(checkout, ".git", "hooks", "post-checkout");
  fs.writeFileSync(postCheckout, `#!/bin/sh
proposal_root="$(git rev-parse --show-toplevel)" || exit 1
if [ "$proposal_root" = ${JSON.stringify(checkout)} ]; then exit 0; fi
mkdir -p "$proposal_root/projects/demo/docs"
ln -s ${JSON.stringify(external)} "$proposal_root/projects/demo/docs/cleanup-escape"
`, "utf8");
  fs.chmodSync(postCheckout, 0o755);
  const realGit = String(execFileSync("which", ["git"], { encoding: "utf8" })).trim();
  const fakeBin = path.join(fixture.base, "cleanup-failing-git");
  fs.mkdirSync(fakeBin);
  const fakeGit = path.join(fakeBin, "git");
  fs.writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then exit 91; fi
exec ${JSON.stringify(realGit)} "$@"
`, "utf8");
  fs.chmodSync(fakeGit, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });

  assert.throws(() => proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "cleanup-escape/attempt.md",
    title: "Cleanup recovery",
    description: "Keep exact recovery state if Git cannot remove the refused unsafe worktree.",
  }), (error) => {
    assert.equal(error.code, "filesystem_recovery_required");
    assert.match(error.message, /registry entry was preserved/);
    return true;
  });

  const registry = JSON.parse(fs.readFileSync(path.join(cacheRoot, "proposals.json"), "utf8"));
  const entries = Object.values(registry.proposals);
  assert.equal(entries.length, 1);
  assert.equal(fs.existsSync(entries[0].root), true);
  assert.match(git(checkout, ["worktree", "list", "--porcelain"]), new RegExp(entries[0].root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.notEqual(git(checkout, ["branch", "--list", entries[0].branch]), "");
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", entries[0].branch]), "");
  assert.equal(fs.existsSync(path.join(external, "attempt.md")), false);
});

test("publishing refuses an ignored symlink anywhere inside the proposal policy tree", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject ignored symlink",
    description: "Validate every physical path in the proposal policy tree before Git mutates or publishes it.",
    branch: "proposal/demo/reject-ignored-symlink",
  });
  configureGit(proposal.root);
  openSharedProposalWorkspace(fixture.project, { proposal: proposal.branch });
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nLegitimate unpublished change.\n");
  const external = path.join(fixture.base, "external-publish-sentinel");
  const sentinel = path.join(external, "sentinel.md");
  fs.mkdirSync(external, { recursive: true });
  fs.writeFileSync(sentinel, "publish sentinel\n", { mode: 0o640 });
  const beforeBytes = fs.readFileSync(sentinel);
  const before = fs.statSync(sentinel, { bigint: true });
  const exclude = git(proposal.root, ["rev-parse", "--git-path", "info/exclude"]);
  fs.appendFileSync(exclude, "\nprojects/demo/docs/ignored-parent\n", "utf8");
  fs.symlinkSync(external, path.join(proposal.root, "projects/demo/docs/ignored-parent"));

  assert.throws(() => publishSharedProposal(fixture.project, { proposal: proposal.branch }), (error) => {
    assert.equal(error.code, "shared-path-unsafe");
    assert.match(error.message, /symbolic link/);
    return true;
  });

  const after = fs.statSync(sentinel, { bigint: true });
  assert.deepEqual(fs.readFileSync(sentinel), beforeBytes);
  assert.equal(after.mode, before.mode);
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]), "");
  assert.equal(git(proposal.root, ["rev-parse", "HEAD"]), proposal.baseRevision);
  assert.equal(git(proposal.root, ["diff", "--cached", "--name-only"]), "");
  const cacheRoot = path.dirname(path.dirname(proposal.root));
  const registry = JSON.parse(fs.readFileSync(path.join(cacheRoot, "proposals.json"), "utf8"));
  assert.equal(registry.proposals[proposal.branch].root, proposal.root, "a refused open workspace remains explicitly recoverable, never orphaned");
});

test("publishing refuses a hard-linked external file without exfiltrating it to the Shared remote", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject external hardlink",
    description: "Never stage or publish bytes reached through an external hard link.",
    branch: "proposal/demo/reject-external-hardlink",
  });
  configureGit(proposal.root);

  const sentinel = path.join(fixture.base, "external-publish-sentinel.md");
  const proposalPath = path.join(proposal.root, "projects/demo/docs/EXTERNAL.md");
  const sentinelBytes = Buffer.from("private external publish sentinel\n");
  fs.writeFileSync(sentinel, sentinelBytes, { mode: 0o640 });
  fs.linkSync(sentinel, proposalPath);
  const before = fs.lstatSync(sentinel, { bigint: true });
  assert.equal(before.nlink, 2n);

  assert.throws(() => publishSharedProposal(fixture.project, { proposal: proposal.branch }), (error) => {
    assert.equal(error.code, "shared-path-unsafe");
    assert.match(error.message, /hard-linked file/);
    return true;
  });

  const after = fs.lstatSync(sentinel, { bigint: true });
  assert.deepEqual(fs.readFileSync(sentinel), sentinelBytes);
  assert.deepEqual(fs.readFileSync(proposalPath), sentinelBytes);
  assert.deepEqual(
    { dev: after.dev, ino: after.ino, nlink: after.nlink, mode: after.mode, size: after.size },
    { dev: before.dev, ino: before.ino, nlink: before.nlink, mode: before.mode, size: before.size },
  );
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]), "");
  assert.equal(git(proposal.root, ["rev-parse", "HEAD"]), proposal.baseRevision);
  assert.equal(git(proposal.root, ["diff", "--cached", "--name-only"]), "");
});

test("Shared repository cache refuses checkout and Git-directory symlinks before any external Git mutation", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const cacheId = createHash("sha256").update(fixture.remote).digest("hex").slice(0, 16);
  const cacheRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, cacheId);
  const checkout = path.join(cacheRoot, "repository");
  const external = path.join(fixture.base, "external-shared-checkout");
  const sentinel = path.join(external, "external-sentinel.txt");
  execFileSync("git", ["clone", "-q", fixture.remote, external]);
  fs.writeFileSync(sentinel, "external checkout sentinel\n", { mode: 0o640 });
  const beforeSentinel = fs.readFileSync(sentinel);
  const beforeConfig = fs.readFileSync(path.join(external, ".git/config"));

  const realGit = String(execFileSync("which", ["git"], { encoding: "utf8" })).trim();
  const fakeBin = path.join(fixture.base, "cache-symlink-git-probe");
  const gitMarker = path.join(fixture.base, "cache-symlink-git-called.txt");
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(path.join(fakeBin, "git"), `#!/bin/sh
printf 'git called\\n' >> ${JSON.stringify(gitMarker)}
exec ${JSON.stringify(realGit)} "$@"
`, "utf8");
  fs.chmodSync(path.join(fakeBin, "git"), 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}${path.delimiter}${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });

  const assertUnsafeCache = () => assert.throws(
    () => listSharedRepositoryProposals(fixture.remote, { allowOffline: false }),
    (error) => error.code === "shared-path-unsafe" && /physical directory|symbolic filesystem boundary/.test(error.message),
  );

  fs.mkdirSync(cacheRoot, { recursive: true });
  fs.symlinkSync(external, checkout, "dir");
  assertUnsafeCache();
  assert.equal(fs.existsSync(gitMarker), false, "a rejected checkout symlink must fail before configure or fetch invokes Git");
  fs.unlinkSync(checkout);

  fs.mkdirSync(checkout);
  fs.symlinkSync(path.join(external, ".git"), path.join(checkout, ".git"), "dir");
  assertUnsafeCache();
  assert.equal(fs.existsSync(gitMarker), false, "a rejected .git symlink must fail before configure or fetch invokes Git");
  assert.deepEqual(fs.readFileSync(sentinel), beforeSentinel);
  assert.deepEqual(fs.readFileSync(path.join(external, ".git/config")), beforeConfig);
});

test("Shared snapshot materialization refuses a symlinked fake snapshot root", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const cacheId = createHash("sha256").update(fixture.remote).digest("hex").slice(0, 16);
  const cacheRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, cacheId);
  const checkout = path.join(cacheRoot, "repository");
  const revision = git(fixture.seed, ["--git-dir", fixture.remote, "rev-parse", "refs/heads/main"]);
  fs.mkdirSync(cacheRoot, { recursive: true });
  execFileSync("git", ["clone", "-q", "--no-checkout", fixture.remote, checkout]);

  const external = path.join(fixture.base, "external-fake-snapshot");
  fs.cpSync(fixture.seed, external, { recursive: true });
  fs.rmSync(path.join(external, ".git"), { recursive: true, force: true });
  const fakeDocument = path.join(external, "projects/demo/docs/README.md");
  fs.writeFileSync(fakeDocument, "# Injected fake accepted snapshot\n", { mode: 0o640 });
  const before = fs.lstatSync(fakeDocument, { bigint: true });
  const beforeBytes = fs.readFileSync(fakeDocument);
  const snapshotRoot = path.join(cacheRoot, "snapshots", revision);
  fs.mkdirSync(path.dirname(snapshotRoot), { recursive: true });
  fs.symlinkSync(external, snapshotRoot, "dir");

  assert.throws(
    () => listSharedRepositoryProposals(fixture.remote, { allowOffline: false }),
    (error) => error.code === "shared-path-unsafe" && /Shared snapshot root/.test(error.message),
  );

  const after = fs.lstatSync(fakeDocument, { bigint: true });
  assert.deepEqual(fs.readFileSync(fakeDocument), beforeBytes);
  assert.deepEqual(
    { dev: after.dev, ino: after.ino, mode: after.mode, size: after.size },
    { dev: before.dev, ino: before.ino, mode: before.mode, size: before.size },
  );
  assert.equal(fs.lstatSync(snapshotRoot).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(cacheRoot, "state.json")), false, "a fake external snapshot must never become cached accepted state");
});

test("rejecting a proposal removes it from the active queue without deleting its protected proposal ref", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Reject safely",
    description: "Keep the rejected proposal revision available in Git history.",
    branch: "proposal/demo/reject-safely",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nRejected proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const rejected = rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
  });

  assert.equal(rejected.rejected, true);
  assert.match(rejected.rejectionBranch, /^rejected\/demo\/reject-safely-[a-f0-9]{12}$/);
  assert.equal(fs.existsSync(proposal.root), false);
  assert.equal(listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals.some((item) => item.branch === proposal.branch), false);
  assert.equal(
    git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0],
    published.head,
  );
  assert.equal(
    git(fixture.seed, ["ls-remote", "--heads", "origin", rejected.rejectionBranch]).split(/\s+/)[0],
    published.head,
  );
});

test("an exact rejected proposal cannot be accepted later and rejection retry preserves the first signed decision", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Terminal rejection",
    branch: "proposal/demo/terminal-rejection",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nThis exact proposal will be rejected.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed before the terminal rejection",
  });
  const mainBefore = git(fixture.remote, ["rev-parse", "refs/heads/main"]);

  const rejected = rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
    actor: "first-rejector",
  });
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.alreadyRejected, false);
  const authorityHome = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "review-authority");
  const firstReceipt = inspectOwnerProposalDecisions(fixture.remote, { authorityHome }).decisions
    .find((item) => item.proposal === proposal.branch && item.proposalHead === published.head);
  assert.equal(firstReceipt.decision, "rejected");
  assert.equal(firstReceipt.actor, "first-rejector");

  const retried = rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
    actor: "retrying-rejector",
  });
  assert.equal(retried.rejected, true);
  assert.equal(retried.alreadyRejected, true);
  assert.equal(retried.rejectionBranch, rejected.rejectionBranch);
  const retriedReceipt = inspectOwnerProposalDecisions(fixture.remote, { authorityHome }).decisions
    .find((item) => item.proposal === proposal.branch && item.proposalHead === published.head);
  assert.equal(retriedReceipt.actor, firstReceipt.actor);
  assert.equal(retriedReceipt.decidedAt, firstReceipt.decidedAt);

  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "rejected",
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), mainBefore);
  assert.equal(inspectOwnerProposalDecisions(fixture.remote, { authorityHome }).decisions.length, 1);
});

test("an exact accepted proposal cannot be rejected later and acceptance retry returns the same commit", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Terminal acceptance",
    branch: "proposal/demo/terminal-acceptance",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nThis exact proposal will be accepted.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed before the terminal acceptance",
  });

  const accepted = acceptSharedReview(review.reviewRoot, { message: "Accept terminal proposal" });
  const retried = acceptSharedReview(review.reviewRoot, { message: "Retry terminal proposal" });
  assert.equal(retried.commit, accepted.commit);
  assert.throws(
    () => rejectSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "accepted",
  );
  const rejectionBranch = `rejected/demo/terminal-acceptance-${published.head.slice(0, 12)}`;
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", rejectionBranch]), "");
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), accepted.commit);
});

test("a rejection retry after a lost response repairs the missing signed receipt without moving either remote ref", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Recover rejected delivery",
    branch: "proposal/demo/recover-rejected-delivery",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nThe archive reached origin before the response was lost.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const rejectionBranch = `rejected/demo/recover-rejected-delivery-${published.head.slice(0, 12)}`;
  git(proposal.root, ["push", "origin", `${published.head}:refs/heads/${rejectionBranch}`]);
  const mainBefore = git(fixture.remote, ["rev-parse", "refs/heads/main"]);
  const proposalBefore = git(fixture.remote, ["rev-parse", `refs/heads/${proposal.branch}`]);
  const authorityHome = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "review-authority");
  assert.equal(inspectOwnerProposalDecisions(fixture.remote, { authorityHome }).integrity, "missing");

  const recovered = rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
    actor: "recovery-owner",
  });
  assert.equal(recovered.rejected, true);
  assert.equal(recovered.alreadyRejected, true);
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), mainBefore);
  assert.equal(git(fixture.remote, ["rev-parse", `refs/heads/${proposal.branch}`]), proposalBefore);
  assert.equal(git(fixture.remote, ["rev-parse", `refs/heads/${rejectionBranch}`]), published.head);
  const receipt = inspectOwnerProposalDecisions(fixture.remote, { authorityHome }).decisions[0];
  assert.equal(receipt.decision, "rejected");
  assert.equal(receipt.archiveRef, rejectionBranch);
});

test("an unsigned exact acceptance candidate on main is hidden from the proposal queue and still blocks terminal reuse", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Recover unsigned acceptance",
    branch: "proposal/demo/recover-unsigned-acceptance",
  });
  configureGit(proposal.root);
  const acceptedContent = "# Demo\n\nThe acceptance commit arrived before its local receipt.\n";
  writeFile(proposal.root, "projects/demo/docs/README.md", acceptedContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeFile(fixture.seed, "projects/demo/docs/README.md", acceptedContent);
  git(fixture.seed, ["add", "projects/demo/docs/README.md"]);
  git(fixture.seed, ["commit", "-m", acceptedProposalCommitMessage(review.metadata, "Exact acceptance awaiting recovery")]);
  const acceptedCommit = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", "main"]);

  assert.equal(
    listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
      .some((item) => item.branch === proposal.branch),
    false,
    "an exact acceptance on main must not remain in the active proposal queue",
  );
  assert.throws(
    () => materializeSharedRepositoryReview(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.proposal === proposal.branch
      && error?.details?.proposalHead === published.head
      && error?.details?.reviewStatus === "acceptance_recovery_required"
      && error?.details?.authorityViolation === true
      && error?.details?.acceptedCommit === acceptedCommit
      && /acceptance authority receipt/i.test(error?.details?.authorityMessage || ""),
  );

  const newerProposalHead = git(fixture.seed, ["rev-parse", `${acceptedCommit}^`]);
  git(fixture.seed, [
    "commit",
    "--allow-empty",
    "-m",
    `Later acceptance for the reused proposal name\n\nContext-Room-Proposal: ${proposal.branch}\nContext-Room-Proposal-Head: ${newerProposalHead}\nContext-Room-Project: demo`,
  ]);
  git(fixture.seed, ["push", "origin", "main"]);

  assert.equal(
    listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
      .some((item) => item.branch === proposal.branch),
    false,
    "an exact older acceptance candidate stays terminal even when a newer candidate uses the same branch name",
  );
  const latestHistoricalAcceptance = listSharedMainAcceptances(fixture.remote, { refresh: true })
    .find((item) => item.proposal === proposal.branch);
  assert.equal(latestHistoricalAcceptance.proposalHead, newerProposalHead, "historical listing keeps its latest-per-branch contract");

  const stateBranch = `context-room-state/${createHash("sha256").update(proposal.branch).digest("hex")}`;
  git(fixture.seed, ["push", "origin", "--delete", stateBranch]);
  writeFile(proposal.root, "projects/demo/docs/README.md", `${acceptedContent}\nAttempted legacy republish.\n`);
  const localHeadBeforeRepublish = git(proposal.root, ["rev-parse", "HEAD"]);
  assert.throws(
    () => publishSharedProposal(fixture.project, {
      proposal: proposal.branch,
      expectedHead: published.head,
      description: "Do not recreate active state after an exact legacy acceptance reached main.",
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.details?.reviewStatus === "acceptance_recovery_required"
      && error?.details?.acceptedCommit === acceptedCommit,
  );
  assert.equal(git(proposal.root, ["rev-parse", "HEAD"]), localHeadBeforeRepublish);
  assert.match(git(proposal.root, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", stateBranch]), "");

  const unpublishedBranch = "proposal/demo/accepted-before-first-publish";
  const unpublished = createSharedProposal(fixture.project, {
    title: "Accepted before first publish",
    branch: unpublishedBranch,
  });
  configureGit(unpublished.root);
  writeFile(unpublished.root, "projects/demo/docs/README.md", "# Demo\n\nThis unpublished branch identifier became terminal on main.\n");
  git(fixture.seed, [
    "commit",
    "--allow-empty",
    "-m",
    `Externally accepted unpublished branch identifier\n\nContext-Room-Proposal: ${unpublishedBranch}\nContext-Room-Proposal-Head: ${unpublished.baseRevision}\nContext-Room-Project: demo`,
  ]);
  const unpublishedAcceptedCommit = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", "main"]);
  const unpublishedLocalHead = git(unpublished.root, ["rev-parse", "HEAD"]);
  assert.throws(
    () => publishSharedProposal(fixture.project, {
      proposal: unpublishedBranch,
      description: "Never publish a branch identifier already recorded on accepted main.",
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.details?.reviewStatus === "acceptance_recovery_required"
      && error?.details?.acceptedCommit === unpublishedAcceptedCommit,
  );
  assert.equal(git(unpublished.root, ["rev-parse", "HEAD"]), unpublishedLocalHead);
  assert.match(git(unpublished.root, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);

  assert.throws(
    () => rejectSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "acceptance_recovery_required"
      && error?.details?.acceptedCommit === acceptedCommit,
  );
  const rejectionBranch = `rejected/demo/recover-unsigned-acceptance-${published.head.slice(0, 12)}`;
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", rejectionBranch]), "");
  git(fixture.seed, ["push", "origin", "--delete", proposal.branch]);
  assert.throws(
    () => openSharedProposalWorkspace(fixture.project, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.details?.reviewStatus === "accepted",
  );
  assert.throws(
    () => createSharedProposal(fixture.project, {
      title: "Do not reuse accepted proposal identity",
      branch: proposal.branch,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.details?.reviewStatus === "accepted",
  );
});

test("verified rejection plus an exact shared-main acceptance stays out of the queue but blocks direct review", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Expose contradictory terminal evidence",
    branch: "proposal/demo/expose-terminal-conflict",
  });
  configureGit(proposal.root);
  const acceptedContent = "# Demo\n\nThe same exact revision was rejected and later copied to main.\n";
  writeFile(proposal.root, "projects/demo/docs/README.md", acceptedContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  const rejected = rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
    actor: "rejecting-owner",
  });

  writeFile(fixture.seed, "projects/demo/docs/README.md", acceptedContent);
  git(fixture.seed, ["add", "projects/demo/docs/README.md"]);
  git(fixture.seed, ["commit", "-m", acceptedProposalCommitMessage(review.metadata, "Contradictory acceptance candidate")]);
  const acceptedCommit = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", "main"]);

  assert.equal(
    listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
      .some((item) => item.branch === proposal.branch),
    false,
    "terminal contradictions belong to diagnostics rather than the active proposal queue",
  );
  assert.throws(
    () => materializeSharedRepositoryReview(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "terminal_conflict_recovery_required"
      && error?.details?.acceptedCommit === acceptedCommit
      && error?.details?.rejectionBranch === rejected.rejectionBranch,
  );
});

test("proposal changes already integrated on main are hidden while direct terminal operations remain blocked", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Recover external integration",
    branch: "proposal/demo/recover-external-integration",
    sessionId: "session-external-merge-recovery",
  });
  configureGit(proposal.root);
  const integratedContent = "# Demo\n\nIntegrated outside the Context Room acceptance path.\n";
  writeFile(proposal.root, "projects/demo/docs/README.md", integratedContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  writeFile(fixture.seed, "projects/demo/docs/README.md", integratedContent);
  git(fixture.seed, ["add", "projects/demo/docs/README.md"]);
  git(fixture.seed, ["commit", "-m", "Integrate proposal content outside Context Room"]);
  const integratedAtRevision = git(fixture.seed, ["rev-parse", "HEAD"]);
  assert.notEqual(integratedAtRevision, published.head, "the recovery gate must not rely on proposal-head ancestry");
  git(fixture.seed, ["push", "origin", "main"]);

  assert.equal(
    listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
      .some((item) => item.branch === proposal.branch),
    false,
    "content already integrated on main must not remain in the active proposal queue",
  );
  const authorityHome = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "review-authority");
  const authorityBeforeReject = inspectOwnerProposalDecisions(fixture.remote, { authorityHome });
  const stateBranch = `context-room-state/${createHash("sha256").update(proposal.branch).digest("hex")}`;
  const rejectionBranch = `rejected/demo/recover-external-integration-${published.head.slice(0, 12)}`;
  const refsBeforeReject = new Map([
    ["main", git(fixture.seed, ["ls-remote", "--heads", "origin", "main"])],
    [proposal.branch, git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch])],
    [stateBranch, git(fixture.seed, ["ls-remote", "--heads", "origin", stateBranch])],
    [rejectionBranch, git(fixture.seed, ["ls-remote", "--heads", "origin", rejectionBranch])],
  ]);
  assert.throws(
    () => rejectSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "external_merge_recovery_required"
      && error?.details?.integratedAtRevision === integratedAtRevision,
  );
  for (const [ref, before] of refsBeforeReject) {
    assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", ref]), before, `${ref} must remain unchanged`);
  }
  assert.deepEqual(
    inspectOwnerProposalDecisions(fixture.remote, { authorityHome }),
    authorityBeforeReject,
    "a blocked recovery rejection must not create or rewrite owner authority",
  );
  const freshSessionDraft = ensureSharedProposal(fixture.project, {
    title: "Continue after external merge recovery",
    description: "Use a new proposal identity instead of resuming the authority-recovery proposal.",
    sessionId: "session-external-merge-recovery",
  });
  assert.equal(freshSessionDraft.reused, false);
  assert.notEqual(freshSessionDraft.branch, proposal.branch);
  writeFile(proposal.root, "projects/demo/docs/README.md", `${integratedContent}\nAttempted recovery bypass.\n`);
  const localHeadBeforeBypass = git(proposal.root, ["rev-parse", "HEAD"]);
  assert.throws(
    () => openSharedRepositoryProposalWorkspace(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "external_merge_recovery_required",
  );
  assert.throws(
    () => publishSharedProposal(fixture.project, {
      proposal: proposal.branch,
      expectedHead: published.head,
      description: "Do not republish a proposal while external merge authority is unresolved.",
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "external_merge_recovery_required"
      && error?.details?.integratedAtRevision === integratedAtRevision,
  );
  assert.equal(git(proposal.root, ["rev-parse", "HEAD"]), localHeadBeforeBypass);
  assert.match(git(proposal.root, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0], published.head);
  assert.deepEqual(
    resolveSharedSessionProposals(fixture.project, { sessionId: "session-external-merge-recovery" }).proposals,
    [],
    "terminal and recovery projections must never leak into the agent session overlay",
  );
  assert.throws(
    () => materializeSharedRepositoryReview(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "external_merge_recovery_required"
      && error?.details?.integratedAtRevision === integratedAtRevision,
  );
});

for (const baseVariant of ["missing", "forged"]) {
  test(`a ${baseVariant} proposal base still runs the conflict check and blocks materialization`, (t) => {
    const fixture = makeFixture();
    withSharedHome(t, fixture);
    connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
    const proposal = createSharedProposal(fixture.project, {
      title: `Conflict with ${baseVariant} base`,
      branch: `proposal/demo/conflict-${baseVariant}-base`,
    });
    configureGit(proposal.root);
    writeFile(proposal.root, "projects/demo/docs/README.md", `# Demo\n\nProposal with ${baseVariant} base.\n`);
    publishSharedProposal(fixture.project, { proposal: proposal.branch });

    const malformedBaseTrailer = baseVariant === "forged"
      ? `\nContext-Room-Base: ${"f".repeat(40)}`
      : "";
    git(proposal.root, [
      "commit",
      "--amend",
      "-m",
      `Conflict with ${baseVariant} base\n\nContext-Room-Title: Conflict with ${baseVariant} base\nContext-Room-Project: demo${malformedBaseTrailer}`,
    ]);
    const exactHead = git(proposal.root, ["rev-parse", "HEAD"]);
    const stateBranch = `context-room-state/${createHash("sha256").update(proposal.branch).digest("hex")}`;
    git(proposal.root, [
      "push",
      "--force",
      "origin",
      `HEAD:refs/heads/${proposal.branch}`,
      `HEAD:refs/heads/${stateBranch}`,
    ]);

    writeFile(fixture.seed, "projects/demo/docs/README.md", `# Demo\n\nConflicting main for ${baseVariant} base.\n`);
    git(fixture.seed, ["add", "projects/demo/docs/README.md"]);
    git(fixture.seed, ["commit", "-m", `Advance main against ${baseVariant} base proposal`]);
    git(fixture.seed, ["push", "origin", "main"]);

    const conflicted = listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
      .find((item) => item.branch === proposal.branch);
    assert.ok(conflicted);
    assert.equal(conflicted.head, exactHead);
    assert.equal(conflicted.hasConflict, true);
    assert.equal(conflicted.conflictCheckStatus, "conflict");
    const reviewsRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "repositories");
    const reviewsBefore = fs.existsSync(reviewsRoot)
      ? fs.readdirSync(reviewsRoot, { recursive: true }).filter((entry) => String(entry).includes("reviews/"))
      : [];
    assert.throws(
      () => materializeSharedRepositoryReview(fixture.remote, {
        proposal: proposal.branch,
        expectedHead: exactHead,
      }),
      (error) => error?.code === "shared-proposal-conflict"
        && error?.statusCode === 409
        && error?.details?.proposalHead === exactHead,
    );
    const reviewsAfter = fs.existsSync(reviewsRoot)
      ? fs.readdirSync(reviewsRoot, { recursive: true }).filter((entry) => String(entry).includes("reviews/"))
      : [];
    assert.deepEqual(reviewsAfter, reviewsBefore, "conflict detection must stop before creating a review worktree");
  });
}

test("an indeterminate merge-tree check is a non-openable recovery state", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Fail closed when conflict status is unknown",
    branch: "proposal/demo/conflict-check-unknown",
    sessionId: "session-conflict-check-unknown",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nProposal awaiting a reliable conflict check.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  writeFile(fixture.seed, "projects/demo/docs/MAIN-ADVANCE.md", "# Main advance\n");
  git(fixture.seed, ["add", "projects/demo/docs/MAIN-ADVANCE.md"]);
  git(fixture.seed, ["commit", "-m", "Advance shared main independently"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const restoreGit = failGitMergeTree(t, fixture);
  const unknown = listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
    .find((item) => item.branch === proposal.branch);
  assert.ok(unknown);
  assert.equal(unknown.reviewStatus, "conflict_check_recovery_required");
  assert.equal(unknown.authorityViolation, true);
  assert.equal(unknown.conflictCheckStatus, "unknown");
  assert.equal(unknown.hasConflict, null);
  assert.match(unknown.authorityMessage, /could not determine whether this proposal conflicts/i);
  assert.deepEqual(
    resolveSharedSessionProposals(fixture.project, { sessionId: "session-conflict-check-unknown" }).proposals,
    [],
    "an unknown conflict result must never be treated as a conflict-free session proposal",
  );

  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAttempted publication during an unknown conflict check.\n");
  const localHeadBefore = git(proposal.root, ["rev-parse", "HEAD"]);
  const assertConflictCheckGate = (operation) => assert.throws(
    operation,
    (error) => error?.code === "shared-proposal-conflict-check-unavailable"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "conflict_check_recovery_required"
      && error?.details?.conflictCheckStatus === "unknown",
  );
  assertConflictCheckGate(() => openSharedRepositoryProposalWorkspace(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
  }));
  assertConflictCheckGate(() => publishSharedProposal(fixture.project, {
    proposal: proposal.branch,
    expectedHead: published.head,
    description: "Do not publish until Git can establish the exact conflict state.",
  }));
  assertConflictCheckGate(() => materializeSharedRepositoryReview(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
  }));
  assert.equal(git(proposal.root, ["rev-parse", "HEAD"]), localHeadBefore);
  assert.match(git(proposal.root, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]).split(/\s+/)[0], published.head);

  restoreGit();
  const reopened = openSharedRepositoryProposalWorkspace(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
  });
  assert.equal(reopened.branch, proposal.branch);
  assert.equal(reopened.head, published.head);
  assert.equal(reopened.dirty, true);
});

test("a cross-process acceptance holding the exact terminal lock excludes concurrent rejection", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Acceptance wins terminal race",
    branch: "proposal/demo/acceptance-wins-terminal-race",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAcceptance wins this terminal race.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed before the acceptance race",
  });
  const started = path.join(fixture.base, "accept-terminal-race.started");
  const release = path.join(fixture.base, "accept-terminal-race.release");
  t.after(() => fs.writeFileSync(release, "release\n", "utf8"));
  const hook = path.join(fixture.remote, "hooks", "post-receive");
  fs.writeFileSync(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    : > ${JSON.stringify(started)}
    while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done
  fi
done
`, "utf8");
  fs.chmodSync(hook, 0o755);

  const accepting = runTerminalDecisionProcess({ action: "accept", reviewRoot: review.reviewRoot });
  await waitForPath(started, "acceptance must reach the remote while holding the exact terminal lock");
  const rejectedContender = await runTerminalDecisionProcess({
    action: "reject",
    repository: fixture.remote,
    proposal: proposal.branch,
    proposalHead: published.head,
  });
  assert.equal(rejectedContender.ok, false, JSON.stringify(rejectedContender));
  assert.equal(rejectedContender.error.code, "shared-terminal-decision-busy");
  assert.equal(rejectedContender.error.statusCode, 409);
  const rejectionBranch = `rejected/demo/acceptance-wins-terminal-race-${published.head.slice(0, 12)}`;
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", rejectionBranch]), "");

  fs.writeFileSync(release, "release\n", "utf8");
  const accepted = await accepting;
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.result.accepted, true);
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), accepted.result.commit);
  assert.throws(
    () => rejectSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal" && error?.statusCode === 409,
  );
});

test("a cross-process rejection holding the exact terminal lock excludes concurrent acceptance", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Rejection wins terminal race",
    branch: "proposal/demo/rejection-wins-terminal-race",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nRejection wins this terminal race.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed before the rejection race",
  });
  const started = path.join(fixture.base, "reject-terminal-race.started");
  const release = path.join(fixture.base, "reject-terminal-race.release");
  t.after(() => fs.writeFileSync(release, "release\n", "utf8"));
  const hook = path.join(fixture.remote, "hooks", "post-receive");
  fs.writeFileSync(hook, `#!/bin/sh
while read old new ref; do
  case "$ref" in
    refs/heads/rejected/*)
      : > ${JSON.stringify(started)}
      while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done
      ;;
  esac
done
`, "utf8");
  fs.chmodSync(hook, 0o755);

  const rejecting = runTerminalDecisionProcess({
    action: "reject",
    repository: fixture.remote,
    proposal: proposal.branch,
    proposalHead: published.head,
  });
  await waitForPath(started, "rejection must reach the remote while holding the exact terminal lock");
  const acceptedContender = await runTerminalDecisionProcess({ action: "accept", reviewRoot: review.reviewRoot });
  assert.equal(acceptedContender.ok, false, JSON.stringify(acceptedContender));
  assert.equal(acceptedContender.error.code, "shared-terminal-decision-busy");
  assert.equal(acceptedContender.error.statusCode, 409);
  const mainBeforeRelease = git(fixture.remote, ["rev-parse", "refs/heads/main"]);
  assert.equal(mainBeforeRelease, review.metadata.baseRevision);

  fs.writeFileSync(release, "release\n", "utf8");
  const rejected = await rejecting;
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  assert.equal(rejected.result.rejected, true);
  assert.equal(git(fixture.remote, ["rev-parse", `refs/heads/${rejected.result.rejectionBranch}`]), published.head);
  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    (error) => error?.code === "shared-proposal-terminal" && error?.statusCode === 409,
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), mainBeforeRelease);
});

test("an exact pre-existing rejection archive needs explicit human recovery", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Trust exact rejection archive",
    description: "Use the exact remote archive as the terminal rejection authority.",
    branch: "proposal/demo/repair-rejection-evidence",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nRejected outside the owner UI.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const rejectionBranch = `rejected/demo/repair-rejection-evidence-${published.head.slice(0, 12)}`;
  const wrongHead = git(proposal.root, ["rev-parse", "origin/main"]);
  git(proposal.root, ["push", "origin", `${wrongHead}:refs/heads/${rejectionBranch}`]);
  assert.equal(listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals.some((item) => item.branch === proposal.branch), true);

  git(proposal.root, ["push", "--force", "origin", `${published.head}:refs/heads/${rejectionBranch}`]);

  const forgedArchiveOnly = listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
    .find((item) => item.branch === proposal.branch);
  assert.ok(forgedArchiveOnly, "an archive created outside the human decision flow must not hide the proposal");
  assert.equal(forgedArchiveOnly.reviewStatus, "ready");

  const recovered = rejectSharedRepositoryProposal(fixture.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
    actor: "archive-recovery-owner",
  });
  assert.equal(recovered.rejected, true);
  assert.equal(recovered.alreadyRejected, true);
  assert.equal(listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals.some((item) => item.branch === proposal.branch), false);
});

test("an externally deleted proposal is absent from the queue but remains blocked by exact direct lookup", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Detect external deletion",
    description: "Do not let a raw Git deletion masquerade as a human review decision.",
    branch: "proposal/demo/detect-external-deletion",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nObserved proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  assert.equal(
    listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals.some((item) => item.branch === proposal.branch),
    true,
  );

  git(fixture.seed, ["push", "origin", "--delete", proposal.branch]);
  assert.equal(
    listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals
      .some((item) => item.branch === proposal.branch),
    false,
  );
  assert.throws(
    () => materializeSharedRepositoryReview(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    (error) => error?.code === "shared-proposal-terminal"
      && error?.statusCode === 409
      && error?.details?.reviewStatus === "externally_deleted",
  );
});

test("rejecting a proposal refuses to discard unpublished local changes", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Protect unpublished work",
    description: "Do not remove a proposal workspace while it contains unpublished changes.",
    branch: "proposal/demo/protect-unpublished",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nPublished proposal.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nUnpublished follow-up.\n");

  assert.throws(
    () => rejectSharedRepositoryProposal(fixture.remote, {
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
    /unpublished local changes/,
  );
  assert.equal(fs.existsSync(proposal.root), true);
  assert.equal(listSharedRepositoryProposals(fixture.remote, { allowOffline: false }).proposals.some((item) => item.branch === proposal.branch), true);
});

test("Context Hub exposes global proposal scopes as filterable shared projects", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Global workflow update",
    description: "Update the workflow shared by every connected project.",
    scope: "global",
    branch: "proposal/global/workflow-update",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "skills/global/global-workflow/SKILL.md", "# Updated global workflow\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const hub = contextHubUiState(fixture.project);
  const globalProject = hub.projects.find((project) => project.projectKey.endsWith(":global"));
  assert.equal(globalProject?.title, "Global skills");
  assert.equal(globalProject?.mode, "shared");
  assert.equal(globalProject?.sharedProposalCount, 1);
  assert.equal(hub.proposals.find((item) => item.branch === proposal.branch)?.projectKey, globalProject.projectKey);
});

test("project proposals cannot modify global or another project scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Escape", branch: "proposal/demo/escape" });
  writeFile(proposal.root, "skills/global/global-workflow/SKILL.md", "outside project scope\n");
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: proposal.branch }), /outside projects\/demo\//);
});

test("partial acceptance includes new files and omits rejected new files", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Add docs", branch: "proposal/demo/add-docs" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/ACCEPTED.md", "# Accepted\n");
  writeFile(proposal.root, "projects/demo/docs/REJECTED.md", "# Rejected\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });
  fs.unlinkSync(path.join(review.reviewRoot, "projects/demo/docs/REJECTED.md"));
  configureGit(review.reviewRoot);
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/ACCEPTED.md", { status: "verified", note: "Accepted new file" });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/REJECTED.md", { status: "verified", note: "Confirmed rejected new file remains absent" });
  const accepted = acceptSharedReview(review.reviewRoot);
  assert.equal(accepted.accepted, true);

  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(fs.readFileSync(path.join(fixture.seed, "projects/demo/docs/ACCEPTED.md"), "utf8"), "# Accepted\n");
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/REJECTED.md")), false);
  assert.equal(git(fixture.seed, ["show", "origin/main:projects/demo/docs/ACCEPTED.md"]), "# Accepted");
  assert.throws(() => git(fixture.seed, ["cat-file", "-e", "origin/main:projects/demo/docs/REJECTED.md"]));
});

test("project proposal acceptance succeeds when the optional skills directory is absent", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  fs.rmSync(path.join(fixture.seed, "projects/demo/skills"), { recursive: true });
  git(fixture.seed, ["add", "-A"]);
  git(fixture.seed, ["commit", "-m", "Keep the shared project docs only"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });

  const proposal = createSharedProposal(fixture.project, {
    title: "Clarify docs-only project",
    branch: "proposal/demo/docs-only",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nDocs-only accepted.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Reviewed the exact docs-only proposal",
  });

  const accepted = acceptSharedReview(review.reviewRoot);
  assert.equal(accepted.accepted, true);
  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(fs.readFileSync(path.join(fixture.seed, "projects/demo/docs/README.md"), "utf8"), "# Demo\n\nDocs-only accepted.\n");
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/skills")), false);
});

test("shared acceptance refuses a direct function call without exact trusted human file decisions", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "No review bypass", branch: "proposal/demo/no-review-bypass" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/UNREVIEWED.md", "# Unreviewed\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });

  assert.throws(
    () => acceptSharedReview(review.reviewRoot),
    /Human review evidence is missing, altered, or recovered/,
  );
  assert.equal(git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]), "# Demo\n\nInitial.");
});

test("remote proposal branches are revalidated before review", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  git(fixture.seed, ["switch", "-c", "proposal/demo/bypass"]);
  writeFile(fixture.seed, "projects/demo/UNREVIEWED.md", "# Outside review surface\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Bypass local CLI"]);
  git(fixture.seed, ["push", "origin", "proposal/demo/bypass"]);
  git(fixture.seed, ["switch", "main"]);

  assert.throws(
    () => materializeSharedReview(fixture.project, { proposal: "proposal/demo/bypass" }),
    /outside projects\/demo\/docs\/ or projects\/demo\/skills\//,
  );
});

test("missing repository proposal materialization returns a typed not-found error", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const missingProposal = "proposal/demo/missing-review";

  assert.throws(
    () => materializeSharedRepositoryReview(fixture.remote, { proposal: missingProposal }),
    (error) => error?.code === "shared_context_proposal_not_found"
      && error?.statusCode === 404
      && error?.details?.proposal === missingProposal,
  );
});

test("an exact invalid proposal preserves its underlying validation error", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const branch = "proposal/demo/orphan-history";
  git(fixture.seed, ["switch", "--orphan", branch]);
  writeFile(fixture.seed, "projects/demo/docs/README.md", "# Orphan proposal\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Create an invalid proposal without a shared merge base"]);
  git(fixture.seed, ["push", "origin", branch]);
  git(fixture.seed, ["switch", "main"]);

  assert.equal(
    listSharedProposals(fixture.project, { refresh: true }).some((item) => item.branch === branch),
    false,
    "generic listing should remain tolerant of an unrelated invalid proposal ref",
  );
  assert.throws(
    () => materializeSharedReview(fixture.project, { proposal: branch }),
    (error) => {
      assert.doesNotMatch(String(error.message || error), /Remote proposal not found/);
      assert.match(String(error.stderr || error.message || error), /no merge base/i);
      return true;
    },
  );
});

test("terminal acceptance revalidates a legacy copy source path against proposal scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const copySource = "skills/global/global-workflow/SKILL.md";
  const copyTarget = "projects/demo/docs/COPIED-IMPORT.md";
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const connection = readSharedProjectConnection(fixture.project);
  const baseRevision = git(fixture.seed, ["rev-parse", "HEAD"]);
  const branch = "proposal/demo/legacy-cross-scope-sources";
  git(fixture.seed, ["switch", "-c", branch]);
  writeFile(fixture.seed, copyTarget, fs.readFileSync(path.join(fixture.seed, copySource), "utf8"));
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, [
    "commit",
    "-m",
    `Legacy authority source-path bypass\n\nContext-Room-Title: Legacy source path bypass\nContext-Room-Project: demo\nContext-Room-Base: ${baseRevision}`,
  ]);
  const proposalHead = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", branch]);
  const exactChanges = git(fixture.seed, [
    "diff",
    "--name-status",
    "-M",
    "-C",
    "--find-copies-harder",
    `${baseRevision}...${proposalHead}`,
  ]);
  assert.match(exactChanges, new RegExp(`C100\\s+${copySource.replaceAll("/", "\\/")}\\s+${copyTarget.replaceAll("/", "\\/")}`));
  git(fixture.seed, ["switch", "main"]);

  const reviewRoot = path.join(fixture.base, "legacy-cross-scope-review");
  git(fixture.seed, ["worktree", "add", "--detach", reviewRoot, baseRevision]);
  const patch = execFileSync("git", ["diff", "--binary", "--full-index", `${baseRevision}...${proposalHead}`, "--"], {
    cwd: fixture.seed,
    encoding: null,
  });
  const applied = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], {
    cwd: reviewRoot,
    input: patch,
    encoding: "utf8",
  });
  assert.equal(applied.status, 0, applied.stderr);
  initializeContextRoomProject(reviewRoot, {
    title: "Legacy cross-scope review",
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });
  const authorityId = randomUUID();
  const metadata = {
    version: 1,
    authorityId,
    reviewRoot: fs.realpathSync(reviewRoot),
    repository: connection.repository,
    projectId: "demo",
    scope: "project",
    allowedExact: [],
    allowedPrefixes: ["projects/demo/docs/", "projects/demo/skills/"],
    proposalFiles: [copyTarget],
    dependencyReviews: [],
    proposal: branch,
    proposalHead,
    title: "Legacy source path bypass",
    description: "Simulate a persisted review authority created before source-path validation.",
    semanticReviewRequired: false,
    sessionId: "",
    baseRevision,
    defaultBranch: "main",
    createdAt: new Date().toISOString(),
  };
  const authorityRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "review-authority");
  fs.mkdirSync(authorityRoot, { recursive: true });
  fs.writeFileSync(path.join(authorityRoot, `${authorityId}.json`), JSON.stringify(metadata, null, 2) + "\n");
  writeFile(reviewRoot, ".context-room/shared-review.json", JSON.stringify({
    version: 1,
    authorityId,
    proposal: branch,
    proposalHead,
  }, null, 2) + "\n");
  for (const filePath of [copyTarget]) {
    writeDocReviewDecision(reviewRoot, filePath, {
      status: "verified",
      note: "Legacy target-only review",
    });
  }

  assert.throws(
    () => acceptSharedReview(reviewRoot, { message: "Reject legacy cross-scope sources" }),
    (error) => error.code === "shared-proposal-scope-violation" && error.statusCode === 403,
  );
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), baseRevision);
});

test("proposal branch scope must match the requested scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  assert.throws(
    () => createSharedProposal(fixture.project, { title: "Mismatch", scope: "project", branch: "proposal/global/mismatch" }),
    /branch scope must be proposal\/demo\//,
  );
});

test("shared proposals reject symlinks and binary files", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const symlinkProposal = createSharedProposal(fixture.project, { title: "Link", branch: "proposal/demo/link" });
  configureGit(symlinkProposal.root);
  fs.symlinkSync("/tmp", path.join(symlinkProposal.root, "projects/demo/docs/escape.md"));
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: symlinkProposal.branch }), /symbolic link/);

  const binaryProposal = createSharedProposal(fixture.project, { title: "Binary", branch: "proposal/demo/binary" });
  configureGit(binaryProposal.root);
  fs.writeFileSync(path.join(binaryProposal.root, "projects/demo/docs/binary.md"), Buffer.from([0, 1, 2, 3]));
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: binaryProposal.branch }), /UTF-8 text/);
});

test("acceptance rejects manual changes outside the proposal scope", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Scoped", branch: "proposal/demo/scoped" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nScoped.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", { status: "verified", note: "Reviewed exact proposal file" });
  writeFile(review.reviewRoot, "projects/demo/UNREVIEWED.md", "# Manual escape\n");
  assert.throws(() => acceptSharedReview(review.reviewRoot), /outside projects\/demo\/docs\/ or projects\/demo\/skills\//);
});

test("an invalid online manifest never silently falls back to the previous snapshot", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const manifestPath = path.join(fixture.seed, ".context-room/shared-repository.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.projectsPath = "projects/..";
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  git(fixture.seed, ["add", manifestPath]);
  git(fixture.seed, ["commit", "-m", "Break shared manifest"]);
  git(fixture.seed, ["push", "origin", "main"]);
  assert.throws(() => syncSharedContext(fixture.project, { allowOffline: true }), /safe repository-relative path|normalized/);
});

test("sync removes only obsolete managed skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const managedLink = path.join(fixture.project, ".agents/skills/demo-workflow");
  assert.equal(fs.lstatSync(managedLink).isSymbolicLink(), true);
  fs.rmSync(path.join(fixture.seed, "projects/demo/skills/demo-workflow"), { recursive: true });
  git(fixture.seed, ["add", "-A"]);
  git(fixture.seed, ["commit", "-m", "Remove project skill"]);
  git(fixture.seed, ["push", "origin", "main"]);
  syncSharedContext(fixture.project, { allowOffline: false });
  assert.equal(fs.existsSync(managedLink), false);
  assert.throws(() => fs.lstatSync(managedLink), /ENOENT/);
});

test("shared read-only paths cannot be reverted or deleted through alternate mutations", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const sharedDoc = listExplorerFiles(fixture.project).find((file) => file.path.endsWith("/projects/demo/docs/README.md"));
  const sharedDocs = readMemoryWebappSettings(fixture.project).readOnlyPaths.find((item) => item.endsWith("/projects/demo/docs/"));
  assert.throws(() => revertMemoryFile(fixture.project, sharedDoc.path), /read-only/);
  assert.throws(() => deleteMemoryPaths(fixture.project, [sharedDocs]), /read-only/);
});

test("project catalog resolves nested cwd and explicitly binds the same project in another worktree", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const sourceRemote = path.join(fixture.base, "source.git");
  const firstClone = path.join(fixture.base, "source-one");
  const secondClone = path.join(fixture.base, "source-two");
  git(fixture.base, ["init", "--bare", "--initial-branch=main", sourceRemote], { stdio: "ignore" });
  git(fixture.base, ["clone", sourceRemote, firstClone], { stdio: "ignore" });
  configureGit(firstClone);
  writeFile(firstClone, "products/demo/website/README.md", "# Website\n");
  git(firstClone, ["add", "."]);
  git(firstClone, ["commit", "-m", "Initialize source"]);
  git(firstClone, ["push", "origin", "main"]);
  git(fixture.base, ["clone", sourceRemote, secondClone], { stdio: "ignore" });

  writeFile(fixture.seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo", source: { remotes: [sourceRemote], subpath: "products/demo" } }],
  }, null, 2) + "\n");
  git(fixture.seed, ["add", "projects.json"]);
  git(fixture.seed, ["commit", "-m", "Register source mapping"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const firstProject = path.join(firstClone, "products/demo");
  const nested = path.join(firstProject, "website");
  initializeContextRoomProject(firstProject, { title: "Demo" });
  const detected = detectSharedProject(nested, { repository: fixture.remote });
  assert.equal(detected.projectId, "demo");
  assert.equal(detected.projectRoot, fs.realpathSync(firstProject));
  const explicit = detectSharedProject(nested, { repository: fixture.remote, projectId: "demo" });
  assert.equal(explicit.projectRoot, fs.realpathSync(firstProject));
  connectSharedContext(nested, { repository: fixture.remote, projectId: "demo" });
  assert.equal(readSharedProjectConnection(nested).projectRoot, fs.realpathSync(firstProject));
  assert.equal(fs.lstatSync(path.join(firstProject, ".agents/skills/demo-workflow")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(nested, ".agents/skills/demo-workflow")), false);

  const secondNested = path.join(secondClone, "products/demo/website");
  assert.equal(readSharedProjectConnection(secondNested), null);
  const secondProject = path.join(secondClone, "products/demo");
  initializeContextRoomProject(secondProject, { title: "Demo second worktree" });
  connectSharedContext(secondNested, { repository: fixture.remote, projectId: "demo" });
  const secondConnection = readSharedProjectConnection(secondNested);
  assert.equal(secondConnection.projectId, "demo");
  assert.equal(secondConnection.projectRoot, fs.realpathSync(secondProject));
  assert.equal(fs.lstatSync(path.join(secondProject, ".agents/skills/demo-workflow")).isSymbolicLink(), true);

  fs.rmSync(path.join(fixture.seed, "projects/demo/skills/demo-workflow"), { recursive: true });
  git(fixture.seed, ["add", "-A"]);
  git(fixture.seed, ["commit", "-m", "Remove registered worktree skill"]);
  git(fixture.seed, ["push", "origin", "main"]);
  syncSharedContext(firstProject, { allowOffline: false });
  assert.equal(fs.existsSync(path.join(firstProject, ".agents/skills/demo-workflow")), false);
  assert.equal(fs.existsSync(path.join(secondProject, ".agents/skills/demo-workflow")), false);
});

test("direct proposal review reopening reuses the exact room and cached DocQA", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Direct warm review",
    branch: "proposal/demo/direct-warm-review",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nOpen this exact review once.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  let materializationCalls = 0;
  let docQaCalls = 0;
  const room = createMemoryServer({
    root: fixture.project,
    sharedReviewMaterializationTask: async ({ sourceRoot, proposal: branch, expectedHead }) => {
      materializationCalls += 1;
      return materializeSharedReview(sourceRoot, { proposal: branch, expectedHead });
    },
    sharedReviewDocQaTask: (reviewRoot) => {
      docQaCalls += 1;
      return buildDocQaReport(reviewRoot, { readOnly: true });
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const openReview = () => fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch, expectedHead: published.head }),
  });

  const firstResponse = await openReview();
  const first = await firstResponse.json();
  assert.equal(firstResponse.status, 201, JSON.stringify(first));
  assert.equal(first.docqa.pendingPaths.includes("projects/demo/docs/README.md"), true);
  assert.equal(materializationCalls, 1);
  assert.equal(docQaCalls, 1);

  const secondResponse = await openReview();
  const second = await secondResponse.json();
  assert.equal(secondResponse.status, 201, JSON.stringify(second));
  assert.equal(second.url, first.url);
  assert.equal(second.reviewRoot, first.reviewRoot);
  assert.equal(materializationCalls, 1, "an exact warm room must not rematerialize");
  assert.equal(docQaCalls, 1, "unchanged review evidence must reuse the cached DocQA report");
});

test("shared Context Room API lists proposals and opens an exact review room", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "API review", branch: "proposal/demo/api-review" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAPI review.\n\nDiscard this separate hunk.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const room = createMemoryServer({ root: fixture.project });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const sharedResponse = await fetch(origin + "/api/shared-context");
  const shared = await sharedResponse.json();
  assert.equal(shared.enabled, true);
  assert.equal(shared.mode, "project");
  assert.equal(shared.proposals.some((item) => item.branch === proposal.branch && item.head === published.head), true);
  const skillsResponse = await fetch(origin + "/api/shared-skills/locations?refresh=0");
  assert.equal(skillsResponse.status, 200);
  const skills = await skillsResponse.json();
  assert.equal(skills.connected, true);
  assert.equal(skills.collections.some((collection) => collection.id === "project-demo"), true);
  const assignmentPreviewResponse = await fetch(origin + "/api/shared-skills/assignments/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex", "claude-code"] }),
  });
  assert.equal(assignmentPreviewResponse.status, 200);
  assert.deepEqual((await assignmentPreviewResponse.json()).assignment.providers, ["codex", "claude-code"]);
  const providerResponse = await fetch(origin + "/api/shared-skills/providers", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "project", provider: "codex", state: "disabled" }),
  });
  assert.equal(providerResponse.status, 200);
  assert.equal((await providerResponse.json()).status.projectProviderOverrides.codex, "disabled");
  await fetch(origin + "/api/shared-skills/providers", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scope: "project", provider: "codex", state: "inherit" }) });
  const localDestination = path.join(fixture.base, "api-local-skills");
  const localPreviewResponse = await fetch(origin + "/api/shared-skills/locations/preview", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignmentId: "project-demo-codex", collectionId: "project-demo", provider: "custom", scope: "project", destination: localDestination }),
  });
  assert.equal(localPreviewResponse.status, 200);
  const localLinkResponse = await fetch(origin + "/api/shared-skills/locations/link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignmentId: "project-demo-codex", collectionId: "project-demo", provider: "custom", scope: "project", destination: localDestination }),
  });
  assert.equal(localLinkResponse.status, 201);
  const localMount = await localLinkResponse.json();
  const localUnlinkResponse = await fetch(origin + "/api/shared-skills/locations/link", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: localMount.mount.id }) });
  assert.equal(localUnlinkResponse.status, 200);
  const assignmentMutationResponse = await fetch(origin + "/api/shared-skills/assignments", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex", "claude-code"], title: "API assignment", description: "Exercise the assignment proposal API." }) });
  assert.equal(assignmentMutationResponse.status, 201);
  assert.equal((await assignmentMutationResponse.json()).localFilesChanged, false);
  const unassignmentPreviewResponse = await fetch(origin + "/api/shared-skills/assignments/unassign/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignmentId: "project-demo-codex" }) });
  assert.equal(unassignmentPreviewResponse.status, 200);
  const unassignmentResponse = await fetch(origin + "/api/shared-skills/assignments", { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ assignmentId: "project-demo-codex", title: "API unassignment", description: "Exercise the unassignment proposal API." }) });
  assert.equal(unassignmentResponse.status, 201);
  const apiImportSource = path.join(fixture.base, "api-import-skills");
  writeFile(apiImportSource, "api-review/SKILL.md", "# API review\n");
  const importPreviewResponse = await fetch(origin + "/api/shared-skills/import/preview", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDirectory: apiImportSource, collectionId: "api-import", collectionPath: "skills/api-import" }) });
  assert.equal(importPreviewResponse.status, 200);
  const importResponse = await fetch(origin + "/api/shared-skills/import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceDirectory: apiImportSource, collectionId: "api-import", collectionTitle: "API import", collectionPath: "skills/api-import", providers: ["codex"], scope: "project", projectIds: ["demo"], destination: apiImportSource, title: "API import proposal", description: "Exercise the skills import API." }) });
  assert.equal(importResponse.status, 201);
  assert.equal(fs.lstatSync(path.join(apiImportSource, "api-review")).isDirectory(), true);

  const reviewResponse = await fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch, expectedHead: published.head }),
  });
  assert.equal(reviewResponse.status, 201);
  const opened = await reviewResponse.json();
  assert.equal(opened.review.proposalHead, published.head);
  assert.equal(opened.review.title, "API review");
  assert.equal(opened.review.description, "");
  assert.deepEqual(opened.docqa.pendingPaths, ["projects/demo/docs/README.md"]);
  assert.deepEqual(opened.docqa.reviewedPaths, []);
  assert.equal("reviewAgentInstructions" in readMemoryWebappSettings(opened.reviewRoot), false);
  const reviewPage = await fetch(opened.url + "/");
  assert.equal(
    reviewPage.headers.get("content-security-policy"),
    `frame-ancestors 'self' http://127.0.0.1:${room.server.address().port} http://localhost:${room.server.address().port}`,
  );
  const reviewHtml = await reviewPage.text();
  const reviewOwnerNonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(reviewHtml)?.[1] || "";
  assert.ok(reviewOwnerNonce);
  const reviewReturnNavigationHeaders = {
    referer: `${opened.url}/`,
    "sec-fetch-site": "same-site",
    "sec-fetch-mode": "navigate",
    "sec-fetch-dest": "document",
  };
  const reviewReturnNavigation = await rawHttpRequest(`${origin}/?hub=1&view=hub`, {
    headers: reviewReturnNavigationHeaders,
  });
  assert.equal(reviewReturnNavigation.statusCode, 200);
  assert.match(reviewReturnNavigation.body, /<html[^>]+data-context-room-runtime-profile="local"/);
  const reviewReturnHead = await rawHttpRequest(`${origin}/?hub=1&view=hub`, {
    method: "HEAD",
    headers: reviewReturnNavigationHeaders,
  });
  assert.equal(reviewReturnHead.statusCode, 200);
  assert.equal(reviewReturnHead.body, "");
  const crossSiteReviewReturnNavigation = await rawHttpRequest(`${origin}/?hub=1&view=hub`, {
    headers: { ...reviewReturnNavigationHeaders, "sec-fetch-site": "cross-site" },
  });
  assert.equal(crossSiteReviewReturnNavigation.statusCode, 200);
  for (const blocked of [
    await rawHttpRequest(`${origin}/api/health`, { headers: reviewReturnNavigationHeaders }),
    await rawHttpRequest(`${origin}/`, { method: "POST", headers: reviewReturnNavigationHeaders }),
    await rawHttpRequest(`${origin}/`, { headers: { ...reviewReturnNavigationHeaders, "sec-fetch-dest": "iframe" } }),
    await rawHttpRequest(`${origin}/`, { headers: { ...reviewReturnNavigationHeaders, "sec-fetch-mode": "no-cors" } }),
    await rawHttpRequest(`${origin}/`, { headers: { ...reviewReturnNavigationHeaders, referer: "http://127.0.0.1:65534/" } }),
    await rawHttpRequest(`${origin}/`, { headers: { ...reviewReturnNavigationHeaders, origin: "https://attacker.example" } }),
    await rawHttpRequest(`${origin}/`, { headers: { ...reviewReturnNavigationHeaders, referer: "https://attacker.example/", "sec-fetch-site": "cross-site" } }),
  ]) {
    assert.equal(blocked.statusCode, 403);
    assert.equal(JSON.parse(blocked.body).code, "context_room_cross_site_request_denied");
  }
  const exactResponse = await fetch(opened.url + "/api/shared-context");
  const exact = await exactResponse.json();
  assert.equal(exact.mode, "review");
  assert.equal(exact.review.proposalHead, published.head);
  const acceptWithoutChallenge = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(acceptWithoutChallenge.status, 403);
  assert.equal((await acceptWithoutChallenge.json()).code, "shared_context_acceptance_challenge_required");
  assert.doesNotMatch(git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]), /API review/);

  const incompleteChallengeResponse = await fetch(opened.url + "/api/shared-context/accept-challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(incompleteChallengeResponse.status, 409);
  const incompleteChallenge = await incompleteChallengeResponse.json();
  assert.equal(incompleteChallenge.code, "shared_context_review_incomplete");
  assert.match(incompleteChallenge.error, /1 file\(s\) remain without current review proof/);

  const reopenedResponse = await fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch, expectedHead: published.head }),
  });
  assert.equal(reopenedResponse.status, 201);
  const reopened = await reopenedResponse.json();
  assert.equal(reopened.url, opened.url);
  assert.equal(reopened.reviewRoot, opened.reviewRoot);

  writeFile(opened.reviewRoot, "projects/demo/docs/README.md", "# Demo\n\nAPI review.\n");
  const decisionResponse = await fetch(opened.url + "/api/docqa/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({
      path: "projects/demo/docs/README.md",
      status: "verified",
      note: "Human file decision",
      expectedContentHash: createHash("sha256")
        .update(fs.readFileSync(path.join(opened.reviewRoot, "projects/demo/docs/README.md"), "utf8"), "utf8")
        .digest("hex"),
    }),
  });
  assert.equal(decisionResponse.status, 200);
  const decision = await decisionResponse.json();
  assert.equal(decision.proposalFinalization, null);
  git(fixture.seed, ["fetch", "origin"]);
  assert.doesNotMatch(git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]), /API review/);

  const reviewedPreviewResponse = await fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch, expectedHead: published.head }),
  });
  assert.equal(reviewedPreviewResponse.status, 201);
  const reviewedPreview = await reviewedPreviewResponse.json();
  assert.deepEqual(reviewedPreview.docqa.pendingPaths, []);
  assert.deepEqual(reviewedPreview.docqa.reviewedPaths, ["projects/demo/docs/README.md"]);
  const preAcceptHub = contextHubUiState(fixture.project, { refreshShared: true, force: true });
  assert.equal(preAcceptHub.proposals.some((item) => item.branch === proposal.branch), true);

  const directAcceptResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(directAcceptResponse.status, 403);
  assert.equal((await directAcceptResponse.json()).code, "shared_context_acceptance_challenge_required");

  const staleChallengeResponse = await fetch(opened.url + "/api/shared-context/accept-challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40) }),
  });
  assert.equal(staleChallengeResponse.status, 409);
  assert.equal((await staleChallengeResponse.json()).code, "shared_context_proposal_head_mismatch");

  const challengeResponse = await fetch(opened.url + "/api/shared-context/accept-challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();
  assert.ok(challenge.challengeId);
  assert.equal(challenge.action, "accept");
  assert.equal(challenge.authorityId, opened.review.authorityId);
  assert.equal(challenge.proposalHead, published.head);
  assert.ok(Date.parse(challenge.expiresAt) > Date.now());

  const mismatchedAcceptResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40), challengeId: challenge.challengeId }),
  });
  assert.equal(mismatchedAcceptResponse.status, 409);
  assert.equal((await mismatchedAcceptResponse.json()).code, "shared_context_proposal_head_mismatch");

  const acceptResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: published.head, challengeId: challenge.challengeId }),
  });
  assert.equal(acceptResponse.status, 200);
  const accepted = await acceptResponse.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.proposalHead, published.head);
  assert.equal(accepted.deliveryVerified, true);
  const hubRefreshStatus = accepted.hubRefresh?.status;
  assert.ok(
    ["complete", "pending"].includes(hubRefreshStatus),
    `Expected an explicit Hub refresh outcome, received ${JSON.stringify(accepted.hubRefresh)}`,
  );
  if (hubRefreshStatus === "pending") {
    assert.ok(
      accepted.hubRefresh?.reason === "timeout" || typeof accepted.hubRefresh?.error === "string",
      `Expected a pending Hub refresh reason, received ${JSON.stringify(accepted.hubRefresh)}`,
    );
  }
  assert.equal(accepted.defaultBranch, "main");
  assert.match(accepted.commit, /^[a-f0-9]{40}$/);
  git(fixture.seed, ["fetch", "origin"]);
  const acceptedReadme = git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]);
  assert.match(acceptedReadme, /API review/);
  assert.doesNotMatch(acceptedReadme, /Discard this separate hunk/);
  assert.match(accepted.verifiedRemoteHead, /^[a-f0-9]{40}$/);
  assert.match(accepted.flashToken, /^[A-Za-z0-9_-]{32}$/);
  const flashResponse = await fetch(origin + "/api/context-hub/flash", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-owner-nonce": room.ownerMutationNonce,
    },
    body: JSON.stringify({ token: accepted.flashToken }),
  });
  assert.equal(flashResponse.status, 200);
  assert.deepEqual(await flashResponse.json(), {
    outcome: "merge",
    commit: accepted.commit,
    hubRefresh: { status: hubRefreshStatus },
  });
  const replayedFlashResponse = await fetch(origin + "/api/context-hub/flash", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-owner-nonce": room.ownerMutationNonce,
    },
    body: JSON.stringify({ token: accepted.flashToken }),
  });
  assert.equal(replayedFlashResponse.status, 404);
  assert.equal((await replayedFlashResponse.json()).code, "verified_acceptance_flash_invalid");
  git(fixture.seed, ["fetch", "origin"]);
  assert.match(git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]), /API review/);
  assert.equal(
    spawnSync("git", ["merge-base", "--is-ancestor", accepted.commit, accepted.verifiedRemoteHead], { cwd: fixture.seed }).status,
    0,
  );
  assert.equal(
    git(fixture.seed, ["ls-remote", "--heads", "origin", "refs/heads/main"]).split(/\s+/)[0],
    accepted.verifiedRemoteHead,
  );
  assert.equal(
    git(fixture.seed, ["ls-remote", "--heads", "origin", `refs/heads/${proposal.branch}`]),
    "",
  );

  assert.equal(listSharedProposals(fixture.project).some((item) => item.branch === proposal.branch), false);
  const refreshedHub = contextHubUiState(fixture.project, {
    refreshShared: hubRefreshStatus === "pending",
    force: hubRefreshStatus === "pending",
  });
  assert.equal(refreshedHub.proposals.some((item) => item.branch === proposal.branch), false);
  assert.equal(refreshedHub.items.some((item) => item.type === "shared" && item.branch === proposal.branch), false);
  assert.equal(refreshedHub.summary.proposals, preAcceptHub.summary.proposals - 1);
  assert.equal(
    refreshedHub.projects.find((item) => item.shared?.repository === fixture.remote && item.shared?.projectId === "demo")?.sharedProposalCount,
    0,
  );

  const replayResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project"), "x-context-room-owner-nonce": reviewOwnerNonce },
    body: JSON.stringify({ expectedProposalHead: published.head, challengeId: challenge.challengeId }),
  });
  assert.equal(replayResponse.status, 409);
  assert.equal((await replayResponse.json()).code, "shared_context_acceptance_challenge_replayed");
});

test("terminal acceptance endpoints journal confirmation opening and confirmation in order", { concurrency: false }, async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const isolatedHubHome = withIsolatedEventJournal(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Acceptance audit events",
    branch: "proposal/demo/acceptance-audit-events",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAudit terminal acceptance.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact proposal file reviewed",
  });

  const room = createMemoryServer({ root: review.reviewRoot, contextHubRoot: fixture.project });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const html = await (await fetch(origin + "/")).text();
  const nonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(html)?.[1] || "";
  assert.ok(nonce);
  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": nonce,
  };

  const challengeResponse = await fetch(origin + "/api/shared-context/accept-challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();
  assert.ok(challenge.challengeId);

  const acceptResponse = await fetch(origin + "/api/shared-context/accept", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedProposalHead: published.head,
      challengeId: challenge.challengeId,
    }),
  });
  assert.equal(acceptResponse.status, 200);
  assert.equal((await acceptResponse.json()).deliveryVerified, true);

  const journalPath = contextRoomEventJournalPath();
  assert.equal(path.relative(isolatedHubHome, journalPath).startsWith(".."), false);
  const events = readContextRoomEvents({ types: "proposal.acceptance.*" }).events;
  assert.deepEqual(events.map((event) => event.type), [
    "proposal.acceptance.confirmation_opened",
    "proposal.acceptance.confirmed",
  ]);
  const expectedActor = `local-human:${createHash("sha256").update(nonce).digest("hex")}`;
  assert.deepEqual(events.map((event) => event.actor), [expectedActor, expectedActor]);
  for (const event of events) {
    assert.equal(event.projectId, "demo");
    assert.equal(event.sharedProjectId, "demo");
    assert.equal(event.sharedRepository, fixture.remote);
    assert.deepEqual(event.resource, { proposal: proposal.branch, proposalHead: published.head });
    assert.equal(event.data.action, "accept");
    assert.equal(event.data.authorityId, review.metadata.authorityId);
    assert.match(event.data.reviewResultDigest, /^[a-f0-9]{64}$/);
  }
  assert.equal(events[1].data.deliveryVerified, true);
  assert.match(events[1].data.commit, /^[a-f0-9]{40}$/);
  const rawJournal = fs.readFileSync(journalPath, "utf8");
  assert.doesNotMatch(rawJournal, /challengeid/i);
  assert.equal(rawJournal.includes(challenge.challengeId), false);
});

test("terminal acceptance challenge is invalidated when review evidence changes after confirmation opens", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Challenge consumption after unreview",
    branch: "proposal/demo/challenge-consumption-after-unreview",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nReview this revision.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });

  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const html = await (await fetch(origin + "/")).text();
  const nonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(html)?.[1] || "";
  assert.ok(nonce);
  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": nonce,
  };
  const filePath = "projects/demo/docs/README.md";
  const reviewFile = () => fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedProposalHead: published.head,
      decision: "accept",
      files: [filePath],
    }),
  });

  assert.equal((await reviewFile()).status, 200);
  const challengeResponse = await fetch(origin + "/api/shared-context/accept-challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();

  const unreviewResponse = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, path: filePath }),
  });
  assert.equal(unreviewResponse.status, 200);

  const incompleteAcceptResponse = await fetch(origin + "/api/shared-context/accept", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, challengeId: challenge.challengeId }),
  });
  assert.equal(incompleteAcceptResponse.status, 409);
  assert.equal((await incompleteAcceptResponse.json()).code, "shared_context_review_incomplete");

  assert.equal((await reviewFile()).status, 200);
  const replayResponse = await fetch(origin + "/api/shared-context/accept", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, challengeId: challenge.challengeId }),
  });
  assert.equal(replayResponse.status, 403);
  assert.equal((await replayResponse.json()).code, "shared_context_acceptance_challenge_mismatch");
});

test("terminal acceptance returns a verified result with Hub refresh pending when snapshot reconstruction blocks", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Bounded Hub refresh",
    branch: "proposal/demo/bounded-hub-refresh",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nDeliver before the Hub snapshot finishes.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });

  let refreshStarted = 0;
  let notifyRefreshStarted;
  const refreshStartedPromise = new Promise((resolve) => { notifyRefreshStarted = resolve; });
  const room = createMemoryServer({
    root: review.reviewRoot,
    contextHubRoot: fixture.project,
    contextHubSnapshotRefresh: () => {
      refreshStarted += 1;
      notifyRefreshStarted();
      return new Promise(() => {});
    },
    contextHubAcceptRefreshTimeoutMs: 40,
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const html = await (await fetch(origin + "/")).text();
  const nonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(html)?.[1] || "";
  assert.ok(nonce);
  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": nonce,
  };
  const filePath = "projects/demo/docs/README.md";
  const expectedContentHash = createHash("sha256")
    .update(fs.readFileSync(path.join(review.reviewRoot, filePath), "utf8"), "utf8")
    .digest("hex");
  const fileDecision = await fetch(origin + "/api/docqa/review", {
    method: "POST",
    headers,
    body: JSON.stringify({
      path: filePath,
      status: "verified",
      note: "Human file decision",
      expectedContentHash,
    }),
  });
  assert.equal(fileDecision.status, 200);
  const challengeResponse = await fetch(origin + "/api/shared-context/accept-challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();

  const acceptRequest = fetch(origin + "/api/shared-context/accept", {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({ expectedProposalHead: published.head, challengeId: challenge.challengeId }),
  });
  await refreshStartedPromise;
  let responseDeadline;
  const acceptResponse = await Promise.race([
    acceptRequest,
    new Promise((resolve) => { responseDeadline = setTimeout(() => resolve(null), 1_000); }),
  ]);
  clearTimeout(responseDeadline);
  assert.ok(acceptResponse, "Acceptance did not return after the Hub refresh timeout elapsed");
  assert.equal(acceptResponse.status, 200);
  const accepted = await acceptResponse.json();
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.deliveryVerified, true);
  assert.match(accepted.commit, /^[a-f0-9]{40}$/);
  assert.equal(refreshStarted, 1);
  assert.equal(accepted.hubRefresh?.status, "pending");

  git(fixture.seed, ["fetch", "origin"]);
  assert.equal(
    spawnSync("git", ["merge-base", "--is-ancestor", accepted.commit, "origin/main"], { cwd: fixture.seed }).status,
    0,
  );
});

test("reopening the same proposal head after shared main advances creates a fresh pending review", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Re-review after main advances",
    branch: "proposal/demo/rereview-after-main",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nProposal revision.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });

  const room = createMemoryServer({ root: fixture.project });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const openReview = () => fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch, expectedHead: published.head }),
  });

  const openedResponse = await openReview();
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json();
  const exactResponse = await fetch(opened.url + "/api/shared-context");
  const exactProjectId = exactResponse.headers.get("x-context-room-project");
  const reviewPage = await fetch(opened.url + "/");
  const reviewOwnerNonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(await reviewPage.text())?.[1] || "";
  assert.ok(reviewOwnerNonce);
  const decisionResponse = await fetch(opened.url + "/api/docqa/review", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": exactProjectId,
      "x-context-room-owner-nonce": reviewOwnerNonce,
    },
    body: JSON.stringify({
      path: "projects/demo/docs/README.md",
      status: "verified",
      note: "Review the original base",
      expectedContentHash: createHash("sha256")
        .update(fs.readFileSync(path.join(opened.reviewRoot, "projects/demo/docs/README.md"), "utf8"), "utf8")
        .digest("hex"),
    }),
  });
  assert.equal(decisionResponse.status, 200);

  writeFile(fixture.seed, "projects/demo/docs/BASELINE.md", "# Accepted baseline\n");
  git(fixture.seed, ["add", "-A"]);
  git(fixture.seed, ["commit", "-m", "Advance accepted shared context"]);
  git(fixture.seed, ["push", "origin", "main"]);

  const reopenedResponse = await openReview();
  assert.equal(reopenedResponse.status, 201);
  const reopened = await reopenedResponse.json();
  assert.notEqual(reopened.reviewRoot, opened.reviewRoot);
  assert.notEqual(reopened.review.baseRevision, opened.review.baseRevision);
  assert.deepEqual(reopened.docqa.pendingPaths, ["projects/demo/docs/README.md"]);
  assert.deepEqual(reopened.docqa.reviewedPaths, []);
});

test("shared proposal file batches preflight every file before accepting or rejecting changes", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Batch review", branch: "proposal/demo/batch-review" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/KEEP.md", "# Keep\n");
  writeFile(proposal.root, "projects/demo/docs/DROP.md", "# Drop\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });

  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const html = await (await fetch(origin + "/")).text();
  const nonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(html)?.[1] || "";
  const projectHeader = { "x-context-room-project": room.projectId, "x-context-room-owner-nonce": nonce, "content-type": "application/json" };
  const legacyPayloadResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({
      expectedProposalHead: published.head,
      decision: "accept",
      files: [{ path: "projects/demo/docs/KEEP.md", expectedContentHash: "0".repeat(64) }],
    }),
  });
  assert.equal(legacyPayloadResponse.status, 400);
  assert.deepEqual((await (await fetch(origin + "/api/docqa")).json()).reviewedPaths, []);

  const injectedFieldResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({
      expectedProposalHead: published.head,
      decision: "accept",
      files: ["projects/demo/docs/KEEP.md"],
      content: "client-controlled",
    }),
  });
  assert.equal(injectedFieldResponse.status, 400);
  assert.deepEqual((await (await fetch(origin + "/api/docqa")).json()).reviewedPaths, []);

  for (const body of [
    { expectedProposalHead: published.head, decision: "accept", files: ["projects/demo/docs/KEEP.md", "projects/demo/docs/KEEP.md"] },
    { expectedProposalHead: published.head, decision: "accept", files: ["./projects/demo/docs/KEEP.md"] },
  ]) {
    const invalidPathResponse = await fetch(origin + "/api/shared-context/review-files", {
      method: "POST",
      headers: projectHeader,
      body: JSON.stringify(body),
    });
    assert.equal(invalidPathResponse.status, 400);
  }
  const wrongHeadResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40), decision: "accept", files: ["projects/demo/docs/KEEP.md"] }),
  });
  assert.equal(wrongHeadResponse.status, 409);

  writeFile(review.reviewRoot, "projects/demo/docs/KEEP.md", "# Concurrent edit\n");
  const tamperedResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "accept", files: ["projects/demo/docs/KEEP.md"] }),
  });
  assert.equal(tamperedResponse.status, 409);
  writeFile(review.reviewRoot, "projects/demo/docs/KEEP.md", "# Keep\n");

  const acceptResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "accept", files: ["projects/demo/docs/KEEP.md"] }),
  });
  assert.equal(acceptResponse.status, 200);
  const replayDecisionResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "accept", files: ["projects/demo/docs/KEEP.md"] }),
  });
  assert.equal(replayDecisionResponse.status, 409);
  const rejectResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "reject", files: ["projects/demo/docs/DROP.md"] }),
  });
  assert.equal(rejectResponse.status, 200);
  const result = await rejectResponse.json();
  assert.deepEqual(result.docqa.reviewedPaths.sort(), ["projects/demo/docs/DROP.md", "projects/demo/docs/KEEP.md"]);
  assert.equal(fs.existsSync(path.join(review.reviewRoot, "projects/demo/docs/KEEP.md")), true);
  assert.equal(fs.existsSync(path.join(review.reviewRoot, "projects/demo/docs/DROP.md")), false);

  const staleUnreviewResponse = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40), path: "projects/demo/docs/DROP.md" }),
  });
  assert.equal(staleUnreviewResponse.status, 409);
  assert.equal((await staleUnreviewResponse.json()).code, "shared_context_review_batch_stale");

  const unreviewDropResponse = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: published.head, path: "projects/demo/docs/DROP.md" }),
  });
  assert.equal(unreviewDropResponse.status, 200);
  const unreviewedDrop = await unreviewDropResponse.json();
  assert.deepEqual(unreviewedDrop.docqa.reviewedPaths, ["projects/demo/docs/KEEP.md"]);
  assert.deepEqual(unreviewedDrop.docqa.pendingPaths, ["projects/demo/docs/DROP.md"]);
  assert.equal(fs.readFileSync(path.join(review.reviewRoot, "projects/demo/docs/DROP.md"), "utf8"), "# Drop\n");

  const duplicateUnreviewResponse = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: published.head, path: "projects/demo/docs/DROP.md" }),
  });
  assert.equal(duplicateUnreviewResponse.status, 409);

  const unreviewKeepResponse = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers: projectHeader,
    body: JSON.stringify({ expectedProposalHead: published.head, path: "projects/demo/docs/KEEP.md" }),
  });
  assert.equal(unreviewKeepResponse.status, 200);
  const unreviewedKeep = await unreviewKeepResponse.json();
  assert.deepEqual(unreviewedKeep.docqa.reviewedPaths, []);
  assert.deepEqual(unreviewedKeep.docqa.pendingPaths.sort(), ["projects/demo/docs/DROP.md", "projects/demo/docs/KEEP.md"]);
});

test("rejecting a proposal mode change restores the accepted Git mode", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Reject executable mode", branch: "proposal/demo/reject-executable-mode" });
  configureGit(proposal.root);
  const relativePath = "projects/demo/docs/README.md";
  fs.chmodSync(path.join(proposal.root, relativePath), 0o755);
  assert.match(git(proposal.root, ["diff", "--summary"]), /mode change 100644 => 100755/);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });

  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const html = await (await fetch(origin + "/")).text();
  const nonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(html)?.[1] || "";
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": nonce };
  const response = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedProposalHead: published.head,
      decision: "reject",
      files: [relativePath],
    }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.statSync(path.join(review.reviewRoot, relativePath)).mode & 0o777, 0o644);
  assert.doesNotMatch(git(review.reviewRoot, ["diff", "--summary"]), /mode change/);
});

test("failed proposal batch rollback restores proposal content and mode", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Rollback executable mode", branch: "proposal/demo/rollback-executable-mode" });
  configureGit(proposal.root);
  const relativePath = "projects/demo/docs/README.md";
  const proposalContent = "# Demo\n\nExecutable proposal content.\n";
  writeFile(proposal.root, relativePath, proposalContent);
  fs.chmodSync(path.join(proposal.root, relativePath), 0o755);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, {
    title: `Review · ${proposal.branch}`,
    allowedPaths: ["projects/demo/"],
    watchAllow: ["projects/demo/"],
  });

  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const html = await (await fetch(origin + "/")).text();
  const nonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(html)?.[1] || "";
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": nonce };
  const externalBaselines = path.join(fixture.base, "external-review-baselines");
  const baselinesLink = path.join(review.reviewRoot, ".context-room", "review-baselines");
  fs.mkdirSync(externalBaselines, { recursive: true });
  fs.symlinkSync(externalBaselines, baselinesLink, "dir");

  const response = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers,
    body: JSON.stringify({
      expectedProposalHead: published.head,
      decision: "reject",
      files: [relativePath],
    }),
  });
  const failure = await response.json();
  assert.equal(response.status, 409, JSON.stringify(failure));
  assert.equal(failure.code, "shared_context_review_batch_failed");
  assert.match(failure.error, /review-baselines|symbolic links/);
  const reviewedPath = path.join(review.reviewRoot, relativePath);
  assert.equal(fs.readFileSync(reviewedPath, "utf8"), proposalContent);
  assert.equal(fs.statSync(reviewedPath).mode & 0o777, 0o755);
});

test("copy review reject and unreview never mutate a separately changed source", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Copy with changed source", branch: "proposal/demo/copy-source-sentinel" });
  configureGit(proposal.root);
  const sourcePath = "projects/demo/docs/README.md";
  const copyPath = "projects/demo/docs/COPY.md";
  const baseSource = fs.readFileSync(path.join(proposal.root, sourcePath), "utf8");
  writeFile(proposal.root, copyPath, baseSource);
  writeFile(proposal.root, sourcePath, "# Demo\n\nDistinct pending source change.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.equal(review.metadata.proposalChanges.find((item) => item.path === copyPath)?.status, "C");
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce };
  const sourceAbs = path.join(review.reviewRoot, sourcePath);
  const sourceIdentity = () => {
    const stats = fs.lstatSync(sourceAbs, { bigint: true });
    return { bytes: fs.readFileSync(sourceAbs), mode: stats.mode.toString(), dev: stats.dev.toString(), ino: stats.ino.toString() };
  };
  const beforeReject = sourceIdentity();
  const reject = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "reject", files: [copyPath] }),
  });
  assert.equal(reject.status, 200, await reject.text());
  assert.deepEqual(sourceIdentity(), beforeReject);
  assert.equal(fs.existsSync(path.join(review.reviewRoot, copyPath)), false);

  const beforeUnreview = sourceIdentity();
  const unreview = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, path: copyPath }),
  });
  assert.equal(unreview.status, 200, await unreview.text());
  assert.deepEqual(sourceIdentity(), beforeUnreview);
  assert.equal(fs.readFileSync(path.join(review.reviewRoot, copyPath), "utf8"), baseSource);

  const externalSentinel = path.join(fixture.base, "copy-source-external-sentinel.md");
  fs.writeFileSync(externalSentinel, "external sentinel\n");
  fs.unlinkSync(sourceAbs);
  fs.symlinkSync(externalSentinel, sourceAbs);
  const symlinkResponse = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "accept", files: [copyPath] }),
  });
  assert.equal(symlinkResponse.status, 409);
  assert.equal(fs.readFileSync(externalSentinel, "utf8"), "external sentinel\n");
});

test("rename review reject and unreview mutate the old and new paths together", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Rename atomically", branch: "proposal/demo/rename-atomically" });
  configureGit(proposal.root);
  const oldPath = "projects/demo/docs/README.md";
  const newPath = "projects/demo/docs/RENAMED.md";
  fs.renameSync(path.join(proposal.root, oldPath), path.join(proposal.root, newPath));
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  assert.deepEqual(review.metadata.proposalChanges.find((item) => item.path === newPath), {
    path: newPath,
    status: "R",
    fromPath: oldPath,
    score: 100,
    reviewKind: "proposal-change",
  });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce };
  const reject = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "reject", files: [newPath] }),
  });
  assert.equal(reject.status, 200, await reject.text());
  assert.equal(fs.existsSync(path.join(review.reviewRoot, oldPath)), true);
  assert.equal(fs.existsSync(path.join(review.reviewRoot, newPath)), false);
  const unreview = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, path: newPath }),
  });
  assert.equal(unreview.status, 200, await unreview.text());
  assert.equal(fs.existsSync(path.join(review.reviewRoot, oldPath)), false);
  assert.equal(fs.existsSync(path.join(review.reviewRoot, newPath)), true);
});

test("deleted proposal files reject and unreview from path-only requests", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Delete whole file", branch: "proposal/demo/delete-whole-file" });
  configureGit(proposal.root);
  const filePath = "projects/demo/docs/README.md";
  fs.unlinkSync(path.join(proposal.root, filePath));
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce };
  const reject = await fetch(origin + "/api/shared-context/review-files", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "reject", files: [filePath] }),
  });
  assert.equal(reject.status, 200, await reject.text());
  assert.equal(fs.existsSync(path.join(review.reviewRoot, filePath)), true);
  const unreview = await fetch(origin + "/api/shared-context/unreview-file", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head, path: filePath }),
  });
  assert.equal(unreview.status, 200, await unreview.text());
  assert.equal(fs.existsSync(path.join(review.reviewRoot, filePath)), false);
});

test("deleted proposal rejection never recreates a parent through a swapped symlink", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const basePath = "projects/demo/docs/removed-parent/BASE.md";
  writeFile(fixture.seed, basePath, "# Base only\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add nested deletion fixture"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Delete nested file", branch: "proposal/demo/delete-nested-file" });
  configureGit(proposal.root);
  fs.unlinkSync(path.join(proposal.root, basePath));
  fs.rmdirSync(path.dirname(path.join(proposal.root, basePath)));
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce };
  const parent = path.join(review.reviewRoot, "projects/demo/docs");
  const movedParent = path.join(review.reviewRoot, "projects/demo/docs-held");
  const outside = path.join(fixture.base, "review-parent-swap-outside");
  const once = path.join(fixture.base, "review-parent-swap.once");
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside shared sentinel\n", "utf8");
  const preload = String.raw`
const fs = require("node:fs");
const originalMkdir = fs.mkdirSync;
const originalRmdir = fs.rmdirSync;
fs.mkdirSync = function(target, ...rest) {
  if (String(target) === "removed-parent" && !fs.existsSync(process.env.CR_SHARED_MKDIR_ONCE)) {
    fs.writeFileSync(process.env.CR_SHARED_MKDIR_ONCE, "1\n", "utf8");
    fs.renameSync(process.env.CR_SHARED_MKDIR_PARENT, process.env.CR_SHARED_MKDIR_MOVED);
    fs.symlinkSync(process.env.CR_SHARED_MKDIR_OUTSIDE, process.env.CR_SHARED_MKDIR_PARENT);
  }
  return originalMkdir.call(this, target, ...rest);
};
fs.rmdirSync = function(target, ...rest) {
  const result = originalRmdir.call(this, target, ...rest);
  if (String(target) === "removed-parent") {
    try {
      if (fs.lstatSync(process.env.CR_SHARED_MKDIR_PARENT).isSymbolicLink()) {
        fs.unlinkSync(process.env.CR_SHARED_MKDIR_PARENT);
        fs.renameSync(process.env.CR_SHARED_MKDIR_MOVED, process.env.CR_SHARED_MKDIR_PARENT);
      }
    } catch {}
  }
  return result;
};
`;
  try {
    await withSharedAnchoredChildPreload(t, "shared-mkdir-parent-swap", preload, {
      CR_SHARED_MKDIR_ONCE: once,
      CR_SHARED_MKDIR_PARENT: parent,
      CR_SHARED_MKDIR_MOVED: movedParent,
      CR_SHARED_MKDIR_OUTSIDE: outside,
    }, async () => {
      const response = await fetch(origin + "/api/shared-context/review-files", {
        method: "POST",
        headers,
        body: JSON.stringify({ expectedProposalHead: published.head, decision: "reject", files: [basePath] }),
      });
      const body = await response.json();
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.code, "managed_context_room_state_unsafe");
      assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
      assert.equal(fs.existsSync(path.join(parent, "removed-parent")), false);
      assert.equal(fs.existsSync(path.join(outside, "removed-parent")), false);
    });
  } finally {
    try { if (fs.lstatSync(parent).isSymbolicLink()) fs.unlinkSync(parent); } catch {}
    if (fs.existsSync(movedParent) && !fs.existsSync(parent)) fs.renameSync(movedParent, parent);
  }
});

test("whole-file acceptance refuses a stale Git mode even when bytes match", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Mode CAS", branch: "proposal/demo/mode-cas" });
  configureGit(proposal.root);
  const filePath = "projects/demo/docs/README.md";
  fs.chmodSync(path.join(proposal.root, filePath), 0o755);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  fs.chmodSync(path.join(review.reviewRoot, filePath), 0o644);
  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const response = await fetch(`http://127.0.0.1:${room.server.address().port}/api/shared-context/review-files`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ expectedProposalHead: published.head, decision: "accept", files: [filePath] }),
  });
  assert.equal(response.status, 409);
  assert.deepEqual(buildDocQaReport(review.reviewRoot).reviewedPaths, []);
});

test("whole-file dependency proofs are independent of batch order", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const dependencyPath = "projects/demo/docs/TRUST.md";
  const dependentPath = "projects/demo/docs/REVIEW.md";
  writeFile(fixture.seed, dependencyPath, "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nBase.\n");
  writeFile(fixture.seed, dependentPath, "---\ncontext_room:\n  id: product.review\n  depends_on:\n    - strategy.trust\n---\n\n# Review\n\nDependent.\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", "Add dependency documents"]);
  git(fixture.seed, ["push", "origin", "main"]);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Dependency batch order", branch: "proposal/demo/dependency-batch-order" });
  configureGit(proposal.root);
  writeFile(proposal.root, dependencyPath, "---\ncontext_room:\n  id: strategy.trust\n---\n\n# Trust\n\nChanged.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce };
  const decide = async (files) => {
    const response = await fetch(origin + "/api/shared-context/review-files", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedProposalHead: published.head, decision: "accept", files }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    return payload;
  };
  const first = await decide([dependencyPath, dependentPath]);
  const firstDependencies = first.files.find((item) => item.path === dependentPath).dependencyVersions;
  for (const filePath of [dependentPath, dependencyPath]) {
    const response = await fetch(origin + "/api/shared-context/unreview-file", {
      method: "POST",
      headers,
      body: JSON.stringify({ expectedProposalHead: published.head, path: filePath }),
    });
    assert.equal(response.status, 200, await response.text());
  }
  const second = await decide([dependentPath, dependencyPath]);
  assert.deepEqual(second.files.find((item) => item.path === dependentPath).dependencyVersions, firstDependencies);
  assert.match(firstDependencies["strategy.trust"], /^[a-f0-9]{64}$/);
});

test("concurrent opposite whole-file decisions serialize with exactly one winner", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Concurrent decisions", branch: "proposal/demo/concurrent-decisions" });
  configureGit(proposal.root);
  const filePath = "projects/demo/docs/README.md";
  const baseContent = fs.readFileSync(path.join(proposal.root, filePath), "utf8");
  const proposalContent = "# Demo\n\nConcurrent proposal result.\n";
  writeFile(proposal.root, filePath, proposalContent);
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  const gate = path.join(fixture.base, "decision-gate");
  const moduleUrl = new URL("../src/context_room.mjs", import.meta.url).href;
  const runDecision = (decision) => new Promise((resolve, reject) => {
    const ready = path.join(fixture.base, `decision-${decision}.ready`);
    const source = `
      import fs from "node:fs";
      import { writeSharedProposalFileBatchDecision } from ${JSON.stringify(moduleUrl)};
      const [root, head, filePath, decision, ready, gate] = process.argv.slice(1);
      fs.writeFileSync(ready, "ready");
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(gate)) Atomics.wait(wait, 0, 0, 10);
      try {
        const result = writeSharedProposalFileBatchDecision(root, { expectedProposalHead: head, decision, files: [filePath] });
        process.stdout.write(JSON.stringify({ ok: true, decision: result.decision }));
      } catch (error) {
        process.stdout.write(JSON.stringify({ ok: false, code: error.code || "", statusCode: error.statusCode || 0, message: error.message }));
      }
    `;
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, review.reviewRoot, published.head, filePath, decision, ready, gate], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `decision child exited ${code}`));
      else resolve({ ready, result: JSON.parse(stdout || "{}") });
    });
  });
  const acceptPromise = runDecision("accept");
  const rejectPromise = runDecision("reject");
  const readyDeadline = Date.now() + 5_000;
  while ((!fs.existsSync(path.join(fixture.base, "decision-accept.ready")) || !fs.existsSync(path.join(fixture.base, "decision-reject.ready"))) && Date.now() < readyDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(Date.now() < readyDeadline, "Concurrent decision children did not reach the start gate");
  fs.writeFileSync(gate, "go");
  const outcomes = (await Promise.all([acceptPromise, rejectPromise])).map((item) => item.result);
  assert.equal(outcomes.filter((item) => item.ok).length, 1, JSON.stringify(outcomes));
  assert.equal(outcomes.filter((item) => !item.ok && item.statusCode === 409).length, 1, JSON.stringify(outcomes));
  const winner = outcomes.find((item) => item.ok).decision;
  assert.equal(fs.readFileSync(path.join(review.reviewRoot, filePath), "utf8"), winner === "accept" ? proposalContent : baseContent);
  assert.deepEqual(buildDocQaReport(review.reviewRoot).reviewedPaths, [filePath]);
});

test("shared review endpoint rejects only the exact opened proposal revision", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "Reject exact", branch: "proposal/demo/reject-exact" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nReject this exact version.\n");
  const published = publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  initializeContextRoomProject(review.reviewRoot, { allowedPaths: ["projects/demo/"], watchAllow: ["projects/demo/"] });
  const room = createMemoryServer({ root: review.reviewRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const html = await (await fetch(origin + "/")).text();
  const nonce = /<meta name="context-room-owner-nonce" content="([^"]+)"/.exec(html)?.[1] || "";
  const headers = { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": nonce };
  const withoutChallenge = await fetch(origin + "/api/shared-context/reject", { method: "POST", headers, body: JSON.stringify({ expectedProposalHead: published.head }) });
  assert.equal(withoutChallenge.status, 403);
  assert.equal((await withoutChallenge.json()).code, "shared_context_rejection_challenge_required");
  assert.equal(listSharedProposals(fixture.project).some((item) => item.branch === proposal.branch), true);

  const stale = await fetch(origin + "/api/shared-context/reject-challenge", { method: "POST", headers, body: JSON.stringify({ expectedProposalHead: "0".repeat(40) }) });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, "shared_context_proposal_head_mismatch");
  const challengeResponse = await fetch(origin + "/api/shared-context/reject-challenge", { method: "POST", headers, body: JSON.stringify({ expectedProposalHead: published.head }) });
  assert.equal(challengeResponse.status, 201);
  const challenge = await challengeResponse.json();
  assert.equal(challenge.action, "reject");
  assert.equal(challenge.authorityId, review.metadata.authorityId);
  assert.equal(challenge.proposal, proposal.branch);
  assert.equal(challenge.proposalHead, published.head);

  const mismatched = await fetch(origin + "/api/shared-context/reject", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40), challengeId: challenge.challengeId }),
  });
  assert.equal(mismatched.status, 409);
  assert.equal((await mismatched.json()).code, "shared_context_proposal_head_mismatch");

  const response = await fetch(origin + "/api/shared-context/reject", { method: "POST", headers, body: JSON.stringify({ expectedProposalHead: published.head, challengeId: challenge.challengeId }) });
  assert.equal(response.status, 200);
  const rejected = await response.json();
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.proposalHead, published.head);
  assert.match(rejected.rejectionBranch, /^rejected\/demo\/reject-exact-/);

  const authorityPath = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    "review-authority",
    `${review.metadata.authorityId}.json`,
  );
  const terminalEvidence = {
    authority: fs.readFileSync(authorityPath, "utf8"),
    journal: fs.readFileSync(contextRoomEventJournalPath(), "utf8"),
    refs: git(fixture.remote, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]),
  };

  const replay = await fetch(origin + "/api/shared-context/reject", { method: "POST", headers, body: JSON.stringify({ expectedProposalHead: published.head, challengeId: challenge.challengeId }) });
  assert.equal(replay.status, 409);
  assert.equal((await replay.json()).code, "shared-proposal-terminal");
  const terminalChallenge = await fetch(origin + "/api/shared-context/reject-challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(terminalChallenge.status, 409);
  assert.equal((await terminalChallenge.json()).code, "shared-proposal-terminal");
  assert.deepEqual({
    authority: fs.readFileSync(authorityPath, "utf8"),
    journal: fs.readFileSync(contextRoomEventJournalPath(), "utf8"),
    refs: git(fixture.remote, ["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads/"]),
  }, terminalEvidence, "a terminal replay must not rewrite authority, append an event, or mutate Git refs");
});
