import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { request as httpRequest } from "node:http";
import os from "node:os";
import path from "node:path";

const HOST = "context.qm.peerlab.fr";
const HUMAN_SECRET = "remote-home-boundary-human-secret-with-more-than-32-bytes";
const AGENT_SECRET = "remote-home-boundary-agent-secret-with-more-than-32-bytes";
const HEALTH_SECRET = "remote-home-boundary-health-secret-with-more-than-32-bytes";
const SENTINEL = "context-room-remote-home-boundary-private-sentinel";

const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-home-boundary-"));
const environmentRoots = {
  HOME: path.join(base, "home"),
  CODEX_HOME: path.join(base, "codex-home"),
  HERMES_HOME: path.join(base, "hermes-home"),
  CONTEXT_ROOM_HUB_HOME: path.join(base, "hub-home"),
  CONTEXT_ROOM_SHARED_HOME: path.join(base, "shared-home"),
  CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: path.join(base, "review-authority-home"),
  CONTEXT_ROOM_SNAPSHOT_HOME: path.join(base, "snapshot-home"),
};

for (const [name, directory] of Object.entries(environmentRoots)) {
  fs.mkdirSync(directory, { recursive: true });
  process.env[name] = directory;
}
process.env.NODE_TEST_CONTEXT = "1";

const [{ createMemoryServer, initializeContextRoomProject }, { signRemoteIdentity }] = await Promise.all([
  import("../src/context_room.mjs"),
  import("../src/remote_identity.mjs"),
]);

function writePrivateFile(filePath, content = SENTINEL) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${content}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function snapshotTree(root) {
  const entries = [];
  const visit = (directory, relativeDirectory = "") => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolutePath = path.join(directory, name);
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join("/"), name);
      const stat = fs.lstatSync(absolutePath);
      const record = {
        path: relativePath,
        type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
        inode: stat.ino,
        mode: stat.mode & 0o7777,
        size: stat.size,
      };
      if (stat.isFile()) {
        record.sha256 = createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex");
      } else if (stat.isSymbolicLink()) {
        record.target = fs.readlinkSync(absolutePath);
      }
      entries.push(record);
      if (stat.isDirectory()) visit(absolutePath, relativePath);
    }
  };
  visit(root);
  return entries;
}

function snapshots() {
  return Object.fromEntries(Object.entries(environmentRoots).map(([name, directory]) => [name, snapshotTree(directory)]));
}

function assertPayloadDoesNotExposeBoundary(payload) {
  const serialized = JSON.stringify(payload);
  assert.doesNotMatch(serialized, new RegExp(SENTINEL, "i"));
  assert.doesNotMatch(serialized, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const forbiddenKeys = new Set([
    "absolutePath",
    "credentials",
    "home",
    "repository",
    "repositoryUrl",
    "reviewRoot",
    "root",
    "worktree",
    "worktrees",
  ]);
  const walk = (value) => {
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbiddenKeys.has(key), false, `forbidden hosted response key: ${key}`);
      walk(child);
    }
  };
  walk(payload);
}

