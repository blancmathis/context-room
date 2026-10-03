import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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
  for (const [key, leaf] of Object.entries({ CONTEXT_ROOM_HUB_HOME: "hub", CONTEXT_ROOM_SHARED_HOME: "shared", CONTEXT_ROOM_REVIEW_AUTHORITY_HOME: "authority", HOME: "home" })) {
    const previous = process.env[key];
    process.env[key] = path.join(base, leaf);
    t.after(() => previous === undefined ? delete process.env[key] : process.env[key] = previous);
  }
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
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
