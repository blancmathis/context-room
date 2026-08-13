import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import {
  CONTEXT_HUB_REGISTRY_VERSION,
  abandonInvalidContextHubSharedTransaction,
  abandonContextHubSharedTransaction,
  beginContextHubSnapshotRefresh,
  clearContextHubRuntime,
  commitContextHubSnapshot,
  contextHubHostRoot,
  contextHubRegistryLockPath,
  contextHubRepositoryIdentity,
  contextHubRegistryRevision,
  disconnectContextHubProjectShared,
  invalidateContextHubSnapshot,
  listContextHubProjects,
  listContextHubSharedRecoveryIssues,
  readContextHubRegistry,
  readContextHubAttention,
  readContextHubRuntime,
  readContextHubSnapshot,
  recoverContextHubSharedTransactions,
  registerContextHubProject,
  registerContextHubSharedRepository,
  removeContextHubReviewSnoozes,
  setContextHubProjectOrder,
  setContextHubReviewSnoozes,
  unregisterContextHubProject,
  unregisterContextHubSharedRepository,
  withContextHubProjectSharedDisconnection,
  withContextHubProjectSharedRegistration,
  writeContextHubSnapshot,
  writeContextHubRuntime,
} from "../src/context_hub.mjs";
import { createFilesystemLockWorkerOwner } from "../src/filesystem_lock.mjs";
import {
  contextRoomWebAssetBundle,
  createMemoryServer,
  contextHubRepositoryId,
  contextHubUiState,
  refreshContextHubSnapshot,
  initializeContextRoomProject,
  listProjectExplorerPage,
  readMemoryWebappSettings,
} from "../src/context_room.mjs";
import {
  connectSharedContext,
  createSharedProposal,
  disconnectSharedContext,
  initializeSharedRepository,
  materializeSharedRepositoryReview,
  publishSharedProposal,
  readSharedProjectConnection,
  sharedContextStatus,
} from "../src/shared_context.mjs";

function makeProject(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), `# ${name}\n`, "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "hub@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Hub Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  return root;
}

function hubGit(cwd, args, options = {}) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function configureHubGit(root) {
  hubGit(root, ["config", "user.email", "hub-shared@example.test"]);
  hubGit(root, ["config", "user.name", "Context Hub Shared Test"]);
}

function writeHubFile(root, relPath, content) {
  const target = path.join(root, relPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function makeHubSharedFixture(base, { projectSource = null, mirror = false } = {}) {
  const remote = path.join(base, "shared-a.git");
  const mirrorRemote = mirror ? path.join(base, "shared-b.git") : "";
  const seed = path.join(base, "shared-seed");
  hubGit(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  if (mirrorRemote) hubGit(base, ["init", "--bare", "--initial-branch=main", mirrorRemote], { stdio: "ignore" });
  hubGit(base, ["clone", remote, seed], { stdio: "ignore" });
  configureHubGit(seed);
  initializeSharedRepository(seed, { name: "Context Hub identity fixture" });
  const sharedProject = { id: "demo", title: "Demo" };
  if (projectSource) sharedProject.source = projectSource;
  writeHubFile(seed, "projects.json", JSON.stringify({ version: 1, projects: [sharedProject] }, null, 2) + "\n");
  writeHubFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  hubGit(seed, ["add", "."]);
  hubGit(seed, ["commit", "-m", "Initialize shared identity fixture"]);
  hubGit(seed, ["push", "origin", "main"]);
  if (mirrorRemote) {
    hubGit(seed, ["remote", "add", "mirror", mirrorRemote]);
    hubGit(seed, ["push", "mirror", "main"]);
  }
  return { remote, mirrorRemote, seed };
}

function publishHubSharedProposal(projectRoot, fixture, {
  branch = "proposal/demo/same-identity",
  title = "Same proposal identity",
} = {}) {
  connectSharedContext(projectRoot, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(projectRoot, { branch, title });
  configureHubGit(proposal.root);
  writeHubFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nProposed identity-safe text.\n");
  const published = publishSharedProposal(projectRoot, { proposal: proposal.branch });
  if (fixture.mirrorRemote) {
    if (!hubGit(proposal.root, ["remote"]).split("\n").includes("mirror")) {
      hubGit(proposal.root, ["remote", "add", "mirror", fixture.mirrorRemote]);
    }
    hubGit(proposal.root, ["push", "mirror", `${proposal.branch}:${proposal.branch}`]);
  }
  return { proposal, published };
}

function withHubHome(t, hubHome) {
  const previous = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previous;
  });
}

function withSharedHome(t, sharedHome) {
  const previous = process.env.CONTEXT_ROOM_SHARED_HOME;
  const previousHome = process.env.HOME;
  process.env.HOME = path.dirname(sharedHome);
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  t.after(() => {
    if (previous === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previous;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
}

test("Context Hub keeps one shared proposal while counting it for every linked local consumer", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-consumers-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const shared = makeHubSharedFixture(base);
  const firstRoot = makeProject(base, "Consumer one");
  const secondRoot = makeProject(base, "Consumer two");
  const { published } = publishHubSharedProposal(firstRoot, shared);
  registerContextHubSharedRepository(shared.remote);
  const first = registerContextHubProject(firstRoot, { shared: { repository: shared.remote, projectId: "demo" } });
  const second = registerContextHubProject(secondRoot, { shared: { repository: shared.remote, projectId: "demo" } });

  const hub = contextHubUiState(firstRoot, { refreshShared: true, force: true });
  assert.equal(hub.proposals.length, 1);
  assert.equal(hub.items.filter((item) => item.type === "shared").length, 1);
  assert.equal(hub.proposals[0].head, published.head);
  assert.deepEqual(new Set(hub.proposals[0].projectKeys), new Set([
    hub.projects.find((project) => project.id === first.id).projectKey,
    hub.projects.find((project) => project.id === second.id).projectKey,
  ]));
  assert.equal(hub.projects.find((project) => project.id === first.id).sharedProposalCount, 1);
  assert.equal(hub.projects.find((project) => project.id === second.id).sharedProposalCount, 1);
  assert.equal(hub.projects.some((project) => project.mode === "shared" && project.shared?.projectId === "demo"), false);
});

test("Context Hub keeps online, cached-offline, and invalid Shared repositories manageable", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-availability-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Shared availability project");
  const fixtureAt = (name) => {
    const directory = path.join(base, name);
    fs.mkdirSync(directory, { recursive: true });
    return makeHubSharedFixture(directory);
  };
  const online = fixtureAt("online");
  const offline = fixtureAt("offline");
  const invalid = fixtureAt("invalid");
  for (const fixture of [online, offline, invalid]) registerContextHubSharedRepository(fixture.remote);

  const warm = contextHubUiState(root, { refreshShared: true, force: true });
  assert.equal(warm.sharedRepositories.length, 3);
  assert.ok(warm.sharedRepositories.every((repository) => repository.availability === "online"));
  const warmIdFor = (fixture) => warm.sharedRepositories.find((repository) => (
    contextHubRepositoryIdentity(repository.repository) === contextHubRepositoryIdentity(fixture.remote)
  )).id;
  const onlineId = warmIdFor(online);
  const offlineId = warmIdFor(offline);
  const invalidId = warmIdFor(invalid);

  const offlineRemote = offline.remote + ".unreachable";
  fs.renameSync(offline.remote, offlineRemote);
  writeHubFile(invalid.seed, "projects.json", "{invalid-json\n");
  hubGit(invalid.seed, ["add", "projects.json"]);
  hubGit(invalid.seed, ["commit", "-m", "Publish an invalid Shared catalog"]);
  hubGit(invalid.seed, ["push", "origin", "main"]);
  try {
    const state = contextHubUiState(root, { refreshShared: true, force: true });
    const byId = new Map(state.sharedRepositories.map((repository) => [repository.id, repository]));
    const onlineRecord = byId.get(onlineId);
    const offlineRecord = byId.get(offlineId);
    const invalidRecord = byId.get(invalidId);

    assert.equal(state.sharedRepositories.length, 3);
    assert.equal(state.summary.sharedRepositories, 3);
    assert.ok(onlineRecord, JSON.stringify(state.sharedRepositories));
    assert.ok(offlineRecord, JSON.stringify(state.sharedRepositories));
    assert.ok(invalidRecord, JSON.stringify(state.sharedRepositories));
    assert.equal(onlineRecord.availability, "online");
    assert.equal(onlineRecord.status.online, true);
    assert.equal(offlineRecord.availability, "cached-offline");
    assert.equal(offlineRecord.status.online, false);
    assert.match(offlineRecord.status.revision, /^[a-f0-9]{40}$/);
    assert.equal(invalidRecord.availability, "unavailable");
    assert.equal(invalidRecord.status.online, false);
    assert.equal(invalidRecord.status.revision, "");
    assert.deepEqual(invalidRecord.projects, []);
    assert.equal(invalidRecord.error.code, "shared_repository_unavailable");
    assert.equal(state.repositoryErrors.length, 1);
    assert.equal(state.repositoryErrors[0].repositoryId, invalidRecord.id);
    const browserSource = contextRoomWebAssetBundle().js;
    assert.ok(browserSource.includes("Unavailable or invalid"));
    assert.ok(browserSource.includes("sharedReviewCoverageConfirmed"));
    assert.ok(browserSource.includes("Cached offline"));
    assert.equal(browserSource.includes("Shared review status is cached or unavailable"), false);

    assert.deepEqual(unregisterContextHubSharedRepository(invalid.remote), {
      repository: invalidRecord.repository,
      removed: true,
    });
    assert.equal(readContextHubRegistry().sharedRepositories.length, 2);
  } finally {
    fs.renameSync(offlineRemote, offline.remote);
  }
});

test("Context Hub opaque repository IDs open the exact repository when branch and head collide", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-opaque-repository-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const previousAuthorityHome = process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME;
  process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = path.join(base, "review-authority");
  t.after(() => {
    if (previousAuthorityHome === undefined) delete process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME;
    else process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = previousAuthorityHome;
  });
  const shared = makeHubSharedFixture(base, { mirror: true });
  const root = makeProject(base, "Opaque repository project");
  const { proposal, published } = publishHubSharedProposal(root, shared);
  registerContextHubSharedRepository(shared.remote);
  registerContextHubSharedRepository(shared.mirrorRemote);
  const registered = registerContextHubProject(root, { shared: { repository: shared.remote, projectId: "demo" } });

  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (room.server.listening) await new Promise((resolve) => room.server.close(resolve));
    await room.waitForShutdown();
  });
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": room.ownerMutationNonce,
  };
  const refreshResponse = await fetch(origin + "/api/context-hub/refresh", { method: "POST", headers, body: "{}" });
  const hub = await refreshResponse.json();
  assert.equal(refreshResponse.status, 200, JSON.stringify(hub));
  const first = hub.proposals.find((item) => contextHubRepositoryIdentity(item.repository) === contextHubRepositoryIdentity(shared.remote));
  const second = hub.proposals.find((item) => contextHubRepositoryIdentity(item.repository) === contextHubRepositoryIdentity(shared.mirrorRemote));
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.branch, proposal.branch);
  assert.equal(second.branch, proposal.branch);
  assert.equal(first.head, published.head);
  assert.equal(second.head, published.head);
  assert.notEqual(first.repositoryId, second.repositoryId);
  assert.notEqual(first.id, second.id);

  const reviewResponse = await fetch(origin + "/api/context-hub/review", {
    method: "POST",
    headers,
    body: JSON.stringify({ repositoryId: first.repositoryId, proposal: first.id, expectedHead: first.head }),
  });
  const review = await reviewResponse.json();
  assert.equal(reviewResponse.status, 201, JSON.stringify(review));
  assert.equal(contextHubRepositoryIdentity(review.review.repository), contextHubRepositoryIdentity(shared.remote));
  assert.equal(review.review.proposal, proposal.branch);
  assert.equal(review.review.proposalHead, published.head);

  const offlineRemote = shared.remote + ".offline";
  fs.renameSync(shared.remote, offlineRemote);
  try {
    const openedResponse = await fetch(origin + "/api/context-hub/project", {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: registered.id }),
    });
    const opened = await openedResponse.json();
    assert.equal(openedResponse.status, 201, JSON.stringify(opened));
    assert.equal(contextHubRepositoryIdentity(opened.project.shared.repository), contextHubRepositoryIdentity(shared.remote));
    let exactStatus = opened.sharedStatus;
    if (exactStatus.refreshing) {
      const offlineDeadline = Date.now() + 20_000;
      while (sharedContextStatus(root).online !== false && Date.now() < offlineDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      exactStatus = sharedContextStatus(root);
    }
    assert.equal(exactStatus.online, false);
    assert.match(exactStatus.revision, /^[a-f0-9]{40}$/);
    assert.ok(exactStatus.fetchError);
  } finally {
    fs.renameSync(offlineRemote, shared.remote);
  }

  const forgedRepository = path.join(base, "not-configured.git");
  const forgedResponse = await fetch(origin + "/api/context-hub/review", {
    method: "POST",
    headers,
    body: JSON.stringify({ repositoryId: forgedRepository, proposal: first.id, expectedHead: first.head }),
  });
  const forged = await forgedResponse.json();
  assert.equal(forgedResponse.status, 403, JSON.stringify(forged));
  assert.equal(forged.code, "shared_context_repository_not_registered");
  assert.equal(fs.existsSync(forgedRepository), false);
});

