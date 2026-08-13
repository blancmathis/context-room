import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";

import {
  acceptSharedReview,
  initializeSharedRepository,
  listSharedRepositoryProposals,
  materializeSharedRepositoryReview,
  proposeSharedDocumentationFile,
  rejectSharedRepositoryProposal,
} from "../src/shared_context.mjs";
import { writeDocReviewDecision } from "../src/context_room.mjs";
import { contextHubRepositoryIdentity } from "../src/context_hub.mjs";
import { filesystemProcessIdentity } from "../src/filesystem_lock.mjs";
import {
  inspectOwnerProposalDecisions,
  recordOwnerProposalDecision,
} from "../src/review_authority.mjs";

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })).trim();
}

function configureGit(root) {
  git(root, ["config", "user.name", "Context Room regression test"]);
  git(root, ["config", "user.email", "context-room-regression@local.invalid"]);
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
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

function makeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-shared-p1-"));
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Shared P1 regression fixture" });
  writeFile(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared context"]);
  git(seed, ["push", "origin", "main"]);
  t.after(() => removeFixtureTree(base));
  return { base, remote, seed };
}

function withSharedHome(t, fixture) {
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const home = path.join(fixture.base, "home");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(home, ".context-room", "shared");
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
  });
}

function withGitHubAliases(t, fixture) {
  const previousGitConfig = process.env.GIT_CONFIG_GLOBAL;
  const previousNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const gitConfig = path.join(fixture.base, "alias-gitconfig");
  const httpsRepository = "https://github.com/Peerlab/context-room-p1-fixture.git";
  const sshRepository = "git@github.com:peerlab/context-room-p1-fixture.git";
  const rewriteKey = `url.file://${fixture.remote}.insteadOf`;
  git(fixture.base, ["config", "--file", gitConfig, rewriteKey, httpsRepository]);
  git(fixture.base, ["config", "--file", gitConfig, "--add", rewriteKey, sshRepository]);
  process.env.GIT_CONFIG_GLOBAL = gitConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  t.after(() => {
    if (previousGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = previousGitConfig;
    if (previousNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
    else process.env.GIT_CONFIG_NOSYSTEM = previousNoSystem;
  });
  return { httpsRepository, sshRepository };
}

function legacyCacheKey(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

function createHistoricalRepositoryCache(fixture, transport, { cacheKey = transport, slug = randomUUID() } = {}) {
  const cacheRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, legacyCacheKey(cacheKey));
  const checkout = path.join(cacheRoot, "repository");
  const branch = `proposal/demo/legacy-${slug}`;
  const proposalRoot = path.join(cacheRoot, "proposals", legacyCacheKey(branch));
  fs.mkdirSync(cacheRoot, { recursive: true });
  git(cacheRoot, ["clone", "--origin", "origin", "--no-checkout", transport, checkout]);
  git(checkout, ["worktree", "add", "-b", branch, proposalRoot, "refs/remotes/origin/main"]);
  writeFile(proposalRoot, "projects/demo/docs/README.md", "# Demo\n\nUnpublished historical local work.\n");
  const baseRevision = git(checkout, ["rev-parse", "refs/remotes/origin/main"]);
  fs.writeFileSync(path.join(cacheRoot, "proposals.json"), JSON.stringify({
    version: 1,
    proposals: {
      [branch]: {
        branch,
        root: proposalRoot,
        baseRevision,
        projectId: "demo",
        scope: "project",
        title: "Unpublished historical proposal",
        description: "Must survive the canonical repository identity upgrade.",
        createdAt: new Date().toISOString(),
      },
    },
  }, null, 2) + "\n", { mode: 0o600 });
  fs.writeFileSync(path.join(cacheRoot, "legacy-sentinel.txt"), `preserve ${branch}\n`, "utf8");
  return { cacheRoot, checkout, branch, proposalRoot, baseRevision };
}

function repositoryCacheDirectories(sharedHome) {
  return fs.readdirSync(sharedHome)
    .map((name) => path.join(sharedHome, name))
    .filter((candidate) => fs.existsSync(path.join(candidate, "repository", ".git")))
    .sort();
}

async function waitForPath(filePath, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(filePath), true, message);
}

async function waitForRefreshPause(refresh, message, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(refresh.stateReady) && Date.now() < deadline) {
    const completed = await Promise.race([
      refresh.result.then((outcome) => ({ outcome })),
      new Promise((resolve) => setTimeout(() => resolve(null), 10)),
    ]);
    if (completed) throw new Error(`${message}: child completed early: ${JSON.stringify(completed.outcome)}`);
  }
  assert.equal(fs.existsSync(refresh.stateReady), true, message);
}

