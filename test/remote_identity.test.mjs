import assert from "node:assert/strict";
import test from "node:test";

import {
  createReplayStore,
  signRemoteIdentity,
  verifyRemoteIdentity,
} from "../src/remote_identity.mjs";

const secret = "test-secret-that-is-long-enough-for-hmac-verification";

test("remote identity accepts one fresh signed administrator request", () => {
  const now = 1_800_000_000;
  const token = signRemoteIdentity({
    kind: "human",
    sub: "mathis",
    email: "mathis@example.test",
    role: "admin",
    operations: ["review", "accept"],
  }, secret, { now, ttlSeconds: 30, jti: "human-request-1" });
  const replayStore = createReplayStore();

  const identity = verifyRemoteIdentity(token, secret, {
    now,
    audience: "context-room",
    kind: "human",
    operation: "accept",
    replayStore,
  });

  assert.equal(identity.sub, "mathis");
  assert.equal(identity.role, "admin");
  assert.throws(() => verifyRemoteIdentity(token, secret, {
    now,
    audience: "context-room",
    kind: "human",
    operation: "accept",
    replayStore,
  }), (error) => error.code === "remote_identity_replayed" && error.statusCode === 403);
});

test("remote identity rejects expired, tampered, wrong-kind, and unauthorized tokens", () => {
  const token = signRemoteIdentity({
    kind: "agent",
    sub: "mathis",
    role: "admin",
    projectId: "hicharlie",
    scopeId: "team-hicharlie",
    sessionId: "thread-123",
    operations: ["accepted:read", "proposal:write"],
  }, secret, { now: 1_800_000_000, ttlSeconds: 600, jti: "agent-request-1" });

  assert.throws(() => verifyRemoteIdentity(token, secret, { now: 1_800_000_601 }), (error) => error.code === "remote_identity_expired");
  assert.throws(() => verifyRemoteIdentity(`${token.slice(0, -1)}x`, secret, { now: 1_800_000_001 }), (error) => error.code === "remote_identity_invalid");
  assert.throws(() => verifyRemoteIdentity(token, secret, { now: 1_800_000_001, kind: "human" }), (error) => error.code === "remote_identity_kind_mismatch");
  assert.throws(() => verifyRemoteIdentity(token, secret, { now: 1_800_000_001, operation: "proposal:accept" }), (error) => error.code === "remote_identity_operation_denied");
});
