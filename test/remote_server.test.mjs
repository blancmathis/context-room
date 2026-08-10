import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { contextHubRepositoryIdentity } from "../src/context_hub.mjs";
import { contextHubRepositoryId, createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";
import { createVerifiedAcceptanceFlashStore } from "../src/review_authority.mjs";

const secret = "remote-server-test-secret-with-more-than-32-bytes";
const remoteHost = "context.qm.peerlab.fr";
const packageVersion = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const sharedRepository = "https://github.com/context-room-tests/hosted-shared.git";
const sharedProjectId = "hicharlie";
const repositoryId = createHash("sha256")
  .update(contextHubRepositoryIdentity(sharedRepository))
  .digest("hex")
  .slice(0, 16);
const proposalBranch = `proposal/${sharedProjectId}/strict-hosted-boundary`;
const proposalHead = "0123456789abcdef0123456789abcdef01234567";

test("Hosted repository IDs hash the canonical GitHub identity exactly once", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-repository-id-"));
  const cwdA = path.join(base, "a");
  const cwdB = path.join(base, "b");
  fs.mkdirSync(cwdA);
  fs.mkdirSync(cwdB);
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));

  const variants = [
    "https://github.com/Context-Room-Tests/Hosted-Shared.git",
    "git@github.com:context-room-tests/hosted-shared.git",
    "git@github.com:CONTEXT-ROOM-TESTS/HOSTED-SHARED.GIT",
  ];
  const identity = contextHubRepositoryIdentity(sharedRepository);
  const storageId = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const expectedId = storageId.slice(0, 16);

  assert.equal(repositoryId, expectedId);
  assert.deepEqual(variants.map(contextHubRepositoryId), [expectedId, expectedId, expectedId]);
  assert.notEqual(
    contextHubRepositoryId("https://github.com/context-room-tests/a-different-shared.git"),
    expectedId,
  );

  const previousCwd = process.cwd();
  try {
    process.chdir(cwdA);
    assert.equal(contextHubRepositoryId(sharedRepository), expectedId);
    process.chdir(cwdB);
    assert.equal(contextHubRepositoryId(sharedRepository), expectedId);
  } finally {
    process.chdir(previousCwd);
  }
});

function configuredSharedRepositories() {
  return Object.freeze([
    Object.freeze({
      repository: sharedRepository,
      projectIds: Object.freeze([sharedProjectId]),
    }),
  ]);
}

function strictRemoteAccess(overrides = {}) {
  return Object.freeze({
    expectedHost: remoteHost,
    humanSecret: secret,
    agentSecret: `${secret}-agent`,
    healthSecret: `${secret}-health`,
    adminSubjects: Object.freeze(["mathis", "florent"]),
    projectRoots: Object.freeze({}),
    sharedRepositories: configuredSharedRepositories(),
    ...overrides,
  });
}

function humanIdentity(jti, { sub = "mathis", role = "admin", operations = ["view"] } = {}) {
  return signRemoteIdentity({ kind: "human", sub, role, operations }, secret, { jti });
}

