import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  acceptSharedReview,
  checkSharedGitHubSecurity,
  connectSharedContext,
  createSharedProposal,
  detectSharedProject,
  ensureSharedProposal,
  initializeSharedRepository,
  importSharedInstructions,
  importSharedSkills,
  linkSharedSkillLocation,
  listSharedProposalWorkspaces,
  listSharedRepositoryProposals,
  listSharedProposals,
  materializeSharedRepositoryReview,
  materializeSharedReview,
  previewSharedSkillAssignment,
  previewSharedInstructionAssignment,
  proposeSharedInstructionAssignment,
  proposeSharedInstructionUnassignment,
  proposeSharedSkillAssignment,
  proposeSharedSkillUnassignment,
  publishSharedProposal,
  readSharedMainRevision,
  readSharedProjectConnection,
  readSharedSkillLocalState,
  reconcileSharedSkillLocations,
  reconcileSharedInstructionLocations,
  rejectSharedRepositoryProposal,
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
  readMemoryWebappSettings,
  renderAppHtml,
  revertMemoryFile,
  writeDocReviewDecision,
  writeMemoryFile,
} from "../src/context_room.mjs";

const cli = fileURLToPath(new URL("../bin/context-room.mjs", import.meta.url));

test("shared proposal review keeps navigation and automatic completion in the proposal workspace", () => {
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
  assert.match(html, /Select a project in the Explorer/);
  assert.match(html, /How shared skills work/);
  assert.match(html, /Collections and assignments/);
  assert.match(html, /Local destinations and conflicts/);
  assert.match(html, /Shared resources/);
  assert.match(html, /How shared instructions work/);
  assert.match(html, /Import or update instruction files/);
  assert.match(html, /AGENTS\.md, AGENTS\.override\.md, CLAUDE\.md/);
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
  assert.match(html, /workspaceHead\.dataset\.view = state\.contextHubView/);
  assert.match(html, /x-context-room-target-project/);
  assert.match(html, /target\.searchParams\.set\("hub", "1"\)/);
  assert.match(html, /window\.location\.assign\(target\.toString\(\)\)/);
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
  assert.match(html, /function contextRoomProposalReviewUrl\(url\)/);
  assert.match(html, /target\.searchParams\.set\("returnTo", window\.location\.href\)/);
  assert.doesNotMatch(html, /target\.searchParams\.set\("file", firstReviewFile\)/);
  assert.match(html, /function contextRoomProposalFileUrl\(url, filePath\)/);
  assert.match(html, /state\.contextRoomPreparedReview = result/);
  assert.match(html, /window\.location\.assign\(contextRoomProposalFileUrl\(prepared\.url, filePath\)\)/);
  assert.match(html, /const requestedReviewFile = initialQuery\?\.get\("file"\) \|\| ""/);
  assert.match(html, /state\.sharedContext\?\.mode === "review"\) \{\s*showProposalReview\(\)/);
  assert.match(html, /expectedHead: item\.head \|\| undefined/);
  assert.match(html, /state\.contextRoomOpeningProposalId = item\.id \|\| sharedProposalKey\(item\)/);
  assert.match(html, /Opening review…/);
  assert.match(html, /Choose a file to begin reviewing · exact review preparing in background/);
  assert.doesNotMatch(html, /Preparing exact review…/);
  assert.match(html, /const pendingPaths = new Set\(state\.docqa\?\.pendingPaths/);
  assert.match(html, /const reviewedPaths = new Set\(state\.docqa\?\.reviewedPaths/);
  assert.match(html, /reviewed: Boolean\(!preview && state\.docqa && reviewedPaths\.has\(filePath\)\)/);
  assert.doesNotMatch(html, /reviewed: Boolean\([^\n]*!pendingPaths\.has/);
  assert.match(html, /const queueCount = Math\.max\(reportedQueueCount, unprovenProposalCount\)/);
  assert.match(html, /Review work is still pending\. Clear the filters or refresh to show it\./);
  assert.match(html, /function contextRoomReturnUrl\(\)/);
  assert.match(html, /Back to main Context Room/);
  assert.doesNotMatch(html, /\/?embedded=1/);
  assert.doesNotMatch(html, /state\.sharedReviewRooms/);
  assert.match(html, /id="sharedProposalReview"/);
  assert.match(html, /id="proposalDockBack"/);
  assert.match(html, /id="proposalDockAccept"/);
  assert.match(html, /Proposal completion is automatic/);
  assert.match(html, /Open review/);
  assert.match(html, /const wasOpen = state\.sharedProposalWorkspaceOpen/);
  assert.doesNotMatch(html, /Accept proposal/);
  assert.doesNotMatch(html, /Prepare pull request|Open pull request|Accepted branch ready/);
  assert.match(html, /if \(shared\?\.mode === "review" \|\| proposalPreview\) \{\s*controls\.hidden = true;/);
  assert.match(html, /backButton\.hidden = !inProposalContext \|\| onProposalPage/);
  assert.match(html, /acceptButton\.hidden = true/);
  assert.match(html, /finalizes the proposal automatically after the last file decision/);
  assert.match(html, /el\("proposalDockBack"\)\?\.addEventListener\("click", \(\) => showProposalReview\(\)\)/);
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
const current = fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, "utf8")) : null;
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
  const saved = { ...body, id: 42, _links: { html: { href: "https://github.com/Acme/shared-context/rules/42" } } };
  fs.writeFileSync(statePath, JSON.stringify(saved));
  process.stdout.write(JSON.stringify(saved));
} else if (/\\/rulesets\\/42/.test(endpoint)) {
  process.stdout.write(JSON.stringify(current));
} else {
  process.stdout.write(JSON.stringify(current ? [{ id: 42, name: current.name }] : []));
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
  assert.equal(Object.values(secured.checks).every(Boolean), true);
  const ruleset = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(ruleset.bypass_actors, []);
  assert.equal(ruleset.rules.find((rule) => rule.type === "pull_request").parameters.required_approving_review_count, 0);
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

function withSharedHome(t, fixture) {
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const home = path.join(fixture.base, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(home, ".context-room", "shared");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });
}

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

test("shared main trailers expose cross-device proposal completion without local review state", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const proposalHead = "a".repeat(40);
  writeFile(fixture.seed, "projects/demo/docs/README.md", "# Accepted elsewhere\n");
  git(fixture.seed, ["add", "."]);
  git(fixture.seed, ["commit", "-m", `Accept elsewhere\n\nContext-Room-Proposal: proposal/demo/elsewhere\nContext-Room-Proposal-Head: ${proposalHead}\nContext-Room-Project: demo`]);
  git(fixture.seed, ["push", "origin", "main"]);
  const accepted = listSharedMainAcceptances(fixture.remote, { refresh: true });
  assert.equal(accepted.some((item) => item.proposal === "proposal/demo/elsewhere" && item.proposalHead === proposalHead && item.merged), true);
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

  const globalLink = path.join(process.env.HOME, ".codex/skills/global-workflow");
  const projectLink = path.join(fixture.project, ".codex/skills/demo-workflow");
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

test("legacy shared skills are synthesized and unmanaged collisions remain untouched", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const unmanaged = path.join(fixture.project, ".codex/skills/demo-workflow");
  writeFile(fixture.project, ".codex/skills/demo-workflow/SKILL.md", "# Local owner copy\n");

  const synced = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const status = sharedSkillLocationsStatus(fixture.project, { refresh: false });

  assert.equal(status.legacy, true);
  assert.equal(status.collections.some((collection) => collection.id === "project-demo"), true);
  assert.equal(status.destinations.some((destination) => destination.status === "conflict"), true);
  assert.equal(fs.lstatSync(unmanaged).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(unmanaged, "SKILL.md"), "utf8"), "# Local owner copy\n");
  assert.equal(fs.existsSync(path.join(synced.current, "projects/demo/docs/README.md")), true);
});

test("two shared contexts never resolve a same-name device skill by implicit priority", (t) => {
  const first = makeFixture();
  const second = makeFixture();
  withSharedHome(t, first);
  const firstSync = connectSharedContext(first.project, { repository: first.remote, projectId: "demo" });
  const deviceLink = path.join(process.env.HOME, ".codex/skills/global-workflow");
  const firstTarget = fs.realpathSync(deviceLink);

  const secondSync = connectSharedContext(second.project, { repository: second.remote, projectId: "demo" });
  const secondStatus = sharedSkillLocationsStatus(second.project, { refresh: false });

  assert.equal(secondStatus.destinations.some((destination) => destination.scope === "device" && destination.status === "conflict"), true);
  assert.equal(fs.realpathSync(deviceLink), firstTarget);
  assert.equal(fs.existsSync(path.join(firstSync.current, "projects/demo/docs/README.md")), true);
  assert.equal(fs.existsSync(path.join(secondSync.current, "projects/demo/docs/README.md")), true);
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
  assert.equal(fs.existsSync(path.join(fixture.project, ".codex/skills/demo-workflow")), false);
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
  const codexLink = path.join(fixture.project, ".codex/skills/demo-workflow");
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
  assert.equal(local.version, 2);
  assert.deepEqual(local.overrides[0].exclude, ["demo-workflow"]);
  assert.equal(projection.destinations[0].filters.localExclude.includes("demo-workflow"), true);
  const localStatePath = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME).find((name) => /^[a-f0-9]{16}$/.test(name)), "skill-locations-local.json");
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
  assert.equal(fs.existsSync(path.join(fixture.project, ".codex/skills/demo-workflow")), false);
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

  const cliEnv = { ...process.env, NODE_TEST_CONTEXT: "1" };
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
  assert.equal(fs.lstatSync(path.join(fixture.project, ".codex/skills/demo-workflow")).isSymbolicLink(), true);
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

  assert.equal(fs.lstatSync(path.join(fixture.project, ".codex/skills/global-workflow")).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(otherRoot, ".codex/skills/global-workflow")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(unregisteredRoot, ".codex/skills/global-workflow")), false);
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

  const deviceDirectory = path.join(process.env.HOME, ".codex/skills");
  assert.equal(fs.readdirSync(deviceDirectory).filter((name) => name === "global-workflow").length, 1);
  assert.equal(sharedSkillLocationsStatus(fixture.project, { refresh: false }).destinations.filter((item) => item.scope === "device" && item.provider === "codex").length, 1);
});

