import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  contextHubRepositoryIdentity,
  contextHubHostRoot,
  readContextHubRegistry,
  registerContextHubProject,
  registerContextHubSharedRepository,
  unregisterContextHubProject,
  writeContextHubRuntime,
} from "../src/context_hub.mjs";
import { openSharedDocumentationProposalByBranch } from "../src/agent_cli.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import {
  disconnectSharedContext,
  initializeSharedRepository,
  readSharedProjectConnection,
} from "../src/shared_context.mjs";

const cli = path.resolve("bin/context-room.mjs");

function git(cwd, args, { allowFailure = false } = {}) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (!allowFailure && result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return String(result.stdout || "").trim();
}

function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  const makeWritable = (target) => {
    let stats;
    try { stats = fs.lstatSync(target); } catch { return; }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      try { fs.chmodSync(target, 0o755); } catch {}
      for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
    } else if (!stats.isSymbolicLink()) {
      try { fs.chmodSync(target, 0o644); } catch {}
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function runCli(args, env, cwd = process.cwd()) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
}

function runCliAsync(args, env, cwd = process.cwd()) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function writeSharedProject(seed, projectId) {
  fs.mkdirSync(path.join(seed, "projects", projectId, "docs"), { recursive: true });
  fs.writeFileSync(path.join(seed, "projects", projectId, "docs", "README.md"), `# ${projectId}\n\nAccepted.\n`, "utf8");
}

function makeRemote(base, name, projectIds = ["demo", "other"]) {
  const remote = path.join(base, `${name}.git`);
  const seed = path.join(base, `${name}-seed`);
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  git(seed, ["config", "user.name", "Shared fixture"]);
  git(seed, ["config", "user.email", "shared-fixture@example.test"]);
  initializeSharedRepository(seed, { name });
  fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({
    version: 1,
    projects: projectIds.map((id) => ({ id, title: id[0].toUpperCase() + id.slice(1) })),
  }, null, 2) + "\n", "utf8");
  for (const projectId of projectIds) writeSharedProject(seed, projectId);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initial shared context"]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed };
}