function hostedSharedProvider(privateRoot) {
  const proposal = Object.freeze({
    id: `proposal:${repositoryId}:${proposalBranch}`,
    type: "shared",
    repositoryId,
    repositoryName: "Hosted Shared",
    projectId: sharedProjectId,
    scope: "project",
    projectTitle: "HiCharlie",
    projectKey: `shared:${repositoryId}:${sharedProjectId}`,
    branch: proposalBranch,
    head: proposalHead,
    baseRevision: "fedcba9876543210fedcba9876543210fedcba98",
    files: Object.freeze([`projects/${sharedProjectId}/docs/README.md`]),
    repository: sharedRepository,
    root: privateRoot,
  });
  const state = Object.freeze({
    generatedAt: "2026-08-08T00:00:00.000Z",
    projects: Object.freeze([Object.freeze({
      id: `shared:${repositoryId}:${sharedProjectId}`,
      projectKey: `shared:${repositoryId}:${sharedProjectId}`,
      logicalProjectId: sharedProjectId,
      title: "HiCharlie",
      mode: "shared",
      shared: Object.freeze({ repositoryId, projectId: sharedProjectId }),
      sharedStatus: Object.freeze({ online: true, revision: proposalHead, defaultBranch: "main" }),
      sharedRecovery: Object.freeze({
        status: "recovery-required",
        transactionId: "local-hub-transaction-must-not-leak",
        operation: "connect",
        projectId: "local-project-location-must-not-leak",
        logicalProjectId: "local-logical-project-must-not-leak",
        createdAt: "2026-08-09T08:00:00.000Z",
      }),
      repository: sharedRepository,
      root: privateRoot,
    })]),
    sharedRepositories: Object.freeze([Object.freeze({
      id: repositoryId,
      repositoryId,
      name: "Hosted Shared",
      status: Object.freeze({ online: true, revision: proposalHead, defaultBranch: "main" }),
      projects: Object.freeze([Object.freeze({ id: sharedProjectId, title: "HiCharlie" })]),
      repository: sharedRepository,
      home: privateRoot,
    })]),
    proposals: Object.freeze([proposal]),
    sharedRecoveryIssues: Object.freeze([Object.freeze({
      status: "recovery-required",
      scope: "global",
      kind: "invalid-journal",
      quarantineId: "hosted-invalid-recovery-must-not-leak",
      revision: "hosted-invalid-revision-must-not-leak",
    })]),
    repositoryErrors: Object.freeze([]),
    freshness: Object.freeze({ fresh: true, refreshing: false }),
  });
  const matchesRepository = (value) => contextHubRepositoryIdentity(value) === contextHubRepositoryIdentity(sharedRepository);
  return Object.freeze({
    repositories: configuredSharedRepositories(),
    read: () => state,
    refresh: () => state,
    resolveRepository: (value) => value === repositoryId ? sharedRepository : "",
    repositoryId: (value) => matchesRepository(value) ? repositoryId : "",
    projectIds: (value) => matchesRepository(value) ? [sharedProjectId] : [],
    consumers: () => [],
    findProposal: (value, selector) => value === repositoryId && [proposal.id, proposal.branch, proposal.head].includes(selector) ? proposal : null,
    allowsProject: (value, projectId) => value === repositoryId && projectId === sharedProjectId,
    allowsAnyProject: (projectId) => projectId === sharedProjectId,
    findProjectProposal: (projectId, selector) => projectId === sharedProjectId && [proposal.id, proposal.branch, proposal.head].includes(selector) ? proposal : null,
  });
}

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
    remoteAccess: strictRemoteAccess(),
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
    headers: { "x-forwarded-host": remoteHost, accept: "text/html" },
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
    headers: { "x-forwarded-host": remoteHost, accept: "application/json" },
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
    remoteAccess: strictRemoteAccess({
      expectedHost,
      browserHost,
      projectRoots: Object.freeze({ [sharedProjectId]: projectRoot }),
    }),
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
  assert.equal(openResponse.status, 403, JSON.stringify(opened));
  assert.equal(opened.code, "agent_project_scope_denied");
  assert.equal(Object.hasOwn(opened, "openUrl"), false);

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

test("hosted health is service-only and exposes only the exact build identity", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-"));
  initializeContextRoomProject(root);
  const room = createMemoryServer({
    root,
    remoteAccess: strictRemoteAccess(),
  });
  t.after(() => room.server.close());
  const origin = await listen(room);
  const hostHeaders = { "x-forwarded-host": remoteHost };
  const unavailable = {
    error: "This operation is unavailable on hosted Context Room.",
    code: "remote_operation_unavailable",
  };

  for (const options of [
    { headers: hostHeaders },
    { headers: { ...hostHeaders, "x-peerlab-context-health": "wrong-health-secret" } },
    { headers: { ...hostHeaders, "x-peerlab-context-identity": humanIdentity("health-human-denied") } },
    { method: "POST", headers: { ...hostHeaders, "x-peerlab-context-health": `${secret}-health` } },
  ]) {
    const response = await fetch(`${origin}/api/health`, options);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), unavailable);
  }

  const response = await fetch(`${origin}/api/health`, {
    headers: { ...hostHeaders, "x-peerlab-context-health": `${secret}-health` },
  });
  const health = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(health, {
    ok: true,
    version: packageVersion,
    buildRevision: response.headers.get("x-context-room-revision") || null,
  });

  const wrongHost = await fetch(`${origin}/api/health`, {
    headers: {
      "x-forwarded-host": "attacker.example",
      "x-peerlab-context-health": `${secret}-health`,
    },
  });
  assert.equal(wrongHost.status, 403);
  assert.equal((await wrongHost.json()).code, "remote_host_denied");
});

