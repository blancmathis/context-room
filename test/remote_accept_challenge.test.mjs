import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  publishSharedProposal,
} from "../src/shared_context.mjs";
import {
  createMemoryServer,
  initializeContextRoomProject,
  remoteAcceptanceTimeouts,
  writeDocReviewDecision,
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
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

async function setupRemoteAcceptanceFixture(t, { githubApp = null } = {}) {
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
  initializeSharedRepository(seed, { name: "Remote acceptance fixture" });
  writeFile(seed, "projects.json", `${JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2)}\n`);
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  writeFile(seed, "projects/demo/skills/demo/SKILL.md", "---\nname: demo\ndescription: Remote acceptance fixture.\n---\n\n# Demo\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize remote acceptance fixture"]);
  git(seed, ["push", "origin", "main"]);

  initializeContextRoomProject(project, { title: "Demo", allowedPaths: ["README.md"], watchAllow: [] });
  connectSharedContext(project, { repository, projectId: "demo" });
  const proposal = createSharedProposal(project, {
    title: "Remote principal-bound acceptance",
    branch: "proposal/demo/remote-principal-bound-acceptance",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nAccepted only by the challenge owner.\n");
  const published = publishSharedProposal(project, { proposal: proposal.branch });

  room = createMemoryServer({
    root: project,
    remoteAccess: {
      expectedHost: remoteHost,
      humanSecret,
      agentSecret: `${humanSecret}-agent`,
      healthSecret: `${humanSecret}-health`,
      adminSubjects: ["human-a", "human-b"],
      projectRoots: { demo: project },
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

  const openResponse = await fetch(`${origin}/api/shared-context/review`, {
    method: "POST",
    headers: remoteHeaders("human-a", "review"),
    body: JSON.stringify({ proposal: proposal.branch, expectedHead: published.head }),
  });
  const opened = await openResponse.json();
  assert.equal(openResponse.status, 201, JSON.stringify(opened));
  assert.match(opened.url, /^\/reviews\//);
  writeDocReviewDecision(opened.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Remote test fixture review",
  });

  const reviewOrigin = new URL(opened.url, origin).toString().replace(/\/$/, "");
  return {
    hubHome,
    opened,
    origin,
    proposal,
    published,
    remote,
    remoteHeaders,
    reviewOrigin,
    seed,
  };
}

test("remote acceptance endpoints fail closed before authority or Git mutation when no GitHub App is configured", { timeout: 30_000 }, async (t) => {
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
    mainHead: git(fixture.remote, ["rev-parse", "refs/heads/main"]),
    proposalHead: git(fixture.remote, ["rev-parse", `refs/heads/${fixture.proposal.branch}`]),
    acceptanceEvents,
  }, {
    challenge: {
      status: 503,
      code: "shared_context_remote_acceptance_unavailable",
      error: "Remote acceptance requires a configured GitHub App.",
    },
    directAccept: {
      status: 503,
      code: "shared_context_remote_acceptance_unavailable",
      error: "Remote acceptance requires a configured GitHub App.",
    },
    mainHead: mainBefore,
    proposalHead: proposalBefore,
    acceptanceEvents: [],
  });
});

test("remote acceptance exposes a retryable GitHub App token timeout without mutating main", { timeout: 30_000 }, async (t) => {
  let requestSignal = null;
  const fixture = await setupRemoteAcceptanceFixture(t, {
    githubApp: {
      appId: "123456",
      installationId: "987654",
      privateKey: githubAppPrivateKey,
      tokenTimeoutMs: 25,
      fetchImpl: async (_url, options) => {
        requestSignal = options.signal || null;
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

  assert.equal(requestSignal instanceof AbortSignal, true);
  assert.deepEqual({
    status: acceptResponse.status,
    code: failure.code,
    retryable: failure.retryable,
    main: git(fixture.remote, ["rev-parse", "refs/heads/main"]),
  }, {
    status: 504,
    code: "github-app-token-timeout",
    retryable: true,
    main: mainBefore,
  });
  assert.match(failure.error || "", /installation token request timed out/i);
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
          json: async () => ({ token: "installation-access-token", expires_at: "2026-08-07T23:59:59Z" }),
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

  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].url, "https://api.github.com/app/installations/987654/access_tokens");
  assert.equal(tokenRequests[0].options.signal instanceof AbortSignal, true);
  assert.deepEqual(JSON.parse(tokenRequests[0].options.body).repositories, ["remote-acceptance"]);
  git(fixture.seed, ["fetch", "origin"]);
  assert.match(git(fixture.seed, ["show", "origin/main:projects/demo/docs/README.md"]), /challenge owner/);
  const journalPath = contextRoomEventJournalPath();
  assert.equal(path.relative(fixture.hubHome, journalPath).startsWith(".."), false);
  assert.equal(fs.existsSync(journalPath), true);
  assert.equal(fs.readFileSync(journalPath, "utf8").includes(challenge.challengeId), false);
});