function publishFixtureProposal(remote, {
  branch = "proposal/demo/canonical-selector",
  projectId = "demo",
  content = "Selected proposal.\n",
} = {}) {
  git(remote.seed, ["checkout", "main"]);
  const baseRevision = git(remote.seed, ["rev-parse", "HEAD"]);
  git(remote.seed, ["checkout", "-b", branch]);
  fs.writeFileSync(path.join(remote.seed, "projects", projectId, "docs", "README.md"), `# ${projectId}\n\n${content}`, "utf8");
  git(remote.seed, ["add", "."]);
  git(remote.seed, [
    "commit",
    "-m",
    `Canonical selector fixture\n\nContext-Room-Title: Canonical selector fixture\nContext-Room-Project: ${projectId}\nContext-Room-Base: ${baseRevision}`,
  ]);
  const head = git(remote.seed, ["rev-parse", "HEAD"]);
  git(remote.seed, ["push", "origin", `${branch}:${branch}`]);
  git(remote.seed, ["checkout", "main"]);
  return { branch, baseRevision, head };
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-cli-contract-"));
  const home = path.join(base, "home");
  const hubHome = path.join(home, ".context-room", "hub");
  const sharedHome = path.join(home, ".context-room", "shared");
  const project = path.join(base, "project");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  git(project, ["init"]);
  initializeContextRoomProject(project, { title: "CLI contract project", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const first = makeRemote(base, "first");
  const second = makeRemote(base, "second", ["demo"]);
  const env = {
    ...process.env,
    HOME: home,
    CONTEXT_ROOM_HUB_HOME: hubHome,
    CONTEXT_ROOM_SHARED_HOME: sharedHome,
    GIT_CONFIG_GLOBAL: path.join(base, "empty-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    NODE_TEST_CONTEXT: "",
  };
  const previous = Object.fromEntries(["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeWritableTree(base);
  });
  return { base, env, home, hubHome, sharedHome, project, first, second };
}

test("machine failures keep valid envelopes and canonical public command names", (t) => {
  const { base, env, project } = fixture(t);
  const cases = [
    { args: ["edit", "open", "proposal/demo/example", "--unknown", "--format=json"], command: "edit", code: "unknown-option" },
    { args: ["ask", "Research the accepted docs", "--unknown", "--format=json"], command: "ask", code: "unknown-option" },
    { args: ["init", `--root=${project}`, "--title", "--format=json"], command: "init", code: "missing-option-value" },
    { args: ["shared", "connect", `--root=${project}`, "--format=json"], command: "shared.connect", code: "missing-repository" },
    { args: ["ask", "Research the accepted docs", "--repository=/missing/shared.git", "--format=json"], command: "ask", code: "shared-target-incomplete" },
    { args: ["agent", "prepare", "--task=Research", "--repository=/missing/shared.git", "--format=json"], command: "agent.prepare", code: "shared-target-incomplete", message: /--shared-project/ },
    { args: ["ask", "--format=json"], command: "ask", code: "missing-research-brief" },
    { args: ["ask", "Research", "--session=proposal", "--format=json"], command: "ask", code: "unsupported-proposal-overlay" },
  ];
  for (const entry of cases) {
    const result = runCli(entry.args, env, base);
    assert.notEqual(result.status, 0, entry.args.join(" "));
    assert.equal(result.stdout, "", entry.args.join(" "));
    const envelope = JSON.parse(result.stderr);
    assert.equal(envelope.ok, false);
    assert.equal(envelope.command, entry.command, entry.args.join(" "));
    assert.equal(envelope.error.code, entry.code);
    if (entry.message) assert.match(envelope.error.message, entry.message);
  }
});

test("shared connect is idempotent but never replaces a binding without disconnect", (t) => {
  const { env, project, first, second } = fixture(t);
  const connect = (repository, projectId = "demo", extra = []) => runCli([
    "shared", "connect", `--root=${project}`, `--repository=${repository}`, `--shared-project=${projectId}`, "--format=json", ...extra,
  ], env, project);

  const initial = connect(first.remote);
  assert.equal(initial.status, 0, initial.stderr);
  const repeated = connect(first.remote);
  assert.equal(repeated.status, 0, repeated.stderr);

  for (const result of [connect(second.remote), connect(first.remote, "other"), connect(second.remote, "demo", ["--dry-run"])]) {
    assert.equal(result.status, 5, result.stderr);
    const failure = JSON.parse(result.stderr);
    assert.equal(failure.error.code, "shared-binding-conflict");
  }
  assert.deepEqual(readSharedProjectConnection(project), {
    version: 1,
    repository: first.remote,
    projectId: "demo",
    projectRoot: fs.realpathSync(project),
  });
});

test("docs publish reports one rebased revision and uses a safe deterministic Git identity", (t) => {
  const { env, project, first, base } = fixture(t);
  let result = runCli(["shared", "connect", `--root=${project}`, `--repository=${first.remote}`, "--shared-project=demo", "--format=json"], env, project);
  assert.equal(result.status, 0, result.stderr);
  result = runCli([
    "edit", "create", "Clarify the accepted demo guidance and preserve exact revision provenance.", `--root=${project}`, "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  const handle = JSON.parse(result.stdout).data;
  fs.writeFileSync(path.join(handle.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nProposed.\n", "utf8");

  fs.writeFileSync(path.join(first.seed, "projects", "demo", "docs", "OTHER.md"), "# Other\n\nAdvanced main.\n", "utf8");
  git(first.seed, ["add", "."]);
  git(first.seed, ["commit", "-m", "Advance accepted main"]);
  git(first.seed, ["push", "origin", "main"]);
  const expectedBase = git(first.seed, ["rev-parse", "HEAD"]);

  const publishEnv = {
    ...env,
    GIT_AUTHOR_NAME: "Leaked OS User",
    GIT_AUTHOR_EMAIL: "leaked@machine.lan",
    GIT_COMMITTER_NAME: "Leaked OS User",
    GIT_COMMITTER_EMAIL: "leaked@machine.lan",
  };
  result = runCli([
    "docs", "publish", `--change=${handle.changeId}`, "--summary=Clarify demo", "--description=Clarify the accepted demo guidance after main advanced.", "--format=json",
  ], publishEnv, base);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout).data;
  assert.equal(published.result.rebased, true);
  assert.equal(published.acceptedRevision, expectedBase);
  assert.equal(published.proposal.baseRevision, expectedBase);
  assert.equal(published.result.baseRevision, expectedBase);
  assert.equal(published.proposal.head, published.result.head);
  const identities = git(handle.editRoot, ["log", `${expectedBase}..HEAD`, "--format=%an <%ae>|%cn <%ce>"]).split("\n").filter(Boolean);
  assert.ok(identities.length >= 1);
  assert.deepEqual(new Set(identities), new Set(["Context Room <context-room@local.invalid>|Context Room <context-room@local.invalid>"]));
});

test("transient Shared publish failures are valid retryable machine errors", (t) => {
  const { env, project, first, base } = fixture(t);
  let result = runCli(["shared", "connect", `--root=${project}`, `--repository=${first.remote}`, "--shared-project=demo", "--format=json"], env, project);
  assert.equal(result.status, 0, result.stderr);
  result = runCli([
    "edit", "create", "Publish this proposal while the Shared repository is temporarily unavailable.", `--root=${project}`, "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  const handle = JSON.parse(result.stdout).data;
  fs.writeFileSync(path.join(handle.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nPending offline publish.\n", "utf8");

  fs.renameSync(first.remote, `${first.remote}.offline`);
  result = runCli([
    "docs", "publish", `--change=${handle.changeId}`, "--summary=Offline publish", "--description=Exercise the transient Shared failure contract.", "--format=json",
  ], env, base);
  assert.equal(result.status, 3, result.stderr);
  assert.equal(result.stdout, "");
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.ok, false);
  assert.equal(failure.command, "docs.publish");
  assert.equal(failure.error.code, "shared-context-unavailable");
  assert.equal(failure.error.retryable, true);
});

test("edit open rehydrates a proposal registered only through the Context Hub", (t) => {
  const { env, project, first, base, sharedHome } = fixture(t);
  const remoteProposal = publishFixtureProposal(first, {
    branch: "proposal/demo/hub-only-open",
    content: "Hub-only proposal.\n",
  });
  const branch = remoteProposal.branch;
  registerContextHubSharedRepository(`file://${first.remote}`);
  unregisterContextHubProject(project);
  assert.equal(readSharedProjectConnection(project), null);
  assert.equal(fs.existsSync(sharedHome), false, "Hub registration alone must not create Shared cache or proposal worktrees");
  const unrelated = path.join(base, "unrelated");
  fs.mkdirSync(unrelated);

  let result = runCli(["edit", "open", branch, "--format=json"], env, unrelated);
  assert.equal(result.status, 0, result.stderr);
  const opened = JSON.parse(result.stdout).data;
  assert.equal(opened.proposal.branch, branch);
  assert.equal(opened.proposal.head, remoteProposal.head);
  assert.equal(opened.proposal.projectId, "demo");
  assert.match(opened.changeId, /^change-[a-f0-9]{24}$/);
  assert.equal(git(opened.editRoot, ["branch", "--show-current"]), branch);
  assert.equal(opened.sourceRoot, "");
  assert.equal(fs.existsSync(path.join(unrelated, ".context-room")), false);
  assert.equal(readSharedProjectConnection(project), null);

  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nHub-only proposal reopened and published.\n", "utf8");
  result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Publish from the Hub", "--description=Publish this reopened proposal without a local project binding.", "--format=json",
  ], env, unrelated);
  assert.equal(result.status, 0, result.stderr);
  const republished = JSON.parse(result.stdout).data;
  assert.equal(republished.status, "published");
  assert.equal(republished.proposal.branch, branch);
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s+/)[0], republished.result.head);

  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nA second unpublished revision.\n", "utf8");
  result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Missing fresh description", "--format=json",
  ], env, unrelated);
  assert.equal(result.status, 2, result.stderr);
  const missingDescription = JSON.parse(result.stderr);
  assert.equal(missingDescription.error.code, "missing-description");
  assert.match(missingDescription.error.message, /--description is required/);
  assert.equal(missingDescription.error.details.expectedHead, republished.result.head);
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s+/)[0], republished.result.head);

  git(first.seed, ["fetch", "origin", branch]);
  git(first.seed, ["checkout", "-B", "external-proposal-update", `origin/${branch}`]);
  fs.writeFileSync(path.join(first.seed, "projects", "demo", "docs", "EXTERNAL.md"), "# External\n\nAdvanced elsewhere.\n", "utf8");
  git(first.seed, ["add", "."]);
  git(first.seed, [
    "commit",
    "-m",
    `Advance the proposal elsewhere\n\nContext-Room-Title: Hub-only proposal\nContext-Room-Project: demo\nContext-Room-Base: ${republished.result.baseRevision}`,
  ]);
  const externalHead = git(first.seed, ["rev-parse", "HEAD"]);
  git(first.seed, ["push", "origin", `HEAD:${branch}`]);
  git(first.seed, ["checkout", "main"]);

  result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Stale publish", "--format=json",
  ], env, unrelated);
  assert.equal(result.status, 3, result.stderr);
  const stale = JSON.parse(result.stderr);
  assert.equal(stale.error.code, "shared-proposal-stale");
  assert.equal(stale.error.retryable, true);
  assert.equal(stale.error.details.expectedHead, republished.result.head);
  assert.equal(stale.error.details.actualHead, externalHead);
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${branch}`]).split(/\s+/)[0], externalHead);
});

test("a legacy Hub-only handle requires an exact reopen before publish", (t) => {
  const { env, first, base, hubHome } = fixture(t);
  const remoteProposal = publishFixtureProposal(first, {
    branch: "proposal/demo/exact-handle-head",
    content: "Proposal version observed by the handle.\n",
  });
  registerContextHubSharedRepository(first.remote);
  const unrelated = path.join(base, "unrelated-exact-handle");
  fs.mkdirSync(unrelated);

  let result = runCli(["edit", "open", remoteProposal.branch, "--format=json"], env, unrelated);
  assert.equal(result.status, 0, result.stderr);
  const opened = JSON.parse(result.stdout).data;
  assert.equal(opened.proposal.head, remoteProposal.head);
  assert.equal(opened.proposal.remoteHead, remoteProposal.head);
  assert.equal(opened.proposal.lastPublishedHead, remoteProposal.head);
  const handlePath = path.join(hubHome, "operations", "documentation-changes", `${opened.changeId}.json`);
  const legacyHandle = JSON.parse(fs.readFileSync(handlePath, "utf8"));
  delete legacyHandle.proposal.remoteHead;
  delete legacyHandle.proposal.lastPublishedHead;
  fs.writeFileSync(handlePath, JSON.stringify(legacyHandle, null, 2) + "\n", "utf8");

  git(first.seed, ["fetch", "origin", remoteProposal.branch]);
  git(first.seed, ["checkout", "-B", "external-exact-handle", `origin/${remoteProposal.branch}`]);
  fs.writeFileSync(path.join(first.seed, "projects", "demo", "docs", "EXTERNAL.md"), "# External\n\nAdvanced elsewhere.\n", "utf8");
  git(first.seed, ["add", "."]);
  git(first.seed, [
    "commit",
    "-m",
    `Advance the proposal elsewhere\n\nContext-Room-Title: Exact handle head\nContext-Room-Project: demo\nContext-Room-Base: ${remoteProposal.baseRevision}`,
  ]);
  const externalHead = git(first.seed, ["rev-parse", "HEAD"]);
  git(first.seed, ["push", "origin", `HEAD:${remoteProposal.branch}`]);
  git(first.seed, ["checkout", "main"]);
  fs.writeFileSync(path.join(first.seed, "projects", "demo", "docs", "MAIN.md"), "# Main\n\nAccepted main advanced too.\n", "utf8");
  git(first.seed, ["add", "."]);
  git(first.seed, ["commit", "-m", "Advance accepted main after the handle opened"]);
  git(first.seed, ["push", "origin", "main"]);

  result = runCli(["edit", "open", remoteProposal.branch, "--format=json"], env, unrelated);
  assert.equal(result.status, 0, result.stderr);
  const refreshed = JSON.parse(result.stdout).data;
  assert.equal(refreshed.proposal.head, externalHead);
  assert.equal(refreshed.editRoot, opened.editRoot);
  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nStale handle must not publish this update.\n", "utf8");
  const localHead = git(opened.editRoot, ["rev-parse", "HEAD"]);

  result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Stale exact handle", "--description=Attempt publication from the exact older handle.", "--format=json",
  ], env, unrelated);
  assert.equal(result.status, 3, result.stderr);
  const upgrade = JSON.parse(result.stderr);
  assert.equal(upgrade.error.code, "change-state-upgrade-required");
  assert.equal(upgrade.error.retryable, true);
  assert.equal(upgrade.error.details.proposalHead, remoteProposal.head);
  assert.equal(upgrade.error.details.lastPublishedHead, "");
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${remoteProposal.branch}`]).split(/\s+/)[0], externalHead);
  assert.equal(git(opened.editRoot, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(opened.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
});

test("a legacy local-only handle requires one exact reopen before its first publish", (t) => {
  const { env, project, first, base, hubHome } = fixture(t);
  let result = runCli([
    "shared", "connect", `--root=${project}`, `--repository=${first.remote}`, "--shared-project=demo", "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  result = runCli([
    "edit", "create", "Create a local-only proposal that has never existed on the remote.", `--root=${project}`, "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout).data;
  result = runCli(["edit", "open", created.proposal.branch, "--format=json"], env, base);
  assert.equal(result.status, 0, result.stderr);
  const opened = JSON.parse(result.stdout).data;
  assert.equal(opened.proposal.remoteHead, "");
  assert.equal(opened.proposal.lastPublishedHead, "");
  const handlePath = path.join(hubHome, "operations", "documentation-changes", `${opened.changeId}.json`);
  const legacyHandle = JSON.parse(fs.readFileSync(handlePath, "utf8"));
  delete legacyHandle.proposal.remoteHead;
  delete legacyHandle.proposal.lastPublishedHead;
  fs.writeFileSync(handlePath, JSON.stringify(legacyHandle, null, 2) + "\n", "utf8");
  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nFirst unpublished local update.\n", "utf8");
  const localHead = git(opened.editRoot, ["rev-parse", "HEAD"]);

  result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Legacy local first publish", "--format=json",
  ], env, base);
  assert.equal(result.status, 3, result.stderr);
  const upgrade = JSON.parse(result.stderr);
  assert.equal(upgrade.error.code, "change-state-upgrade-required");
  assert.equal(upgrade.error.retryable, true);
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${created.proposal.branch}`]), "");
  assert.equal(git(opened.editRoot, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(opened.editRoot, ["status", "--porcelain=v1"]), /README\.md/);

  result = runCli(["edit", "open", created.proposal.branch, "--format=json"], env, base);
  assert.equal(result.status, 0, result.stderr);
  const reopened = JSON.parse(result.stdout).data;
  assert.equal(reopened.editRoot, opened.editRoot);
  assert.equal(reopened.proposal.remoteHead, "");
  result = runCli([
    "docs", "publish", `--change=${reopened.changeId}`, "--summary=Publish after exact reopen", "--format=json",
  ], env, base);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout).data;
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${created.proposal.branch}`]).split(/\s+/)[0], published.result.head);
});