test("Context Hub refreshes a transient catalogue gap before declaring an exact proposal missing", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-transient-proposal-gap-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const previousAuthorityHome = process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME;
  process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = path.join(base, "review-authority");
  t.after(() => {
    if (previousAuthorityHome === undefined) delete process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME;
    else process.env.CONTEXT_ROOM_REVIEW_AUTHORITY_HOME = previousAuthorityHome;
  });
  const shared = makeHubSharedFixture(base);
  const root = makeProject(base, "Transient proposal gap");
  const { proposal, published } = publishHubSharedProposal(root, shared);
  registerContextHubSharedRepository(shared.remote);
  registerContextHubProject(root, { shared: { repository: shared.remote, projectId: "demo" } });
  writeContextHubSnapshot({
    enabled: true,
    generatedAt: new Date().toISOString(),
    currentProjectId: "",
    projects: [],
    proposals: [],
    items: [],
    repositoryErrors: [],
    summary: { projects: 0, proposals: 0, localReviews: 0 },
  });

  let materializedReview = null;
  let materializationCalls = 0;
  let reviewServerListenCalls = 0;
  let resolveFirstMaterialization;
  let releaseMaterializations;
  let materializationGateTimeout = null;
  const firstMaterialization = new Promise((resolve) => { resolveFirstMaterialization = resolve; });
  const materializationGate = new Promise((resolve) => { releaseMaterializations = resolve; });
  t.after(() => {
    if (materializationGateTimeout) clearTimeout(materializationGateTimeout);
  });
  const room = createMemoryServer({
    root,
    sharedReviewMaterializationTask: async () => {
      materializationCalls += 1;
      if (materializationCalls === 1) {
        resolveFirstMaterialization();
        materializationGateTimeout = setTimeout(releaseMaterializations, 2_000);
      }
      if (materializationCalls === 2) {
        clearTimeout(materializationGateTimeout);
        materializationGateTimeout = null;
        releaseMaterializations();
      }
      await materializationGate;
      assert.ok(materializedReview);
      return materializedReview;
    },
    sharedReviewServerListen: async (server, reviewPort) => {
      reviewServerListenCalls += 1;
      await new Promise((resolve, reject) => {
        const onError = (error) => reject(error);
        server.once("error", onError);
        server.listen(reviewPort, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const requestHeaders = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": room.ownerMutationNonce,
  };
  const staleResponse = await fetch(origin + "/api/context-hub/review", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      repositoryId: contextHubRepositoryId(shared.remote),
      proposal: proposal.branch,
      expectedHead: "0".repeat(40),
    }),
  });
  const stale = await staleResponse.json();
  assert.equal(staleResponse.status, 409, JSON.stringify(stale));
  assert.equal(stale.code, "shared_context_proposal_head_mismatch");
  materializedReview = materializeSharedRepositoryReview(shared.remote, {
    proposal: proposal.branch,
    expectedHead: published.head,
  });
  const materializedBase = materializedReview.metadata.baseRevision;
  const alternateObservedBase = materializedBase === "f".repeat(40) ? "e".repeat(40) : "f".repeat(40);
  const snapshotState = contextHubUiState(root, { refreshShared: true, force: true });
  const snapshotAtBase = (revision) => ({
    ...snapshotState,
    generatedAt: new Date().toISOString(),
    sharedRepositories: snapshotState.sharedRepositories.map((entry) => ({
      ...entry,
      status: { ...entry.status, revision },
    })),
  });
  const openReview = () => fetch(origin + "/api/context-hub/review", {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify({
      repositoryId: contextHubRepositoryId(shared.remote),
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
  });
  writeContextHubSnapshot(snapshotAtBase(materializedBase));
  const firstResponse = openReview();
  await firstMaterialization;
  writeContextHubSnapshot(snapshotAtBase(alternateObservedBase));
  const responses = await Promise.all([firstResponse, openReview()]);
  const openedReviews = await Promise.all(responses.map((response) => response.json()));
  for (const [index, response] of responses.entries()) {
    const opened = openedReviews[index];
    assert.equal(response.status, 201, JSON.stringify(opened));
    assert.equal(opened.review.proposal, proposal.branch);
    assert.equal(opened.review.proposalHead, published.head);
    assert.equal("docqa" in opened, false, "Hub opening should not build DocQA before navigating to the exact review room");
  }
  assert.equal(materializationCalls, 1, "current local main refs must collapse stale snapshot bases before materialization");
  assert.equal(reviewServerListenCalls, 1, "one exact materialized review must initialize only one review server");
  assert.equal(new Set(openedReviews.map((opened) => opened.url)).size, 1);
  assert.deepEqual(new Set(openedReviews.map((opened) => opened.review.baseRevision)), new Set([materializedBase]));
  const reviewPageResponse = await fetch(openedReviews[0].url + "/");
  assert.equal(reviewPageResponse.status, 200);
  const targetDocQaResponse = await fetch(openedReviews[0].url + "/api/docqa");
  const targetDocQa = await targetDocQaResponse.json();
  assert.equal(targetDocQaResponse.status, 200, JSON.stringify(targetDocQa));
  assert.deepEqual(targetDocQa.pendingPaths, ["projects/demo/docs/README.md"]);
  const refreshedResponse = await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: requestHeaders,
    body: "{}",
  });
  const refreshed = await refreshedResponse.json();
  assert.equal(refreshedResponse.status, 200, JSON.stringify(refreshed));
  assert.equal(refreshed.freshness?.fresh, true, JSON.stringify(refreshed.freshness));
  writeContextHubSnapshot(refreshed, { generatedAt: "2000-01-01T00:00:00.000Z" });
  const cachedRepository = path.join(sharedContextStatus(root).cacheRoot, "repository");
  const cachedProposalRef = `refs/remotes/origin/${proposal.branch}`;
  hubGit(cachedRepository, ["update-ref", "-d", cachedProposalRef]);

  const offlineRemote = shared.remote + ".offline";
  fs.renameSync(shared.remote, offlineRemote);
  try {
    const reopenedResponse = await openReview();
    const reopened = await reopenedResponse.json();
    assert.equal(reopenedResponse.status, 409, JSON.stringify(reopened));
    assert.equal(reopened.code, "shared-proposal-terminal");
    assert.equal(reopened.details?.reviewStatus, "externally_deleted");
    assert.equal(reopened.details?.authorityViolation, true);
  } finally {
    fs.renameSync(offlineRemote, shared.remote);
    hubGit(cachedRepository, ["update-ref", cachedProposalRef, published.head]);
  }
});

test("Context Hub revalidates current cached refs before reusing a warm proposal room", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-warm-terminal-revalidation-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const shared = makeHubSharedFixture(base);
  const root = makeProject(base, "Warm terminal revalidation");
  const { proposal, published } = publishHubSharedProposal(root, shared);
  registerContextHubSharedRepository(shared.remote);
  registerContextHubProject(root, { shared: { repository: shared.remote, projectId: "demo" } });
  const snapshot = contextHubUiState(root, { refreshShared: true, force: true });
  writeContextHubSnapshot(snapshot);
  const target = snapshot.proposals.find((item) => item.branch === proposal.branch);
  assert.ok(target);

  let materializationCalls = 0;
  const room = createMemoryServer({
    root,
    sharedReviewMaterializationTask: async ({ repository, proposal: branch, expectedHead }) => {
      materializationCalls += 1;
      return materializeSharedRepositoryReview(repository, { proposal: branch, expectedHead });
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": room.ownerMutationNonce,
  };
  const openReview = () => fetch(origin + "/api/context-hub/review", {
    method: "POST",
    headers,
    body: JSON.stringify({
      repositoryId: target.repositoryId,
      proposal: target.id,
      expectedHead: published.head,
    }),
  });

  const openedResponse = await openReview();
  const opened = await openedResponse.json();
  assert.equal(openedResponse.status, 201, JSON.stringify(opened));
  assert.equal(materializationCalls, 1);

  const integratedContent = fs.readFileSync(path.join(proposal.root, "projects/demo/docs/README.md"), "utf8");
  writeHubFile(shared.seed, "projects/demo/docs/README.md", integratedContent);
  hubGit(shared.seed, ["add", "projects/demo/docs/README.md"]);
  hubGit(shared.seed, ["commit", "-m", "Integrate proposal outside Context Room"]);
  const integratedAtRevision = hubGit(shared.seed, ["rev-parse", "HEAD"]);
  hubGit(shared.seed, ["push", "origin", "main"]);
  const cachedRepository = path.join(sharedContextStatus(root).cacheRoot, "repository");
  hubGit(cachedRepository, ["fetch", "origin"]);
  const offlineRemote = shared.remote + ".offline";
  fs.renameSync(shared.remote, offlineRemote);
  try {
    const reopenedResponse = await openReview();
    const reopened = await reopenedResponse.json();
    assert.equal(reopenedResponse.status, 409, JSON.stringify(reopened));
    assert.equal(reopened.code, "shared-proposal-terminal");
    assert.equal(reopened.details?.reviewStatus, "external_merge_recovery_required");
    assert.equal(reopened.details?.integratedAtRevision, integratedAtRevision);
    assert.equal(materializationCalls, 1, "terminal revalidation must reject instead of reusing or rematerializing");
  } finally {
    fs.renameSync(offlineRemote, shared.remote);
  }
});

test("Context Hub rejects terminal and conflicting proposal cards before materialization", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-proposal-precheck-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const shared = makeHubSharedFixture(base);
  const root = makeProject(base, "Proposal precheck");
  const { proposal, published } = publishHubSharedProposal(root, shared);
  registerContextHubSharedRepository(shared.remote);
  registerContextHubProject(root, { shared: { repository: shared.remote, projectId: "demo" } });
  const current = contextHubUiState(root, { refreshShared: true, force: true });
  const active = current.proposals.find((item) => item.branch === proposal.branch);
  assert.ok(active);

  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": room.ownerMutationNonce,
  };
  const openReview = () => fetch(origin + "/api/context-hub/review", {
    method: "POST",
    headers,
    body: JSON.stringify({ repositoryId: active.repositoryId, proposal: active.id, expectedHead: published.head }),
  });
  const publishSnapshot = (item) => writeContextHubSnapshot({
    ...current,
    generatedAt: new Date().toISOString(),
    proposals: [item],
    items: [item],
    summary: { ...current.summary, proposals: 1 },
  });

  const acceptedCommit = "a".repeat(40);
  publishSnapshot({ ...active, reviewStatus: "accepted", acceptedCommit });
  const terminalResponse = await openReview();
  const terminal = await terminalResponse.json();
  assert.equal(terminalResponse.status, 409, JSON.stringify(terminal));
  assert.equal(terminal.code, "shared-proposal-terminal");
  assert.deepEqual(terminal.details, {
    reviewStatus: "accepted",
    authorityViolation: false,
    authorityMessage: "",
    acceptedCommit,
    proposal: proposal.branch,
    head: published.head,
    proposalHead: published.head,
  });
  publishSnapshot({ ...active, reviewStatus: "updated", hasConflict: true, mainAdvancedBy: 2 });
  const conflictResponse = await openReview();
  const conflict = await conflictResponse.json();
  assert.equal(conflictResponse.status, 409, JSON.stringify(conflict));
  assert.equal(conflict.code, "shared-proposal-conflict");
  assert.deepEqual(conflict.details, {
    proposal: proposal.branch,
    head: published.head,
    proposalHead: published.head,
    mainAdvancedBy: 2,
  });
});

test("Context Hub cleans an unpublished child review when its server cannot listen", { timeout: 30_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-review-listen-cleanup-"));
  withHubHome(t, path.join(base, "hub"));
  const sharedHome = path.join(base, "shared-home");
  withSharedHome(t, sharedHome);
  const shared = makeHubSharedFixture(base);
  const root = makeProject(base, "Review listen cleanup");
  const { proposal, published } = publishHubSharedProposal(root, shared, {
    branch: "proposal/demo/listen-cleanup",
    title: "Clean failed review server",
  });
  registerContextHubSharedRepository(shared.remote);
  registerContextHubProject(root, { shared: { repository: shared.remote, projectId: "demo" } });
  const snapshot = contextHubUiState(root, { refreshShared: true, force: true });
  writeContextHubSnapshot(snapshot);
  const target = snapshot.proposals.find((item) => item.branch === proposal.branch);
  assert.ok(target);

  let materialized = null;
  const room = createMemoryServer({
    root,
    sharedReviewMaterializationTask: async () => {
      materialized = materializeSharedRepositoryReview(shared.remote, {
        proposal: proposal.branch,
        expectedHead: published.head,
      });
      return materialized;
    },
    sharedReviewServerListen: async () => {
      throw new Error("Injected review listen failure");
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const response = await fetch(`http://127.0.0.1:${room.server.address().port}/api/context-hub/review`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-owner-nonce": room.ownerMutationNonce,
    },
    body: JSON.stringify({
      repositoryId: target.repositoryId,
      proposal: target.branch,
      expectedHead: target.head,
    }),
  });
  const failure = await response.json();
  assert.equal(response.status, 500, JSON.stringify(failure));
  assert.equal(failure.error, "Context Room could not complete this request.");
  assert.ok(materialized);
  assert.equal(fs.existsSync(materialized.reviewRoot), false);
  assert.equal(
    fs.existsSync(path.join(sharedHome, "review-authority", `${materialized.metadata.authorityId}.json`)),
    false,
  );
});

test("Context Hub returns verified partial receipts when a later proposal rejection fails", { timeout: 45_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-partial-rejection-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const shared = makeHubSharedFixture(base);
  const root = makeProject(base, "Partial proposal rejection");
  const first = publishHubSharedProposal(root, shared, {
    branch: "proposal/demo/partial-first",
    title: "Reject first",
  });
  const secondProposal = createSharedProposal(root, {
    branch: "proposal/demo/partial-second",
    title: "Fail second after first",
  });
  configureHubGit(secondProposal.root);
  writeHubFile(secondProposal.root, "projects/demo/docs/README.md", "# Demo\n\nSecond proposal.\n");
  const secondPublished = publishSharedProposal(root, { proposal: secondProposal.branch });
  writeHubFile(secondProposal.root, "projects/demo/docs/UNPUBLISHED.md", "# Must remain local\n");

  registerContextHubSharedRepository(shared.remote);
  registerContextHubProject(root, { shared: { repository: shared.remote, projectId: "demo" } });
  const snapshot = contextHubUiState(root, { refreshShared: true, force: true });
  writeContextHubSnapshot(snapshot);
  const firstItem = snapshot.proposals.find((item) => item.branch === first.proposal.branch);
  const secondItem = snapshot.proposals.find((item) => item.branch === secondProposal.branch);
  assert.ok(firstItem && secondItem);

  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": room.ownerMutationNonce,
  };
  const items = [
    { id: firstItem.id, expectedHead: first.published.head },
    { id: secondItem.id, expectedHead: secondPublished.head },
  ];
  const challengeResponse = await fetch(origin + "/api/context-hub/reject-challenge", {
    method: "POST",
    headers,
    body: JSON.stringify({ items }),
  });
  const challenge = await challengeResponse.json();
  assert.equal(challengeResponse.status, 201, JSON.stringify(challenge));
  const response = await fetch(origin + "/api/context-hub/reject", {
    method: "POST",
    headers,
    body: JSON.stringify({ challengeId: challenge.challengeId, items }),
  });
  const result = await response.json();
  assert.equal(response.status, 207, JSON.stringify(result));
  assert.equal(result.outcome, "partial");
  assert.equal(result.partial, true);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].id, firstItem.id);
  assert.equal(result.rejected[0].rejected, true);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].id, secondItem.id);
  assert.deepEqual(result.results.map((item) => [item.id, item.status]), [
    [firstItem.id, "rejected"],
    [secondItem.id, "failed"],
  ]);
  assert.equal(
    hubGit(shared.remote, ["rev-parse", `refs/heads/${result.rejected[0].rejectionBranch}`]),
    first.published.head,
  );
  assert.equal(fs.existsSync(path.join(secondProposal.root, "projects/demo/docs/UNPUBLISHED.md")), true);
});

test("direct room boot refreshes Shared through the protected POST and GET remains read-only", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-direct-shared-boot-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const shared = makeHubSharedFixture(base);
  const root = makeProject(base, "Direct Shared boot");
  connectSharedContext(root, { repository: shared.remote, projectId: "demo" });
  const registered = registerContextHubProject(root, {
    shared: { repository: shared.remote, projectId: "demo" },
  });

  const initialStatus = sharedContextStatus(root);
  const acceptedDocument = path.join(initialStatus.cacheRoot, "current", "projects", "demo", "docs", "README.md");
  const projectConfigPath = path.join(root, ".context-room", "config.json");
  const projectConfigBeforeRead = fs.readFileSync(projectConfigPath, "utf8");
  const currentTargetBeforeRead = fs.readlinkSync(path.join(initialStatus.cacheRoot, "current"));
  assert.match(initialStatus.revision, /^[a-f0-9]{40}$/);
  assert.match(fs.readFileSync(acceptedDocument, "utf8"), /Initial\./);

  writeHubFile(shared.seed, "projects/demo/docs/README.md", "# Demo\n\nAccepted M1.\n");
  hubGit(shared.seed, ["add", "projects/demo/docs/README.md"]);
  hubGit(shared.seed, ["commit", "-m", "Publish accepted M1"]);
  hubGit(shared.seed, ["push", "origin", "main"]);
  const acceptedM1 = hubGit(shared.seed, ["rev-parse", "HEAD"]);
  assert.notEqual(acceptedM1, initialStatus.revision);

  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;

  const readOnlyResponse = await fetch(origin + "/api/shared-context?refresh=1");
  const readOnlyState = await readOnlyResponse.json();
  assert.equal(readOnlyResponse.status, 200, JSON.stringify(readOnlyState));
  assert.equal(readOnlyState.status.revision, initialStatus.revision);
  assert.equal(sharedContextStatus(root).revision, initialStatus.revision);
  assert.match(fs.readFileSync(acceptedDocument, "utf8"), /Initial\./);
  assert.equal(fs.readFileSync(projectConfigPath, "utf8"), projectConfigBeforeRead);
  assert.equal(fs.readlinkSync(path.join(initialStatus.cacheRoot, "current")), currentTargetBeforeRead);

  const untrustedRefresh = await fetch(origin + "/api/shared-context/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  });
  const untrustedResult = await untrustedRefresh.json();
  assert.equal(untrustedRefresh.status, 403, JSON.stringify(untrustedResult));
  assert.equal(untrustedResult.code, "review_authority_nonce_required");
  assert.equal(sharedContextStatus(root).revision, initialStatus.revision);

  const headers = {
    "content-type": "application/json",
    "x-context-room-project": room.projectId,
    "x-context-room-owner-nonce": room.ownerMutationNonce,
  };
  const refreshedResponse = await fetch(origin + "/api/shared-context/refresh", {
    method: "POST",
    headers,
    body: "{}",
  });
  const refreshed = await refreshedResponse.json();
  assert.equal(refreshedResponse.status, 200, JSON.stringify(refreshed));
  assert.equal(refreshed.status.revision, acceptedM1);
  assert.equal(refreshed.status.online, true);
  assert.equal(sharedContextStatus(root).revision, acceptedM1);
  assert.match(fs.readFileSync(acceptedDocument, "utf8"), /Accepted M1\./);

  const offlineRemote = shared.remote + ".offline";
  fs.renameSync(shared.remote, offlineRemote);
  try {
    const offlineResponse = await fetch(origin + "/api/shared-context/refresh", {
      method: "POST",
      headers,
      body: "{}",
    });
    const offline = await offlineResponse.json();
    assert.equal(offlineResponse.status, 200, JSON.stringify(offline));
    assert.equal(offline.status.online, false);
    assert.equal(offline.status.revision, acceptedM1);
    assert.ok(offline.status.fetchError);
  } finally {
    fs.renameSync(offlineRemote, shared.remote);
  }

  writeHubFile(shared.seed, "projects/demo/docs/README.md", "# Demo\n\nAccepted M2.\n");
  hubGit(shared.seed, ["add", "projects/demo/docs/README.md"]);
  hubGit(shared.seed, ["commit", "-m", "Publish accepted M2"]);
  hubGit(shared.seed, ["push", "origin", "main"]);
  const acceptedM2 = hubGit(shared.seed, ["rev-parse", "HEAD"]);
  const openedResponse = await fetch(origin + "/api/context-hub/project", {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: registered.id }),
  });
  const opened = await openedResponse.json();
  assert.equal(openedResponse.status, 201, JSON.stringify(opened));
  assert.equal(opened.project.id, registered.id);
  assert.ok(["complete", "pending"].includes(opened.hubRefresh?.status), JSON.stringify(opened));
  if (opened.hubRefresh.status === "complete") {
    assert.equal(opened.sharedStatus.revision, acceptedM2);
    assert.equal(opened.sharedStatus.online, true);
    assert.equal(opened.sharedStatus.refreshing, false);
  } else {
    assert.equal(typeof opened.sharedStatus.refreshing, "boolean");
    if (opened.sharedStatus.refreshing) {
      assert.match(opened.sharedStatus.revision, /^[a-f0-9]{40}$/);
    } else {
      assert.equal(opened.sharedStatus.revision, acceptedM2);
      assert.equal(opened.sharedStatus.online, true);
    }
  }
  const syncDeadline = Date.now() + 20_000;
  while (sharedContextStatus(root).revision !== acceptedM2 && Date.now() < syncDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(sharedContextStatus(root).revision, acceptedM2);
  assert.match(fs.readFileSync(acceptedDocument, "utf8"), /Accepted M2\./);
  const snapshotDeadline = Date.now() + 20_000;
  let persistedAfterOpen = readContextHubSnapshot();
  while (
    persistedAfterOpen?.state?.projects?.find((project) => project.id === registered.id)?.sharedStatus?.revision !== acceptedM2
    && Date.now() < snapshotDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    persistedAfterOpen = readContextHubSnapshot();
  }
  assert.ok(persistedAfterOpen?.state, "Context Hub snapshot should complete after a pending project sync");
  assert.equal(
    persistedAfterOpen.state.projects.find((project) => project.id === registered.id).sharedStatus.revision,
    acceptedM2,
  );
  const immediateHubAfterOpen = await (await fetch(origin + "/api/context-hub")).json();
  assert.equal(
    immediateHubAfterOpen.projects.find((project) => project.id === registered.id).sharedStatus.revision,
    acceptedM2,
  );

  const browserSource = contextRoomWebAssetBundle().js;
  const directBootSource = browserSource.slice(
    browserSource.indexOf("async function loadInitialDirectSharedContext"),
    browserSource.indexOf("async function loadFiles"),
  );
  assert.match(directBootSource, /const initial = await api\("\/api\/shared-context"\)/);
  assert.match(directBootSource, /initial\.mode !== "project"/);
  assert.match(directBootSource, /api\("\/api\/shared-context\/refresh", \{[\s\S]*method: "POST"/);
  assert.doesNotMatch(directBootSource, /shared-context\?refresh/);
});

test("Context Hub rejects ambiguous project aliases but keeps exact project IDs deterministic", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-project-ambiguity-"));
  withHubHome(t, path.join(base, "hub"));
  const firstRoot = makeProject(base, "Alias project one");
  const secondRoot = makeProject(base, "Alias project two");
  const unavailableRepository = path.join(base, "unavailable-shared.git");
  const shared = { repository: unavailableRepository, projectId: "duplicate-alias" };
  const first = registerContextHubProject(firstRoot, { shared });
  registerContextHubProject(secondRoot, { shared });
  const room = createMemoryServer({ root: firstRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;

  const refreshResponse = await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  });
  const refreshed = await refreshResponse.json();
  assert.equal(refreshResponse.status, 200, JSON.stringify(refreshed));
  assert.equal(refreshed.projects.filter((project) => project.shared?.projectId === "duplicate-alias").length, 2);

  const ambiguousResponse = await fetch(origin + "/api/context-hub/attention?projectId=duplicate-alias");
  const ambiguous = await ambiguousResponse.json();
  assert.equal(ambiguousResponse.status, 409, JSON.stringify(ambiguous));
  assert.equal(ambiguous.code, "context_hub_project_ambiguous");
  assert.equal(ambiguous.details.candidates.length, 2);

  const exactResponse = await fetch(origin + "/api/context-hub/attention?projectId=" + encodeURIComponent(first.id));
  assert.equal(exactResponse.status, 200, await exactResponse.text());

  const browserSource = contextRoomWebAssetBundle().js;
  const requestedProjectSource = browserSource.slice(
    browserSource.indexOf("function applyContextHubRequestedProject"),
    browserSource.indexOf("function applyInitialContextHubWhenReady"),
  );
  assert.match(requestedProjectSource, /error\?\.code !== "context_hub_project_ambiguous"/);
  assert.match(requestedProjectSource, /state\.activeProjectLocationId = ""/);
  assert.match(requestedProjectSource, /state\.sharedProposalProject = ""/);
  assert.match(requestedProjectSource, /state\.globalExplorerMode = "projects"/);
  assert.match(requestedProjectSource, /state\.contextHubView = "home"/);
  assert.match(requestedProjectSource, /Choose the exact project from Context Room/);
  assert.match(requestedProjectSource, /state\.contextHubInitialProjectOpenedId === exactLocationId/);
  assert.match(requestedProjectSource, /state\.contextHubInitialProjectOpen\?\.id === exactLocationId/);
  assert.match(requestedProjectSource, /openContextHubProject\(exactLocationId, \{ pushHistory: false \}, requestedGeneration\)/);
});

