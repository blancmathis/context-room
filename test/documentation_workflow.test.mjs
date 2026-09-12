import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initializeContextRoomProject, writeMemoryWebappSettings, readMemoryWebappSettings, writeDocReviewBaseline, writeDocReviewDecision, readMemoryFile, readFileDiff,
  revertMemoryFile, saveHumanReviewedFile, buildDocQaReport, createLocalDocumentationProposal,
  submitLocalDocumentationProposal, reviewLocalDocumentationProposal, contextHubUiState, runAuthorizedReviewCleanup,
  createMemoryServer, listStartupContextFiles, readStartupContextFile, readStartupSkillFile, rejectDirectDocumentationChange } from "../src/context_room.mjs";
import { writeReviewCleanupPolicy, recentReviewCleanupReceipts } from "../src/review_cleanup.mjs";
import { registerContextHubProject } from "../src/context_hub.mjs";
import { inspectLocalProposal } from "../src/local_proposals.mjs";
import { buildDocumentationCorpus } from "../src/documentation.mjs";

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "cr-document-workflow-")), root = path.join(base, "project");
  const previous = {};
  for (const name of ["CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME"]) {
    previous[name] = process.env[name]; process.env[name] = path.join(base, name);
  }
  t.after(() => { for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } fs.rmSync(base, { recursive: true, force: true }); });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  for (const name of ["a", "b"]) fs.writeFileSync(path.join(root, `docs/${name}.md`), `# ${name}\n\nAccepted ${name}.\n`);
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  writeMemoryWebappSettings(root, { startupContext: { enabled: false }, startupSkills: { enabled: false }, startupHooks: { enabled: false } });
  for (const name of ["a", "b"]) writeDocReviewDecision(root, `docs/${name}.md`, { status: "verified" });
  return root;
}