test("a local-only handle atomically pins the proposal branch as remotely absent", (t) => {
  const { env, project, first, base } = fixture(t);
  let result = runCli([
    "shared", "connect", `--root=${project}`, `--repository=${first.remote}`, "--shared-project=demo", "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  result = runCli([
    "edit", "create", "Create a proposal whose remote branch is initially absent.", `--root=${project}`, "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout).data;
  result = runCli(["edit", "open", created.proposal.branch, "--format=json"], env, base);
  assert.equal(result.status, 0, result.stderr);
  const absentHandle = JSON.parse(result.stdout).data;
  assert.equal(absentHandle.proposal.remoteHead, "");
  assert.equal(absentHandle.proposal.lastPublishedHead, "");

  fs.writeFileSync(path.join(created.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nFirst published proposal version.\n", "utf8");
  result = runCli([
    "docs", "publish", `--change=${created.changeId}`, "--summary=Create the remote proposal branch", "--format=json",
  ], env, base);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout).data;
  fs.writeFileSync(path.join(absentHandle.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nThe old absent-head handle must not republish.\n", "utf8");
  const localHead = git(absentHandle.editRoot, ["rev-parse", "HEAD"]);

  result = runCli([
    "docs", "publish", `--change=${absentHandle.changeId}`, "--summary=Stale absent-head handle", "--format=json",
  ], env, base);
  assert.equal(result.status, 3, result.stderr);
  const stale = JSON.parse(result.stderr);
  assert.equal(stale.error.code, "shared-proposal-stale");
  assert.equal(stale.error.details.expectedHead, "");
  assert.equal(stale.error.details.actualHead, published.result.head);
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${created.proposal.branch}`]).split(/\s+/)[0], published.result.head);
  assert.equal(git(absentHandle.editRoot, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(absentHandle.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
});

test("compat Shared edit pins the exact head of a reused published proposal", (t) => {
  const { env, project, first, base } = fixture(t);
  let result = runCli([
    "shared", "connect", `--root=${project}`, `--repository=${first.remote}`, "--shared-project=demo", "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  result = runCli([
    "edit", "create", "Create the proposal that the compatibility handle will later reuse.", `--root=${project}`, "--session=compat-reused-head", "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout).data;
  fs.writeFileSync(path.join(created.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nInitial compatibility proposal.\n", "utf8");
  result = runCli([
    "docs", "publish", `--change=${created.changeId}`, "--summary=Initial compatibility proposal", "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout).data;

  result = runCli([
    "docs", "edit", "--task=Continue the exact compatibility proposal.", "--scope=shared", "--session=compat-reused-head", `--root=${project}`, "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  const compatibilityHandle = JSON.parse(result.stdout).data;
  assert.equal(compatibilityHandle.proposal.branch, published.proposal.branch);
  assert.equal(compatibilityHandle.proposal.reused, true);
  assert.equal(compatibilityHandle.proposal.head, published.result.head);
  assert.equal(compatibilityHandle.proposal.remoteHead, published.result.head);
  assert.equal(compatibilityHandle.proposal.lastPublishedHead, published.result.head);

  git(first.seed, ["fetch", "origin", published.proposal.branch]);
  git(first.seed, ["checkout", "-B", "external-compat-reused", `origin/${published.proposal.branch}`]);
  fs.writeFileSync(path.join(first.seed, "projects", "demo", "docs", "EXTERNAL.md"), "# External\n\nAdvanced after compatibility edit.\n", "utf8");
  git(first.seed, ["add", "."]);
  git(first.seed, [
    "commit",
    "-m",
    `Advance the compatibility proposal elsewhere\n\nContext-Room-Title: Compatibility proposal\nContext-Room-Project: demo\nContext-Room-Base: ${published.result.baseRevision}\nContext-Room-Session: compat-reused-head`,
  ]);
  const externalHead = git(first.seed, ["rev-parse", "HEAD"]);
  const proposalStateRef = `refs/heads/context-room-state/${createHash("sha256").update(published.proposal.branch).digest("hex")}`;
  git(first.seed, [
    "push",
    "--atomic",
    `--force-with-lease=refs/heads/${published.proposal.branch}:${published.result.head}`,
    `--force-with-lease=${proposalStateRef}:${published.result.head}`,
    "origin",
    `${externalHead}:refs/heads/${published.proposal.branch}`,
    `${externalHead}:${proposalStateRef}`,
  ]);
  git(first.seed, ["checkout", "main"]);

  result = runCli(["edit", "open", published.proposal.branch, "--format=json"], env, base);
  assert.equal(result.status, 0, result.stderr);
  const refreshed = JSON.parse(result.stdout).data;
  assert.equal(refreshed.proposal.head, externalHead);
  assert.equal(refreshed.editRoot, compatibilityHandle.editRoot);
  fs.writeFileSync(path.join(compatibilityHandle.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nThe stale compatibility handle must not publish.\n", "utf8");
  const localHead = git(compatibilityHandle.editRoot, ["rev-parse", "HEAD"]);

  result = runCli([
    "docs", "publish", `--change=${compatibilityHandle.changeId}`, "--summary=Stale compatibility handle", "--description=Attempt publication from the older compatibility handle.", "--format=json",
  ], env, base);
  assert.equal(result.status, 3, result.stderr);
  const stale = JSON.parse(result.stderr);
  assert.equal(stale.error.code, "shared-proposal-stale");
  assert.equal(stale.error.details.expectedHead, published.result.head);
  assert.equal(stale.error.details.actualHead, externalHead);
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${published.proposal.branch}`]).split(/\s+/)[0], externalHead);
  assert.equal(git(compatibilityHandle.editRoot, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(compatibilityHandle.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
});

test("publish fails closed when a handle contains conflicting observed proposal heads", (t) => {
  const { env, first, base, hubHome } = fixture(t);
  const remoteProposal = publishFixtureProposal(first, { branch: "proposal/demo/conflicting-handle-heads" });
  registerContextHubSharedRepository(first.remote);
  const unrelated = path.join(base, "unrelated-conflicting-heads");
  fs.mkdirSync(unrelated);
  let result = runCli(["edit", "open", remoteProposal.branch, "--format=json"], env, unrelated);
  assert.equal(result.status, 0, result.stderr);
  const opened = JSON.parse(result.stdout).data;
  const handlePath = path.join(hubHome, "operations", "documentation-changes", `${opened.changeId}.json`);
  const originalHandle = JSON.parse(fs.readFileSync(handlePath, "utf8"));
  const conflictingHead = remoteProposal.head === "0".repeat(40) ? "1".repeat(40) : "0".repeat(40);
  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nThis inconsistent handle must not publish.\n", "utf8");
  const localHead = git(opened.editRoot, ["rev-parse", "HEAD"]);
  const variants = [
    { remoteHead: remoteProposal.head, lastPublishedHead: conflictingHead },
    { remoteHead: "", lastPublishedHead: remoteProposal.head },
    { remoteHead: remoteProposal.head, lastPublishedHead: "" },
  ];
  for (const variant of variants) {
    const inconsistentHandle = structuredClone(originalHandle);
    Object.assign(inconsistentHandle.proposal, variant);
    fs.writeFileSync(handlePath, JSON.stringify(inconsistentHandle, null, 2) + "\n", "utf8");
    result = runCli([
      "docs", "publish", `--change=${opened.changeId}`, "--summary=Conflicting observed heads", "--description=Attempt publication from an inconsistent handle.", "--format=json",
    ], env, unrelated);
    assert.equal(result.status, 3, `${JSON.stringify(variant)}\n${result.stderr}`);
    const invalid = JSON.parse(result.stderr);
    assert.equal(invalid.error.code, "change-state-invalid");
    assert.equal(invalid.error.retryable, true);
    assert.equal(invalid.error.details.remoteHead, variant.remoteHead);
    assert.equal(invalid.error.details.lastPublishedHead, variant.lastPublishedHead);
    assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${remoteProposal.branch}`]).split(/\s+/)[0], remoteProposal.head);
    assert.equal(git(opened.editRoot, ["rev-parse", "HEAD"]), localHead);
    assert.match(git(opened.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
  }
});

test("Hub-only publish requires the reopened proposal head to equal its exact published head", (t) => {
  const { env, first, base, hubHome } = fixture(t);
  const remoteProposal = publishFixtureProposal(first, { branch: "proposal/demo/reopened-head-binding" });
  registerContextHubSharedRepository(first.remote);
  const unrelated = path.join(base, "unrelated-reopened-head-binding");
  fs.mkdirSync(unrelated);
  let result = runCli(["edit", "open", remoteProposal.branch, "--format=json"], env, unrelated);
  assert.equal(result.status, 0, result.stderr);
  const opened = JSON.parse(result.stdout).data;
  assert.equal(opened.sourceRoot, "");
  assert.equal(opened.proposal.head, remoteProposal.head);
  assert.equal(opened.proposal.lastPublishedHead, remoteProposal.head);
  const handlePath = path.join(hubHome, "operations", "documentation-changes", `${opened.changeId}.json`);
  const originalHandle = JSON.parse(fs.readFileSync(handlePath, "utf8"));
  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nAn inconsistent reopened handle must not publish.\n", "utf8");
  const localHead = git(opened.editRoot, ["rev-parse", "HEAD"]);
  const variants = [
    { proposalHead: remoteProposal.baseRevision, lastPublishedHead: remoteProposal.head },
    { proposalHead: "", lastPublishedHead: remoteProposal.head },
    { proposalHead: remoteProposal.head, lastPublishedHead: "" },
  ];

  for (const variant of variants) {
    const inconsistentHandle = structuredClone(originalHandle);
    inconsistentHandle.proposal.head = variant.proposalHead;
    inconsistentHandle.proposal.lastPublishedHead = variant.lastPublishedHead;
    inconsistentHandle.proposal.remoteHead = variant.lastPublishedHead;
    fs.writeFileSync(handlePath, JSON.stringify(inconsistentHandle, null, 2) + "\n", "utf8");
    result = runCli([
      "docs", "publish", `--change=${opened.changeId}`, "--summary=Reject inconsistent reopened head", "--description=Do not publish from a handle whose exact heads disagree.", "--format=json",
    ], env, unrelated);
    assert.equal(result.status, 3, `${JSON.stringify(variant)}\n${result.stderr}`);
    const invalid = JSON.parse(result.stderr);
    assert.equal(invalid.error.code, "change-state-invalid");
    assert.equal(invalid.error.retryable, true);
    assert.equal(invalid.error.details.proposalHead, variant.proposalHead);
    assert.equal(invalid.error.details.lastPublishedHead, variant.lastPublishedHead);
    assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${remoteProposal.branch}`]).split(/\s+/)[0], remoteProposal.head);
    assert.equal(git(opened.editRoot, ["rev-parse", "HEAD"]), localHead);
    assert.match(git(opened.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
  }
});

test("Hub-only publish never reuses the reopened proposal description", (t) => {
  const { env, first, base } = fixture(t);
  const remoteProposal = publishFixtureProposal(first, { branch: "proposal/demo/fresh-hub-description" });
  registerContextHubSharedRepository(first.remote);
  const unrelated = path.join(base, "unrelated-fresh-hub-description");
  fs.mkdirSync(unrelated);
  let result = runCli(["edit", "open", remoteProposal.branch, "--format=json"], env, unrelated);
  assert.equal(result.status, 0, result.stderr);
  const opened = JSON.parse(result.stdout).data;
  assert.equal(opened.sourceRoot, "");
  assert.ok(opened.description, "the reopened handle intentionally retains its old human-readable description");
  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nThis update requires a fresh cumulative description.\n", "utf8");
  const localHead = git(opened.editRoot, ["rev-parse", "HEAD"]);

  result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Missing fresh Hub description", "--format=json",
  ], env, unrelated);
  assert.equal(result.status, 2, result.stderr);
  const missing = JSON.parse(result.stderr);
  assert.equal(missing.error.code, "missing-description");
  assert.match(missing.error.message, /--description is required/);
  assert.equal(missing.error.details.expectedHead, remoteProposal.head);
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${remoteProposal.branch}`]).split(/\s+/)[0], remoteProposal.head);
  assert.equal(git(opened.editRoot, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(opened.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
});

test("Hub-only publish refuses an accepted proposal before mutating its workspace", (t) => {
  const { env, first, base } = fixture(t);
  const fixtureProposal = publishFixtureProposal(first, { branch: "proposal/demo/terminal-publish" });
  const opened = openSharedDocumentationProposalByBranch({
    proposal: fixtureProposal.branch,
    repository: first.remote,
    projectId: "demo",
  });
  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nMust remain unpublished.\n", "utf8");

  git(first.seed, ["checkout", "-B", "terminal-acceptance", fixtureProposal.head]);
  git(first.seed, [
    "commit",
    "--allow-empty",
    "-m",
    `Accept the proposal\n\nContext-Room-Proposal: ${fixtureProposal.branch}\nContext-Room-Proposal-Head: ${fixtureProposal.head}\nContext-Room-Project: demo`,
  ]);
  git(first.seed, ["push", "origin", "HEAD:accepted/demo/terminal-publish"]);
  git(first.seed, ["checkout", "main"]);
  const proposalHead = git(first.seed, ["ls-remote", "origin", `refs/heads/${fixtureProposal.branch}`]).split(/\s+/)[0];

  const result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Do not republish accepted work", "--format=json",
  ], env, base);
  assert.notEqual(result.status, 0, result.stderr);
  const terminal = JSON.parse(result.stderr);
  assert.equal(terminal.error.code, "shared-proposal-terminal");
  assert.equal(terminal.error.details.reviewStatus, "accepted");
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${fixtureProposal.branch}`]).split(/\s+/)[0], proposalHead);
  assert.match(git(opened.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
});

test("Hub-only publish refuses a rejected proposal before mutating its workspace", (t) => {
  const { env, first, base } = fixture(t);
  const remoteProposal = publishFixtureProposal(first, { branch: "proposal/demo/terminal-rejected-publish" });
  const opened = openSharedDocumentationProposalByBranch({
    proposal: remoteProposal.branch,
    repository: first.remote,
    projectId: "demo",
  });
  fs.writeFileSync(path.join(opened.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nMust remain unpublished after rejection.\n", "utf8");
  const rejectionBranch = `rejected/demo/terminal-rejected-publish-${remoteProposal.head.slice(0, 12)}`;
  git(first.seed, ["fetch", "origin", remoteProposal.branch]);
  const proposalTree = git(first.seed, ["rev-parse", `${remoteProposal.head}^{tree}`]);
  const rejectedState = git(first.seed, [
    "commit-tree",
    proposalTree,
    "-p",
    remoteProposal.head,
    "-m",
    `Context Room terminal proposal decision: rejected\n\nContext-Room-Terminal-Decision: rejected\nContext-Room-Proposal: ${remoteProposal.branch}\nContext-Room-Proposal-Head: ${remoteProposal.head}\nContext-Room-Rejection-Archive: ${rejectionBranch}`,
  ]);
  const proposalStateRef = `refs/heads/context-room-state/${createHash("sha256").update(remoteProposal.branch).digest("hex")}`;
  git(first.seed, [
    "push",
    "--atomic",
    "origin",
    `${remoteProposal.head}:refs/heads/${rejectionBranch}`,
    `${rejectedState}:${proposalStateRef}`,
  ]);
  const proposalHead = git(first.seed, ["ls-remote", "origin", `refs/heads/${remoteProposal.branch}`]).split(/\s+/)[0];
  const localHead = git(opened.editRoot, ["rev-parse", "HEAD"]);

  const result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Do not republish rejected work", "--format=json",
  ], env, base);
  assert.notEqual(result.status, 0, result.stderr);
  const terminal = JSON.parse(result.stderr);
  assert.equal(terminal.error.code, "shared-proposal-terminal");
  assert.equal(terminal.error.details.reviewStatus, "rejected");
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${remoteProposal.branch}`]).split(/\s+/)[0], proposalHead);
  assert.equal(git(opened.editRoot, ["rev-parse", "HEAD"]), localHead);
  assert.match(git(opened.editRoot, ["status", "--porcelain=v1"]), /README\.md/);
});

test("equivalent repository aliases retain the local proposal workspace through publish", (t) => {
  const { env, first, base, project } = fixture(t);
  registerContextHubProject(project);
  const aliasProject = path.join(base, "alias-project");
  fs.mkdirSync(aliasProject);
  git(aliasProject, ["init"]);
  initializeContextRoomProject(aliasProject, { title: "Alias project", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  registerContextHubProject(aliasProject);

  let result = runCli([
    "shared", "connect", `--root=${project}`, `--repository=${first.remote}`, "--shared-project=demo", "--format=json",
  ], env, project);
  assert.equal(result.status, 0, result.stderr);
  result = runCli([
    "shared", "connect", `--root=${aliasProject}`, `--repository=file://${first.remote}`, "--shared-project=demo", "--format=json",
  ], env, aliasProject);
  assert.equal(result.status, 0, result.stderr);
  result = runCli([
    "edit", "create", "Preserve the exact local alias workspace when reopening globally.", `--root=${aliasProject}`, "--format=json",
  ], env, aliasProject);
  assert.equal(result.status, 0, result.stderr);
  const created = JSON.parse(result.stdout).data;
  fs.writeFileSync(path.join(created.editRoot, "projects", "demo", "docs", "README.md"), "# demo\n\nAlias-local proposal.\n", "utf8");

  const opened = openSharedDocumentationProposalByBranch({ proposal: created.proposal.branch });
  assert.equal(opened.sourceRoot, fs.realpathSync(aliasProject));
  assert.equal(opened.editRoot, created.editRoot);
  assert.equal(opened.proposal.repository, first.remote, "the first registered transport stays canonical across aliases");
  result = runCli([
    "docs", "publish", `--change=${opened.changeId}`, "--summary=Publish alias-local proposal", "--format=json",
  ], env, base);
  assert.equal(result.status, 0, result.stderr);
  const published = JSON.parse(result.stdout).data;
  assert.equal(git(first.seed, ["ls-remote", "origin", `refs/heads/${created.proposal.branch}`]).split(/\s+/)[0], published.result.head);
});