test("Context Hub detects Shared root drift before mutation and restores failed staged registration exactly", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-root-drift-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const sourceRemote = path.join(base, "source.git");
  const sourceRoot = path.join(base, "source-root");
  hubGit(base, ["init", "--bare", "--initial-branch=main", sourceRemote], { stdio: "ignore" });
  hubGit(base, ["clone", sourceRemote, sourceRoot], { stdio: "ignore" });
  configureHubGit(sourceRoot);
  writeHubFile(sourceRoot, "apps/demo/docs/README.md", "# Nested demo\n");
  initializeContextRoomProject(sourceRoot, { title: "Source root", allowedPaths: ["apps/demo/docs/"], watchAllow: ["apps/demo/docs/"] });
  hubGit(sourceRoot, ["add", "."]);
  hubGit(sourceRoot, ["commit", "-m", "Initialize source root"]);
  hubGit(sourceRoot, ["push", "origin", "main"]);
  const shared = makeHubSharedFixture(base, {
    projectSource: { remotes: [sourceRemote], subpath: "apps/demo" },
  });
  registerContextHubSharedRepository(shared.remote);
  const registered = registerContextHubProject(sourceRoot);
  const before = readContextHubRegistry();
  const room = createMemoryServer({ root: sourceRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const response = await fetch(origin + "/api/context-hub/project-shared-context", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-owner-nonce": room.ownerMutationNonce,
    },
    body: JSON.stringify({ projectId: registered.id, repository: shared.remote, sharedProjectId: "demo" }),
  });
  const result = await response.json();
  assert.equal(response.status, 409, JSON.stringify(result));
  assert.equal(result.code, "shared_project_root_mismatch");
  assert.deepEqual(readContextHubRegistry(), before);
  assert.equal(readSharedProjectConnection(sourceRoot), null);

  const rollbackBefore = readContextHubRegistry();
  assert.throws(() => withContextHubProjectSharedRegistration(sourceRoot, {
    shared: { repository: shared.remote, projectId: "demo" },
  }, () => {
    throw new Error("injected connect failure");
  }), /injected connect failure/);
  assert.deepEqual(readContextHubRegistry(), rollbackBefore);
  assert.equal(readSharedProjectConnection(sourceRoot), null);
});

test("Context Hub restores a failed staged Shared disconnection exactly", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-disconnect-rollback-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Disconnect rollback project");
  const sharedFixture = makeHubSharedFixture(base);
  connectSharedContext(root, { repository: sharedFixture.remote, projectId: "demo", sync: false });
  const repository = sharedFixture.remote;
  const registered = registerContextHubProject(root, {
    shared: { repository, projectId: "demo" },
  });
  const before = readContextHubRegistry();
  let staged = null;

  assert.throws(() => withContextHubProjectSharedDisconnection(root, () => {
    staged = readContextHubRegistry();
    throw new Error("injected disconnect failure");
  }), /injected disconnect failure/);

  const stagedShared = staged.projects.find((entry) => entry.id === registered.id).shared;
  assert.equal(stagedShared.projectId, "demo");
  assert.equal(contextHubRepositoryIdentity(stagedShared.repository), contextHubRepositoryIdentity(repository));
  assert.deepEqual(readContextHubRegistry(), before);
  assert.equal(readSharedProjectConnection(root).projectId, "demo");
});

test("Context Hub failed connection preserves an unrelated concurrent registry mutation without publishing a phantom binding", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-connect-compensation-race-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Connect compensation race project");
  const repository = "git@github.com:example/connect-compensation-race.git";
  const concurrentRepository = "git@github.com:example/connect-compensation-concurrent.git";
  const registered = registerContextHubProject(root);
  const injectedFailure = new Error("injected connect compensation race");
  let failure = null;

  try {
    withContextHubProjectSharedRegistration(root, {
      shared: { repository, projectId: "connect-compensation-race" },
    }, () => {
      mutateContextHubRegistryInChild(hubHome, concurrentRepository);
      throw injectedFailure;
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure, injectedFailure);
  assert.equal(failure.contextHubRecoveryError, undefined);
  const conflicted = readContextHubRegistry();
  assert.equal(conflicted.projects.find((entry) => entry.id === registered.id).shared, null);
  assert.deepEqual(conflicted.sharedRepositories.map((entry) => entry.repository), [concurrentRepository]);
  assert.equal(readSharedProjectConnection(root), null);
});

test("Context Hub failed disconnection preserves an unrelated concurrent registry mutation and the real Shared binding", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-disconnect-compensation-race-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Disconnect compensation race project");
  const sharedFixture = makeHubSharedFixture(base);
  const repository = sharedFixture.remote;
  const concurrentRepository = "git@github.com:example/disconnect-compensation-concurrent.git";
  const shared = { repository, projectId: "demo" };
  connectSharedContext(root, { ...shared, sync: false });
  const registered = registerContextHubProject(root, { shared });
  const injectedFailure = new Error("injected disconnect compensation race");
  let failure = null;

  try {
    withContextHubProjectSharedDisconnection(root, () => {
      mutateContextHubRegistryInChild(hubHome, concurrentRepository);
      throw injectedFailure;
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure, injectedFailure);
  assert.equal(failure.contextHubRecoveryError, undefined);
  const conflicted = readContextHubRegistry();
  const preservedShared = conflicted.projects.find((entry) => entry.id === registered.id).shared;
  assert.equal(preservedShared.projectId, shared.projectId);
  assert.equal(contextHubRepositoryIdentity(preservedShared.repository), contextHubRepositoryIdentity(shared.repository));
  assert.deepEqual(
    new Set(conflicted.sharedRepositories.map((entry) => contextHubRepositoryIdentity(entry.repository))),
    new Set([repository, concurrentRepository].map(contextHubRepositoryIdentity)),
  );
  assert.equal(readSharedProjectConnection(root).projectId, "demo");

  const completed = withContextHubProjectSharedDisconnection(root, () => disconnectSharedContext(root));
  assert.equal(completed.result.disconnected, true);
  const recovered = readContextHubRegistry();
  assert.equal(recovered.projects.find((entry) => entry.id === registered.id).shared, null);
  assert.deepEqual(
    new Set(recovered.sharedRepositories.map((entry) => contextHubRepositoryIdentity(entry.repository))),
    new Set([repository, concurrentRepository].map(contextHubRepositoryIdentity)),
  );
  assert.equal(readSharedProjectConnection(root), null);
});

test("Context Hub rejects a concurrent Shared mutation of the same logical project", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-same-project-race-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Same project race");
  const sharedFixture = makeHubSharedFixture(base);
  const registered = registerContextHubProject(root);
  const injectedFailure = new Error("stop after blocked concurrent mutation");

  assert.throws(() => withContextHubProjectSharedRegistration(root, {
    shared: { repository: sharedFixture.remote, projectId: "demo" },
  }, () => {
    assert.throws(
      () => registerContextHubProject(root, {
        shared: { repository: "git@github.com:example/conflicting.git", projectId: "conflicting" },
      }),
      (error) => error?.code === "context_hub_shared_transaction_busy",
    );
    throw injectedFailure;
  }), (error) => error === injectedFailure);

  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id).shared, null);
  assert.equal(readSharedProjectConnection(root), null);
  assert.deepEqual(fs.readdirSync(path.join(base, "hub", "shared-transactions")).filter((name) => name.endsWith(".json")), []);
});

test("a supervised worker cannot replay the main thread's live Hub Shared journal", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-worker-isolate-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Worker isolate transaction");
  const shared = makeHubSharedFixture(base);
  const registered = registerContextHubProject(root);
  const state = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 5));
  const worker = new Worker(`
    import fs from "node:fs";
    import { parentPort, workerData } from "node:worker_threads";
    const state = new Int32Array(workerData.state);
    const hub = await import(workerData.moduleUrl + "?worker-isolate=" + Date.now());
    parentPort.postMessage({ ready: true });
    Atomics.wait(state, 0, 0);
    try {
      const project = hub.readContextHubRegistry().projects.find((entry) => entry.id === workerData.projectId);
      state[2] = project?.shared ? 1 : 0;
      const directory = workerData.hubHome + "/shared-transactions";
      state[3] = fs.existsSync(directory) ? fs.readdirSync(directory).filter((name) => name.endsWith(".json")).length : 0;
    } catch (error) {
      state[4] = 1;
      parentPort.postMessage({ error: error?.stack || String(error) });
    } finally {
      Atomics.store(state, 1, 1);
      Atomics.notify(state, 1);
    }
  `, {
    eval: true,
    type: "module",
    workerData: {
      state: state.buffer,
      moduleUrl: new URL("../src/context_hub.mjs", import.meta.url).href,
      projectId: registered.id,
      hubHome,
      filesystemLockOwner: createFilesystemLockWorkerOwner([contextHubRegistryLockPath()]),
    },
  });
  t.after(() => worker.terminate());
  const messages = [];
  worker.on("message", (message) => messages.push(message));
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Worker did not become ready")), 5_000);
    const onMessage = (message) => {
      if (!message?.ready) return;
      clearTimeout(timeout);
      worker.off("message", onMessage);
      resolve();
    };
    worker.on("message", onMessage);
    worker.once("error", reject);
  });

  const transaction = withContextHubProjectSharedRegistration(root, {
    shared: { repository: shared.remote, projectId: "demo" },
  }, () => {
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
    const waitResult = Atomics.wait(state, 1, 0, 5_000);
    assert.notEqual(waitResult, "timed-out", JSON.stringify(messages));
    assert.equal(state[4], 0, JSON.stringify(messages));
    assert.equal(state[2], 0, "the worker must see the pre-transaction Hub state");
    assert.equal(state[3], 1, "the live owner journal must remain present");
    return connectSharedContext(root, { repository: shared.remote, projectId: "demo", sync: false });
  });
  assert.equal(transaction.result.connected, true);
  await new Promise((resolve, reject) => {
    worker.once("exit", resolve);
    worker.once("error", reject);
  });
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id).shared.projectId, "demo");
  assert.deepEqual(recoverContextHubSharedTransactions(), []);
});

test("Context Hub commits a successful Shared connection and disconnection without leaving a journal", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-transaction-success-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Successful Shared transaction");
  const shared = makeHubSharedFixture(base);
  const registered = registerContextHubProject(root);

  const connected = withContextHubProjectSharedRegistration(root, {
    shared: { repository: shared.remote, projectId: "demo" },
  }, () => connectSharedContext(root, { repository: shared.remote, projectId: "demo", sync: false }));
  assert.equal(connected.result.connected, true);
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id).shared.projectId, "demo");
  assert.equal(readSharedProjectConnection(root).projectId, "demo");

  const disconnected = withContextHubProjectSharedDisconnection(root, () => disconnectSharedContext(root));
  assert.equal(disconnected.result.disconnected, true);
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id).shared, null);
  assert.equal(readSharedProjectConnection(root), null);
  assert.deepEqual(fs.readdirSync(path.join(hubHome, "shared-transactions")).filter((name) => name.endsWith(".json")), []);
});

async function waitForRuntimeEvent(events, index, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events[index]) return events[index];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return null;
}

function runNodeModule(script, env = {}, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(reject, new Error(`Child registry mutation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => {
      const text = Buffer.concat(output).toString("utf8");
      if (code === 0) finish(resolve, text);
      else finish(reject, new Error(`Child registry mutation failed (${code ?? signal}): ${text}`));
    });
  });
}

function mutateContextHubRegistryInChild(hubHome, repository) {
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const script = `
    const hub = await import(${JSON.stringify(moduleUrl)});
    hub.registerContextHubSharedRepository(process.env.CONCURRENT_REPOSITORY);
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      CONTEXT_ROOM_HUB_HOME: hubHome,
      CONCURRENT_REPOSITORY: repository,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function waitForFile(filePath, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(filePath), true, `Timed out waiting for ${filePath}`);
}

async function killHubSharedTransactionAtPhase({ hubHome, sharedHome, root, repository, operation, phase, marker, beforeKill = null }) {
  const hubModuleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const sharedModuleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    const wait = () => {
      const signal = new Int32Array(new SharedArrayBuffer(4));
      while (true) Atomics.wait(signal, 0, 0, 1_000);
    };
    const markAndWait = () => {
      fs.writeFileSync(process.env.MARKER, process.env.PHASE);
      wait();
    };
    if (process.env.PHASE === "hub-applied") {
      const originalUnlink = fs.unlinkSync;
      fs.unlinkSync = function(target) {
        const candidate = String(target || "").replaceAll("\\\\", "/");
        if (candidate.includes("/shared-transactions/") && candidate.endsWith(".json")) markAndWait();
        return originalUnlink.call(this, target);
      };
    }
    const hub = await import(${JSON.stringify(hubModuleUrl)} + "?crash=" + Date.now());
    const shared = await import(${JSON.stringify(sharedModuleUrl)} + "?crash=" + Date.now());
    const callback = () => {
      if (process.env.PHASE === "prepared") markAndWait();
      const result = process.env.OPERATION === "connect"
        ? shared.connectSharedContext(process.env.ROOT, { repository: process.env.REPOSITORY, projectId: "demo", sync: false })
        : shared.disconnectSharedContext(process.env.ROOT);
      if (process.env.PHASE === "shared-applied") markAndWait();
      return result;
    };
    if (process.env.OPERATION === "connect") {
      hub.withContextHubProjectSharedRegistration(process.env.ROOT, {
        shared: { repository: process.env.REPOSITORY, projectId: "demo" },
      }, callback);
    } else {
      hub.withContextHubProjectSharedDisconnection(process.env.ROOT, callback);
    }
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    env: {
      ...process.env,
      CONTEXT_ROOM_HUB_HOME: hubHome,
      CONTEXT_ROOM_SHARED_HOME: sharedHome,
      ROOT: root,
      REPOSITORY: repository,
      OPERATION: operation,
      PHASE: phase,
      MARKER: marker,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(marker) && child.exitCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (!fs.existsSync(marker)) {
    child.kill("SIGKILL");
    await new Promise((resolve) => child.once("exit", resolve));
    throw new Error(`Crash transaction did not reach ${operation}:${phase}: ${Buffer.concat(output).toString("utf8")}`);
  }
  if (beforeKill) await beforeKill();
  child.kill("SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
}

test("Context Hub recovers connect and disconnect idempotently after SIGKILL at every cross-registry phase", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-crash-journal-"));
  const hubHome = path.join(base, "hub");
  const sharedHome = path.join(base, "shared-home");
  withHubHome(t, hubHome);
  withSharedHome(t, sharedHome);
  const shared = makeHubSharedFixture(base);

  for (const operation of ["connect", "disconnect"]) {
    for (const phase of ["prepared", "shared-applied", "hub-applied"]) {
      const root = makeProject(base, `${operation}-${phase}`);
      const registered = operation === "disconnect"
        ? (() => {
          connectSharedContext(root, { repository: shared.remote, projectId: "demo", sync: false });
          return registerContextHubProject(root, { shared: { repository: shared.remote, projectId: "demo" } });
        })()
        : registerContextHubProject(root);
      const marker = path.join(base, `${operation}-${phase}.marker`);
      await killHubSharedTransactionAtPhase({
        hubHome,
        sharedHome,
        root,
        repository: shared.remote,
        operation,
        phase,
        marker,
        beforeKill: phase === "prepared" ? async () => {
          const liveProject = readContextHubRegistry().projects.find((entry) => entry.id === registered.id);
          const liveConnection = readSharedProjectConnection(root);
          const expectedBeforeConnected = operation === "disconnect";
          assert.equal(Boolean(liveProject.shared), expectedBeforeConnected, `${operation}:${phase} live Hub must expose only canonical state`);
          assert.equal(Boolean(liveConnection), expectedBeforeConnected, `${operation}:${phase} live Shared state`);
        } : null,
      });

      const expectConnected = operation === "connect" ? phase !== "prepared" : phase === "prepared";
      const first = readContextHubRegistry();
      assert.deepEqual(recoverContextHubSharedTransactions(), [], `${operation}:${phase} next Hub access must finish recovery`);
      const firstProject = first.projects.find((entry) => entry.id === registered.id);
      const firstConnection = readSharedProjectConnection(root);
      assert.equal(Boolean(firstProject.shared), expectConnected, `${operation}:${phase} Hub state`);
      assert.equal(Boolean(firstConnection), expectConnected, `${operation}:${phase} Shared state`);
      if (expectConnected) {
        assert.equal(firstProject.shared.projectId, "demo");
        assert.equal(firstConnection.projectId, "demo");
        assert.equal(
          contextHubRepositoryIdentity(firstProject.shared.repository),
          contextHubRepositoryIdentity(firstConnection.repository),
        );
      }

      const second = readContextHubRegistry();
      assert.deepEqual(second, first, `${operation}:${phase} recovery must be idempotent`);
      const transactionDirectory = path.join(hubHome, "shared-transactions");
      assert.deepEqual(
        fs.existsSync(transactionDirectory) ? fs.readdirSync(transactionDirectory).filter((name) => name.endsWith(".json")) : [],
        [],
        `${operation}:${phase} journal must be cleared after recovery`,
      );
    }
  }
});

test("Context Hub recovery refuses a replacement project directory with the same path", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-root-replacement-"));
  const hubHome = path.join(base, "hub");
  const sharedHome = path.join(base, "shared-home");
  withHubHome(t, hubHome);
  withSharedHome(t, sharedHome);
  const shared = makeHubSharedFixture(base);
  const root = makeProject(base, "Replaceable project");
  const registered = registerContextHubProject(root);
  await killHubSharedTransactionAtPhase({
    hubHome,
    sharedHome,
    root,
    repository: shared.remote,
    operation: "connect",
    phase: "prepared",
    marker: path.join(base, "prepared.marker"),
  });

  const original = path.join(base, "original-project");
  fs.renameSync(root, original);
  const replacement = makeProject(base, "Replaceable project");
  assert.equal(replacement, root);
  const readable = readContextHubRegistry();
  assert.equal(readable.projects.find((entry) => entry.id === registered.id).shared, null);
  assert.equal(listContextHubProjects().find((entry) => entry.id === registered.id).available, false);
  assert.throws(
    () => recoverContextHubSharedTransactions(),
    (error) => error?.code === "context_hub_shared_transaction_conflict",
  );
  assert.equal(readSharedProjectConnection(replacement), null);

  fs.renameSync(replacement, path.join(base, "replacement-project"));
  fs.renameSync(original, root);
  const recovered = recoverContextHubSharedTransactions();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].committed, false);
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id).shared, null);
});