function spawnSharedRepositoryRefreshProcess(fixture, spec = {}) {
  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const identity = randomUUID();
  const ready = path.join(fixture.base, `shared-refresh-${identity}.ready`);
  const stateReady = path.join(fixture.base, `shared-refresh-${identity}.state-ready`);
  const stateRelease = path.join(fixture.base, `shared-refresh-${identity}.state-release`);
  const source = `
    import fs from "node:fs";

    const [moduleUrl, rawSpec] = process.argv.slice(1);
    const spec = JSON.parse(rawSpec);
    const originalWriteFileSync = fs.writeFileSync.bind(fs);

    originalWriteFileSync(spec.ready, "ready");
    try {
      const api = await import(moduleUrl);
      const result = api.listSharedRepositoryProposals(spec.repository, {
        allowOffline: false,
        refresh: true,
        timeoutMs: 15_000,
      });
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: error.code || "", message: error.message },
      }));
    }
  `;
  const childSpec = {
    repository: spec.repository || fixture.remote,
    sharedHome: process.env.CONTEXT_ROOM_SHARED_HOME,
    pauseStateWrite: spec.pauseStateWrite === true,
    ready,
    stateReady,
    stateRelease,
  };
  const result = new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      "--input-type=module",
      "-e",
      source,
      moduleUrl,
      JSON.stringify(childSpec),
    ], {
      env: {
        ...process.env,
        ...(spec.env || {}),
        CONTEXT_ROOM_REFRESH_PAUSE: spec.pauseStateWrite ? "1" : "",
        CONTEXT_ROOM_REFRESH_PAUSE_READY: stateReady,
        CONTEXT_ROOM_REFRESH_PAUSE_RELEASE: stateRelease,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `Shared refresh child exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); }
      catch { reject(new Error(`Invalid Shared refresh child output: ${stdout || stderr}`)); }
    });
  });
  return { ready, stateReady, stateRelease, result };
}

function runAcceptanceProcess(reviewRoot) {
  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const source = `
    const [moduleUrl, reviewRoot] = process.argv.slice(1);
    const api = await import(moduleUrl);
    try {
      const result = api.acceptSharedReview(reviewRoot, { message: "Accept alias terminal regression" });
      process.stdout.write(JSON.stringify({ ok: true, result }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: error.code || "", statusCode: error.statusCode || 0, message: error.message },
      }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, moduleUrl, reviewRoot], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `Acceptance child exited ${code}`));
      try { resolve(JSON.parse(stdout || "{}")); }
      catch { reject(new Error(`Invalid acceptance child output: ${stdout || stderr}`)); }
    });
  });
}

