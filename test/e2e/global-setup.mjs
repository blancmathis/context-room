import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function write(root, relativePath, content) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

function configureGit(root) {
  git(root, ["config", "user.email", "ux-soak@example.test"]);
  git(root, ["config", "user.name", "Context Room UX Soak"]);
}

function makeFixtureTreeRemovable(root) {
  let stats;
  try { stats = fs.lstatSync(root); } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (stats.isSymbolicLink()) return;
  if (!stats.isDirectory()) {
    try { fs.chmodSync(root, 0o600); } catch {}
    return;
  }
  try { fs.chmodSync(root, 0o700); } catch {}
  let entries = [];
  try { entries = fs.readdirSync(root); } catch {}
  for (const entry of entries) makeFixtureTreeRemovable(path.join(root, entry));
  try { fs.chmodSync(root, 0o700); } catch {}
}

export default async function globalSetup() {
  const originalHome = process.env.HOME || os.homedir();
  process.env.PLAYWRIGHT_BROWSERS_PATH ||= process.platform === "darwin"
    ? path.join(originalHome, "Library", "Caches", "ms-playwright")
    : path.join(originalHome, ".cache", "ms-playwright");
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-ux-soak-"));
  const home = path.join(base, "home");
  const hubHome = path.join(home, ".context-room", "hub");
  const sharedHome = path.join(home, ".context-room", "shared");
  fs.mkdirSync(home, { recursive: true });
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;

  const [{
    createMemoryServer,
    initializeContextRoomProject,
  }, {
    contextHubHostRoot,
    registerContextHubProject,
    registerContextHubSharedRepository,
  }, {
    connectSharedContext,
    createSharedProposal,
    initializeSharedRepository,
    publishSharedProposal,
  }] = await Promise.all([
    import("../../src/context_room.mjs"),
    import("../../src/context_hub.mjs"),
    import("../../src/shared_context.mjs"),
  ]);

  const atlas = path.join(base, "Atlas");
  fs.mkdirSync(atlas, { recursive: true });
  git(atlas, ["init", "--initial-branch=main"]);
  configureGit(atlas);
  write(atlas, "docs/README.md", "# Atlas\n\nSee [Operations](operations.md).\n");
  write(atlas, "docs/operations.md", "# Operations\n\nAccepted operating procedure.\n");
  write(atlas, "docs/diagram.mmd", "graph TD\n  A[Atlas] --> B[Review]\n");
  write(atlas, "AGENTS.md", "# Atlas agent instructions\n");
  initializeContextRoomProject(atlas, {
    title: "Atlas",
    allowedPaths: ["docs/", "AGENTS.md"],
    watchAllow: ["docs/", "AGENTS.md"],
  });
  git(atlas, ["add", "."]);
  git(atlas, ["commit", "-m", "Initialize Atlas"]);
  fs.appendFileSync(path.join(atlas, "docs", "operations.md"), "\nPending local clarification.\n", "utf8");

  const atlasWorktree = path.join(base, "Atlas-agent");
  git(atlas, ["worktree", "add", "-b", "agent/atlas-docs", atlasWorktree]);
  fs.appendFileSync(path.join(atlasWorktree, "docs", "README.md"), "\nAgent worktree note.\n", "utf8");

  const beacon = path.join(base, "Beacon");
  fs.mkdirSync(beacon, { recursive: true });
  git(beacon, ["init", "--initial-branch=main"]);
  configureGit(beacon);
  write(beacon, "docs/README.md", "# Beacon\n\nBeacon documentation.\n");
  write(beacon, "docs/runbook.md", "# Runbook\n\nCurrent runbook.\n");
  write(beacon, "notes/scratch.md", "# Scratch\n\nWorkspace-safe editing surface.\n");
  initializeContextRoomProject(beacon, {
    title: "Beacon",
    allowedPaths: ["docs/", "notes/"],
    watchAllow: ["docs/"],
  });
  git(beacon, ["add", "."]);
  git(beacon, ["commit", "-m", "Initialize Beacon"]);
  fs.appendFileSync(path.join(beacon, "docs", "runbook.md"), "\nPending Beacon change.\n", "utf8");

  const remote = path.join(base, "shared.git");
  const seed = path.join(base, "shared-seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed);
  initializeSharedRepository(seed, { name: "UX Soak Shared Context" });
  write(seed, "projects.json", JSON.stringify({ version: 1, projects: [{ id: "atlas", title: "Atlas" }] }, null, 2) + "\n");
  write(seed, "projects/atlas/docs/README.md", "# Shared Atlas\n\nAccepted shared documentation.\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared documentation"]);
  git(seed, ["push", "origin", "main"]);
  connectSharedContext(atlas, { repository: remote, projectId: "atlas" });
  const proposal = createSharedProposal(atlas, {
    title: "Clarify Atlas review",
    description: "Clarify the accepted Atlas review workflow and the exact human verification boundary.",
    branch: "proposal/atlas/ux-soak-review",
  });
  configureGit(proposal.root);
  write(proposal.root, "projects/atlas/docs/README.md", "# Shared Atlas\n\nAccepted shared documentation with a proposed review clarification.\n");
  const published = publishSharedProposal(atlas, { proposal: proposal.branch });

  registerContextHubSharedRepository(remote);
  const atlasEntry = registerContextHubProject(atlas, { title: "Atlas", shared: { repository: remote, projectId: "atlas" } });
  const atlasWorktreeEntry = registerContextHubProject(atlasWorktree, { title: "Atlas", shared: { repository: remote, projectId: "atlas" } });
  const beaconEntry = registerContextHubProject(beacon, { title: "Beacon" });

  const hostRoot = contextHubHostRoot();
  fs.mkdirSync(hostRoot, { recursive: true });
  initializeContextRoomProject(hostRoot, { title: "Context Room", allowedPaths: [], watchAllow: [] });
  const { server, waitForShutdown } = createMemoryServer({ root: hostRoot, registerInHub: false, persistentDocumentGraphLayout: true });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const fixturePath = path.join(base, "fixture.json");
  fs.writeFileSync(fixturePath, JSON.stringify({
    base,
    home,
    origin,
    projects: {
      atlas: { id: atlasEntry.id, root: atlas, worktreeId: atlasWorktreeEntry.id, worktreeRoot: atlasWorktree },
      beacon: { id: beaconEntry.id, root: beacon },
    },
    shared: { remote, seed, proposal: proposal.branch, proposalHead: published.head },
  }, null, 2));
  process.env.CONTEXT_ROOM_E2E_FIXTURE = fixturePath;

  return async () => {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections?.();
    });
    await waitForShutdown();
    try { execFileSync("chmod", ["-R", "u+w", base], { stdio: "ignore" }); } catch {}
    makeFixtureTreeRemovable(base);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  };
}
