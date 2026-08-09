import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
  acceptSharedReview,
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  materializeSharedReview,
  publishSharedProposal,
} from "../src/shared_context.mjs";
import {
  createMemoryServer,
  initializeContextRoomProject,
  remoteAcceptanceTimeouts,
  writeSharedProposalFileBatchDecision,
} from "../src/context_room.mjs";
import { DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS } from "../src/github_app_token.mjs";
import { contextRoomEventJournalPath } from "../src/event_journal.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";

const remoteHost = "context.qm.peerlab.fr";
const humanSecret = "remote-accept-challenge-test-secret-more-than-32-bytes";
const githubRepository = "https://github.com/context-room-tests/remote-acceptance.git";
const { privateKey: githubAppPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

test("remote acceptance always applies non-zero token and Git delivery budgets", () => {
  assert.deepEqual(remoteAcceptanceTimeouts(), {
    tokenTimeoutMs: DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS,
    deliveryTimeoutMs: DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
  });
  assert.deepEqual(remoteAcceptanceTimeouts({ tokenTimeoutMs: 321, deliveryTimeoutMs: 654 }), {
    tokenTimeoutMs: 321,
    deliveryTimeoutMs: 654,
  });
  assert.deepEqual(remoteAcceptanceTimeouts({ tokenTimeoutMs: 0, deliveryTimeoutMs: -1 }), {
    tokenTimeoutMs: DEFAULT_GITHUB_APP_TOKEN_TIMEOUT_MS,
    deliveryTimeoutMs: DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
  });
});

function git(cwd, args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "remote-accept@example.test"]);
  git(root, ["config", "user.name", "Remote Accept Test"]);
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
  let lastError = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      if (!fs.existsSync(root)) return;
      makeWritable(root);
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
      if (!fs.existsSync(root)) return;
    } catch (error) {
      if (!["ENOENT", "ENOTEMPTY", "EBUSY"].includes(error?.code)) throw error;
      lastError = error;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  if (fs.existsSync(root)) throw lastError || new Error(`Unable to remove temporary fixture: ${root}`);
}