test("provider preferences remove only managed links and project overrides take precedence", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const managed = path.join(fixture.project, ".codex/skills/demo-workflow");
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
  const assigned = proposeSharedSkillAssignment(fixture.project, { ...preview.assignment, title: "Assign demo skills", description: "Assign the accepted demo collection to Codex and Claude Code." });
  assert.equal(assigned.localFilesChanged, false);
  git(fixture.seed, ["fetch", "origin", assigned.proposal.branch]);
  const assignedManifest = JSON.parse(git(fixture.seed, ["show", `origin/${assigned.proposal.branch}:skill-locations.json`]));
  assert.deepEqual(assignedManifest.assignments.find((item) => item.id === preview.assignment.id).providers, ["codex", "claude-code"]);

  const unassigned = proposeSharedSkillUnassignment(fixture.project, { assignmentId: "project-demo-codex", title: "Unassign legacy demo skills", description: "Remove the legacy project assignment through a skills proposal." });
  git(fixture.seed, ["fetch", "origin", unassigned.proposal.branch]);
  const unassignedManifest = JSON.parse(git(fixture.seed, ["show", `origin/${unassigned.proposal.branch}:skill-locations.json`]));
  assert.equal(unassignedManifest.assignments.some((item) => item.id === "project-demo-codex"), false);
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

test("a failed first sync rolls back the approved binding, current snapshot, and skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  fs.writeFileSync(path.join(fixture.project, ".context-room/config.json"), "{ invalid json\n", "utf8");

  assert.throws(
    () => connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" }),
    /JSON/,
  );
  assert.equal(readSharedProjectConnection(fixture.project), null);
  assert.equal(fs.existsSync(path.join(process.env.HOME, ".codex/skills/global-workflow")), false);
  assert.equal(fs.existsSync(path.join(fixture.project, ".codex/skills/demo-workflow")), false);
  const cacheDirectory = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .find((entry) => /^[a-f0-9]{16}$/.test(entry));
  assert.ok(cacheDirectory);
  assert.equal(fs.existsSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, cacheDirectory, "current")), false);
});

