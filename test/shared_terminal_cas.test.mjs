import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  initializeSharedRepository,
  materializeSharedRepositoryReview,
  proposeSharedDocumentationFile,
} from "../src/shared_context.mjs";
import { writeDocReviewDecision } from "../src/context_room.mjs";
import { contextHubRepositoryIdentity } from "../src/context_hub.mjs";

const sharedModuleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
const gatewayModuleUrl = new URL("../src/qm_gateway.mjs", import.meta.url).href;

function git(cwd, args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })).trim();
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, ...relativePath.split("/"));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function removeFixtureTree(root) {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      try { fs.chmodSync(target, 0o700); } catch {}
      removeFixtureTree(target);
    }
  }
  try { fs.chmodSync(root, 0o700); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-terminal-cas-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  git(seed, ["config", "user.name", "Terminal CAS test"]);
  git(seed, ["config", "user.email", "terminal-cas@invalid.test"]);
  initializeSharedRepository(seed, { name: "Terminal CAS fixture" });
  writeFile(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize Shared terminal CAS fixture"]);
  git(seed, ["push", "origin", "main"]);
  t.after(() => removeFixtureTree(base));
  return { base, remote, seed };
}

function useSharedHome(t, root) {
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const home = path.join(root, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  fs.mkdirSync(sharedHome, { recursive: true });
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });
  return { home, sharedHome };
}

function createReviewedProposal(t, fx, home, slug) {
  const repositoryPath = `${slug}.md`;
  const created = proposeSharedDocumentationFile(fx.remote, {
    projectId: "demo",
    path: repositoryPath,
    title: `Terminal ${slug}`,
    description: `Exercise the exact distributed terminal transition for ${slug}.`,
  });
  const review = materializeSharedRepositoryReview(fx.remote, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
  });
  writeDocReviewDecision(review.reviewRoot, created.repositoryPath, {
    status: "verified",
    note: "Exact terminal CAS fixture reviewed",
  });
  return { created, review, home };
}

function runChild(action, spec, { home, sharedHome }) {
  const source = `
    import fs from "node:fs";
    import path from "node:path";
    const [sharedModuleUrl, gatewayModuleUrl, action, rawSpec] = process.argv.slice(1);
    const spec = JSON.parse(rawSpec);
    const api = await import(sharedModuleUrl);
    const gateway = await import(gatewayModuleUrl);
    try {
      let result;
      if (action === "accept") {
        result = api.acceptSharedReview(spec.reviewRoot, { message: spec.message || "Accept distributed terminal CAS" });
      } else if (action === "reject") {
        result = api.rejectSharedRepositoryProposal(spec.repository, {
          proposal: spec.proposal,
          expectedHead: spec.proposalHead,
          actor: "distributed-terminal-test",
        });
      } else if (action === "republish") {
        const opened = api.openSharedRepositoryProposalWorkspace(spec.repository, {
          proposal: spec.proposal,
          expectedHead: spec.proposalHead,
        });
        fs.writeFileSync(path.join(opened.root, ...spec.path.split("/")), spec.content, "utf8");
        result = api.publishSharedRepositoryProposal(spec.repository, {
          proposal: spec.proposal,
          expectedHead: spec.proposalHead,
          title: spec.title,
          description: spec.description,
          message: "Republish while an exact review is open",
        });
      } else if (action === "patch") {
        result = gateway.applyTextPatch(spec.proposal, spec.patch, {
          projectId: "demo",
          lockTimeoutMs: 200,
        });
      } else if (action === "list") {
        result = api.listSharedRepositoryProposals(spec.repository, { allowOffline: false });
      } else if (action === "open") {
        result = api.openSharedRepositoryProposalWorkspace(spec.repository, {
          proposal: spec.proposal,
          expectedHead: spec.proposalHead,
        });
      } else {
        throw new Error("Unknown child action");
      }
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: {
          code: error.code || "",
          statusCode: error.statusCode || 0,
          message: error.message,
          details: error.details || null,
        },
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      source,
      sharedModuleUrl,
      gatewayModuleUrl,
      action,
      JSON.stringify(spec),
    ], {
      env: {
        ...process.env,
        HOME: home,
        CONTEXT_ROOM_SHARED_HOME: sharedHome,
        GIT_AUTHOR_NAME: "Context Room Test",
        GIT_AUTHOR_EMAIL: "context-room@test.invalid",
        GIT_COMMITTER_NAME: "Context Room Test",
        GIT_COMMITTER_EMAIL: "context-room@test.invalid",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `Child ${action} exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); }
      catch { reject(new Error(`Invalid child ${action} output: ${stdout || stderr}`)); }
    });
  });
}