test("Hosted Shared refresh isolates repositories behind one non-blocking global deadline", { timeout: 5_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-refresh-"));
  initializeContextRoomProject(root);
  const repositories = ["alpha", "beta", "gamma"].map((name) => Object.freeze({
    repository: `https://github.com/context-room-tests/hosted-${name}.git`,
    projectIds: Object.freeze([name]),
  }));
  const pending = [];
  const started = [];
  const sharedRefreshTaskRunner = (task, workerRoot, payload) => new Promise((resolve) => {
    started.push({ task, workerRoot, payload, startedAt: Date.now() });
    pending.push({ resolve, payload });
  });
  const room = createMemoryServer({
    root,
    remoteAccess: strictRemoteAccess({
      sharedRepositories: Object.freeze(repositories),
      sharedRefreshTaskRunner,
      sharedRefreshTimeoutMs: 150,
    }),
  });
  t.after(async () => {
    for (const task of pending) task.resolve(null);
    await new Promise((resolve) => room.server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const origin = await listen(room);
  let sequence = 0;
  const headers = (operations = ["view"]) => ({
    "content-type": "application/json",
    "x-forwarded-host": remoteHost,
    "x-peerlab-context-identity": humanIdentity(`hosted-refresh-${++sequence}`, { operations }),
  });

  const firstReadStartedAt = Date.now();
  const firstReadResponse = await fetch(`${origin}/api/context-hub`, { headers: headers() });
  const firstReadElapsedMs = Date.now() - firstReadStartedAt;
  const firstRead = await firstReadResponse.json();
  assert.equal(firstReadResponse.status, 200, JSON.stringify(firstRead));
  assert.ok(firstReadElapsedMs < 500, `cached Hub read took ${firstReadElapsedMs}ms`);
  assert.equal(firstRead.freshness.refreshing, true);
  assert.deepEqual(firstRead.projects.map((project) => project.logicalProjectId).sort(), ["alpha", "beta", "gamma"]);
  assert.equal(started.length, 3);
  assert.ok(Math.max(...started.map((item) => item.startedAt)) - Math.min(...started.map((item) => item.startedAt)) < 50);
  assert.deepEqual(new Set(started.map((item) => item.task)), new Set(["hosted-shared-repository"]));
  assert.deepEqual(new Set(started.map((item) => item.workerRoot)), new Set([fs.realpathSync(root)]));
  assert.deepEqual(
    new Set(started.map((item) => item.payload.repositoryId)),
    new Set(repositories.map((item) => contextHubRepositoryId(item.repository))),
  );

  const refreshStartedAt = Date.now();
  const refreshRequest = fetch(`${origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: headers(["review"]),
    body: "{}",
  });

  const healthStartedAt = Date.now();
  const healthResponse = await fetch(`${origin}/api/health`, {
    headers: {
      "x-forwarded-host": remoteHost,
      "x-peerlab-context-health": `${secret}-health`,
    },
  });
  assert.equal(healthResponse.status, 200);
  assert.ok(Date.now() - healthStartedAt < 500, "health was blocked by Hosted Shared refresh");

  const eventsStartedAt = Date.now();
  const eventsResponse = await fetch(`${origin}/api/runtime-events`, { headers: headers() });
  assert.equal(eventsResponse.status, 200);
  assert.match(eventsResponse.headers.get("content-type") || "", /^text\/event-stream/);
  assert.ok(Date.now() - eventsStartedAt < 500, "runtime events were blocked by Hosted Shared refresh");
  await eventsResponse.body?.cancel();

  const refreshResponse = await refreshRequest;
  const refreshElapsedMs = Date.now() - refreshStartedAt;
  const refreshed = await refreshResponse.json();
  assert.equal(refreshResponse.status, 200, JSON.stringify(refreshed));
  assert.ok(refreshElapsedMs < 800, `global refresh deadline took ${refreshElapsedMs}ms`);
  assert.equal(started.length, 3, "concurrent explicit refresh must reuse the in-flight refresh");
  assert.equal(refreshed.freshness.refreshing, false);
  assert.equal(refreshed.repositoryErrors.length, 3);
  assert.deepEqual(new Set(refreshed.repositoryErrors.map((error) => error.code)), new Set(["shared_repository_unavailable"]));
  const serialized = JSON.stringify(refreshed);
  for (const repository of repositories) assert.equal(serialized.includes(repository.repository), false);
  assert.equal(serialized.includes(root), false);

  for (const task of pending) {
    task.resolve({
      repository: task.payload.repository,
      repositoryName: "late-result-must-be-ignored",
      status: { online: true, revision: proposalHead, defaultBranch: "main" },
      projects: [{ id: "late", title: "late" }],
      proposals: [],
    });
  }
  await new Promise((resolve) => setTimeout(resolve, 25));
  const afterLateResponse = await fetch(`${origin}/api/context-hub`, { headers: headers() });
  const afterLate = await afterLateResponse.json();
  assert.equal(afterLateResponse.status, 200, JSON.stringify(afterLate));
  assert.equal(afterLate.repositoryErrors.length, 3);
  assert.equal(JSON.stringify(afterLate).includes("late-result-must-be-ignored"), false);
});

test("hosted human routes reject unsigned, expired, replayed, and non-admin identities", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-auth-"));
  initializeContextRoomProject(root);
  const room = createMemoryServer({ root, remoteAccess: strictRemoteAccess() });
  t.after(() => room.server.close());
  const origin = await listen(room);
  const headers = { "x-forwarded-host": remoteHost };

  const unsigned = await fetch(`${origin}/`, { headers });
  assert.equal(unsigned.status, 403);
  assert.equal((await unsigned.json()).code, "remote_identity_required");

  const token = humanIdentity("request-1");
  const authorized = { ...headers, "x-peerlab-context-identity": token };
  const page = await fetch(`${origin}/`, { headers: authorized });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /data-context-room-runtime-profile="hosted-hub"/);

  const replay = await fetch(`${origin}/`, { headers: authorized });
  assert.equal(replay.status, 403);
  assert.equal((await replay.json()).code, "remote_identity_replayed");

  const nonAdmin = humanIdentity("request-2", { sub: "member", role: "member" });
  const nonAdminResponse = await fetch(`${origin}/`, {
    headers: { ...headers, "x-peerlab-context-identity": nonAdmin },
  });
  assert.equal(nonAdminResponse.status, 403);
  assert.equal((await nonAdminResponse.json()).code, "remote_admin_required");

  const expired = signRemoteIdentity({ kind: "human", sub: "mathis", role: "admin", operations: ["view"] }, secret, {
    now: 1,
    ttlSeconds: 1,
    jti: "request-3",
  });
  const expiredResponse = await fetch(`${origin}/`, {
    headers: { ...headers, "x-peerlab-context-identity": expired },
  });
  assert.equal(expiredResponse.status, 403);
  assert.equal((await expiredResponse.json()).code, "remote_identity_expired");
});

test("hosted Hub projects only configured Shared state and requires opaque exact review selectors", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-projection-"));
  const privateRoot = path.join(root, "private-home-must-not-leak");
  initializeContextRoomProject(root);
  const sharedProvider = hostedSharedProvider(privateRoot);
  const room = createMemoryServer({
    root,
    remoteAccess: strictRemoteAccess({ sharedProvider }),
  });
  t.after(() => room.server.close());
  const origin = await listen(room);
  let sequence = 0;
  const humanHeaders = (operation = "view") => ({
    "content-type": "application/json",
    "x-forwarded-host": remoteHost,
    "x-peerlab-context-identity": humanIdentity(`hosted-projection-${++sequence}`, { operations: [operation] }),
  });

  const hubResponse = await fetch(`${origin}/api/context-hub`, { headers: humanHeaders() });
  const hub = await hubResponse.json();
  assert.equal(hubResponse.status, 200, JSON.stringify(hub));
  assert.equal(hub.sharedRepositories.length, 1);
  assert.equal(hub.sharedRepositories[0].repositoryId, repositoryId);
  assert.match(hub.sharedRepositories[0].repositoryId, /^[a-f0-9]{16}$/);
  assert.equal(hub.proposals[0].repositoryId, repositoryId);
  assert.equal(hub.proposals[0].head, proposalHead);
  assert.equal(hub.projects[0].shared.projectId, sharedProjectId);
  const serializedHub = JSON.stringify(hub);
  assert.equal(serializedHub.includes(sharedRepository), false);
  assert.equal(serializedHub.includes(privateRoot), false);
  assert.equal(serializedHub.includes("sharedRecovery"), false);
  assert.equal(serializedHub.includes("local-hub-transaction-must-not-leak"), false);
  assert.equal(serializedHub.includes("hosted-invalid-recovery-must-not-leak"), false);
  if (process.env.HOME) assert.equal(serializedHub.includes(process.env.HOME), false);
  for (const key of ["repository", "root", "home", "provider", "worktrees"]) {
    assert.equal(Object.hasOwn(hub.sharedRepositories[0], key), false);
  }

  const deniedLocalRoutes = [
    "/api/settings",
    "/api/file",
    "/api/codex-prompts",
    "/api/context-hub/project-explorer",
    "/api/shared-context",
  ];
  for (const route of deniedLocalRoutes) {
    const denied = await fetch(`${origin}${route}`, { headers: { "x-forwarded-host": remoteHost } });
    assert.equal(denied.status, 404, route);
    assert.equal((await denied.json()).code, "remote_operation_unavailable", route);
  }
  const deniedRecovery = await fetch(`${origin}/api/context-hub/shared-recovery/abandon`, {
    method: "POST",
    headers: humanHeaders("review"),
    body: JSON.stringify({
      transactionId: "local-hub-transaction-must-not-leak",
      expectedProjectId: "local-project-location-must-not-leak",
      expectedLogicalProjectId: "local-logical-project-must-not-leak",
    }),
  });
  assert.equal(deniedRecovery.status, 404);
  assert.equal((await deniedRecovery.json()).code, "remote_operation_unavailable");

  const review = async (body) => {
    const response = await fetch(`${origin}/api/context-hub/review`, {
      method: "POST",
      headers: humanHeaders("review"),
      body: JSON.stringify(body),
    });
    return { response, payload: await response.json() };
  };
  const rawRepository = await review({ repository: sharedRepository, proposal: proposalBranch, expectedHead: proposalHead });
  assert.equal(rawRepository.response.status, 400);
  assert.equal(rawRepository.payload.code, "shared_context_repository_required");

  const missingHead = await review({ repositoryId, proposal: proposalBranch });
  assert.equal(missingHead.response.status, 400);
  assert.equal(missingHead.payload.code, "shared_context_proposal_head_required");

  const staleHead = await review({ repositoryId, proposal: proposalBranch, expectedHead: "0".repeat(40) });
  assert.equal(staleHead.response.status, 409, JSON.stringify(staleHead.payload));
  assert.equal(staleHead.payload.code, "shared_context_proposal_head_mismatch");
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
    remoteAccess: strictRemoteAccess(),
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
      "x-forwarded-host": remoteHost,
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