async function setupRemoteAcceptanceFixture(t, {
  githubApp = null,
  advanceMainBeforeReview = false,
  rejectionPrefix = "rejected/",
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-remote-accept-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  const hubHome = path.join(base, "hub-home");
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  const previousGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  let room = null;
  t.after(async () => {
    if (room?.server.listening) await new Promise((resolve) => room.server.close(resolve));
    if (room) await room.waitForShutdown();
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    if (previousGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfigGlobal;
    removeWritableTree(base);
  });

  fs.mkdirSync(project, { recursive: true });
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  const repository = githubApp ? githubRepository : remote;
  if (githubApp) {
    const gitConfig = path.join(base, "gitconfig");
    fs.writeFileSync(gitConfig, `[url "${remote}"]\n\tinsteadOf = ${githubRepository}\n`, "utf8");
    process.env.GIT_CONFIG_GLOBAL = gitConfig;
  }
  git(base, ["clone", repository, seed]);
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Remote acceptance fixture", rejectionPrefix });
  writeFile(seed, "projects.json", `${JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2)}\n`);
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  writeFile(seed, "projects/demo/skills/demo/SKILL.md", "---\nname: demo\ndescription: Remote acceptance fixture.\n---\n\n# Demo\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize remote acceptance fixture"]);
  git(seed, ["push", "origin", "main"]);
  const initialMainHead = git(seed, ["rev-parse", "HEAD"]);

  initializeContextRoomProject(project, { title: "Demo", allowedPaths: ["README.md"], watchAllow: [] });
  connectSharedContext(project, { repository, projectId: "demo" });
  const proposal = createSharedProposal(project, {
    title: "Remote principal-bound acceptance",
    branch: "proposal/demo/remote-principal-bound-acceptance",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted only by the challenge owner.\n");
  const published = publishSharedProposal(project, { proposal: proposal.branch });

  let advancedMainHead = "";
  if (advanceMainBeforeReview) {
    const earlierProposal = createSharedProposal(project, {
      title: "Advance main without rebasing the pending proposal",
      branch: "proposal/demo/advance-main-before-review",
    });
    configureGit(earlierProposal.root);
    const earlierPath = "projects/demo/docs/ADVANCE.md";
    writeFile(earlierProposal.root, earlierPath, "# Accepted first\n\nAdvance main independently.\n");
    const earlierPublished = publishSharedProposal(project, { proposal: earlierProposal.branch });
    const earlierReview = materializeSharedReview(project, {
      proposal: earlierProposal.branch,
      expectedHead: earlierPublished.head,
    });
    initializeContextRoomProject(earlierReview.reviewRoot, {
      title: `Review · ${earlierProposal.branch}`,
      allowedPaths: ["projects/demo/"],
      watchAllow: ["projects/demo/"],
    });
    configureGit(earlierReview.reviewRoot);
    writeSharedProposalFileBatchDecision(earlierReview.reviewRoot, {
      expectedProposalHead: earlierPublished.head,
      decision: "accept",
      files: [earlierPath],
    });
    const accepted = acceptSharedReview(earlierReview.reviewRoot);
    advancedMainHead = accepted.commit;
    assert.equal(git(seed, ["ls-remote", "--heads", "origin", "refs/heads/main"]).split(/\s+/)[0], advancedMainHead);
    assert.equal(git(remote, ["merge-base", advancedMainHead, published.head]), initialMainHead);
    assert.notEqual(advancedMainHead, initialMainHead);
  }

  room = createMemoryServer({
    root: project,
    remoteAccess: {
      expectedHost: remoteHost,
      humanSecret,
      agentSecret: `${humanSecret}-agent`,
      healthSecret: `${humanSecret}-health`,
      adminSubjects: ["human-a", "human-b"],
      projectRoots: { demo: project },
      sharedRepositories: [{ repository, projectIds: ["demo"] }],
      githubApp,
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  let tokenSequence = 0;
  const remoteHeaders = (subject, operation) => ({
    "content-type": "application/json",
    "x-forwarded-host": remoteHost,
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: subject,
      role: "admin",
      operations: [operation],
    }, humanSecret, { jti: `${subject}-${operation}-${++tokenSequence}` }),
  });

  const hubResponse = await fetch(`${origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: remoteHeaders("human-a", "review"),
    body: "{}",
  });
  const hub = await hubResponse.json();
  assert.equal(hubResponse.status, 200, JSON.stringify(hub));
  const hostedProposal = hub.proposals.find((item) => item.branch === proposal.branch);
  assert.ok(hostedProposal, JSON.stringify(hub));
  assert.equal(hostedProposal.head, published.head);
  assert.match(hostedProposal.repositoryId, /^[a-f0-9]{16}$/);
  assert.equal(hub.sharedRepositories.some((item) => item.repositoryId === hostedProposal.repositoryId), true);

  const openResponse = await fetch(`${origin}/api/context-hub/review`, {
    method: "POST",
    headers: remoteHeaders("human-a", "review"),
    body: JSON.stringify({
      repositoryId: hostedProposal.repositoryId,
      proposal: proposal.branch,
      expectedHead: published.head,
    }),
  });
  const opened = await openResponse.json();
  assert.equal(openResponse.status, 201, JSON.stringify(opened));
  assert.match(opened.url, /^\/reviews\//);
  assert.equal(opened.review.repositoryId, hostedProposal.repositoryId);
  assert.equal(opened.review.proposalHead, published.head);
  assert.equal(Object.hasOwn(opened, "reviewRoot"), false);
  const reviewOrigin = new URL(opened.url, origin).toString().replace(/\/$/, "");
  const fileReviewResponse = await fetch(`${reviewOrigin}/api/shared-context/review-files`, {
    method: "POST",
    headers: remoteHeaders("human-a", "review"),
    body: JSON.stringify({
      expectedProposalHead: published.head,
      decision: "accept",
      files: ["projects/demo/docs/README.md"],
    }),
  });
  const fileReviewText = await fileReviewResponse.text();
  assert.equal(fileReviewResponse.status, 200, fileReviewText);

  return {
    advancedMainHead,
    fileReview: JSON.parse(fileReviewText),
    hostedProposal,
    hubHome,
    initialMainHead,
    opened,
    origin,
    proposal,
    published,
    repositoryId: hostedProposal.repositoryId,
    remote,
    remoteHeaders,
    reviewOrigin,
    seed,
    sharedHome,
  };
}

test("a fresh Hosted review can decide proposal B from M0 after proposal A advances main to M1", { timeout: 60_000 }, async (t) => {
  const fixture = await setupRemoteAcceptanceFixture(t, { advanceMainBeforeReview: true });

  assert.match(fixture.advancedMainHead, /^[a-f0-9]{40}$/);
  assert.equal(fixture.opened.review.baseRevision, fixture.advancedMainHead);
  assert.equal(fixture.opened.review.proposalHead, fixture.published.head);
  assert.equal(git(fixture.remote, ["merge-base", fixture.advancedMainHead, fixture.published.head]), fixture.initialMainHead);
  assert.equal(fixture.fileReview.decision, "accept");
  assert.deepEqual(fixture.fileReview.reviewedPaths, ["projects/demo/docs/README.md"]);
});

test("Hosted rejects known and unknown exact-review routes without the canonical trailing slash", { timeout: 30_000 }, async (t) => {
  const fixture = await setupRemoteAcceptanceFixture(t);
  const routes = [
    fixture.reviewOrigin,
    `${fixture.origin}/reviews/unknown-review-authority`,
  ];

  for (const route of routes) {
    const response = await fetch(route, { headers: { "x-forwarded-host": remoteHost } });
    assert.equal(response.status, 404, route);
    assert.deepEqual(await response.json(), {
      error: "This operation is unavailable on hosted Context Room.",
      code: "remote_operation_unavailable",
    });
  }
});

test("remote rejection uses an ephemeral GitHub App credential and supports a custom rejection prefix", { timeout: 30_000 }, async (t) => {
  const tokenRequests = [];
  const installationToken = "rejection-installation-access-token";
  const fixture = await setupRemoteAcceptanceFixture(t, {
    rejectionPrefix: "declined/",
    githubApp: {
      appId: "123456",
      installationId: "987654",
      privateKey: githubAppPrivateKey,
      fetchImpl: async (url, options) => {
        tokenRequests.push({ url, options });
        return {
          ok: true,
          status: 201,
          json: async () => ({ token: installationToken, expires_at: "2099-08-07T23:59:59Z" }),
        };
      },
    },
  });
  assert.equal(fixture.opened.review.rejectionPrefix, "declined/");
  assert.equal(fixture.hostedProposal.rejectionPrefix, "declined/");
  const rejectionResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/reject`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "reject"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head }),
  });
  const rejected = await rejectionResponse.json();
  assert.equal(rejectionResponse.status, 200, JSON.stringify(rejected));
  assert.deepEqual(Object.keys(rejected).sort(), [
    "flashToken",
    "hubRefresh",
    "proposal",
    "proposalHead",
    "rejected",
    "rejectionBranch",
    "rejectionPrefix",
  ]);
  assert.equal(rejected.rejected, true);
  assert.equal(rejected.proposal, fixture.proposal.branch);
  assert.equal(rejected.proposalHead, fixture.published.head);
  assert.equal(rejected.rejectionPrefix, "declined/");
  assert.match(rejected.rejectionBranch, /^declined\/demo\/remote-principal-bound-acceptance-[a-f0-9]{12}$/);
  assert.match(rejected.flashToken, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(["complete", "pending"].includes(rejected.hubRefresh?.status), true);
  assert.equal(tokenRequests.length, 2);
  assert.equal(tokenRequests.every((request) => request.url === "https://api.github.com/app/installations/987654/access_tokens"), true);
  assert.equal(tokenRequests.every((request) => request.options.signal instanceof AbortSignal), true);
  assert.equal(tokenRequests.every((request) => JSON.parse(request.options.body).repositories[0] === "remote-acceptance"), true);
  assert.equal(Object.values(process.env).some((value) => String(value).includes(installationToken)), false);
  assert.equal(git(fixture.seed, ["remote", "get-url", "origin"]).includes(installationToken), false);
  assert.equal(
    git(fixture.seed, ["ls-remote", "--heads", "origin", `refs/heads/${rejected.rejectionBranch}`]).split(/\s+/)[0],
    fixture.published.head,
  );

  const consume = () => fetch(`${fixture.origin}/api/context-hub/flash`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "review"),
    body: JSON.stringify({ token: rejected.flashToken }),
  });
  const flashResponse = await consume();
  assert.equal(flashResponse.status, 200);
  assert.deepEqual(await flashResponse.json(), {
    outcome: "reject",
    rejectionPrefix: "declined/",
    rejectionBranch: rejected.rejectionBranch,
    hubRefresh: { status: rejected.hubRefresh.status },
  });
  const replay = await consume();
  assert.equal(replay.status, 404);
  assert.equal((await replay.json()).code, "verified_acceptance_flash_invalid");
});

