import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";

const humanSecret = "remote-ui-human-secret-with-more-than-32-bytes";
const agentSecret = "remote-ui-agent-secret-with-more-than-32-bytes";
const expectedHost = "context.example.test";
const browserHost = "public.context.example.test";
let tokenSequence = 0;

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

async function startRemoteRoom(t) {
  const hostRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-ui-host-"));
  const hicharlieRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-ui-hicharlie-"));
  const peerlabRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-ui-peerlab-"));
  initializeContextRoomProject(hostRoot);
  initializeContextRoomProject(hicharlieRoot);
  initializeContextRoomProject(peerlabRoot);
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
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => room.server.close(resolve)));
  return `http://127.0.0.1:${room.server.address().port}`;
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
    body: JSON.stringify({ workspace: "workspace-stream-mathis", navigation: { view: "file", file: "projects/hicharlie/docs/private.md" } }),
  });
  assert.equal(commanded.status, 200);

  const mathisStream = await fetch(`${origin}/api/runtime-events?workspace=workspace-stream-mathis&since=0`, { headers: humanHeaders("mathis") });
  const florentStream = await fetch(`${origin}/api/runtime-events?workspace=workspace-stream-florent&since=0`, { headers: humanHeaders("florent") });
  const [mathisEvents, florentEvents] = await Promise.all([readAvailableSse(mathisStream), readAvailableSse(florentStream)]);
  assert.match(mathisEvents, /workspace-command/);
  assert.match(mathisEvents, /private\.md/);
  assert.doesNotMatch(florentEvents, /workspace-command/);
  assert.doesNotMatch(florentEvents, /private\.md/);
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
  assert.equal(recent.status, 200);
  const recentBody = await recent.json();
  assert.equal(recentBody.status, "commanded");
  assert.equal(recentBody.workspace.workspaceId, "workspace-two-hc");
  assert.equal(recentBody.command.settingsSection, "project");
  assert.equal(recentBody.command.search, "priority");
  assert.deepEqual(recentBody.command.filters, ["docs/"]);
  assert.equal(recentBody.command.target, null);

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
  assert.equal(exact.status, 200);
  const exactBody = await exact.json();
  assert.equal(exactBody.workspace.workspaceId, "workspace-one-hc");
  assert.equal(exactBody.command.projectId, "hicharlie");
  assert.equal(exactBody.command.proposal, "proposal/hicharlie/chat-one");
  assert.equal(exactBody.command.path, "projects/hicharlie/docs/PRODUCT.md");
  assert.deepEqual(exactBody.command.target, { type: "heading", value: "Purpose" });
});

test("missing remote workspace returns a one-use pairing link bound to the user, project, and chat", async (t) => {
  const origin = await startRemoteRoom(t);
  const openResponse = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: agentHeaders({ sessionId: "chat-pair" }),
    body: JSON.stringify({ navigation: { view: "file", project: "hicharlie", file: "projects/hicharlie/docs/PRODUCT.md" } }),
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
  assert.equal(paired.workspace.sessionId, "chat-pair");
  assert.equal(paired.workspace.pairedProjectId, "hicharlie");

  const reloaded = await register(origin, "mathis", { workspaceId: opened.workspaceId, projectId: "hicharlie", view: "file" });
  assert.equal(reloaded.workspace.sessionId, "chat-pair");
  assert.equal(reloaded.workspace.pairedProjectId, "hicharlie");

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

test("pairing links bound navigation metadata before signing it", async (t) => {
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
  assert.equal(openResponse.status, 200);
  const opened = await openResponse.json();
  const pairToken = new URLSearchParams(new URL(opened.openUrl).hash.slice(1)).get("pair");
  assert.ok(pairToken);
  assert.ok(Buffer.byteLength(pairToken, "utf8") < 16_384);

  await register(origin, "mathis", { workspaceId: opened.workspaceId, projectId: "hicharlie", view: "hub" });
  const pairedResponse = await fetch(`${origin}/api/workspaces/pair`, {
    method: "POST",
    headers: humanHeaders("mathis"),
    body: JSON.stringify({ workspaceId: opened.workspaceId, token: pairToken }),
  });
  assert.equal(pairedResponse.status, 200);
  const paired = await pairedResponse.json();
  assert.equal(paired.command.search.length, 300);
  assert.equal(paired.command.filters.length, 10);
  assert.ok(paired.command.filters.every((filter) => filter.length <= 300));
  assert.equal(paired.command.target.type, "heading");
  assert.equal(paired.command.target.value.length, 500);
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
  assert.equal(registered.workspace.sessionId, "");
  assert.equal(registered.workspace.pairedProjectId, "");

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
