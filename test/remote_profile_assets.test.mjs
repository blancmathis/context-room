import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contextRoomWebAssetBundle,
  createMemoryServer,
  initializeContextRoomProject,
  renderAppHtml,
} from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";

const RUNTIME_PROFILES = ["local", "hosted-hub", "hosted-review"];
const REMOTE_HOST = "context.qm.peerlab.fr";
const REMOTE_SECRET = "remote-profile-assets-human-secret-with-more-than-32-bytes";
const HTML_START_TAG = /<html\b[^>]*>/i;
const PROFILE_ATTRIBUTE = /data-context-room-runtime-profile="([^"]+)"/g;
const MERMAID_PATH = /\/vendor\/mermaid\.[a-f0-9]{16}\.min\.js/;
const INVALID_PROFILE = "hosted-unknown";

function assertInvalidProfileRejected() {
  assert.throws(
    () => renderAppHtml({ runtimeProfile: INVALID_PROFILE }),
    /Unsupported Context Room runtime profile: hosted-unknown/,
  );
  assert.throws(
    () => contextRoomWebAssetBundle("prompt-secret", "owner-secret", INVALID_PROFILE),
    /Unsupported Context Room runtime profile: hosted-unknown/,
  );
}

function runtimeProfileFromHtml(html) {
  const startTag = String(html).match(HTML_START_TAG)?.[0] || "";
  assert.ok(startTag, "the app shell must expose an opening html tag");
  const matches = [...startTag.matchAll(PROFILE_ATTRIBUTE)];
  assert.equal(matches.length, 1, "the html start tag must expose exactly one runtime profile attribute");
  return matches[0][1];
}

function mermaidPathFromSource(source) {
  const match = String(source).match(MERMAID_PATH);
  assert.ok(match, "the compiled app must reference the versioned Mermaid asset");
  return match[0];
}

function normalizedShell(html) {
  return String(html)
    .replace(/data-context-room-runtime-profile="[^"]+"/, 'data-context-room-runtime-profile="PROFILE"')
    .replace(/(<meta name="context-room-prompt-nonce" content=")[^"]*(" \/>)/, "$1NONCE$2")
    .replace(/(<meta name="context-room-owner-nonce" content=")[^"]*(" \/>)/, "$1NONCE$2");
}

function assertNoHostPaths(value, label) {
  const source = Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
  const forbidden = [
    process.env.HOME,
    "/Users/",
    "/home/context-room",
    "/data/home",
  ].filter(Boolean);
  for (const candidate of forbidden) {
    assert.equal(source.includes(candidate), false, `${label} must not compile host path ${candidate}`);
  }
}

function profileSnapshot(profile) {
  const promptNonce = `prompt-${profile}-sentinel`;
  const ownerNonce = `owner-${profile}-sentinel`;
  const rendered = renderAppHtml({
    codexPromptMutationNonce: promptNonce,
    ownerMutationNonce: ownerNonce,
    runtimeProfile: profile,
  });
  const bundle = contextRoomWebAssetBundle(promptNonce, ownerNonce, profile);

  assert.equal(runtimeProfileFromHtml(rendered), profile);
  assert.equal(runtimeProfileFromHtml(bundle.html), profile);
  assert.doesNotMatch(rendered, /__CONTEXT_ROOM_(?:PROMPT_NONCE|OWNER_NONCE|RUNTIME_PROFILE)__/);
  assert.doesNotMatch(bundle.html, /__CONTEXT_ROOM_(?:PROMPT_NONCE|OWNER_NONCE|RUNTIME_PROFILE)__/);

  if (profile === "local") {
    assert.match(rendered, new RegExp(`name="context-room-prompt-nonce" content="${promptNonce}"`));
    assert.match(rendered, new RegExp(`name="context-room-owner-nonce" content="${ownerNonce}"`));
    assert.match(bundle.html, new RegExp(`name="context-room-prompt-nonce" content="${promptNonce}"`));
    assert.match(bundle.html, new RegExp(`name="context-room-owner-nonce" content="${ownerNonce}"`));
  } else {
    assert.match(rendered, /name="context-room-prompt-nonce" content=""/);
    assert.match(rendered, /name="context-room-owner-nonce" content=""/);
    assert.match(bundle.html, /name="context-room-prompt-nonce" content=""/);
    assert.match(bundle.html, /name="context-room-owner-nonce" content=""/);
    assert.doesNotMatch(rendered, new RegExp(`${promptNonce}|${ownerNonce}`));
    assert.doesNotMatch(bundle.html, new RegExp(`${promptNonce}|${ownerNonce}`));
  }

  for (const [label, value] of [
    [`${profile} rendered HTML`, rendered],
    [`${profile} bundled HTML`, bundle.html],
    [`${profile} CSS`, bundle.css],
    [`${profile} JavaScript`, bundle.js],
  ]) assertNoHostPaths(value, label);

  return {
    profile,
    rendered,
    bundle,
    mermaidPath: mermaidPathFromSource(bundle.js),
  };
}

function assertSharedAssets(reference, candidate) {
  assert.equal(candidate.bundle.cssPath, reference.bundle.cssPath);
  assert.equal(candidate.bundle.jsPath, reference.bundle.jsPath);
  assert.equal(candidate.bundle.cssEtag, reference.bundle.cssEtag);
  assert.equal(candidate.bundle.jsEtag, reference.bundle.jsEtag);
  assert.equal(candidate.bundle.css, reference.bundle.css);
  assert.equal(candidate.bundle.js, reference.bundle.js);
  assert.deepEqual(candidate.bundle.cssVariants.raw, reference.bundle.cssVariants.raw);
  assert.deepEqual(candidate.bundle.cssVariants.gzip, reference.bundle.cssVariants.gzip);
  assert.deepEqual(candidate.bundle.cssVariants.brotli, reference.bundle.cssVariants.brotli);
  assert.deepEqual(candidate.bundle.jsVariants.raw, reference.bundle.jsVariants.raw);
  assert.deepEqual(candidate.bundle.jsVariants.gzip, reference.bundle.jsVariants.gzip);
  assert.deepEqual(candidate.bundle.jsVariants.brotli, reference.bundle.jsVariants.brotli);
  assert.equal(candidate.mermaidPath, reference.mermaidPath);
  assert.equal(normalizedShell(candidate.rendered), normalizedShell(reference.rendered));
  assert.equal(normalizedShell(candidate.bundle.html), normalizedShell(reference.bundle.html));
}

function isolatedProject(t, name) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `context-room-${name}-`));
  const root = path.join(base, "project");
  fs.mkdirSync(root, { recursive: true });
  initializeContextRoomProject(root);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  return root;
}

async function listen(t, room) {
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    if (!room.server.listening) return resolve();
    room.server.close(() => resolve());
  }));
  return `http://127.0.0.1:${room.server.address().port}`;
}