test("same Shared Home serializes repository refresh through state publication", { timeout: 30_000 }, async (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);

  const prewarmed = listSharedRepositoryProposals(fixture.remote, {
    allowOffline: false,
    refresh: true,
  });

  const realGit = String(execFileSync("which", ["git"], { encoding: "utf8" })).trim();
  const fakeBin = path.join(fixture.base, "fake-git-refresh");
  const fakeGit = path.join(fakeBin, "git");
  const fetchMarkers = path.join(fixture.base, "fetch-markers");
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.mkdirSync(fetchMarkers, { recursive: true });
  fs.writeFileSync(fakeGit, [
    "#!/bin/sh",
    "if [ \"$1\" = \"fetch\" ]; then",
    "  printf \"fetch\\n\" > \"$CONTEXT_ROOM_FETCH_DIR/$CONTEXT_ROOM_REFRESH_SLOT\"",
    "fi",
    "\"$CONTEXT_ROOM_REAL_GIT\" \"$@\"",
    "status=$?",
    "if [ \"$1\" = \"ls-tree\" ] && [ \"$CONTEXT_ROOM_REFRESH_PAUSE\" = \"1\" ] && [ ! -f \"$CONTEXT_ROOM_REFRESH_PAUSE_READY\" ]; then",
    "  printf \"ready\\n\" > \"$CONTEXT_ROOM_REFRESH_PAUSE_READY\"",
    "  while [ ! -f \"$CONTEXT_ROOM_REFRESH_PAUSE_RELEASE\" ]; do sleep 0.01; done",
    "fi",
    "exit $status",
    "",
  ].join("\n"), "utf8");
  fs.chmodSync(fakeGit, 0o755);

  const commonEnv = {
    PATH: `${fakeBin}:${process.env.PATH}`,
    CONTEXT_ROOM_REAL_GIT: realGit,
    CONTEXT_ROOM_FETCH_DIR: fetchMarkers,
  };

  const first = spawnSharedRepositoryRefreshProcess(fixture, {
    pauseStateWrite: true,
    env: { ...commonEnv, CONTEXT_ROOM_REFRESH_SLOT: "first" },
  });
  t.after(() => {
    try { fs.writeFileSync(first.stateRelease, "release"); } catch {}
  });

  await waitForRefreshPause(first, "first refresh should pause before publishing Shared state");

  const second = spawnSharedRepositoryRefreshProcess(fixture, {
    env: { ...commonEnv, CONTEXT_ROOM_REFRESH_SLOT: "second" },
  });
  await waitForPath(second.ready, "second refresh process should start");

  const secondFetch = path.join(fetchMarkers, "second");
  const observationDeadline = Date.now() + 1_000;
  while (!fs.existsSync(secondFetch) && Date.now() < observationDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const overlappedBeforeStateCommit = fs.existsSync(secondFetch);

  fs.writeFileSync(first.stateRelease, "release");
  const outcomes = await Promise.all([first.result, second.result]);

  assert.equal(
    overlappedBeforeStateCommit,
    false,
    "a second process must not fetch while the first still owns repository state publication",
  );
  assert.equal(outcomes.every((outcome) => outcome.ok), true, JSON.stringify(outcomes));
  assert.equal(fs.existsSync(secondFetch), true, "the second refresh should continue after release");

  const revisions = new Set(outcomes.map((outcome) => outcome.result.status.revision));
  assert.deepEqual(revisions, new Set([prewarmed.status.revision]));

  const cacheRoots = fs.readdirSync(process.env.CONTEXT_ROOM_SHARED_HOME)
    .map((name) => path.join(process.env.CONTEXT_ROOM_SHARED_HOME, name))
    .filter((candidate) => fs.existsSync(path.join(candidate, "repository", ".git")));
  assert.equal(cacheRoots.length, 1);

  const state = JSON.parse(fs.readFileSync(path.join(cacheRoots[0], "state.json"), "utf8"));
  assert.equal(state.revision, prewarmed.status.revision);
  assert.equal(
    fs.statSync(path.join(cacheRoots[0], "snapshots", state.revision)).isDirectory(),
    true,
  );
});

test("a v0.6.1 local symlink cache is adopted in place without hiding unpublished proposal work", { timeout: 30_000 }, (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const alias = path.join(fixture.base, "remote-alias.git");
  fs.symlinkSync(fixture.remote, alias);
  const legacy = createHistoricalRepositoryCache(fixture, alias, { slug: "symlink" });
  const canonicalRoot = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    legacyCacheKey(contextHubRepositoryIdentity(alias)),
  );

  const listed = listSharedRepositoryProposals(alias, { allowOffline: false, refresh: true });

  assert.equal(listed.repository, alias);
  assert.deepEqual(repositoryCacheDirectories(process.env.CONTEXT_ROOM_SHARED_HOME), [legacy.cacheRoot]);
  assert.equal(fs.existsSync(canonicalRoot), false);
  assert.equal(fs.existsSync(path.join(legacy.cacheRoot, "repository-identity.json")), true);
  assert.equal(fs.readFileSync(path.join(legacy.cacheRoot, "legacy-sentinel.txt"), "utf8"), `preserve ${legacy.branch}\n`);
  assert.match(git(legacy.proposalRoot, ["status", "--porcelain=v1"]), /projects\/demo\/docs\/README\.md/);
  const registry = JSON.parse(fs.readFileSync(path.join(legacy.cacheRoot, "proposals.json"), "utf8"));
  assert.equal(registry.proposals[legacy.branch].root, legacy.proposalRoot);
});

