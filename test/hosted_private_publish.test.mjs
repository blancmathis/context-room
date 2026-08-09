import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  contextHubRepositoryId,
  createMemoryServer,
  initializeContextRoomProject,
} from "../src/context_room.mjs";
import { signRemoteIdentity } from "../src/remote_identity.mjs";
import {
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  listSharedProposalWorkspaces,
  publishSharedProposal,
} from "../src/shared_context.mjs";

const expectedHost = "context.qm.peerlab.fr";
const humanSecret = "hosted-private-publish-human-secret-32-bytes-minimum";
const agentSecret = "hosted-private-publish-agent-secret-32-bytes-minimum";
const repository = "https://github.com/context-room-tests/private-shared.git";
const repositoryId = contextHubRepositoryId(repository);
const { privateKey: githubAppPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function git(cwd, args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "hosted-private-publish@example.test"]);
  git(root, ["config", "user.name", "Hosted Private Publish Test"]);
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  const visit = (target) => {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) return;
    fs.chmodSync(target, stats.isDirectory() ? 0o700 : 0o600);
    if (stats.isDirectory()) for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
  };
  visit(root);
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

function proposalRefs(remote) {
  return git(remote, ["for-each-ref", "--format=%(refname):%(objectname)", "refs/heads/proposal/"]);
}

function credentialRepresentations(token) {
  const userPassword = `x-access-token:${token}`;
  const encoded = Buffer.from(userPassword, "utf8").toString("base64");
  return [token, userPassword, encoded, `Authorization: Basic ${encoded}`];
}

