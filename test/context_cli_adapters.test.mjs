import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  applyCliContextSettings,
  buildAgentEnvironment,
  buildCliContextEffective,
  buildCliContextGraph,
  createCliContextSnapshot,
  diffCliContextSnapshots,
  doctorAllProjects,
  getCliContextSettings,
  impactCliContext,
  planCliContextSettings,
  proposalContextImpact,
  registerCliProject,
  resolveCliTarget,
  traceCliContext,
} from "../src/agent_cli.mjs";
import { initializeContextRoomProject, readMemoryWebappSettings, writeMemoryWebappSettings } from "../src/context_room.mjs";
import {
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  materializeSharedReview,
  publishSharedProposal,
} from "../src/shared_context.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  try { fs.chmodSync(root, 0o700); } catch {}
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) removeWritableTree(candidate);
    try { fs.chmodSync(candidate, entry.isDirectory() ? 0o700 : 0o600); } catch {}
  }
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-context-cli-"));
  const root = path.join(parent, "project");
  fs.mkdirSync(path.join(root, "apps", "calls"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n");
  fs.writeFileSync(path.join(root, "apps", "AGENTS.md"), "# App instructions\n");
  fs.writeFileSync(path.join(root, "apps", "calls", "AGENTS.override.md"), "# Calls override\n");
  fs.writeFileSync(path.join(root, "apps", "calls", "runtime.md"), "---\ncontext_room:\n  status: current\n  kind: canonical\n---\n\n# Runtime\n");
  git(root, ["init"]);
  git(root, ["config", "user.email", "context-room@example.test"]);
  git(root, ["config", "user.name", "Context Room Test"]);
  initializeContextRoomProject(root, { title: "Context CLI", allowedPaths: ["AGENTS.md", "apps/"], watchAllow: ["AGENTS.md", "apps/"] });
  const current = readMemoryWebappSettings(root);
  writeMemoryWebappSettings(root, {
    ...current,
    startupContext: { enabled: true, projectOnly: true, fileNames: ["AGENTS.md", "AGENTS.override.md"], globalPaths: [] },
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  const previousHub = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(parent, "hub");
  t.after(() => {
    if (previousHub === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHub;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  registerCliProject({ root, title: "Context CLI" });
  return { parent, root, target: resolveCliTarget({ cwd: path.join(root, "apps", "calls") }) };
}

test("Context CLI graph, effective, trace, impact, and legacy environment share one inventory", (t) => {
  const { target } = fixture(t);
  const graph = buildCliContextGraph(target, { provider: "codex" });
  assert.equal(graph.coordinate.folder, "apps/calls");
  assert.ok(graph.resources.some((item) => item.kind === "instruction" && item.metadata.name === "AGENTS.override.md"));

  const effective = buildCliContextEffective(target, { provider: "codex" });
  assert.equal(effective.schemaVersion, "context-room.context-effective/1");
  assert.equal(effective.documents.length, 0, "unverified current documents must not enter effective context");

  const trace = traceCliContext(target, "AGENTS.override.md", { provider: "codex" });
  assert.equal(trace.status, "ok");
  assert.equal(trace.chain.at(-1).resource.metadata.name, "AGENTS.override.md");

  const impact = impactCliContext(target, trace.selected.id, { provider: "codex" });
  assert.equal(impact.status, "ok");
  assert.deepEqual(impact.projects, [target.project.id]);

  const bulk = impactCliContext(target, "", { provider: "codex", limit: 1 });
  assert.equal(bulk.impacts.length, 1);
  assert.equal(bulk.pagination.limit, 1);

  const legacy = buildAgentEnvironment(target, { provider: "codex" });
  assert.deepEqual(legacy.instructions.map((item) => item.path), ["AGENTS.md", "apps/AGENTS.md", "apps/calls/AGENTS.override.md"]);
  assert.equal(legacy.freshness.verified, true);
});

test("Context snapshots are content-addressed and diff the same exact target", async (t) => {
  const { parent, root, target } = fixture(t);
  const storageRoot = path.join(parent, "snapshots");
  const first = await createCliContextSnapshot(target, { provider: "codex", storageRoot });
  const repeated = await createCliContextSnapshot(target, { provider: "codex", storageRoot });
  assert.equal(first.manifest.snapshotId, repeated.manifest.snapshotId);
  assert.equal(fs.statSync(first.path).mode & 0o777, 0o600);

  fs.appendFileSync(path.join(root, "AGENTS.md"), "\nUse focused tests.\n");
  const second = await createCliContextSnapshot(target, { provider: "codex", storageRoot });
  const diff = await diffCliContextSnapshots({ from: first.manifest.snapshotId, to: second.manifest.snapshotId, storageRoot });
  assert.ok(diff.resources.modified.some((item) => item.resourceId.endsWith("/AGENTS.md")));
});

test("Context Settings filesystem adapter plans, applies once, and Doctor paginates before inspection", (t) => {
  const { target } = fixture(t);
  assert.equal(getCliContextSettings(target, { key: "startupSkills.enabled" }).value, true);
  const plan = planCliContextSettings(target, { set: { "startupSkills.enabled": false } });
  const first = applyCliContextSettings(target, { planId: plan.planId, idempotencyKey: "test" });
  const replay = applyCliContextSettings(target, { planId: plan.planId, idempotencyKey: "test" });
  assert.equal(first.operationId, replay.operationId);
  assert.equal(replay.idempotentReplay, true);
  assert.equal(getCliContextSettings(target, { key: "startupSkills.enabled" }).value, false);

  const page = doctorAllProjects({ limit: 1 });
  assert.equal(page.projects.length, 1);
  assert.equal(page.pagination.limit, 1);
});

test("proposal context impact reads accepted main and exact proposal metadata without mutating either", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-proposal-impact-cli-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.HOME = path.join(base, "home");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(process.env.HOME, ".context-room", "shared");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    removeWritableTree(base);
  });
  fs.mkdirSync(process.env.HOME, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  git(seed, ["config", "user.email", "context-room@example.test"]);
  git(seed, ["config", "user.name", "Context Room Test"]);
  initializeSharedRepository(seed, { name: "Impact shared" });
  fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2) + "\n");
  fs.mkdirSync(path.join(seed, "projects", "demo", "docs"), { recursive: true });
  fs.writeFileSync(path.join(seed, "projects", "demo", "docs", "README.md"), "# Demo\n");
  fs.writeFileSync(path.join(seed, "projects", "demo", "docs", "DELETE.md"), "# Delete me\n");
  fs.writeFileSync(path.join(seed, "projects", "demo", "docs", "OLD-NAME.md"), "# Rename me\n");
  fs.mkdirSync(path.join(seed, "skills", "global", "global-workflow"), { recursive: true });
  fs.writeFileSync(path.join(seed, "skills", "global", "global-workflow", "SKILL.md"), "# Global workflow\n");
  fs.mkdirSync(path.join(seed, "projects", "demo", "skills", "demo-workflow"), { recursive: true });
  fs.writeFileSync(path.join(seed, "projects", "demo", "skills", "demo-workflow", "SKILL.md"), "# Demo workflow\n");
  fs.writeFileSync(path.join(seed, "skill-locations.json"), JSON.stringify({
    version: 1,
    collections: [
      { id: "global", title: "Global skills", path: "skills/global" },
      { id: "project-demo", title: "Demo skills", path: "projects/demo/skills" },
    ],
    assignments: [
      { id: "global-device", collectionId: "global", scope: "device", providers: ["codex"], include: ["*"], exclude: [] },
      { id: "demo-project", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["codex"], include: ["*"], exclude: [] },
    ],
  }, null, 2) + "\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "initial"]);
  git(seed, ["push", "origin", "main"]);
  initializeContextRoomProject(project, { title: "Demo", allowedPaths: ["README.md"], watchAllow: [] });
  connectSharedContext(project, { repository: remote, projectId: "demo" });
  const proposal = createSharedProposal(project, { title: "Clarify demo", branch: "proposal/demo/clarify" });
  git(proposal.root, ["config", "user.email", "context-room@example.test"]);
  git(proposal.root, ["config", "user.name", "Context Room Test"]);
  fs.writeFileSync(path.join(proposal.root, "projects", "demo", "docs", "README.md"), "# Demo\n\nClarified.\n");
  fs.writeFileSync(path.join(proposal.root, "projects", "demo", "docs", "ADDED.md"), "# Added\n");
  fs.unlinkSync(path.join(proposal.root, "projects", "demo", "docs", "DELETE.md"));
  git(proposal.root, ["mv", "projects/demo/docs/OLD-NAME.md", "projects/demo/docs/RENAMED.md"]);
  const firstPublished = publishSharedProposal(project, { proposal: proposal.branch });
  const review = materializeSharedReview(project, { proposal: proposal.branch, expectedHead: firstPublished.head });
  assert.equal(review.metadata.proposalHead, firstPublished.head);
  fs.writeFileSync(path.join(proposal.root, "projects", "demo", "docs", "README.md"), "# Demo\n\nClarified again.\n");
  fs.writeFileSync(path.join(proposal.root, "projects", "demo", "docs", "SECOND-ADD.md"), "# Added later\n");
  const published = publishSharedProposal(project, { proposal: proposal.branch, description: "Second exact revision" });
  const before = git(seed, ["rev-parse", "HEAD"]);
  const remoteRefsBefore = git(base, ["ls-remote", remote, "refs/heads/main", `refs/heads/${proposal.branch}`]);
  const impact = await proposalContextImpact({ selector: proposal.branch, repository: remote });
  assert.equal(impact.base, before);
  assert.equal(impact.head, published.head);
  assert.equal(impact.semanticConflicts, "not-evaluated");
  assert.equal(impact.reviewInvalidation.mode, "exact-revision");
  assert.deepEqual(new Set(impact.changedFiles.map((item) => item.rawStatus)), new Set(["A", "M", "D", "R"]));
  assert.deepEqual(new Set(impact.changedFiles.map((item) => item.status)), new Set(["added", "modified", "deleted", "renamed"]));
  assert.deepEqual(impact.changedFiles.find((item) => item.rawStatus === "R"), {
    oldPath: "projects/demo/docs/OLD-NAME.md",
    path: "projects/demo/docs/RENAMED.md",
    status: "renamed",
    rawStatus: "R",
    score: 100,
  });
  assert.deepEqual(impact.reviewInvalidation.reviews.map((item) => item.path), ["projects/demo/docs/README.md"]);
  assert.equal(impact.reviewInvalidation.reviews[0].reviewId, review.metadata.authorityId);
  assert.equal(impact.reviewInvalidation.reviews[0].reviewedRevision, firstPublished.head);
  assert.equal(impact.reviewInvalidation.reviews[0].expectedRevision, published.head);
  assert.equal(impact.reviewInvalidation.reviews.some((item) => item.path.endsWith("SECOND-ADD.md")), false);
  assert.equal(git(seed, ["rev-parse", "HEAD"]), before);
  assert.equal(git(base, ["ls-remote", remote, "refs/heads/main", `refs/heads/${proposal.branch}`]), remoteRefsBefore);

  const skillsProposal = createSharedProposal(project, { title: "Reassign shared skills", branch: "proposal/skills/reassign", scope: "skills" });
  fs.writeFileSync(path.join(skillsProposal.root, "skill-locations.json"), JSON.stringify({
    version: 1,
    collections: [
      { id: "global", title: "Global skills renamed", path: "skills/global" },
      { id: "project-demo", title: "Demo skills", path: "projects/demo/skills" },
    ],
    assignments: [
      { id: "demo-project", collectionId: "project-demo", scope: "project", projectIds: ["demo"], providers: ["claude-code"], include: ["*"], exclude: [] },
      { id: "demo-shared", collectionId: "project-demo", scope: "shared", providers: ["opencode"], include: ["*"], exclude: [] },
    ],
  }, null, 2) + "\n");
  const publishedSkills = publishSharedProposal(project, { proposal: skillsProposal.branch });
  const skillRefsBefore = git(base, ["ls-remote", remote, "refs/heads/main", `refs/heads/${skillsProposal.branch}`]);
  const skillImpact = await proposalContextImpact({ selector: skillsProposal.branch, repository: remote });
  assert.equal(skillImpact.head, publishedSkills.head);
  assert.deepEqual(skillImpact.affected.sharedSkills.collections.map((item) => [item.id, item.change]), [["global", "modified"]]);
  assert.deepEqual(skillImpact.affected.sharedSkills.assignments.map((item) => [item.id, item.change]), [
    ["demo-project", "modified"],
    ["demo-shared", "added"],
    ["global-device", "removed"],
  ]);
  assert.deepEqual(skillImpact.affected.sharedSkills.providers, ["claude-code", "codex", "opencode"]);
  assert.equal(skillImpact.affected.sharedSkills.destinations.some((item) => item.assignmentId === "global-device" && item.destination === "provider-global"), true);
  assert.equal(skillImpact.affected.sharedSkills.destinations.some((item) => item.assignmentId === "demo-project" && item.provider === "claude-code" && item.destination === "project-provider"), true);
  assert.equal(skillImpact.affected.sharedSkills.destinations.some((item) => item.assignmentId === "demo-shared" && item.provider === "opencode" && item.destination === "project-provider"), true);
  assert.equal(skillImpact.reviewInvalidation.reviews.length, 0);
  assert.equal(git(base, ["ls-remote", remote, "refs/heads/main", `refs/heads/${skillsProposal.branch}`]), skillRefsBefore);
});