test("Context Hub registration does not inherit Shared state after a project root is replaced", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-register-root-replacement-"));
  withHubHome(t, path.join(base, "hub"));
  const root = makeProject(base, "Replaced registration");
  const shared = { repository: path.join(base, "shared.git"), projectId: "demo" };
  const original = registerContextHubProject(root, { shared });
  const archivedRoot = path.join(base, "archived-registration");

  fs.renameSync(root, archivedRoot);
  const replacement = makeProject(base, "Replaced registration");
  const fresh = registerContextHubProject(replacement);

  assert.equal(fresh.id, original.id, "the lexical project path remains the same");
  assert.notDeepEqual(fresh.rootIdentity, original.rootIdentity, "the filesystem capability must change");
  assert.equal(fresh.shared, null, "a replacement root must opt in to Shared explicitly");
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === fresh.id).shared, null);
});

test("Context Hub Shared recovery CAS covers every worktree in the logical project", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-group-cas-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const mainRoot = makeProject(base, "Journal group");
  const worktreeRoot = path.join(base, "Journal group agent");
  execFileSync("git", ["worktree", "add", "-b", "agent/journal-group", worktreeRoot], { cwd: mainRoot, stdio: "ignore" });
  if (!fs.existsSync(path.join(worktreeRoot, ".context-room", "config.json"))) {
    fs.cpSync(path.join(mainRoot, ".context-room"), path.join(worktreeRoot, ".context-room"), { recursive: true });
  }
  const main = registerContextHubProject(mainRoot);
  const agent = registerContextHubProject(worktreeRoot);
  const shared = makeHubSharedFixture(base);
  const archivedRoot = path.join(base, "Journal group agent original");
  let failure = null;

  try {
    withContextHubProjectSharedRegistration(mainRoot, {
      shared: { repository: shared.remote, projectId: "demo" },
    }, (pending) => {
      const result = connectSharedContext(mainRoot, {
        repository: shared.remote,
        projectId: "demo",
        projectRoots: pending.sharedProjectRoots,
        sync: false,
      });
      fs.renameSync(worktreeRoot, archivedRoot);
      makeProject(base, "Journal group agent");
      return result;
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "context_hub_shared_transaction_conflict");
  const unchanged = readContextHubRegistry();
  assert.equal(unchanged.projects.find((entry) => entry.id === main.id).shared, null);
  assert.equal(unchanged.projects.find((entry) => entry.id === agent.id).shared, null);
  assert.equal(readSharedProjectConnection(mainRoot).projectId, "demo");

  fs.renameSync(worktreeRoot, path.join(base, "Journal group agent replacement"));
  fs.renameSync(archivedRoot, worktreeRoot);
  const recovered = recoverContextHubSharedTransactions();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].committed, true);
  const connected = readContextHubRegistry();
  assert.equal(connected.projects.find((entry) => entry.id === main.id).shared.projectId, "demo");
  assert.equal(connected.projects.find((entry) => entry.id === agent.id).shared.projectId, "demo");
});

test("Context Hub Shared recovery rejects a worktree whose Git membership changes in place", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-git-membership-cas-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared-home"));
  const mainRoot = makeProject(base, "Git membership group");
  const worktreeRoot = path.join(base, "Git membership group agent");
  execFileSync("git", ["worktree", "add", "-b", "agent/git-membership", worktreeRoot], { cwd: mainRoot, stdio: "ignore" });
  if (!fs.existsSync(path.join(worktreeRoot, ".context-room", "config.json"))) {
    fs.cpSync(path.join(mainRoot, ".context-room"), path.join(worktreeRoot, ".context-room"), { recursive: true });
  }
  const main = registerContextHubProject(mainRoot);
  const agent = registerContextHubProject(worktreeRoot);
  const shared = makeHubSharedFixture(base);
  const gitEntry = path.join(worktreeRoot, ".git");
  const originalGitEntry = path.join(worktreeRoot, ".git.context-room-original");
  const rootStats = fs.lstatSync(worktreeRoot, { bigint: true });
  let failure = null;

  try {
    withContextHubProjectSharedRegistration(mainRoot, {
      shared: { repository: shared.remote, projectId: "demo" },
    }, (pending) => {
      const result = connectSharedContext(mainRoot, {
        repository: shared.remote,
        projectId: "demo",
        projectRoots: pending.sharedProjectRoots,
        sync: false,
      });
      fs.renameSync(gitEntry, originalGitEntry);
      execFileSync("git", ["init"], { cwd: worktreeRoot, stdio: "ignore" });
      return result;
    });
  } catch (error) {
    failure = error;
  }

  const unchangedRootStats = fs.lstatSync(worktreeRoot, { bigint: true });
  assert.equal(unchangedRootStats.dev, rootStats.dev);
  assert.equal(unchangedRootStats.ino, rootStats.ino);
  assert.equal(failure?.code, "context_hub_shared_transaction_conflict");
  const unchanged = readContextHubRegistry();
  assert.equal(unchanged.projects.find((entry) => entry.id === main.id).shared, null);
  assert.equal(unchanged.projects.find((entry) => entry.id === agent.id).shared, null);

  fs.rmSync(gitEntry, { recursive: true, force: true });
  fs.renameSync(originalGitEntry, gitEntry);
  const recovered = recoverContextHubSharedTransactions();
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].committed, true);
  const connected = readContextHubRegistry();
  assert.equal(connected.projects.find((entry) => entry.id === main.id).shared.projectId, "demo");
  assert.equal(connected.projects.find((entry) => entry.id === agent.id).shared.projectId, "demo");
});

test("a conflicting Shared recovery blocks only its logical project", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-conflict-isolation-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Conflicted Shared project");
  const unrelatedRoot = makeProject(base, "Unaffected project");
  const registered = registerContextHubProject(root);
  const unrelated = registerContextHubProject(unrelatedRoot);
  const shared = makeHubSharedFixture(base, { mirror: true });
  let failure = null;

  try {
    withContextHubProjectSharedRegistration(root, {
      shared: { repository: shared.remote, projectId: "demo" },
    }, () => connectSharedContext(root, { repository: shared.mirrorRemote, projectId: "demo", sync: false }));
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "context_hub_shared_transaction_conflict");
  assert.equal(failure?.contextHubRecoveryError?.code, "context_hub_shared_transaction_conflict");
  assert.equal(
    contextHubRepositoryIdentity(readSharedProjectConnection(root).repository),
    contextHubRepositoryIdentity(shared.mirrorRemote),
  );
  const readable = readContextHubRegistry();
  assert.equal(readable.projects.find((entry) => entry.id === registered.id).shared, null);
  assert.equal(readable.projects.find((entry) => entry.id === unrelated.id).title, "Unaffected project");

  const updatedUnrelated = registerContextHubProject(unrelatedRoot, { title: "Hub remains usable" });
  assert.equal(updatedUnrelated.title, "Hub remains usable");
  assert.throws(
    () => registerContextHubProject(root),
    (error) => error?.code === "context_hub_shared_transaction_busy",
  );
  assert.throws(
    () => recoverContextHubSharedTransactions(),
    (error) => error?.code === "context_hub_shared_transaction_conflict",
  );

  disconnectSharedContext(root);
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id).shared, null);
  assert.deepEqual(fs.readdirSync(path.join(hubHome, "shared-transactions")).filter((name) => name.endsWith(".json")), []);
});

test("abandoning recovery for a permanently lost root removes its exact orphaned Shared binding", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-lost-root-abandon-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Permanently lost project");
  const lostRoot = path.join(base, "Permanently lost project archived");
  const shared = makeHubSharedFixture(base);
  registerContextHubSharedRepository(shared.remote);
  const registered = registerContextHubProject(root);
  let failure = null;

  try {
    withContextHubProjectSharedRegistration(root, {
      shared: { repository: shared.remote, projectId: "demo" },
    }, () => {
      const connected = connectSharedContext(root, { repository: shared.remote, projectId: "demo", sync: false });
      fs.renameSync(root, lostRoot);
      return connected;
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "context_hub_shared_transaction_conflict");
  assert.equal(readSharedProjectConnection(registered.root), null, "a moved root cannot reuse its stale binding capability");
  const unavailable = listContextHubProjects().find((entry) => entry.id === registered.id);
  assert.equal(unavailable.available, false);
  assert.equal(unavailable.shared, null);
  assert.equal(unavailable.sharedRecovery?.status, "recovery-required");

  const abandoned = abandonContextHubSharedTransaction({
    transactionId: unavailable.sharedRecovery.transactionId,
    expectedProjectId: unavailable.sharedRecovery.projectId,
    expectedLogicalProjectId: unavailable.sharedRecovery.logicalProjectId,
  });
  assert.equal(abandoned.abandoned, true);
  assert.equal(abandoned.orphanBindingRemoved, true);
  assert.equal(abandoned.canonicalSharedCleared, true);
  assert.equal(readSharedProjectConnection(registered.root), null);
  assert.equal(listContextHubProjects().find((entry) => entry.id === registered.id).sharedRecovery, undefined);
  assert.equal(unregisterContextHubSharedRepository(shared.remote).removed, true);
});

test("an unreadable Shared journal is quarantined globally until its exact owner acknowledgement", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-invalid-shared-journal-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  withSharedHome(t, path.join(base, "shared-home"));
  const root = makeProject(base, "Invalid journal project");
  const registered = registerContextHubProject(root);
  const transactionDirectory = path.join(hubHome, "shared-transactions");
  fs.mkdirSync(transactionDirectory, { recursive: true });
  fs.writeFileSync(path.join(transactionDirectory, "unreadable.json"), "{not-json\n", "utf8");

  const [listed] = listContextHubProjects();
  assert.equal(listed.id, registered.id);
  assert.equal(listed.sharedRecovery?.status, "recovery-required");
  assert.equal(listed.sharedRecovery?.scope, "global");
  assert.equal(listed.sharedRecovery?.kind, "invalid-journal");
  assert.deepEqual(fs.readdirSync(transactionDirectory).filter((name) => name.endsWith(".json")), []);

  let [issue] = listContextHubSharedRecoveryIssues();
  assert.ok(issue?.quarantineId);
  assert.ok(issue?.revision);
  assert.throws(
    () => registerContextHubSharedRepository("git@github.com:example/blocked-by-invalid-journal.git"),
    (error) => error?.code === "context_hub_shared_recovery_required",
  );
  assert.throws(
    () => abandonInvalidContextHubSharedTransaction({
      quarantineId: issue.quarantineId,
      expectedRevision: `${issue.revision}-stale`,
    }),
    (error) => error?.code === "context_hub_shared_transaction_conflict",
  );

  const metadataPath = path.join(transactionDirectory, "invalid", issue.quarantineId, "meta.json");
  fs.writeFileSync(metadataPath, "{corrupt\n", "utf8");
  [issue] = listContextHubSharedRecoveryIssues();
  assert.equal(issue.kind, "invalid-journal");
  assert.notEqual(issue.revision, "");
  const abandoned = abandonInvalidContextHubSharedTransaction({
    quarantineId: issue.quarantineId,
    expectedRevision: issue.revision,
  });
  assert.equal(abandoned.abandoned, true);
  assert.deepEqual(listContextHubSharedRecoveryIssues(), []);
  assert.ok(fs.existsSync(path.join(transactionDirectory, "abandoned-invalid", issue.quarantineId)));

  const stagedQuarantineId = "11111111-1111-4111-8111-111111111111";
  const stagingDirectory = path.join(transactionDirectory, "invalid", `.${stagedQuarantineId}.tmp`);
  fs.mkdirSync(stagingDirectory, { recursive: true });
  fs.writeFileSync(path.join(stagingDirectory, "meta.json"), JSON.stringify({
    version: 1,
    quarantineId: stagedQuarantineId,
    originalName: "already-renamed.json",
    entryIdentity: { dev: "1", ino: "2", mode: "33152", nlink: "1", size: "42" },
  }), "utf8");
  const [stagedIssue] = listContextHubSharedRecoveryIssues();
  assert.equal(stagedIssue.quarantineId, stagedQuarantineId);
  assert.equal(stagedIssue.kind, "invalid-journal");
  assert.ok(fs.existsSync(path.join(transactionDirectory, "invalid", stagedQuarantineId)));
  abandonInvalidContextHubSharedTransaction({
    quarantineId: stagedIssue.quarantineId,
    expectedRevision: stagedIssue.revision,
  });
  assert.deepEqual(listContextHubSharedRecoveryIssues(), []);
  assert.equal(readSharedProjectConnection(root), null);
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id).shared, null);
  assert.equal(
    registerContextHubSharedRepository("git@github.com:example/unblocked-after-invalid-journal.git").repository,
    "git@github.com:example/unblocked-after-invalid-journal.git",
  );
});

test("Context Hub registry keeps local projects and shared repositories independent", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-registry-"));
  withHubHome(t, path.join(base, "hub"));
  const first = makeProject(base, "First project");
  const registered = registerContextHubProject(first);
  registerContextHubSharedRepository("git@github.com:example/shared-context.git");

  const registry = readContextHubRegistry();
  assert.equal(registry.projects.length, 1);
  assert.equal(registry.projects[0].id, registered.id);
  assert.equal(registry.sharedRepositories.length, 1);
  assert.equal(listContextHubProjects()[0].available, true);
  assert.equal(fs.statSync(path.join(base, "hub")).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(base, "hub", "registry.json")).mode & 0o777, 0o600);

  writeContextHubRuntime({ pid: 43210, port: 4319, root: first, url: "https://example.test/not-trusted" });
  assert.equal(readContextHubRuntime().port, 4319);
  assert.equal(readContextHubRuntime().url, "http://127.0.0.1:4319");
  assert.equal(clearContextHubRuntime(43210), true);
  assert.equal(readContextHubRuntime(), null);
});

test("Context Hub runtime clear cannot delete a replacement written by another process", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-runtime-cas-"));
  const hubHome = path.join(base, "hub");
  const clearBlocked = path.join(base, "clear-blocked");
  const releaseClear = path.join(base, "release-clear");
  const writerReady = path.join(base, "writer-ready");
  withHubHome(t, hubHome);
  writeContextHubRuntime({ pid: 41_001, port: 4319, root: base, url: "http://127.0.0.1:4319" });
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const clearScript = `
    import fs from "node:fs";
    const runtimePath = process.env.CONTEXT_ROOM_HUB_HOME + "/runtime.json";
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = function(target) {
      if (target === runtimePath && !fs.existsSync(process.env.CLEAR_BLOCKED)) {
        fs.writeFileSync(process.env.CLEAR_BLOCKED, "blocked");
        while (!fs.existsSync(process.env.RELEASE_CLEAR)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return originalUnlink.call(this, target);
    };
    const hub = await import(${JSON.stringify(moduleUrl)} + "?runtime-clear=" + Date.now());
    process.stdout.write(JSON.stringify({ cleared: hub.clearContextHubRuntime(41_001) }));
  `;
  const writerScript = `
    import fs from "node:fs";
    fs.writeFileSync(process.env.WRITER_READY, "ready");
    const hub = await import(${JSON.stringify(moduleUrl)} + "?runtime-writer=" + Date.now());
    hub.writeContextHubRuntime({
      pid: 41_002,
      port: 4320,
      root: process.env.RUNTIME_ROOT,
      url: "http://127.0.0.1:4320",
    });
    process.stdout.write(JSON.stringify({ written: true }));
  `;

  const clearing = runNodeModule(clearScript, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    CLEAR_BLOCKED: clearBlocked,
    RELEASE_CLEAR: releaseClear,
  });
  await waitForFile(clearBlocked);
  const writing = runNodeModule(writerScript, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    WRITER_READY: writerReady,
    RUNTIME_ROOT: base,
  });
  await waitForFile(writerReady);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(releaseClear, "release\n", "utf8");

  const [cleared, written] = (await Promise.all([clearing, writing])).map(JSON.parse);
  assert.deepEqual(cleared, { cleared: true });
  assert.deepEqual(written, { written: true });
  assert.equal(readContextHubRuntime().pid, 41_002);
  assert.equal(readContextHubRuntime().port, 4320);
});

test("Context Hub deduplicates equivalent Shared repository URLs and invalidates stale snapshots", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-repository-identity-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const root = makeProject(base, "Repository identity project");
  const sshRepository = "git@github.com:Example/shared-context.git";
  const sshUrlRepository = "ssh://git@github.com/example/SHARED-context.git";
  const httpsRepository = "https://github.com/Example/shared-context.git";

  const registered = registerContextHubSharedRepository(sshUrlRepository);
  assert.equal(registered.repository, "git@github.com:example/SHARED-context.git");
  assert.equal(registerContextHubSharedRepository(sshRepository).repository, registered.repository);
  assert.equal(registerContextHubSharedRepository(httpsRepository).repository, registered.repository);
  assert.equal(readContextHubRegistry().sharedRepositories.length, 1);

  registerContextHubProject(root, { shared: { repository: httpsRepository, projectId: "identity" } });
  const registry = readContextHubRegistry();
  assert.equal(registry.projects[0].shared.repository, registered.repository);
  assert.equal(registry.sharedRepositories.length, 1);

  writeContextHubSnapshot({ projects: [], items: [], summary: {} });
  assert.ok(readContextHubSnapshot());
  registerContextHubSharedRepository("git@github.com:example/another-context.git");
  assert.equal(readContextHubSnapshot(), null);

  assert.throws(() => unregisterContextHubSharedRepository(httpsRepository), (error) => error?.code === "shared_repository_in_use");
});

