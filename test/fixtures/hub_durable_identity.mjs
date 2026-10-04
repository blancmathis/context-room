import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { initializeContextRoomProject } from "../../src/context_room.mjs";
import { registerContextHubProject, listContextHubProjects, readContextHubRegistry, withContextHubProjectSharedRegistration, withContextHubProjectSharedDisconnection, confirmContextHubProjectLocation } from "../../src/context_hub.mjs";
import { acceptsRootIdentity } from "../../src/location_attestation.mjs";
import { initializeSharedRepository, connectSharedContext, disconnectSharedContext, listRegisteredSharedBindings, readSharedProjectConnection, readSharedConnectionReceipt, removeOrphanedSharedContextBindings } from "../../src/shared_context.mjs";
import { openNotebook, mutateNotebook, readNotebook } from "../../src/notebooks.mjs";

const [action, base, change = "{}"] = process.argv.slice(2);
const root = path.join(base, "project"), remote = path.join(base, "remote.git"), seed = path.join(base, "seed");
const altered = JSON.parse(change);
for (const name of ["lstatSync", "statSync", "fstatSync"]) {
  const original = fs[name];
  fs[name] = (...args) => {
    const stats = original(...args);
    if (!stats) return stats;
    if (altered.dev) stats.dev += typeof stats.dev === "bigint" ? BigInt(altered.dev) : Number(altered.dev);
    if (args[0] === (altered.git ? path.join(root, ".git") : root)) {
      if (altered.ino) stats.ino += typeof stats.ino === "bigint" ? BigInt(altered.ino) : Number(altered.ino);
      if (altered.birth && typeof stats.birthtimeNs === "bigint") stats.birthtimeNs += BigInt(altered.birth);
    }
    return stats;
  };
}
const git = (cwd, args) => execFileSync("git", args, { cwd, stdio: "ignore" });
const configure = cwd => {
  git(cwd, ["config", "user.email", "durable@example.test"]);
  git(cwd, ["config", "user.name", "Durable fixture"]);
};
const manifestPath = path.join(base, "manifest.json");
if (action === "create") {
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/a.md"), "# A\n");
  git(root, ["init", "--initial-branch=main"]); configure(root);
  initializeContextRoomProject(root, { title: "Durable", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  git(root, ["add", "."]); git(root, ["commit", "-m", "Initial"]);
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]); configure(seed);
  initializeSharedRepository(seed, { name: "Durable fixture" });
  fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }));
  fs.mkdirSync(path.join(seed, "projects/demo/docs"), { recursive: true });
  fs.writeFileSync(path.join(seed, "projects/demo/docs/a.md"), "# Shared\n");
  git(seed, ["add", "."]); git(seed, ["commit", "-m", "Shared"]); git(seed, ["push", "origin", "main"]);
  registerContextHubProject(root);
  let receiptId;
  withContextHubProjectSharedRegistration(root, { shared: { repository: remote, projectId: "demo" }, requireSyncedShared: true }, pending => {
    receiptId = pending.sharedTransactionId;
    return connectSharedContext(root, { repository: remote, projectId: "demo", sync: true,
      connectionReceiptId: receiptId, projectRoots: pending.sharedProjectRoots, projectCapabilities: pending.sharedProjectCapabilities });
  });
  const scene = openNotebook(root, { path: "docs/Scene.crnb", id: "durable-scene", canWrite: () => true });
  for (let i = 0; i < 3; i++) mutateNotebook(root, { protocolVersion: 1, resourceId: scene.resourceId, operationId: `event-${i}`,
    locationRevision: scene.locator.revision, edits: [{ kind: "put", id: `shape-${i}`, expectedRevision: 0, object: { type: "rect", x: i, y: i } }] },
  { actor: { kind: "human", id: "fixture" }, canWrite: () => true });
  fs.writeFileSync(manifestPath, JSON.stringify({ scene, receiptId, entry: readContextHubRegistry().projects[0], bindings: listRegisteredSharedBindings(remote) }));
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  if (action === "crash-disconnect") {
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      const result = rename(from, to);
      if (String(to).includes("transactions/disconnect/") && String(to).endsWith(".json")) {
        const fd = fs.openSync(to, "r"); fs.fsyncSync(fd); fs.closeSync(fd);
        process.exit(23);
      }
      return result;
    };
    withContextHubProjectSharedDisconnection(root, pending => disconnectSharedContext(root,
      { projectRoots: pending.sharedProjectRoots, projectCapabilities: pending.sharedProjectCapabilities }));
    throw new Error("The process must stop after publishing its disconnect journal");
  }
  if (action === "forget-durable") {
    // Rewrite this enrollment as Context Room wrote it before durable identities.
    const strip = (value) => Array.isArray(value) ? value.map(strip) : value && typeof value === "object"
      ? Object.fromEntries(Object.entries(value).filter(([key]) => !key.endsWith("DurableIdentity")).map(([key, item]) => [key, strip(item)]))
      : value;
    const files = [path.join(base, "hub/registry.json"), path.join(base, "shared/registry.json"),
      ...fs.readdirSync(path.join(base, "shared"), { recursive: true }).map(name => path.join(base, "shared", name))
        .filter(file => file.includes(`${path.sep}connection-receipts${path.sep}`) && file.endsWith(".json"))];
    for (const file of files) {
      const mode = fs.statSync(file).mode;
      fs.chmodSync(file, 0o600);
      fs.writeFileSync(file, JSON.stringify(strip(JSON.parse(fs.readFileSync(file, "utf8"))), null, 2) + "\n");
      fs.chmodSync(file, mode & 0o777);
    }
    for (const name of fs.readdirSync(path.join(base, "authority"))) if (name.startsWith("location-")) fs.rmSync(path.join(base, "authority", name));
    fs.writeFileSync(manifestPath, JSON.stringify({ ...manifest, entry: strip(manifest.entry), bindings: listRegisteredSharedBindings(remote) }));
    process.exit(0);
  }
  const registryBefore = fs.readFileSync(path.join(base, "hub/registry.json"));
  const [entry] = listContextHubProjects();
  if (action === "blocked") {
    assert.equal(entry.available, false);
    assert.equal(entry.unavailableReason, "folder identity changed");
    assert.deepEqual(fs.readFileSync(path.join(base, "hub/registry.json")), registryBefore);
    assert.equal(readSharedProjectConnection(root), null);
    if (!altered.git) assert.equal(readSharedConnectionReceipt(root, { repository: remote, projectId: "demo", receiptId: manifest.receiptId }), null);
  } else if (action === "read") {
    assert.equal(entry.available, true);
    assert.deepEqual(entry.shared, manifest.entry.shared);
    assert.equal(readSharedProjectConnection(root)?.projectId, "demo");
    assert.equal(readSharedConnectionReceipt(root, { repository: remote, projectId: "demo", receiptId: manifest.receiptId })?.receiptId, manifest.receiptId);
    assert.ok(readNotebook(root, manifest.scene.resourceId));
    assert.deepEqual(listRegisteredSharedBindings(remote), manifest.bindings);
    assert.throws(() => removeOrphanedSharedContextBindings({ repository: remote, projectId: "demo", projectRoots: [manifest.entry] }), { code: "shared-orphan-root-still-present" });
    assert.deepEqual(listRegisteredSharedBindings(remote), manifest.bindings);
  } else if (action === "confirm") {
    const old = `${manifest.entry.rootIdentity.dev}:${manifest.entry.rootIdentity.ino}`;
    assert.equal(entry.available, false);
    assert.equal(entry.unavailableReason, "identity to confirm");
    assert.equal(entry.confirmRootIdentity, old);
    assert.deepEqual(fs.readFileSync(path.join(base, "hub/registry.json")), registryBefore);
    assert.equal(readSharedProjectConnection(root), null);
    assert.throws(() => readNotebook(root, manifest.scene.resourceId), { code: "notebook_root_conflict" });
    assert.throws(() => confirmContextHubProjectLocation({ projectId: entry.id, expectedRoot: root, expectedRootIdentity: "1:1" }), { code: "context_hub_location_changed" });
    const confirmed = confirmContextHubProjectLocation({ projectId: entry.id, expectedRoot: root, expectedRootIdentity: old });
    assert.deepEqual(confirmed.confirmedIdentities, [old]);
    assert.equal(acceptsRootIdentity(root, old), "confirmed");
    const [after] = listContextHubProjects();
    assert.equal(after.available, true);
    assert.equal("confirmRootIdentity" in after, false);
    assert.deepEqual(after.shared, manifest.entry.shared);
    assert.throws(() => confirmContextHubProjectLocation({ projectId: after.id, expectedRoot: root,
      expectedRootIdentity: `${after.rootIdentity.dev}:${after.rootIdentity.ino}` }), { code: "context_hub_location_confirmed" });
  } else throw new Error(`Unknown action: ${action}`);
}
