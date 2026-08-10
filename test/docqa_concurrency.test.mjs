import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  initializeContextRoomProject,
  readDocReviewState,
  readGlobalReviewLedger,
  writeDocReviewDecision,
} from "../src/context_room.mjs";
import { inspectOwnerTrustedState } from "../src/review_authority.mjs";

function waitFor(predicate, message, timeoutMs = 8_000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      if (predicate()) return resolve();
      if (Date.now() - startedAt >= timeoutMs) return reject(new Error(message));
      setTimeout(poll, 10);
    };
    poll();
  });
}

function runDecisionChild({ root, relPath, hubHome, gateRoot, index, moduleUrl }) {
  const source = String.raw`
import fs from "node:fs";
import path from "node:path";

const [root, relPath, gateRoot, index, moduleUrl] = process.argv.slice(1);
const statePath = path.resolve(root, ".context-room/review-state.json");
const enteredPath = path.join(gateRoot, "entered-" + index);
const ownerPath = path.join(gateRoot, "read-owner");
const releasePath = path.join(gateRoot, "release-owner");
const readyPath = path.join(gateRoot, "ready-" + index);
const startPath = path.join(gateRoot, "start");
const originalReadFileSync = fs.readFileSync;
const originalWriteFileSync = fs.writeFileSync;
let intercepted = false;

fs.readFileSync = function(target, ...args) {
  const result = originalReadFileSync.call(this, target, ...args);
  if (!intercepted && path.resolve(String(target)) === statePath) {
    intercepted = true;
    originalWriteFileSync.call(fs, enteredPath, "entered\n", "utf8");
    let owner = false;
    let descriptor = null;
    try {
      descriptor = fs.openSync(ownerPath, "wx", 0o600);
      owner = true;
      originalWriteFileSync.call(fs, descriptor, String(index), "utf8");
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    } finally {
      if (descriptor != null) fs.closeSync(descriptor);
    }
    if (owner) {
      const wait = new Int32Array(new SharedArrayBuffer(4));
      while (!fs.existsSync(releasePath)) Atomics.wait(wait, 0, 0, 10);
    }
  }
  return result;
};

const contextRoom = await import(moduleUrl + "?docqa-child=" + process.pid + "-" + index);
originalWriteFileSync.call(fs, readyPath, "ready\n", "utf8");
const wait = new Int32Array(new SharedArrayBuffer(4));
while (!fs.existsSync(startPath)) Atomics.wait(wait, 0, 0, 10);
const content = originalReadFileSync.call(fs, path.join(root, relPath), "utf8");
const decision = contextRoom.writeDocReviewDecision(root, relPath, {
  status: "verified",
  expectedContentHash: (await import("node:crypto")).createHash("sha256").update(content).digest("hex"),
});
process.stdout.write(JSON.stringify({ path: decision.path, status: decision.status }));
`;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", source, root, relPath, gateRoot, String(index), moduleUrl], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      env: { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `DocQA decision child exited ${code}`));
      else resolve(JSON.parse(stdout || "{}"));
    });
  });
}

function regularFileSnapshot(root) {
  const snapshot = new Map();
  if (!fs.existsSync(root)) return snapshot;
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) snapshot.set(path.relative(root, absolute), fs.readFileSync(absolute));
    }
  };
  visit(root);
  return snapshot;
}

test("concurrent DocQA decisions serialize across processes without losing state, ledger, or authority", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-docqa-concurrency-"));
  const root = path.join(base, "project");
  const hubHome = path.join(base, "hub");
  const gateRoot = path.join(base, "gate");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(gateRoot, { recursive: true });
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const paths = ["docs/seed.md", ...Array.from({ length: 6 }, (_, index) => `docs/concurrent-${index}.md`)];
  for (const [index, relPath] of paths.entries()) {
    fs.writeFileSync(path.join(root, relPath), `# Review ${index}\n`, "utf8");
  }
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "docqa@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "DocQA Concurrency Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  const seedContent = fs.readFileSync(path.join(root, paths[0]), "utf8");
  writeDocReviewDecision(root, paths[0], {
    status: "verified",
    expectedContentHash: createHash("sha256").update(seedContent).digest("hex"),
  });

  const moduleUrl = new URL("../src/context_room.mjs", import.meta.url).href;
  const childPaths = paths.slice(1);
  const children = childPaths.map((relPath, index) => runDecisionChild({ root, relPath, hubHome, gateRoot, index, moduleUrl }));
  await waitFor(
    () => childPaths.every((_, index) => fs.existsSync(path.join(gateRoot, `ready-${index}`))),
    "DocQA children did not reach the common start gate",
  );
  fs.writeFileSync(path.join(gateRoot, "start"), "start\n", "utf8");
  await waitFor(() => fs.existsSync(path.join(gateRoot, "read-owner")), "No child reached the protected state read");
  await new Promise((resolve) => setTimeout(resolve, 350));
  const enteredBeforeRelease = fs.readdirSync(gateRoot).filter((name) => name.startsWith("entered-")).length;
  fs.writeFileSync(path.join(gateRoot, "release-owner"), "release\n", "utf8");
  const results = await Promise.all(children);

  assert.equal(enteredBeforeRelease, 1, "only the lock owner may read the shared state while its transaction is paused");
  assert.deepEqual(results.map((item) => item.status), childPaths.map(() => "verified"));
  const state = readDocReviewState(root);
  assert.deepEqual(Object.keys(state.reviews).sort(), [...paths].sort());
  const ledger = readGlobalReviewLedger(root);
  assert.equal(Object.keys(ledger.reviews).length, paths.length);
  const rawState = JSON.parse(fs.readFileSync(path.join(root, ".context-room/review-state.json"), "utf8"));
  const rawLedger = JSON.parse(fs.readFileSync(path.join(root, ".context-room/review-ledger.json"), "utf8"));
  const stateAuthority = inspectOwnerTrustedState(root, "review-state", rawState);
  const ledgerAuthority = inspectOwnerTrustedState(fs.realpathSync(root), "review-ledger", rawLedger);
  assert.equal(stateAuthority.trusted, true, JSON.stringify(stateAuthority));
  assert.equal(ledgerAuthority.trusted, true, JSON.stringify(ledgerAuthority));
});