function installPrivateReadGitWrapper(base, { requireFetch = false, requirePush = false } = {}) {
  const wrapperRoot = path.join(base, "private-git-wrapper");
  const wrapper = path.join(wrapperRoot, "git");
  const logFile = path.join(base, "private-git-broker.jsonl");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  fs.mkdirSync(wrapperRoot, { recursive: true });
  fs.writeFileSync(wrapper, `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
let commandIndex = 0;
while (args[commandIndex] === "-c" && commandIndex + 1 < args.length) commandIndex += 2;
const operation = args[commandIndex] || "";
const logicalRepository = String(process.env.CR_TEST_PRIVATE_REPOSITORY || "");
const fixtureRepository = String(process.env.CR_TEST_PRIVATE_REMOTE || "");
const matchedRepository = args.includes(logicalRepository);
const networkOperation = ["clone", "fetch", "push", "ls-remote"].includes(operation);
const repositoryNetworkOperation = matchedRepository || (operation === "fetch" && args.includes("origin"));
let authenticated = false;
let credentialHash = "";
let helperConfigured = false;
let brokerRoot = "";
let brokerDirectoryMode = 0;
let socketMode = 0;
if (matchedRepository && networkOperation) {
  const prefix = args.slice(0, commandIndex);
  const helper = prefix.find((value) => String(value).includes(" credential-cache ")) || "";
  const socketMatch = String(helper).match(/--socket=(?:'([^']+)'|"([^"]+)"|([^ ]+))/);
  helperConfigured = Boolean(socketMatch);
  if (socketMatch) {
    const socketPath = socketMatch[1] || socketMatch[2] || socketMatch[3];
    brokerRoot = path.dirname(socketPath);
    try { brokerDirectoryMode = fs.statSync(brokerRoot).mode & 511; } catch {}
    try { socketMode = fs.lstatSync(socketPath).mode & 511; } catch {}
  }
  const parsed = new URL(logicalRepository);
  const input = Buffer.from("protocol=https\\nhost=github.com\\npath=" + parsed.pathname.slice(1) + "\\n\\n", "utf8");
  const filled = spawnSync(process.env.CR_TEST_REAL_GIT, [...prefix, "credential", "fill"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: process.env.CR_TEST_ORIGINAL_PATH },
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  input.fill(0);
  const password = String(filled.stdout || "").split("\\n").find((line) => line.startsWith("password="))?.slice("password=".length) || "";
  authenticated = filled.status === 0 && Boolean(password);
  credentialHash = authenticated ? createHash("sha256").update(password).digest("hex") : "";
}
if (repositoryNetworkOperation && networkOperation) {
  const forbidden = new Set(JSON.parse(process.env.CR_TEST_FORBIDDEN_CREDENTIAL_HASHES || "[]"));
  const containsForbidden = (values) => values.some((value) => forbidden.has(createHash("sha256").update(String(value)).digest("hex")));
  const procEntries = (file) => {
    try { return fs.readFileSync(file).toString("utf8").split("\\0").filter(Boolean); } catch { return []; }
  };
  fs.appendFileSync(process.env.CR_TEST_PRIVATE_READ_LOG, JSON.stringify({
    operation,
    authenticated,
    credentialHash,
    helperConfigured,
    brokerRoot,
    brokerDirectoryMode,
    socketMode,
    environmentContainsCredential: containsForbidden(Object.values(process.env)),
    argvContainsCredential: containsForbidden(args),
    procEnvironmentContainsCredential: containsForbidden(procEntries("/proc/self/environ").map((entry) => entry.slice(entry.indexOf("=") + 1))),
    procArgvContainsCredential: containsForbidden(procEntries("/proc/self/cmdline")),
    argvContainsAuthorization: args.some((value) => /(?:^Authorization:|Basic |password=)/i.test(String(value))),
  }) + "\\n");
  if ((operation === "fetch" && process.env.CR_TEST_REQUIRE_PRIVATE_FETCH === "1" && !authenticated)
    || (operation === "push" && process.env.CR_TEST_REQUIRE_PRIVATE_PUSH === "1" && !authenticated)) process.exit(87);
}
const effectiveArgs = args.map((value) => value === logicalRepository && operation !== "clone" ? fixtureRepository : value);
const result = spawnSync(process.env.CR_TEST_REAL_GIT, effectiveArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PATH: process.env.CR_TEST_ORIGINAL_PATH,
    ...(matchedRepository && authenticated ? { CR_TEST_BROKER_AUTHENTICATED: "1" } : {}),
  },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  return {
    logFile,
    env: {
      PATH: `${wrapperRoot}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`,
      CR_TEST_PRIVATE_READ_LOG: logFile,
      CR_TEST_REAL_GIT: realGit,
      CR_TEST_ORIGINAL_PATH: process.env.PATH || "/usr/bin:/bin",
      ...(requireFetch ? { CR_TEST_REQUIRE_PRIVATE_FETCH: "1" } : {}),
      ...(requirePush ? { CR_TEST_REQUIRE_PRIVATE_PUSH: "1" } : {}),
    },
  };
}

function jsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function assertTreeExcludes(root, values) {
  const needles = values.map((value) => Buffer.from(String(value), "utf8"));
  const visit = (target) => {
    const stats = fs.lstatSync(target);
    if (stats.isSymbolicLink()) return;
    if (stats.isDirectory()) {
      for (const entry of fs.readdirSync(target)) visit(path.join(target, entry));
      return;
    }
    if (!stats.isFile()) return;
    const bytes = fs.readFileSync(target);
    for (const needle of needles) assert.equal(bytes.includes(needle), false, `credential persisted in ${target}`);
  };
  visit(root);
}

function sharedRepositoryCacheDirectories(sharedHome) {
  if (!fs.existsSync(sharedHome)) return [];
  return fs.readdirSync(sharedHome)
    .filter((name) => /^[a-f0-9]{16}$/.test(name))
    .map((name) => path.join(sharedHome, name))
    .filter((target) => fs.existsSync(target) && fs.lstatSync(target).isDirectory());
}

function resetSharedReadCache(fixture, { requireAuthentication = true } = {}) {
  assert.ok(fixture.readWrapper, "the private Git wrapper must be installed");
  if (requireAuthentication) process.env.CR_TEST_REQUIRE_PRIVATE_FETCH = "1";
  else delete process.env.CR_TEST_REQUIRE_PRIVATE_FETCH;
  fs.writeFileSync(fixture.readWrapper.logFile, "", "utf8");
  const cacheDirectories = sharedRepositoryCacheDirectories(fixture.sharedHome);
  assert.ok(cacheDirectories.length > 0, "the Shared repository cache must be warm before the absence probe");
  for (const cacheDirectory of cacheDirectories) removeWritableTree(cacheDirectory);
  assert.deepEqual(sharedRepositoryCacheDirectories(fixture.sharedHome), []);
}

function assertAuthenticatedPrivateReads(events) {
  assert.ok(events.some((event) => event.operation === "clone"), JSON.stringify(events));
  assert.ok(events.some((event) => event.operation === "fetch"), JSON.stringify(events));
  assert.equal(events.every((event) => event.authenticated && event.helperConfigured), true, JSON.stringify(events));
  assert.equal(events.every((event) => event.brokerDirectoryMode === 0o700 && event.socketMode === 0o600), true, JSON.stringify(events));
  assert.equal(events.every((event) => !event.environmentContainsCredential && !event.argvContainsCredential), true, JSON.stringify(events));
  assert.equal(events.every((event) => !event.procEnvironmentContainsCredential && !event.procArgvContainsCredential), true, JSON.stringify(events));
  assert.equal(events.every((event) => !event.argvContainsAuthorization && !fs.existsSync(event.brokerRoot)), true, JSON.stringify(events));
}

function assertAnonymousSharedReads(events) {
  assert.ok(events.some((event) => event.operation === "clone"), JSON.stringify(events));
  assert.ok(events.some((event) => event.operation === "fetch"), JSON.stringify(events));
  assert.equal(events.every((event) => !event.authenticated && !event.helperConfigured), true, JSON.stringify(events));
  assert.equal(events.every((event) => !event.environmentContainsCredential && !event.argvContainsCredential), true, JSON.stringify(events));
  assert.equal(events.every((event) => !event.procEnvironmentContainsCredential && !event.procArgvContainsCredential), true, JSON.stringify(events));
  assert.equal(events.every((event) => !event.argvContainsAuthorization && !event.brokerRoot), true, JSON.stringify(events));
}

async function setupFixture(t, {
  githubApp = null,
  protectProposalPushes = true,
  protectSharedReads = false,
  sharedRefreshTimeoutMs = undefined,
  sharedScopes = [],
  credentialTokens = [],
  anonymousSharedRead = false,
} = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-private-publish-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  const hostRoot = path.join(base, "host");
  const home = path.join(base, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  const hubHome = path.join(home, ".context-room", "hub");
  const gitConfig = path.join(base, "gitconfig");
  const environmentKeys = [
    "HOME",
    "CONTEXT_ROOM_SHARED_HOME",
    "CONTEXT_ROOM_HUB_HOME",
    "GIT_CONFIG_GLOBAL",
    "PATH",
    "CR_TEST_PRIVATE_READ_LOG",
    "CR_TEST_REAL_GIT",
    "CR_TEST_ORIGINAL_PATH",
    "CR_TEST_PRIVATE_REPOSITORY",
    "CR_TEST_PRIVATE_REMOTE",
    "CR_TEST_REQUIRE_PRIVATE_FETCH",
    "CR_TEST_REQUIRE_PRIVATE_PUSH",
    "CR_TEST_FORBIDDEN_CREDENTIAL_HASHES",
  ];
  const previousEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;

  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Hosted private Shared fixture" });
  writeFile(seed, "projects.json", `${JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2)}\n`);
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial private Shared content.\n");
  writeFile(seed, "projects/demo/skills/demo/SKILL.md", "---\nname: demo\ndescription: Hosted private fixture.\n---\n\n# Demo\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize Hosted private Shared fixture"]);
  git(seed, ["push", "origin", "main"]);
  fs.writeFileSync(gitConfig, `[url "${remote}"]\n\tinsteadOf = ${repository}\n`, "utf8");
  process.env.GIT_CONFIG_GLOBAL = gitConfig;

  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(project, { title: "Demo" });
  initializeContextRoomProject(hostRoot, { title: "Hosted Context Room", allowedPaths: [], watchAllow: [] });
  connectSharedContext(project, { repository, projectId: "demo" });
  const proposal = createSharedProposal(project, {
    title: "Agent private publication",
    description: "Update one exact private Shared proposal through the Hosted agent gateway.",
    branch: "proposal/demo/agent-private-publication",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/AGENT.md", "# Agent private publication\n\nBefore Hosted patch.\n");
  const published = publishSharedProposal(project, { proposal: proposal.branch });

  if (protectProposalPushes) {
    const hook = path.join(remote, "hooks", "pre-receive");
    fs.writeFileSync(hook, [
      "#!/bin/sh",
      "while read old new ref; do",
      "  case \"$ref\" in",
      "    refs/heads/proposal/*)",
      "      case \"$CR_TEST_BROKER_AUTHENTICATED\" in",
      "        1) ;;",
      "        *) exit 1 ;;",
      "      esac",
      "      ;;",
      "  esac",
      "done",
      "exit 0",
      "",
    ].join("\n"), "utf8");
    fs.chmodSync(hook, 0o755);
  }

  const readWrapper = protectSharedReads || protectProposalPushes
    ? installPrivateReadGitWrapper(base, { requireFetch: protectSharedReads, requirePush: protectProposalPushes })
    : null;
  if (readWrapper) {
    Object.assign(process.env, readWrapper.env, {
      CR_TEST_PRIVATE_REPOSITORY: repository,
      CR_TEST_PRIVATE_REMOTE: remote,
      CR_TEST_FORBIDDEN_CREDENTIAL_HASHES: JSON.stringify(credentialTokens
        .flatMap(credentialRepresentations)
        .map((value) => createHash("sha256").update(value).digest("hex"))),
    });
  }

  const room = createMemoryServer({
    root: hostRoot,
    remoteAccess: {
      expectedHost,
      humanSecret,
      agentSecret,
      healthSecret: `${humanSecret}-health`,
      adminSubjects: ["mathis"],
      projectRoots: { demo: project },
      sharedRepositories: [{ repository, projectIds: ["demo"], scopes: sharedScopes }],
      anonymousSharedReadRepositories: anonymousSharedRead ? [repository] : [],
      githubApp,
      ...(sharedRefreshTimeoutMs ? { sharedRefreshTimeoutMs } : {}),
    },
  });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  let sequence = 0;
  const humanHeaders = (operation = "review") => ({
    "content-type": "application/json",
    "x-forwarded-host": expectedHost,
    "x-peerlab-context-identity": signRemoteIdentity({
      kind: "human",
      sub: "mathis",
      role: "admin",
      operations: [operation],
    }, humanSecret, { jti: `hosted-private-human-${++sequence}` }),
  });
  const agentHeaders = (operation) => ({
    authorization: `Bearer ${signRemoteIdentity({
      kind: "agent",
      sub: "mathis",
      projectId: "demo",
      sessionId: "hosted-private-session",
      operations: [operation],
    }, agentSecret, { jti: `hosted-private-agent-${++sequence}` })}`,
    "content-type": "application/json",
    "x-forwarded-host": expectedHost,
  });

  t.after(async () => {
    if (room.server.listening) await new Promise((resolve) => room.server.close(resolve));
    for (const [key, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeWritableTree(base);
  });

  const refresh = await fetch(`${origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: humanHeaders("review"),
    body: "{}",
  });
  assert.equal(refresh.status, 200, await refresh.text());

  return {
    agentHeaders,
    base,
    home,
    hostRoot,
    humanHeaders,
    origin,
    project,
    proposal,
    proposalPath: "projects/demo/docs/AGENT.md",
    published,
    remote,
    readWrapper,
    seed,
    sharedHome,
  };
}