test("Context Hub keeps non-GitHub transports and SSH users distinct and rejects non-local file hosts", () => {
  assert.notEqual(
    contextHubRepositoryIdentity("alice@git.example.test:team/context.git"),
    contextHubRepositoryIdentity("bob@git.example.test:team/context.git"),
  );
  assert.notEqual(
    contextHubRepositoryIdentity("ssh://alice@git.example.test/team/context.git"),
    contextHubRepositoryIdentity("ssh://bob@git.example.test/team/context.git"),
  );
  assert.notEqual(
    contextHubRepositoryIdentity("ssh://alice@git.example.test/team/context.git"),
    contextHubRepositoryIdentity("https://git.example.test/team/context.git"),
  );
  assert.notEqual(
    contextHubRepositoryIdentity("git://git.example.test/team/context.git"),
    contextHubRepositoryIdentity("https://git.example.test/team/context.git"),
  );
  assert.throws(
    () => contextHubRepositoryIdentity("file://storage-a.example.test/context.git"),
    (error) => error?.code === "shared_repository_file_host_not_local",
  );
});

test("Context Hub rejects embedded URL credentials before persisting a repository", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-repository-credentials-"));
  withHubHome(t, path.join(base, "hub"));

  for (const repository of [
    "https://alice@github.com/example/context.git",
    "https://alice:secret@github.com/example/context.git",
    "ssh://git:secret@github.com/example/context.git",
    "https://github.com/example/context.git?token=secret-query",
    "https://github.com/example/context.git#credential=secret-fragment",
  ]) {
    assert.throws(
      () => registerContextHubSharedRepository(repository),
      /must not contain embedded credentials/,
    );
  }
  assert.equal(readContextHubRegistry().sharedRepositories.length, 0);
});

test("Context Hub stores relative local repositories once as absolute paths", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-local-repository-"));
  withHubHome(t, path.join(base, "hub"));
  const repositoryRoot = path.join(base, "shared-context.git");
  fs.mkdirSync(repositoryRoot, { recursive: true });
  const relativeRepository = path.relative(process.cwd(), repositoryRoot);

  const registered = registerContextHubSharedRepository(relativeRepository);
  assert.equal(registered.repository, fs.realpathSync(repositoryRoot));
  assert.equal(readContextHubRegistry().sharedRepositories[0].repository, fs.realpathSync(repositoryRoot));
  assert.equal(registerContextHubSharedRepository(pathToFileURL(repositoryRoot).href).repository, registered.repository);
  assert.equal(readContextHubRegistry().sharedRepositories.length, 1);
});

test("Context Hub serializes concurrent registry mutations across processes", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-registry-concurrency-"));
  const hubHome = path.join(base, "hub");
  const ready = path.join(base, "ready");
  const go = path.join(base, "go");
  fs.mkdirSync(ready, { recursive: true });
  withHubHome(t, hubHome);
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    const hub = await import(${JSON.stringify(moduleUrl)});
    fs.writeFileSync(path.join(process.env.READY_DIR, process.env.REGISTRY_INDEX), "ready");
    while (!fs.existsSync(process.env.GO_FILE)) await new Promise((resolve) => setTimeout(resolve, 5));
    hub.registerContextHubSharedRepository("git@github.com:example/shared-" + process.env.REGISTRY_INDEX + ".git");
  `;
  const count = 12;
  const children = Array.from({ length: count }, (_, index) => runNodeModule(script, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    READY_DIR: ready,
    GO_FILE: go,
    REGISTRY_INDEX: String(index),
  }));
  const deadline = Date.now() + 5_000;
  while (fs.readdirSync(ready).length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(go, "go\n", "utf8");
  assert.equal(fs.readdirSync(ready).length, count);
  await Promise.all(children);
  assert.equal(readContextHubRegistry().sharedRepositories.length, count);
  assert.equal(fs.existsSync(path.join(hubHome, "registry.lock")), false);
});

test("Context Hub recovers a stale incomplete lock generation by inode", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-stale-lock-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  fs.mkdirSync(hubHome, { recursive: true });
  const lockPath = path.join(hubHome, "registry.lock");
  fs.writeFileSync(lockPath, "", "utf8");
  const staleAt = new Date(Date.now() - 31_000);
  fs.utimesSync(lockPath, staleAt, staleAt);

  registerContextHubSharedRepository("git@github.com:example/recovered-context.git");
  assert.equal(readContextHubRegistry().sharedRepositories.length, 1);
  assert.equal(fs.existsSync(lockPath), false);
});

test("Context Hub recovers an abandoned reclaim sentinel before acquiring", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-stale-reclaim-"));
  const hubHome = path.join(base, "hub");
  const reclaimPath = path.join(hubHome, "registry.lock.reclaim");
  withHubHome(t, hubHome);
  fs.mkdirSync(hubHome, { recursive: true });
  fs.writeFileSync(reclaimPath, JSON.stringify({ pid: 99_999_999, token: "abandoned-reclaim" }) + "\n", "utf8");
  const staleAt = new Date(Date.now() - 31_000);
  fs.utimesSync(reclaimPath, staleAt, staleAt);

  registerContextHubSharedRepository("git@github.com:example/recovered-reclaim.git");
  assert.equal(readContextHubRegistry().sharedRepositories.length, 1);
  assert.equal(fs.existsSync(reclaimPath), false);
  assert.equal(fs.existsSync(path.join(hubHome, "registry.lock")), false);
});

test("Context Hub elects one stale reclaim recovery under process contention", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-reclaim-contention-"));
  const hubHome = path.join(base, "hub");
  const ready = path.join(base, "ready");
  const go = path.join(base, "go");
  const reclaimPath = path.join(hubHome, "registry.lock.reclaim");
  fs.mkdirSync(ready, { recursive: true });
  fs.mkdirSync(hubHome, { recursive: true });
  withHubHome(t, hubHome);
  fs.writeFileSync(reclaimPath, JSON.stringify({ pid: 99_999_999, token: "abandoned-contended-reclaim" }) + "\n", "utf8");
  const staleAt = new Date(Date.now() - 31_000);
  fs.utimesSync(reclaimPath, staleAt, staleAt);
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    import path from "node:path";
    const hub = await import(${JSON.stringify(moduleUrl)});
    fs.writeFileSync(path.join(process.env.READY_DIR, process.env.REGISTRY_INDEX), "ready");
    while (!fs.existsSync(process.env.GO_FILE)) await new Promise((resolve) => setTimeout(resolve, 5));
    hub.registerContextHubSharedRepository("git@github.com:example/reclaimed-" + process.env.REGISTRY_INDEX + ".git");
  `;
  const count = 8;
  const children = Array.from({ length: count }, (_, index) => runNodeModule(script, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    READY_DIR: ready,
    GO_FILE: go,
    REGISTRY_INDEX: String(index),
  }));
  const deadline = Date.now() + 5_000;
  while (fs.readdirSync(ready).length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  fs.writeFileSync(go, "go\n", "utf8");
  assert.equal(fs.readdirSync(ready).length, count);
  await Promise.all(children);

  assert.equal(readContextHubRegistry().sharedRepositories.length, count);
  assert.equal(fs.existsSync(reclaimPath), false);
  assert.equal(fs.existsSync(path.join(hubHome, "registry.lock")), false);
  const reclaimersPath = path.join(hubHome, "registry.lock.reclaimers");
  assert.deepEqual(fs.existsSync(reclaimersPath) ? fs.readdirSync(reclaimersPath) : [], []);
});

