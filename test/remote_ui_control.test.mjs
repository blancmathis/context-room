import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";
import {
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  publishSharedProposal,
} from "../src/shared_context.mjs";

const humanSecret = "remote-ui-human-secret-with-more-than-32-bytes";
const agentSecret = "remote-ui-agent-secret-with-more-than-32-bytes";
const expectedHost = "context.example.test";
const browserHost = "public.context.example.test";
let tokenSequence = 0;

function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  const makeWritable = (target) => {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) return;
    fs.chmodSync(target, stats.isDirectory() ? 0o700 : 0o600);
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function identity(claims, secret, operations) {
  tokenSequence += 1;
  return signRemoteIdentity({ ...claims, operations }, secret, { jti: `remote-ui-${tokenSequence}` });
}

function humanHeaders(sub, operations = ["view", "review"]) {
  return {
    "content-type": "application/json",
    "x-forwarded-host": expectedHost,
    "x-peerlab-context-identity": identity({ kind: "human", sub, role: "admin" }, humanSecret, operations),
  };
}

function agentHeaders({ sub = "mathis", projectId = "hicharlie", sessionId = "chat-one", operations = ["ui:workspace:list", "ui:workspace:navigate", "ui:workspace:pair"] } = {}) {
  return {
    authorization: `Bearer ${identity({ kind: "agent", sub, projectId, sessionId }, agentSecret, operations)}`,
    "content-type": "application/json",
    "x-forwarded-host": expectedHost,
  };
}