test("proposal discovery is canonical, selector-bounded, and fail-closed", (t) => {
  const { first, second } = fixture(t);
  const { branch } = publishFixtureProposal(first, { content: "First repository.\n" });
  publishFixtureProposal(second, { branch, content: "Second repository.\n" });
  registerContextHubSharedRepository(first.remote);
  registerContextHubSharedRepository(`file://${first.remote}`);
  registerContextHubSharedRepository(second.remote);

  let credentialFailure = null;
  try {
    openSharedDocumentationProposalByBranch({ proposal: branch, repository: "https://agent:do-not-leak@example.test/shared.git" });
  } catch (error) {
    credentialFailure = error;
  }
  assert.equal(credentialFailure?.code, "invalid-repository-selector");
  assert.doesNotMatch(JSON.stringify(credentialFailure?.details), /do-not-leak/);

  let queryFailure = null;
  try {
    openSharedDocumentationProposalByBranch({
      proposal: branch,
      repository: "https://example.test/shared.git?token=do-not-leak-query#do-not-leak-fragment",
    });
  } catch (error) {
    queryFailure = error;
  }
  assert.equal(queryFailure?.code, "invalid-repository-selector");
  assert.doesNotMatch(JSON.stringify(queryFailure?.details), /do-not-leak/);

  let ambiguousDiscovery = null;
  try {
    openSharedDocumentationProposalByBranch({ proposal: branch });
  } catch (error) {
    ambiguousDiscovery = error;
  }
  assert.equal(ambiguousDiscovery?.code, "proposal-ambiguous");
  assert.equal(ambiguousDiscovery?.details?.candidates?.length, 2);
  for (const candidate of ambiguousDiscovery.details.candidates) {
    assert.ok(candidate.repository, JSON.stringify(candidate));
    assert.equal(candidate.repositoryIdentity, contextHubRepositoryIdentity(candidate.repository));
  }
  const reusableCandidate = ambiguousDiscovery.details.candidates.find((candidate) => (
    candidate.repositoryIdentity === contextHubRepositoryIdentity(first.remote)
  ));
  assert.ok(reusableCandidate, JSON.stringify(ambiguousDiscovery.details, null, 2));

  const secondRepositoryIdentity = contextHubRepositoryIdentity(second.remote);
  fs.renameSync(second.remote, `${second.remote}.offline`);
  let incompleteDiscovery = null;
  try {
    openSharedDocumentationProposalByBranch({ proposal: branch });
  } catch (error) {
    incompleteDiscovery = error;
  }
  assert.equal(incompleteDiscovery?.code, "proposal-discovery-incomplete");
  assert.equal(incompleteDiscovery?.retryable, true);
  assert.ok(
    incompleteDiscovery?.details?.repositoryErrors?.some((entry) => entry.repository === secondRepositoryIdentity),
    JSON.stringify(incompleteDiscovery?.details, null, 2),
  );

  const opened = openSharedDocumentationProposalByBranch({
    proposal: branch,
    repository: reusableCandidate.repository,
    sharedProject: "demo",
  });
  assert.equal(opened.proposal.branch, branch);
  assert.equal(opened.proposal.projectId, "demo");
  assert.equal(contextHubRepositoryIdentity(opened.proposal.repository), contextHubRepositoryIdentity(first.remote));
  assert.match(opened.changeId, /^change-[a-f0-9]{24}$/);
});