async function waitForPath(filePath, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(filePath), true, message);
}

function installBlockingHook(t, fx, predicate, started, release) {
  t.after(() => {
    try { fs.writeFileSync(release, "release\n", "utf8"); } catch {}
  });
  const hook = path.join(fx.remote, "hooks", "pre-receive");
  fs.writeFileSync(hook, `#!/bin/sh
block=0
while read old new ref; do
  case "$ref" in
    ${predicate})
      if [ "$new" != "0000000000000000000000000000000000000000" ]; then block=1; fi
      ;;
  esac
done
if [ "$block" = 1 ]; then
  : > ${JSON.stringify(started)}
  while [ ! -f ${JSON.stringify(release)} ]; do sleep 0.02; done
fi
`, "utf8");
  fs.chmodSync(hook, 0o755);
}

function stateRef(proposal) {
  const key = createHash("sha256").update(proposal).digest("hex");
  return `refs/heads/context-room-state/${key}`;
}

test("different Shared homes cannot accept and reject the same exact proposal", { timeout: 45_000 }, async (t) => {
  const fx = fixture(t);
  const ownerA = useSharedHome(t, path.join(fx.base, "owner-a"));
  const ownerB = {
    home: path.join(fx.base, "owner-b", "home"),
    sharedHome: path.join(fx.base, "owner-b", "home", ".context-room", "shared"),
  };
  fs.mkdirSync(ownerB.sharedHome, { recursive: true });
  const { created, review } = createReviewedProposal(t, fx, ownerA, `cross-home-${randomUUID()}`);
  const mainBefore = git(fx.remote, ["rev-parse", "refs/heads/main"]);
  const started = path.join(fx.base, "accept-cross-home.started");
  const release = path.join(fx.base, "accept-cross-home.release");
  installBlockingHook(t, fx, "refs/heads/main", started, release);

  const accepting = runChild("accept", { reviewRoot: review.reviewRoot }, ownerA);
  await waitForPath(started, "acceptance should pause before its atomic remote transaction commits");
  const rejected = await runChild("reject", {
    repository: fx.remote,
    proposal: created.proposal.branch,
    proposalHead: created.proposal.head,
  }, ownerB);
  assert.equal(rejected.ok, true, JSON.stringify(rejected));
  fs.writeFileSync(release, "release\n", "utf8");
  const accepted = await accepting;

  assert.equal(accepted.ok, false, JSON.stringify(accepted));
  assert.equal(accepted.error.statusCode, 409);
  assert.match(accepted.error.code, /^shared-proposal-terminal/);
  assert.equal(git(fx.remote, ["rev-parse", "refs/heads/main"]), mainBefore);
  assert.equal(git(fx.remote, ["rev-parse", `refs/heads/${rejected.result.rejectionBranch}`]), created.proposal.head);
  const marker = git(fx.remote, ["show", "-s", "--format=%(trailers:key=Context-Room-Terminal-Decision,valueonly)", stateRef(created.proposal.branch)]);
  assert.equal(marker, "rejected");
  const listedOnAcceptingHome = await runChild("list", { repository: fx.remote }, ownerA);
  assert.equal(listedOnAcceptingHome.ok, true, JSON.stringify(listedOnAcceptingHome));
  const rejectedOnOtherHome = listedOnAcceptingHome.result.proposals.find((item) => item.branch === created.proposal.branch);
  assert.equal(rejectedOnOtherHome?.reviewStatus, "unverified_rejection");
  assert.equal(rejectedOnOtherHome?.authorityViolation, true);
  const reopenedRejected = await runChild("open", {
    repository: fx.remote,
    proposal: created.proposal.branch,
    proposalHead: created.proposal.head,
  }, ownerA);
  assert.equal(reopenedRejected.ok, false, JSON.stringify(reopenedRejected));
  assert.equal(reopenedRejected.error.code, "shared-proposal-terminal");
  assert.equal(reopenedRejected.error.details?.reviewStatus, "rejected");
  git(fx.seed, ["push", "origin", "--delete", created.proposal.branch]);
  const reopenedRejectedWithoutProposalRef = await runChild("open", {
    repository: fx.remote,
    proposal: created.proposal.branch,
    proposalHead: created.proposal.head,
  }, ownerA);
  assert.equal(reopenedRejectedWithoutProposalRef.ok, false, JSON.stringify(reopenedRejectedWithoutProposalRef));
  assert.equal(reopenedRejectedWithoutProposalRef.error.code, "shared-proposal-terminal");
  assert.equal(reopenedRejectedWithoutProposalRef.error.details?.reviewStatus, "rejected");
});

