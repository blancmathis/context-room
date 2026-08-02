import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";

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