test("a v0.6.1 file URL cache is adopted under its exact canonical repository lock", { timeout: 30_000 }, (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const repository = pathToFileURL(fixture.remote).href;
  const legacy = createHistoricalRepositoryCache(fixture, repository, { slug: "file-url" });

  const listed = listSharedRepositoryProposals(repository, { allowOffline: false, refresh: true });

  assert.equal(listed.repository, repository);
  assert.deepEqual(repositoryCacheDirectories(process.env.CONTEXT_ROOM_SHARED_HOME), [legacy.cacheRoot]);
  const claim = JSON.parse(fs.readFileSync(path.join(legacy.cacheRoot, "repository-identity.json"), "utf8"));
  assert.equal(claim.repository, repository);
  assert.equal(claim.identity, contextHubRepositoryIdentity(repository));
  assert.equal(fs.existsSync(legacy.proposalRoot), true);
});

test("macOS adopts a historical /var cache when the same repository reopens through /private/var", { timeout: 30_000 }, (t) => {
  if (process.platform !== "darwin") return t.skip("macOS filesystem alias regression");
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const canonicalRepository = fs.realpathSync(fixture.remote);
  if (canonicalRepository === fixture.remote || !fixture.remote.startsWith("/var/")) {
    return t.skip("the test temp directory does not expose the /var to /private/var alias");
  }
  const legacy = createHistoricalRepositoryCache(fixture, fixture.remote, { slug: "var-alias" });

  const listed = listSharedRepositoryProposals(canonicalRepository, { allowOffline: false, refresh: true });

  assert.equal(listed.repository, canonicalRepository);
  assert.deepEqual(repositoryCacheDirectories(process.env.CONTEXT_ROOM_SHARED_HOME), [legacy.cacheRoot]);
  assert.equal(fs.existsSync(path.join(legacy.cacheRoot, "repository-identity.json")), true);
  assert.equal(fs.existsSync(legacy.proposalRoot), true);
});

test("two unclaimed historical caches for one repository fail closed without adopting either", { timeout: 30_000 }, (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const alias = path.join(fixture.base, "ambiguous-alias.git");
  fs.symlinkSync(fixture.remote, alias);
  const first = createHistoricalRepositoryCache(fixture, alias, { slug: "ambiguous-raw" });
  const second = createHistoricalRepositoryCache(fixture, alias, {
    cacheKey: contextHubRepositoryIdentity(alias),
    slug: "ambiguous-canonical",
  });

  assert.throws(
    () => listSharedRepositoryProposals(alias, { allowOffline: false, refresh: true }),
    (error) => error?.code === "shared-repository-identity-mismatch"
      && /Multiple Shared repository caches/.test(error.message)
      && error.details?.cacheRoots?.length === 2,
  );
  assert.equal(fs.existsSync(path.join(first.cacheRoot, "repository-identity.json")), false);
  assert.equal(fs.existsSync(path.join(second.cacheRoot, "repository-identity.json")), false);
  assert.equal(fs.existsSync(first.proposalRoot), true);
  assert.equal(fs.existsSync(second.proposalRoot), true);
  assert.equal(fs.readFileSync(path.join(first.cacheRoot, "legacy-sentinel.txt"), "utf8"), `preserve ${first.branch}\n`);
  assert.equal(fs.readFileSync(path.join(second.cacheRoot, "legacy-sentinel.txt"), "utf8"), `preserve ${second.branch}\n`);
});