test("proposal discovery spends one global network budget", (t) => {
  const { base } = fixture(t);
  const helperRoot = path.join(base, "git-helpers");
  const helper = path.join(helperRoot, "git-remote-wait");
  fs.mkdirSync(helperRoot, { recursive: true });
  fs.writeFileSync(helper, "#!/bin/sh\ntrap 'exit 0' HUP INT TERM\nsleep 5\n", "utf8");
  fs.chmodSync(helper, 0o755);
  const previousPath = process.env.PATH;
  process.env.PATH = `${helperRoot}${path.delimiter}${previousPath || ""}`;
  t.after(() => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  });

  registerContextHubSharedRepository("wait://first.example/context.git");
  registerContextHubSharedRepository("wait://second.example/context.git");
  const startedAt = Date.now();
  let failure = null;
  try {
    openSharedDocumentationProposalByBranch({ proposal: "proposal/demo/missing", timeoutMs: 250 });
  } catch (error) {
    failure = error;
  }
  const elapsedMs = Date.now() - startedAt;
  assert.equal(failure?.code, "proposal-discovery-incomplete");
  assert.equal(failure?.retryable, true);
  assert.equal(failure?.details?.discoveryBudgetMs, 250);
  assert.equal(failure?.details?.repositoryErrors?.length, 2);
  assert.equal(failure?.details?.repositoryErrors?.[0]?.code, "shared-git-timeout", JSON.stringify(failure?.details, null, 2));
  assert.equal(failure?.details?.repositoryErrors?.[1]?.code, "proposal-discovery-budget-exhausted", JSON.stringify(failure?.details, null, 2));
  assert.ok(elapsedMs < 1_000, `discovery exceeded one bounded deadline (${elapsedMs} ms)`);
});