test("Context Hub releases its owner while another live reclaim sentinel exists", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-release-reclaim-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    const registryPath = process.env.CONTEXT_ROOM_HUB_HOME + "/registry.json";
    const lockPath = process.env.CONTEXT_ROOM_HUB_HOME + "/registry.lock";
    const reclaimPath = process.env.CONTEXT_ROOM_HUB_HOME + "/registry.lock.reclaim";
    const originalRename = fs.renameSync;
    let injected = false;
    fs.renameSync = function(source, target) {
      const result = originalRename.call(this, source, target);
      if (!injected && target === registryPath) {
        injected = true;
        fs.writeFileSync(reclaimPath, JSON.stringify({
          pid: process.pid,
          token: "live-release-reclaim",
          acquiredAt: new Date().toISOString(),
        }) + "\\n", "utf8");
      }
      return result;
    };
    let clock = Date.now();
    Date.now = () => clock;
    Atomics.wait = () => {
      clock += 6_000;
      return "timed-out";
    };
    const hub = await import(${JSON.stringify(moduleUrl)} + "?release-reclaim=" + clock);
    hub.registerContextHubSharedRepository("git@github.com:example/release-first.git");
    const lockAfterFirst = fs.existsSync(lockPath);
    fs.unlinkSync(reclaimPath);
    let second = "written";
    try {
      hub.registerContextHubSharedRepository("git@github.com:example/release-second.git");
    } catch (error) {
      second = error.code || error.message;
    }
    process.stdout.write(JSON.stringify({
      lockAfterFirst,
      second,
      repositories: hub.readContextHubRegistry().sharedRepositories.length,
    }));
  `;

  const output = await runNodeModule(script, { CONTEXT_ROOM_HUB_HOME: hubHome });
  assert.deepEqual(JSON.parse(output), {
    lockAfterFirst: false,
    second: "written",
    repositories: 2,
  });
});

test("Context Hub never steals an old lock from a live owner", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-live-lock-"));
  const hubHome = path.join(base, "hub");
  const ownerBlocked = path.join(base, "owner-blocked");
  const releaseOwner = path.join(base, "release-owner");
  const contenderReady = path.join(base, "contender-ready");
  withHubHome(t, hubHome);
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const ownerScript = `
    import fs from "node:fs";
    const originalRename = fs.renameSync;
    fs.renameSync = function(source, target) {
      if (String(target).endsWith("registry.json") && !fs.existsSync(process.env.OWNER_BLOCKED)) {
        fs.writeFileSync(process.env.OWNER_BLOCKED, "blocked");
        while (!fs.existsSync(process.env.RELEASE_OWNER)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return originalRename.call(this, source, target);
    };
    const hub = await import(${JSON.stringify(moduleUrl)} + "?owner=" + Date.now());
    hub.registerContextHubSharedRepository("git@github.com:example/live-owner.git");
  `;
  const contenderScript = `
    import fs from "node:fs";
    fs.writeFileSync(process.env.CONTENDER_READY, "ready");
    const hub = await import(${JSON.stringify(moduleUrl)} + "?contender=" + Date.now());
    hub.registerContextHubSharedRepository("git@github.com:example/contender.git");
  `;

  const owner = runNodeModule(ownerScript, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    OWNER_BLOCKED: ownerBlocked,
    RELEASE_OWNER: releaseOwner,
  });
  await waitForFile(ownerBlocked);
  const lockPath = path.join(hubHome, "registry.lock");
  const old = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, old, old);
  const contender = runNodeModule(contenderScript, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    CONTENDER_READY: contenderReady,
  });
  await waitForFile(contenderReady);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(releaseOwner, "release\n", "utf8");

  await Promise.all([owner, contender]);
  assert.deepEqual(
    readContextHubRegistry().sharedRepositories.map((entry) => entry.repository).sort(),
    ["git@github.com:example/contender.git", "git@github.com:example/live-owner.git"],
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test("Context Hub revalidates a stale lock generation under the reclaim sentinel", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-lock-generation-"));
  const hubHome = path.join(base, "hub");
  const lockPath = path.join(hubHome, "registry.lock");
  withHubHome(t, hubHome);
  fs.mkdirSync(hubHome, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 99_999_999, token: "stale-generation" }) + "\n", "utf8");
  const staleAt = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, staleAt, staleAt);
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const script = `
    import fs from "node:fs";
    const lockPath = process.env.CONTEXT_ROOM_HUB_HOME + "/registry.lock";
    const originalOpen = fs.openSync;
    const realNow = Date.now;
    let replaced = false;
    fs.openSync = function(target, flags, ...rest) {
      const handle = originalOpen.call(this, target, flags, ...rest);
      if (!replaced && target === lockPath && flags === "r") {
        replaced = true;
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, JSON.stringify({
          pid: process.pid,
          token: "replacement-live-owner",
          acquiredAt: new Date().toISOString(),
        }) + "\\n", "utf8");
        Date.now = () => realNow() + 10_000;
      }
      return handle;
    };
    const hub = await import(${JSON.stringify(moduleUrl)} + "?generation=" + realNow());
    let code = "";
    try {
      hub.registerContextHubSharedRepository("git@github.com:example/must-not-write.git");
    } catch (error) {
      code = error.code || error.message;
    }
    const current = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    process.stdout.write(JSON.stringify({ code, token: current.token }));
  `;

  const output = await runNodeModule(script, { CONTEXT_ROOM_HUB_HOME: hubHome });
  assert.deepEqual(JSON.parse(output), {
    code: "context_hub_registry_busy",
    token: "replacement-live-owner",
  });
  assert.equal(readContextHubRegistry().sharedRepositories.length, 0);
});

test("Context Hub can remove a technical project root without removing its Shared Context repository", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-technical-root-"));
  withHubHome(t, path.join(base, "hub"));
  const root = makeProject(base, "Remote shared project root");
  const repository = "git@github.com:example/shared-context.git";
  const registered = registerContextHubProject(root, { shared: { repository, projectId: "shared-project" } });

  assert.equal(listContextHubProjects().length, 1);
  assert.deepEqual(unregisterContextHubProject(root), { projectId: registered.id, removed: true });
  assert.equal(listContextHubProjects().length, 0);
  assert.equal(readContextHubRegistry().sharedRepositories[0].repository, repository);
  assert.deepEqual(unregisterContextHubProject(root), { projectId: registered.id, removed: false });
});

test("Context Hub removes a shared repository only after its local projects disconnect", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-shared-management-"));
  withHubHome(t, path.join(base, "hub"));
  const root = makeProject(base, "Connected project");
  const repository = "git@github.com:example/team-context.git";
  registerContextHubProject(root, { shared: { repository, projectId: "connected" } });

  assert.throws(() => unregisterContextHubSharedRepository(repository), (error) => error?.code === "shared_repository_in_use");
  const disconnected = disconnectContextHubProjectShared(root);
  assert.equal(disconnected.disconnectedLocations, 1);
  assert.equal(readContextHubRegistry().projects[0].shared, null);
  assert.deepEqual(unregisterContextHubSharedRepository(repository), { repository, removed: true });
  assert.equal(readContextHubRegistry().sharedRepositories.length, 0);
});

test("Context Hub snapshot is private, atomic, versioned, and fails closed when corrupted", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-snapshot-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  writeContextHubSnapshot({ projects: [], items: [], summary: { projects: 0 } }, { generatedAt: "2026-07-26T12:00:00.000Z" });
  const snapshotPath = path.join(hubHome, "snapshot.json");
  const controlPath = path.join(hubHome, "snapshot-control.json");
  assert.equal(fs.statSync(snapshotPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(controlPath).mode & 0o777, 0o600);
  assert.equal(readContextHubSnapshot().generatedAt, "2026-07-26T12:00:00.000Z");
  fs.writeFileSync(snapshotPath, "{broken", "utf8");
  assert.equal(readContextHubSnapshot(), null);
});

test("Context Hub registry revisions remain stable for legacy entries without timestamps", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-legacy-revision-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const root = makeProject(base, "Legacy registry project");
  fs.mkdirSync(hubHome, { recursive: true });
  fs.writeFileSync(path.join(hubHome, "registry.json"), JSON.stringify({
    version: 2,
    projects: [{ root, title: "Legacy registry project" }],
    sharedRepositories: [{ repository: "git@github.com:example/legacy-context.git" }],
  }), "utf8");

  const firstRevision = contextHubRegistryRevision();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondRevision = contextHubRegistryRevision();

  assert.equal(secondRevision, firstRevision);
  assert.equal(readContextHubRegistry().projects[0].registeredAt, "1970-01-01T00:00:00.000Z");
  assert.equal(readContextHubRegistry().sharedRepositories[0].addedAt, "1970-01-01T00:00:00.000Z");
});

test("Context Hub input revisions invalidate state and project-summary caches", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-input-cache-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared"));
  const firstRoot = makeProject(base, "Cached first project");
  registerContextHubProject(firstRoot);

  const initial = contextHubUiState(firstRoot, { refreshShared: false, force: true });
  assert.equal(initial.summary.localProjects, 1);
  const initialReadme = initial.items.flatMap((item) => item.reviews || []).find((review) => review.path === "docs/README.md");
  assert.ok(initialReadme?.currentHash);

  const secondRoot = makeProject(base, "Cached second project");
  registerContextHubProject(secondRoot);
  const afterRegistryMutation = contextHubUiState(firstRoot, { refreshShared: false });
  assert.equal(afterRegistryMutation.summary.localProjects, 2);

  fs.writeFileSync(path.join(firstRoot, "docs", "README.md"), "# Changed while another process cached the hub\n", "utf8");
  invalidateContextHubSnapshot();
  const afterInputInvalidation = contextHubUiState(firstRoot, { refreshShared: false });
  const refreshedReadme = afterInputInvalidation.items.flatMap((item) => item.reviews || []).find((review) => review.path === "docs/README.md");
  assert.notEqual(refreshedReadme?.currentHash, initialReadme.currentHash);
});

test("Context Hub rejects a snapshot computed from an older registry revision", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-snapshot-revision-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  registerContextHubSharedRepository("git@github.com:example/first-context.git");
  const staleRevision = contextHubRegistryRevision();
  const staleState = { projects: [], items: [], summary: { sharedRepositories: 1 } };
  registerContextHubSharedRepository("git@github.com:example/second-context.git");

  assert.equal(writeContextHubSnapshot(staleState, { registryRevision: staleRevision }), null);
  assert.equal(readContextHubSnapshot(), null);
});

test("Context Hub snapshot reads linearize with registry mutations", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-snapshot-read-lock-"));
  const hubHome = path.join(base, "hub");
  const mutationBlocked = path.join(base, "mutation-blocked");
  withHubHome(t, hubHome);
  writeContextHubSnapshot({ generatedAt: "2026-08-08T12:00:00.000Z", marker: "before-mutation" });
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const mutationScript = `
    import fs from "node:fs";
    const originalRename = fs.renameSync;
    fs.renameSync = function(source, target) {
      if (String(target).endsWith("registry.json") && !fs.existsSync(process.env.MUTATION_BLOCKED)) {
        fs.writeFileSync(process.env.MUTATION_BLOCKED, "blocked");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
      }
      return originalRename.call(this, source, target);
    };
    const hub = await import(${JSON.stringify(moduleUrl)} + "?snapshot-read-lock=" + Date.now());
    hub.registerContextHubSharedRepository("git@github.com:example/read-race.git");
  `;

  const mutation = runNodeModule(mutationScript, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    MUTATION_BLOCKED: mutationBlocked,
  });
  await waitForFile(mutationBlocked);

  assert.equal(readContextHubSnapshot(), null);
  await mutation;
});

test("Context Hub snapshot commits reject invalidated and out-of-order refresh results", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-snapshot-order-"));
  withHubHome(t, path.join(base, "hub"));
  const first = beginContextHubSnapshotRefresh();
  const second = beginContextHubSnapshotRefresh();
  const newerState = { generatedAt: "2026-08-08T12:00:02.000Z", marker: "newer" };
  const olderState = { generatedAt: "2026-08-08T12:00:01.000Z", marker: "older" };

  assert.equal(commitContextHubSnapshot(newerState, second).committed, true);
  assert.deepEqual(commitContextHubSnapshot(olderState, first), {
    committed: false,
    reason: "out-of-order",
    currentRefreshSequence: second.refreshSequence,
  });
  assert.equal(readContextHubSnapshot().state.marker, "newer");

  const invalidated = beginContextHubSnapshotRefresh();
  invalidateContextHubSnapshot({ preserveState: true });
  const invalidatedCommit = commitContextHubSnapshot({ generatedAt: "2026-08-08T12:00:03.000Z", marker: "invalid" }, invalidated);
  assert.equal(invalidatedCommit.committed, false);
  assert.equal(invalidatedCommit.reason, "inputs-changed");
  assert.equal(readContextHubSnapshot().state.marker, "newer");
  assert.equal(readContextHubSnapshot().generatedAt, "1970-01-01T00:00:00.000Z");
});

test("Context Hub registry mutation atomically prevents an in-flight snapshot commit", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-snapshot-registry-race-"));
  withHubHome(t, path.join(base, "hub"));
  const refresh = beginContextHubSnapshotRefresh();

  registerContextHubSharedRepository("git@github.com:example/changed-during-refresh.git");

  const committed = commitContextHubSnapshot({ generatedAt: "2026-08-08T12:00:00.000Z", marker: "stale" }, refresh);
  assert.equal(committed.committed, false);
  assert.equal(committed.reason, "inputs-changed");
  assert.equal(readContextHubSnapshot(), null);
});

test("Context Hub refresh recomputes after a registry mutation during generation", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-refresh-retry-"));
  withHubHome(t, path.join(base, "hub"));
  const root = makeProject(base, "Refresh retry project");
  let calls = 0;
  const taskRunner = async () => {
    calls += 1;
    if (calls === 1) registerContextHubSharedRepository("git@github.com:example/mutated-mid-refresh.git");
    return {
      enabled: true,
      generatedAt: `2026-08-08T12:00:0${calls}.000Z`,
      marker: `attempt-${calls}`,
      projects: [],
      sharedRepositories: [],
      proposals: [],
      items: [],
      repositoryErrors: [],
      summary: {},
    };
  };

  const refreshed = await refreshContextHubSnapshot(root, { refreshShared: false, force: true, taskRunner });

  assert.equal(calls, 2);
  assert.equal(refreshed.marker, "attempt-2");
  assert.equal(readContextHubSnapshot().state.marker, "attempt-2");
});

test("Context Hub project opening joins an invalidated active snapshot refresh without a forced follow-up", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-project-refresh-coalescing-"));
  withHubHome(t, path.join(base, "hub"));
  const root = makeProject(base, "Project refresh coalescing");
  const registered = registerContextHubProject(root);
  const pending = [];
  const taskPayloads = [];
  let calls = 0;
  const taskRunner = (_task, _root, payload) => new Promise((resolve) => {
    calls += 1;
    taskPayloads.push(payload);
    pending.push(resolve);
  });
  const state = (marker) => ({
    enabled: true,
    generatedAt: new Date().toISOString(),
    marker,
    currentProjectId: registered.id,
    projects: [{
      ...registered,
      projectKey: `local:${registered.logicalProjectId || registered.id}`,
      mode: "local",
      current: true,
      worktrees: [{ ...registered, current: true }],
      localReviews: [],
      hubSections: [],
    }],
    sharedRepositories: [],
    proposals: [],
    items: [],
    repositoryErrors: [],
    summary: {},
  });

  const active = refreshContextHubSnapshot(root, { refreshShared: false, force: false, taskRunner });
  assert.equal(calls, 1);
  invalidateContextHubSnapshot({ preserveState: true });
  const joined = refreshContextHubSnapshot(root, { refreshShared: false, force: false, taskRunner });
  assert.equal(calls, 1, "a non-forced project refresh must join the active generation");

  pending.shift()(state("invalidated-generation"));
  const deadline = Date.now() + 1_000;
  while (calls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2, "the invalidated generation must retry exactly once");
  pending.shift()(state("current-generation"));
  const [activeResult, joinedResult] = await Promise.all([active, joined]);

  assert.equal(calls, 2, "joining must not schedule a third forced follow-up");
  assert.equal(taskPayloads.length, 2);
  assert.ok(taskPayloads.every((payload) => payload.snapshotCoordinated === true));
  assert.equal(activeResult.marker, "current-generation");
  assert.equal(joinedResult.marker, "current-generation");
  assert.equal(readContextHubSnapshot().state.marker, "current-generation");
});

test("Context Hub project endpoint requests a coalescing snapshot refresh", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-project-route-refresh-"));
  withHubHome(t, path.join(base, "hub"));
  const root = makeProject(base, "Project route refresh");
  const registered = registerContextHubProject(root);
  const refreshOptions = [];
  const room = createMemoryServer({
    root,
    contextHubSnapshotRefresh: async (_targetRoot, options = {}) => {
      refreshOptions.push({ ...options });
      return contextHubUiState(root, { refreshShared: false, refreshGit: true, force: true });
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const response = await fetch(origin + "/api/context-hub/project", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-owner-nonce": room.ownerMutationNonce,
    },
    body: JSON.stringify({ projectId: registered.id }),
  });
  const result = await response.json();

  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.project.id, registered.id);
  assert.equal(refreshOptions.length, 1);
  assert.deepEqual(refreshOptions[0], { refreshShared: false, force: false });
});

test("Context Hub serializes forced refreshes and publishes only the later result", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-refresh-order-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const root = makeProject(base, "Refresh order project");
  const pending = [];
  let calls = 0;
  const taskRunner = () => new Promise((resolve) => {
    calls += 1;
    pending.push(resolve);
  });
  const state = (marker, generatedAt) => ({
    enabled: true,
    generatedAt,
    marker,
    projects: [],
    sharedRepositories: [],
    proposals: [],
    items: [],
    repositoryErrors: [],
    summary: {},
  });

  const first = refreshContextHubSnapshot(root, { refreshShared: false, force: true, taskRunner });
  const second = refreshContextHubSnapshot(root, { refreshShared: false, force: true, taskRunner });
  assert.equal(calls, 1, "the second forced refresh must wait for the active worker result");

  pending.shift()(state("first", "2026-08-08T12:00:01.000Z"));
  const firstResult = await first;
  const deadline = Date.now() + 1_000;
  while (calls < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 2);
  pending.shift()(state("second", "2026-08-08T12:00:02.000Z"));
  const secondResult = await second;

  assert.equal(firstResult.marker, "first");
  assert.equal(secondResult.marker, "second");
  assert.equal(readContextHubSnapshot().state.marker, "second");
});

test("Context Hub projects a newer cross-root snapshot onto the requesting root", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-cross-root-order-"));
  withHubHome(t, path.join(base, "hub"));
  const firstRoot = makeProject(base, "First refresh root");
  const secondRoot = makeProject(base, "Second refresh root");
  const pending = new Map();
  const taskRunner = (_task, root) => new Promise((resolve) => pending.set(root, resolve));
  const state = (marker, currentRoot, generatedAt) => ({
    enabled: true,
    generatedAt,
    marker,
    projects: [firstRoot, secondRoot].map((root, index) => ({
      id: `project-${index + 1}`,
      root,
      current: root === currentRoot,
      worktrees: [{ id: `project-${index + 1}`, root, current: root === currentRoot }],
    })),
    sharedRepositories: [],
    proposals: [],
    items: [],
    repositoryErrors: [],
    summary: {},
  });

  const first = refreshContextHubSnapshot(firstRoot, { refreshShared: false, force: true, taskRunner });
  const second = refreshContextHubSnapshot(secondRoot, { refreshShared: false, force: true, taskRunner });
  assert.equal(pending.size, 2);

  pending.get(secondRoot)(state("second", secondRoot, "2026-08-08T12:00:02.000Z"));
  const secondResult = await second;
  pending.get(firstRoot)(state("first", firstRoot, "2026-08-08T12:00:01.000Z"));
  const firstResult = await first;

  assert.equal(secondResult.projects.find((project) => project.root === secondRoot).current, true);
  assert.equal(firstResult.marker, "second");
  assert.equal(firstResult.projects.find((project) => project.root === firstRoot).current, true);
  assert.equal(firstResult.projects.find((project) => project.root === secondRoot).current, false);
  assert.equal(readContextHubSnapshot().state.marker, "second");
});

test("Context Hub reprojects grouped worktree details from a fresh snapshot", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-grouped-projection-"));
  withHubHome(t, path.join(base, "hub"));
  withSharedHome(t, path.join(base, "shared"));
  const mainRoot = makeProject(base, "Projected grouped project");
  const agentRoot = path.join(base, "Projected grouped project agent");
  execFileSync("git", ["worktree", "add", "-b", "agent/projected-group", agentRoot], { cwd: mainRoot, stdio: "ignore" });
  if (!fs.existsSync(path.join(agentRoot, ".context-room", "config.json"))) {
    fs.cpSync(path.join(mainRoot, ".context-room"), path.join(agentRoot, ".context-room"), { recursive: true });
  }
  const setHubSection = (root, id, title) => {
    const configPath = path.join(root, ".context-room", "config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
    config.title = title;
    config.hubSections = [{
      id,
      title: `${id} section`,
      description: "",
      cards: [{ id: `${id}-card`, title: `${id} card`, description: "", paths: ["docs/README.md"] }],
    }];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  };
  setHubSection(mainRoot, "main-view", "Main worktree");
  setHubSection(agentRoot, "agent-view", "Agent worktree");
  fs.appendFileSync(path.join(mainRoot, "docs", "README.md"), "\nChanged in main.\n", "utf8");
  fs.appendFileSync(path.join(agentRoot, "docs", "README.md"), "\nChanged in agent.\n", "utf8");
  const main = registerContextHubProject(mainRoot, { title: "Main worktree" });
  const agent = registerContextHubProject(agentRoot, { title: "Agent worktree" });
  assert.equal(main.logicalProjectId, agent.logicalProjectId);

  const generated = contextHubUiState(mainRoot, { refreshShared: false, refreshGit: true, force: true });
  const generatedProject = generated.projects.find((project) => project.logicalProjectId === main.logicalProjectId);
  assert.deepEqual(
    new Set(generatedProject.worktrees.map((worktree) => worktree.hubSections[0]?.id)),
    new Set(["main-view", "agent-view"]),
  );
  writeContextHubSnapshot(generated, { generatedAt: generated.generatedAt });

  let unexpectedRefresh = false;
  const projected = await refreshContextHubSnapshot(agentRoot, {
    refreshShared: false,
    taskRunner: async () => {
      unexpectedRefresh = true;
      throw new Error("fresh snapshot should be projected without a worker refresh");
    },
  });
  const project = projected.projects.find((entry) => entry.logicalProjectId === main.logicalProjectId);
  const localItem = projected.items.find((item) => item.type === "local" && item.projectKey === project.projectKey);

  assert.equal(unexpectedRefresh, false);
  assert.equal(project.id, agent.id);
  assert.equal(project.root, agent.root);
  assert.equal(project.title, "Agent worktree");
  assert.equal(project.worktree.branch, "agent/projected-group");
  assert.equal(project.hubSections[0].id, "agent-view");
  assert.equal(project.worktrees[0].id, agent.id);
  assert.equal(project.worktrees[0].current, true);
  assert.equal(project.worktrees.find((worktree) => worktree.id === main.id).current, false);
  assert.equal(project.localReviews.find((review) => review.worktreeId === agent.id).worktreeCurrent, true);
  assert.equal(project.localReviews.find((review) => review.worktreeId === main.id).worktreeCurrent, false);
  assert.equal(localItem.projectId, agent.id);
  assert.equal(localItem.root, agent.root);
  assert.equal(localItem.title, "Agent worktree");
  assert.equal(localItem.current, true);
  assert.equal(localItem.reviews.find((review) => review.worktreeId === agent.id).worktreeCurrent, true);
  assert.equal(localItem.reviews.find((review) => review.worktreeId === main.id).worktreeCurrent, false);
});

test("Context Hub snapshot reads do not republish the same refresh generation", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-refresh-events-"));
  withHubHome(t, path.join(base, "hub"));
  const project = makeProject(base, "Refresh events project");
  registerContextHubProject(project);
  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room", allowedPaths: [], watchAllow: [] });
  let generation = "2026-08-07T19:29:08.160Z";
  const { server } = createMemoryServer({
    root: hostRoot,
    registerInHub: false,
    contextHubSnapshotRefresh: async () => ({
      enabled: true,
      generatedAt: generation,
      freshness: { generatedAt: generation, refreshing: false, fresh: true },
      currentProjectId: "",
      projects: [],
      proposals: [],
      items: [],
      sharedRepositories: [],
      repositoryErrors: [],
      summary: { projects: 0, proposals: 0, localReviews: 0 },
    }),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controller = new AbortController();
  t.after(async () => {
    controller.abort();
    if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
  });

  const stream = await fetch(origin + "/api/runtime-events?workspace=refresh-events&since=0", { signal: controller.signal });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  const runtimeEvents = [];
  const readEvents = (async () => {
    const decoder = new TextDecoder();
    let payload = "";
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        payload += decoder.decode(next.value, { stream: true });
        let match = payload.match(/event: runtime\ndata: ([^\n]+)\n\n/);
        while (match) {
          runtimeEvents.push(JSON.parse(match[1]));
          payload = payload.slice((match.index || 0) + match[0].length);
          match = payload.match(/event: runtime\ndata: ([^\n]+)\n\n/);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  await fetch(origin + "/api/context-hub/catalog");
  const first = await waitForRuntimeEvent(runtimeEvents, 0);
  assert.equal(first?.type, "state-invalidated");
  assert.equal(first?.data?.source, "context-hub-refresh");
  assert.equal(first?.data?.generatedAt, generation);

  await Promise.all([
    fetch(origin + "/api/context-hub/catalog"),
    fetch(origin + "/api/context-hub/review-queue?limit=80"),
    fetch(origin + "/api/context-hub/sections"),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(runtimeEvents.length, 1, `duplicate refresh generation published: ${runtimeEvents[1]?.data?.generatedAt || ""}`);

  generation = "2026-08-07T19:29:09.160Z";
  await fetch(origin + "/api/context-hub/catalog");
  const changed = await waitForRuntimeEvent(runtimeEvents, 1);
  assert.equal(changed?.type, "state-invalidated");
  assert.equal(changed?.data?.generatedAt, generation);
  controller.abort();
  await readEvents;
});

test("Context Hub attention keeps project order and exact-version snoozes private and revision-safe", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-attention-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);

  const initial = readContextHubAttention();
  const ordered = setContextHubProjectOrder(["local:important", "shared:team:project"], { expectedRevision: initial.revision });
  assert.deepEqual(ordered.projectOrder, ["local:important", "shared:team:project"]);
  assert.notEqual(ordered.revision, initial.revision);

  const until = new Date(Date.now() + 3_600_000).toISOString();
  const snoozed = setContextHubReviewSnoozes([
    { reviewId: "local:project:file:docs/README.md", revisionToken: "local:current:sha256:abc", until },
    { reviewId: "shared:repo:proposal/example", revisionToken: "shared:def", until },
  ], { expectedRevision: ordered.revision });
  assert.equal(snoozed.snoozes["local:project:file:docs/README.md"].revisionToken, "local:current:sha256:abc");
  assert.equal(snoozed.snoozes["shared:repo:proposal/example"].until, until);
  assert.equal(fs.statSync(path.join(hubHome, "attention.json")).mode & 0o777, 0o600);

  assert.throws(
    () => setContextHubProjectOrder([], { expectedRevision: initial.revision }),
    (error) => error.code === "attention_revision_conflict" && error.statusCode === 409,
  );

  const returned = removeContextHubReviewSnoozes(["local:project:file:docs/README.md"], { expectedRevision: snoozed.revision });
  assert.equal(returned.snoozes["local:project:file:docs/README.md"], undefined);
  assert.ok(returned.snoozes["shared:repo:proposal/example"]);
});

test("Context Hub attention revision is a cross-process compare-and-swap", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-attention-cas-"));
  const hubHome = path.join(base, "hub");
  const firstBlocked = path.join(base, "first-blocked");
  const releaseFirst = path.join(base, "release-first");
  const secondReady = path.join(base, "second-ready");
  withHubHome(t, hubHome);
  const expectedRevision = readContextHubAttention().revision;
  const moduleUrl = new URL("../src/context_hub.mjs", import.meta.url).href;
  const firstScript = `
    import fs from "node:fs";
    const originalRename = fs.renameSync;
    fs.renameSync = function(source, target) {
      if (String(target).endsWith("attention.json") && !fs.existsSync(process.env.FIRST_BLOCKED)) {
        fs.writeFileSync(process.env.FIRST_BLOCKED, "blocked");
        while (!fs.existsSync(process.env.RELEASE_FIRST)) {
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
        }
      }
      return originalRename.call(this, source, target);
    };
    const hub = await import(${JSON.stringify(moduleUrl)} + "?attention-first=" + Date.now());
    const result = hub.setContextHubProjectOrder(["first"], { expectedRevision: ${JSON.stringify(expectedRevision)} });
    process.stdout.write(JSON.stringify({ outcome: "written", revision: result.revision }));
  `;
  const secondScript = `
    import fs from "node:fs";
    fs.writeFileSync(process.env.SECOND_READY, "ready");
    const hub = await import(${JSON.stringify(moduleUrl)} + "?attention-second=" + Date.now());
    try {
      hub.setContextHubProjectOrder(["second"], { expectedRevision: ${JSON.stringify(expectedRevision)} });
      process.stdout.write(JSON.stringify({ outcome: "written" }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ outcome: error.code || error.message }));
    }
  `;

  const first = runNodeModule(firstScript, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    FIRST_BLOCKED: firstBlocked,
    RELEASE_FIRST: releaseFirst,
  });
  await waitForFile(firstBlocked);
  const second = runNodeModule(secondScript, {
    CONTEXT_ROOM_HUB_HOME: hubHome,
    SECOND_READY: secondReady,
  });
  await waitForFile(secondReady);
  await new Promise((resolve) => setTimeout(resolve, 100));
  fs.writeFileSync(releaseFirst, "release\n", "utf8");

  const [firstResult, secondResult] = (await Promise.all([first, second])).map(JSON.parse);
  assert.equal(firstResult.outcome, "written");
  assert.equal(secondResult.outcome, "attention_revision_conflict");
  assert.deepEqual(readContextHubAttention().projectOrder, ["first"]);
});

test("progressive project Explorer bounds a 20,000-file folder and searches paths without content", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-large-explorer-"));
  const docs = path.join(root, "docs");
  fs.mkdirSync(docs, { recursive: true });
  for (let index = 0; index < 20_000; index += 1) {
    fs.writeFileSync(path.join(docs, `file-${String(index).padStart(5, "0")}.md`), "", "utf8");
  }
  initializeContextRoomProject(root, { title: "Large Explorer", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  const first = listProjectExplorerPage(root, { directory: "docs" });
  assert.equal(first.total, 20_000);
  assert.equal(first.entries.length, 250);
  assert.ok(first.entries.every((entry) => typeof entry.name === "string" && entry.name.length > 0));
  assert.equal(first.nextCursor, "250");
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 100_000);
  assert.equal(first.entries.every((entry) => !("content" in entry) && !("summary" in entry)), true);
  const second = listProjectExplorerPage(root, { directory: "docs", cursor: first.nextCursor });
  assert.equal(second.entries[0].path, "docs/file-00250.md");
  const search = listProjectExplorerPage(root, { query: "file-00001" });
  assert.deepEqual(search.entries.map((entry) => entry.path), ["docs/file-00001.md"]);
});

test("registered Git worktrees stay distinct locally but appear as one logical project", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-worktrees-"));
  withHubHome(t, path.join(base, "hub"));
  const mainRoot = makeProject(base, "Grouped project");
  const worktreeRoot = path.join(base, "Grouped project agent");
  execFileSync("git", ["worktree", "add", "-b", "agent/grouped-project", worktreeRoot], { cwd: mainRoot, stdio: "ignore" });
  if (!fs.existsSync(path.join(worktreeRoot, ".context-room", "config.json"))) {
    fs.cpSync(path.join(mainRoot, ".context-room"), path.join(worktreeRoot, ".context-room"), { recursive: true });
  }
  fs.appendFileSync(path.join(worktreeRoot, "docs", "README.md"), "\nChanged in the agent worktree.\n", "utf8");

  const main = registerContextHubProject(mainRoot);
  const agent = registerContextHubProject(worktreeRoot);
  assert.notEqual(main.id, agent.id);
  assert.equal(main.logicalProjectId, agent.logicalProjectId);
  assert.equal(readContextHubRegistry().projects.length, 2);

  const room = createMemoryServer({ root: mainRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const hub = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(hub.summary.localProjects, 1);
  assert.equal(hub.summary.localWorktrees, 2);
  const project = hub.projects.find((item) => item.logicalProjectId === main.logicalProjectId);
  assert.equal(project.worktreeCount, 2);
  assert.deepEqual(new Set(project.worktrees.map((worktree) => worktree.id)), new Set([main.id, agent.id]));
  assert.equal(project.localReviews.some((review) => review.worktreeId === agent.id && review.worktreeLabel === "agent/grouped-project"), true);

  const html = await (await fetch(origin + "/")).text();
  const source = `${html}\n${contextRoomWebAssetBundle().js}`;
  assert.match(source, /id="singleProjectWorktreeSwitch"/);
  assert.match(source, /function contextHubWorktreeSelectorMarkup\(/);
  assert.match(source, /data-global-project-worktree/);
  assert.match(source, /data-single-project-worktree/);
  assert.match(source, /context-hub-worktree-count/);
});

test("Context Hub accepts selected local file versions as one verified batch", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-accept-batch-"));
  withHubHome(t, path.join(base, "hub"));
  const root = makeProject(base, "Batch acceptance");
  fs.appendFileSync(path.join(root, "docs", "README.md"), "\nReviewed update.\n", "utf8");
  fs.writeFileSync(path.join(root, "docs", "SECOND.md"), "# Second reviewed file\n", "utf8");
  execFileSync("git", ["add", "docs/README.md", "docs/SECOND.md"], { cwd: root, stdio: "ignore" });
  const registered = registerContextHubProject(root);

  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const hubResponse = await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  });
  assert.equal(hubResponse.status, 200);
  const hub = await hubResponse.json();
  const project = hub.projects.find((item) => item.id === registered.id);
  assert.deepEqual(project.localReviews.map((review) => review.path).sort(), ["docs/README.md", "docs/SECOND.md"]);
  const items = project.localReviews.map((review) => ({
    id: `local:${review.worktreeId || registered.id}:file:${review.path}`,
    revisionToken: `local:${review.resourceState}:${review.resourceVersion || "-"}:${review.currentHash}`,
  }));

  const staleResponse = await fetch(origin + "/api/context-hub/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ items: items.map((item, index) => index ? item : { ...item, revisionToken: item.revisionToken + ":stale" }) }),
  });
  assert.equal(staleResponse.status, 409);
  assert.equal((await staleResponse.json()).code, "context_hub_accept_stale");

  const acceptedResponse = await fetch(origin + "/api/context-hub/accept", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ items }),
  });
  assert.equal(acceptedResponse.status, 200);
  const accepted = await acceptedResponse.json();
  assert.equal(accepted.summary.localReviews, 2);
  assert.equal(accepted.summary.failed, 0);
  assert.deepEqual(accepted.accepted.map((item) => item.path).sort(), ["docs/README.md", "docs/SECOND.md"]);

  const refreshed = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(refreshed.projects.find((item) => item.id === registered.id).localReviews.length, 0);
});

test("Context Room Home combines global review queues without nesting another Home", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-api-"));
  withHubHome(t, path.join(base, "hub"));
  const first = makeProject(base, "First project");
  const second = makeProject(base, "Second project");
  fs.appendFileSync(path.join(second, "docs", "README.md"), "\nNeeds review.\n", "utf8");
  fs.writeFileSync(path.join(second, "docs", "SECOND.md"), "# Second file\n", "utf8");
  fs.writeFileSync(
    path.join(second, ".context-room", "review-state.json"),
    JSON.stringify({
      version: 1,
      reviews: {
        "docs/README.md": {
          status: "verified",
          reviewedAt: "2026-07-24T12:00:00.000Z",
          resourceState: "present",
        },
      },
    }, null, 2) + "\n",
    "utf8",
  );
  const firstEntry = registerContextHubProject(first);
  const secondEntry = registerContextHubProject(second);

  const room = createMemoryServer({ root: first });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const rootPage = await fetch(origin + "/");
  assert.equal(rootPage.headers.get("content-security-policy"), "frame-ancestors 'self'");
  const rootHtml = await rootPage.text();
  const rootSource = `${rootHtml}\n${contextRoomWebAssetBundle().js}`;
  assert.match(rootSource, /class="context-room-brand"/);
  assert.doesNotMatch(rootSource, /data-context-room-view=/);
  assert.doesNotMatch(rootSource, /contextRoomReviewHistory|Review history|contextHubHistoryItems|localReviewHistory/);
  assert.match(rootSource, /id="contextHubManageProjects"[^>]*>Manage projects…</);
  assert.match(rootSource, /id="openCodexPromptCenter"/);
  assert.ok(rootSource.indexOf("Review queue") < rootSource.indexOf("<h2>Context health</h2>"));
  assert.doesNotMatch(rootSource, /Your sections/);
  assert.doesNotMatch(rootSource, /id="contextHubHome"/);
  assert.doesNotMatch(rootSource, /id="contextHubHomeProjectFrame"/);
  assert.doesNotMatch(rootSource, /context-room-project-home-height/);
  assert.doesNotMatch(rootSource, /body\.context-hub-project-embed/);
  assert.match(rootSource, /id="contextHubProjectPicker"/);
  assert.match(rootSource, /id="contextHubProjectPickerSearch"/);
  assert.match(rootSource, /data-context-hub-project-picker-trigger="room-home"/);
  assert.match(rootSource, /id="contextRoomReviewSourceFilter"/);
  assert.match(rootSource, /id="contextRoomReviewSearch"/);
  assert.match(rootSource, /data-context-room-review/);
  assert.match(rootSource, /class="context-room-review-proposal/);
  assert.match(rootSource, /class="context-room-proposal-hitbox"/);
  assert.match(rootSource, /context-room-proposal-hitbox[^\n]+data-context-room-review=/);
  assert.match(rootSource, /data-context-room-proposal-description=/);
  assert.match(rootSource, /data-context-room-proposal-description-toggle=/);
  assert.match(rootSource, /function syncContextRoomProposalDescriptionToggles\(\)/);
  assert.ok(rootSource.indexOf("const descriptionToggle = event.target.closest") < rootSource.indexOf("const selectionEntry = event.target.closest"));
  assert.doesNotMatch(rootSource, /data-context-room-proposal-toggle/);
  assert.match(rootSource, /id="contextRoomReviewSelection"/);
  assert.match(rootSource, /id="contextRoomReviewContextMenu"/);
  assert.match(rootSource, /data-context-room-review-entry=/);
  assert.match(rootSource, /addEventListener\("contextmenu"/);
  assert.match(rootSource, /data-context-room-selection-toggle=/);
  assert.match(rootSource, /state\.contextRoomSelectedReviews\.size > 0 && selectionEntry/);
  assert.match(rootSource, /function toggleContextRoomReviewSelection\(item\)/);
  assert.doesNotMatch(rootSource, /data-context-room-select=/);
  assert.match(rootSource, /data-context-room-accept-selected/);
  assert.match(rootSource, /data-context-room-reject-selected/);
  assert.doesNotMatch(rootSource, /data-context-room-review-visibility="snoozed"/);
  assert.match(rootSource, /data-context-room-snooze-open=/);
  assert.match(rootSource, /data-context-room-snooze-selected/);
  assert.match(rootSource, /data-context-room-snooze-preset="1h"/);
  assert.match(rootSource, /data-context-room-snooze-duration/);
  assert.match(rootSource, /data-context-room-snooze-time/);
  assert.match(rootSource, /Only the versions currently shown are hidden/);
  assert.match(rootSource, /id: "review-snoozed"/);
  assert.match(rootSource, /id="settingsSnoozedReviewSearch"/);
  assert.match(rootSource, /data-settings-unsnooze-review=/);
  assert.match(rootSource, /data-global-context-snooze-reviews/);
  assert.match(rootSource, /data-context-snooze-reviews/);
  assert.match(rootSource, /function contextRoomReviewSnooze\(item\)/);
  assert.match(rootSource, /snooze\.revisionToken !== item\.revisionToken/);
  assert.match(rootSource, /data-global-context-priority="top"/);
  assert.match(rootSource, /title: "Project priority"/);
  assert.doesNotMatch(rootSource, /data-context-room-reject-proposal/);
  assert.match(rootSource, /\/api\/context-hub\/accept/);
  assert.match(rootSource, /\/api\/context-hub\/reject/);
  assert.match(rootSource, /exact Git revision stays archived on a rejected branch/);
  assert.match(rootSource, /Each file stays atomic\. Shared changes stay grouped by proposal\./);
  assert.match(rootSource, /projectFilter\.disabled = Boolean\(state\.sharedContextBusy\)/);
  assert.match(rootSource, /project selected · Shared offline · cached @/);
  assert.match(rootSource, /repositoryId: repositorySelector/);
  assert.match(rootSource, /function buildContextRoomModeCodexPrompt/);
  assert.match(rootSource, /data-context-room-mode-prompt="shared"/);
  assert.match(rootSource, /Two review flows are active for/);
  assert.match(rootSource, /state\.contextHubSource = "all"/);
  assert.match(rootSource, /function contextRoomReviewPriority/);
  assert.match(rootSource, /function renderContextRoomGlobalReviewQueue/);
  assert.match(rootSource, /CONTEXT_HUB_HOME_REVIEW_LIMIT = 80/);
  assert.match(rootSource, /id="sharedProposalProjectFilter"[^>]+aria-haspopup="dialog"/);
  assert.match(rootSource, /function renderContextHubProjectPicker/);
  assert.match(rootSource, /contextHubProjectPickerQuery = event\.target\.value/);
  assert.match(rootSource, /state\.activeProjectLocationId = ""/);
  assert.match(rootSource, /async function openInitialContextHubRequestedProject\(contextHub, requestedGeneration = 0\)[\s\S]*openContextHubProject\(exactLocationId, \{ pushHistory: false \}, requestedGeneration\)/);
  assert.match(rootSource, /x-context-room-target-project/);
  assert.match(rootSource, /target\.searchParams\.set\("hub", "1"\)/);
  assert.doesNotMatch(rootSource, /state\.contextHubView = "review"/);
  const hubResponse = await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  });
  assert.equal(hubResponse.status, 200);
  const hub = await hubResponse.json();
  assert.equal(hub.summary.localProjects, 2);
  assert.equal(hub.projects.some((project) => project.id === firstEntry.id && project.current), true);
  assert.equal(
    hub.items.some((item) => item.type === "local" && item.projectId === secondEntry.id && item.reviewStatus === "local_changes" && item.fileCount === 2),
    true,
    JSON.stringify({ secondProject: hub.projects.find((project) => project.id === secondEntry.id), localItems: hub.items.filter((item) => item.type === "local") }, null, 2),
  );
  const secondProject = hub.projects.find((project) => project.id === secondEntry.id);
  assert.deepEqual(secondProject.localReviewFiles.sort(), ["docs/README.md", "docs/SECOND.md"]);
  assert.deepEqual(secondProject.localReviews.map((review) => review.path).sort(), ["docs/README.md", "docs/SECOND.md"]);
  assert.equal("localReviewHistory" in secondProject, false);
  assert.equal("reviewHistory" in hub.summary, false);
  const secondLocalItem = hub.items.find((item) => item.type === "local" && item.projectId === secondEntry.id);
  assert.deepEqual(secondLocalItem.reviews.map((review) => review.path).sort(), ["docs/README.md", "docs/SECOND.md"]);
  const snoozeReview = secondLocalItem.reviews.find((review) => review.path === "docs/SECOND.md");
  const snoozeId = `${secondLocalItem.id}:worktree:${snoozeReview.worktreeId || secondLocalItem.projectId}:file:${snoozeReview.path}`;
  const snoozeToken = `local:${snoozeReview.resourceState}:${snoozeReview.resourceVersion || "-"}:${snoozeReview.currentHash}`;
  const snoozeResponse = await fetch(origin + "/api/context-hub/reviews/snooze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({
      until: new Date(Date.now() + 3_600_000).toISOString(),
      expectedRevision: hub.attention.revision,
      items: [{ id: snoozeId, revisionToken: snoozeToken }],
    }),
  });
  const snoozeResult = await snoozeResponse.json();
  assert.equal(snoozeResponse.status, 200, JSON.stringify(snoozeResult));
  assert.equal(snoozeResult.attention.snoozes[snoozeId].revisionToken, snoozeToken);
  const staleSnooze = await fetch(origin + "/api/context-hub/reviews/snooze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({
      until: new Date(Date.now() + 3_600_000).toISOString(),
      expectedRevision: snoozeResult.attention.revision,
      items: [{ id: snoozeId, revisionToken: snoozeToken + ":stale" }],
    }),
  });
  assert.equal(staleSnooze.status, 409);
  assert.equal((await staleSnooze.json()).code, "review_revision_conflict");
  const unsnoozeResponse = await fetch(origin + "/api/context-hub/reviews/unsnooze", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ reviewIds: [snoozeId], expectedRevision: snoozeResult.attention.revision }),
  });
  assert.equal(unsnoozeResponse.status, 200);
  assert.equal((await unsnoozeResponse.json()).attention.snoozes[snoozeId], undefined);
  assert.ok(secondProject.hubSections.length > 0);
  assert.ok(secondProject.hubSections.flatMap((section) => section.cards).some((card) => card.paths.length > 0));

  const catalogResponse = await fetch(origin + "/api/context-hub/catalog");
  assert.equal(catalogResponse.status, 200);
  assert.match(catalogResponse.headers.get("server-timing") || "", /catalog;dur=/);
  const catalog = await catalogResponse.json();
  assert.equal("localReviews" in catalog.projects[0], false);
  assert.equal("hubSections" in catalog.projects[0], false);
  const reviewPage = await (await fetch(origin + "/api/context-hub/review-queue?limit=1")).json();
  assert.equal(reviewPage.items.length, 1);
  assert.ok(reviewPage.nextCursor);
  const compactLocalItem = reviewPage.items.find((item) => item.type === "local");
  if (compactLocalItem?.reviews?.length) {
    assert.deepEqual(compactLocalItem.files, []);
    assert.equal("dependencyVersions" in compactLocalItem.reviews[0], false);
  }
  const sectionsPage = await (await fetch(origin + "/api/context-hub/sections")).json();
  assert.equal(sectionsPage.projects.some((project) => project.projectKey === secondProject.projectKey && project.hubSections.length > 0), true);
  const attentionResponse = await fetch(origin + `/api/context-hub/attention?projectId=${encodeURIComponent(secondEntry.id)}`);
  assert.equal(attentionResponse.status, 200);
  const attentionPayload = await attentionResponse.json();
  assert.equal(attentionPayload.items.filter((item) => item.kind === "review").length, 2);
  assert.ok(attentionPayload.items.every((item) => item.schemaVersion === "context-room.attention-item/1"));

  fs.writeFileSync(path.join(second, "docs", "THIRD.md"), "# Third file\n", "utf8");
  const cachedHub = await (await fetch(origin + "/api/context-hub")).json();
  assert.equal(cachedHub.items.find((item) => item.type === "local" && item.projectId === secondEntry.id).fileCount, 2);
  const refreshedHub = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(refreshedHub.items.find((item) => item.type === "local" && item.projectId === secondEntry.id).fileCount, 3);
  const refreshedSecondProject = refreshedHub.projects.find((project) => project.id === secondEntry.id);
  const batchItems = ["docs/README.md", "docs/THIRD.md"].map((reviewPath) => {
    const review = refreshedSecondProject.localReviews.find((item) => item.path === reviewPath);
    return {
      id: `local:${secondEntry.id}:file:${review.path}`,
      revisionToken: `local:${review.resourceState}:${review.resourceVersion || "-"}:${review.currentHash}`,
    };
  });
  const unconfirmedBatch = await fetch(origin + "/api/context-hub/reject", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ items: batchItems }),
  });
  assert.equal(unconfirmedBatch.status, 403);
  assert.equal((await unconfirmedBatch.json()).code, "context_hub_rejection_challenge_required");
  const batchChallengeResponse = await fetch(origin + "/api/context-hub/reject-challenge", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ items: batchItems }),
  });
  assert.equal(batchChallengeResponse.status, 201);
  const batchChallenge = await batchChallengeResponse.json();
  assert.match(batchChallenge.selectionDigest, /^[a-f0-9]{64}$/);
  const rejectedBatch = await fetch(origin + "/api/context-hub/reject", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ items: batchItems, challengeId: batchChallenge.challengeId }),
  });
  assert.equal(rejectedBatch.status, 200, await rejectedBatch.text());

  const secondReview = refreshedSecondProject.localReviews.find((review) => review.path === "docs/SECOND.md");
  const secondRevisionToken = `local:${secondReview.resourceState}:${secondReview.resourceVersion || "-"}:${secondReview.currentHash}`;

  const rejectedLocal = await fetch(origin + "/api/context-hub/reject", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ items: [{ id: `local:${secondEntry.id}:file:docs/SECOND.md`, revisionToken: secondRevisionToken }] }),
  });
  assert.equal(rejectedLocal.status, 200);
  const rejectedLocalResult = await rejectedLocal.json();
  assert.equal(rejectedLocalResult.summary.localReviews, 1);
  const hubAfterRejection = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(
    hubAfterRejection.projects.find((project) => project.id === secondEntry.id)
      .localReviews.find((review) => review.path === "docs/SECOND.md").reviewStatus,
    "needs_changes",
  );

  const openedResponse = await fetch(origin + "/api/context-hub/project", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ projectId: secondEntry.id }),
  });
  assert.equal(openedResponse.status, 201);
  const opened = await openedResponse.json();
  assert.equal(opened.current, true);
  assert.equal(opened.url, origin);
  const projectFilesResponse = await fetch(origin + "/api/files", {
    headers: {
      "x-context-room-project": room.projectId,
      "x-context-room-target-project": secondEntry.id,
    },
  });
  assert.equal(projectFilesResponse.status, 200);
  assert.equal(projectFilesResponse.headers.get("x-context-room-target-project"), secondEntry.id);
  const projectFiles = await projectFilesResponse.json();
  assert.equal(fs.realpathSync(projectFiles.root), fs.realpathSync(second));
  assert.ok(projectFiles.files.some((file) => file.path === "docs/SECOND.md"));
});

test("global Explorer context actions stay scoped to the selected local project", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-explorer-actions-"));
  withHubHome(t, path.join(base, "hub"));
  const hostRoot = makeProject(base, "Host project");
  const targetRoot = makeProject(base, "Target project");
  const target = registerContextHubProject(targetRoot);
  registerContextHubProject(hostRoot);
  const room = createMemoryServer({ root: hostRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const request = (body) => fetch(origin + "/api/context-hub/project-explorer/action", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ projectId: target.id, ...body }),
  });

  const createFolderResponse = await request({ action: "create-folder", path: "docs/context-menu" });
  assert.equal(createFolderResponse.status, 200);
  assert.equal(fs.existsSync(path.join(targetRoot, "docs", "context-menu")), true);
  assert.equal(fs.existsSync(path.join(hostRoot, "docs", "context-menu")), false);

  const createFileResponse = await request({ action: "create-markdown", path: "docs/context-menu/notes.md", title: "Notes" });
  assert.equal(createFileResponse.status, 200);
  assert.equal(fs.existsSync(path.join(targetRoot, "docs", "context-menu", "notes.md")), true);

  const rootExplorerResponse = await fetch(origin + "/api/context-hub/project-explorer?projectId=" + encodeURIComponent(target.id));
  assert.equal(rootExplorerResponse.status, 200);
  assert.match(rootExplorerResponse.headers.get("server-timing") || "", /explorer;dur=/);
  const rootExplorer = await rootExplorerResponse.json();
  assert.equal(rootExplorer.mode, "directory");
  assert.equal(rootExplorer.entries.some((entry) => entry.type === "directory" && entry.path === "docs"), true);
  assert.equal(rootExplorer.entries.some((entry) => entry.path === "docs/README.md"), false);
  assert.equal("content" in rootExplorer.entries[0], false);

  const docsExplorer = await (await fetch(origin + "/api/context-hub/project-explorer?projectId=" + encodeURIComponent(target.id) + "&path=docs")).json();
  assert.equal(docsExplorer.entries.some((entry) => entry.path === "docs/README.md"), true);
  assert.equal(docsExplorer.entries.some((entry) => entry.path === "docs/context-menu" && entry.hasChildren), true);

  const settingsResponse = await fetch(origin + "/api/context-hub/project-settings?projectId=" + encodeURIComponent(target.id));
  const settingsText = await settingsResponse.text();
  assert.equal(settingsResponse.status, 200, settingsText);
  assert.match(settingsResponse.headers.get("etag") || "", /^"[a-f0-9]+"$/);
  assert.ok(Buffer.byteLength(settingsText) < 50_000);
  const settingsPayload = JSON.parse(settingsText);
  assert.equal("hubSections" in settingsPayload, false);
  assert.ok(settingsPayload.revision);
  const notModified = await fetch(origin + "/api/context-hub/project-settings?projectId=" + encodeURIComponent(target.id), {
    headers: { "if-none-match": settingsResponse.headers.get("etag") },
  });
  assert.equal(notModified.status, 304);
  const staleSave = await fetch(origin + "/api/context-hub/project-settings", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId, "x-context-room-owner-nonce": room.ownerMutationNonce },
    body: JSON.stringify({ projectId: target.id, expectedRevision: "stale", settings: settingsPayload.settings }),
  });
  assert.equal(staleSave.status, 409);

  const watchResponse = await request({ action: "watch-folder", path: "docs/context-menu", mode: "recursive-live" });
  assert.equal(watchResponse.status, 200);
  assert.equal(readMemoryWebappSettings(targetRoot).watchRules.some((rule) => rule.path.replace(/\/$/, "") === "docs/context-menu"), true);

  const inspectionResponse = await fetch(origin + "/api/context-hub/project-inspection?projectId=" + encodeURIComponent(target.id));
  assert.equal(inspectionResponse.status, 200);
  const inspection = await inspectionResponse.json();
  assert.equal(inspection.project.id, target.id);
  assert.equal(fs.realpathSync(inspection.project.root), fs.realpathSync(targetRoot));
  assert.ok(Array.isArray(inspection.doctor.issues));
  assert.ok(Array.isArray(inspection.startupContext));
  assert.ok(Array.isArray(inspection.startupSkills));
  assert.ok(Array.isArray(inspection.startupHooks));
});

test("Context Hub rejects hard-linked project control files before registration", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-control-hardlink-registration-"));
  withHubHome(t, path.join(base, "hub"));
  const victimRoot = makeProject(base, "Victim project");

  for (const fileName of ["config.json", "review-gate.json"]) {
    const targetRoot = makeProject(base, `Target ${fileName}`);
    const target = path.join(targetRoot, ".context-room", fileName);
    const victim = path.join(victimRoot, ".context-room", fileName);
    const victimBytes = fs.readFileSync(victim);
    fs.unlinkSync(target);
    fs.linkSync(victim, target);

    assert.throws(
      () => registerContextHubProject(targetRoot),
      (error) => error?.code === "context_hub_project_control_file_unsafe" && /hard links|one filesystem link/i.test(error.message),
    );
    assert.deepEqual(fs.readFileSync(victim), victimBytes);
  }

  assert.deepEqual(listContextHubProjects(), []);
});

test("hard-linked config and review gate stay fail-closed after registration in local and global HTTP", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-control-hardlink-http-"));
  withHubHome(t, path.join(base, "hub"));
  const hostRoot = makeProject(base, "Hub host");
  const globalRoom = createMemoryServer({ root: hostRoot });
  await new Promise((resolve) => globalRoom.server.listen(0, "127.0.0.1", resolve));
  t.after(() => globalRoom.server.close());
  const globalOrigin = `http://127.0.0.1:${globalRoom.server.address().port}`;

  for (const fixture of [
    { fileName: "config.json", endpoint: "/api/settings", body: (settings) => ({ settings: { ...settings, title: "Must not escape" } }) },
    { fileName: "review-gate.json", endpoint: "/api/review-gate", body: () => ({ reviewGate: { operations: ["push"] } }) },
  ]) {
    const targetRoot = makeProject(base, `Registered ${fixture.fileName}`);
    const victimRoot = makeProject(base, `Victim ${fixture.fileName}`);
    const settings = readMemoryWebappSettings(targetRoot);
    const registered = registerContextHubProject(targetRoot);
    const localRoom = createMemoryServer({ root: targetRoot });
    await new Promise((resolve) => localRoom.server.listen(0, "127.0.0.1", resolve));
    const localOrigin = `http://127.0.0.1:${localRoom.server.address().port}`;
    const target = path.join(targetRoot, ".context-room", fixture.fileName);
    const victim = path.join(victimRoot, ".context-room", fixture.fileName);
    const victimBytes = fs.readFileSync(victim);
    fs.unlinkSync(target);
    fs.linkSync(victim, target);
    try {
      const indexed = listContextHubProjects().find((project) => project.id === registered.id);
      assert.equal(indexed?.available, false);

      const localGet = await fetch(`${localOrigin}/api/settings`);
      assert.equal(localGet.status, 409, await localGet.text());
      const localPost = await fetch(`${localOrigin}${fixture.endpoint}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-context-room-project": localRoom.projectId,
          "x-context-room-owner-nonce": localRoom.ownerMutationNonce,
        },
        body: JSON.stringify(fixture.body(settings)),
      });
      assert.equal(localPost.status, 409, await localPost.text());

      const globalPost = await fetch(`${globalOrigin}/api/context-hub/project-settings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-context-room-project": globalRoom.projectId,
          "x-context-room-owner-nonce": globalRoom.ownerMutationNonce,
        },
        body: JSON.stringify({
          projectId: registered.id,
          expectedRevision: "must-not-be-reached",
          settings: { ...settings, title: "Must not escape through Hub" },
          reviewGate: { operations: ["merge"] },
        }),
      });
      assert.equal(globalPost.status, 409, await globalPost.text());
      assert.deepEqual(fs.readFileSync(victim), victimBytes);
      assert.equal(fs.lstatSync(target).nlink, 2);
    } finally {
      await new Promise((resolve) => localRoom.server.close(resolve));
    }
  }
});