function githubApp(fetchImpl, overrides = {}) {
  return {
    appId: "123456",
    installationId: "987654",
    privateKey: githubAppPrivateKey,
    fetchImpl,
    ...overrides,
  };
}

test("Hosted HTTPS private accepted and context-impact reads refresh an absent cache with one request-scoped credential", { timeout: 120_000 }, async (t) => {
  const installationToken = "hosted-private-read-installation-token";
  const tokenRequests = [];
  const fixture = await setupFixture(t, {
    sharedScopes: ["projects"],
    credentialTokens: [installationToken],
    githubApp: githubApp(async (url, options) => {
      tokenRequests.push({ url, options });
      return {
        ok: true,
        status: 201,
        json: async () => ({
          token: installationToken,
          expires_at: new Date(Date.now() + 5 * 60_000).toISOString(),
        }),
      };
    }),
  });

  resetSharedReadCache(fixture);
  const accepted = await fetch(`${fixture.origin}/api/agent/accepted?projectId=demo`, {
    headers: fixture.agentHeaders("accepted:read"),
  });
  const acceptedPayload = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(acceptedPayload));
  assert.equal(acceptedPayload.truthState, "accepted");
  assert.equal(acceptedPayload.documents.some((document) => document.path === "projects/demo/docs/README.md"), true);
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].url, "https://api.github.com/app/installations/987654/access_tokens");
  assertAuthenticatedPrivateReads(jsonLines(fixture.readWrapper.logFile));

  resetSharedReadCache(fixture);
  tokenRequests.length = 0;
  const impact = await fetch(
    `${fixture.origin}/api/proposal/context-impact?repositoryId=${encodeURIComponent(repositoryId)}&selector=${encodeURIComponent(fixture.published.branch)}`,
    { headers: fixture.humanHeaders("view") },
  );
  const impactPayload = await impact.json();
  assert.equal(impact.status, 200, JSON.stringify(impactPayload));
  assert.equal(impactPayload.repositoryId, repositoryId);
  assert.equal(impactPayload.head, fixture.published.head);
  assert.equal(impactPayload.proposal.branch, fixture.published.branch);
  assert.equal(tokenRequests.length, 1);
  assert.equal(tokenRequests[0].url, "https://api.github.com/app/installations/987654/access_tokens");
  assertAuthenticatedPrivateReads(jsonLines(fixture.readWrapper.logFile));

  const forbidden = credentialRepresentations(installationToken);
  assert.equal(Object.values(process.env).some((value) => forbidden.some((secret) => String(value).includes(secret))), false);
  assert.equal(process.argv.some((value) => forbidden.some((secret) => String(value).includes(secret))), false);
  assertTreeExcludes(fixture.base, forbidden);
});

