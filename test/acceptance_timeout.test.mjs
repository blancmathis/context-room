import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createGitHubInstallationToken } from "../src/github_app_token.mjs";
import {
  DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
  acceptSharedReview,
  connectSharedContext,
  createSharedProposal,
  initializeSharedRepository,
  materializeSharedReview,
  publishSharedProposal,
  sharedDeliveryTimeoutBudget,
} from "../src/shared_context.mjs";
import {
  initializeContextRoomProject,
  writeDocReviewDecision,
} from "../src/context_room.mjs";

const { privateKey: testPrivateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function configureGit(root) {
  git(root, ["config", "user.email", "acceptance-timeout@example.test"]);
  git(root, ["config", "user.name", "Acceptance Timeout Test"]);
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

function makeSharedFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-acceptance-timeout-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(base, ["clone", remote, seed], { stdio: "ignore" });
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Acceptance timeout fixture" });
  writeFile(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  writeFile(seed, "projects/demo/skills/demo-workflow/SKILL.md", "---\nname: demo-workflow\ndescription: Fixture workflow.\n---\n\n# Demo workflow\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared context"]);
  git(seed, ["push", "origin", "main"]);
  initializeContextRoomProject(project, { title: "Demo", allowedPaths: ["README.md"], watchAllow: [] });

  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(home, ".context-room", "shared");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    removeWritableTree(base);
  });
  return { base, remote, project };
}

