import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { registerContextHubSharedRepository } from "../src/context_hub.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";

const REMOTE_SECRET = "server-security-test-secret-with-more-than-32-bytes";
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

function isolatedProject(t, name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `context-room-${name}-`));
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(base, "shared");
  initializeContextRoomProject(root);
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  return { base, root };
}

async function listen(t, room) {
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    if (!room.server.listening) return resolve();
    room.server.close(() => resolve());
  }));
  return `http://127.0.0.1:${room.server.address().port}`;
}

function snapshotDirectory(directory) {
  const entries = [];
  const visit = (current, relativeDirectory = "") => {
    for (const name of fs.readdirSync(current).sort()) {
      const absolutePath = path.join(current, name);
      const relativePath = path.posix.join(relativeDirectory.split(path.sep).join("/"), name);
      const stat = fs.lstatSync(absolutePath);
      entries.push({
        path: relativePath,
        inode: stat.ino,
        mode: stat.mode & 0o7777,
        size: stat.size,
        type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file",
        ...(stat.isFile() ? { bytes: fs.readFileSync(absolutePath).toString("base64") } : {}),
        ...(stat.isSymbolicLink() ? { target: fs.readlinkSync(absolutePath) } : {}),
      });
      if (stat.isDirectory()) visit(absolutePath, relativePath);
    }
  };
  visit(directory);
  return entries;
}

test("document inspection never follows a project symlink outside the selected root", async (t) => {
  const { base, root } = isolatedProject(t, "document-symlink");
  const external = path.join(base, "external.md");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(external, "---\nsecret: sentinel-outside-project\n---\n# External\n");
  fs.symlinkSync(external, path.join(root, "docs", "linked.md"));
  const room = createMemoryServer({ root });
  const origin = await listen(t, room);

  const response = await fetch(`${origin}/api/context-hub/document-inspect?path=docs%2Flinked.md`);
  const payload = await response.json();
  assert.equal(response.status, 403);
  assert.equal(payload.code, "document_outside_project");
  assert.doesNotMatch(JSON.stringify(payload), /sentinel-outside-project/);
});

test("browser workspace registration rejects cross-site requests but can establish its initial project identity", async (t) => {
  const { root } = isolatedProject(t, "workspace-csrf");
  const room = createMemoryServer({ root });
  const origin = await listen(t, room);
  const body = JSON.stringify({
    workspaceId: "workspace-security",
    clientInstanceId: "client-security",
    view: "hub",
  });

  const crossSite = await fetch(`${origin}/api/workspaces/register`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "https://attacker.example",
      "sec-fetch-site": "cross-site",
    },
    body,
  });
  assert.equal(crossSite.status, 403);
  assert.equal((await crossSite.json()).code, "context_room_cross_site_request_denied");

  const untrustedLoopbackPort = await fetch(`${origin}/api/workspaces/register`, {
    method: "POST",
    headers: {
      "content-type": "text/plain",
      origin: "http://127.0.0.1:65534",
      referer: "http://127.0.0.1:65534/",
      "sec-fetch-site": "same-site",
    },
    body,
  });
  assert.equal(untrustedLoopbackPort.status, 403);
  assert.equal((await untrustedLoopbackPort.json()).code, "context_room_cross_site_request_denied");

  const initialRegistration = await fetch(`${origin}/api/workspaces/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body,
  });
  assert.equal(initialRegistration.status, 200);

  const accepted = await fetch(`${origin}/api/workspaces/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin,
      "x-context-room-project": room.projectId,
    },
    body,
  });
  assert.equal(accepted.status, 200);
  const workspaces = await (await fetch(`${origin}/api/workspaces`)).json();
  assert.deepEqual(workspaces.workspaces.map((item) => item.workspaceId), ["workspace-security"]);
});

test("another loopback Context Room port can register a materialized proposal room before learning its project identity", async (t) => {
  const { root } = isolatedProject(t, "cross-port-review");
  const ownerRoom = createMemoryServer({ root });
  const ownerOrigin = await listen(t, ownerRoom);
  const reviewRoom = createMemoryServer({
    root,
    frameAncestorPorts: [ownerRoom.server.address().port],
  });
  const reviewOrigin = await listen(t, reviewRoom);
  const response = await fetch(`${reviewOrigin}/api/workspaces/register`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ownerOrigin,
      referer: `${ownerOrigin}/`,
      "sec-fetch-site": "same-site",
    },
    body: JSON.stringify({
      workspaceId: "workspace-cross-port",
      clientInstanceId: "client-cross-port",
      view: "proposal",
    }),
  });
  assert.equal(response.status, 200);
});

