import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  listSharedProposalWorkspaces,
  publishSharedProposal,
} from "../src/shared_context.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";

const REMOTE_HOST = "context.qm.peerlab.fr";
const HUMAN_SECRET = "hosted-scope-human-secret-with-more-than-32-bytes";
const AGENT_SECRET = "hosted-scope-agent-secret-with-more-than-32-bytes";
const HEALTH_SECRET = "hosted-scope-health-secret-with-more-than-32-bytes";
const ALLOWED_PROJECT = "alpha";
const HIDDEN_PROJECT = "beta";
const PRIVATE_SENTINEL = "private-hosted-scope-sentinel-must-never-leak";
const HIDDEN_SECRET_MARKER = "beta-secret-marker-must-never-cross-hosted-scope";
const HIDDEN_SECRET_PATH = `projects/${HIDDEN_PROJECT}/docs/SECRET.md`;

function git(cwd, args, { stdio = ["ignore", "pipe", "pipe"] } = {}) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "hosted-scope@example.test"]);
  git(root, ["config", "user.name", "Hosted Scope Test"]);
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

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

function treeSnapshot(target) {
  const entries = [];
  const visit = (absolutePath, relativePath) => {
    let stats;
    try {
      stats = fs.lstatSync(absolutePath);
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const mode = stats.mode & 0o7777;
    if (stats.isSymbolicLink()) {
      entries.push([relativePath, "link", mode, fs.readlinkSync(absolutePath)]);
      return;
    }
    if (stats.isDirectory()) {
      entries.push([relativePath, "dir", mode]);
      for (const name of fs.readdirSync(absolutePath).sort()) {
        visit(path.join(absolutePath, name), relativePath ? `${relativePath}/${name}` : name);
      }
      return;
    }
    if (stats.isFile()) {
      entries.push([
        relativePath,
        "file",
        mode,
        stats.size,
        createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
      ]);
      return;
    }
    entries.push([relativePath, "other", mode]);
  };
  visit(target, ".");
  const serialized = JSON.stringify(entries);
  return {
    entries: entries.length,
    digest: createHash("sha256").update(serialized).digest("hex"),
  };
}

function namedTreeSnapshots(root, directoryName) {
  const snapshots = {};
  const visit = (target, relativePath = ".") => {
    if (!fs.existsSync(target)) return;
    const stats = fs.lstatSync(target);
    if (!stats.isDirectory() || stats.isSymbolicLink()) return;
    if (path.basename(target) === directoryName) {
      snapshots[relativePath] = treeSnapshot(target);
      return;
    }
    for (const entry of fs.readdirSync(target).sort()) {
      visit(path.join(target, entry), relativePath === "." ? entry : `${relativePath}/${entry}`);
    }
  };
  visit(root);
  return snapshots;
}

function boundarySnapshot(fixture) {
  return {
    sharedCacheAndProposalRegistry: treeSnapshot(fixture.sharedHome),
    hubRegistry: treeSnapshot(path.join(fixture.hubHome, "registry.json")),
    hubSnapshotCache: treeSnapshot(fixture.snapshotHome),
    ownerReviewAuthority: treeSnapshot(fixture.reviewAuthorityHome),
    remoteRefs: treeSnapshot(path.join(fixture.remote, "refs")),
    projectState: treeSnapshot(path.join(fixture.projectAlpha, ".context-room")),
  };
}

function restoreEnvironment(previous) {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

async function setupFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-scope-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const projectAlpha = path.join(base, "project-alpha");
  const projectBeta = path.join(base, "project-beta");
  const home = path.join(base, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  const hubHome = path.join(home, ".context-room", "hub");
  const snapshotHome = path.join(home, ".context-room", "snapshots");
  const reviewAuthorityHome = path.join(home, ".context-room", "review-authority");
  const gitConfig = path.join(base, "gitconfig");
  const environmentKeys = [
    "HOME",
    "CONTEXT_ROOM_SHARED_HOME",
    "CONTEXT_ROOM_HUB_HOME",
    "CONTEXT_ROOM_SNAPSHOT_HOME",
    "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME",
    "GIT_CONFIG_GLOBAL",
  ];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  process.env.CONTEXT_ROOM_SNAPSHOT_HOME = snapshotHome;
  process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = reviewAuthorityHome;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(gitConfig, "", "utf8");

  let room = null;
  t.after(async () => {
    if (room?.server.listening) await new Promise((resolve) => room.server.close(resolve));
    restoreEnvironment(previousEnvironment);
    removeWritableTree(base);
  });

  fs.mkdirSync(projectAlpha, { recursive: true });
  fs.mkdirSync(projectBeta, { recursive: true });
  git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(base, ["clone", remote, seed], { stdio: "ignore" });
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Hosted scope fixture" });
  writeFile(seed, "projects.json", `${JSON.stringify({
    version: 1,
    projects: [
      { id: ALLOWED_PROJECT, title: "Alpha" },
      { id: HIDDEN_PROJECT, title: "Beta" },
    ],
  }, null, 2)}\n`);
  writeFile(seed, `projects/${ALLOWED_PROJECT}/docs/README.md`, "# Alpha\n\nAccepted alpha.\n");
  writeFile(seed, `projects/${HIDDEN_PROJECT}/docs/README.md`, "# Beta\n\nAccepted beta.\n");
  writeFile(seed, HIDDEN_SECRET_PATH, `# Private Beta\n\n${HIDDEN_SECRET_MARKER}\n`);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize hosted scope fixture"]);
  git(seed, ["push", "origin", "main"]);

  initializeContextRoomProject(projectAlpha, { title: "Alpha", allowedPaths: ["README.md"], watchAllow: [] });
  initializeContextRoomProject(projectBeta, { title: "Beta", allowedPaths: ["README.md"], watchAllow: [] });
  connectSharedContext(projectAlpha, { repository: remote, projectId: ALLOWED_PROJECT });
  connectSharedContext(projectBeta, { repository: remote, projectId: HIDDEN_PROJECT });

  const alphaProposal = createSharedProposal(projectAlpha, {
    title: "Visible alpha proposal",
    branch: `proposal/${ALLOWED_PROJECT}/visible-alpha`,
  });
  configureGit(alphaProposal.root);
  writeFile(alphaProposal.root, `projects/${ALLOWED_PROJECT}/docs/README.md`, "# Alpha\n\nVisible alpha proposal.\n");
  const alphaPublished = publishSharedProposal(projectAlpha, { proposal: alphaProposal.branch });

  const betaProposal = createSharedProposal(projectBeta, {
    title: "Hidden beta proposal",
    branch: `proposal/${HIDDEN_PROJECT}/hidden-beta`,
  });
  configureGit(betaProposal.root);
  writeFile(betaProposal.root, HIDDEN_SECRET_PATH, `# Private Beta\n\n${HIDDEN_SECRET_MARKER}\n\nHidden proposal revision.\n`);
  const betaPublished = publishSharedProposal(projectBeta, { proposal: betaProposal.branch });

  // Stabilize Git index state before taking the no-mutation boundary snapshot.
  listSharedProposalWorkspaces(projectAlpha);
  listSharedProposalWorkspaces(projectAlpha);

  room = createMemoryServer({
    root: projectAlpha,
    remoteAccess: {
      expectedHost: REMOTE_HOST,
      humanSecret: HUMAN_SECRET,
      agentSecret: AGENT_SECRET,
      healthSecret: HEALTH_SECRET,
      adminSubjects: ["scope-owner"],
      projectRoots: { [ALLOWED_PROJECT]: projectAlpha },
      sharedRepositories: [{ repository: remote, projectIds: [ALLOWED_PROJECT] }],
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  let tokenSequence = 0;
  const humanHeaders = (operation) => ({
    "content-type": "application/json",
    "x-forwarded-host": REMOTE_HOST,
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "scope-owner",
      role: "admin",
      operations: [operation],
    }, HUMAN_SECRET, { jti: `hosted-scope-human-${operation}-${++tokenSequence}` }),
  });
  const agentHeaders = (operation) => ({
    authorization: `Bearer ${signRemoteIdentity({
      kind: "agent",
      sub: "scope-agent",
      projectId: ALLOWED_PROJECT,
      sessionId: "hosted-scope-session",
      operations: [operation],
    }, AGENT_SECRET, { jti: `hosted-scope-agent-${operation}-${++tokenSequence}` })}`,
    "content-type": "application/json",
    "x-forwarded-host": REMOTE_HOST,
  });

  const warmResponse = await fetch(`${origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: humanHeaders("review"),
    body: "{}",
  });
  const hub = await warmResponse.json();
  assert.equal(warmResponse.status, 200, JSON.stringify(hub));
  assert.equal(hub.proposals.some((proposal) => proposal.branch === alphaProposal.branch), true);
  assert.equal(hub.proposals.some((proposal) => proposal.branch === betaProposal.branch), false);
  assertPayloadOmitsHiddenProject(hub);
  const repositoryId = hub.sharedRepositories?.[0]?.repositoryId || hub.sharedRepositories?.[0]?.id || "";
  assert.ok(repositoryId);

  const catalogResponse = await fetch(`${origin}/api/context-hub/catalog`, { headers: humanHeaders("view") });
  const catalog = await catalogResponse.json();
  assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
  assertPayloadOmitsHiddenProject(catalog);

  const agentCatalogResponse = await fetch(`${origin}/api/agent/proposals?projectId=${ALLOWED_PROJECT}&refresh=0`, {
    headers: agentHeaders("proposal:list"),
  });
  const agentCatalog = await agentCatalogResponse.json();
  assert.equal(agentCatalogResponse.status, 200, JSON.stringify(agentCatalog));
  assert.equal(agentCatalog.proposals?.some((proposal) => proposal.branch === alphaProposal.branch), true);
  assert.equal(agentCatalog.proposals?.some((proposal) => proposal.branch === betaProposal.branch), false);
  assertPayloadOmitsHiddenProject(agentCatalog);

  return {
    alphaProposal,
    alphaPublished,
    agentHeaders,
    base,
    betaProposal,
    betaPublished,
    hubHome,
    humanHeaders,
    origin,
    projectAlpha,
    remote,
    repositoryId,
    reviewAuthorityHome,
    sharedHome,
    snapshotHome,
  };
}

async function jsonRequest(url, options) {
  const response = await fetch(url, options);
  const text = await response.text();
  let payload = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    assert.fail(`Expected JSON from ${url}, received: ${text.slice(0, 500)}`);
  }
  return { response, payload, text };
}

function assertSafeDenied(result, { status, code, fixture }) {
  assert.equal(result.response.status, status, result.text);
  assert.equal(result.payload?.code, code, result.text);
  assert.deepEqual(Object.keys(result.payload || {}).sort(), ["code", "error"]);
  assert.equal("url" in (result.payload || {}), false);
  for (const value of [
    PRIVATE_SENTINEL,
    fixture.base,
    fixture.remote,
    fixture.sharedHome,
    fixture.reviewAuthorityHome,
  ]) {
    assert.equal(result.text.includes(value), false, `Hosted denial leaked ${value}`);
  }
  assertPayloadOmitsHiddenProject(result.payload);
}

function assertPayloadOmitsHiddenProject(payload) {
  const forbidden = [HIDDEN_SECRET_MARKER, HIDDEN_SECRET_PATH];
  const visit = (value, pointer = "$") => {
    if (typeof value === "string") {
      for (const secret of forbidden) {
        assert.equal(value.includes(secret), false, `Hosted response leaked hidden project data at ${pointer}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${pointer}[${index}]`));
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const [key, item] of Object.entries(value)) {
      for (const secret of forbidden) {
        assert.equal(key.includes(secret), false, `Hosted response key leaked hidden project data at ${pointer}`);
      }
      visit(item, `${pointer}.${key}`);
    }
  };
  visit(payload);
}

test("hosted Shared scope denies hidden reviews and agent mutations before filesystem or Git changes", { timeout: 90_000 }, async (t) => {
  const fixture = await setupFixture(t);
  const beforeDeniedRequests = boundarySnapshot(fixture);

  const hiddenReview = await jsonRequest(`${fixture.origin}/api/context-hub/review`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId: fixture.repositoryId,
      proposal: fixture.betaProposal.branch,
      expectedHead: fixture.betaPublished.head,
      marker: PRIVATE_SENTINEL,
    }),
  });
  assertSafeDenied(hiddenReview, {
    status: 404,
    code: "shared_context_proposal_not_found",
    fixture,
  });

  const missingHead = await jsonRequest(`${fixture.origin}/api/context-hub/review`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId: fixture.repositoryId,
      proposal: fixture.alphaProposal.branch,
      marker: PRIVATE_SENTINEL,
    }),
  });
  assertSafeDenied(missingHead, {
    status: 400,
    code: "shared_context_proposal_head_required",
    fixture,
  });

  const staleHead = await jsonRequest(`${fixture.origin}/api/context-hub/review`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId: fixture.repositoryId,
      proposal: fixture.alphaProposal.branch,
      expectedHead: "0".repeat(40),
      marker: PRIVATE_SENTINEL,
    }),
  });
  assertSafeDenied(staleHead, {
    status: 409,
    code: "shared_context_proposal_head_mismatch",
    fixture,
  });

  const hiddenAgentRequests = [
    await jsonRequest(
      `${fixture.origin}/api/agent/proposals/checkout?projectId=${ALLOWED_PROJECT}&proposal=${encodeURIComponent(fixture.betaProposal.branch)}`,
      { headers: fixture.agentHeaders("proposal:checkout") },
    ),
    await jsonRequest(`${fixture.origin}/api/agent/proposals/patch?projectId=${ALLOWED_PROJECT}`, {
      method: "POST",
      headers: fixture.agentHeaders("proposal:write"),
      body: JSON.stringify({
        proposal: fixture.betaProposal.branch,
        path: `projects/${ALLOWED_PROJECT}/docs/README.md`,
        content: PRIVATE_SENTINEL,
        expectedContentHash: "0".repeat(64),
        expectedProposalHead: fixture.betaPublished.head,
        entryType: "file",
      }),
    }),
    await jsonRequest(`${fixture.origin}/api/agent/proposals/publish?projectId=${ALLOWED_PROJECT}`, {
      method: "POST",
      headers: fixture.agentHeaders("proposal:publish"),
      body: JSON.stringify({
        proposal: fixture.betaProposal.branch,
        title: PRIVATE_SENTINEL,
        description: PRIVATE_SENTINEL,
      }),
    }),
  ];
  for (const result of hiddenAgentRequests) {
    assertSafeDenied(result, {
      status: 403,
      code: "agent_project_scope_denied",
      fixture,
    });
  }

  assert.deepEqual(
    boundarySnapshot(fixture),
    beforeDeniedRequests,
    "Denied hosted requests must not create review authority, proposal worktrees, registry entries, cache writes, or refs",
  );

  const outside = path.join(fixture.base, "outside");
  const sentinelPath = path.join(outside, "sentinel.md");
  const escapeLink = path.join(fixture.alphaProposal.root, `projects/${ALLOWED_PROJECT}/docs/escape`);
  const beforeSymlinkSetup = boundarySnapshot(fixture);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(sentinelPath, `${PRIVATE_SENTINEL}\n`, { mode: 0o640 });
  fs.symlinkSync(outside, escapeLink, "dir");
  const sentinelBefore = fs.lstatSync(sentinelPath, { bigint: true });
  const sentinelBytes = fs.readFileSync(sentinelPath);
  const beforeSymlinkRequest = boundarySnapshot(fixture);

  const symlinkParentPatch = await jsonRequest(`${fixture.origin}/api/agent/proposals/patch?projectId=${ALLOWED_PROJECT}`, {
    method: "POST",
    headers: fixture.agentHeaders("proposal:write"),
    body: JSON.stringify({
      proposal: fixture.alphaProposal.branch,
      path: `projects/${ALLOWED_PROJECT}/docs/escape/sentinel.md`,
      content: "attempted overwrite\n",
      expectedContentHash: createHash("sha256").update(sentinelBytes).digest("hex"),
      expectedProposalHead: fixture.alphaPublished.head,
      entryType: "file",
    }),
  });
  assert.equal(symlinkParentPatch.response.status, 403, symlinkParentPatch.text);
  assert.equal(symlinkParentPatch.payload?.code, "agent_path_denied", symlinkParentPatch.text);
  assert.equal(symlinkParentPatch.text.includes(PRIVATE_SENTINEL), false);
  assert.equal(symlinkParentPatch.text.includes(outside), false);
  assertPayloadOmitsHiddenProject(symlinkParentPatch.payload);
  assert.deepEqual(
    boundarySnapshot(fixture),
    beforeSymlinkRequest,
    "A denied symlink-parent patch must not mutate its worktree, caches, registries, authority, snapshots, refs, or project state",
  );
  const sentinelAfter = fs.lstatSync(sentinelPath, { bigint: true });
  assert.deepEqual(fs.readFileSync(sentinelPath), sentinelBytes);
  assert.deepEqual(
    { dev: sentinelAfter.dev, ino: sentinelAfter.ino, mode: sentinelAfter.mode },
    { dev: sentinelBefore.dev, ino: sentinelBefore.ino, mode: sentinelBefore.mode },
  );
  fs.unlinkSync(escapeLink);
  assert.deepEqual(
    boundarySnapshot(fixture),
    beforeSymlinkSetup,
    "Removing the test-only symlink must leave no hosted filesystem residue",
  );

  const allowedReview = await jsonRequest(`${fixture.origin}/api/context-hub/review`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId: fixture.repositoryId,
      proposal: fixture.alphaProposal.branch,
      expectedHead: fixture.alphaPublished.head,
    }),
  });
  assert.equal(allowedReview.response.status, 201, allowedReview.text);
  assert.match(allowedReview.payload?.url || "", /^\/reviews\/[A-Za-z0-9_-]+\/$/);
  assert.equal(allowedReview.payload?.review?.repositoryId, fixture.repositoryId);
  assert.equal(allowedReview.payload?.review?.projectId, ALLOWED_PROJECT);
  assert.equal(allowedReview.payload?.review?.proposal, fixture.alphaProposal.branch);
  assert.equal(allowedReview.payload?.review?.proposalHead, fixture.alphaPublished.head);
  assertPayloadOmitsHiddenProject(allowedReview.payload);

  const reviewApiUrl = new URL("api/shared-context", `${fixture.origin}${allowedReview.payload.url}`).toString();
  const openedReview = await jsonRequest(reviewApiUrl, { headers: fixture.humanHeaders("view") });
  assert.equal(openedReview.response.status, 200, openedReview.text);
  assert.equal(openedReview.payload?.review?.repositoryId, fixture.repositoryId);
  assert.equal(openedReview.payload?.review?.projectId, ALLOWED_PROJECT);
  assert.equal(openedReview.payload?.review?.proposal, fixture.alphaProposal.branch);
  assert.equal(openedReview.payload?.review?.proposalHead, fixture.alphaPublished.head);
  assertPayloadOmitsHiddenProject(openedReview.payload);
});

test("hosted agent routes reject a same-project root connected to an unconfigured repository", { timeout: 90_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-repository-binding-"));
  const configuredRemote = path.join(base, "configured.git");
  const configuredSeed = path.join(base, "configured-seed");
  const unconfiguredRemote = path.join(base, "unconfigured.git");
  const unconfiguredSeed = path.join(base, "unconfigured-seed");
  const gatewayRoot = path.join(base, "gateway-root");
  const home = path.join(base, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  const hubHome = path.join(home, ".context-room", "hub");
  const snapshotHome = path.join(home, ".context-room", "snapshots");
  const reviewAuthorityHome = path.join(home, ".context-room", "review-authority");
  const gitConfig = path.join(base, "gitconfig");
  const secret = "UNCONFIGURED_REPO_SECRET";
  const environmentKeys = [
    "HOME",
    "CONTEXT_ROOM_SHARED_HOME",
    "CONTEXT_ROOM_HUB_HOME",
    "CONTEXT_ROOM_SNAPSHOT_HOME",
    "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME",
    "GIT_CONFIG_GLOBAL",
  ];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  process.env.CONTEXT_ROOM_SNAPSHOT_HOME = snapshotHome;
  process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = reviewAuthorityHome;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(gitConfig, "", "utf8");

  let room = null;
  t.after(async () => {
    if (room?.server.listening) await new Promise((resolve) => room.server.close(resolve));
    restoreEnvironment(previousEnvironment);
    removeWritableTree(base);
  });

  const seedRepository = (remote, seed, marker) => {
    git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    git(base, ["clone", remote, seed], { stdio: "ignore" });
    configureGit(seed);
    initializeSharedRepository(seed, { name: marker });
    writeFile(seed, "projects.json", `${JSON.stringify({
      version: 1,
      projects: [{ id: ALLOWED_PROJECT, title: "Alpha" }],
    }, null, 2)}\n`);
    writeFile(seed, `projects/${ALLOWED_PROJECT}/docs/README.md`, `# Alpha\n\n${marker}\n`);
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", `Initialize ${marker}`]);
    git(seed, ["push", "origin", "main"]);
  };

  seedRepository(configuredRemote, configuredSeed, "configured-repository");
  seedRepository(unconfiguredRemote, unconfiguredSeed, secret);
  fs.mkdirSync(gatewayRoot, { recursive: true });
  initializeContextRoomProject(gatewayRoot, { title: "Gateway root", allowedPaths: ["README.md"], watchAllow: [] });
  connectSharedContext(gatewayRoot, { repository: unconfiguredRemote, projectId: ALLOWED_PROJECT });
  const unconfiguredProposal = createSharedProposal(gatewayRoot, {
    title: "Unconfigured repository proposal",
    branch: `proposal/${ALLOWED_PROJECT}/unconfigured-repository`,
  });
  configureGit(unconfiguredProposal.root);
  writeFile(
    unconfiguredProposal.root,
    `projects/${ALLOWED_PROJECT}/docs/README.md`,
    `# Alpha\n\n${secret}\n\nUnconfigured proposal revision.\n`,
  );
  const published = publishSharedProposal(gatewayRoot, { proposal: unconfiguredProposal.branch });

  room = createMemoryServer({
    root: gatewayRoot,
    remoteAccess: {
      expectedHost: REMOTE_HOST,
      humanSecret: HUMAN_SECRET,
      agentSecret: AGENT_SECRET,
      healthSecret: HEALTH_SECRET,
      adminSubjects: ["repository-binding-owner"],
      projectRoots: { [ALLOWED_PROJECT]: gatewayRoot },
      sharedRepositories: [{ repository: configuredRemote, projectIds: [ALLOWED_PROJECT] }],
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  let tokenSequence = 0;
  const agentHeaders = (operation) => ({
    authorization: `Bearer ${signRemoteIdentity({
      kind: "agent",
      sub: "repository-binding-agent",
      projectId: ALLOWED_PROJECT,
      sessionId: "repository-binding-session",
      operations: [operation],
    }, AGENT_SECRET, { jti: `repository-binding-${operation}-${++tokenSequence}` })}`,
    "x-forwarded-host": REMOTE_HOST,
  });
  const beforeDeniedRequests = {
    sharedHome: treeSnapshot(sharedHome),
    gatewayState: treeSnapshot(path.join(gatewayRoot, ".context-room")),
    unconfiguredRefs: treeSnapshot(path.join(unconfiguredRemote, "refs")),
  };

  const deniedRequests = [
    await jsonRequest(`${origin}/api/agent/accepted?projectId=${ALLOWED_PROJECT}&refresh=0`, {
      headers: agentHeaders("accepted:read"),
    }),
    await jsonRequest(`${origin}/api/agent/proposals?projectId=${ALLOWED_PROJECT}&refresh=0`, {
      headers: agentHeaders("proposal:list"),
    }),
    await jsonRequest(
      `${origin}/api/agent/proposals/checkout?projectId=${ALLOWED_PROJECT}&proposal=${encodeURIComponent(unconfiguredProposal.branch)}`,
      { headers: agentHeaders("proposal:checkout") },
    ),
  ];

  for (const result of deniedRequests) {
    assert.equal(result.response.status, 403, result.text);
    assert.equal(result.payload?.code, "agent_project_scope_denied", result.text);
    assert.deepEqual(Object.keys(result.payload || {}).sort(), ["code", "error"]);
    for (const forbidden of [secret, base, configuredRemote, unconfiguredRemote, published.head]) {
      assert.equal(result.text.includes(forbidden), false, `Hosted denial leaked ${forbidden}`);
    }
  }
  assert.deepEqual(
    {
      sharedHome: treeSnapshot(sharedHome),
      gatewayState: treeSnapshot(path.join(gatewayRoot, ".context-room")),
      unconfiguredRefs: treeSnapshot(path.join(unconfiguredRemote, "refs")),
    },
    beforeDeniedRequests,
    "Repository-binding denials must happen before cache, connection, worktree, or Git mutations",
  );
});

test("hosted scope rejects copy sources outside the proposal project before listing or materialization", { timeout: 90_000 }, async (t) => {
  const fixture = await setupFixture(t);
  const attacker = path.join(fixture.base, "out-of-scope-copy");
  const branch = `proposal/${ALLOWED_PROJECT}/copied-beta-secret`;
  const leakPath = `projects/${ALLOWED_PROJECT}/docs/LEAK.md`;
  git(fixture.base, ["clone", fixture.remote, attacker], { stdio: "ignore" });
  configureGit(attacker);
  git(attacker, ["checkout", "-b", branch, "origin/main"]);
  writeFile(attacker, leakPath, fs.readFileSync(path.join(attacker, HIDDEN_SECRET_PATH), "utf8"));
  git(attacker, ["add", leakPath]);
  git(attacker, ["commit", "-m", "Copy hidden project document into alpha"]);
  const maliciousHead = git(attacker, ["rev-parse", "HEAD"]);
  git(attacker, ["push", "origin", `HEAD:refs/heads/${branch}`]);

  const refreshed = await jsonRequest(`${fixture.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: "{}",
  });
  assert.equal(refreshed.response.status, 200, refreshed.text);
  assert.equal(refreshed.payload?.proposals?.some((proposal) => proposal.branch === branch), false);
  for (const forbidden of [HIDDEN_SECRET_MARKER, HIDDEN_SECRET_PATH, leakPath, maliciousHead]) {
    assert.equal(refreshed.text.includes(forbidden), false, `Hosted refresh leaked ${forbidden}`);
  }

  const beforeDeniedRequests = {
    reviewAuthority: treeSnapshot(fixture.reviewAuthorityHome),
    reviewWorktrees: namedTreeSnapshots(fixture.sharedHome, "reviews"),
    remoteRefs: treeSnapshot(path.join(fixture.remote, "refs")),
    projectState: treeSnapshot(path.join(fixture.projectAlpha, ".context-room")),
  };
  const hub = await jsonRequest(`${fixture.origin}/api/context-hub`, {
    headers: fixture.humanHeaders("view"),
  });
  const catalog = await jsonRequest(`${fixture.origin}/api/context-hub/catalog`, {
    headers: fixture.humanHeaders("view"),
  });
  const agentList = await jsonRequest(`${fixture.origin}/api/agent/proposals?projectId=${ALLOWED_PROJECT}&refresh=0`, {
    headers: fixture.agentHeaders("proposal:list"),
  });
  for (const result of [hub, catalog, agentList]) {
    assert.equal(result.response.status, 200, result.text);
    assert.equal((result.payload?.proposals || []).some((proposal) => proposal.branch === branch), false);
    for (const forbidden of [HIDDEN_SECRET_MARKER, HIDDEN_SECRET_PATH, leakPath, maliciousHead]) {
      assert.equal(result.text.includes(forbidden), false, `Hosted projection leaked ${forbidden}`);
    }
  }

  const checkout = await jsonRequest(
    `${fixture.origin}/api/agent/proposals/checkout?projectId=${ALLOWED_PROJECT}&proposal=${encodeURIComponent(branch)}`,
    { headers: fixture.agentHeaders("proposal:checkout") },
  );
  const publish = await jsonRequest(`${fixture.origin}/api/agent/proposals/publish?projectId=${ALLOWED_PROJECT}`, {
    method: "POST",
    headers: fixture.agentHeaders("proposal:publish"),
    body: JSON.stringify({ proposal: branch, title: "Denied copy", description: PRIVATE_SENTINEL }),
  });
  for (const result of [checkout, publish]) {
    assertSafeDenied(result, {
      status: 403,
      code: "agent_project_scope_denied",
      fixture,
    });
    assert.equal(result.text.includes(leakPath), false);
    assert.equal(result.text.includes(maliciousHead), false);
  }

  const review = await jsonRequest(`${fixture.origin}/api/context-hub/review`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId: fixture.repositoryId,
      proposal: branch,
      expectedHead: maliciousHead,
      marker: PRIVATE_SENTINEL,
    }),
  });
  assertSafeDenied(review, {
    status: 404,
    code: "shared_context_proposal_not_found",
    fixture,
  });
  assert.equal(review.text.includes(leakPath), false);
  assert.equal(review.text.includes(maliciousHead), false);

  assert.deepEqual({
    reviewAuthority: treeSnapshot(fixture.reviewAuthorityHome),
    reviewWorktrees: namedTreeSnapshots(fixture.sharedHome, "reviews"),
    remoteRefs: treeSnapshot(path.join(fixture.remote, "refs")),
    projectState: treeSnapshot(path.join(fixture.projectAlpha, ".context-room")),
  }, beforeDeniedRequests, "An out-of-scope copy must be rejected before review authority, review worktree, project, or ref mutations");
});

test("hosted agent exact-head selectors fail closed when the proposal advances after provider resolution", { timeout: 90_000 }, async (t) => {
  const fixture = await setupFixture(t);
  const collaborator = path.join(fixture.base, "exact-head-collaborator");
  const branch = `proposal/${ALLOWED_PROJECT}/exact-head-race`;
  const documentPath = `projects/${ALLOWED_PROJECT}/docs/README.md`;
  const h1Content = "# Alpha\n\nExact cached head H1.\n";
  const h2Marker = "ADVANCED_HEAD_H2_MUST_NOT_BE_SUBSTITUTED";
  git(fixture.base, ["clone", fixture.remote, collaborator], { stdio: "ignore" });
  configureGit(collaborator);
  git(collaborator, ["checkout", "-b", branch, "origin/main"]);
  writeFile(collaborator, documentPath, h1Content);
  git(collaborator, ["add", documentPath]);
  git(collaborator, ["commit", "-m", "Publish exact head H1"]);
  const h1 = git(collaborator, ["rev-parse", "HEAD"]);
  git(collaborator, ["push", "origin", `HEAD:refs/heads/${branch}`]);

  const warmed = await jsonRequest(`${fixture.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: "{}",
  });
  assert.equal(warmed.response.status, 200, warmed.text);
  assert.equal(warmed.payload?.proposals?.some((proposal) => proposal.branch === branch && proposal.head === h1), true);

  writeFile(collaborator, documentPath, `# Alpha\n\n${h2Marker}\n`);
  git(collaborator, ["add", documentPath]);
  git(collaborator, ["commit", "-m", "Advance proposal to H2"]);
  const h2 = git(collaborator, ["rev-parse", "HEAD"]);
  assert.notEqual(h2, h1);
  git(collaborator, ["push", "origin", `HEAD:refs/heads/${branch}`]);

  const before = {
    proposalWorktrees: namedTreeSnapshots(fixture.sharedHome, "proposals"),
    reviewAuthority: treeSnapshot(fixture.reviewAuthorityHome),
    reviewWorktrees: namedTreeSnapshots(fixture.sharedHome, "reviews"),
    projectState: treeSnapshot(path.join(fixture.projectAlpha, ".context-room")),
    remoteRefs: treeSnapshot(path.join(fixture.remote, "refs")),
  };
  const requests = [
    await jsonRequest(
      `${fixture.origin}/api/proposal/context-impact?repositoryId=${encodeURIComponent(fixture.repositoryId)}&selector=${h1}`,
      { headers: fixture.humanHeaders("view") },
    ),
    await jsonRequest(`${fixture.origin}/api/context-hub/review`, {
      method: "POST",
      headers: fixture.humanHeaders("review"),
      body: JSON.stringify({
        repositoryId: fixture.repositoryId,
        proposal: branch,
        expectedHead: h1,
        marker: PRIVATE_SENTINEL,
      }),
    }),
    await jsonRequest(
      `${fixture.origin}/api/agent/proposals/checkout?projectId=${ALLOWED_PROJECT}&proposal=${h1}`,
      { headers: fixture.agentHeaders("proposal:checkout") },
    ),
    await jsonRequest(`${fixture.origin}/api/agent/proposals/patch?projectId=${ALLOWED_PROJECT}`, {
      method: "POST",
      headers: fixture.agentHeaders("proposal:write"),
      body: JSON.stringify({
        proposal: h1,
        path: documentPath,
        content: "# Alpha\n\nAgent must not patch a substituted head.\n",
        expectedContentHash: createHash("sha256").update(h1Content).digest("hex"),
        expectedProposalHead: h1,
        entryType: "file",
      }),
    }),
    await jsonRequest(`${fixture.origin}/api/agent/proposals/publish?projectId=${ALLOWED_PROJECT}`, {
      method: "POST",
      headers: fixture.agentHeaders("proposal:publish"),
      body: JSON.stringify({
        proposal: h1,
        expectedProposalHead: h1,
        title: "Stale exact head must not publish",
        description: PRIVATE_SENTINEL,
      }),
    }),
  ];
  for (const result of requests) {
    assert.equal([403, 409].includes(result.response.status), true, result.text);
    assert.equal(typeof result.payload?.code, "string", result.text);
    assert.equal(result.text.includes(h2Marker), false);
  }
  assert.deepEqual({
    proposalWorktrees: namedTreeSnapshots(fixture.sharedHome, "proposals"),
    reviewAuthority: treeSnapshot(fixture.reviewAuthorityHome),
    reviewWorktrees: namedTreeSnapshots(fixture.sharedHome, "reviews"),
    projectState: treeSnapshot(path.join(fixture.projectAlpha, ".context-room")),
    remoteRefs: treeSnapshot(path.join(fixture.remote, "refs")),
  }, before, "Stale exact-head operations must not create a worktree, edit registries, or move remote refs");
});

test("hosted agent stale patches return the same error before and after proposal checkout", { timeout: 90_000 }, async (t) => {
  const fixture = await setupFixture(t);
  const collaborator = path.join(fixture.base, "stale-patch-collaborator");
  const branch = `proposal/${ALLOWED_PROJECT}/stale-patch-cache-parity`;
  const documentPath = `projects/${ALLOWED_PROJECT}/docs/README.md`;
  const h1Content = "# Alpha\n\nStale patch cache parity H1.\n";
  git(fixture.base, ["clone", fixture.remote, collaborator], { stdio: "ignore" });
  configureGit(collaborator);
  git(collaborator, ["checkout", "-b", branch, "origin/main"]);
  writeFile(collaborator, documentPath, h1Content);
  git(collaborator, ["add", documentPath]);
  git(collaborator, ["commit", "-m", "Publish stale patch cache parity H1"]);
  const h1 = git(collaborator, ["rev-parse", "HEAD"]);
  const staleHead = "0".repeat(40);
  assert.notEqual(h1, staleHead);
  git(collaborator, ["push", "origin", `HEAD:refs/heads/${branch}`]);

  const warmed = await jsonRequest(`${fixture.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: "{}",
  });
  assert.equal(warmed.response.status, 200, warmed.text);
  assert.equal(warmed.payload?.proposals?.some((proposal) => proposal.branch === branch && proposal.head === h1), true);

  const patchBody = JSON.stringify({
    proposal: branch,
    path: documentPath,
    content: "# Alpha\n\nThis stale patch must never be written.\n",
    expectedContentHash: createHash("sha256").update(h1Content).digest("hex"),
    expectedProposalHead: staleHead,
    entryType: "file",
  });
  const patchRequest = () => jsonRequest(`${fixture.origin}/api/agent/proposals/patch?projectId=${ALLOWED_PROJECT}`, {
    method: "POST",
    headers: fixture.agentHeaders("proposal:write"),
    body: patchBody,
  });

  const beforeUncachedPatch = boundarySnapshot(fixture);
  const uncached = await patchRequest();
  assert.equal(uncached.response.status, 409, uncached.text);
  assert.equal(uncached.payload?.code, "agent_proposal_stale", uncached.text);
  assert.deepEqual(boundarySnapshot(fixture), beforeUncachedPatch, "An uncached stale patch must not mutate repositories, registries, or Hosted caches");

  const checkout = await jsonRequest(
    `${fixture.origin}/api/agent/proposals/checkout?projectId=${ALLOWED_PROJECT}&proposal=${encodeURIComponent(branch)}`,
    { headers: fixture.agentHeaders("proposal:checkout") },
  );
  assert.equal(checkout.response.status, 200, checkout.text);
  assert.equal(checkout.payload?.proposal?.branch, branch);
  assert.equal(checkout.payload?.proposal?.head, h1);

  const beforeCachedPatch = boundarySnapshot(fixture);
  const cached = await patchRequest();
  assert.equal(cached.response.status, 409, cached.text);
  assert.equal(cached.payload?.code, "agent_proposal_stale", cached.text);
  assert.deepEqual(boundarySnapshot(fixture), beforeCachedPatch, "A cached stale patch must not mutate repositories, registries, or Hosted caches");
  assert.equal(git(fixture.base, ["--git-dir", fixture.remote, "rev-parse", `refs/heads/${branch}`]), h1);
});

test("hosted agent can immediately checkout the exact head advertised by a refreshed proposal list", { timeout: 90_000 }, async (t) => {
  const fixture = await setupFixture(t);
  const collaborator = path.join(fixture.base, "agent-list-collaborator");
  const branch = `proposal/${ALLOWED_PROJECT}/agent-list-exact-head`;
  const documentPath = `projects/${ALLOWED_PROJECT}/docs/README.md`;
  const h1Marker = "AGENT_LIST_CACHED_H1_MUST_NOT_REAPPEAR";
  const h2Marker = "AGENT_LIST_ADVERTISED_H2_CONTENT";
  git(fixture.base, ["clone", fixture.remote, collaborator], { stdio: "ignore" });
  configureGit(collaborator);
  git(collaborator, ["checkout", "-b", branch, "origin/main"]);
  writeFile(collaborator, documentPath, `# Alpha\n\n${h1Marker}\n`);
  git(collaborator, ["add", documentPath]);
  git(collaborator, ["commit", "-m", "Publish agent list head H1"]);
  const h1 = git(collaborator, ["rev-parse", "HEAD"]);
  git(collaborator, ["push", "origin", `HEAD:refs/heads/${branch}`]);

  const warmed = await jsonRequest(`${fixture.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: "{}",
  });
  assert.equal(warmed.response.status, 200, warmed.text);
  assert.equal(warmed.payload?.proposals?.some((proposal) => proposal.branch === branch && proposal.head === h1), true);

  writeFile(collaborator, documentPath, `# Alpha\n\n${h2Marker}\n`);
  git(collaborator, ["add", documentPath]);
  git(collaborator, ["commit", "-m", "Advance agent list proposal to H2"]);
  const h2 = git(collaborator, ["rev-parse", "HEAD"]);
  assert.notEqual(h2, h1);
  git(collaborator, ["push", "origin", `HEAD:refs/heads/${branch}`]);

  const listed = await jsonRequest(`${fixture.origin}/api/agent/proposals?projectId=${ALLOWED_PROJECT}&refresh=1`, {
    headers: fixture.agentHeaders("proposal:list"),
  });
  assert.equal(listed.response.status, 200, listed.text);
  const advertised = listed.payload?.proposals?.find((proposal) => proposal.branch === branch);
  assert.equal(advertised?.head, h2, listed.text);
  assertPayloadOmitsHiddenProject(listed.payload);

  const checkout = await jsonRequest(
    `${fixture.origin}/api/agent/proposals/checkout?projectId=${ALLOWED_PROJECT}&proposal=${h2}`,
    { headers: fixture.agentHeaders("proposal:checkout") },
  );
  assert.equal(checkout.response.status, 200, checkout.text);
  assert.equal(checkout.payload?.projectId, ALLOWED_PROJECT);
  assert.equal(checkout.payload?.proposal?.branch, branch);
  assert.equal(checkout.payload?.proposal?.head, h2);
  const openedDocument = checkout.payload?.files?.find((file) => file.path === documentPath);
  assert.equal(openedDocument?.content, `# Alpha\n\n${h2Marker}\n`);
  assert.equal(checkout.text.includes(h1Marker), false);
  assert.equal(checkout.payload?.files?.every((file) => (
    file.path.startsWith(`projects/${ALLOWED_PROJECT}/docs/`)
    || file.path.startsWith(`projects/${ALLOWED_PROJECT}/skills/`)
  )), true, checkout.text);
  assertPayloadOmitsHiddenProject(checkout.payload);
  assert.equal(git(fixture.base, ["--git-dir", fixture.remote, "rev-parse", `refs/heads/${branch}`]), h2);
});

test("hosted Shared configuration rejects project IDs reserved for special proposal scopes", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-reserved-project-"));
  t.after(() => removeWritableTree(base));
  for (const projectId of ["global", "skills", "instructions"]) {
    const root = path.join(base, projectId);
    fs.mkdirSync(root, { recursive: true });
    initializeContextRoomProject(root, { title: projectId, allowedPaths: [], watchAllow: [] });
    assert.throws(() => createMemoryServer({
      root,
      remoteAccess: {
        expectedHost: REMOTE_HOST,
        humanSecret: HUMAN_SECRET,
        agentSecret: AGENT_SECRET,
        healthSecret: HEALTH_SECRET,
        adminSubjects: ["reserved-project-owner"],
        projectRoots: { [projectId]: root },
        sharedRepositories: [{
          repository: "https://github.com/example/context-room-shared.git",
          projectIds: [projectId],
        }],
      },
    }), (error) => {
      assert.match(String(error?.message || ""), /reserved|special proposal scope/i);
      assert.match(String(error?.message || ""), new RegExp(projectId, "i"));
      return true;
    });
  }
});

test("hosted special Shared scopes are explicit per repository and remain human-only", { timeout: 120_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-special-scopes-"));
  const home = path.join(base, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  const hubHome = path.join(home, ".context-room", "hub");
  const snapshotHome = path.join(home, ".context-room", "snapshots");
  const reviewAuthorityHome = path.join(home, ".context-room", "review-authority");
  const gitConfig = path.join(base, "gitconfig");
  const environmentKeys = [
    "HOME",
    "CONTEXT_ROOM_SHARED_HOME",
    "CONTEXT_ROOM_HUB_HOME",
    "CONTEXT_ROOM_SNAPSHOT_HOME",
    "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME",
    "GIT_CONFIG_GLOBAL",
  ];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  process.env.CONTEXT_ROOM_SNAPSHOT_HOME = snapshotHome;
  process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = reviewAuthorityHome;
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(gitConfig, "", "utf8");

  let room = null;
  t.after(async () => {
    if (room?.server.listening) await new Promise((resolve) => room.server.close(resolve));
    restoreEnvironment(previousEnvironment);
    removeWritableTree(base);
  });

  const createScopedRepository = (label, projectId) => {
    const remote = path.join(base, `${label}.git`);
    const seed = path.join(base, `${label}-seed`);
    const projectRoot = path.join(base, `${label}-project`);
    const skillCollectionPath = `collections/${label}-skills`;
    const instructionCollectionPath = `instructions/${label}`;
    const instructionPath = `${instructionCollectionPath}/AGENTS.md`;
    git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
    git(base, ["clone", remote, seed], { stdio: "ignore" });
    configureGit(seed);
    initializeSharedRepository(seed, { name: `Hosted scopes ${label}` });
    writeFile(seed, "projects.json", `${JSON.stringify({
      version: 1,
      projects: [{ id: projectId, title: `Project ${label}` }],
    }, null, 2)}\n`);
    writeFile(seed, `projects/${projectId}/docs/README.md`, `# ${label}\n\nAccepted ${label}.\n`);
    writeFile(seed, "skill-locations.json", `${JSON.stringify({
      version: 1,
      collections: [{ id: `${label}-skills`, title: `${label} skills`, path: skillCollectionPath }],
      assignments: [{
        id: `${label}-skills-device`,
        collectionId: `${label}-skills`,
        scope: "device",
        providers: ["codex"],
        include: ["*"],
        exclude: [],
      }],
    }, null, 2)}\n`);
    writeFile(seed, `${skillCollectionPath}/base/SKILL.md`, `# ${label} base skill\n`);
    writeFile(seed, "instruction-locations.json", `${JSON.stringify({
      version: 1,
      collections: [{ id: `${label}-instructions`, title: `${label} instructions`, path: instructionCollectionPath }],
      assignments: [{
        id: `${label}-instructions-shared`,
        collectionId: `${label}-instructions`,
        scope: "shared",
        files: [{ source: instructionPath, target: `${label}-AGENTS.md`, providers: ["codex"] }],
      }],
    }, null, 2)}\n`);
    writeFile(seed, instructionPath, `# ${label} accepted instructions\n`);
    git(seed, ["add", "."]);
    git(seed, ["commit", "-m", `Initialize ${label} scoped repository`]);
    git(seed, ["push", "origin", "main"]);

    fs.mkdirSync(projectRoot, { recursive: true });
    initializeContextRoomProject(projectRoot, { title: `Project ${label}`, allowedPaths: ["README.md"], watchAllow: [] });
    connectSharedContext(projectRoot, { repository: remote, projectId });

    const proposals = {};
    for (const scope of ["project", "global", "skills", "instructions"]) {
      const scopeId = scope === "project" ? projectId : scope;
      const marker = `${label.toUpperCase().replaceAll("-", "_")}_${scope.toUpperCase()}_SCOPE_SECRET`;
      const proposal = createSharedProposal(projectRoot, {
        title: `${label} ${scope} ${marker}`,
        description: `Boundary marker ${marker} must follow its exact repository scope grant.`,
        scope,
        branch: `proposal/${scopeId}/${label}-${scope}`,
      });
      configureGit(proposal.root);
      let proposalPath = "";
      if (scope === "project") {
        proposalPath = `projects/${projectId}/docs/README.md`;
        writeFile(proposal.root, proposalPath, `# ${label}\n\n${marker}\n`);
      } else if (scope === "global") {
        proposalPath = `skills/global/${label}-global/SKILL.md`;
        writeFile(proposal.root, proposalPath, `# ${marker}\n`);
      } else if (scope === "skills") {
        proposalPath = `${skillCollectionPath}/${label}-proposal/SKILL.md`;
        writeFile(proposal.root, proposalPath, `# ${marker}\n`);
      } else {
        proposalPath = instructionPath;
        writeFile(proposal.root, proposalPath, `# ${marker}\n`);
      }
      const published = publishSharedProposal(projectRoot, { proposal: proposal.branch });
      proposals[scope] = {
        branch: proposal.branch,
        head: published.head,
        marker,
        path: proposalPath,
        scope,
      };
    }
    return { label, projectId, projectRoot, proposals, remote };
  };

  const repositoryA = createScopedRepository("repo-a", "scope-alpha");
  const repositoryB = createScopedRepository("repo-b", "scope-beta");
  // Stabilize proposal registries before asserting that denied calls do not materialize anything.
  listSharedProposalWorkspaces(repositoryB.projectRoot);
  listSharedProposalWorkspaces(repositoryB.projectRoot);

  room = createMemoryServer({
    root: repositoryB.projectRoot,
    remoteAccess: {
      expectedHost: REMOTE_HOST,
      humanSecret: HUMAN_SECRET,
      agentSecret: AGENT_SECRET,
      healthSecret: HEALTH_SECRET,
      adminSubjects: ["special-scope-owner"],
      projectRoots: {
        [repositoryA.projectId]: repositoryA.projectRoot,
        [repositoryB.projectId]: repositoryB.projectRoot,
      },
      sharedRepositories: [
        { repository: repositoryA.remote, projectIds: [repositoryA.projectId] },
        {
          repository: repositoryB.remote,
          projectIds: [repositoryB.projectId],
          scopes: ["global", "instructions"],
        },
      ],
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  let tokenSequence = 0;
  const humanHeaders = (operation) => ({
    "content-type": "application/json",
    "x-forwarded-host": REMOTE_HOST,
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "special-scope-owner",
      role: "admin",
      operations: [operation],
    }, HUMAN_SECRET, { jti: `special-scope-human-${operation}-${++tokenSequence}` }),
  });
  const agentHeaders = (operation) => ({
    authorization: `Bearer ${signRemoteIdentity({
      kind: "agent",
      sub: "special-scope-agent",
      projectId: repositoryB.projectId,
      sessionId: "special-scope-session",
      operations: [operation],
    }, AGENT_SECRET, { jti: `special-scope-agent-${operation}-${++tokenSequence}` })}`,
    "content-type": "application/json",
    "x-forwarded-host": REMOTE_HOST,
  });

  const warmed = await jsonRequest(`${origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: humanHeaders("review"),
    body: "{}",
  });
  assert.equal(warmed.response.status, 200, warmed.text);
  assert.deepEqual(warmed.payload?.repositoryErrors || [], [], warmed.text);
  assert.equal((warmed.payload?.proposals || []).length > 0, true, warmed.text);
  const hub = await jsonRequest(`${origin}/api/context-hub`, { headers: humanHeaders("view") });
  const catalog = await jsonRequest(`${origin}/api/context-hub/catalog`, { headers: humanHeaders("view") });
  assert.equal(hub.response.status, 200, hub.text);
  assert.equal(catalog.response.status, 200, catalog.text);
  const repositoryRecordA = hub.payload?.sharedRepositories?.find((entry) => (
    entry.projects?.some((project) => project.id === repositoryA.projectId)
  ));
  const repositoryRecordB = hub.payload?.sharedRepositories?.find((entry) => (
    entry.projects?.some((project) => project.id === repositoryB.projectId)
  ));
  assert.ok(repositoryRecordA?.repositoryId);
  assert.ok(repositoryRecordB?.repositoryId);
  assert.notEqual(repositoryRecordA.repositoryId, repositoryRecordB.repositoryId);
  assert.deepEqual(repositoryRecordA.scopes, []);
  assert.deepEqual(repositoryRecordB.scopes, ["global", "instructions"]);

  const visibleSpecialProposals = (hub.payload?.proposals || [])
    .filter((proposal) => proposal.scope !== "project")
    .map((proposal) => `${proposal.repositoryId}:${proposal.scope}:${proposal.branch}`)
    .sort();
  assert.deepEqual(visibleSpecialProposals, [
    `${repositoryRecordB.repositoryId}:global:${repositoryB.proposals.global.branch}`,
    `${repositoryRecordB.repositoryId}:instructions:${repositoryB.proposals.instructions.branch}`,
  ].sort());
  for (const repository of [repositoryA, repositoryB]) {
    assert.equal(
      hub.payload?.proposals?.some((proposal) => proposal.branch === repository.proposals.project.branch),
      true,
      `${repository.label} project proposals must remain governed by projectIds`,
    );
  }
  const visibleSpecialCatalogProjects = (catalog.payload?.projects || [])
    .filter((project) => ["global", "skills", "instructions"].includes(project.logicalProjectId))
    .map((project) => `${project.shared?.repositoryId}:${project.logicalProjectId}`)
    .sort();
  assert.deepEqual(visibleSpecialCatalogProjects, [
    `${repositoryRecordB.repositoryId}:global`,
    `${repositoryRecordB.repositoryId}:instructions`,
  ].sort());
  const catalogRepositoryA = catalog.payload?.sharedRepositories?.find((entry) => entry.repositoryId === repositoryRecordA.repositoryId);
  const catalogRepositoryB = catalog.payload?.sharedRepositories?.find((entry) => entry.repositoryId === repositoryRecordB.repositoryId);
  assert.deepEqual(catalogRepositoryA?.scopes, []);
  assert.deepEqual(catalogRepositoryB?.scopes, ["global", "instructions"]);

  const deniedProposals = [
    ...["global", "skills", "instructions"].map((scope) => ({
      ...repositoryA.proposals[scope],
      repositoryId: repositoryRecordA.repositoryId,
    })),
    { ...repositoryB.proposals.skills, repositoryId: repositoryRecordB.repositoryId },
  ];
  const deniedSecrets = deniedProposals.flatMap((proposal) => [
    proposal.branch,
    proposal.head,
    proposal.marker,
    proposal.path,
  ]);
  const assertOmitsDeniedScopes = (result, label) => {
    for (const secret of deniedSecrets) {
      assert.equal(result.text.includes(secret), false, `${label} leaked denied scope data: ${secret}`);
    }
  };
  assertOmitsDeniedScopes(hub, "Hub");
  assertOmitsDeniedScopes(catalog, "Catalog");

  const listedForAgent = await jsonRequest(
    `${origin}/api/agent/proposals?projectId=${repositoryB.projectId}&refresh=0`,
    { headers: agentHeaders("proposal:list") },
  );
  assert.equal(listedForAgent.response.status, 200, listedForAgent.text);
  assert.deepEqual(
    (listedForAgent.payload?.proposals || []).map((proposal) => proposal.branch),
    [repositoryB.proposals.project.branch],
  );
  assert.equal((listedForAgent.payload?.proposals || []).every((proposal) => proposal.scope === "project"), true);
  assertOmitsDeniedScopes(listedForAgent, "Agent proposal list");
  for (const proposal of [repositoryB.proposals.global, repositoryB.proposals.instructions]) {
    for (const secret of [proposal.branch, proposal.head, proposal.marker, proposal.path]) {
      assert.equal(listedForAgent.text.includes(secret), false, `Agent proposal list leaked human-only scope data: ${secret}`);
    }
  }

  const beforeDeniedRequests = {
    proposalWorktrees: namedTreeSnapshots(sharedHome, "proposals"),
    reviewAuthority: treeSnapshot(reviewAuthorityHome),
    reviewWorktrees: namedTreeSnapshots(sharedHome, "reviews"),
    projectAState: treeSnapshot(path.join(repositoryA.projectRoot, ".context-room")),
    projectBState: treeSnapshot(path.join(repositoryB.projectRoot, ".context-room")),
    repositoryARefs: treeSnapshot(path.join(repositoryA.remote, "refs")),
    repositoryBRefs: treeSnapshot(path.join(repositoryB.remote, "refs")),
  };

  for (const proposal of deniedProposals) {
    const impact = await jsonRequest(
      `${origin}/api/proposal/context-impact?repositoryId=${encodeURIComponent(proposal.repositoryId)}&selector=${encodeURIComponent(proposal.branch)}`,
      { headers: humanHeaders("view") },
    );
    assert.equal(impact.response.status, 404, impact.text);
    assert.equal(impact.payload?.code, "shared_context_proposal_not_found", impact.text);
    assert.deepEqual(Object.keys(impact.payload || {}).sort(), ["code", "error"]);
    assertOmitsDeniedScopes(impact, "Denied impact");

    const review = await jsonRequest(`${origin}/api/context-hub/review`, {
      method: "POST",
      headers: humanHeaders("review"),
      body: JSON.stringify({
        repositoryId: proposal.repositoryId,
        proposal: proposal.branch,
        expectedHead: proposal.head,
        marker: PRIVATE_SENTINEL,
      }),
    });
    assert.equal(review.response.status, 404, review.text);
    assert.equal(review.payload?.code, "shared_context_proposal_not_found", review.text);
    assert.deepEqual(Object.keys(review.payload || {}).sort(), ["code", "error"]);
    assertOmitsDeniedScopes(review, "Denied review");
  }

  const agentDeniedTargets = [
    ...deniedProposals,
    { ...repositoryB.proposals.global, repositoryId: repositoryRecordB.repositoryId },
    { ...repositoryB.proposals.instructions, repositoryId: repositoryRecordB.repositoryId },
  ];
  for (const proposal of agentDeniedTargets) {
    const checkout = await jsonRequest(
      `${origin}/api/agent/proposals/checkout?projectId=${repositoryB.projectId}&proposal=${encodeURIComponent(proposal.branch)}`,
      { headers: agentHeaders("proposal:checkout") },
    );
    assert.equal(checkout.response.status, 403, checkout.text);
    assert.equal(checkout.payload?.code, "agent_project_scope_denied", checkout.text);
    assert.deepEqual(Object.keys(checkout.payload || {}).sort(), ["code", "error"]);
    for (const secret of [proposal.head, proposal.marker, proposal.path]) {
      assert.equal(checkout.text.includes(secret), false, `Agent checkout denial leaked ${secret}`);
    }
  }
  const spoofedSpecialProject = await jsonRequest(`${origin}/api/agent/proposals?projectId=global&refresh=0`, {
    headers: agentHeaders("proposal:list"),
  });
  assert.equal(spoofedSpecialProject.response.status, 403, spoofedSpecialProject.text);
  assert.equal(spoofedSpecialProject.payload?.code, "agent_project_scope_denied", spoofedSpecialProject.text);
  assertOmitsDeniedScopes(spoofedSpecialProject, "Spoofed special project");

  const patchSpecial = await jsonRequest(`${origin}/api/agent/proposals/patch?projectId=${repositoryB.projectId}`, {
    method: "POST",
    headers: agentHeaders("proposal:write"),
    body: JSON.stringify({
      proposal: repositoryB.proposals.global.branch,
      path: `projects/${repositoryB.projectId}/docs/README.md`,
      content: "Agent must not edit a human-only special scope.\n",
      expectedContentHash: "0".repeat(64),
      expectedProposalHead: repositoryB.proposals.global.head,
      entryType: "file",
    }),
  });
  const publishSpecial = await jsonRequest(`${origin}/api/agent/proposals/publish?projectId=${repositoryB.projectId}`, {
    method: "POST",
    headers: agentHeaders("proposal:publish"),
    body: JSON.stringify({
      proposal: repositoryB.proposals.instructions.branch,
      expectedProposalHead: repositoryB.proposals.instructions.head,
      title: "Agent must not publish a human-only special scope",
      description: PRIVATE_SENTINEL,
    }),
  });
  for (const result of [patchSpecial, publishSpecial]) {
    assert.equal(result.response.status, 403, result.text);
    assert.equal(result.payload?.code, "agent_project_scope_denied", result.text);
    assert.deepEqual(Object.keys(result.payload || {}).sort(), ["code", "error"]);
    assertOmitsDeniedScopes(result, "Agent special-scope mutation");
  }

  assert.deepEqual({
    proposalWorktrees: namedTreeSnapshots(sharedHome, "proposals"),
    reviewAuthority: treeSnapshot(reviewAuthorityHome),
    reviewWorktrees: namedTreeSnapshots(sharedHome, "reviews"),
    projectAState: treeSnapshot(path.join(repositoryA.projectRoot, ".context-room")),
    projectBState: treeSnapshot(path.join(repositoryB.projectRoot, ".context-room")),
    repositoryARefs: treeSnapshot(path.join(repositoryA.remote, "refs")),
    repositoryBRefs: treeSnapshot(path.join(repositoryB.remote, "refs")),
  }, beforeDeniedRequests, "Denied special scopes must fail before proposal or review materialization and before project or Git mutations");

  for (const proposal of [repositoryB.proposals.global, repositoryB.proposals.instructions]) {
    const impact = await jsonRequest(
      `${origin}/api/proposal/context-impact?repositoryId=${encodeURIComponent(repositoryRecordB.repositoryId)}&selector=${encodeURIComponent(proposal.branch)}`,
      { headers: humanHeaders("view") },
    );
    assert.equal(impact.response.status, 200, impact.text);
    assert.equal(impact.payload?.repositoryId, repositoryRecordB.repositoryId);
    assert.equal(impact.payload?.proposal?.branch, proposal.branch);
    assert.equal(impact.payload?.proposal?.scope, proposal.scope);
    assert.equal(impact.payload?.head, proposal.head);
    assert.equal(impact.payload?.changedFiles?.some((file) => file.path === proposal.path), true, impact.text);
    assertOmitsDeniedScopes(impact, "Allowed special-scope impact");

    const review = await jsonRequest(`${origin}/api/context-hub/review`, {
      method: "POST",
      headers: humanHeaders("review"),
      body: JSON.stringify({
        repositoryId: repositoryRecordB.repositoryId,
        proposal: proposal.branch,
        expectedHead: proposal.head,
      }),
    });
    assert.equal(review.response.status, 201, review.text);
    assert.match(review.payload?.url || "", /^\/reviews\/[A-Za-z0-9_-]+\/$/);
    assert.equal(review.payload?.review?.repositoryId, repositoryRecordB.repositoryId);
    assert.equal(review.payload?.review?.projectId, proposal.scope);
    assert.equal(review.payload?.review?.scope, proposal.scope);
    assert.equal(review.payload?.review?.proposal, proposal.branch);
    assert.equal(review.payload?.review?.proposalHead, proposal.head);
    assert.equal(review.payload?.review?.proposalFiles?.includes(proposal.path), true, review.text);
    assertOmitsDeniedScopes(review, "Allowed special-scope review");
  }
});
