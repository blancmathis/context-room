import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initializeContextRoomProject, writeMemoryWebappSettings, readMemoryWebappSettings, writeDocReviewBaseline, writeDocReviewDecision, readMemoryFile, readFileDiff,
  revertMemoryFile, saveHumanReviewedFile, buildDocQaReport, createLocalDocumentationProposal,
  submitLocalDocumentationProposal, reviewLocalDocumentationProposal, contextHubUiState, runAuthorizedReviewCleanup,
  createMemoryServer, listStartupContextFiles, readStartupContextFile, readStartupSkillFile, rejectDirectDocumentationChange, proposeDocumentMove, proposeDocumentationMap, documentationDriftReport } from "../src/context_room.mjs";
import { writeReviewCleanupPolicy, recentReviewCleanupReceipts } from "../src/review_cleanup.mjs";
import { registerContextHubProject } from "../src/context_hub.mjs";
import { inspectLocalProposal } from "../src/local_proposals.mjs";
import { buildDocumentationCorpus, buildDocumentationMap } from "../src/documentation.mjs";

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

test("docs move proposes the moved document and every accepted inbound link fix together", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "docs/a.md"), "# a\n\nSee [b](b.md#b), [ref][b] and `b.md`.\n\n[b]: ./b.md\n");
  fs.writeFileSync(path.join(root, "docs/b.md"), "# b\n\nBack to [a](a.md).\n");
  for (const name of ["a", "b"]) writeDocReviewDecision(root, `docs/${name}.md`, { status: "verified" });
  fs.writeFileSync(path.join(root, "docs/c.md"), "# c\n\nPending link to [b](b.md).\n");

  const preview = proposeDocumentMove(root, { from: "docs/b.md", to: "docs/guides/b.md", dryRun: true });
  assert.deepEqual(preview, { dryRun: true, from: "docs/b.md", to: "docs/guides/b.md", links: 2,
    rewritten: [{ path: "docs/a.md", links: 2 }], movedDocumentLinks: 1, notRewritten: ["docs/c.md"] });
  assert.equal(fs.existsSync(path.join(root, ".context-room/local-proposals/proposals")), false);
  assert.throws(() => proposeDocumentMove(root, { from: "docs/c.md", to: "docs/d.md" }), /Only an accepted document/);
  assert.throws(() => proposeDocumentMove(root, { from: "docs/b.md", to: "docs/a.md" }), /already exists/);

  const moved = proposeDocumentMove(root, { from: "docs/b.md", to: "docs/guides/b.md" });
  assert.equal(moved.status, "submitted");
  assert.equal(moved.accepted, false);
  assert.equal(fs.readFileSync(path.join(root, "docs/b.md"), "utf8"), "# b\n\nBack to [a](a.md).\n");
  const proposal = inspectLocalProposal(root, moved.proposalId);
  assert.deepEqual(proposal.changes.map((change) => [change.path, change.kind]).sort(), [
    ["docs/a.md", "modified"], ["docs/b.md", "deleted"], ["docs/guides/b.md", "added"],
  ]);
  for (const change of proposal.changes) {
    reviewLocalDocumentationProposal(root, moved.proposalId, { path: change.path, decision: "accepted", expectedRevision: proposal.submittedRevision });
  }
  assert.equal(fs.existsSync(path.join(root, "docs/b.md")), false);
  assert.equal(fs.readFileSync(path.join(root, "docs/guides/b.md"), "utf8"), "# b\n\nBack to [a](../a.md).\n");
  assert.equal(fs.readFileSync(path.join(root, "docs/a.md"), "utf8"), "# a\n\nSee [b](guides/b.md#b), [ref][b] and `b.md`.\n\n[b]: ./guides/b.md\n");
});

