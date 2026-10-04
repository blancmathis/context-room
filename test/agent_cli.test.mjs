import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import test from "node:test";

import {
  applyAgentHandoff,
  applyCliReviewAnnotation,
  agentInstructions,
  buildAgentEnvironment,
  buildAgentPrepare,
  buildAgentPrepareCached,
  classifyAgentChanges,
  listCliProjects,
  listCliReviews,
  planAgentHandoff,
  planCliReviewAnnotation,
  registerCliProject,
  resolveCliProjectReference,
  resolveCliTarget,
} from "../src/agent_cli.mjs";
import { cliCapabilities, cliEnvelope, cliErrorEnvelope, ContextRoomCliError, projectCliData } from "../src/cli_contract.mjs";
import { appendContextRoomEvent, contextRoomEventJournalPath, readContextRoomEvents } from "../src/event_journal.mjs";
import { initializeContextRoomProject, writeDocReviewDecision, writeMemoryWebappSettings } from "../src/context_room.mjs";
import { fitToTokenBudget } from "../src/agent_budget.mjs";
import { estimateTokens } from "../src/documentation.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-agent-cli-"));
  const root = path.join(parent, "project");
  const hub = path.join(parent, "hub");
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hub;
  t.after(() => {
    if (previous === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previous;
    fs.rmSync(parent, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "docs", "feature"), { recursive: true });
  fs.writeFileSync(path.join(root, "AGENTS.md"), "# Project instructions\n");
  fs.writeFileSync(path.join(root, "docs", "feature", "AGENTS.md"), "# Folder instructions\n");
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# Guide\n\nAccepted baseline.\n");
  git(root, ["init"]);
  git(root, ["config", "user.email", "context-room@example.test"]);
  git(root, ["config", "user.name", "Context Room Test"]);
  initializeContextRoomProject(root, { title: "Agent CLI", allowedPaths: ["docs/", "AGENTS.md"], watchAllow: ["docs/", "AGENTS.md"] });
  const settings = writeMemoryWebappSettings(root, {
    ...JSON.parse(fs.readFileSync(path.join(root, ".context-room", "config.json"), "utf8")),
    startupContext: { enabled: true, projectOnly: true, fileNames: ["AGENTS.md"], globalPaths: [] },
  });
  assert.equal(settings.startupContext.enabled, true);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return { parent, root, hub };
}

test("agent-first target, environment, review, handoff, and event contracts stay deterministic", (t) => {
  const { root } = fixture(t);
  const registered = registerCliProject({ root, title: "Agent CLI" });
  assert.ok(registered.id);

  const target = resolveCliTarget({ cwd: path.join(root, "docs", "feature") });
  assert.equal(target.root, fs.realpathSync(root));
  assert.equal(target.folder.path, "docs/feature");
  assert.equal(target.registered, true);

  const explicitTarget = resolveCliTarget({ cwd: path.dirname(root), project: registered.id });
  assert.equal(explicitTarget.root, fs.realpathSync(root));
  assert.equal(explicitTarget.folder.path, ".");

  const environment = buildAgentEnvironment(target, { provider: "codex" });
  assert.deepEqual(environment.instructions.map((item) => item.path), ["AGENTS.md", "docs/feature/AGENTS.md"]);
  assert.equal(environment.localEnvironment, "available");

  fs.appendFileSync(path.join(root, "docs", "guide.md"), "Changed.\n");
  const changes = classifyAgentChanges(target);
  assert.equal(changes.local.some((item) => item.path === "docs/guide.md" && item.category === "local-review"), true);

  const reviews = listCliReviews(target);
  const review = reviews.queue.find((item) => item.path === "docs/guide.md");
  assert.ok(review);
  assert.equal(reviews.humanOwned, true);
  assert.equal(reviews.humanDecisionPolicy.confirmationsRequired, 2);

  const annotationPlan = planCliReviewAnnotation(target, review.path, "Please confirm the terminology.");
  assert.match(annotationPlan.planId, /^plan-/);
  const annotation = applyCliReviewAnnotation(target, { selector: review.path, note: "Please confirm the terminology.", planId: annotationPlan.planId });
  assert.equal(annotation.humanDecisionChanged, false);
  assert.equal(annotation.annotation.note, "Please confirm the terminology.");

  const handoffPlan = planAgentHandoff(target, { task: "Clarify guide", sessionId: "test-session", idempotencyKey: "test-op" });
  assert.match(handoffPlan.planId, /^plan-/);
  assert.match(handoffPlan.humanOwned, /second separate, unambiguous yes/i);
  const receipt = applyAgentHandoff(target, { planId: handoffPlan.planId, task: "Clarify guide", sessionId: "test-session", idempotencyKey: "test-op" });
  const repeated = applyAgentHandoff(target, { planId: handoffPlan.planId, task: "Clarify guide", sessionId: "test-session", idempotencyKey: "test-op" });
  assert.equal(receipt.operationId, repeated.operationId);
  assert.equal(repeated.idempotentReplay, true);

  const prepared = buildAgentPrepare(target, { task: "Clarify guide", provider: "codex" });
  assert.equal(prepared.data.documentation.pendingSession instanceof Array, true);
  assert.equal(prepared.data.review.humanOwned, true);
  assert.equal(prepared.data.review.humanDecisionPolicy.confirmationsRequired, 2);
  assert.match(prepared.data.review.humanDecisionPolicy.instruction, /second separate, unambiguous yes/i);
  assert.equal(prepared.data.environment.selectedFolder.path, "docs/feature");

  const instructions = agentInstructions(target, { provider: "codex" });
  assert.match(instructions.prompt, /second separate, unambiguous yes/i);

  const projects = listCliProjects();
  assert.equal(projects.projects.length, 1);
  assert.equal(projects.projects[0].locations.length, 1);

  const event = appendContextRoomEvent("test.changed", {
    projectId: target.project.id,
    resource: { path: "docs/guide.md" },
    data: { content: "must not persist", status: "changed" },
  });
  const eventFile = contextRoomEventJournalPath();
  assert.equal(fs.statSync(eventFile).mode & 0o777, 0o600);
  const events = readContextRoomEvents({ since: event.cursor, projectId: target.project.id });
  assert.equal(events.events.length, 0);
  const stored = JSON.parse(fs.readFileSync(eventFile, "utf8").trim().split("\n").at(-1));
  assert.equal(Object.hasOwn(stored.data, "content"), false);
  assert.equal(stored.data.status, "changed");
});

test("machine envelopes and capabilities expose no agent review decision command", () => {
  const capabilities = cliCapabilities({ version: "test" });
  const expanded = cliCapabilities({ version: "test", expand: true });
  assert.equal(expanded.commands.some((item) => /(?:accept|reject|verify)/.test(item.path)), false);
  assert.deepEqual(capabilities.humanOwned, ["accept-file-review", "reject-file-review"]);
  assert.equal(capabilities.humanDecisionPolicy.confirmationsRequired, 2);
  const success = cliEnvelope("agent.prepare", { data: { ok: true } });
  assert.equal(success.schemaVersion, "context-room.cli/1");
  assert.equal(success.ok, true);
  const failure = cliErrorEnvelope("agent.prepare", new ContextRoomCliError("ambiguous-target", "Choose a location", { retryable: true }));
  assert.equal(failure.error.code, "ambiguous-target");
  assert.equal(failure.error.retryable, true);
});

test("project selectors prefer exact identities and reject cross-project aliases", () => {
  const projects = [
    { id: "exact-id", logicalProjectId: "logical-one", title: "Primary" },
    {
      id: "location-two",
      projectKey: "exact-id",
      logicalProjectId: "logical-two",
      title: "Exact ID",
      shared: { projectId: "exact-id" },
      worktrees: [{ id: "worktree-two", branch: "feature/two" }],
    },
  ];
  assert.equal(resolveCliProjectReference(projects, "exact-id").matches[0].logicalProjectId, "logical-one");
  assert.equal(resolveCliProjectReference(projects, "worktree-two").matches[0].logicalProjectId, "logical-two");
  assert.equal(resolveCliProjectReference(projects, "logical-two").matches[0].logicalProjectId, "logical-two");
  assert.equal(resolveCliProjectReference(projects, "shared:exact-id").matches[0].logicalProjectId, "logical-two");
  assert.equal(resolveCliProjectReference(projects, "shared:exact-id").matchedBy, "legacy-shared-project-key");

  const ambiguous = [
    { id: "one", logicalProjectId: "logical-one", title: "Atlas" },
    { id: "two", logicalProjectId: "logical-two", shared: { projectId: "atlas" }, title: "Other" },
  ];
  assert.throws(
    () => resolveCliProjectReference(ambiguous, "ATLAS"),
    (error) => error.code === "ambiguous-target"
      && error.statusCode === 409
      && error.details?.matchedBy === "alias"
      && error.details?.candidates?.length === 2,
  );
  assert.throws(
    () => resolveCliProjectReference([
      { id: "shared-one", logicalProjectId: "shared-one", shared: { projectId: "atlas" } },
      { id: "shared-two", logicalProjectId: "shared-two", shared: { projectId: "atlas" } },
    ], "shared:atlas"),
    (error) => error.code === "ambiguous-target"
      && error.details?.matchedBy === "legacy-shared-project-key"
      && error.details?.candidates?.length === 2,
  );

  const worktrees = [
    { id: "main", logicalProjectId: "logical-shared", title: "Shared title" },
    { id: "feature", logicalProjectId: "logical-shared", title: "Shared title" },
  ];
  assert.equal(resolveCliProjectReference(worktrees, "shared title").matches.length, 2);
});

test("resolveCliTarget never lets a title alias shadow an exact location id", (t) => {
  const { parent, root } = fixture(t);
  const exact = registerCliProject({ root, title: "Exact target" });
  const aliasRoot = path.join(parent, "alias-project");
  fs.mkdirSync(aliasRoot, { recursive: true });
  git(aliasRoot, ["init"]);
  initializeContextRoomProject(aliasRoot, { title: exact.id, allowedPaths: [], watchAllow: [] });
  registerCliProject({ root: aliasRoot, title: exact.id });

  const selected = resolveCliTarget({ cwd: aliasRoot, project: exact.id });
  assert.equal(selected.root, fs.realpathSync(root));
  assert.equal(selected.location.id, exact.id);
});

test("machine output projection selects fields and summarizes unexpanded collections", () => {
  const data = { target: { project: "hicharlie", folder: "apps/calls" }, instructions: [{ id: "global" }, { id: "project" }], health: { issues: [{ id: "one" }] } };
  assert.deepEqual(projectCliData(data, { fields: ["target.project", "health.issues"] }), {
    target: { project: "hicharlie" },
    health: { issues: [{ id: "one" }] },
  });
  assert.deepEqual(projectCliData(data, { summary: true }), {
    target: { project: "hicharlie", folder: "apps/calls" },
    instructions: { count: 2 },
    health: { issues: { count: 1 } },
  });
  assert.deepEqual(projectCliData(data, { summary: true, expand: ["instructions"] }).instructions, data.instructions);
});

test("worktrees stay undiscovered until explicitly registered and then group under one project", (t) => {
  const { parent, root } = fixture(t);
  const worktree = path.join(parent, "project-worktree");
  git(root, ["worktree", "add", "-b", "agent-cli-worktree", worktree]);
  registerCliProject({ root, title: "Grouped project" });
  let catalog = listCliProjects();
  assert.equal(catalog.projects.length, 1);
  assert.equal(catalog.projects[0].locations.length, 1);
  assert.equal(catalog.projects[0].locations.some((item) => item.root === fs.realpathSync(worktree)), false);

  registerCliProject({ root: worktree, title: "Grouped project" });
  catalog = listCliProjects();
  assert.equal(catalog.projects.length, 1);
  assert.equal(catalog.projects[0].locations.length, 2);
  const target = resolveCliTarget({ cwd: path.join(worktree, "docs") });
  assert.equal(target.root, fs.realpathSync(worktree));
  assert.equal(target.location.branch, "agent-cli-worktree");
});


test("prepare cache invalidates when ignored provider or configured instructions disappear", (t) => {
  const { root } = fixture(t);
  const folder = path.join(root, "docs", "feature");
  const override = path.join(folder, "AGENTS.override.md");
  const configured = path.join(folder, "TEAM.md");
  fs.writeFileSync(override, "# Override instruction\n");
  fs.writeFileSync(configured, "# Configured instruction\n");
  fs.appendFileSync(path.join(root, ".git", "info", "exclude"), "\nAGENTS.override.md\nTEAM.md\n");
  const settings = JSON.parse(fs.readFileSync(path.join(root, ".context-room", "config.json"), "utf8"));
  writeMemoryWebappSettings(root, { ...settings, startupContext: { ...settings.startupContext, fileNames: ["AGENTS.md", "TEAM.md"] } });
  registerCliProject({ root, title: "Cached instructions" });
  const target = resolveCliTarget({ cwd: folder });
  const options = { provider: "codex", task: "Guide" };
  const first = buildAgentPrepareCached(target, options);
  assert.equal(first.freshness.cache, "cold");
  for (const name of ["AGENTS.override.md", "TEAM.md"]) {
    assert.ok(first.data.environment.instructions.some((item) => item.path.endsWith(name)));
  }
  assert.equal(buildAgentPrepareCached(target, options).freshness.cache, "warm");
  for (const file of [override, configured]) {
    const before = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
    fs.unlinkSync(file);
    assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), before, "Git status cannot detect these ignored instructions");
    const refreshed = buildAgentPrepareCached(target, options);
    assert.equal(refreshed.freshness.cache, "cold");
    assert.equal(refreshed.data.environment.instructions.some((item) => item.path.endsWith(path.basename(file))), false);
    assert.equal(buildAgentPrepareCached(target, options).freshness.cache, "warm");
  }
});


