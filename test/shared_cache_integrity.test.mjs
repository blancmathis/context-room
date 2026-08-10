import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";

import { contextHubRepositoryIdentity } from "../src/context_hub.mjs";
import {
  initializeSharedRepository,
  listSharedRepositoryProposals,
  readSharedMainRevision,
} from "../src/shared_context.mjs";

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  })).trim();
}

function configureGit(root) {
  git(root, ["config", "user.name", "Shared cache integrity test"]);
  git(root, ["config", "user.email", "shared-cache-integrity@local.invalid"]);
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function makeTreeWritable(root) {
  fs.chmodSync(root, 0o700);
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) makeTreeWritable(target);
    else if (entry.isFile()) fs.chmodSync(target, 0o600);
  }
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

function createRemote(base, name, title, document) {
  const remote = path.join(base, `${name}.git`);
  const seed = path.join(base, `${name}-seed`);
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed);
  initializeSharedRepository(seed, { name: title });
  writeFile(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", document);
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", `Initialize ${name}`]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed, revision: git(seed, ["rev-parse", "HEAD"]) };
}

function makeFixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-shared-cache-integrity-"));
  const legitimate = createRemote(base, "legitimate", "Legitimate Shared", "# Legitimate\n");
  const malicious = createRemote(base, "malicious", "Malicious Shared", "# Malicious\n");
  const home = path.join(base, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  fs.mkdirSync(sharedHome, { recursive: true });
  const previousHome = process.env.HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  process.env.HOME = home;
  process.env.CONTEXT_ROOM_SHARED_HOME = sharedHome;
  t.after(() => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    removeFixtureTree(base);
  });
  return { base, home, sharedHome, legitimate, malicious };
}

function canonicalCacheRoot(sharedHome, repository) {
  const identity = contextHubRepositoryIdentity(repository);
  const key = createHash("sha256").update(identity).digest("hex").slice(0, 16);
  return path.join(sharedHome, key);
}

function runCachedRead(repository, env) {
  const moduleUrl = new URL("../src/shared_context.mjs", import.meta.url).href;
  const source = `
    const [moduleUrl, repository] = process.argv.slice(1);
    const api = await import(moduleUrl);
    try {
      const result = api.listSharedRepositoryProposals(repository, { refresh: false });
      process.stdout.write(JSON.stringify({ ok: true, revision: result.status.revision }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ ok: false, code: error.code || "", message: error.message }));
    }
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", source, moduleUrl, repository], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) return reject(new Error(stderr || `cached read child exited ${code}`));
      try { resolve(JSON.parse(stdout)); }
      catch { reject(new Error(`invalid cached read output: ${stdout || stderr}`)); }
    });
  });
}

test("a preclaimed cache cannot bind a legitimate transport to a malicious checkout", (t) => {
  const fixture = makeFixture(t);
  const candidate = path.join(fixture.sharedHome, "aaaaaaaaaaaaaaaa");
  const checkout = path.join(candidate, "repository");
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, "repository-identity.json"), JSON.stringify({
    version: 1,
    repository: fixture.legitimate.remote,
    identity: contextHubRepositoryIdentity(fixture.legitimate.remote),
  }, null, 2) + "\n", { mode: 0o600 });
  git(candidate, ["clone", "--no-checkout", fixture.malicious.remote, checkout]);
  const claimBefore = fs.readFileSync(path.join(candidate, "repository-identity.json"));
  const originBefore = git(checkout, ["config", "--get-all", "remote.origin.url"]);

  assert.throws(
    () => readSharedMainRevision(fixture.legitimate.remote, { refresh: true }),
    (error) => error.code === "shared-repository-identity-mismatch" && /origin/.test(error.message),
  );

  assert.equal(git(checkout, ["config", "--get-all", "remote.origin.url"]), originBefore);
  assert.deepEqual(fs.readFileSync(path.join(candidate, "repository-identity.json")), claimBefore);
  assert.equal(fs.existsSync(path.join(candidate, "state.json")), false);
  assert.equal(fs.existsSync(path.join(candidate, "snapshots")), false);
  assert.equal(fixture.malicious.revision === fixture.legitimate.revision, false);
});

test("poisoned snapshots and cached config are quarantined and reconstructed from the exact Git tree", async (t) => {
  const fixture = makeFixture(t);
  const initial = listSharedRepositoryProposals(fixture.legitimate.remote, {
    allowOffline: false,
    refresh: true,
  });
  const cacheRoot = canonicalCacheRoot(fixture.sharedHome, fixture.legitimate.remote);
  const snapshot = path.join(cacheRoot, "snapshots", initial.status.revision);
  const document = path.join(snapshot, "projects/demo/docs/README.md");
  const catalogPath = path.join(snapshot, "projects.json");
  makeTreeWritable(snapshot);
  fs.writeFileSync(document, "# Injected snapshot\n", "utf8");
  fs.writeFileSync(catalogPath, JSON.stringify({ version: 1, projects: [{ id: "poison", title: "Poison" }] }) + "\n", "utf8");
  fs.writeFileSync(path.join(snapshot, "injected.txt"), "not in Git\n", "utf8");
  fs.chmodSync(snapshot, 0o555);

  const repaired = listSharedRepositoryProposals(fixture.legitimate.remote, { refresh: false });
  assert.equal(repaired.repositoryName, "Legitimate Shared");
  assert.deepEqual(repaired.projects.map((project) => project.id), ["demo"]);
  assert.equal(fs.readFileSync(document, "utf8"), "# Legitimate\n");
  assert.equal(fs.existsSync(path.join(snapshot, "injected.txt")), false);
  const quarantineRoot = path.join(cacheRoot, "quarantine");
  const firstQuarantine = fs.readdirSync(quarantineRoot).filter((name) => !name.endsWith(".json"));
  assert.equal(firstQuarantine.length, 1);
  assert.equal(fs.readFileSync(path.join(quarantineRoot, firstQuarantine[0], "projects/demo/docs/README.md"), "utf8"), "# Injected snapshot\n");

  const statePath = path.join(cacheRoot, "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  fs.writeFileSync(statePath, JSON.stringify({
    ...state,
    repositoryConfig: { ...state.repositoryConfig, name: "Poisoned state" },
    catalog: { version: 1, projects: [{ id: "poison", title: "Poison" }] },
  }, null, 2) + "\n", "utf8");
  const stateIgnored = listSharedRepositoryProposals(fixture.legitimate.remote, { refresh: false });
  assert.equal(stateIgnored.repositoryName, "Legitimate Shared");
  assert.deepEqual(stateIgnored.projects.map((project) => project.id), ["demo"]);

  makeTreeWritable(snapshot);
  fs.writeFileSync(document, "# Concurrent poison\n", "utf8");
  fs.chmodSync(snapshot, 0o555);
  const outcomes = await Promise.all([
    runCachedRead(fixture.legitimate.remote, { HOME: fixture.home, CONTEXT_ROOM_SHARED_HOME: fixture.sharedHome }),
    runCachedRead(fixture.legitimate.remote, { HOME: fixture.home, CONTEXT_ROOM_SHARED_HOME: fixture.sharedHome }),
  ]);
  assert.equal(outcomes.every((outcome) => outcome.ok && outcome.revision === initial.status.revision), true, JSON.stringify(outcomes));
  assert.equal(fs.readFileSync(document, "utf8"), "# Legitimate\n");
  const finalQuarantine = fs.readdirSync(quarantineRoot).filter((name) => !name.endsWith(".json"));
  assert.equal(finalQuarantine.length, 2, "only one concurrent reader should quarantine and rebuild the poisoned snapshot");
});