test("Hosted HTTPS public accepted and context-impact reads preserve attested anonymous refresh without a GitHub App", { timeout: 120_000 }, async (t) => {
  const fixture = await setupFixture(t, {
    anonymousSharedRead: true,
    sharedScopes: ["projects"],
  });

  resetSharedReadCache(fixture, { requireAuthentication: false });
  const accepted = await fetch(`${fixture.origin}/api/agent/accepted?projectId=demo`, {
    headers: fixture.agentHeaders("accepted:read"),
  });
  const acceptedPayload = await accepted.json();
  assert.equal(accepted.status, 200, JSON.stringify(acceptedPayload));
  assert.equal(acceptedPayload.truthState, "accepted");
  assert.equal(acceptedPayload.documents.some((document) => document.path === "projects/demo/docs/README.md"), true);
  assertAnonymousSharedReads(jsonLines(fixture.readWrapper.logFile));

  resetSharedReadCache(fixture, { requireAuthentication: false });
  const impact = await fetch(
    `${fixture.origin}/api/proposal/context-impact?repositoryId=${encodeURIComponent(repositoryId)}&selector=${encodeURIComponent(fixture.published.branch)}`,
    { headers: fixture.humanHeaders("view") },
  );
  const impactPayload = await impact.json();
  assert.equal(impact.status, 200, JSON.stringify(impactPayload));
  assert.equal(impactPayload.repositoryId, repositoryId);
  assert.equal(impactPayload.head, fixture.published.head);
  assert.equal(impactPayload.proposal.branch, fixture.published.branch);
  assertAnonymousSharedReads(jsonLines(fixture.readWrapper.logFile));
});