test("prepare computes truthful context with a read-only project and cache", (t) => {
  const { root, hub } = fixture(t);
  registerCliProject({ root, title: "Read-only context" });
  const target = resolveCliTarget({ cwd: root });
  fs.mkdirSync(path.join(hub, "cli-cache"), { recursive: true });
  const modes = [];
  const visit = (file) => {
    const stats = fs.lstatSync(file);
    if (stats.isSymbolicLink()) return;
    modes.push([file, stats.mode & 0o777]);
    if (stats.isDirectory()) for (const child of fs.readdirSync(file)) visit(path.join(file, child));
  };
  visit(root);
  visit(hub);
  const before = git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
  try {
    for (const [file] of modes) fs.chmodSync(file, fs.statSync(file).isDirectory() ? 0o555 : 0o444);
    const result = buildAgentPrepareCached(target, { provider: "codex", task: "Guide" });
    assert.equal(result.freshness.cache, "unavailable");
    assert.ok(result.warnings.some((warning) => warning.includes("Context cache unavailable")));
    assert.ok(result.data.environment.instructions.some((item) => item.path === "AGENTS.md"));
    assert.equal(result.data.documentation.accepted.length, 0, "unreviewed documentation must remain excluded");
    assert.ok(result.data.review.items.some((item) => item.path === "docs/guide.md"));
    assert.deepEqual(fs.readdirSync(path.join(hub, "cli-cache")), []);
    assert.equal(git(root, ["status", "--porcelain=v1", "--untracked-files=all"]), before);
  } finally {
    for (const [file, mode] of modes) fs.chmodSync(file, mode);
  }
});