test("createGitHubInstallationToken aborts a hung request with a clear retryable timeout", { timeout: 1_000 }, async () => {
  const timeoutMs = 25;
  let requestSignal = null;
  let requestAborted = false;
  const request = createGitHubInstallationToken({
    appId: "123456",
    privateKey: testPrivateKey,
    installationId: "987654",
    repository: "context-room",
    timeoutMs,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal || null;
      return new Promise((_resolve, reject) => {
        requestSignal?.addEventListener("abort", () => {
          requestAborted = true;
          const error = new Error("request aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    },
  }).then(
    (value) => ({ status: "resolved", value }),
    (error) => ({ status: "rejected", error }),
  );

  const outcome = await Promise.race([
    request,
    new Promise((resolve) => setTimeout(() => resolve({ status: "deadline" }), timeoutMs * 5)),
  ]);

  assert.notEqual(outcome.status, "deadline", "the GitHub token request exceeded its explicit timeout budget");
  assert.equal(outcome.status, "rejected");
  assert.equal(requestSignal instanceof AbortSignal, true, "fetch must receive an abort signal");
  assert.equal(requestAborted, true, "the in-flight fetch must be aborted");
  assert.equal(outcome.error?.code, "github-app-token-timeout");
  assert.equal(outcome.error?.retryable, true);
  assert.match(outcome.error?.message || "", /GitHub App installation token request timed out/i);
});

test("local acceptance has a non-zero default Git delivery budget", () => {
  assert.equal(sharedDeliveryTimeoutBudget(), DEFAULT_SHARED_DELIVERY_TIMEOUT_MS);
  assert.ok(sharedDeliveryTimeoutBudget() > 0);
});

test("shared main delivery bounds a stalled git push and reports a retryable timeout", { timeout: 15_000 }, (t) => {
  const fixture = makeSharedFixture(t);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Bound stalled delivery",
    branch: "proposal/demo/bound-stalled-delivery",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nReady for bounded delivery.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact proposal file reviewed",
  });

  const realGit = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], { encoding: "utf8" }).trim();
  const fakeBin = path.join(fixture.base, "fake-bin");
  const fakeGit = path.join(fakeBin, "git");
  const pushStartedAtFile = path.join(fixture.base, "push-started-at");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "push" ]; then
  : > ${JSON.stringify(pushStartedAtFile)}
  sleep 5
  printf '%s\\n' 'simulated stalled git push' >&2
  exit 124
fi
if [ "$1" = "fetch" ]; then
  exit 0
fi
exec ${JSON.stringify(realGit)} "$@"
`, "utf8");
  fs.chmodSync(fakeGit, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });

  const timeoutMs = 1_000;
  let deliveryError = null;
  try {
    acceptSharedReview(review.reviewRoot, {
      message: "Accept with a bounded delivery",
      push: {
        token: "test-installation-token",
        url: fixture.remote,
        timeoutMs,
      },
    });
  } catch (error) {
    deliveryError = error;
  }

  assert.ok(deliveryError, "a stalled push must fail instead of reporting delivery success");
  assert.equal(
    fs.existsSync(pushStartedAtFile),
    true,
    `the test must reach the delivery push before asserting its timeout; received ${deliveryError?.stack || deliveryError}`,
  );
  const elapsedSincePushMs = Date.now() - fs.statSync(pushStartedAtFile).mtimeMs;
  assert.equal(deliveryError.code, "shared-delivery-timeout");
  assert.equal(deliveryError.retryable, true);
  assert.match(deliveryError.message, /git push timed out/i);
  assert.ok(elapsedSincePushMs < 3_000, `delivery exceeded its timeout budget (${elapsedSincePushMs}ms since push started)`);
});

test("local acceptance bounds its initial fetch without push credentials", { timeout: 15_000 }, (t) => {
  const fixture = makeSharedFixture(t);
  connectSharedContext(fixture.project, { repository: fixture.remote, projectId: "demo" });
  const proposal = createSharedProposal(fixture.project, {
    title: "Bound local acceptance fetch",
    branch: "proposal/demo/bound-local-acceptance-fetch",
  });
  configureGit(proposal.root);
  writeFile(proposal.root, "projects/demo/docs/README.md", "# Demo\n\nReady for a bounded local acceptance.\n");
  publishSharedProposal(fixture.project, { proposal: proposal.branch });
  const review = materializeSharedReview(fixture.project, { proposal: proposal.branch });
  writeDocReviewDecision(review.reviewRoot, "projects/demo/docs/README.md", {
    status: "verified",
    note: "Exact local proposal file reviewed",
  });

  const mainBefore = git(fixture.remote, ["rev-parse", "refs/heads/main"]);
  const realGit = execFileSync("/usr/bin/env", ["sh", "-c", "command -v git"], { encoding: "utf8" }).trim();
  const fakeBin = path.join(fixture.base, "fake-fetch-bin");
  const fakeGit = path.join(fakeBin, "git");
  const fetchStartedAtFile = path.join(fixture.base, "fetch-started-at");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(fakeGit, `#!/bin/sh
if [ "$1" = "fetch" ]; then
  : > ${JSON.stringify(fetchStartedAtFile)}
  sleep 5
  printf '%s\\n' 'simulated stalled git fetch' >&2
  exit 124
fi
exec ${JSON.stringify(realGit)} "$@"
`, "utf8");
  fs.chmodSync(fakeGit, 0o755);

  const previousPath = process.env.PATH;
  process.env.PATH = `${fakeBin}:${previousPath}`;
  t.after(() => { process.env.PATH = previousPath; });

  let deliveryError = null;
  try {
    acceptSharedReview(review.reviewRoot, {
      message: "Accept locally with a bounded fetch",
      deliveryTimeoutMs: 1_000,
    });
  } catch (error) {
    deliveryError = error;
  }

  assert.ok(deliveryError, "a stalled local fetch must fail instead of entering an unbounded terminal operation");
  assert.equal(fs.existsSync(fetchStartedAtFile), true);
  const elapsedSinceFetchMs = Date.now() - fs.statSync(fetchStartedAtFile).mtimeMs;
  assert.equal(deliveryError.code, "shared-delivery-timeout");
  assert.equal(deliveryError.retryable, true);
  assert.match(deliveryError.message, /git fetch timed out/i);
  assert.ok(elapsedSinceFetchMs < 3_000, `fetch exceeded its timeout budget (${elapsedSinceFetchMs}ms since fetch started)`);
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), mainBefore, "a timed-out fetch must not mutate main");
});