test("proposal repository APIs reject repositories outside the configured registries", async (t) => {
  const { root } = isolatedProject(t, "repository-boundary");
  const room = createMemoryServer({ root });
  const origin = await listen(t, room);
  const repository = "https://attacker.example/unregistered.git";

  const impact = await fetch(`${origin}/api/proposal/context-impact?selector=proposal%2Fdemo%2Fchange&repository=${encodeURIComponent(repository)}`);
  assert.equal(impact.status, 403);
  assert.equal((await impact.json()).code, "shared_context_repository_not_registered");

  const review = await fetch(`${origin}/api/context-hub/review`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ proposal: "proposal/demo/change", repository }),
  });
  assert.equal(review.status, 403);
  assert.equal((await review.json()).code, "shared_context_repository_not_registered");

  registerContextHubSharedRepository("git@github.com:example/registered.git");
  const registeredImpact = await fetch(`${origin}/api/proposal/context-impact?selector=&repository=${encodeURIComponent("https://github.com/example/registered.git")}`);
  assert.equal(registeredImpact.status, 400);
  assert.equal((await registeredImpact.json()).code, "proposal_selector_required");
});

test("JSON requests are bounded and unexpected server errors are sanitized", async (t) => {
  const { root } = isolatedProject(t, "bounded-json");
  const room = createMemoryServer({ root });
  const origin = await listen(t, room);

  const oversized = await fetch(`${origin}/api/workspaces/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ padding: "x".repeat(2_200_000) }),
  });
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "request_body_too_large");

  fs.writeFileSync(path.join(root, ".context-room", "config.json"), JSON.stringify({ allowedPaths: null }) + "\n");
  const failed = await fetch(`${origin}/api/file`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: "docs/private.md", content: "sentinel-internal-error" }),
  });
  const payload = await failed.json();
  assert.equal(failed.status, 500);
  assert.equal(payload.code, "context_room_internal_error");
  assert.equal(payload.error, "Context Room could not complete this request.");
  assert.doesNotMatch(JSON.stringify(payload), /allowedPaths|sentinel-internal-error|context-room-bounded-json/);
});

test("document shell and assets support HEAD while OPTIONS stays unauthenticated and non-CORS", async (t) => {
  const { root } = isolatedProject(t, "http-methods");
  const room = createMemoryServer({ root });
  const origin = await listen(t, room);
  const page = await (await fetch(`${origin}/`)).text();
  const cssPath = page.match(/href="([^"]+\.css)"/)?.[1];
  const jsPath = page.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(cssPath);
  assert.ok(jsPath);
  const script = await (await fetch(`${origin}${jsPath}`)).text();
  const mermaidPath = script.match(/\/vendor\/mermaid\.[a-f0-9]{16}\.min\.js/)?.[0];
  assert.ok(mermaidPath);

  for (const requestPath of ["/", cssPath, mermaidPath, "/vendor/mermaid.min.js"]) {
    const response = await fetch(`${origin}${requestPath}`, { method: "HEAD" });
    assert.equal(response.status, 200, requestPath);
    assert.equal(await response.text(), "");
  }
  const versionedMermaid = await fetch(`${origin}${mermaidPath}`, { method: "HEAD" });
  assert.equal(versionedMermaid.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const mermaid = await fetch(`${origin}/vendor/mermaid.min.js`, { method: "HEAD" });
  assert.doesNotMatch(mermaid.headers.get("cache-control") || "", /immutable/);
  assert.match(mermaid.headers.get("cache-control") || "", /max-age=3600/);

  const gzipPreferred = await fetch(`${origin}${cssPath}`, {
    method: "HEAD",
    headers: { "accept-encoding": "br;q=0, gzip;q=1" },
  });
  assert.equal(gzipPreferred.status, 200);
  assert.equal(gzipPreferred.headers.get("content-encoding"), "gzip");
  const identityPreferred = await fetch(`${origin}${cssPath}`, {
    method: "HEAD",
    headers: { "accept-encoding": "br;q=0, gzip;q=0, identity;q=1" },
  });
  assert.equal(identityPreferred.status, 200);
  assert.equal(identityPreferred.headers.get("content-encoding"), null);
  const unacceptableEncoding = await fetch(`${origin}${cssPath}`, {
    method: "HEAD",
    headers: { "accept-encoding": "br;q=0, gzip;q=0, identity;q=0" },
  });
  assert.equal(unacceptableEncoding.status, 406);

  const identityValidator = identityPreferred.headers.get("etag");
  const gzipWithIdentityValidator = await fetch(`${origin}${cssPath}`, {
    method: "HEAD",
    headers: {
      "accept-encoding": "gzip",
      "if-none-match": identityValidator,
    },
  });
  assert.equal(gzipWithIdentityValidator.status, 200);
  assert.notEqual(gzipWithIdentityValidator.headers.get("etag"), identityValidator);
  const gzipNotModified = await fetch(`${origin}${cssPath}`, {
    method: "HEAD",
    headers: {
      "accept-encoding": "gzip",
      "if-none-match": gzipWithIdentityValidator.headers.get("etag"),
    },
  });
  assert.equal(gzipNotModified.status, 304);
  assert.equal(gzipNotModified.headers.get("vary"), "accept-encoding");
  for (const validator of [
    `"unrelated", ${gzipWithIdentityValidator.headers.get("etag")}`,
    `W/${gzipWithIdentityValidator.headers.get("etag")}`,
    "*",
  ]) {
    const notModified = await fetch(`${origin}${cssPath}`, {
      method: "HEAD",
      headers: { "accept-encoding": "gzip", "if-none-match": validator },
    });
    assert.equal(notModified.status, 304, validator);
  }

  const rootOptions = await fetch(`${origin}/`, { method: "OPTIONS" });
  assert.equal(rootOptions.status, 204);
  assert.equal(rootOptions.headers.get("allow"), "GET, HEAD, OPTIONS");
  const workspaceOptions = await fetch(`${origin}/api/workspaces/register`, {
    method: "OPTIONS",
    headers: { origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
  });
  assert.equal(workspaceOptions.status, 204);
  assert.equal(workspaceOptions.headers.get("allow"), "POST, DELETE, OPTIONS");
  assert.equal(workspaceOptions.headers.get("access-control-allow-origin"), null);
});

test("health and response headers publish validated runtime build identity", async (t) => {
  const { root } = isolatedProject(t, "build-identity");
  const previousRevision = process.env.CONTEXT_ROOM_BUILD_REVISION;
  const revision = "0123456789abcdef0123456789abcdef01234567";
  process.env.CONTEXT_ROOM_BUILD_REVISION = revision.toUpperCase();
  t.after(() => {
    if (previousRevision === undefined) delete process.env.CONTEXT_ROOM_BUILD_REVISION;
    else process.env.CONTEXT_ROOM_BUILD_REVISION = previousRevision;
  });
  const room = createMemoryServer({ root });
  const origin = await listen(t, room);

  const healthResponse = await fetch(`${origin}/api/health`);
  const health = await healthResponse.json();
  assert.equal(health.version, PACKAGE_VERSION);
  assert.equal(health.buildRevision, revision);
  assert.equal(healthResponse.headers.get("x-context-room-version"), PACKAGE_VERSION);
  assert.equal(healthResponse.headers.get("x-context-room-revision"), revision);

  const pageResponse = await fetch(`${origin}/`);
  const page = await pageResponse.text();
  const assetPath = page.match(/src="([^"]+\.js)"/)?.[1];
  assert.ok(assetPath);
  const assetResponse = await fetch(`${origin}${assetPath}`, { method: "HEAD" });
  assert.equal(assetResponse.headers.get("x-context-room-version"), PACKAGE_VERSION);
  assert.equal(assetResponse.headers.get("x-context-room-revision"), revision);
  assert.equal(assetResponse.headers.get("x-context-room-project"), null);

  process.env.CONTEXT_ROOM_BUILD_REVISION = "a".repeat(64);
  const invalidResponse = await fetch(`${origin}/api/health`);
  assert.equal((await invalidResponse.json()).buildRevision, null);
  assert.equal(invalidResponse.headers.get("x-context-room-revision"), null);
});
