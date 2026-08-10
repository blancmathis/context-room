import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  abandonInvalidContextHubSharedTransaction,
  contextHubRepositoryIdentity,
  listContextHubSharedRecoveryIssues,
  registerContextHubProject,
} from "../src/context_hub.mjs";
import { initializeContextRoomProject } from "../src/context_room.mjs";
import {
  connectSharedContext,
  initializeSharedRepository,
  listRegisteredSharedBindings,
  recoverSharedContextTransactions,
  removeOrphanedSharedContextBindings,
  sharedContextStatus,
} from "../src/shared_context.mjs";

function git(cwd, args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "shared-recovery@example.test"]);
  git(root, ["config", "user.name", "Shared Recovery Test"]);
}

function writeFile(root, relativePath, content) {
  const destination = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content, "utf8");
}

function makeSharedFixture(base, { skills = false } = {}) {
  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Shared recovery fixture" });
  writeFile(seed, "projects.json", JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  writeFile(seed, "projects/demo/docs/README.md", "# Demo\n");
  if (skills) {
    writeFile(seed, "projects/demo/skills/demo-workflow/SKILL.md", "---\nname: demo-workflow\ndescription: Project workflow.\n---\n\n# Demo\n");
    writeFile(seed, "skills/global/global-workflow/SKILL.md", "---\nname: global-workflow\ndescription: Global workflow.\n---\n\n# Global\n");
  }
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize fixture"]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed };
}

function makeProject(base, name = "project") {
  const root = path.join(base, name);
  fs.mkdirSync(root, { recursive: true });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["README.md"], watchAllow: [] });
  return root;
}

function isolateHomes(t, base) {
  const previous = Object.fromEntries(["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME"].map((name) => [name, process.env[name]]));
  process.env.HOME = path.join(base, "home");
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub-home");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(process.env.HOME, ".context-room", "shared");
  fs.mkdirSync(process.env.HOME, { recursive: true });
  t.after(() => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function legacyCache(sharedHome, repository, key, marker) {
  const cacheRoot = path.join(sharedHome, createHash("sha256").update(key).digest("hex").slice(0, 16));
  fs.mkdirSync(cacheRoot, { recursive: true });
  git(cacheRoot, ["clone", repository, "repository"]);
  writeFile(cacheRoot, "proposals.json", JSON.stringify({ version: 1, proposals: {} }, null, 2) + "\n");
  writeFile(cacheRoot, "proposals/preserved/marker.txt", marker);
  return cacheRoot;
}

test("a unique unclaimed v0.6.1 cache is adopted by checkout identity without moving its proposals", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "shared-legacy-adoption-p1-"));
  isolateHomes(t, base);
  const fixture = makeSharedFixture(base);
  const project = makeProject(base);
  const legacyRoot = legacyCache(process.env.CONTEXT_ROOM_SHARED_HOME, fixture.remote, "lost-alias-A", "preserve me\n");

  connectSharedContext(project, { repository: fixture.remote, projectId: "demo", sync: false });
  const status = sharedContextStatus(project);
  assert.equal(status.cacheRoot, legacyRoot);
  assert.equal(fs.readFileSync(path.join(legacyRoot, "proposals/preserved/marker.txt"), "utf8"), "preserve me\n");
  const claim = JSON.parse(fs.readFileSync(path.join(legacyRoot, "repository-identity.json"), "utf8"));
  assert.equal(claim.identity, contextHubRepositoryIdentity(fixture.remote));
});

test("security-only legacy metadata does not hide a valid Shared repository cache", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "shared-security-only-cache-p1-"));
  isolateHomes(t, base);
  const fixture = makeSharedFixture(base);
  const project = makeProject(base);

  const connected = connectSharedContext(project, { repository: fixture.remote, projectId: "demo" });
  const validCacheRoot = connected.cacheRoot;
  const legacyTransport = pathToFileURL(fixture.remote).href;
  const metadataRoot = path.join(
    process.env.CONTEXT_ROOM_SHARED_HOME,
    createHash("sha256").update(legacyTransport).digest("hex").slice(0, 16),
  );
  const securityBytes = Buffer.from('{"verified":true,"checkedAt":"2026-08-10T00:00:00.000Z"}\n');
  fs.mkdirSync(metadataRoot, { recursive: true });
  fs.writeFileSync(path.join(metadataRoot, "github-security.json"), securityBytes);

  const status = sharedContextStatus(project);
  assert.equal(status.cacheRoot, validCacheRoot);
  assert.deepEqual(fs.readFileSync(path.join(metadataRoot, "github-security.json")), securityBytes);
  assert.equal(fs.existsSync(path.join(metadataRoot, "repository-identity.json")), false);
});

