import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  readContextHubRegistry,
  recoverContextHubSharedTransactions,
  registerContextHubProject,
  withContextHubProjectSharedDisconnection,
  withContextHubProjectSharedRegistration,
} from "../src/context_hub.mjs";
import { initializeContextRoomProject } from "../src/context_room.mjs";
import {
  connectSharedContext,
  disconnectSharedContext,
  initializeSharedRepository,
  listRegisteredSharedBindings,
  readSharedConnectionReceipt,
  readSharedProjectConnection,
} from "../src/shared_context.mjs";

function git(cwd, args) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "hub-capability@example.test"]);
  git(root, ["config", "user.name", "Context Hub Capability Test"]);
}

function makeProject(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), `# ${name}\n`, "utf8");
  git(root, ["init", "--initial-branch=main"]);
  configureGit(root);
  initializeContextRoomProject(root, {
    title: name,
    allowedPaths: ["docs/"],
    watchAllow: ["docs/"],
  });
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Initial"]);
  return root;
}

function makeSharedFixture(base) {
  const remote = path.join(base, "shared.git");
  const seed = path.join(base, "shared-seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Hub capability fixture" });
  fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n", "utf8");
  fs.mkdirSync(path.join(seed, "projects", "demo", "docs"), { recursive: true });
  fs.writeFileSync(path.join(seed, "projects", "demo", "docs", "README.md"), "# Demo\n", "utf8");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize shared fixture"]);
  git(seed, ["push", "origin", "main"]);
  return { remote };
}

function withIsolatedHomes(t, base) {
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  const previousSharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const previousHome = process.env.HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub-home");
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(base, "shared-home");
  process.env.HOME = path.join(base, "home");
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    if (previousSharedHome === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousSharedHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  });
}

function byteSnapshot(root) {
  const entries = [];
  const visit = (directory) => {
    for (const name of fs.readdirSync(directory).sort()) {
      const absolute = path.join(directory, name);
      const relative = path.relative(root, absolute);
      const stats = fs.lstatSync(absolute);
      if (stats.isDirectory()) {
        entries.push([relative, "directory"]);
        visit(absolute);
      } else if (stats.isSymbolicLink()) {
        entries.push([relative, "symlink", fs.readlinkSync(absolute)]);
      } else if (stats.isFile()) {
        entries.push([
          relative,
          "file",
          createHash("sha256").update(fs.readFileSync(absolute)).digest("hex"),
        ]);
      } else {
        entries.push([relative, "other"]);
      }
    }
  };
  visit(root);
  return entries;
}

function swapFiles(left, right, temporary) {
  fs.renameSync(left, temporary);
  fs.renameSync(right, left);
  fs.renameSync(temporary, right);
}

function gitCommonDirectory(root) {
  const value = git(root, ["rev-parse", "--git-common-dir"]);
  return path.resolve(root, value);
}

test("Hub connect capability rejects a same-path replacement without a binding or receipt", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hub-connect-capability-p1-"));
  withIsolatedHomes(t, base);
  const name = "Replaceable connect project";
  const root = makeProject(base, name);
  const archivedRoot = path.join(base, "original-connect-project");
  const movedReplacement = path.join(base, "replacement-connect-project");
  const shared = makeSharedFixture(base);
  const registered = registerContextHubProject(root);
  let replacementBefore = null;
  let failure = null;
  let receiptId = "";

  try {
    withContextHubProjectSharedRegistration(root, {
      shared: { repository: shared.remote, projectId: "demo" },
      requireSyncedShared: true,
    }, (pending) => {
      receiptId = pending.sharedTransactionId;
      fs.renameSync(root, archivedRoot);
      const replacement = makeProject(base, name);
      replacementBefore = byteSnapshot(replacement);
      return connectSharedContext(replacement, {
        repository: shared.remote,
        projectId: "demo",
        sync: true,
        connectionReceiptId: pending.sharedTransactionId,
        projectRoots: pending.sharedProjectRoots,
        projectCapabilities: pending.sharedProjectCapabilities,
      });
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "shared-project-capability-changed");
  assert.deepEqual(byteSnapshot(root), replacementBefore, "the replacement checkout bytes must remain untouched");
  assert.deepEqual(listRegisteredSharedBindings(shared.remote), []);
  assert.equal(readSharedProjectConnection(root), null);
  assert.equal(readSharedConnectionReceipt(root, {
    repository: shared.remote,
    projectId: "demo",
    receiptId,
  }), null);
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id)?.shared, null);

  fs.renameSync(root, movedReplacement);
  fs.renameSync(archivedRoot, root);
  const [recovered] = recoverContextHubSharedTransactions();
  assert.equal(recovered?.committed, false);
  assert.deepEqual(listRegisteredSharedBindings(shared.remote), []);
  assert.equal(readSharedConnectionReceipt(root, {
    repository: shared.remote,
    projectId: "demo",
    receiptId,
  }), null);
});