test("a registered project root cannot be retargeted through a replacement symlink", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-root-capability-"));
  withHubHome(t, path.join(base, "hub"));
  const targetRoot = makeProject(base, "Registered root");
  const victimRoot = makeProject(base, "Unregistered victim");
  const hostRoot = makeProject(base, "Capability host");
  const registered = registerContextHubProject(targetRoot);
  const victimConfig = path.join(victimRoot, ".context-room", "config.json");
  const victimBytes = fs.readFileSync(victimConfig);
  const retiredRoot = `${targetRoot}-retired`;
  fs.renameSync(targetRoot, retiredRoot);
  fs.symlinkSync(victimRoot, targetRoot, "dir");

  const indexed = listContextHubProjects();
  const selected = indexed.find((project) => project.id === registered.id);
  assert.equal(selected?.root, registered.root);
  assert.equal(selected?.available, false);
  assert.equal(indexed.some((project) => project.root === victimRoot), false);

  const room = createMemoryServer({ root: hostRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const response = await fetch(`http://127.0.0.1:${room.server.address().port}/api/context-hub/project-settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-owner-nonce": room.ownerMutationNonce,
    },
    body: JSON.stringify({
      projectId: registered.id,
      expectedRevision: "must-not-be-reached",
      settings: { title: "Retargeted" },
    }),
  });
  assert.equal(response.status, 409, await response.text());
  assert.deepEqual(fs.readFileSync(victimConfig), victimBytes);
});

test("legacy project root identities migrate once and reject a later physical replacement", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-root-identity-migration-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const legacyRoot = makeProject(base, "Legacy registered root");
  const canonicalRoot = fs.realpathSync(legacyRoot);
  fs.mkdirSync(hubHome, { recursive: true });
  fs.writeFileSync(path.join(hubHome, "registry.json"), JSON.stringify({
    version: 2,
    projects: [{ root: canonicalRoot, title: "Legacy registered root" }],
    sharedRepositories: [],
  }, null, 2) + "\n");

  const [migrated] = listContextHubProjects();
  assert.equal(migrated.available, true);
  const persisted = JSON.parse(fs.readFileSync(path.join(hubHome, "registry.json"), "utf8"));
  assert.equal(persisted.version, CONTEXT_HUB_REGISTRY_VERSION);
  assert.match(String(persisted.projects[0].rootIdentity?.dev || ""), /^\d+$/);
  assert.match(String(persisted.projects[0].rootIdentity?.ino || ""), /^\d+$/);
  assert.equal(persisted.projects[0].worktreeIdentity?.kind, "git");

  const retiredRoot = `${canonicalRoot}-retired`;
  fs.renameSync(canonicalRoot, retiredRoot);
  const replacementRoot = makeProject(base, "Legacy registered root");
  const replacementConfig = path.join(replacementRoot, ".context-room", "config.json");
  const replacementBytes = fs.readFileSync(replacementConfig);
  const [afterReplacement] = listContextHubProjects();
  assert.equal(afterReplacement.id, migrated.id);
  assert.equal(afterReplacement.root, migrated.root);
  assert.equal(afterReplacement.available, false);
  const persistedAfter = JSON.parse(fs.readFileSync(path.join(hubHome, "registry.json"), "utf8"));
  assert.deepEqual(persistedAfter.projects[0].rootIdentity, persisted.projects[0].rootIdentity);

  const hostRoot = makeProject(base, "Legacy migration host");
  const room = createMemoryServer({ root: hostRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const response = await fetch(`http://127.0.0.1:${room.server.address().port}/api/context-hub/project-settings`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": room.projectId,
      "x-context-room-owner-nonce": room.ownerMutationNonce,
    },
    body: JSON.stringify({ projectId: migrated.id, expectedRevision: "must-not-be-reached", settings: { title: "Retargeted" } }),
  });
  assert.equal(response.status, 409, await response.text());
  assert.deepEqual(fs.readFileSync(replacementConfig), replacementBytes);
});

