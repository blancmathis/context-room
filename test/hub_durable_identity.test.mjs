import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { registerContextHubProject, readContextHubRegistry, listContextHubProjects } from "../src/context_hub.mjs";
import { readFilesystemIdentity } from "../src/filesystem_identity.mjs";
import { rootIdentityAliases } from "../src/location_attestation.mjs";
import { initializeContextRoomProject } from "../src/context_room.mjs";

function fixture(t, { git = true } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "hub-durable-")));
  for (const [key, leaf] of Object.entries({ CONTEXT_ROOM_HUB_HOME: "hub", CONTEXT_ROOM_SHARED_HOME: "shared", CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: "authority", HOME: "" })) {
    const previous = process.env[key];
    process.env[key] = path.join(base, leaf);
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
  }
  t.after(() => {
    // Shared snapshots are deliberately read-only; restore owner permissions
    // only inside this disposable fixture before removing it.
    for (const name of fs.readdirSync(base, { recursive: true })) {
      const file = path.join(base, name), stats = fs.lstatSync(file);
      if (!stats.isSymbolicLink()) fs.chmodSync(file, stats.isDirectory() ? 0o700 : 0o600);
    }
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = path.join(base, "project");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/a.md"), "# A\n");
  if (git) execFileSync("git", ["init", "--initial-branch=main", root], { stdio: "ignore" });
  initializeContextRoomProject(root, { title: "Durable", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  return { base, root, registryPath: path.join(base, "hub/registry.json") };
}

function alterStats(t, changes, root) {
  for (const name of ["lstatSync", "statSync", "fstatSync"]) {
    const original = fs[name];
    fs[name] = (...args) => {
      const stats = original(...args);
      if (!stats) return stats;
      if (changes.dev) stats.dev += typeof stats.dev === "bigint" ? BigInt(changes.dev) : Number(changes.dev);
      if (args[0] === root && changes.birth && typeof stats.birthtimeNs === "bigint") stats.birthtimeNs += BigInt(changes.birth);
      return stats;
    };
    t.after(() => fs[name] = original);
  }
}

function notebookBytes(root) {
  const directory = path.join(root, ".context-room/notebooks");
  return fs.readdirSync(directory, { recursive: true }).sort()
    .filter(name => fs.lstatSync(path.join(directory, name)).isFile())
    .map(name => [name, fs.readFileSync(path.join(directory, name))]);
}

test("Hub enrollment records root and every Git durable identity, preserving rollback fields", (t) => {
  const { root } = fixture(t);
  const first = registerContextHubProject(root);
  assert.deepEqual(first.rootDurableIdentity, readFilesystemIdentity(root).identity);
  const membership = first.worktreeIdentity;
  for (const key of ["commonDir", "gitDir", "gitEntry"]) {
    assert.deepEqual(membership[`${key}DurableIdentity`], readFilesystemIdentity(key === "gitEntry" ? path.join(root, ".git") : membership[key]).identity);
    assert.match(membership[`${key}Identity`].dev, /^\d+$/);
  }
  assert.deepEqual(readContextHubRegistry().projects[0], first);
  assert.deepEqual(rootIdentityAliases(root), [`${first.rootIdentity.dev}:${first.rootIdentity.ino}`]);
  const again = registerContextHubProject(root);
  assert.deepEqual(again.rootDurableIdentity, first.rootDurableIdentity);
  assert.equal(again.registeredAt, first.registeredAt);
});

test("legacy uncertain enrollment does not write a registry or an attestation", (t) => {
  const { root, base, registryPath } = fixture(t, { git: false });
  registerContextHubProject(root);
  const raw = JSON.parse(fs.readFileSync(registryPath));
  delete raw.projects[0].rootDurableIdentity;
  fs.writeFileSync(registryPath, JSON.stringify(raw));
  fs.rmSync(path.join(base, "authority"), { recursive: true, force: true });
  const before = fs.readFileSync(registryPath);
  alterStats(t, { dev: 77 }, root);
  assert.equal(registerContextHubProject(root).identityUnconfirmed, true);
  assert.deepEqual(fs.readFileSync(registryPath), before);
  assert.equal(fs.existsSync(path.join(base, "authority")), false);
});

test("legacy registry reads never enroll the directory currently at its path", (t) => {
  const { root, base, registryPath } = fixture(t);
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify({ version: 2, projects: [{ root, title: "Old" }], sharedRepositories: [] }));
  fs.writeFileSync(registryPath, bytes);
  fs.rmSync(path.join(base, "authority"), { recursive: true, force: true });
  assert.equal(readContextHubRegistry().projects[0].rootDurableIdentity, null);
  assert.deepEqual(fs.readFileSync(registryPath), bytes);
  assert.equal(fs.existsSync(path.join(base, "authority")), false);
});

test("matching durable enrollment remains available and observes a changed device", (t) => {
  const { root } = fixture(t);
  const original = registerContextHubProject(root, { shared: { repository: path.join(root, "remote.git"), projectId: "demo" } });
  alterStats(t, { dev: 77 }, root);
  const [entry] = listContextHubProjects();
  assert.equal(entry.available, true);
  assert.deepEqual(entry.shared, original.shared);
  assert.equal(entry.rootIdentity.dev, String(BigInt(original.rootIdentity.dev) + 77n));
  assert.deepEqual(entry.rootDurableIdentity, original.rootDurableIdentity);
  assert.ok(rootIdentityAliases(root).includes(`${original.rootIdentity.dev}:${original.rootIdentity.ino}`));
  assert.deepEqual(readContextHubRegistry().projects[0], (({ available, unavailableReason, ...stored }) => stored)(entry));
});

test("legacy availability is identity to confirm without writing or observing", (t) => {
  const { root, base, registryPath } = fixture(t);
  registerContextHubProject(root);
  const raw = JSON.parse(fs.readFileSync(registryPath));
  delete raw.projects[0].rootDurableIdentity;
  fs.writeFileSync(registryPath, JSON.stringify(raw) + "\n\n");
  fs.rmSync(path.join(root, ".git"), { recursive: true });
  const before = fs.readFileSync(registryPath);
  const authority = fs.readdirSync(path.join(base, "authority")).map(name => [name, fs.readFileSync(path.join(base, "authority", name))]);
  const [entry] = listContextHubProjects({ refreshGit: true });
  assert.equal(entry.available, false);
  assert.equal(entry.unavailableReason, "identity to confirm");
  assert.deepEqual(fs.readFileSync(registryPath), before);
  assert.deepEqual(fs.readdirSync(path.join(base, "authority")).map(name => [name, fs.readFileSync(path.join(base, "authority", name))]), authority);
});

test("incomplete durable Git evidence stays unconfirmed without a registry write", (t) => {
  const { root, registryPath } = fixture(t);
  registerContextHubProject(root);
  const raw = JSON.parse(fs.readFileSync(registryPath));
  delete raw.projects[0].worktreeIdentity.gitEntryDurableIdentity;
  fs.writeFileSync(registryPath, JSON.stringify(raw));
  const before = fs.readFileSync(registryPath);
  const [entry] = listContextHubProjects();
  assert.equal(entry.available, false);
  assert.equal(entry.unavailableReason, "identity to confirm");
  assert.deepEqual(fs.readFileSync(registryPath), before);
});

test("matching legacy inode cannot override a different durable birthtime", (t) => {
  const { root, registryPath } = fixture(t);
  registerContextHubProject(root);
  const before = fs.readFileSync(registryPath);
  alterStats(t, { birth: 1 }, root);
  const [entry] = listContextHubProjects();
  assert.equal(entry.available, false);
  assert.equal(entry.unavailableReason, "folder identity changed");
  assert.deepEqual(fs.readFileSync(registryPath), before);
});

test("two processes keep Hub, Shared, receipts and notebook bytes after every device changes", (t) => {
  const { root, base } = fixture(t);
  fs.rmSync(root, { recursive: true, force: true });
  const run = (action, changes = {}, status = 0) => {
    const result = spawnSync(process.execPath, ["test/fixtures/hub_durable_identity.mjs", action, base, JSON.stringify(changes)], { encoding: "utf8", timeout: 180_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, status, result.stdout + result.stderr);
  };
  run("create");
  const bytes = notebookBytes(root);
  for (const changes of [{ dev: 77, ino: 1 }, { dev: 77, birth: 1 }, { dev: 77, git: true, ino: 1 }, { dev: 77, git: true, birth: 1 }]) run("blocked", changes);
  run("read", { dev: 77 });
  assert.deepEqual(notebookBytes(root), bytes);
});

test("disconnect and Hub journals recover across a device change without orphan cleanup", (t) => {
  const { root, base } = fixture(t);
  fs.rmSync(root, { recursive: true, force: true });
  const run = (action, changes = {}, status = 0) => {
    const result = spawnSync(process.execPath, ["test/fixtures/hub_durable_identity.mjs", action, base, JSON.stringify(changes)], { encoding: "utf8", timeout: 180_000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, status, result.stdout + result.stderr);
  };
  run("create");
  const bytes = notebookBytes(root);
  run("crash-disconnect", {}, 23);
  run("read", { dev: 77 });
  assert.deepEqual(notebookBytes(root), bytes);
});

test("nested projects and linked worktrees resolve relative Git paths at their actual cwd", (t) => {
  const { root, base } = fixture(t);
  const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(root, ["add", "."]);
  git(root, ["-c", "user.email=durable@example.test", "-c", "user.name=Durable", "commit", "-m", "Initial"]);
  const nested = path.join(root, "docs/subproject");
  fs.mkdirSync(nested);
  initializeContextRoomProject(nested, { title: "Nested", allowedPaths: [], watchAllow: [] });
  const main = registerContextHubProject(nested);
  assert.equal(main.worktreeIdentity.commonDir, path.join(root, ".git"));
  assert.equal(main.worktreeIdentity.gitDir, path.join(root, ".git"));
  assert.equal(main.worktreeIdentity.relativeRoot, "docs/subproject");

  const linked = path.join(base, "linked"), other = path.join(base, "other");
  git(root, ["worktree", "add", "-b", "linked", linked]);
  git(root, ["worktree", "add", "-b", "other", other]);
  const gitDir = path.resolve(linked, git(linked, ["rev-parse", "--git-dir"]));
  const pointer = path.join(linked, ".git");
  fs.writeFileSync(pointer, `gitdir: ${path.relative(linked, gitDir)}\n`);
  const linkedNested = path.join(linked, "docs/subproject");
  fs.mkdirSync(linkedNested);
  initializeContextRoomProject(linkedNested, { title: "Linked nested", allowedPaths: [], watchAllow: [] });
  const entry = registerContextHubProject(linkedNested);
  assert.equal(entry.worktreeIdentity.commonDir, main.worktreeIdentity.commonDir);
  assert.equal(entry.worktreeIdentity.gitDir, gitDir);
  assert.equal(entry.worktreeIdentity.gitEntryIdentity.kind, "file");
  assert.deepEqual(entry.worktreeIdentity.gitEntryDurableIdentity, readFilesystemIdentity(pointer).identity);
  assert.equal(listContextHubProjects().find(item => item.id === entry.id).available, true);

  const otherGitDir = path.resolve(other, git(other, ["rev-parse", "--git-dir"]));
  fs.writeFileSync(pointer, `gitdir: ${path.relative(linked, otherGitDir)}\n`);
  const changed = listContextHubProjects().find(item => item.id === entry.id);
  assert.equal(changed.available, false, "another worktree cannot inherit the saved Git capability");
  assert.equal(changed.unavailableReason, "folder identity changed");
});