test("Hosted bulk rejection validates the selection before using one request-scoped GitHub App credential", { timeout: 30_000 }, async (t) => {
  const tokenRequests = [];
  const installationToken = "bulk-rejection-installation-token";
  const fixture = await setupRemoteAcceptanceFixture(t, {
    rejectionPrefix: "archives/rejected/",
    githubApp: {
      appId: "123456",
      installationId: "987654",
      privateKey: githubAppPrivateKey,
      fetchImpl: async (url, options) => {
        tokenRequests.push({ url, options });
        return {
          ok: true,
          status: 201,
          json: async () => ({ token: installationToken, expires_at: "2099-08-07T23:59:59Z" }),
        };
      },
    },
  });

  const invalidSelectionResponse = await fetch(`${fixture.origin}/api/context-hub/reject`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "reject"),
    body: JSON.stringify({
      items: [
        { id: fixture.hostedProposal.id, expectedHead: fixture.published.head },
        { id: "proposal:unknown:proposal/demo/missing", expectedHead: fixture.published.head },
      ],
    }),
  });
  const invalidSelection = await invalidSelectionResponse.json();
  assert.equal(invalidSelectionResponse.status, 409, JSON.stringify(invalidSelection));
  assert.equal(invalidSelection.code, "context_hub_reject_stale");
  assert.equal(tokenRequests.length, 1);
  assert.equal(git(fixture.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/archives/rejected/"]), "");

  const response = await fetch(`${fixture.origin}/api/context-hub/reject`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "reject"),
    body: JSON.stringify({
      items: [{ id: fixture.hostedProposal.id, expectedHead: fixture.published.head }],
    }),
  });
  const result = await response.json();
  assert.equal(response.status, 200, JSON.stringify(result));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.summary, { proposals: 1, localReviews: 0, failed: 0 });
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].id, fixture.hostedProposal.id);
  assert.equal(result.rejected[0].rejected, true);
  assert.equal(result.rejected[0].rejectionPrefix, "archives/rejected/");
  assert.match(result.rejected[0].rejectionBranch, /^archives\/rejected\/demo\/remote-principal-bound-acceptance-[a-f0-9]{12}$/);
  assert.equal(tokenRequests.length, 2);
  assert.equal(Object.values(process.env).some((value) => String(value).includes(installationToken)), false);
  assert.equal(
    git(fixture.seed, ["ls-remote", "--heads", "origin", `refs/heads/${result.rejected[0].rejectionBranch}`]).split(/\s+/)[0],
    fixture.published.head,
  );
  const settledRefresh = await fetch(`${fixture.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "review"),
    body: "{}",
  });
  assert.equal(settledRefresh.status, 200, await settledRefresh.text());
});

test("remote terminal decision endpoints fail closed before authority or Git mutation when no GitHub App is configured", { timeout: 30_000 }, async (t) => {
  const fixture = await setupRemoteAcceptanceFixture(t);
  const mainBefore = git(fixture.remote, ["rev-parse", "refs/heads/main"]);
  const proposalBefore = git(fixture.remote, ["rev-parse", `refs/heads/${fixture.proposal.branch}`]);

  const challengeResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/accept-challenge`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "accept"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head }),
  });
  const challenge = await challengeResponse.json();
  const directAcceptResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/accept`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "accept"),
    body: JSON.stringify({
      expectedProposalHead: fixture.published.head,
      challengeId: "unavailable-without-github-app",
    }),
  });
  const directAccept = await directAcceptResponse.json();
  const exactRejectResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/reject`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "reject"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head }),
  });
  const exactReject = await exactRejectResponse.json();
  const bulkRejectResponse = await fetch(`${fixture.origin}/api/context-hub/reject`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "reject"),
    body: JSON.stringify({
      items: [{ id: fixture.hostedProposal.id, expectedHead: fixture.published.head }],
    }),
  });
  const bulkReject = await bulkRejectResponse.json();
  const journalPath = contextRoomEventJournalPath();
  const acceptanceEvents = fs.existsSync(journalPath)
    ? fs.readFileSync(journalPath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
      .filter((event) => String(event.type || "").startsWith("proposal.acceptance."))
      .map((event) => event.type)
    : [];

  assert.deepEqual({
    challenge: { status: challengeResponse.status, code: challenge.code, error: challenge.error },
    directAccept: { status: directAcceptResponse.status, code: directAccept.code, error: directAccept.error },
    exactReject: { status: exactRejectResponse.status, code: exactReject.code, error: exactReject.error },
    bulkReject: { status: bulkRejectResponse.status, code: bulkReject.code, error: bulkReject.error },
    mainHead: git(fixture.remote, ["rev-parse", "refs/heads/main"]),
    proposalHead: git(fixture.remote, ["rev-parse", `refs/heads/${fixture.proposal.branch}`]),
    rejectionRefs: git(fixture.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/rejected/"]),
    acceptanceEvents,
  }, {
    challenge: {
      status: 503,
      code: "shared_context_remote_acceptance_unavailable",
      error: "This hosted Context Room capability is temporarily unavailable.",
    },
    directAccept: {
      status: 503,
      code: "shared_context_remote_acceptance_unavailable",
      error: "This hosted Context Room capability is temporarily unavailable.",
    },
    exactReject: {
      status: 503,
      code: "shared_context_remote_rejection_unavailable",
      error: "This hosted Context Room capability is temporarily unavailable.",
    },
    bulkReject: {
      status: 503,
      code: "shared_context_remote_rejection_unavailable",
      error: "This hosted Context Room capability is temporarily unavailable.",
    },
    mainHead: mainBefore,
    proposalHead: proposalBefore,
    rejectionRefs: "",
    acceptanceEvents: [],
  });
});