test("republishing H2 and accepting H1 are one atomic remote state transition", { timeout: 45_000 }, async (t) => {
  const fx = fixture(t);
  const ownerA = useSharedHome(t, path.join(fx.base, "review-owner"));
  const ownerB = {
    home: path.join(fx.base, "publisher", "home"),
    sharedHome: path.join(fx.base, "publisher", "home", ".context-room", "shared"),
  };
  fs.mkdirSync(ownerB.sharedHome, { recursive: true });
  const { created, review } = createReviewedProposal(t, fx, ownerA, `republish-race-${randomUUID()}`);
  const started = path.join(fx.base, "republish-h2.started");
  const release = path.join(fx.base, "republish-h2.release");
  installBlockingHook(t, fx, `refs/heads/${created.proposal.branch}`, started, release);

  const publishing = runChild("republish", {
    repository: fx.remote,
    proposal: created.proposal.branch,
    proposalHead: created.proposal.head,
    path: created.repositoryPath,
    content: "---\ncontext_room:\n  id: demo.docs.republish-race\n---\n\n# H2\n",
    title: "Republished exact proposal",
    description: "Publish H2 while the H1 review is still open.",
  }, ownerB);
  await waitForPath(started, "H2 publication should pause before its atomic ref update commits");
  const accepted = await runChild("accept", { reviewRoot: review.reviewRoot }, ownerA);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  fs.writeFileSync(release, "release\n", "utf8");
  const published = await publishing;

  assert.equal(published.ok, false, JSON.stringify(published));
  assert.equal(published.error.statusCode, 409);
  assert.equal(git(fx.seed, ["ls-remote", "--heads", "origin", created.proposal.branch]), "");
  assert.equal(git(fx.remote, ["rev-parse", "refs/heads/main"]), accepted.result.commit);
  const marker = git(fx.remote, ["show", "-s", "--format=%(trailers:key=Context-Room-Terminal-Decision,valueonly)", stateRef(created.proposal.branch)]);
  assert.equal(marker, "accepted");
  const listedOnPublishingHome = await runChild("list", { repository: fx.remote }, ownerB);
  assert.equal(listedOnPublishingHome.ok, true, JSON.stringify(listedOnPublishingHome));
  assert.equal(listedOnPublishingHome.result.proposals.some((item) => item.branch === created.proposal.branch), false);
  const reopenedAccepted = await runChild("open", {
    repository: fx.remote,
    proposal: created.proposal.branch,
    proposalHead: created.proposal.head,
  }, ownerB);
  assert.equal(reopenedAccepted.ok, false, JSON.stringify(reopenedAccepted));
  assert.equal(reopenedAccepted.error.code, "shared-proposal-terminal");
  assert.equal(reopenedAccepted.error.details?.reviewStatus, "accepted");
  const reopenedAcceptedWithoutProposalRef = await runChild("open", {
    repository: fx.remote,
    proposal: created.proposal.branch,
    proposalHead: created.proposal.head,
  }, ownerB);
  assert.equal(reopenedAcceptedWithoutProposalRef.ok, false, JSON.stringify(reopenedAcceptedWithoutProposalRef));
  assert.equal(reopenedAcceptedWithoutProposalRef.error.code, "shared-proposal-terminal");
  assert.equal(reopenedAcceptedWithoutProposalRef.error.details?.reviewStatus, "accepted");
});