test("Startup human saves require owner authority and accept only the exact saved document", async t => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n");
  fs.mkdirSync(path.join(root, "skills/demo"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills/demo/SKILL.md"), "# Demo skill\n");
  writeMemoryWebappSettings(root, {
    startupContext: { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] },
    startupSkills: { enabled: true, projectOnly: true, folderNames: ["skills"] },
  });
  const room = createMemoryServer({ root });
  await new Promise(resolve => room.server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${room.server.address().port}`;
    const order = listStartupContextFiles(root)[0].startupContext.order;
    const cases = [
      { endpoint: "startup-context", selector: { order }, current: readStartupContextFile(root, order) },
      { endpoint: "startup-skills", selector: { folder: 1, skill: "demo" }, current: readStartupSkillFile(root, 1, "demo") },
    ];
    for (const { endpoint, selector, current } of cases) {
      const reviewPath = current.startupContext.explorerPath;
      const content = current.content + "\nHuman correction.\n";
      const body = JSON.stringify({ ...selector, content, expectedContentHash: current.contentHash });
      const request = nonce => fetch(`${origin}/api/${endpoint}/file`, { method: "POST", headers: { "content-type": "application/json", ...(nonce ? { "x-context-room-owner-nonce": nonce } : {}) }, body });
      assert.equal((await request()).status, 403);
      const response = await request(room.ownerMutationNonce), result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.accepted, true);
      assert.equal(result.content, content);
      assert.equal(buildDocQaReport(root).queue.some(item => item.path === reviewPath), false);
      fs.writeFileSync(path.join(root, reviewPath), "Later agent change");
      assert.equal((await request(room.ownerMutationNonce)).status, 409);
      assert.equal(fs.readFileSync(path.join(root, reviewPath), "utf8"), "Later agent change");
      assert.equal(buildDocQaReport(root).queue.some(item => item.path === reviewPath), true);
    }
  } finally {
    await new Promise(resolve => { room.server.close(resolve); room.server.closeAllConnections?.(); });
    await room.waitForShutdown();
  }
});

test("a human save accepts only its exact correction, keeping other and subsequent changes pending", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "docs/b.md"), "Pending b");
  const current = readMemoryFile(root, "docs/a.md");
  const saved = saveHumanReviewedFile(root, "docs/a.md", "# Human correction\n", { expectedContentHash: current.contentHash });
  assert.equal(saved.accepted, true);
  assert.deepEqual(buildDocQaReport(root).queue.map((entry) => entry.path), ["docs/b.md"]);
  fs.writeFileSync(path.join(root, "docs/a.md"), "Later agent content");
  assert.equal(buildDocQaReport(root).queue.length, 2);
  const accepted = buildDocumentationCorpus(root).documents.find((entry) => entry.path === "docs/a.md");
  assert.equal(accepted.rawContent, "# Human correction\n");
  assert.throws(() => saveHumanReviewedFile(root, "docs/a.md", "Stale human edit", { expectedContentHash: current.contentHash }), /changed before saving/);
  assert.equal(fs.readFileSync(path.join(root, "docs/a.md"), "utf8"), "Later agent content");
});

test("no-Git direct rejection restores modified, deleted, and renamed files and preserves rejected bytes", (t) => {
  const root = fixture(t), a = path.join(root, "docs/a.md"), original = fs.readFileSync(a, "utf8");
  fs.writeFileSync(a, "Agent edit");
  const revision = readFileDiff(root, "docs/a.md");
  assert.equal(revision.changed, true);
  const rejected = revertMemoryFile(root, "docs/a.md", { expectedRevision: revision.revision });
  assert.equal(fs.readFileSync(a, "utf8"), original);
  assert.ok(rejected.backupPath);
  fs.unlinkSync(a);
  const deleted = readFileDiff(root, "docs/a.md");
  assert.equal(deleted.changeKind, "deleted");
  revertMemoryFile(root, "docs/a.md", { expectedRevision: deleted.revision });
  assert.equal(fs.readFileSync(a, "utf8"), original);
  const moved = path.join(root, "docs/moved.md"); fs.renameSync(a, moved);
  const rename = readFileDiff(root, "docs/moved.md");
  assert.equal(rename.oldPath, "docs/a.md");
  revertMemoryFile(root, "docs/moved.md", { expectedRevision: rename.revision });
  assert.equal(fs.existsSync(moved), false);
  assert.equal(fs.readFileSync(a, "utf8"), original);
  fs.writeFileSync(path.join(root, "docs/new.md"), "New agent document");
  const added = readFileDiff(root, "docs/new.md");
  assert.equal(added.changeKind, "added");
  const removed = revertMemoryFile(root, "docs/new.md", { expectedRevision: added.revision });
  assert.ok(removed.backupPath);
  assert.equal(fs.existsSync(path.join(root, "docs/new.md")), false);
  assert.equal(buildDocQaReport(root).queue.length, 0);
});

test("no-Git rejection refuses a newer disk revision without touching either accepted baseline or newer content", (t) => {
  const root = fixture(t), file = path.join(root, "docs/a.md");
  fs.writeFileSync(file, "First edit"); const first = readFileDiff(root, "docs/a.md");
  fs.writeFileSync(file, "Newer edit");
  assert.throws(() => revertMemoryFile(root, "docs/a.md", { expectedRevision: first.revision }), /changed|revision/i);
  assert.equal(fs.readFileSync(file, "utf8"), "Newer edit");
  assert.match(buildDocumentationCorpus(root).documents.find((entry) => entry.path === "docs/a.md").rawContent, /Accepted a/);
});

test("direct rejection refuses a mode change since the human selected the document", t => {
  const root = fixture(t), file = path.join(root, "docs/a.md");
  fs.writeFileSync(file, "Pending change"); fs.chmodSync(file, 0o644);
  const selected = buildDocQaReport(root).queue.find(item => item.path === "docs/a.md");
  assert.equal(selected.resourceMode, "100644");
  fs.chmodSync(file, 0o755);
  assert.throws(() => rejectDirectDocumentationChange(root, selected.path, { expectedContentHash: selected.currentHash, expectedResourceMode: selected.resourceMode }), /mode changed/);
  assert.equal(fs.readFileSync(file, "utf8"), "Pending change");
  assert.ok(fs.statSync(file).mode & 0o111);
});

test("a staged Git disagreement blocks local proposal application before changing source bytes", (t) => {
  const root = fixture(t);
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init"]); git(["config", "user.name", "Test"]); git(["config", "user.email", "test@example.test"]);
  git(["add", "docs"]); git(["commit", "-m", "Initial"]);
  const draft = createLocalDocumentationProposal(root, { title: "Proposed" });
  fs.writeFileSync(path.join(draft.editRoot, "docs/a.md"), "Proposal content");
  const submitted = submitLocalDocumentationProposal(root, draft.id);
  const original = fs.readFileSync(path.join(root, "docs/a.md"), "utf8");
  fs.writeFileSync(path.join(root, "docs/a.md"), "Different staged content"); git(["add", "docs/a.md"]);
  fs.writeFileSync(path.join(root, "docs/a.md"), original);
  assert.throws(() => reviewLocalDocumentationProposal(root, draft.id, { path: "docs/a.md", decision: "accepted", expectedRevision: submitted.submittedRevision }), /staged Git content/);
  assert.equal(fs.readFileSync(path.join(root, "docs/a.md"), "utf8"), original);
  assert.equal(git(["show", ":docs/a.md"]), "Different staged content");
});

test("partial settings keep the Hub and unknown legacy configuration fields", (t) => {
  const root = fixture(t), file = path.join(root, ".context-room/config.json");
  const before = readMemoryWebappSettings(root);
  const raw = JSON.parse(fs.readFileSync(file)); raw.customPlugin = { future: true }; raw.startupContext.custom = "preserved";
  fs.writeFileSync(file, JSON.stringify(raw));
  writeMemoryWebappSettings(root, { startupSkills: { enabled: true } });
  const after = readMemoryWebappSettings(root), saved = JSON.parse(fs.readFileSync(file));
  assert.deepEqual(after.hubSections, before.hubSections);
  assert.deepEqual(saved.customPlugin, { future: true });
  assert.equal(saved.startupContext.custom, "preserved");
});
test("legacy annotations retain the accepted version independently of their current review baseline", t => {
  const root = fixture(t), file = path.join(root, "docs/a.md");
  fs.writeFileSync(file, "Unaccepted agent replacement");
  writeDocReviewDecision(root, "docs/a.md", { status: "snoozed" });
  const accepted = buildDocumentationCorpus(root).documents.find(item => item.path === "docs/a.md");
  assert.match(accepted.rawContent, /Accepted a/);
  assert.doesNotMatch(accepted.rawContent, /Unaccepted/);
});

test("a local proposal never imports an unaccepted baseline from another agent", t => {
  const root = fixture(t), rel = "docs/unaccepted.md";
  fs.writeFileSync(path.join(root, rel), "Pending initial document");
  writeDocReviewBaseline(root, rel);
  const proposal = createLocalDocumentationProposal(root, { title: "Independent work" });
  assert.equal(fs.existsSync(path.join(proposal.editRoot, rel)), false);
  assert.match(fs.readFileSync(path.join(proposal.editRoot, "docs/a.md"), "utf8"), /Accepted a/);
});

test("an unwatched document is never silently promoted to accepted CLI truth", t => {
  const root = fixture(t);
  fs.mkdirSync(path.join(root, "notes")); fs.writeFileSync(path.join(root, "notes/unchecked.md"), "Unreviewed outside the watch scope");
  writeMemoryWebappSettings(root, { allowedPaths: ["docs/", "notes/"] });
  assert.equal(buildDocumentationCorpus(root).documents.some(item => item.path === "notes/unchecked.md"), false);
  assert.ok(buildDocumentationCorpus(root).documents.some(item => item.path === "docs/a.md"));
});

test("an authorized automatic cleanup really rejects old local proposals and keeps their originals", t => {
  const root = fixture(t); registerContextHubProject(root, { title: "Cleanup fixture" });
  const draft = createLocalDocumentationProposal(root, { title: "Old change" });
  fs.writeFileSync(path.join(draft.editRoot, "docs/a.md"), "Pending change");
  submitLocalDocumentationProposal(root, draft.id);
  assert.equal(runAuthorizedReviewCleanup(root).disabled, true);
  writeReviewCleanupPolicy(root, { enabled: true, days: 1, projectIds: [] });
  const outcome = runAuthorizedReviewCleanup(root, { now: Date.now() + 3 * 86400000 });
  assert.deepEqual(outcome.errors, []); assert.equal(outcome.applied.length, 1);
  assert.equal(inspectLocalProposal(root, draft.id).changes[0].decision.status, "rejected");
  assert.match(fs.readFileSync(path.join(root, "docs/a.md"), "utf8"), /Accepted a/);
  assert.equal(recentReviewCleanupReceipts(root)[0].applied, 1);
});