test("two unclaimed legacy caches for one repository fail closed without claiming either", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "shared-legacy-ambiguous-p1-"));
  isolateHomes(t, base);
  const fixture = makeSharedFixture(base);
  const project = makeProject(base);
  const first = legacyCache(process.env.CONTEXT_ROOM_SHARED_HOME, fixture.remote, "lost-alias-A", "first\n");
  const second = legacyCache(process.env.CONTEXT_ROOM_SHARED_HOME, fixture.remote, "lost-alias-B", "second\n");

  assert.throws(
    () => connectSharedContext(project, { repository: fixture.remote, projectId: "demo", sync: false }),
    (error) => error?.code === "shared-repository-identity-mismatch" && /Multiple Shared repository caches/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(first, "repository-identity.json")), false);
  assert.equal(fs.existsSync(path.join(second, "repository-identity.json")), false);
});

test("orphan abandonment detaches global links, registries, and owners without touching a replacement root", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "shared-orphan-cleanup-p1-"));
  isolateHomes(t, base);
  const fixture = makeSharedFixture(base, { skills: true });
  const root = makeProject(base);
  const connected = connectSharedContext(root, { repository: fixture.remote, projectId: "demo" });
  const canonicalRoot = fs.realpathSync(root);
  const originalIdentity = fs.lstatSync(root, { bigint: true });
  const lostRoot = path.join(base, "lost-project");
  const globalLink = path.join(process.env.HOME, ".agents", "skills", "global-workflow");
  const projectLink = path.join(root, ".agents", "skills", "demo-workflow");
  assert.equal(fs.lstatSync(globalLink).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(projectLink).isSymbolicLink(), true);

  fs.renameSync(root, lostRoot);
  fs.mkdirSync(path.dirname(projectLink), { recursive: true });
  fs.writeFileSync(projectLink, "replacement-owned bytes\n", "utf8");
  const replacementConfig = path.join(root, ".context-room", "config.json");
  fs.mkdirSync(path.dirname(replacementConfig), { recursive: true });
  fs.writeFileSync(replacementConfig, "{\"replacement\":true}\n", "utf8");
  const replacementBefore = fs.readFileSync(projectLink);

  const removed = removeOrphanedSharedContextBindings({
    repository: fixture.remote,
    projectId: "demo",
    projectRoots: [{
      root: canonicalRoot,
      rootIdentity: { dev: originalIdentity.dev.toString(), ino: originalIdentity.ino.toString() },
    }],
  });

  assert.equal(removed.removed, true);
  assert.equal(fs.existsSync(globalLink), false);
  assert.deepEqual(fs.readFileSync(projectLink), replacementBefore);
  assert.equal(fs.readFileSync(replacementConfig, "utf8"), "{\"replacement\":true}\n");
  assert.deepEqual(listRegisteredSharedBindings(fixture.remote), []);
  const skillRegistry = fs.readdirSync(path.join(connected.cacheRoot, "skill-links"))
    .map((name) => path.join(connected.cacheRoot, "skill-links", name))
    .find((candidate) => candidate.endsWith(".json"));
  assert.deepEqual(JSON.parse(fs.readFileSync(skillRegistry, "utf8")).links, []);
  const owners = JSON.parse(fs.readFileSync(path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "managed-destinations.json"), "utf8"));
  assert.deepEqual(owners.destinations || {}, {});
  const transactionRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "transactions", "disconnect");
  assert.equal(fs.existsSync(transactionRoot) && fs.readdirSync(transactionRoot).some((name) => name.endsWith(".json")), false);
});

test("an invalid Shared disconnect journal is durable quarantine surfaced and acknowledged through Context Hub", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "shared-disconnect-quarantine-p1-"));
  isolateHomes(t, base);
  const project = makeProject(base);
  const transactionRoot = path.join(process.env.CONTEXT_ROOM_SHARED_HOME, "transactions", "disconnect");
  fs.mkdirSync(transactionRoot, { recursive: true });
  fs.writeFileSync(path.join(transactionRoot, "truncated.json"), "{\"version\":1,", { mode: 0o600 });

  const [issue] = listContextHubSharedRecoveryIssues();
  assert.equal(issue?.scope, "global");
  assert.equal(issue?.kind, "invalid-journal");
  assert.equal(issue?.recoverySystem, "shared-disconnect");
  assert.equal(fs.readdirSync(transactionRoot).some((name) => name.endsWith(".json")), false);
  assert.throws(
    () => recoverSharedContextTransactions(),
    (error) => error?.code === "shared-disconnect-recovery-required" && error?.details?.scope === "global",
  );
  assert.throws(
    () => registerContextHubProject(project),
    (error) => error?.code === "context_hub_shared_recovery_required",
  );

  const abandoned = abandonInvalidContextHubSharedTransaction({
    quarantineId: issue.quarantineId,
    expectedRevision: issue.revision,
  });
  assert.equal(abandoned.abandoned, true);
  assert.equal(abandoned.recoverySystem, "shared-disconnect");
  assert.deepEqual(listContextHubSharedRecoveryIssues(), []);
  assert.deepEqual(recoverSharedContextTransactions(), { recovered: [] });
  assert.equal(registerContextHubProject(project).root, fs.realpathSync(project));
  assert.equal(fs.existsSync(path.join(transactionRoot, "abandoned-invalid", issue.quarantineId)), true);
});