test("acceptance holds the proposal registry lock against exact agent patches", { timeout: 45_000 }, async (t) => {
  const fx = fixture(t);
  const owner = useSharedHome(t, path.join(fx.base, "patch-owner"));
  const { created, review } = createReviewedProposal(t, fx, owner, `patch-race-${randomUUID()}`);
  const started = path.join(fx.base, "accept-patch.started");
  const release = path.join(fx.base, "accept-patch.release");
  installBlockingHook(t, fx, "refs/heads/main", started, release);

  const accepting = runChild("accept", { reviewRoot: review.reviewRoot }, owner);
  await waitForPath(started, "acceptance should hold the proposal registry lock through remote delivery");
  const original = fs.readFileSync(path.join(created.proposal.root, ...created.repositoryPath.split("/")), "utf8");
  const patched = await runChild("patch", {
    proposal: { root: created.proposal.root, branch: created.proposal.branch },
    patch: {
      expectedProposalHead: created.proposal.head,
      path: created.repositoryPath,
      expectedContentHash: createHash("sha256").update(original).digest("hex"),
      content: `${original}\nUnreviewed concurrent patch.\n`,
    },
  }, owner);
  assert.equal(patched.ok, false, JSON.stringify(patched));
  assert.equal(patched.error.code, "agent_patch_busy");
  assert.equal(fs.readFileSync(path.join(created.proposal.root, ...created.repositoryPath.split("/")), "utf8"), original);
  fs.writeFileSync(release, "release\n", "utf8");
  const accepted = await accepting;
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
});

test("terminal lock recovery never removes a fresh successor generation", { timeout: 45_000 }, async (t) => {
  const fx = fixture(t);
  const owner = useSharedHome(t, path.join(fx.base, "lock-owner"));
  const { created, review } = createReviewedProposal(t, fx, owner, `lock-race-${randomUUID()}`);
  const identity = `${contextHubRepositoryIdentity(review.metadata.repository)}\0${review.metadata.proposal}\0${review.metadata.proposalHead}`;
  const lockKey = createHash("sha256").update(identity).digest("hex").slice(0, 24);
  const lock = path.join(owner.sharedHome, "locks", `accept-${lockKey}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: 99999999,
    host: os.hostname(),
    token: "stale-generation",
    createdAt: new Date(Date.now() - 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 30_000).toISOString(),
  }) + "\n", "utf8");
  fs.rmSync(lock, { recursive: true, force: true });
  fs.mkdirSync(lock, { mode: 0o700 });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    token: "fresh-successor-generation",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }) + "\n", "utf8");
  const before = fs.lstatSync(lock, { bigint: true });
  const beforeOwner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
  assert.notEqual(beforeOwner.token, "stale-generation");
  const contender = await runChild("accept", { reviewRoot: review.reviewRoot }, owner);
  assert.equal(contender.ok, false, JSON.stringify(contender));
  assert.equal(contender.error.code, "shared-terminal-decision-busy");
  const after = fs.lstatSync(lock, { bigint: true });
  const afterOwner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8"));
  assert.equal(after.dev, before.dev);
  assert.equal(after.ino, before.ino);
  assert.equal(afterOwner.token, beforeOwner.token);
});