test("context bundle succeeds under a macOS sandbox denying all file writes", { skip: process.platform !== "darwin" }, (t) => {
  const { root, parent } = fixture(t);
  registerCliProject({ root, title: "Sandbox context" });
  const result = spawnSync("/usr/bin/sandbox-exec", [
    "-p", "(version 1) (allow default) (deny file-write*)",
    process.execPath, path.resolve("bin/context-room.mjs"),
    "context", "bundle", "--task", "Guide", "--provider", "codex", "--format", "json",
  ], {
    cwd: fs.realpathSync(root), encoding: "utf8", timeout: 60_000,
    env: { ...process.env, CONTEXT_ROOM_SHARED_HOME: path.join(parent, "shared") },
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.freshness.cache, "unavailable");
  assert.equal(envelope.data.documentation.accepted.length, 0);
  assert.ok(envelope.data.review.items.some((item) => item.path === "docs/guide.md"));
});

test("fitToTokenBudget drops the least useful items first and reports what it left out", () => {
  const value = { data: { minor: Array.from({ length: 30 }, (_, index) => `minor-${index}`), major: ["keep-a", "keep-b"] } };
  const render = (current, report) => JSON.stringify({ ...current, report });
  const { output, report } = fitToTokenBudget(value, { budget: 60, render, trimmers: ["data.minor", "data.major"] });
  assert.ok(estimateTokens(output) <= 60);
  assert.equal(report.fits, true);
  assert.ok(report.trimmed["data.minor"] > 0);
  assert.equal(report.trimmed["data.major"], undefined);
  assert.deepEqual(JSON.parse(output).report, report);
  assert.deepEqual(JSON.parse(output).data.major, ["keep-a", "keep-b"]);
});

test("context bundle, docs search and brief keep the whole printed output within --budget", (t) => {
  const { root, parent } = fixture(t);
  registerCliProject({ root, title: "Budget" });
  writeDocReviewDecision(root, "docs/guide.md", { status: "verified" });
  fs.writeFileSync(path.join(root, "docs", "guide-draft.md"), "# Guide draft\n\nNot reviewed yet.\n");
  const run = (...args) => spawnSync(process.execPath, [path.resolve("bin/context-room.mjs"), ...args], {
    cwd: fs.realpathSync(root), encoding: "utf8", timeout: 120_000,
    env: { ...process.env, CONTEXT_ROOM_SHARED_HOME: path.join(parent, "shared") },
  });
  const within = (output, budget) => assert.ok(estimateTokens(output) <= budget, `${estimateTokens(output)} tokens over ${budget}`);

  const bundle = run("context", "bundle", "--task", "Guide", "--budget", "1200", "--format", "json");
  assert.equal(bundle.status, 0, bundle.stderr || bundle.stdout);
  within(bundle.stdout, 1200);
  assert.deepEqual([JSON.parse(bundle.stdout).data.outputBudget.requested, JSON.parse(bundle.stdout).data.outputBudget.fits], [1200, true]);

  const tight = run("context", "bundle", "--task", "Guide", "--budget", "256", "--format", "json");
  if (tight.status === 0) within(tight.stdout, 256);
  else {
    assert.equal(tight.status, 2);
    assert.match(tight.stderr + tight.stdout, /budget-too-small/);
    assert.match(tight.stderr + tight.stdout, /Use --budget \d+ or more/);
  }

  const search = run("docs", "search", "Guide", "--budget", "256");
  assert.equal(search.status, 0, search.stderr || search.stdout);
  within(search.stdout, 256);
  assert.equal(JSON.parse(search.stdout).outputBudget.fits, true);

  const brief = run("brief", "guide", "--budget", "256");
  assert.equal(brief.status, 0, brief.stderr || brief.stdout);
  within(brief.stdout, 256);
  assert.match(brief.stdout, /^# Context Room Brief/);
  assert.match(brief.stdout, /- docs\/guide\.md /);
  assert.doesNotMatch(brief.stdout.split("## Review Warnings")[0], /guide-draft/, "Read First lists accepted documents only");
  assert.match(brief.stdout, /not reviewed yet and left out/);
});