test("a freshly discovered proposal opens without a second network refresh", (t) => {
  const { base, first } = fixture(t);
  const { branch } = publishFixtureProposal(first, { branch: "proposal/demo/single-refresh" });
  const helperRoot = path.join(base, "single-refresh-helper");
  const helper = path.join(helperRoot, "git-remote-counted");
  const countFile = path.join(base, "remote-helper-count.txt");
  fs.mkdirSync(helperRoot, { recursive: true });
  fs.writeFileSync(helper, `#!/bin/sh
while IFS= read -r command; do
  case "$command" in
    capabilities)
      printf 'connect\\n\\n'
      ;;
    "connect git-upload-pack")
      count=0
      if [ -f "$CONTEXT_ROOM_TEST_REMOTE_COUNT" ]; then count=$(sed -n '1p' "$CONTEXT_ROOM_TEST_REMOTE_COUNT"); fi
      count=$((count + 1))
      printf '%s\\n' "$count" > "$CONTEXT_ROOM_TEST_REMOTE_COUNT"
      if [ "$count" -ge 3 ]; then sleep 5; exit 1; fi
      printf '\\n'
      exec git-upload-pack "$CONTEXT_ROOM_TEST_REMOTE_REPOSITORY"
      ;;
    "option "*)
      printf 'unsupported\\n'
      ;;
    *)
      printf '\\n'
      ;;
  esac
done
`, "utf8");
  fs.chmodSync(helper, 0o755);
  const previous = {
    PATH: process.env.PATH,
    CONTEXT_ROOM_TEST_REMOTE_COUNT: process.env.CONTEXT_ROOM_TEST_REMOTE_COUNT,
    CONTEXT_ROOM_TEST_REMOTE_REPOSITORY: process.env.CONTEXT_ROOM_TEST_REMOTE_REPOSITORY,
  };
  process.env.PATH = `${helperRoot}${path.delimiter}${previous.PATH || ""}`;
  process.env.CONTEXT_ROOM_TEST_REMOTE_COUNT = countFile;
  process.env.CONTEXT_ROOM_TEST_REMOTE_REPOSITORY = first.remote;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  let opened = null;
  let openFailure = null;
  try {
    opened = openSharedDocumentationProposalByBranch({
      proposal: branch,
      repository: "counted://shared.example/context.git",
      projectId: "demo",
      timeoutMs: 1_000,
    });
  } catch (error) {
    openFailure = error;
  }
  assert.equal(openFailure, null, JSON.stringify(openFailure?.details, null, 2));
  assert.equal(opened.proposal.branch, branch);
  assert.equal(Number(fs.readFileSync(countFile, "utf8").trim()), 2, "clone + discovery fetch only; opening must reuse the fresh cache");
});