test("Hosted anonymous Shared read attestation rejects an unconfigured repository identity", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-hosted-anonymous-attestation-"));
  t.after(() => removeWritableTree(base));
  initializeContextRoomProject(base, { title: "Anonymous attestation boundary", allowedPaths: [], watchAllow: [] });
  assert.throws(() => createMemoryServer({
    root: base,
    remoteAccess: {
      expectedHost,
      humanSecret,
      agentSecret,
      healthSecret: `${humanSecret}-health`,
      adminSubjects: ["mathis"],
      projectRoots: {},
      sharedRepositories: [{ repository, projectIds: ["demo"] }],
      anonymousSharedReadRepositories: ["https://github.com/context-room-tests/unconfigured.git"],
    },
  }), /exactly configured repository/);
});

for (const scenario of [
  {
    name: "no GitHub App",
    githubApp: null,
    expectedStatus: 503,
    expectedCode: "shared_context_remote_read_unavailable",
    token: "",
  },
  {
    name: "an expired installation token",
    token: "hosted-private-read-expired-token",
    githubApp: githubApp(async () => ({
      ok: true,
      status: 201,
      json: async () => ({
        token: "hosted-private-read-expired-token",
        expires_at: new Date(Date.now() - 1_000).toISOString(),
      }),
    })),
    expectedStatus: 504,
    expectedCode: "shared_context_remote_read_token_expired",
  },
  {
    name: "an installation token timeout",
    token: "",
    githubApp: githubApp(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }), { tokenTimeoutMs: 25 }),
    expectedStatus: 504,
    expectedCode: "shared_context_remote_read_token_timeout",
  },
]) {
  test(`Hosted HTTPS private accepted and context-impact reads fail before Git or cache mutation with ${scenario.name}`, { timeout: 90_000 }, async (t) => {
    const fixture = await setupFixture(t, {
      githubApp: scenario.githubApp,
      sharedScopes: ["projects"],
      credentialTokens: scenario.token ? [scenario.token] : [],
    });
    const registryBefore = fs.readFileSync(path.join(fixture.sharedHome, "registry.json"), "utf8");
    resetSharedReadCache(fixture);

    const responses = [
      await fetch(`${fixture.origin}/api/agent/accepted?projectId=demo`, {
        headers: fixture.agentHeaders("accepted:read"),
      }),
      await fetch(
        `${fixture.origin}/api/proposal/context-impact?repositoryId=${encodeURIComponent(repositoryId)}&selector=${encodeURIComponent(fixture.published.branch)}`,
        { headers: fixture.humanHeaders("view") },
      ),
    ];
    for (const response of responses) {
      const payload = await response.json();
      assert.equal(response.status, scenario.expectedStatus, JSON.stringify(payload));
      assert.equal(payload.code, scenario.expectedCode);
      if (scenario.token) assert.equal(JSON.stringify(payload).includes(scenario.token), false);
    }
    assert.deepEqual(jsonLines(fixture.readWrapper.logFile), []);
    assert.deepEqual(sharedRepositoryCacheDirectories(fixture.sharedHome), []);
    assert.equal(fs.readFileSync(path.join(fixture.sharedHome, "registry.json"), "utf8"), registryBefore);
    if (scenario.token) assertTreeExcludes(fixture.base, credentialRepresentations(scenario.token));
  });
}