function remoteAccess() {
  return {
    expectedHost: REMOTE_HOST,
    humanSecret: REMOTE_SECRET,
    agentSecret: `${REMOTE_SECRET}-agent`,
    healthSecret: `${REMOTE_SECRET}-health`,
    adminSubjects: ["profile-test-admin"],
    projectRoots: {},
    sharedRepositories: [],
  };
}

let remoteRequestCounter = 0;
function remoteHeaders() {
  remoteRequestCounter += 1;
  return {
    "accept-encoding": "identity",
    "x-forwarded-host": REMOTE_HOST,
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "profile-test-admin",
      role: "admin",
      operations: ["view"],
    }, REMOTE_SECRET, { jti: `remote-profile-assets-${remoteRequestCounter}` }),
  };
}

async function readHttpAsset(origin, assetPath, headers = {}) {
  const response = await fetch(`${origin}${assetPath}`, {
    headers: { "accept-encoding": "identity", ...headers },
  });
  assert.equal(response.status, 200, `expected ${assetPath} to be served`);
  assert.equal(response.headers.get("cache-control"), "public, max-age=31536000, immutable");
  return {
    bytes: Buffer.from(await response.arrayBuffer()),
    etag: response.headers.get("etag"),
  };
}

test("runtime profile shells and immutable assets remain cache-safe in every call order", async (t) => {
  assertInvalidProfileRejected();
  assert.equal(runtimeProfileFromHtml(
    '<html data-context-room-runtime-profile="local"><style>html[data-context-room-runtime-profile="hosted-hub"]{display:block}</style>',
  ), "local", "runtime profile selectors inside inline CSS must not count as shell attributes");

  const forward = ["local", "hosted-hub", "hosted-review", "local"].map(profileSnapshot);
  const inverse = ["hosted-review", "hosted-hub", "local", "hosted-review"].map(profileSnapshot);
  const reference = forward[0];

  for (const snapshot of [...forward, ...inverse]) assertSharedAssets(reference, snapshot);
  assert.equal(forward[0].rendered, forward.at(-1).rendered);
  assert.equal(forward[0].bundle.html, forward.at(-1).bundle.html);
  assert.equal(inverse[0].rendered, inverse.at(-1).rendered);
  assert.equal(inverse[0].bundle.html, inverse.at(-1).bundle.html);

  for (const profile of RUNTIME_PROFILES) {
    const snapshot = profileSnapshot(profile);
    assert.equal(runtimeProfileFromHtml(snapshot.rendered), profile);
    assert.equal(runtimeProfileFromHtml(snapshot.bundle.html), profile);
  }

  const localRoot = isolatedProject(t, "profile-assets-local");
  const hostedRoot = isolatedProject(t, "profile-assets-hosted");
  const localRoom = createMemoryServer({ root: localRoot });
  const hostedRoom = createMemoryServer({ root: hostedRoot, remoteAccess: remoteAccess() });
  const localOrigin = await listen(t, localRoom);
  const hostedOrigin = await listen(t, hostedRoom);

  const localHtmlResponse = await fetch(`${localOrigin}/`);
  assert.equal(localHtmlResponse.status, 200);
  assert.equal(localHtmlResponse.headers.get("cache-control"), "no-store");
  assert.match(localHtmlResponse.headers.get("content-type") || "", /^text\/html\b/);
  const localHtml = await localHtmlResponse.text();
  assert.equal(runtimeProfileFromHtml(localHtml), "local");
  assert.match(localHtml, new RegExp(localRoom.promptMutationNonce));
  assert.match(localHtml, new RegExp(localRoom.ownerMutationNonce));

  const hostedHtmlResponse = await fetch(`${hostedOrigin}/`, { headers: remoteHeaders() });
  assert.equal(hostedHtmlResponse.status, 200);
  assert.equal(hostedHtmlResponse.headers.get("cache-control"), "no-store");
  assert.match(hostedHtmlResponse.headers.get("content-type") || "", /^text\/html\b/);
  const hostedHtml = await hostedHtmlResponse.text();
  assert.equal(runtimeProfileFromHtml(hostedHtml), "hosted-hub");
  assert.match(hostedHtml, /name="context-room-prompt-nonce" content=""/);
  assert.match(hostedHtml, /name="context-room-owner-nonce" content=""/);
  assert.doesNotMatch(hostedHtml, new RegExp(`${hostedRoom.promptMutationNonce}|${hostedRoom.ownerMutationNonce}`));

  const missingReviewResponse = await fetch(`${hostedOrigin}/reviews/missing-review/`, {
    headers: { "x-forwarded-host": REMOTE_HOST },
  });
  assert.equal(missingReviewResponse.status, 404);
  assert.equal(missingReviewResponse.headers.get("cache-control"), "no-store");
  assert.match(missingReviewResponse.headers.get("content-type") || "", /^text\/html\b/);

  const cssPath = reference.bundle.cssPath;
  const jsPath = reference.bundle.jsPath;
  const mermaidPath = reference.mermaidPath;
  const [localCss, hostedCss, localJs, hostedJs, localMermaid, hostedMermaid] = await Promise.all([
    readHttpAsset(localOrigin, cssPath),
    readHttpAsset(hostedOrigin, cssPath, remoteHeaders()),
    readHttpAsset(localOrigin, jsPath),
    readHttpAsset(hostedOrigin, jsPath, remoteHeaders()),
    readHttpAsset(localOrigin, mermaidPath),
    readHttpAsset(hostedOrigin, mermaidPath, remoteHeaders()),
  ]);

  assert.deepEqual(localCss.bytes, reference.bundle.cssVariants.raw);
  assert.deepEqual(hostedCss.bytes, reference.bundle.cssVariants.raw);
  assert.equal(localCss.etag, hostedCss.etag);
  assert.equal(localCss.etag, reference.bundle.cssEtag.replace(/"$/, '-identity"'));
  assert.deepEqual(localJs.bytes, reference.bundle.jsVariants.raw);
  assert.deepEqual(hostedJs.bytes, reference.bundle.jsVariants.raw);
  assert.equal(localJs.etag, hostedJs.etag);
  assert.equal(localJs.etag, reference.bundle.jsEtag.replace(/"$/, '-identity"'));

  const mermaidSource = fs.readFileSync(new URL("../node_modules/mermaid/dist/mermaid.min.js", import.meta.url));
  const mermaidHash = createHash("sha256").update(mermaidSource).digest("hex").slice(0, 16);
  assert.equal(mermaidPath, `/vendor/mermaid.${mermaidHash}.min.js`);
  assert.deepEqual(localMermaid.bytes, mermaidSource);
  assert.deepEqual(hostedMermaid.bytes, mermaidSource);
  assert.equal(localMermaid.etag, hostedMermaid.etag);
  assert.equal(localMermaid.etag, `"${mermaidHash}-identity"`);

  for (const [label, value] of [
    ["served local CSS", localCss.bytes],
    ["served hosted CSS", hostedCss.bytes],
    ["served local JavaScript", localJs.bytes],
    ["served hosted JavaScript", hostedJs.bytes],
    ["served local Mermaid", localMermaid.bytes],
    ["served hosted Mermaid", hostedMermaid.bytes],
  ]) assertNoHostPaths(value, label);

  assertInvalidProfileRejected();
});