test("ui open resolves a Hub shared-only project to its canonical project key", async (t) => {
  const { env, first, second, base } = fixture(t);
  registerContextHubSharedRepository(first.remote);
  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room Hub", allowedPaths: [], watchAllow: [] });
  const room = createMemoryServer({ root: hostRoot, registerInHub: false });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => room.server.close(resolve)));
  writeContextHubRuntime({ pid: process.pid, port: room.server.address().port, root: hostRoot });

  const result = await runCliAsync(["ui", "open", "--project=demo", "--view=hub", "--format=json"], env, base);
  assert.equal(result.status, 0, result.stderr);
  const opened = JSON.parse(result.stdout);
  assert.equal(opened.data.status, "open_required");
  const projectKey = new URL(opened.data.openUrl).searchParams.get("project");
  assert.match(projectKey, /^shared:[a-f0-9]{16}:demo$/);
  assert.equal(opened.target.project.id, projectKey);

  registerContextHubSharedRepository(second.remote);
  const ambiguous = await runCliAsync(["ui", "open", "--project=demo", "--view=hub", "--format=json"], env, base);
  assert.equal(ambiguous.status, 5, ambiguous.stderr);
  const ambiguousEnvelope = JSON.parse(ambiguous.stderr);
  assert.equal(ambiguousEnvelope.error.code, "ambiguous-target");
  assert.equal(ambiguousEnvelope.error.details.matchedBy, "alias");
  assert.equal(ambiguousEnvelope.error.details.candidates.length, 2);

  const exactProjectKey = ambiguousEnvelope.error.details.candidates[0].projectKey;
  const exact = await runCliAsync(["ui", "open", `--project=${exactProjectKey}`, "--view=hub", "--format=json"], env, base);
  assert.equal(exact.status, 0, exact.stderr);
  assert.equal(new URL(JSON.parse(exact.stdout).data.openUrl).searchParams.get("project"), exactProjectKey);

  const ambiguousHub = runCli(["hub", "open", "--project=demo", "--format=json"], env, base);
  assert.equal(ambiguousHub.status, 5, ambiguousHub.stderr);
  assert.equal(JSON.parse(ambiguousHub.stderr).error.code, "ambiguous-target");
  const exactHub = runCli(["hub", "open", `--project=${exactProjectKey}`], env, base);
  assert.equal(exactHub.status, 0, exactHub.stderr);
  assert.equal(new URL(exactHub.stdout.trim().replace(/^Context Room Hub: /, "")).searchParams.get("project"), exactProjectKey);
});