function requestRawJson(port, method, requestPath) {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: "127.0.0.1",
      port,
      method,
      path: requestPath,
      headers: { "x-forwarded-host": HOST },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        try {
          resolve({ status: response.statusCode, payload: JSON.parse(text) });
        } catch (error) {
          reject(Object.assign(error, { responseText: text }));
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

function staleFingerprint(requestPath) {
  return requestPath.replace(/[a-f0-9]{16}/, (fingerprint) => (
    fingerprint === "0000000000000000" ? "ffffffffffffffff" : "0000000000000000"
  ));
}

const projectRoot = path.join(environmentRoots.HOME, "workspace", "project");
fs.mkdirSync(projectRoot, { recursive: true });
initializeContextRoomProject(projectRoot, {
  allowedPaths: ["docs/", "~/.codex/"],
  watchAllow: ["docs/"],
  reviewPaths: ["docs/"],
});

writePrivateFile(path.join(environmentRoots.HOME, "AGENTS.md"), `${SENTINEL}-agents`);
writePrivateFile(path.join(environmentRoots.HOME, ".codex", "config.toml"), `${SENTINEL}-config`);
writePrivateFile(path.join(environmentRoots.HOME, ".codex", "hooks", "private-hook.sh"), `${SENTINEL}-hook`);
writePrivateFile(path.join(environmentRoots.HOME, ".codex", "skills", "private", "SKILL.md"), `${SENTINEL}-skill`);
for (const [name, directory] of Object.entries(environmentRoots)) {
  writePrivateFile(path.join(directory, "boundary-sentinel.txt"), `${SENTINEL}-${name}`);
  writePrivateFile(path.join(directory, ".private", "registry.json"), JSON.stringify({ secret: `${SENTINEL}-${name}` }));
}

const before = snapshots();
const touches = { codexPromptCenter: 0, sharedProvider: 0 };
const throwingProvider = (name) => new Proxy(Object.freeze({}), {
  get() {
    touches[name] += 1;
    throw new Error(`${SENTINEL}-${name}-was-touched`);
  },
});
const codexPromptCenter = throwingProvider("codexPromptCenter");
const sharedProvider = throwingProvider("sharedProvider");
const room = createMemoryServer({
  root: projectRoot,
  codexPromptCenter,
  remoteAccess: {
    expectedHost: HOST,
    humanSecret: HUMAN_SECRET,
    agentSecret: AGENT_SECRET,
    healthSecret: HEALTH_SECRET,
    adminSubjects: ["mathis"],
    projectRoots: {},
    sharedProvider,
  },
});

await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${room.server.address().port}`;
const remotePort = room.server.address().port;
const denied = [
  ["GET", "/api/settings"],
  ["POST", "/api/settings"],
  ["GET", "/api/files"],
  ["GET", "/api/file?path=docs/private.md"],
  ["POST", "/api/file"],
  ["GET", "/api/startup-context"],
  ["GET", "/api/startup-context/file?path=AGENTS.md"],
  ["POST", "/api/startup-context/file"],
  ["GET", "/api/startup-skills"],
  ["GET", "/api/startup-skills/file?path=private/SKILL.md"],
  ["POST", "/api/startup-skills/file"],
  ["GET", "/api/startup-hooks"],
  ["GET", "/api/startup-hooks/file?path=private-hook.sh"],
  ["POST", "/api/startup-hooks/file"],
  ["GET", "/api/context/effective"],
  ["GET", "/api/context-hub/computer-explorer"],
  ["POST", "/api/context-hub/preferences"],
  ["POST", "/api/context-hub/projects"],
  ["POST", "/api/context-hub/project"],
  ["GET", "/api/codex-prompts"],
  ["GET", "/api/codex-prompts/target?id=agents"],
  ["POST", "/api/codex-prompts/validate"],
  ["POST", "/api/codex-prompts/override"],
  ["DELETE", "/api/codex-prompts/override"],
  ["POST", "/api/codex-prompts/refresh"],
  ["GET", "/vendor/mermaid.min.js"],
  ["OPTIONS", "/vendor/mermaid.min.js"],
];
const rawDenied = [
  "/api/context-hub/../settings",
  "/api/context-hub/%2e%2e/settings",
  "/api/context-hub\\..\\settings",
  "//api/context-hub",
];
let deniedCount = 0;
let exactAssetCount = 0;

try {
  for (const [method, requestPath] of denied) {
    const response = await fetch(`${origin}${requestPath}`, {
      method,
      headers: {
        "content-type": "application/json",
        "x-forwarded-host": HOST,
      },
      ...(["GET", "HEAD"].includes(method) ? {} : { body: JSON.stringify({ path: "docs/private.md", content: SENTINEL }) }),
    });
    const payload = await response.json();
    assert.equal(response.status, 404, `${method} ${requestPath}`);
    assert.equal(payload.code, "remote_operation_unavailable", `${method} ${requestPath}`);
    assertPayloadDoesNotExposeBoundary(payload);
    deniedCount += 1;
  }

  for (const requestPath of rawDenied) {
    for (const method of ["GET", "OPTIONS"]) {
      const response = await requestRawJson(remotePort, method, requestPath);
      assert.equal(response.status, 404, `${method} ${requestPath}`);
      assert.equal(response.payload.code, "remote_operation_unavailable", `${method} ${requestPath}`);
      assertPayloadDoesNotExposeBoundary(response.payload);
      deniedCount += 1;
    }
  }

  const humanHealthIdentity = signRemoteIdentity({
    kind: "human",
    sub: "mathis",
    role: "admin",
    operations: ["view"],
  }, HUMAN_SECRET, { jti: "remote-home-boundary-human-health" });
  const humanHealth = await fetch(`${origin}/api/health`, {
    headers: {
      "x-forwarded-host": HOST,
      "x-peerlab-context-identity": humanHealthIdentity,
    },
  });
  const humanHealthPayload = await humanHealth.json();
  assert.equal(humanHealth.status, 404);
  assert.equal(humanHealthPayload.code, "remote_operation_unavailable");
  assertPayloadDoesNotExposeBoundary(humanHealthPayload);
  deniedCount += 1;

  const forgedTargetIdentity = signRemoteIdentity({
    kind: "human",
    sub: "mathis",
    role: "admin",
    operations: ["view"],
  }, HUMAN_SECRET, { jti: "remote-home-boundary-forged-target" });
  const forgedTarget = await fetch(`${origin}/api/context-hub`, {
    headers: {
      "x-forwarded-host": HOST,
      "x-peerlab-context-identity": forgedTargetIdentity,
      "x-context-room-target-project": "forged-local-project",
    },
  });
  const forgedTargetPayload = await forgedTarget.json();
  assert.equal(forgedTarget.status, 404);
  assert.equal(forgedTargetPayload.code, "remote_operation_unavailable");
  assertPayloadDoesNotExposeBoundary(forgedTargetPayload);
  deniedCount += 1;

  let assetIdentitySequence = 0;
  const assetHeaders = () => ({
    "x-forwarded-host": HOST,
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "mathis",
      role: "admin",
      operations: ["view"],
    }, HUMAN_SECRET, { jti: `remote-home-boundary-asset-${assetIdentitySequence += 1}` }),
  });
  const pageResponse = await fetch(`${origin}/`, { headers: assetHeaders() });
  const page = await pageResponse.text();
  assert.equal(pageResponse.status, 200);
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  assert.doesNotMatch(page, new RegExp(SENTINEL, "i"));
  assert.doesNotMatch(page, new RegExp(base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"));
  const cssPath = page.match(/href="([^"]+\.css)"/)?.[1] || "";
  const jsPath = page.match(/src="([^"]+\.js)"/)?.[1] || "";
  assert.match(cssPath, /^\/assets\/context-room\.[a-f0-9]{16}\.css$/);
  assert.match(jsPath, /^\/assets\/context-room\.[a-f0-9]{16}\.js$/);

  const cssResponse = await fetch(`${origin}${cssPath}`, { headers: assetHeaders() });
  assert.equal(cssResponse.status, 200);
  assert.doesNotMatch(await cssResponse.text(), new RegExp(SENTINEL, "i"));
  exactAssetCount += 1;
  const jsResponse = await fetch(`${origin}${jsPath}`, { headers: assetHeaders() });
  const script = await jsResponse.text();
  assert.equal(jsResponse.status, 200);
  assert.doesNotMatch(script, new RegExp(SENTINEL, "i"));
  exactAssetCount += 1;
  const mermaidPath = script.match(/\/vendor\/mermaid\.[a-f0-9]{16}\.min\.js/)?.[0] || "";
  assert.match(mermaidPath, /^\/vendor\/mermaid\.[a-f0-9]{16}\.min\.js$/);
  const mermaidResponse = await fetch(`${origin}${mermaidPath}`, { headers: assetHeaders() });
  assert.equal(mermaidResponse.status, 200);
  assert.doesNotMatch(await mermaidResponse.text(), new RegExp(SENTINEL, "i"));
  exactAssetCount += 1;

  for (const [currentPath, requestPath] of [cssPath, jsPath, mermaidPath].map((assetPath) => [assetPath, staleFingerprint(assetPath)])) {
    assert.notEqual(requestPath, currentPath);
    for (const method of ["GET", "OPTIONS"]) {
      const response = await fetch(`${origin}${requestPath}`, {
        method,
        headers: { "x-forwarded-host": HOST },
      });
      const payload = await response.json();
      assert.equal(response.status, 404, `${method} ${requestPath}`);
      assert.equal(payload.code, "remote_operation_unavailable", `${method} ${requestPath}`);
      assertPayloadDoesNotExposeBoundary(payload);
      deniedCount += 1;
    }
  }

  const serviceHealth = await fetch(`${origin}/api/health`, {
    headers: {
      "x-forwarded-host": HOST,
      "x-peerlab-context-health": HEALTH_SECRET,
    },
  });
  const serviceHealthPayload = await serviceHealth.json();
  assert.equal(serviceHealth.status, 200);
  assert.deepEqual(Object.keys(serviceHealthPayload).sort(), ["buildRevision", "ok", "version"]);
  assert.equal(serviceHealthPayload.ok, true);
  assertPayloadDoesNotExposeBoundary(serviceHealthPayload);

  assert.deepEqual(touches, { codexPromptCenter: 0, sharedProvider: 0 });
} finally {
  await new Promise((resolve) => room.server.close(() => resolve()));
}

const after = snapshots();
assert.deepEqual(after, before);
assert.deepEqual(touches, { codexPromptCenter: 0, sharedProvider: 0 });

process.stdout.write(`${JSON.stringify({
  ok: true,
  deniedRoutes: deniedCount,
  exactAssets: exactAssetCount,
  healthKeys: ["buildRevision", "ok", "version"],
  touches,
  roots: Object.keys(environmentRoots).sort(),
})}\n`);

fs.rmSync(base, { recursive: true, force: true });