test("remote terminal decisions expose retryable GitHub App token timeouts without mutating Git", { timeout: 30_000 }, async (t) => {
  const requestSignals = [];
  let tokenRequestCount = 0;
  const fixture = await setupRemoteAcceptanceFixture(t, {
    githubApp: {
      appId: "123456",
      installationId: "987654",
      privateKey: githubAppPrivateKey,
      tokenTimeoutMs: 25,
      fetchImpl: async (_url, options) => {
        const requestSignal = options.signal || null;
        requestSignals.push(requestSignal);
        tokenRequestCount += 1;
        if (tokenRequestCount === 1) {
          return {
            ok: true,
            status: 201,
            json: async () => ({ token: "materialization-installation-token", expires_at: "2099-08-07T23:59:59Z" }),
          };
        }
        return new Promise((_resolve, reject) => {
          requestSignal?.addEventListener("abort", () => {
            const error = new Error("request aborted");
            error.name = "AbortError";
            reject(error);
          }, { once: true });
        });
      },
    },
  });
  const mainBefore = git(fixture.remote, ["rev-parse", "refs/heads/main"]);
  const challengeResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/accept-challenge`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "accept"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head }),
  });
  const challenge = await challengeResponse.json();
  assert.equal(challengeResponse.status, 201, JSON.stringify(challenge));

  const acceptResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/accept`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "accept"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head, challengeId: challenge.challengeId }),
  });
  const failure = await acceptResponse.json();

  assert.equal(requestSignals[0] instanceof AbortSignal, true);
  assert.deepEqual({
    status: acceptResponse.status,
    code: failure.code,
    retryable: failure.retryable,
    main: git(fixture.remote, ["rev-parse", "refs/heads/main"]),
  }, {
    status: 504,
    code: "remote_request_rejected",
    retryable: true,
    main: mainBefore,
  });
  assert.equal(failure.error, "The hosted Context Room operation timed out safely.");

  const exactRejectResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/reject`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "reject"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head }),
  });
  const exactReject = await exactRejectResponse.json();
  assert.deepEqual({
    status: exactRejectResponse.status,
    code: exactReject.code,
    retryable: exactReject.retryable,
    main: git(fixture.remote, ["rev-parse", "refs/heads/main"]),
    proposal: git(fixture.remote, ["rev-parse", `refs/heads/${fixture.proposal.branch}`]),
  }, {
    status: 504,
    code: "remote_request_rejected",
    retryable: true,
    main: mainBefore,
    proposal: fixture.published.head,
  });

  const bulkRejectResponse = await fetch(`${fixture.origin}/api/context-hub/reject`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "reject"),
    body: JSON.stringify({
      items: [{ id: fixture.hostedProposal.id, expectedHead: fixture.published.head }],
    }),
  });
  const bulkReject = await bulkRejectResponse.json();
  assert.deepEqual({
    status: bulkRejectResponse.status,
    code: bulkReject.code,
    retryable: bulkReject.retryable,
    rejectionRefs: git(fixture.remote, ["for-each-ref", "--format=%(refname)", "refs/heads/rejected/"]),
  }, {
    status: 504,
    code: "remote_request_rejected",
    retryable: true,
    rejectionRefs: "",
  });
  assert.equal(requestSignals.length, 4);
  assert.equal(requestSignals[0] instanceof AbortSignal && !requestSignals[0].aborted, true);
  assert.equal(requestSignals.slice(1).every((signal) => signal instanceof AbortSignal && signal.aborted), true);
});

test("a remote human cannot consume another human's acceptance challenge", { timeout: 30_000 }, async (t) => {
  const tokenRequests = [];
  const fixture = await setupRemoteAcceptanceFixture(t, {
    githubApp: {
      appId: "123456",
      installationId: "987654",
      privateKey: githubAppPrivateKey,
      fetchImpl: async (url, options) => {
        tokenRequests.push({ url, options });
        return {
          ok: true,
          status: 201,
          json: async () => ({ token: "installation-access-token", expires_at: "2099-08-07T23:59:59Z" }),
        };
      },
    },
  });
  const challengeResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/accept-challenge`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "accept"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head }),
  });
  const challenge = await challengeResponse.json();
  assert.equal(challengeResponse.status, 201, JSON.stringify(challenge));
  assert.ok(challenge.challengeId);

  const mismatchedHumanResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/accept`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-b", "accept"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head, challengeId: challenge.challengeId }),
  });
  assert.equal(mismatchedHumanResponse.status, 403);
  assert.equal((await mismatchedHumanResponse.json()).code, "shared_context_acceptance_challenge_mismatch");

  const ownerResponse = await fetch(`${fixture.reviewOrigin}/api/shared-context/accept`, {
    method: "POST",
    headers: fixture.remoteHeaders("human-a", "accept"),
    body: JSON.stringify({ expectedProposalHead: fixture.published.head, challengeId: challenge.challengeId }),
  });
  const accepted = await ownerResponse.json();
  assert.equal(ownerResponse.status, 200, JSON.stringify(accepted));
  assert.equal(accepted.accepted, true);
  assert.equal(accepted.deliveryVerified, true);

  assert.equal(tokenRequests.length, 2);
  assert.equal(tokenRequests.every((request) => request.url === "https://api.github.com/app/installations/987654/access_tokens"), true);
  assert.equal(tokenRequests.every((request) => request.options.signal instanceof AbortSignal), true);
  assert.equal(tokenRequests.every((request) => JSON.parse(request.options.body).repositories[0] === "remote-acceptance"), true);
  git(fixture.seed, ["fetch", "origin"]);
  assert.match(git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]), /challenge owner/);
  const journalPath = contextRoomEventJournalPath();
  assert.equal(path.relative(fixture.hubHome, journalPath).startsWith(".."), false);
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(fs.readFileSync(journalPath, "utf8").includes(challenge.challengeId), false);
});
