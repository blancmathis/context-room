import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";
import { createVerifiedAcceptanceFlashStore } from "../src/review_authority.mjs";

const secret = "remote-server-test-secret-with-more-than-32-bytes";

async function listen(room) {
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${room.server.address().port}`;
}

test("local mode remains loopback-only and needs no signed identity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-local-"));
  initializeContextRoomProject(root);
  const room = createMemoryServer({ root });
  t.after(() => room.server.close());
  const origin = await listen(room);
  const response = await fetch(`${origin}/api/health`);
  assert.equal(response.status, 200);
});

test("an expired remote review page returns a canonical Context Room recovery link", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-expired-review-"));
  initializeContextRoomProject(root);
  const room = createMemoryServer({
    root,
    remoteAccess: {
      expectedHost: "context.qm.peerlab.fr",
      humanSecret: secret,
      agentSecret: `${secret}-agent`,
      healthSecret: `${secret}-health`,
      adminSubjects: ["mathis", "florent"],
      projectRoots: {},
    },
  });
  t.after(() => room.server.close());
  const origin = await listen(room);
  const returnTo = new URL("https://context.qm.peerlab.fr/");
  returnTo.searchParams.set("hub", "1");
  returnTo.searchParams.set("workspace", "workspace-review-owner");
  returnTo.searchParams.set("project", "shared:hicharlie");
  returnTo.searchParams.set("view", "proposal");
  returnTo.searchParams.set("proposal", "proposal/global/stale");
  returnTo.searchParams.set("explorer", "collapsed");

  const pageUrl = new URL(`${origin}/reviews/expired-review/`);
  pageUrl.searchParams.set("returnTo", returnTo.toString());
  pageUrl.searchParams.set("workspace", "wrong-workspace");
  pageUrl.searchParams.set("view", "hub");
  const response = await fetch(pageUrl, {
    headers: { "x-forwarded-host": "context.qm.peerlab.fr", accept: "text/html" },
  });

  assert.equal(response.status, 404);
  assert.match(response.headers.get("content-type") || "", /^text\/html/);
  const html = await response.text();
  assert.match(html, /Review unavailable/);
  assert.match(html, /Return to Context Room/);
  assert.match(html, /workspace=workspace-review-owner/);
  assert.match(html, /project=shared%3Ahicharlie/);
  assert.match(html, /view=hub/);
  assert.match(html, /explorer=collapsed/);
  assert.doesNotMatch(html, /proposal%2Fglobal%2Fstale/);

  const apiResponse = await fetch(`${origin}/reviews/expired-review/api/context`, {
    headers: { "x-forwarded-host": "context.qm.peerlab.fr", accept: "application/json" },
  });
  assert.equal(apiResponse.status, 404);
  assert.match(apiResponse.headers.get("content-type") || "", /^application\/json/);
  assert.equal((await apiResponse.json()).code, "remote_review_not_found");
});

test("production split keeps the proxy host trusted while browser-facing links stay on QM", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-split-host-"));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-split-host-project-"));
  initializeContextRoomProject(root);
  initializeContextRoomProject(projectRoot);
  const expectedHost = "context.peerlab.fr";
  const browserHost = "context.qm.peerlab.fr";
  const agentSecret = `${secret}-agent`;
  const room = createMemoryServer({
    root,
    remoteAccess: {
      expectedHost,
      browserHost,
      humanSecret: secret,
      agentSecret,
      healthSecret: `${secret}-health`,
      adminSubjects: ["mathis", "florent"],
      projectRoots: { hicharlie: projectRoot },
    },
  });
  t.after(() => room.server.close());
  const origin = await listen(room);
  const agentIdentity = (jti) => signRemoteIdentity({
    kind: "agent",
    sub: "mathis",
    projectId: "hicharlie",
    sessionId: "split-host-test",
    operations: ["ui:workspace:navigate", "ui:workspace:pair"],
  }, agentSecret, { jti });

  const openResponse = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentIdentity("split-host-open")}`,
      "content-type": "application/json",
      "x-forwarded-host": expectedHost,
    },
    body: JSON.stringify({ navigation: { project: "hicharlie", view: "hub" } }),
  });
  const opened = await openResponse.json();
  assert.equal(openResponse.status, 200, JSON.stringify(opened));
  assert.equal(opened.status, "open_required");
  assert.equal(new URL(opened.openUrl).host, browserHost);

  const browserHostRequest = await fetch(`${origin}/api/agent/ui/open`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${agentIdentity("split-host-browser-denied")}`,
      "content-type": "application/json",
      "x-forwarded-host": browserHost,
    },
    body: JSON.stringify({ navigation: { project: "hicharlie", view: "hub" } }),
  });
  assert.equal(browserHostRequest.status, 403);
  assert.equal((await browserHostRequest.json()).code, "remote_host_denied");

  const returnTo = new URL(`https://${browserHost}/`);
  returnTo.searchParams.set("hub", "1");
  returnTo.searchParams.set("workspace", "workspace-split-host");
  returnTo.searchParams.set("project", "shared:hicharlie");
  returnTo.searchParams.set("view", "proposal");
  returnTo.searchParams.set("proposal", "proposal/hicharlie/stale");
  const unavailableUrl = new URL(`${origin}/reviews/no-longer-present/`);
  unavailableUrl.searchParams.set("returnTo", returnTo.toString());
  const unavailable = await fetch(unavailableUrl, {
    headers: { "x-forwarded-host": expectedHost, accept: "text/html" },
  });
  assert.equal(unavailable.status, 404);
  const html = await unavailable.text();
  const recoveryHref = /href="([^"]+)"[^>]*>Return to Context Room/.exec(html)?.[1]?.replaceAll("&amp;", "&");
  assert.ok(recoveryHref);
  const recoveryUrl = new URL(recoveryHref, `https://${browserHost}/`);
  assert.equal(recoveryUrl.host, browserHost);
  assert.equal(recoveryUrl.searchParams.get("workspace"), "workspace-split-host");
  assert.equal(recoveryUrl.searchParams.get("project"), "shared:hicharlie");
  assert.equal(recoveryUrl.searchParams.get("view"), "hub");
  assert.equal(recoveryUrl.searchParams.has("proposal"), false);

  const wrongHostUnavailable = await fetch(unavailableUrl, {
    headers: { "x-forwarded-host": browserHost, accept: "text/html" },
  });
  assert.equal(wrongHostUnavailable.status, 403);
  assert.equal((await wrongHostUnavailable.json()).code, "remote_host_denied");
});