test("rebinding replaces only the previously managed paths and skill links", (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  const first = connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const projectLink = path.join(fixture.project, ".codex/skills/demo-workflow");
  const firstTarget = fs.realpathSync(projectLink);
  const secondRemote = path.join(fixture.base, "second-remote.git");
  git(fixture.base, ["clone", "--bare", fixture.seed, secondRemote], { stdio: "ignore" });

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
  assert.throws(() => acceptSharedReview(review.reviewRoot), /already accepted/);
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
});

test("documentation research keeps accepted truth separate from the current session proposal overlay", (t) => {
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
  const packet = {
    summary: "The current session proposes one pending project-document change.",
    currentFacts: [],
    constraints: [],
    decisions: [],
    targetDifferences: [],
    pendingSessionChanges: [{
      claim: "The proposal adds pending session alpha.",
      path: pendingSearch.results[0].path,
      repositoryPath: pendingSearch.results[0].repositoryPath,
      section: pendingSearch.results[0].section,
      truthState: "proposal",
      revision: pendingSearch.results[0].revision,
      contentHash: pendingSearch.results[0].contentHash,
      deleted: false,
      proposal: pendingSearch.results[0].proposal,
    }],
    unknowns: [],
    conflicts: [],
    optionalReads: [],
    coverage: { project: "demo", docsRevision: "replaced", scope: "standard", sourcesExamined: 1, pathsExamined: [pendingSearch.results[0].path] },
  };
  const researched = runDocumentationAgent({
    root: fixture.project,
    cliPath: cli,
    task: "Use the pending session documentation",
    sessionId: "session-overlay-a",
    proposalOverlay: frozen,
    codexBin: "/test/codex",
    spawnSyncImpl() { return { status: 0, signal: null, stdout: JSON.stringify(packet), stderr: "" }; },
  });
  assert.equal(researched.packet.pendingSessionChanges[0].proposal.head, pendingSearch.results[0].proposal.head);
  const wrongHead = structuredClone(packet);
  wrongHead.pendingSessionChanges[0].proposal.head = "f".repeat(40);
  assert.throws(() => runDocumentationAgent({
    root: fixture.project,
    cliPath: cli,
    task: "Reject stale pending evidence",
    sessionId: "session-overlay-a",
    proposalOverlay: frozen,
    codexBin: "/test/codex",
    spawnSyncImpl() { return { status: 0, signal: null, stdout: JSON.stringify(wrongHead), stderr: "" }; },
  }), /exact proposal head/);

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
  const sharedOnlyPacket = structuredClone(packet);
  sharedOnlyPacket.pendingSessionChanges = [{
    claim: "The latest proposal updates the pending session guidance.",
    path: sharedOnlyPending.results[0].path,
    repositoryPath: sharedOnlyPending.results[0].repositoryPath,
    section: sharedOnlyPending.results[0].section,
    truthState: "proposal",
    revision: sharedOnlyPending.results[0].revision,
    contentHash: sharedOnlyPending.results[0].contentHash,
    deleted: false,
    proposal: sharedOnlyPending.results[0].proposal,
  }];
  sharedOnlyPacket.coverage.pathsExamined = [sharedOnlyPending.results[0].path];

  const fakeCodex = path.join(fixture.base, "shared-only-codex.mjs");
  fs.writeFileSync(fakeCodex, `#!/usr/bin/env node
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { prompt += chunk; });
process.stdin.on("end", () => {
  if (!prompt.includes("--repository") || !prompt.includes("--project") || !process.env.CONTEXT_ROOM_DOC_ACCEPTED_REVISION) process.exit(9);
  process.stdout.write(${JSON.stringify(JSON.stringify(sharedOnlyPacket))});
});
`, "utf8");
  fs.chmodSync(fakeCodex, 0o755);
  const sharedOnlyCli = spawnSync(process.execPath, [
    cli,
    "context", "ask", "Use the pending session documentation",
    `--repository=${fixture.remote}`,
    "--project=demo",
    "--session=session-overlay-a",
    "--json",
  ], {
    cwd: sharedOnlyRoot,
    encoding: "utf8",
    env: { ...process.env, CONTEXT_ROOM_CODEX_BIN: fakeCodex, NODE_TEST_CONTEXT: "1" },
  });
  assert.equal(sharedOnlyCli.status, 0, sharedOnlyCli.stderr);
  assert.equal(JSON.parse(sharedOnlyCli.stdout).pendingSessionChanges[0].proposal.sessionId, "session-overlay-a");
  assert.equal(fs.existsSync(path.join(sharedOnlyRoot, ".context-room")), false);
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

test("rejecting a proposal removes it from the active queue while preserving its exact Git revision", (t) => {
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
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", proposal.branch]), "");
  assert.equal(
    git(fixture.seed, ["ls-remote", "--heads", "origin", rejected.rejectionBranch]).split(/\s+/)[0],
    published.head,
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
  fs.unlinkSync(path.join(review.reviewRoot, "projects/demo/docs/REJECTED.md"));
  configureGit(review.reviewRoot);
  const accepted = acceptSharedReview(review.reviewRoot);
  assert.equal(accepted.accepted, true);

  git(fixture.seed, ["pull", "--ff-only", "origin", "main"]);
  assert.equal(fs.readFileSync(path.join(fixture.seed, "projects/demo/docs/ACCEPTED.md"), "utf8"), "# Accepted\n");
  assert.equal(fs.existsSync(path.join(fixture.seed, "projects/demo/docs/REJECTED.md")), false);
  assert.equal(git(fixture.seed, ["show", "origin/main:projects/demo/docs/ACCEPTED.md"]), "# Accepted");
  assert.throws(() => git(fixture.seed, ["cat-file", "-e", "origin/main:projects/demo/docs/REJECTED.md"]));
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
  assert.throws(() => publishSharedProposal(fixture.project, { proposal: symlinkProposal.branch }), /reject symlinks/);

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
  const managedLink = path.join(fixture.project, ".codex/skills/demo-workflow");
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

test("project catalog resolves nested cwd and the same binding in another worktree", (t) => {
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
  assert.equal(fs.lstatSync(path.join(firstProject, ".codex/skills/demo-workflow")).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(nested, ".codex/skills/demo-workflow")), false);

  const secondNested = path.join(secondClone, "products/demo/website");
  const secondConnection = readSharedProjectConnection(secondNested);
  assert.equal(secondConnection.projectId, "demo");
  assert.equal(secondConnection.projectRoot, fs.realpathSync(path.join(secondClone, "products/demo")));
  const secondProject = path.join(secondClone, "products/demo");
  initializeContextRoomProject(secondProject, { title: "Demo second worktree" });
  connectSharedContext(secondNested, { repository: fixture.remote, projectId: "demo" });
  assert.equal(fs.lstatSync(path.join(secondProject, ".codex/skills/demo-workflow")).isSymbolicLink(), true);

  fs.rmSync(path.join(fixture.seed, "projects/demo/skills/demo-workflow"), { recursive: true });
  git(fixture.seed, ["add", "-A"]);
  git(fixture.seed, ["commit", "-m", "Remove registered worktree skill"]);
  git(fixture.seed, ["push", "origin", "main"]);
  syncSharedContext(firstProject, { allowOffline: false });
  assert.equal(fs.existsSync(path.join(firstProject, ".codex/skills/demo-workflow")), false);
  assert.equal(fs.existsSync(path.join(secondProject, ".codex/skills/demo-workflow")), false);
});

test("shared Context Room API lists proposals and opens an exact review room", async (t) => {
  const fixture = makeFixture();
  withSharedHome(t, fixture);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, { title: "API review", branch: "proposal/demo/api-review" });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAPI review.\n");
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
  assert.equal("reviewAgentInstructions" in readMemoryWebappSettings(opened.reviewRoot), false);
  const reviewPage = await fetch(opened.url + "/");
  assert.equal(
    reviewPage.headers.get("content-security-policy"),
    `frame-ancestors 'self' http://127.0.0.1:${room.server.address().port} http://localhost:${room.server.address().port}`,
  );
  const exactResponse = await fetch(opened.url + "/api/shared-context");
  const exact = await exactResponse.json();
  assert.equal(exact.mode, "review");
  assert.equal(exact.review.proposalHead, published.head);
  const incompleteResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project") },
    body: JSON.stringify({ expectedProposalHead: published.head }),
  });
  assert.equal(incompleteResponse.status, 409);
  const incomplete = await incompleteResponse.json();
  assert.equal(incomplete.code, "shared_context_review_incomplete");
  assert.match(incomplete.error, /1 file\(s\) remain without current review proof/);

  const reopenedResponse = await fetch(origin + "/api/shared-context/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ proposal: proposal.branch, expectedHead: published.head }),
  });
  assert.equal(reopenedResponse.status, 201);
  const reopened = await reopenedResponse.json();
  assert.equal(reopened.url, opened.url);
  assert.equal(reopened.reviewRoot, opened.reviewRoot);

  const decisionResponse = await fetch(opened.url + "/api/docqa/review", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project") },
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
  assert.equal(decision.proposalFinalization.accepted, true);
  assert.equal(decision.proposalFinalization.proposalHead, published.head);
  git(fixture.seed, ["fetch", "origin"]);
  assert.match(git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]), /API review/);

  const staleResponse = await fetch(opened.url + "/api/shared-context/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": exactResponse.headers.get("x-context-room-project") },
    body: JSON.stringify({ expectedProposalHead: "0".repeat(40) }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "shared_context_proposal_head_mismatch");
});