test("docs drift counts commits to cited code since acceptance, and says unknown without git", (t) => {
  const root = fixture(t);
  for (const [file, text] of [["src/engine.mjs", "v1\n"], ["src/ui/view.mjs", "v1\n"], ["src/ui/notes.md", "v1\n"], ["scripts/x.sh", "v1\n"], ["other.txt", "v1\n"]]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  fs.writeFileSync(path.join(root, "docs/a.md"), "# a\n\nSee `src/engine.mjs:12`, [view](../src/ui/), `scripts/x.sh`, [b](b.md) and `docs/`.\n");
  writeDocReviewDecision(root, "docs/a.md", { status: "verified" });
  const before = documentationDriftReport(root);
  assert.deepEqual(before.documents.map((item) => [item.path, item.status]), [["docs/a.md", "unknown"], ["docs/b.md", "no-cited-code"]]);
  assert.deepEqual(before.documents[0].cited, ["docs", "scripts/x.sh", "src/engine.mjs", "src/ui"]);

  const commit = (date, files) => {
    const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com", GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date };
    for (const file of files) fs.appendFileSync(path.join(root, file), "change\n");
    execFileSync("git", ["add", "src", "scripts", "docs", "other.txt"], { cwd: root, env });
    execFileSync("git", ["commit", "-q", "-m", date], { cwd: root, env });
  };
  execFileSync("git", ["init", "-q"], { cwd: root });
  // The acceptance is stamped now: one commit before it, three after it.
  const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString();
  commit(day(-2), []);
  commit(day(1), ["src/engine.mjs"]);
  commit(day(2), ["src/engine.mjs", "src/ui/view.mjs"]);
  commit(day(3), ["other.txt", "src/ui/notes.md", "docs/b.md"]);
  fs.appendFileSync(path.join(root, "scripts/x.sh"), "uncommitted\n");

  const report = documentationDriftReport(root);
  const [drift] = report.documents;
  assert.equal(drift.path, "docs/a.md");
  assert.equal(drift.status, "changed");
  assert.equal(drift.commits, 2);
  assert.deepEqual(drift.changedPaths, [{ path: "src/engine.mjs", commits: 2 }, { path: "src/ui", commits: 1 }]);
  assert.deepEqual(drift.uncommitted, ["scripts/x.sh"]);
  assert.equal(drift.message, "The cited code changed 2 times since you accepted this document. 1 cited path has uncommitted changes.");
  assert.deepEqual(report.summary, { documents: 2, changed: 1, unchanged: 0, unknown: 0, noCitedCode: 1 });
  assert.throws(() => documentationDriftReport(root, { path: "docs/missing.md" }), /not an accepted document/);

  const cli = JSON.parse(execFileSync(process.execPath, [path.resolve("bin/context-room.mjs"), "docs", "drift", "docs/a.md", "--root", root, "--format=json"], { encoding: "utf8" }));
  assert.deepEqual(cli.data.documents.map((item) => [item.path, item.commits]), [["docs/a.md", 2]]);
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

test("docs map lists each accepted document once and proposes it as a reviewed AGENTS.md block", (t) => {
  const root = fixture(t);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Agents\n\nKeep this rule.\n");
  writeMemoryWebappSettings(root, { allowedPaths: ["docs/", "AGENTS.md"], watchAllow: ["docs/", "AGENTS.md"] });
  writeDocReviewDecision(root, "AGENTS.md", { status: "verified" });
  fs.mkdirSync(path.join(root, "docs/lifecycle/changes/active"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs/decisions"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/lifecycle/changes/active/next.md"), "# Next steps\n\nShip the map. Then measure it.\n");
  fs.writeFileSync(path.join(root, "docs/decisions/map.md"), "---\ntitle: Keep one map\nsummary: The map lives in AGENTS.md.\n---\n\n# Decision\n");
  for (const rel of ["docs/lifecycle/changes/active/next.md", "docs/decisions/map.md"]) writeDocReviewDecision(root, rel, { status: "verified" });
  fs.writeFileSync(path.join(root, "docs/c.md"), "# c\n\nPending.\n");

  const map = buildDocumentationMap(root);
  assert.equal(map.documents, 4);
  assert.deepEqual(map.groups.map((group) => [group.role, group.entries.map((entry) => entry.path)]), [
    ["Reference", ["docs/a.md", "docs/b.md"]], ["Plans", ["docs/lifecycle/changes/active/next.md"]], ["History", ["docs/decisions/map.md"]],
  ]);
  assert.deepEqual(map.groups[1].entries[0], { path: "docs/lifecycle/changes/active/next.md", title: "Next steps", summary: "Ship the map." });
  assert.deepEqual(map.groups[2].entries[0], { path: "docs/decisions/map.md", title: "Keep one map", summary: "The map lives in AGENTS.md." });
  assert.equal(map.excluded.unreviewed, 1);
  assert.doesNotMatch(map.markdown, /docs\/c\.md/);
  assert.match(map.markdown, /^<!-- context-room:docs-map -->\n## Documentation map\n/);
  assert.deepEqual(buildDocumentationMap(root).markdown, map.markdown, "the map is deterministic");

  assert.deepEqual(proposeDocumentationMap(root, { map, dryRun: true }), { dryRun: true, target: "AGENTS.md", documents: 4, estimatedTokens: map.estimatedTokens, changed: true });
  const proposed = proposeDocumentationMap(root, { map });
  assert.equal(proposed.status, "submitted");
  assert.equal(proposed.accepted, false);
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# Agents\n\nKeep this rule.\n");
  const proposal = inspectLocalProposal(root, proposed.proposalId);
  assert.deepEqual(proposal.changes.map((change) => [change.path, change.kind]), [["AGENTS.md", "modified"]]);
  reviewLocalDocumentationProposal(root, proposed.proposalId, { path: "AGENTS.md", decision: "accepted", expectedRevision: proposal.submittedRevision });
  assert.equal(fs.readFileSync(path.join(root, "AGENTS.md"), "utf8"), "# Agents\n\nKeep this rule.\n\n" + map.markdown);
  assert.equal(proposeDocumentationMap(root, { map: buildDocumentationMap(root) }).changed, false);
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Pending edit\n");
  assert.equal(proposeDocumentationMap(root, { map: buildDocumentationMap(root) }).changed, false, "the map builds on the accepted version");
  assert.throws(() => proposeDocumentationMap(root, { map, target: "docs/c.md" }), /Only an accepted docs\/c\.md/);
});