test("Hub capability rejects swapped linked-worktree .git files with the same common directory", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hub-git-entry-capability-p1-"));
  withIsolatedHomes(t, base);
  const mainRoot = makeProject(base, "Linked worktree project");
  const firstRoot = path.join(base, "linked-first");
  const secondRoot = path.join(base, "linked-second");
  git(mainRoot, ["worktree", "add", "-b", "test/capability-first", firstRoot]);
  git(mainRoot, ["worktree", "add", "-b", "test/capability-second", secondRoot]);
  registerContextHubProject(mainRoot);
  registerContextHubProject(firstRoot);
  registerContextHubProject(secondRoot);
  const shared = makeSharedFixture(base);
  const firstGitEntry = path.join(firstRoot, ".git");
  const secondGitEntry = path.join(secondRoot, ".git");
  const temporaryGitEntry = path.join(base, ".git-swap-temporary");
  const firstRootIdentity = fs.lstatSync(firstRoot, { bigint: true });
  const secondRootIdentity = fs.lstatSync(secondRoot, { bigint: true });
  const originalCommonDirectory = gitCommonDirectory(firstRoot);
  let swapped = false;
  let failure = null;

  try {
    withContextHubProjectSharedRegistration(mainRoot, {
      shared: { repository: shared.remote, projectId: "demo" },
    }, (pending) => {
      swapFiles(firstGitEntry, secondGitEntry, temporaryGitEntry);
      swapped = true;
      return connectSharedContext(mainRoot, {
        repository: shared.remote,
        projectId: "demo",
        sync: false,
        connectionReceiptId: pending.sharedTransactionId,
        projectRoots: pending.sharedProjectRoots,
        projectCapabilities: pending.sharedProjectCapabilities,
      });
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "shared-project-capability-changed");
  assert.equal(fs.lstatSync(firstRoot, { bigint: true }).dev, firstRootIdentity.dev);
  assert.equal(fs.lstatSync(firstRoot, { bigint: true }).ino, firstRootIdentity.ino);
  assert.equal(fs.lstatSync(secondRoot, { bigint: true }).dev, secondRootIdentity.dev);
  assert.equal(fs.lstatSync(secondRoot, { bigint: true }).ino, secondRootIdentity.ino);
  assert.equal(gitCommonDirectory(firstRoot), originalCommonDirectory);
  assert.equal(gitCommonDirectory(secondRoot), originalCommonDirectory);
  assert.deepEqual(listRegisteredSharedBindings(shared.remote), []);

  if (swapped) swapFiles(firstGitEntry, secondGitEntry, temporaryGitEntry);
  const [recovered] = recoverContextHubSharedTransactions();
  assert.equal(recovered?.committed, false);
  assert.deepEqual(listRegisteredSharedBindings(shared.remote), []);
});

test("Hub disconnect capability leaves a same-path replacement byte-for-byte unchanged", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "hub-disconnect-capability-p1-"));
  withIsolatedHomes(t, base);
  const name = "Replaceable disconnect project";
  const root = makeProject(base, name);
  const archivedRoot = path.join(base, "original-disconnect-project");
  const movedReplacement = path.join(base, "replacement-disconnect-project");
  const shared = makeSharedFixture(base);
  const registered = registerContextHubProject(root);

  withContextHubProjectSharedRegistration(root, {
    shared: { repository: shared.remote, projectId: "demo" },
  }, (pending) => connectSharedContext(root, {
    repository: shared.remote,
    projectId: "demo",
    sync: false,
    projectRoots: pending.sharedProjectRoots,
    projectCapabilities: pending.sharedProjectCapabilities,
  }));
  assert.equal(readSharedProjectConnection(root)?.projectId, "demo");

  let replacementBefore = null;
  let failure = null;
  try {
    withContextHubProjectSharedDisconnection(root, (pending) => {
      fs.renameSync(root, archivedRoot);
      const replacement = makeProject(base, name);
      replacementBefore = byteSnapshot(replacement);
      return disconnectSharedContext(replacement, {
        projectRoots: pending.sharedProjectRoots,
        projectCapabilities: pending.sharedProjectCapabilities,
      });
    });
  } catch (error) {
    failure = error;
  }

  assert.equal(failure?.code, "shared-project-capability-changed");
  assert.deepEqual(byteSnapshot(root), replacementBefore, "disconnect must not modify replacement checkout bytes");
  assert.equal(readSharedProjectConnection(root), null, "the old binding must not attest the replacement root");
  assert.equal(listRegisteredSharedBindings(shared.remote).length, 1, "the original binding must remain registered");

  fs.renameSync(root, movedReplacement);
  fs.renameSync(archivedRoot, root);
  const [recovered] = recoverContextHubSharedTransactions();
  assert.equal(recovered?.committed, false);
  assert.equal(readSharedProjectConnection(root)?.projectId, "demo");
  assert.equal(readContextHubRegistry().projects.find((entry) => entry.id === registered.id)?.shared?.projectId, "demo");
});