test("HTTPS and SSH aliases share the exact terminal-decision lock", { timeout: 30_000 }, async (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const { httpsRepository, sshRepository } = withGitHubAliases(t, fixture);
  const created = proposeSharedDocumentationFile(httpsRepository, {
    projectId: "demo",
    path: "alias-terminal-lock.md",
    title: "Alias terminal lock",
    description: "Keep one human terminal decision across equivalent repository transports.",
  });
  const review = materializeSharedRepositoryReview(httpsRepository, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
  });
  writeDocReviewDecision(review.reviewRoot, created.repositoryPath, {
    status: "verified",
    note: "Exact alias terminal proposal reviewed",
  });

  const acceptanceStarted = path.join(fixture.base, "alias-acceptance.started");
  const acceptanceRelease = path.join(fixture.base, "alias-acceptance.release");
  t.after(() => {
    try { fs.writeFileSync(acceptanceRelease, "release\n", "utf8"); } catch {}
  });
  const hook = path.join(fixture.remote, "hooks", "post-receive");
  fs.writeFileSync(hook, `#!/bin/sh
while read old new ref; do
  if [ "$ref" = "refs/heads/main" ]; then
    : > ${JSON.stringify(acceptanceStarted)}
    while [ ! -f ${JSON.stringify(acceptanceRelease)} ]; do sleep 0.02; done
  fi
done
`, "utf8");
  fs.chmodSync(hook, 0o755);

  const accepting = runAcceptanceProcess(review.reviewRoot);
  await waitForPath(acceptanceStarted, "acceptance should reach origin while holding its terminal lock");

  let rejectionError = null;
  try {
    rejectSharedRepositoryProposal(sshRepository, {
      proposal: created.proposal.branch,
      expectedHead: created.proposal.head,
      actor: "alias-terminal-contender",
    });
  } catch (error) {
    rejectionError = error;
  } finally {
    fs.writeFileSync(acceptanceRelease, "release\n", "utf8");
  }

  const accepted = await accepting;
  assert.equal(rejectionError?.code, "shared-terminal-decision-busy", rejectionError?.message);
  assert.equal(rejectionError?.statusCode, 409);
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.equal(accepted.result.accepted, true);
  const proposalSuffix = created.proposal.branch.slice("proposal/".length);
  const rejectionBranch = `rejected/${proposalSuffix}-${created.proposal.head.slice(0, 12)}`;
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", rejectionBranch]), "");
});

test("an expired terminal lease is not stolen while its local owner process is alive", { timeout: 30_000 }, async (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const created = proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "live-terminal-owner.md",
    title: "Live terminal owner",
    description: "Do not steal an expired lease from a process that is still alive.",
  });
  const review = materializeSharedRepositoryReview(fixture.remote, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
  });
  writeDocReviewDecision(review.reviewRoot, created.repositoryPath, {
    status: "verified",
    note: "Exact live-owner proposal reviewed",
  });
  const lockIdentity = `${review.metadata.repository}\0${review.metadata.proposal}\0${review.metadata.proposalHead}`;
  const lockKey = createHash("sha256").update(lockIdentity).digest("hex").slice(0, 24);
  const lock = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "locks", `accept-${lockKey}.lock`);
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({
    pid: process.pid,
    host: os.hostname(),
    token: "still-alive",
    processIdentity: filesystemProcessIdentity(process.pid),
    createdAt: new Date(Date.now() - 60 * 60_000).toISOString(),
    expiresAt: new Date(Date.now() - 45 * 60_000).toISOString(),
    proposal: review.metadata.proposal,
    proposalHead: review.metadata.proposalHead,
  }, null, 2) + "\n", "utf8");
  t.after(() => fs.rmSync(lock, { recursive: true, force: true }));

  const attempted = await runAcceptanceProcess(review.reviewRoot);
  assert.equal(attempted.ok, false, JSON.stringify(attempted));
  assert.equal(attempted.error?.code, "shared-terminal-decision-busy");
  assert.equal(attempted.error?.statusCode, 409);
  assert.equal(fs.existsSync(lock), true);
  assert.equal(
    git(fixture.remote, ["rev-parse", "refs/heads/main"]),
    review.metadata.baseRevision,
  );
});