test("Hosted HTTPS private Shared creation and agent publication use one exact request-scoped credential", { timeout: 60_000 }, async (t) => {
  const tokenRequests = [];
  const installationToken = "hosted-private-installation-token";
  const fixture = await setupFixture(t, {
    sharedScopes: ["projects"],
    credentialTokens: [installationToken],
    githubApp: githubApp(async (url, options) => {
      tokenRequests.push({ url, options });
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: installationToken, expires_at: new Date(Date.now() + 60_000).toISOString() }),
      };
    }),
  });

  const invalidProjectResponse = await fetch(`${fixture.origin}/api/context-hub/shared-documents`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId,
      projectId: "outside-hosted-scope",
      path: "must-not-mint-a-token.md",
      title: "Invalid project",
      description: "Repository and project scope must be validated before requesting a credential.",
    }),
  });
  assert.equal(invalidProjectResponse.status, 404, await invalidProjectResponse.text());
  const invalidProposalResponse = await fetch(`${fixture.origin}/api/agent/proposals/publish?projectId=demo`, {
    method: "POST",
    headers: fixture.agentHeaders("proposal:publish"),
    body: JSON.stringify({
      proposal: "proposal/demo/outside-hosted-cache",
      expectedProposalHead: "0".repeat(40),
      title: "Invalid proposal",
      description: "The exact proposal must be validated before requesting a credential.",
    }),
  });
  assert.equal(invalidProposalResponse.status, 403, await invalidProposalResponse.text());

  const invalidCreationResponse = await fetch(`${fixture.origin}/api/context-hub/shared-projects`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId,
      projectId: "Invalid-Project",
      title: "Invalid project",
      path: "README.md",
      description: "Input validation must fail before requesting a private repository credential.",
    }),
  });
  assert.equal(invalidCreationResponse.status, 400, await invalidCreationResponse.text());
  assert.equal(tokenRequests.length, 0);

  const projectCreationResponse = await fetch(`${fixture.origin}/api/context-hub/shared-projects`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId,
      projectId: "private-project",
      title: "Private project",
      path: "overview.md",
      description: "Create one project proposal through the exact private Hosted Shared repository.",
    }),
  });
  const createdProject = await projectCreationResponse.json();
  assert.equal(projectCreationResponse.status, 201, JSON.stringify(createdProject));
  assert.equal(createdProject.repositoryId, repositoryId);
  assert.equal(createdProject.repositoryPath, "projects/private-project/docs/overview.md");
  assert.equal(Object.hasOwn(createdProject, "repository"), false);
  assert.equal(JSON.stringify(createdProject).includes(fixture.remote), false);
  assert.equal(
    JSON.parse(git(fixture.remote, ["show", "refs/heads/main:projects.json"])).projects.some((project) => project.id === "private-project"),
    false,
  );
  assert.equal(
    git(fixture.remote, ["show", `refs/heads/${createdProject.proposal.branch}:${createdProject.repositoryPath}`]).includes("# Private project"),
    true,
  );
  assert.equal(tokenRequests.length, 1);

  const createResponse = await fetch(`${fixture.origin}/api/context-hub/shared-documents`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: JSON.stringify({
      repositoryId,
      projectId: "demo",
      path: "private/operating-model.md",
      title: "Private operating model",
      description: "Define the exact private Shared operating model under human review.",
    }),
  });
  const created = await createResponse.json();
  assert.equal(createResponse.status, 201, JSON.stringify(created));
  assert.equal(created.repositoryPath, "projects/demo/docs/private/operating-model.md");
  assert.equal(
    git(fixture.remote, ["show", `refs/heads/${created.proposal.branch}:${created.repositoryPath}`]).includes("# Private operating model"),
    true,
  );

  const original = fs.readFileSync(path.join(fixture.proposal.root, fixture.proposalPath));
  const patchedContent = "# Agent private publication\n\nPublished with one request-scoped credential.\n";
  const patchResponse = await fetch(`${fixture.origin}/api/agent/proposals/patch?projectId=demo`, {
    method: "POST",
    headers: fixture.agentHeaders("proposal:write"),
    body: JSON.stringify({
      proposal: fixture.proposal.branch,
      path: fixture.proposalPath,
      content: patchedContent,
      expectedContentHash: createHash("sha256").update(original).digest("hex"),
      expectedProposalHead: fixture.published.head,
      entryType: "file",
    }),
  });
  assert.equal(patchResponse.status, 200, await patchResponse.text());
  const publishResponse = await fetch(`${fixture.origin}/api/agent/proposals/publish?projectId=demo`, {
    method: "POST",
    headers: fixture.agentHeaders("proposal:publish"),
    body: JSON.stringify({
      proposal: fixture.proposal.branch,
      expectedProposalHead: fixture.published.head,
      title: "Agent private publication",
      description: "Publish the exact private Shared proposal with an ephemeral GitHub App credential.",
      message: "Publish private Shared proposal",
    }),
  });
  const published = await publishResponse.json();
  assert.equal(publishResponse.status, 200, JSON.stringify(published));
  assert.equal(
    git(fixture.remote, ["show", `refs/heads/${fixture.proposal.branch}:${fixture.proposalPath}`]),
    patchedContent.trim(),
  );

  assert.equal(tokenRequests.length, 4);
  for (const request of tokenRequests) {
    assert.equal(request.url, "https://api.github.com/app/installations/987654/access_tokens");
    assert.deepEqual(JSON.parse(request.options.body), {
      repositories: ["private-shared"],
      permissions: { contents: "write" },
    });
    assert.equal(request.options.signal instanceof AbortSignal, true);
  }
  assert.equal(Object.values(process.env).some((value) => String(value).includes(installationToken)), false);
  assert.equal(process.argv.some((value) => String(value).includes(installationToken)), false);
  assert.equal(git(fixture.proposal.root, ["remote", "get-url", "origin"]).includes(installationToken), false);
  const brokerEvents = jsonLines(fixture.readWrapper.logFile);
  const brokeredEvents = brokerEvents.filter((event) => event.helperConfigured);
  assert.equal(brokerEvents.filter((event) => event.operation === "push").length >= 3, true, JSON.stringify(brokerEvents));
  assert.equal(brokeredEvents.every((event) => event.authenticated), true, JSON.stringify(brokerEvents));
  assert.equal(brokeredEvents.every((event) => event.brokerDirectoryMode === 0o700 && event.socketMode === 0o600), true, JSON.stringify(brokerEvents));
  assert.equal(brokerEvents.every((event) => !event.environmentContainsCredential && !event.argvContainsCredential), true, JSON.stringify(brokerEvents));
  assert.equal(brokerEvents.every((event) => !event.procEnvironmentContainsCredential && !event.procArgvContainsCredential), true, JSON.stringify(brokerEvents));
  assert.equal(brokerEvents.every((event) => !event.argvContainsAuthorization), true, JSON.stringify(brokerEvents));
  assert.equal(brokerEvents.every((event) => !fs.existsSync(event.brokerRoot)), true, JSON.stringify(brokerEvents));
  const extraHeader = spawnSync("git", ["config", "--get", "http.https://github.com/.extraHeader"], {
    cwd: fixture.proposal.root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(extraHeader.status, 1);
  assert.equal(String(extraHeader.stdout || "").trim(), "");
  const basicHeader = credentialRepresentations(installationToken).at(-1);
  assertTreeExcludes(fixture.base, [installationToken, basicHeader]);
});