test("remote mode rejects unsigned, expired, replayed, and non-admin requests", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-"));
  initializeContextRoomProject(root);
  const room = createMemoryServer({
    root,
    remoteAccess: {
      expectedHost: "context.qm.peerlab.fr",
      humanSecret: secret,
      agentSecret: `${secret}-agent`,
      healthSecret: `${secret}-health`,
      adminSubjects: ["mathis", "florent"],
      projectRoots: {},
    },
  });
  t.after(() => room.server.close());
  const origin = await listen(room);
  const headers = { "x-forwarded-host": "context.qm.peerlab.fr" };

  assert.equal((await fetch(`${origin}/api/health`, { headers })).status, 403);

  const token = signRemoteIdentity({ kind: "human", sub: "mathis", role: "admin", operations: ["view"] }, secret, { jti: "request-1" });
  const authorized = { ...headers, "x-peerlab-context-identity": token };
  assert.equal((await fetch(`${origin}/api/health`, { headers: authorized })).status, 200);
  assert.equal((await fetch(`${origin}/api/health`, { headers: authorized })).status, 403);

  const nonAdmin = signRemoteIdentity({ kind: "human", sub: "member", role: "member", operations: ["view"] }, secret, { jti: "request-2" });
  assert.equal((await fetch(`${origin}/api/health`, { headers: { ...headers, "x-peerlab-context-identity": nonAdmin } })).status, 403);

  const expired = signRemoteIdentity({ kind: "human", sub: "mathis", role: "admin", operations: ["view"] }, secret, { now: 1, ttlSeconds: 1, jti: "request-3" });
  assert.equal((await fetch(`${origin}/api/health`, { headers: { ...headers, "x-peerlab-context-identity": expired } })).status, 403);
});

test("remote Hub consumes a verified acceptance flash once through human review authority", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-flash-"));
  initializeContextRoomProject(root);
  const verifiedAcceptanceFlashes = createVerifiedAcceptanceFlashStore();
  const issued = verifiedAcceptanceFlashes.issue({
    outcome: "merge",
    commit: "0123456789abcdef0123456789abcdef01234567",
    hubRefresh: { status: "pending" },
  });
  const room = createMemoryServer({
    root,
    verifiedAcceptanceFlashes,
    remoteAccess: {
      expectedHost: "context.qm.peerlab.fr",
      humanSecret: secret,
      agentSecret: `${secret}-agent`,
      healthSecret: `${secret}-health`,
      adminSubjects: ["mathis", "florent"],
      projectRoots: {},
    },
  });
  t.after(() => {
    room.server.close();
    verifiedAcceptanceFlashes.clear();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const origin = await listen(room);
  const identity = (jti) => signRemoteIdentity({
    kind: "human",
    sub: "mathis",
    role: "admin",
    operations: ["review"],
  }, secret, { jti });
  const consume = (jti) => fetch(`${origin}/api/context-hub/flash`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-host": "context.qm.peerlab.fr",
      "x-peerlab-context-identity": identity(jti),
    },
    body: JSON.stringify({ token: issued.token }),
  });

  const response = await consume("remote-flash-consume");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    outcome: "merge",
    commit: "0123456789abcdef0123456789abcdef01234567",
    hubRefresh: { status: "pending" },
  });
  const replay = await consume("remote-flash-replay");
  assert.equal(replay.status, 404);
  assert.equal((await replay.json()).code, "verified_acceptance_flash_invalid");
});