test("hub proposals resolves every exact consumer and rejects an ambiguous alias", (t) => {
  const { env, project, first, second, base } = fixture(t);
  const proposal = publishFixtureProposal(first, { branch: "proposal/demo/multi-consumer-cli" });
  const otherProject = path.join(base, "other-consumer");
  fs.mkdirSync(otherProject);
  git(otherProject, ["init"]);
  initializeContextRoomProject(otherProject, { title: "Shared consumer", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  registerContextHubProject(project);
  registerContextHubProject(otherProject);

  for (const consumer of [project, otherProject]) {
    const connected = runCli([
      "shared", "connect", `--root=${consumer}`, `--repository=${first.remote}`, "--shared-project=demo", "--format=json",
    ], env, consumer);
    assert.equal(connected.status, 0, connected.stderr);
  }
  const firstConsumer = registerContextHubProject(project, { title: "Shared consumer" });
  const secondConsumer = registerContextHubProject(otherProject, { title: "Shared consumer" });

  const all = runCli(["hub", "proposals"], env, base);
  assert.equal(all.status, 0, all.stderr);
  const listedProposal = JSON.parse(all.stdout).find((item) => item.branch === proposal.branch);
  assert.ok(listedProposal);
  assert.equal(listedProposal.projectKeys.length, 2);

  for (const consumer of [firstConsumer, secondConsumer]) {
    const filtered = runCli(["hub", "proposals", `--project=${consumer.id}`], env, base);
    assert.equal(filtered.status, 0, filtered.stderr);
    assert.deepEqual(JSON.parse(filtered.stdout).map((item) => item.branch), [proposal.branch]);
  }

  registerContextHubSharedRepository(second.remote);
  const ambiguous = runCli(["hub", "proposals", "--project=demo", "--format=json"], env, base);
  assert.equal(ambiguous.status, 5, ambiguous.stderr);
  const failure = JSON.parse(ambiguous.stderr);
  assert.equal(failure.error.code, "ambiguous-target");
  assert.equal(failure.error.details.matchedBy, "alias");
  assert.equal(failure.error.details.candidates.length, 3);
});

test("Hub and UI opening preserve an exact registered worktree location", async (t) => {
  const { env, project, base } = fixture(t);
  git(project, ["config", "user.name", "Context Room Test"]);
  git(project, ["config", "user.email", "context-room@example.test"]);
  git(project, ["add", "."]);
  git(project, ["commit", "-m", "Initialize exact location fixture"]);
  const worktreeRoot = path.join(base, "project-feature-worktree");
  git(project, ["worktree", "add", "-b", "feature/exact-location", worktreeRoot]);
  initializeContextRoomProject(worktreeRoot, { title: "Exact location project", allowedPaths: ["docs/"], watchAllow: ["docs/"] });

  const main = registerContextHubProject(project, { title: "Exact location project" });
  const feature = registerContextHubProject(worktreeRoot, { title: "Exact location project" });
  registerContextHubProject(project, { title: "Exact location project" });
  assert.notEqual(feature.id, main.id);
  assert.equal(feature.logicalProjectId, main.logicalProjectId);

  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room Hub", allowedPaths: [], watchAllow: [] });
  const room = createMemoryServer({ root: hostRoot, registerInHub: false });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => room.server.close(resolve)));
  writeContextHubRuntime({ pid: process.pid, port: room.server.address().port, root: hostRoot });

  const hub = runCli(["hub", "open", `--project=${feature.id}`], env, base);
  assert.equal(hub.status, 0, hub.stderr);
  assert.equal(new URL(hub.stdout.trim().replace(/^Context Room Hub: /, "")).searchParams.get("project"), feature.id);

  const nestedWorktreeDirectory = path.join(worktreeRoot, "docs");
  fs.mkdirSync(nestedWorktreeDirectory, { recursive: true });
  unregisterContextHubProject(worktreeRoot);
  const bareHubFromWorktree = await runCliAsync(["hub"], env, nestedWorktreeDirectory);
  assert.equal(bareHubFromWorktree.status, 0, bareHubFromWorktree.stderr);
  const focusedUrl = bareHubFromWorktree.stdout.split("\n")[0].replace(/^Context Room Hub: /, "");
  assert.equal(new URL(focusedUrl).searchParams.get("project"), feature.id);

  const unrelated = path.join(base, "unrelated");
  fs.mkdirSync(unrelated);
  const bareGlobalHub = await runCliAsync(["hub"], env, unrelated);
  assert.equal(bareGlobalHub.status, 0, bareGlobalHub.stderr);
  const globalUrl = bareGlobalHub.stdout.split("\n")[0].replace(/^Context Room Hub: /, "");
  assert.equal(new URL(globalUrl).searchParams.has("project"), false);
  assert.equal(fs.existsSync(path.join(unrelated, ".context-room")), false);
  assert.equal(readContextHubRegistry().projects.some((project) => project.root === fs.realpathSync(unrelated)), false);

  const ui = await runCliAsync(["ui", "open", `--location=${feature.id}`, "--view=hub", "--format=json"], env, base);
  assert.equal(ui.status, 0, ui.stderr);
  const opened = JSON.parse(ui.stdout);
  assert.equal(opened.target.location.id, feature.id);
  assert.equal(new URL(opened.data.openUrl).searchParams.get("project"), feature.id);
});