test("a failed ledger publication rolls back local state, ledger, baseline, and trusted authority", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-docqa-rollback-"));
  const root = path.join(base, "project");
  const hubHome = path.join(base, "hub");
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    fs.rmSync(base, { recursive: true, force: true });
  });

  for (const [relPath, content] of [["docs/seed.md", "# Seed\n"], ["docs/rollback.md", "# Rollback\n"]]) {
    fs.writeFileSync(path.join(root, relPath), content, "utf8");
  }
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "docqa@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "DocQA Rollback Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  const seedContent = fs.readFileSync(path.join(root, "docs/seed.md"), "utf8");
  writeDocReviewDecision(root, "docs/seed.md", {
    status: "verified",
    expectedContentHash: createHash("sha256").update(seedContent).digest("hex"),
  });

  const statePath = path.join(root, ".context-room/review-state.json");
  const canonicalRoot = fs.realpathSync(root);
  const ledgerPath = path.join(canonicalRoot, ".context-room/review-ledger.json");
  const baselineRoot = path.join(root, ".context-room/review-baselines");
  const stateBefore = fs.readFileSync(statePath);
  const ledgerBefore = fs.readFileSync(ledgerPath);
  const baselinesBefore = regularFileSnapshot(baselineRoot);
  const originalRenameSync = fs.renameSync;
  let injected = false;
  fs.renameSync = function(source, destination) {
    if (!injected && path.resolve(String(destination)) === path.resolve(ledgerPath)) {
      injected = true;
      const error = new Error("injected ledger publication failure");
      error.code = "EIO";
      throw error;
    }
    return originalRenameSync.call(this, source, destination);
  };
  try {
    const content = fs.readFileSync(path.join(root, "docs/rollback.md"), "utf8");
    assert.throws(() => writeDocReviewDecision(root, "docs/rollback.md", {
      status: "verified",
      expectedContentHash: createHash("sha256").update(content).digest("hex"),
    }), /injected ledger publication failure/);
  } finally {
    fs.renameSync = originalRenameSync;
  }

  assert.equal(injected, true);
  assert.deepEqual(fs.readFileSync(statePath), stateBefore);
  assert.deepEqual(fs.readFileSync(ledgerPath), ledgerBefore);
  assert.deepEqual(regularFileSnapshot(baselineRoot), baselinesBefore);
  const state = readDocReviewState(root);
  const ledger = readGlobalReviewLedger(root);
  assert.deepEqual(Object.keys(state.reviews), ["docs/seed.md"]);
  assert.equal(Object.keys(ledger.reviews).length, 1);
  const rawState = JSON.parse(stateBefore.toString("utf8"));
  const rawLedger = JSON.parse(ledgerBefore.toString("utf8"));
  assert.equal(inspectOwnerTrustedState(root, "review-state", rawState).trusted, true);
  assert.equal(inspectOwnerTrustedState(canonicalRoot, "review-ledger", rawLedger).trusted, true);

  const externalVictim = path.join(base, "rollback-symlink-victim.json");
  const victimBefore = Buffer.from('{"sentinel":"must survive"}\n');
  fs.writeFileSync(externalVictim, victimBefore);
  let stateSwapped = false;
  let ledgerFailed = false;
  fs.renameSync = function(source, destination) {
    const result = originalRenameSync.call(this, source, destination);
    if (!stateSwapped && path.resolve(String(destination)) === path.resolve(statePath)) {
      fs.unlinkSync(statePath);
      fs.symlinkSync(externalVictim, statePath);
      stateSwapped = true;
      return result;
    }
    if (stateSwapped && !ledgerFailed && path.resolve(String(destination)) === path.resolve(ledgerPath)) {
      ledgerFailed = true;
      const error = new Error("injected ledger failure after review-state symlink swap");
      error.code = "EIO";
      throw error;
    }
    return result;
  };
  try {
    const content = fs.readFileSync(path.join(root, "docs/rollback.md"), "utf8");
    assert.throws(
      () => writeDocReviewDecision(root, "docs/rollback.md", {
        status: "verified",
        expectedContentHash: createHash("sha256").update(content).digest("hex"),
      }),
      (error) => error?.code === "filesystem_recovery_required",
    );
  } finally {
    fs.renameSync = originalRenameSync;
  }
  assert.equal(stateSwapped, true);
  assert.equal(ledgerFailed, true);
  assert.deepEqual(fs.readFileSync(externalVictim), victimBefore);
  assert.equal(fs.lstatSync(statePath).isSymbolicLink(), true);
});
