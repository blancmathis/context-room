import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";

const REMOTE_HOST = "context.qm.peerlab.fr";
const HUMAN_SECRET = "remote-http-human-secret-with-more-than-32-bytes";
const AGENT_SECRET = "remote-http-agent-secret-with-more-than-32-bytes";

async function setupRemoteRoom(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-http-"));
  initializeContextRoomProject(root);
  const room = createMemoryServer({
    root,
    remoteAccess: {
      expectedHost: REMOTE_HOST,
      humanSecret: HUMAN_SECRET,
      agentSecret: AGENT_SECRET,
      adminSubjects: ["transport-owner"],
      projectRoots: {},
      sharedRepositories: [],
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (room.server.listening) await new Promise((resolve) => room.server.close(resolve));
    await room.waitForShutdown();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return room;
}

function withDeadline(promise, timeoutMs, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

async function rawExchange(port, request) {
  const socket = net.createConnection({ host: "127.0.0.1", port });
  socket.setEncoding("utf8");
  let response = "";
  const headersReceived = new Promise((resolve, reject) => {
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.includes("\r\n\r\n")) resolve();
    });
    socket.once("error", reject);
  });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  socket.write(request);
  await withDeadline(headersReceived, 1_000, "Hosted rejection did not return response headers");
  await withDeadline(closed, 1_000, "Hosted rejection left an unread request socket open");
  return response;
}

function signedHumanIdentity(jti, operations = ["review"]) {
  return signRemoteIdentity({
    kind: "human",
    sub: "transport-owner",
    role: "admin",
    operations,
  }, HUMAN_SECRET, { jti });
}

test("Hosted rejects unread unauthenticated bodies and closes their transport", async (t) => {
  const room = await setupRemoteRoom(t);
  const port = room.server.address().port;
  const common = [
    "POST /api/context-hub/flash HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `X-Forwarded-Host: ${REMOTE_HOST}`,
    "X-Peerlab-Context-Identity: invalid",
    "Content-Type: application/json",
    "Connection: keep-alive",
  ];
  const requests = [
    [...common, "Content-Length: 100000000", "", ""].join("\r\n"),
    [...common, "Transfer-Encoding: chunked", "", "1\r\n{"].join("\r\n"),
    [...common, "Content-Length: 100000000", "Expect: 100-continue", "", ""].join("\r\n"),
    [...common, "Content-Length: 64", "", "{"].join("\r\n"),
  ];

  for (const request of requests) {
    const response = await rawExchange(port, request);
    assert.match(response, /^HTTP\/1\.1 403 /);
    assert.match(response, /\r\nconnection: close\r\n/i);
    assert.doesNotMatch(response, /^HTTP\/1\.1 100 Continue/m);
  }

  const boundedDenied = await fetch(`http://127.0.0.1:${port}/api/settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-host": REMOTE_HOST,
    },
    body: JSON.stringify({ bounded: true }),
  });
  assert.equal(boundedDenied.status, 404);
  assert.equal((await boundedDenied.json()).code, "remote_operation_unavailable");
  assert.notEqual(boundedDenied.headers.get("connection"), "close");
});

test("Hosted authenticates Expect requests before accepting a bounded body", async (t) => {
  const room = await setupRemoteRoom(t);
  const port = room.server.address().port;
  const oversized = [
    "POST /api/context-hub/flash HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `X-Forwarded-Host: ${REMOTE_HOST}`,
    `X-Peerlab-Context-Identity: ${signedHumanIdentity("transport-expect-oversized")}`,
    "Content-Type: application/json",
    "Content-Length: 100000000",
    "Expect: 100-continue",
    "Connection: keep-alive",
    "",
    "",
  ].join("\r\n");
  const oversizedResponse = await rawExchange(port, oversized);
  assert.match(oversizedResponse, /^HTTP\/1\.1 413 /);
  assert.match(oversizedResponse, /\r\nconnection: close\r\n/i);
  assert.doesNotMatch(oversizedResponse, /^HTTP\/1\.1 100 Continue/m);

  const streamingGetWithBody = [
    "GET /api/runtime-events HTTP/1.1",
    `Host: 127.0.0.1:${port}`,
    `X-Forwarded-Host: ${REMOTE_HOST}`,
    `X-Peerlab-Context-Identity: ${signedHumanIdentity("transport-stream-body", ["view"])}`,
    "Content-Length: 100000000",
    "Connection: keep-alive",
    "",
    "",
  ].join("\r\n");
  const streamingGetResponse = await rawExchange(port, streamingGetWithBody);
  assert.match(streamingGetResponse, /^HTTP\/1\.1 400 /);
  assert.match(streamingGetResponse, /\r\nconnection: close\r\n/i);

  let continued = false;
  const bounded = withDeadline(new Promise((resolve, reject) => {
    const request = http.request({
      host: "127.0.0.1",
      port,
      path: "/api/context-hub/flash",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": 2,
        expect: "100-continue",
        "x-forwarded-host": REMOTE_HOST,
        "x-peerlab-context-identity": signedHumanIdentity("transport-expect-bounded"),
      },
    }, (response) => {
      response.resume();
      response.once("end", () => resolve(response));
    });
    request.once("continue", () => {
      continued = true;
      request.end("{}");
    });
    request.once("error", reject);
    request.flushHeaders();
  }), 1_000, "Hosted did not accept a valid bounded Expect request");
  const boundedResponse = await bounded;
  assert.equal(continued, true);
  assert.equal(boundedResponse.statusCode, 404);
});

function keepAlivePost(port, agent, jti) {
  return new Promise((resolve, reject) => {
    const body = "{}";
    const request = http.request({
      agent,
      host: "127.0.0.1",
      port,
      path: "/api/context-hub/flash",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
        "x-forwarded-host": REMOTE_HOST,
        "x-peerlab-context-identity": signedHumanIdentity(jti),
      },
    }, (response) => {
      const socket = response.socket;
      response.resume();
      response.once("end", () => resolve({ response, socket }));
    });
    request.once("error", reject);
    request.end(body);
  });
}

test("Hosted keeps a legitimate completed request connection reusable and bounds HTTP timeouts", async (t) => {
  const room = await setupRemoteRoom(t);
  const port = room.server.address().port;
  assert.ok(room.server.headersTimeout > 0 && room.server.headersTimeout <= 15_000);
  assert.ok(room.server.requestTimeout > 0 && room.server.requestTimeout <= 30_000);
  assert.ok(room.server.keepAliveTimeout > 0 && room.server.keepAliveTimeout <= 5_000);

  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const first = await keepAlivePost(port, agent, "transport-keepalive-1");
  const second = await keepAlivePost(port, agent, "transport-keepalive-2");
  assert.equal(first.response.statusCode, 404);
  assert.equal(second.response.statusCode, 404);
  assert.notEqual(first.response.headers.connection, "close");
  assert.equal(second.socket, first.socket);
});