test("HTTPS and SSH aliases agree that an externally deleted proposal is absent from the queue", { timeout: 30_000 }, (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const { httpsRepository, sshRepository } = withGitHubAliases(t, fixture);
  const created = proposeSharedDocumentationFile(httpsRepository, {
    projectId: "demo",
    path: "alias-observation.md",
    title: "Alias observation",
    description: "Keep proposal history across equivalent repository transports.",
  });
  assert.equal(
    listSharedRepositoryProposals(httpsRepository, { allowOffline: false }).proposals
      .some((proposal) => proposal.branch === created.proposal.branch),
    true,
  );

  git(fixture.seed, ["push", "origin", "--delete", created.proposal.branch]);
  assert.equal(
    listSharedRepositoryProposals(sshRepository, { allowOffline: false }).proposals
      .some((proposal) => proposal.branch === created.proposal.branch),
    false,
  );
});

test("a recovered proposal authority blocks rejection before any remote archive mutation", { timeout: 30_000 }, (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const created = proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "recovered-authority.md",
    title: "Recovered authority",
    description: "Fail closed until the owner repairs recovered terminal authority.",
  });
  const authorityHome = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "review-authority");
  recordOwnerProposalDecision(fixture.remote, {
    proposal: "proposal/demo/authority-sentinel",
    proposalHead: "a".repeat(40),
    decision: "accepted",
    acceptedCommit: git(fixture.remote, ["rev-parse", "refs/heads/main"]),
  }, { authorityHome, actor: "authority-regression" });
  const verified = inspectOwnerProposalDecisions(fixture.remote, { authorityHome });
  assert.equal(verified.integrity, "verified");
  fs.writeFileSync(verified.authorityPath, "{corrupted-primary", "utf8");
  const recovered = inspectOwnerProposalDecisions(fixture.remote, { authorityHome });
  assert.equal(recovered.integrity, "recovered");
  assert.equal(recovered.writable, false);

  assert.throws(
    () => rejectSharedRepositoryProposal(fixture.remote, {
      proposal: created.proposal.branch,
      expectedHead: created.proposal.head,
      actor: "must-not-push",
    }),
    (error) => error?.code === "shared-proposal-decision-authority-unavailable",
  );
  const proposalSuffix = created.proposal.branch.slice("proposal/".length);
  const rejectionBranch = `rejected/${proposalSuffix}-${created.proposal.head.slice(0, 12)}`;
  assert.equal(git(fixture.seed, ["ls-remote", "--heads", "origin", rejectionBranch]), "");
});

test("terminal decisions fail closed when defaultBranch and rejectionPrefix drift after review", { timeout: 30_000 }, (t) => {
  const fixture = makeFixture(t);
  withSharedHome(t, fixture);
  const created = proposeSharedDocumentationFile(fixture.remote, {
    projectId: "demo",
    path: "terminal-config-drift.md",
    title: "Terminal config drift",
    description: "Require a fresh review when terminal branch policy changes.",
  });
  const review = materializeSharedRepositoryReview(fixture.remote, {
    proposal: created.proposal.branch,
    expectedHead: created.proposal.head,
  });
  writeDocReviewDecision(review.reviewRoot, created.repositoryPath, {
    status: "verified",
    note: "Reviewed before terminal configuration changed",
  });

  const configPath = path.join(fixture.seed, ".context-room", "shared-repository.json");
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  config.defaultBranch = "trunk";
  config.rejectionPrefix = "archive/";
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  git(fixture.seed, ["add", ".context-room/shared-repository.json"]);
  git(fixture.seed, ["commit", "-m", "Change terminal branch policy"]);
  const driftCommit = git(fixture.seed, ["rev-parse", "HEAD"]);
  git(fixture.seed, ["push", "origin", "main", "HEAD:trunk"]);

  let acceptanceError = null;
  try {
    acceptSharedReview(review.reviewRoot, { message: "Must not accept through config drift" });
  } catch (error) {
    acceptanceError = error;
  }

  assert.equal(acceptanceError?.code, "shared-review-terminal-config-stale", acceptanceError?.message);
  assert.deepEqual(acceptanceError?.details?.changedFields, ["defaultBranch", "rejectionPrefix"]);
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/main"]), driftCommit);
  assert.equal(git(fixture.remote, ["rev-parse", "refs/heads/trunk"]), driftCommit);
});