test("Hosted HTTPS private Shared refresh rotates an expired stdin-only credential and discovers a new proposal", { timeout: 90_000 }, async (t) => {
  const tokens = [
    "hosted-private-refresh-token-one",
    "hosted-private-refresh-token-two",
  ];
  const tokenRequests = [];
  const fixture = await setupFixture(t, {
    protectProposalPushes: false,
    protectSharedReads: true,
    sharedRefreshTimeoutMs: 3_000,
    credentialTokens: tokens,
    githubApp: githubApp(async (url, options) => {
      const token = tokens[tokenRequests.length];
      const expiresAt = new Date(Date.now() + 7_000).toISOString();
      tokenRequests.push({ url, options, token, expiresAt });
      return {
        ok: true,
        status: 201,
        json: async () => ({ token, expires_at: expiresAt }),
      };
    }, {
      authenticateSharedReads: true,
      deliveryTimeoutMs: 3_000,
      tokenTimeoutMs: 3_000,
    }),
  });
  assert.equal(tokenRequests.length, 1);

  const branch = "proposal/demo/rotated-private-read";
  const baseRevision = git(fixture.seed, ["rev-parse", "refs/remotes/origin/main"]);
  git(fixture.seed, ["checkout", "-B", branch, baseRevision]);
  writeFile(fixture.seed, "projects/demo/docs/ROTATED.md", "# Rotated private read\n\nVisible only after the second authenticated refresh.\n");
  git(fixture.seed, ["add", "projects/demo/docs/ROTATED.md"]);
  git(fixture.seed, ["commit", "-m", [
    "Publish a remotely created proposal",
    "",
    "Context-Room-Title: Rotated private read",
    "Context-Room-Project: demo",
    `Context-Room-Base: ${baseRevision}`,
  ].join("\n")]);
  const proposalHead = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", fixture.remote, `${proposalHead}:refs/heads/${branch}`]);

  const waitForExpiryMs = Math.max(0, Date.parse(tokenRequests[0].expiresAt) - Date.now() + 100);
  await new Promise((resolve) => setTimeout(resolve, waitForExpiryMs));
  assert.equal(Date.now() > Date.parse(tokenRequests[0].expiresAt), true);

  const refresh = await fetch(`${fixture.origin}/api/context-hub/refresh`, {
    method: "POST",
    headers: fixture.humanHeaders("review"),
    body: "{}",
  });
  const refreshed = await refresh.json();
  assert.equal(refresh.status, 200, JSON.stringify(refreshed));
  assert.equal(refreshed.proposals.some((proposal) => proposal.branch === branch && proposal.head === proposalHead), true, JSON.stringify(refreshed));
  assert.equal(tokenRequests.length, 2);
  assert.deepEqual(tokenRequests.map((request) => request.url), [
    "https://api.github.com/app/installations/987654/access_tokens",
    "https://api.github.com/app/installations/987654/access_tokens",
  ]);

  const fetches = jsonLines(fixture.readWrapper.logFile).filter((event) => event.operation === "fetch");
  assert.equal(fetches.length, 2, JSON.stringify(fetches));
  assert.equal(fetches.every((event) => event.authenticated && event.helperConfigured), true, JSON.stringify(fetches));
  assert.equal(new Set(fetches.map((event) => event.credentialHash)).size, 2, JSON.stringify(fetches));
  assert.equal(fetches.every((event) => event.brokerDirectoryMode === 0o700 && event.socketMode === 0o600), true, JSON.stringify(fetches));
  assert.equal(fetches.every((event) => !event.environmentContainsCredential && !event.argvContainsCredential), true, JSON.stringify(fetches));
  assert.equal(fetches.every((event) => !event.procEnvironmentContainsCredential && !event.procArgvContainsCredential), true, JSON.stringify(fetches));
  assert.equal(fetches.every((event) => !event.argvContainsAuthorization && !fs.existsSync(event.brokerRoot)), true, JSON.stringify(fetches));

  const forbidden = tokens.flatMap(credentialRepresentations);
  assert.equal(Object.values(process.env).some((value) => forbidden.some((secret) => String(value).includes(secret))), false);
  assert.equal(process.argv.some((value) => forbidden.some((secret) => String(value).includes(secret))), false);
  assertTreeExcludes(fixture.base, forbidden);
});

