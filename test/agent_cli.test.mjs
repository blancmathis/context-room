import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

import {
  applyAgentHandoff,
  applyCliReviewAnnotation,
  buildAgentEnvironment,
  buildAgentPrepare,
  classifyAgentChanges,
  listCliProjects,
  listCliReviews,
  planAgentHandoff,
  planCliReviewAnnotation,
  registerCliProject,
  resolveCliTarget,
} from "../src/agent_cli.mjs";
import { cliCapabilities, cliEnvelope, cliErrorEnvelope, ContextRoomCliError, projectCliData } from "../src/cli_contract.mjs";
import { appendContextRoomEvent, contextRoomEventJournalPath, readContextRoomEvents } from "../src/event_journal.mjs";
import { initializeContextRoomProject, writeMemoryWebappSettings } from "../src/context_room.mjs";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-agent-cli-"));
  const root = path.join(parent, "project");
  const hub = path.join(parent, "hub");
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
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hub;
  t.after(() => {
    if (previous === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previous;
    fs.rmSync(parent, { recursive: true, force: true });
  });
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

  const annotationPlan = planCliReviewAnnotation(target, review.path, "Please confirm the terminology.");
  assert.match(annotationPlan.planId, /^plan-/);
  const annotation = applyCliReviewAnnotation(target, { selector: review.path, note: "Please confirm the terminology.", planId: annotationPlan.planId });
  assert.equal(annotation.humanDecisionChanged, false);
  assert.equal(annotation.annotation.note, "Please confirm the terminology.");

  const handoffPlan = planAgentHandoff(target, { task: "Clarify guide", sessionId: "test-session", idempotencyKey: "test-op" });
  assert.match(handoffPlan.planId, /^plan-/);
  assert.match(handoffPlan.humanOwned, /accepted or rejected by a human/);
  const receipt = applyAgentHandoff(target, { planId: handoffPlan.planId, task: "Clarify guide", sessionId: "test-session", idempotencyKey: "test-op" });
  const repeated = applyAgentHandoff(target, { planId: handoffPlan.planId, task: "Clarify guide", sessionId: "test-session", idempotencyKey: "test-op" });
  assert.equal(receipt.operationId, repeated.operationId);
  assert.equal(repeated.idempotentReplay, true);

  const prepared = buildAgentPrepare(target, { task: "Clarify guide", provider: "codex" });
  assert.equal(prepared.data.documentation.pendingSession instanceof Array, true);
  assert.equal(prepared.data.review.humanOwned, true);
  assert.equal(prepared.data.environment.selectedFolder.path, "docs/feature");

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
  assert.equal(capabilities.commands.some((item) => /(?:accept|reject|verify)/.test(item.path)), false);
  assert.deepEqual(capabilities.humanOwned, ["accept-file-review", "reject-file-review"]);
  const success = cliEnvelope("agent.prepare", { data: { ok: true } });
  assert.equal(success.schemaVersion, "context-room.cli/1");
  assert.equal(success.ok, true);
  const failure = cliErrorEnvelope("agent.prepare", new ContextRoomCliError("ambiguous-target", "Choose a location", { retryable: true }));
  assert.equal(failure.error.code, "ambiguous-target");
  assert.equal(failure.error.retryable, true);
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