test("Context Hub never blocks on a FIFO project config and bounds control-file reads", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-control-file-bounds-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const fifoRoot = path.join(base, "FIFO project");
  fs.mkdirSync(path.join(fifoRoot, ".context-room"), { recursive: true });
  const fifoConfig = path.join(fifoRoot, ".context-room", "config.json");
  execFileSync("mkfifo", [fifoConfig]);
  fs.mkdirSync(hubHome, { recursive: true });
  fs.writeFileSync(path.join(hubHome, "registry.json"), JSON.stringify({
    version: 2,
    projects: [{ root: fifoRoot, title: "FIFO project" }],
    sharedRepositories: [],
  }, null, 2) + "\n");

  const moduleUrl = pathToFileURL(path.resolve("src/context_hub.mjs")).href;
  const output = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    `import { listContextHubProjects } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(listContextHubProjects()));`,
  ], {
    cwd: path.resolve("."),
    env: { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome },
    encoding: "utf8",
    timeout: 1_500,
  });
  const [fifoProject] = JSON.parse(output);
  assert.equal(fifoProject.available, false);
  assert.throws(() => registerContextHubProject(fifoRoot), /regular non-symbolic-link file/i);

  const oversizedRoot = path.join(base, "Oversized project");
  fs.mkdirSync(path.join(oversizedRoot, ".context-room"), { recursive: true });
  fs.writeFileSync(path.join(oversizedRoot, ".context-room", "config.json"), Buffer.alloc(2_097_153, 0x20));
  assert.throws(() => registerContextHubProject(oversizedRoot), /exceeds 2097152 bytes/i);
});

test("offline local Shared repository aliases keep one canonical identity", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-offline-repository-alias-"));
  withHubHome(t, path.join(base, "hub"));
  const canonicalBase = fs.realpathSync(base);
  const aliasRepository = path.join(base, "offline.git");
  const canonicalRepository = path.join(canonicalBase, "offline.git");

  assert.equal(fs.existsSync(aliasRepository), false);
  assert.equal(contextHubRepositoryIdentity(aliasRepository), contextHubRepositoryIdentity(canonicalRepository));
  assert.equal(
    contextHubRepositoryIdentity(pathToFileURL(aliasRepository).href),
    contextHubRepositoryIdentity(pathToFileURL(canonicalRepository).href),
  );

  const first = registerContextHubSharedRepository(aliasRepository);
  const second = registerContextHubSharedRepository(canonicalRepository);
  assert.equal(first.repository, second.repository);
  assert.equal(readContextHubRegistry().sharedRepositories.length, 1);
});

test("Context Room keeps a 150-project registry complete in the live picker while the review queue stays bounded", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-many-projects-"));
  const hubHome = path.join(base, "hub");
  withHubHome(t, hubHome);
  const activeRoot = makeProject(base, "Active project");
  const active = registerContextHubProject(activeRoot);
  const registry = readContextHubRegistry();
  const projects = [
    active,
    ...Array.from({ length: 149 }, (_, index) => ({
      root: path.join(base, "archived", `Project ${String(index + 1).padStart(3, "0")}`),
      title: `Project ${String(index + 1).padStart(3, "0")}`,
      registeredAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      lastOpenedAt: new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString(),
      shared: null,
    })),
  ];
  fs.writeFileSync(
    path.join(hubHome, "registry.json"),
    JSON.stringify({ ...registry, projects }, null, 2) + "\n",
    "utf8",
  );

  assert.equal(listContextHubProjects().length, 150);
  assert.equal(listContextHubProjects()[0].available, true);

  const room = createMemoryServer({ root: activeRoot });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => room.server.close());
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const hub = await (await fetch(origin + "/api/context-hub/refresh", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: "{}",
  })).json();
  assert.equal(hub.summary.localProjects, 150);
  assert.equal(hub.projects.filter((project) => project.mode !== "shared").length, 150);
  assert.ok(hub.projects.length >= 150);

  const html = await (await fetch(origin + "/")).text();
  const bundle = contextRoomWebAssetBundle();
  assert.ok(Buffer.byteLength(html) < 100_000);
  assert.match(bundle.js, /visibleReviews = renderedReviews\.slice\(0, CONTEXT_HUB_HOME_REVIEW_LIMIT\)/);
  assert.match(bundle.js, /choices: needle \? projects : \[null, \.\.\.projects\]/);
  assert.match(bundle.js, /contextHubProjectPickerQuery = event\.target\.value/);
});