for (const scenario of [
  {
    name: "no GitHub App",
    githubApp: null,
    expectedStatus: 503,
    expectedCode: "shared_context_remote_publish_unavailable",
  },
  {
    name: "expired installation token",
    githubApp: githubApp(async () => ({
      ok: true,
      status: 201,
      json: async () => ({ token: "already-expired-token", expires_at: new Date(Date.now() - 1_000).toISOString() }),
    })),
    expectedStatus: 504,
    expectedCode: "shared_context_remote_publish_token_expired",
  },
  {
    name: "installation token timeout",
    githubApp: githubApp(async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
    }), { tokenTimeoutMs: 25 }),
    expectedStatus: 504,
    expectedCode: "shared_context_remote_publish_token_timeout",
  },
]) {
  test(`Hosted HTTPS private Shared publication fails closed without mutation on ${scenario.name}`, { timeout: 60_000 }, async (t) => {
    const fixture = await setupFixture(t, { githubApp: scenario.githubApp });
    const refsBefore = proposalRefs(fixture.remote);
    const workspacesBefore = listSharedProposalWorkspaces(fixture.project).map((item) => ({ branch: item.branch, head: item.head }));
    const createResponse = await fetch(`${fixture.origin}/api/context-hub/shared-documents`, {
      method: "POST",
      headers: fixture.humanHeaders("review"),
      body: JSON.stringify({
        repositoryId,
        projectId: "demo",
        path: `private/${scenario.name.replaceAll(" ", "-")}.md`,
        title: `Fail closed on ${scenario.name}`,
        description: "This request must fail before creating a proposal worktree, commit, registry entry, or remote ref.",
      }),
    });
    const createFailure = await createResponse.json();
    assert.equal(createResponse.status, scenario.expectedStatus, JSON.stringify(createFailure));
    assert.equal(createFailure.code, scenario.expectedCode);
    assert.equal(createFailure.error.includes("token"), false);
    assert.equal(proposalRefs(fixture.remote), refsBefore);
    assert.deepEqual(
      listSharedProposalWorkspaces(fixture.project).map((item) => ({ branch: item.branch, head: item.head })),
      workspacesBefore,
    );

    const proposalHeadBefore = git(fixture.proposal.root, ["rev-parse", "HEAD"]);
    const proposalStatusBefore = git(fixture.proposal.root, ["status", "--porcelain=v1"]);
    const publishResponse = await fetch(`${fixture.origin}/api/agent/proposals/publish?projectId=demo`, {
      method: "POST",
      headers: fixture.agentHeaders("proposal:publish"),
      body: JSON.stringify({
        proposal: fixture.proposal.branch,
        expectedProposalHead: fixture.published.head,
        title: "Agent private publication",
        description: "Fail closed before changing the exact agent proposal workspace.",
      }),
    });
    const publishFailure = await publishResponse.json();
    assert.equal(publishResponse.status, scenario.expectedStatus, JSON.stringify(publishFailure));
    assert.equal(publishFailure.code, scenario.expectedCode);
    assert.equal(git(fixture.proposal.root, ["rev-parse", "HEAD"]), proposalHeadBefore);
    assert.equal(git(fixture.proposal.root, ["status", "--porcelain=v1"]), proposalStatusBefore);
    assert.equal(proposalRefs(fixture.remote), refsBefore);
  });
}