async function startRemoteRoom(t, { fixture = false } = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-ui-"));
  const hostRoot = path.join(base, "host");
  const hicharlieRoot = path.join(base, "hicharlie");
  const peerlabRoot = path.join(base, "peerlab");
  const sharedRepository = path.join(base, "shared.git");
  const seed = path.join(base, "seed");
  const isolatedHome = path.join(base, "home");
  const sharedHome = path.join(isolatedHome, ".context-room", "shared");
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.HOME = isolatedHome;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  fs.mkdirSync(isolatedHome, { recursive: true });
  fs.mkdirSync(hostRoot, { recursive: true });
  fs.mkdirSync(hicharlieRoot, { recursive: true });
  fs.mkdirSync(peerlabRoot, { recursive: true });
  execFileSync("git", ["init", "--bare", "--initial-branch=main", sharedRepository], { stdio: "ignore" });
  execFileSync("git", ["clone", sharedRepository, seed], { stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "remote-ui@example.test"], { cwd: seed });
  execFileSync("git", ["config", "user.name", "Remote UI Test"], { cwd: seed });
  initializeSharedRepository(seed, { name: "Remote UI fixture" });
  fs.writeFileSync(path.join(seed, "projects.json"), `${JSON.stringify({
    version: 1,
    projects: [
      { id: "hicharlie", title: "HiCharlie" },
      { id: "peerlab", title: "Peerlab" },
    ],
  }, null, 2)}\n`, "utf8");
  for (const projectId of ["hicharlie", "peerlab"]) {
    const document = path.join(seed, "projects", projectId, "docs", "README.md");
    fs.mkdirSync(path.dirname(document), { recursive: true });
    fs.writeFileSync(document, `# ${projectId}\n`, "utf8");
  }
  execFileSync("git", ["add", "."], { cwd: seed });
  execFileSync("git", ["commit", "-m", "Initialize Remote UI Shared fixture"], { cwd: seed, stdio: "ignore" });
  execFileSync("git", ["push", "origin", "main"], { cwd: seed, stdio: "ignore" });
  initializeContextRoomProject(hostRoot);
  initializeContextRoomProject(hicharlieRoot);
  initializeContextRoomProject(peerlabRoot);
  connectSharedContext(hicharlieRoot, { repository: sharedRepository, projectId: "hicharlie" });
  connectSharedContext(peerlabRoot, { repository: sharedRepository, projectId: "peerlab" });
  const room = createMemoryServer({
    root: hostRoot,
    remoteAccess: {
      expectedHost,
      browserHost,
      humanSecret,
      agentSecret,
      healthSecret: "remote-ui-health-secret-with-more-than-32-bytes",
      adminSubjects: ["mathis", "florent"],
      projectRoots: { hicharlie: hicharlieRoot, peerlab: peerlabRoot },
      sharedRepositories: [{
        repository: sharedRepository,
        projectIds: ["hicharlie", "peerlab"],
      }],
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (room.server.listening) await new Promise((resolve) => room.server.close(resolve));
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    removeWritableTree(base);
  });
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  return fixture ? {
    origin,
    hicharlieRoot,
    peerlabRoot,
    sharedRepository,
  } : origin;
}

async function register(origin, sub, workspace) {
  const response = await fetch(`${origin}/api/workspaces/register`, {
    method: "POST",
    headers: humanHeaders(sub),
    body: JSON.stringify(workspace),
  });
  assert.equal(response.status, 200);
  return response.json();
}

async function readAvailableSse(response, waitMs = 120) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let value = "";
  const deadline = Date.now() + waitMs;
  try {
    while (Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      const next = await Promise.race([
        reader.read(),
        new Promise((resolve) => setTimeout(() => resolve(null), remaining)),
      ]);
      if (!next || next.done) break;
      value += decoder.decode(next.value, { stream: true });
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return value;
}

async function createPeerlabHostedReview(fixture) {
  const proposal = createSharedProposal(fixture.peerlabRoot, {
    title: "Peerlab hosted review",
    branch: "proposal/peerlab/remote-ui-review",
  });
  execFileSync("git", ["config", "user.email", "remote-ui@example.test"], { cwd: proposal.root });
  execFileSync("git", ["config", "user.name", "Remote UI Test"], { cwd: proposal.root });
  const document = path.join(proposal.root, "projects", "peerlab", "docs", "README.md");
  fs.writeFileSync(document, "# peerlab\n\nHosted review B.\n", "utf8");
  const published = publishSharedProposal(fixture.peerlabRoot, { proposal: proposal.branch });
  const refresh = await fetch(`${fixture.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: "{}",
  });
  assert.equal(refresh.status, 200, await refresh.text());
  const hubResponse = await fetch(`${fixture.origin}/api/context-hub`, { headers: humanHeaders("mathis") });
  assert.equal(hubResponse.status, 200);
  const hub = await hubResponse.json();
  const repositoryId = hub.sharedRepositories?.[0]?.repositoryId || hub.sharedRepositories?.[0]?.id || "";
  assert.ok(repositoryId);
  const reviewResponse = await fetch(`${fixture.origin}/api/context-hub/review`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({
      repositoryId,
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
  });
  const reviewText = await reviewResponse.text();
  assert.equal(reviewResponse.status, 201, reviewText);
  const review = JSON.parse(reviewText);
  assert.match(review.url || "", /^\/reviews\/[A-Za-z0-9_-]+\/$/);
  return { ...review, proposal: proposal.branch, proposalHead: published.head };
}

test("remote workspace listing and commands are isolated by user and project", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", { workspaceId: "workspace-mathis-hc", projectId: "hicharlie", view: "hub", focused: true });
  await register(origin, "florent", { workspaceId: "workspace-florent-hc", projectId: "hicharlie", view: "hub", focused: true });
  await register(origin, "mathis", { workspaceId: "workspace-mathis-peer", projectId: "peerlab", view: "hub", focused: true });

  const listedResponse = await fetch(`${origin}/api/agent/ui/workspaces?all=1`, { headers: agentHeaders() });
  assert.equal(listedResponse.status, 200);
  const listed = await listedResponse.json();
  assert.deepEqual(listed.workspaces.map((workspace) => workspace.workspaceId), ["workspace-mathis-hc"]);
  assert.equal(Object.hasOwn(listed.workspaces[0], "ownerSub"), false);

  const crossUser = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ workspace: "workspace-florent-hc", navigation: { view: "home" } }),
  });
  assert.equal(crossUser.status, 404);

  const crossProject = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "peerlab" }),
    body: JSON.stringify({ workspace: "workspace-mathis-hc", navigation: { view: "home" } }),
  });
  assert.equal(crossProject.status, 404);
});

test("an exact project agent can claim one neutral manual workspace without exposing it cross-project", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", {
    workspaceId: "workspace-manual-global",
    projectId: "internal-context-room-root",
    scopeProjectId: "internal-context-room-root",
    view: "hub",
    focused: true,
  });

  const listedResponse = await fetch(`${origin}/api/agent/ui/workspaces?all=1`, { headers: agentHeaders() });
  assert.equal(listedResponse.status, 200);
  assert.deepEqual((await listedResponse.json()).workspaces.map((workspace) => workspace.workspaceId), ["workspace-manual-global"]);

  const openedResponse = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ workspace: "workspace-manual-global", navigation: { view: "settings" } }),
  });
  assert.equal(openedResponse.status, 403);
  assert.equal((await openedResponse.json()).code, "agent_navigation_scope_denied");

  const allowedResponse = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ workspace: "workspace-manual-global", navigation: { view: "home" } }),
  });
  assert.equal(allowedResponse.status, 200);
  const opened = await allowedResponse.json();
  assert.equal(opened.workspace.projectId, "internal-context-room-root");
  assert.equal(opened.workspace.scopeProjectId, "internal-context-room-root");
  assert.equal(opened.workspace.paired, true);
  assert.equal(opened.workspace.currentSession, true);
  assert.equal(Object.hasOwn(opened.workspace, "pairedProjectId"), false);
  assert.equal(Object.hasOwn(opened.workspace, "sessionId"), false);

  const crossProject = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "peerlab", sessionId: "chat-two" }),
    body: JSON.stringify({ workspace: "workspace-manual-global", navigation: { view: "home" } }),
  });
  assert.equal(crossProject.status, 404);
});

test("remote UI capabilities remain usable for multiple scoped requests during their lifetime", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", { workspaceId: "workspace-reusable-hc", projectId: "hicharlie", view: "hub" });
  const headers = agentHeaders();

  const listed = await fetch(`${origin}/api/agent/ui/workspaces?all=1`, { headers });
  assert.equal(listed.status, 200);
  const opened = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers,
    body: JSON.stringify({ workspace: "workspace-reusable-hc", navigation: { view: "home" } }),
  });
  assert.equal(opened.status, 200);
});

test("remote runtime streams never expose another user's workspace commands", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", { workspaceId: "workspace-stream-mathis", projectId: "hicharlie", view: "hub" });
  await register(origin, "florent", { workspaceId: "workspace-stream-florent", projectId: "hicharlie", view: "hub" });

  const commanded = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ workspace: "workspace-stream-mathis", navigation: { view: "home" } }),
  });
  assert.equal(commanded.status, 200);

  const mathisStream = await fetch(`${origin}/api/runtime-events?workspace=workspace-stream-mathis&since=0`, { headers: humanHeaders("mathis") });
  const florentStream = await fetch(`${origin}/api/runtime-events?workspace=workspace-stream-florent&since=0`, { headers: humanHeaders("florent") });
  const [mathisEvents, florentEvents] = await Promise.all([readAvailableSse(mathisStream), readAvailableSse(florentStream)]);
  assert.match(mathisEvents, /workspace-command/);
  assert.match(mathisEvents, /"view":"home"/);
  assert.doesNotMatch(mathisEvents, /(?:root|worktree|file|folder|path)/i);
  assert.doesNotMatch(florentEvents, /workspace-command/);
});

test("remote workspace lists apply location and text filters", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", { workspaceId: "workspace-filter-one", projectId: "hicharlie", locationId: "worktree-one", label: "Planning", view: "hub" });
  await register(origin, "mathis", { workspaceId: "workspace-filter-two", projectId: "hicharlie", locationId: "worktree-two", label: "Delivery", view: "settings" });

  const response = await fetch(`${origin}/api/agent/ui/workspaces?all=1&location=worktree-two&query=delivery`, { headers: agentHeaders() });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).workspaces.map((workspace) => workspace.workspaceId), ["workspace-filter-two"]);
});

test("remote UI open resolves exact, session, unique, ambiguous, and recent targets safely", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", { workspaceId: "workspace-one-hc", projectId: "hicharlie", view: "hub", focused: false });
  await register(origin, "mathis", { workspaceId: "workspace-two-hc", projectId: "hicharlie", view: "settings", focused: true });

  const ambiguous = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ navigation: { view: "home" } }),
  });
  assert.equal(ambiguous.status, 409);
  assert.equal((await ambiguous.json()).code, "workspace_ambiguous");

  const recent = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ recent: true, navigation: { view: "settings", settingsSection: "project", search: "priority", filters: ["docs/"] } }),
  });
  assert.equal(recent.status, 403);
  assert.equal((await recent.json()).code, "agent_navigation_scope_denied");

  const allowedRecent = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ recent: true, navigation: { view: "home" } }),
  });
  assert.equal(allowedRecent.status, 200);
  const recentBody = await allowedRecent.json();
  assert.equal(recentBody.status, "commanded");
  assert.equal(recentBody.workspace.workspaceId, "workspace-two-hc");
  assert.equal(recentBody.command.view, "home");
  assert.equal(Object.hasOwn(recentBody.command, "settingsSection"), false);
  assert.equal(Object.hasOwn(recentBody.command, "search"), false);
  assert.equal(Object.hasOwn(recentBody.command, "filters"), false);
  assert.equal(Object.hasOwn(recentBody.command, "target"), false);

  const malformedExact = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ workspace: "not valid!", recent: true, navigation: { view: "home" } }),
  });
  assert.equal(malformedExact.status, 400);
  assert.equal((await malformedExact.json()).code, "workspace_id_invalid");

  const exact = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({
      workspace: "workspace-one-hc",
      navigation: {
        view: "proposal",
        project: "hicharlie",
        proposal: "proposal/hicharlie/chat-one",
        file: "projects/hicharlie/docs/PRODUCT.md",
        target: { heading: "Purpose" },
      },
    }),
  });
  assert.equal(exact.status, 403);
  assert.equal((await exact.json()).code, "agent_navigation_scope_denied");
});

test("missing remote workspace returns a one-use pairing link bound to the user, project, and chat", async (t) => {
  const origin = await startRemoteRoom(t);
  const openResponse = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ sessionId: "chat-pair" }),
    body: JSON.stringify({ navigation: { view: "home", project: "hicharlie" } }),
  });
  assert.equal(openResponse.status, 200);
  const opened = await openResponse.json();
  assert.equal(opened.status, "open_required");
  assert.match(opened.openUrl, /^https:\/\/public\.context\.example\.test\//);
  const openUrl = new URL(opened.openUrl);
  const pairToken = new URLSearchParams(openUrl.hash.slice(1)).get("pair");
  assert.ok(pairToken);
  assert.equal(openUrl.searchParams.get("workspace"), opened.workspaceId);
  assert.equal(openUrl.searchParams.get("project"), "hicharlie");

  await register(origin, "mathis", { workspaceId: opened.workspaceId, projectId: "hicharlie", view: "file" });
  const pairedResponse = await fetch(`${origin}/api/workspaces/pair`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId: opened.workspaceId, token: pairToken }),
  });
  assert.equal(pairedResponse.status, 200);
  const paired = await pairedResponse.json();
  assert.equal(paired.workspace.projectId, "hicharlie");
  assert.equal(paired.workspace.paired, true);
  assert.equal(Object.hasOwn(paired.workspace, "sessionId"), false);
  assert.equal(Object.hasOwn(paired.workspace, "pairedProjectId"), false);

  const reloaded = await register(origin, "mathis", { workspaceId: opened.workspaceId, projectId: "hicharlie", view: "file" });
  assert.equal(reloaded.workspace.projectId, "hicharlie");
  assert.equal(reloaded.workspace.paired, true);
  assert.equal(Object.hasOwn(reloaded.workspace, "sessionId"), false);
  assert.equal(Object.hasOwn(reloaded.workspace, "pairedProjectId"), false);

  const sessionListResponse = await fetch(`${origin}/api/agent/ui/workspaces`, {
    headers: agentHeaders({ sessionId: "chat-pair" }),
  });
  assert.equal(sessionListResponse.status, 200);
  assert.deepEqual((await sessionListResponse.json()).workspaces.map((workspace) => workspace.workspaceId), [opened.workspaceId]);

  const replay = await fetch(`${origin}/api/workspaces/pair`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId: opened.workspaceId, token: pairToken }),
  });
  assert.equal(replay.status, 403);
});

test("pairing links reject local navigation metadata before signing it", async (t) => {
  const origin = await startRemoteRoom(t);
  const openResponse = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ sessionId: "chat-bounded" }),
    body: JSON.stringify({
      navigation: {
        view: "file",
        project: "hicharlie",
        file: "projects/hicharlie/docs/" + "a".repeat(2_000) + ".md",
        search: "s".repeat(2_000),
        filters: Array.from({ length: 40 }, (_, index) => `projects/hicharlie/docs/${index}/${"f".repeat(900)}`),
        target: { heading: "h".repeat(2_000) },
      },
    }),
  });
  assert.equal(openResponse.status, 403);
  const denied = await openResponse.json();
  assert.equal(denied.code, "agent_navigation_scope_denied");
  assert.equal(Object.hasOwn(denied, "openUrl"), false);
});

test("pairing refuses another human and ignores forged remote session metadata", async (t) => {
  const origin = await startRemoteRoom(t);
  const openResponse = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ sessionId: "chat-private" }),
    body: JSON.stringify({ navigation: { view: "home" } }),
  });
  const opened = await openResponse.json();
  const pairToken = new URLSearchParams(new URL(opened.openUrl).hash.slice(1)).get("pair");

  const registered = await register(origin, "florent", {
    workspaceId: opened.workspaceId,
    projectId: "hicharlie",
    sessionId: "chat-private",
    pairedProjectId: "hicharlie",
    view: "hub",
  });
  assert.equal(registered.workspace.paired, false);
  assert.equal(registered.workspace.currentSession, false);
  assert.equal(Object.hasOwn(registered.workspace, "sessionId"), false);
  assert.equal(Object.hasOwn(registered.workspace, "pairedProjectId"), false);

  const denied = await fetch(`${origin}/api/workspaces/pair`, {
    method: "POST",
    headers: humanHeaders("florent"),
    body: JSON.stringify({ workspaceId: opened.workspaceId, token: pairToken }),
  });
  assert.equal(denied.status, 403);
});

test("remote UI control rejects project changes and expired pairing tickets", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", { workspaceId: "workspace-project-guard", projectId: "hicharlie", view: "hub" });

  const projectChange = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({
      workspace: "workspace-project-guard",
      navigation: { project: "peerlab", view: "home" },
    }),
  });
  assert.equal(projectChange.status, 403);
  assert.equal((await projectChange.json()).code, "agent_project_scope_denied");

  const expiredTicket = signRemoteIdentity({
    kind: "workspace-pair",
    sub: "mathis",
    projectId: "hicharlie",
    sessionId: "chat-expired",
    workspaceId: "workspace-project-guard",
    operations: ["ui:workspace:pair"],
  }, agentSecret, { now: 1, ttlSeconds: 300, jti: "remote-ui-expired-pair" });
  const expired = await fetch(`${origin}/api/workspaces/pair`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId: "workspace-project-guard", token: expiredTicket }),
  });
  assert.equal(expired.status, 403);
  assert.equal((await expired.json()).code, "remote_identity_expired");
});

test("navigate-only agent capabilities cannot claim an unpaired workspace", async (t) => {
  const origin = await startRemoteRoom(t);
  await register(origin, "mathis", {
    workspaceId: "workspace-navigate-only",
    projectId: "internal-context-room-root",
    scopeProjectId: "internal-context-room-root",
    view: "hub",
  });

  const denied = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ operations: ["ui:workspace:navigate"] }),
    body: JSON.stringify({ workspace: "workspace-navigate-only", navigation: { view: "home" } }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "agent_operation_denied");

  const listed = await fetch(`${origin}/api/workspaces?workspace=workspace-navigate-only`, {
    headers: humanHeaders("mathis"),
  });
  assert.equal(listed.status, 200);
  const workspace = (await listed.json()).workspaces?.[0];
  assert.equal(workspace?.paired, false);
  assert.equal(workspace?.currentSession, false);
});

test("a project A pairing ticket cannot be redeemed from a project B hosted review", async (t) => {
  const fixture = await startRemoteRoom(t, { fixture: true });
  const review = await createPeerlabHostedReview(fixture);
  const openResponse = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "chat-project-a" }),
    body: JSON.stringify({ navigation: { view: "home", project: "hicharlie" } }),
  });
  assert.equal(openResponse.status, 200);
  const opened = await openResponse.json();
  const pairToken = new URLSearchParams(new URL(opened.openUrl).hash.slice(1)).get("pair");
  assert.ok(pairToken);

  const reviewOrigin = `${fixture.origin}${review.url}`;
  const registered = await fetch(new URL("api/workspaces/register", reviewOrigin), {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({
      workspaceId: opened.workspaceId,
      projectId: "hicharlie",
      scopeProjectId: "hicharlie",
      proposal: "private-project-b-proposal-metadata",
      title: "Private project B review",
      view: "proposal",
    }),
  });
  assert.equal(registered.status, 200);
  const registeredWorkspace = (await registered.json()).workspace;
  assert.equal(registeredWorkspace.projectId, "peerlab");
  assert.equal(registeredWorkspace.scopeProjectId, "peerlab");
  assert.equal(registeredWorkspace.paired, false);

  const denied = await fetch(new URL("api/workspaces/pair", reviewOrigin), {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId: opened.workspaceId, token: pairToken }),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).code, "workspace_pair_project_denied");

  const agentList = await fetch(`${fixture.origin}/api/agent/ui/workspaces?all=1`, {
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "chat-project-a" }),
  });
  assert.equal(agentList.status, 200);
  const agentPayload = JSON.stringify(await agentList.json());
  assert.doesNotMatch(agentPayload, /private-project-b-proposal-metadata|Private project B review/);
});

test("reused workspace IDs do not replay another owner generation and still deliver current live commands", async (t) => {
  const origin = await startRemoteRoom(t);
  const workspaceId = "workspace-reused-generation";
  await register(origin, "mathis", { workspaceId, projectId: "hicharlie", view: "hub" });
  const aliceCommand = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ sub: "mathis", projectId: "hicharlie", sessionId: "alice-session" }),
    body: JSON.stringify({ workspace: workspaceId, label: "ALICE_PRIVATE_COMMAND", navigation: { view: "home" } }),
  });
  assert.equal(aliceCommand.status, 200);

  const removed = await fetch(`${origin}/api/workspaces/register`, {
    method: "DELETE",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId }),
  });
  assert.equal(removed.status, 200);
  assert.equal((await removed.json()).removed, true);
  await register(origin, "florent", { workspaceId, projectId: "hicharlie", view: "hub" });
  const bobReplayCommand = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ sub: "florent", projectId: "hicharlie", sessionId: "bob-session" }),
    body: JSON.stringify({ workspace: workspaceId, label: "BOB_REPLAY_COMMAND", navigation: { view: "home" } }),
  });
  assert.equal(bobReplayCommand.status, 200);

  const stream = await fetch(`${origin}/api/runtime-events?workspace=${workspaceId}&since=0`, {
    headers: humanHeaders("florent"),
  });
  assert.equal(stream.status, 200);
  const bobLiveCommand = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ sub: "florent", projectId: "hicharlie", sessionId: "bob-session" }),
    body: JSON.stringify({ workspace: workspaceId, label: "BOB_LIVE_COMMAND", navigation: { view: "hub" } }),
  });
  assert.equal(bobLiveCommand.status, 200);
  const events = await readAvailableSse(stream, 250);
  assert.doesNotMatch(events, /ALICE_PRIVATE_COMMAND|alice-session|mathis/);
  assert.match(events, /BOB_REPLAY_COMMAND/);
  assert.match(events, /BOB_LIVE_COMMAND/);
  assert.doesNotMatch(events, /"(?:ownerSub|generation|sessionId)":/);
});

test("a paired project A workspace cannot retain its binding after registering from a project B review", async (t) => {
  const fixture = await startRemoteRoom(t, { fixture: true });
  const review = await createPeerlabHostedReview(fixture);
  const openResponse = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "paired-project-a" }),
    body: JSON.stringify({ navigation: { view: "home", project: "hicharlie" } }),
  });
  assert.equal(openResponse.status, 200);
  const opened = await openResponse.json();
  const pairToken = new URLSearchParams(new URL(opened.openUrl).hash.slice(1)).get("pair");
  assert.ok(pairToken);
  await register(fixture.origin, "mathis", {
    workspaceId: opened.workspaceId,
    projectId: "hicharlie",
    scopeProjectId: "hicharlie",
    view: "hub",
  });
  const pairedResponse = await fetch(`${fixture.origin}/api/workspaces/pair`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId: opened.workspaceId, token: pairToken }),
  });
  assert.equal(pairedResponse.status, 200);
  assert.equal((await pairedResponse.json()).workspace?.paired, true);

  const projectBMarker = "PRIVATE_PROJECT_B_REVIEW_METADATA";
  const reviewOrigin = `${fixture.origin}${review.url}`;
  const transitioned = await fetch(new URL("api/workspaces/register", reviewOrigin), {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({
      workspaceId: opened.workspaceId,
      projectId: "hicharlie",
      scopeProjectId: "hicharlie",
      proposal: projectBMarker,
      title: projectBMarker,
      view: "proposal",
    }),
  });
  assert.equal([200, 403, 409].includes(transitioned.status), true);
  const transitionPayload = await transitioned.json();
  if (transitioned.status === 200) {
    assert.equal(transitionPayload.workspace?.projectId, "peerlab");
    assert.equal(transitionPayload.workspace?.scopeProjectId, "peerlab");
    assert.equal(transitionPayload.workspace?.paired, false);
    assert.equal(transitionPayload.workspace?.currentSession, false);
  }

  const commanded = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "paired-project-a" }),
    body: JSON.stringify({
      workspace: opened.workspaceId,
      label: "PROJECT_A_COMMAND_MUST_NOT_ENTER_REVIEW_B",
      navigation: { view: "home" },
    }),
  });
  assert.equal(commanded.status, 200);

  const reviewCommand = await fetch(new URL(`api/workspaces/${opened.workspaceId}/command`, reviewOrigin), {
    headers: humanHeaders("mathis"),
  });
  const reviewCommandText = await reviewCommand.text();
  assert.equal([403, 404].includes(reviewCommand.status), true, reviewCommandText);

  const reviewStream = await fetch(new URL(`api/runtime-events?workspace=${opened.workspaceId}&since=0`, reviewOrigin), {
    headers: humanHeaders("mathis"),
  });
  if (reviewStream.status === 200) await reviewStream.body?.cancel().catch(() => {});
  assert.equal([403, 404].includes(reviewStream.status), true);

  const reviewDelete = await fetch(new URL("api/workspaces/register", reviewOrigin), {
    method: "DELETE",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId: opened.workspaceId }),
  });
  const reviewDeleteText = await reviewDelete.text();
  assert.equal([403, 404].includes(reviewDelete.status), true, reviewDeleteText);

  const agentList = await fetch(`${fixture.origin}/api/agent/ui/workspaces?all=1`, {
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "paired-project-a" }),
  });
  assert.equal(agentList.status, 200);
  assert.doesNotMatch(JSON.stringify(await agentList.json()), new RegExp(projectBMarker));
});

test("entering an exact hosted review revokes a command issued before review binding", async (t) => {
  const fixture = await startRemoteRoom(t, { fixture: true });
  const review = await createPeerlabHostedReview(fixture);
  const reviewOrigin = `${fixture.origin}${review.url}`;
  const workspaceId = "workspace-hub-to-exact-review";

  await register(fixture.origin, "mathis", {
    workspaceId,
    projectId: "peerlab",
    scopeProjectId: "peerlab",
    view: "hub",
  });
  const staleWrite = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "peerlab", sessionId: "hub-before-review" }),
    body: JSON.stringify({
      workspace: workspaceId,
      label: "PRE_REVIEW_COMMAND",
      navigation: { view: "home", project: "peerlab" },
    }),
  });
  assert.equal(staleWrite.status, 200, await staleWrite.text());
  const staleRead = await fetch(`${fixture.origin}/api/workspaces/${workspaceId}/command`, {
    headers: humanHeaders("mathis"),
  });
  assert.equal((await staleRead.json()).command?.label, "PRE_REVIEW_COMMAND");

  const bound = await fetch(new URL("api/workspaces/register", reviewOrigin), {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId, view: "proposal" }),
  });
  assert.equal(bound.status, 200, await bound.text());

  const revoked = await fetch(new URL(`api/workspaces/${workspaceId}/command`, reviewOrigin), {
    headers: humanHeaders("mathis"),
  });
  const revokedText = await revoked.text();
  assert.equal(revoked.status, 200, revokedText);
  assert.equal(JSON.parse(revokedText).command, null);

  const exactWrite = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "peerlab", sessionId: "hub-before-review" }),
    body: JSON.stringify({
      workspace: workspaceId,
      label: "EXACT_REVIEW_COMMAND",
      navigation: { view: "proposal", project: "peerlab", proposal: review.proposal },
    }),
  });
  assert.equal(exactWrite.status, 200, await exactWrite.text());
  const exactRead = await fetch(new URL(`api/workspaces/${workspaceId}/command`, reviewOrigin), {
    headers: humanHeaders("mathis"),
  });
  const exactReadText = await exactRead.text();
  assert.equal(exactRead.status, 200, exactReadText);
  assert.equal(JSON.parse(exactReadText).command?.label, "EXACT_REVIEW_COMMAND");
});

test("an SSE subscription opened before pairing receives the legitimate post-pair command", async (t) => {
  const origin = await startRemoteRoom(t);
  const workspaceId = "workspace-stream-before-pair";
  await register(origin, "mathis", {
    workspaceId,
    projectId: "internal-context-room-root",
    scopeProjectId: "internal-context-room-root",
    view: "hub",
  });
  const stream = await fetch(`${origin}/api/runtime-events?workspace=${workspaceId}&since=0`, {
    headers: humanHeaders("mathis"),
  });
  assert.equal(stream.status, 200);

  const commanded = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "post-pair-session" }),
    body: JSON.stringify({ workspace: workspaceId, label: "POST_PAIR_LIVE_COMMAND", navigation: { view: "home" } }),
  });
  assert.equal(commanded.status, 200);
  const commandedPayload = await commanded.json();
  assert.equal(commandedPayload.workspace?.paired, true);
  assert.equal(commandedPayload.command?.label, "POST_PAIR_LIVE_COMMAND");

  const events = await readAvailableSse(stream, 250);
  assert.match(events, /workspace-command/);
  assert.match(events, /POST_PAIR_LIVE_COMMAND/);
  assert.doesNotMatch(events, /"(?:ownerSub|generation|sessionId)":/);
});

test("hosted workspace search cannot use hidden local presence fields as a substring oracle", async (t) => {
  const origin = await startRemoteRoom(t);
  const hiddenMarker = "private-hidden-local-path-marker";
  await register(origin, "mathis", {
    workspaceId: "workspace-hidden-search",
    projectId: "hicharlie",
    label: "Public planning room",
    locationId: `worktree-${hiddenMarker}`,
    folder: `private/${hiddenMarker}`,
    file: `private/${hiddenMarker}/SECRET.md`,
    view: "hub",
  });

  const hiddenQuery = await fetch(`${origin}/api/agent/ui/workspaces?all=1&query=${encodeURIComponent(hiddenMarker)}`, {
    headers: agentHeaders(),
  });
  assert.equal(hiddenQuery.status, 200);
  const hiddenPayload = await hiddenQuery.json();
  assert.deepEqual(hiddenPayload.workspaces, []);
  assert.doesNotMatch(JSON.stringify(hiddenPayload), new RegExp(hiddenMarker));

  const hiddenLocation = await fetch(`${origin}/api/agent/ui/workspaces?all=1&location=${encodeURIComponent(`worktree-${hiddenMarker}`)}`, {
    headers: agentHeaders(),
  });
  assert.equal(hiddenLocation.status, 200);
  const hiddenLocationPayload = await hiddenLocation.json();
  const falseLocation = await fetch(`${origin}/api/agent/ui/workspaces?all=1&location=not-a-real-worktree-location`, {
    headers: agentHeaders(),
  });
  assert.equal(falseLocation.status, 200);
  const falseLocationPayload = await falseLocation.json();
  assert.deepEqual(hiddenLocationPayload.workspaces, falseLocationPayload.workspaces);
  assert.doesNotMatch(JSON.stringify({ hiddenLocationPayload, falseLocationPayload }), new RegExp(hiddenMarker));

  const publicQuery = await fetch(`${origin}/api/agent/ui/workspaces?all=1&query=planning`, {
    headers: agentHeaders(),
  });
  assert.equal(publicQuery.status, 200);
  assert.deepEqual((await publicQuery.json()).workspaces.map((workspace) => workspace.workspaceId), ["workspace-hidden-search"]);
});

test("Last-Event-ID cannot be weakened by a stale since query during SSE reconnect", async (t) => {
  const origin = await startRemoteRoom(t);
  const workspaceId = "workspace-sse-reconnect";
  const replayMarker = "STALE_SSE_COMMAND_MUST_NOT_REPLAY";
  await register(origin, "mathis", { workspaceId, projectId: "hicharlie", view: "hub" });
  const commanded = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders(),
    body: JSON.stringify({ workspace: workspaceId, label: replayMarker, navigation: { view: "home" } }),
  });
  assert.equal(commanded.status, 200);

  const reconnected = await fetch(`${origin}/api/runtime-events?workspace=${workspaceId}&since=0`, {
    headers: { ...humanHeaders("mathis"), "last-event-id": "999" },
  });
  assert.equal(reconnected.status, 200);
  const events = await readAvailableSse(reconnected, 180);
  assert.doesNotMatch(events, new RegExp(replayMarker));
  assert.doesNotMatch(events, /workspace-command/);
});

test("exact hosted review authorities isolate workspaces across heads of the same proposal branch", async (t) => {
  const fixture = await startRemoteRoom(t, { fixture: true });
  const branch = "proposal/hicharlie/remote-ui-authority-scope";
  const proposal = createSharedProposal(fixture.hicharlieRoot, {
    title: "Hosted review authority scope",
    branch,
  });
  execFileSync("git", ["config", "user.email", "remote-ui@example.test"], { cwd: proposal.root });
  execFileSync("git", ["config", "user.name", "Remote UI Test"], { cwd: proposal.root });
  const document = path.join(proposal.root, "projects", "hicharlie", "docs", "README.md");

  const publishAndOpenReview = async (content, description = "") => {
    fs.writeFileSync(document, content, "utf8");
    const published = publishSharedProposal(fixture.hicharlieRoot, {
      proposal: branch,
      ...(description ? { description } : {}),
    });
    const refresh = await fetch(`${fixture.origin}/api/context-hub/refresh`, {
      method: "POST",
      headers: humanHeaders("mathis"),
      body: "{}",
    });
    assert.equal(refresh.status, 200, await refresh.text());
    const hubResponse = await fetch(`${fixture.origin}/api/context-hub`, { headers: humanHeaders("mathis") });
    assert.equal(hubResponse.status, 200);
    const hub = await hubResponse.json();
    const repositoryId = hub.sharedRepositories?.[0]?.repositoryId || hub.sharedRepositories?.[0]?.id || "";
    assert.ok(repositoryId);
    const reviewResponse = await fetch(`${fixture.origin}/api/context-hub/review`, {
      method: "POST",
      headers: humanHeaders("mathis"),
      body: JSON.stringify({ repositoryId, proposal: branch, expectedHead: published.head }),
    });
    const reviewText = await reviewResponse.text();
    assert.equal(reviewResponse.status, 201, reviewText);
    const review = JSON.parse(reviewText);
    assert.match(review.url || "", /^\/reviews\/[A-Za-z0-9_-]+\/$/);
    return { published, review, origin: `${fixture.origin}${review.url}` };
  };

  const first = await publishAndOpenReview("# hicharlie\n\nExact head one.\n");
  const workspaceId = "workspace-review-authority-scope";
  const registered = await fetch(new URL("api/workspaces/register", first.origin), {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId, view: "proposal" }),
  });
  assert.equal(registered.status, 200, await registered.text());
  const initialCommand = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "authority-one" }),
    body: JSON.stringify({ workspace: workspaceId, label: "REVIEW_ONE_INITIAL_COMMAND", navigation: { view: "home" } }),
  });
  assert.equal(initialCommand.status, 200, await initialCommand.text());

  const second = await publishAndOpenReview("# hicharlie\n\nExact head two.\n", "Publish a second exact review head");
  assert.notEqual(first.published.head, second.published.head);
  assert.notEqual(first.review.url, second.review.url);

  const secondCommand = await fetch(new URL(`api/workspaces/${workspaceId}/command`, second.origin), {
    headers: humanHeaders("mathis"),
  });
  const secondStream = await fetch(new URL(`api/runtime-events?workspace=${workspaceId}&since=0`, second.origin), {
    headers: humanHeaders("mathis"),
  });
  if (secondStream.status === 200) await secondStream.body?.cancel().catch(() => {});
  const secondDelete = await fetch(new URL("api/workspaces/register", second.origin), {
    method: "DELETE",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId }),
  });

  const firstStillCommands = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "authority-one" }),
    body: JSON.stringify({ workspace: workspaceId, label: "REVIEW_ONE_STILL_FUNCTIONAL", navigation: { view: "hub" } }),
  });
  const firstCommand = await fetch(new URL(`api/workspaces/${workspaceId}/command`, first.origin), {
    headers: humanHeaders("mathis"),
  });
  const firstCommandBody = await firstCommand.json();

  assert.deepEqual({
    secondCommandDenied: [403, 404].includes(secondCommand.status),
    secondStreamDenied: [403, 404].includes(secondStream.status),
    secondDeleteDenied: [403, 404].includes(secondDelete.status),
    firstAgentCommanded: firstStillCommands.status === 200,
    firstCommandReadable: firstCommand.status === 200 && firstCommandBody.command?.label === "REVIEW_ONE_STILL_FUNCTIONAL",
  }, {
    secondCommandDenied: true,
    secondStreamDenied: true,
    secondDeleteDenied: true,
    firstAgentCommanded: true,
    firstCommandReadable: true,
  });
});

test("hosted hub registration cannot forge an exact review authority binding", async (t) => {
  const fixture = await startRemoteRoom(t, { fixture: true });
  const branch = "proposal/hicharlie/remote-ui-forged-authority";
  const proposal = createSharedProposal(fixture.hicharlieRoot, {
    title: "Hosted review forged authority",
    branch,
  });
  execFileSync("git", ["config", "user.email", "remote-ui@example.test"], { cwd: proposal.root });
  execFileSync("git", ["config", "user.name", "Remote UI Test"], { cwd: proposal.root });
  const document = path.join(proposal.root, "projects", "hicharlie", "docs", "README.md");

  const publishAndOpenReview = async (content, description = "") => {
    fs.writeFileSync(document, content, "utf8");
    const published = publishSharedProposal(fixture.hicharlieRoot, {
      proposal: branch,
      ...(description ? { description } : {}),
    });
    const refresh = await fetch(`${fixture.origin}/api/context-hub/refresh`, {
      method: "POST",
      headers: humanHeaders("mathis"),
      body: "{}",
    });
    assert.equal(refresh.status, 200, await refresh.text());
    const hubResponse = await fetch(`${fixture.origin}/api/context-hub`, { headers: humanHeaders("mathis") });
    assert.equal(hubResponse.status, 200);
    const hub = await hubResponse.json();
    const repositoryId = hub.sharedRepositories?.[0]?.repositoryId || hub.sharedRepositories?.[0]?.id || "";
    assert.ok(repositoryId);
    const reviewResponse = await fetch(`${fixture.origin}/api/context-hub/review`, {
      method: "POST",
      headers: humanHeaders("mathis"),
      body: JSON.stringify({ repositoryId, proposal: branch, expectedHead: published.head }),
    });
    const reviewText = await reviewResponse.text();
    assert.equal(reviewResponse.status, 201, reviewText);
    const review = JSON.parse(reviewText);
    assert.match(review.url || "", /^\/reviews\/[A-Za-z0-9_-]+\/$/);
    return { published, review, origin: `${fixture.origin}${review.url}` };
  };

  const first = await publishAndOpenReview("# hicharlie\n\nForged authority head one.\n");
  const workspaceId = "workspace-review-forged-authority";
  const registered = await fetch(new URL("api/workspaces/register", first.origin), {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId, view: "proposal" }),
  });
  assert.equal(registered.status, 200, await registered.text());
  const initialCommand = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "forged-authority-one" }),
    body: JSON.stringify({ workspace: workspaceId, label: "FORGED_AUTHORITY_INITIAL_COMMAND", navigation: { view: "home" } }),
  });
  assert.equal(initialCommand.status, 200, await initialCommand.text());

  const second = await publishAndOpenReview("# hicharlie\n\nForged authority head two.\n", "Publish the forged authority target head");
  const secondAuthorityId = second.review.url.match(/^\/reviews\/([^/]+)\/$/)?.[1] || "";
  assert.match(secondAuthorityId, /^[a-f0-9-]{36}$/i);
  assert.notEqual(first.published.head, second.published.head);

  const forgedRegistration = await fetch(`${fixture.origin}/api/workspaces/register`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({
      workspaceId,
      projectId: "hicharlie",
      scopeProjectId: "hicharlie",
      proposal: branch,
      reviewAuthorityId: secondAuthorityId,
      reviewProposalHead: second.published.head,
      view: "hub",
    }),
  });
  const forgedRegistrationText = await forgedRegistration.text();
  assert.equal(forgedRegistration.status, 200, forgedRegistrationText);
  assert.doesNotMatch(forgedRegistrationText, /reviewAuthorityId|reviewProposalHead/);
  assert.doesNotMatch(forgedRegistrationText, new RegExp(`${secondAuthorityId}|${second.published.head}`));

  const publicHubList = await fetch(`${fixture.origin}/api/workspaces?workspace=${workspaceId}`, {
    headers: humanHeaders("mathis"),
  });
  assert.equal(publicHubList.status, 200);
  const publicHubText = await publicHubList.text();
  assert.doesNotMatch(publicHubText, /reviewAuthorityId|reviewProposalHead/);
  assert.doesNotMatch(publicHubText, new RegExp(`${secondAuthorityId}|${second.published.head}`));

  const publicAgentList = await fetch(`${fixture.origin}/api/agent/ui/workspaces?all=1`, {
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "forged-authority-one" }),
  });
  assert.equal(publicAgentList.status, 200);
  const publicAgentText = await publicAgentList.text();
  assert.doesNotMatch(publicAgentText, /reviewAuthorityId|reviewProposalHead/);
  assert.doesNotMatch(publicAgentText, new RegExp(`${secondAuthorityId}|${second.published.head}`));

  const secondList = await fetch(new URL(`api/workspaces?workspace=${workspaceId}`, second.origin), {
    headers: humanHeaders("mathis"),
  });
  assert.equal(secondList.status, 200);
  assert.deepEqual((await secondList.json()).workspaces, []);
  const secondCommand = await fetch(new URL(`api/workspaces/${workspaceId}/command`, second.origin), {
    headers: humanHeaders("mathis"),
  });
  const secondStream = await fetch(new URL(`api/runtime-events?workspace=${workspaceId}&since=0`, second.origin), {
    headers: humanHeaders("mathis"),
  });
  if (secondStream.status === 200) await secondStream.body?.cancel().catch(() => {});
  const secondRegister = await fetch(new URL("api/workspaces/register", second.origin), {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId, view: "proposal" }),
  });
  const secondDelete = await fetch(new URL("api/workspaces/register", second.origin), {
    method: "DELETE",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId }),
  });

  const firstStream = await fetch(new URL(`api/runtime-events?workspace=${workspaceId}&since=0`, first.origin), {
    headers: humanHeaders("mathis"),
  });
  assert.equal(firstStream.status, 200);
  const firstStillCommands = await fetch(`${fixture.origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ projectId: "hicharlie", sessionId: "forged-authority-one" }),
    body: JSON.stringify({ workspace: workspaceId, label: "FORGED_AUTHORITY_R1_STILL_FUNCTIONAL", navigation: { view: "hub" } }),
  });
  const firstEvents = await readAvailableSse(firstStream, 250);
  assert.match(firstEvents, /FORGED_AUTHORITY_R1_STILL_FUNCTIONAL/);
  assert.doesNotMatch(firstEvents, /reviewAuthorityId|reviewProposalHead/);
  assert.doesNotMatch(firstEvents, new RegExp(`${secondAuthorityId}|${second.published.head}`));
  const firstCommand = await fetch(new URL(`api/workspaces/${workspaceId}/command`, first.origin), {
    headers: humanHeaders("mathis"),
  });
  const firstCommandBody = await firstCommand.json();

  assert.deepEqual({
    secondCommandDenied: [403, 404].includes(secondCommand.status),
    secondStreamDenied: [403, 404].includes(secondStream.status),
    secondRegisterDenied: [403, 404].includes(secondRegister.status),
    secondDeleteDenied: [403, 404].includes(secondDelete.status),
    firstAgentCommanded: firstStillCommands.status === 200,
    firstCommandReadable: firstCommand.status === 200 && firstCommandBody.command?.label === "FORGED_AUTHORITY_R1_STILL_FUNCTIONAL",
  }, {
    secondCommandDenied: true,
    secondStreamDenied: true,
    secondRegisterDenied: true,
    secondDeleteDenied: true,
    firstAgentCommanded: true,
    firstCommandReadable: true,
  });
});
