import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";

import { registerContextHubProject } from "../src/context_hub.mjs";
import {
  cleanupFilesystemLockWorkerOwner,
  createFilesystemLockWorkerOwner,
  filesystemProcessIdentity,
  withFilesystemLock,
} from "../src/filesystem_lock.mjs";
import {
  buildContextRoomReports,
  buildContextRoomDoctorReport,
  createMemoryServer,
  deleteMemoryPaths,
  initializeContextRoomProject,
  readFileDiff,
  readMemoryFile,
  readMemoryWebappSettings,
  revertMemoryFile,
  writeDocReviewBaseline,
  writeDocReviewDecision,
  writeMemoryFile,
  writeMemoryWebappSettings,
} from "../src/context_room.mjs";

const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
const suiteHome = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-revision-integrity-"));
process.env.CONTEXT_ROOM_HUB_HOME = path.join(suiteHome, "hub");

test.after(() => {
  if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
  else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
  fs.rmSync(suiteHome, { recursive: true, force: true });
});

function makeProject(name) {
  const root = path.join(suiteHome, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), `# ${name}\n`, "utf8");
  fs.writeFileSync(path.join(root, "docs", "DELETE.md"), "# Delete me\n", "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "revision@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Revision Integrity Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  return root;
}

async function startRoom(t, root) {
  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve, reject) => room.server.close((error) => error ? reject(error) : resolve())));
  return { ...room, origin: `http://127.0.0.1:${room.server.address().port}` };
}

function ownerHeaders(room) {
  return {
    "content-type": "application/json",
    "x-context-room-owner-nonce": room.ownerMutationNonce,
    "x-context-room-project": room.projectId,
  };
}

function startFilesystemLockWorker(t, { lockPath, owner, holdMs = 5_000, staleMs = 40 }) {
  const moduleUrl = new URL("../src/filesystem_lock.mjs", import.meta.url).href;
  const source = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
(async () => {
  const { withFilesystemLock } = await import(workerData.moduleUrl);
  withFilesystemLock(workerData.lockPath, () => {
    parentPort.postMessage({ type: "locked" });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, workerData.holdMs);
  }, { timeoutMs: 1_000, staleMs: workerData.staleMs });
  parentPort.postMessage({ type: "released" });
})().catch((error) => parentPort.postMessage({ type: "error", code: error?.code, message: error?.message }));
`;
  const worker = new Worker(source, {
    eval: true,
    workerData: { moduleUrl, lockPath, holdMs, staleMs, filesystemLockOwner: owner },
  });
  t.after(() => { if (worker.threadId !== -1) worker.terminate().catch(() => {}); });
  return worker;
}

async function waitForWorkerMessage(worker, type) {
  while (true) {
    const [message] = await once(worker, "message");
    if (message?.type === "error") throw Object.assign(new Error(message.message), { code: message.code });
    if (message?.type === type) return message;
  }
}

test("filesystem lock supervision never steals a live Worker and cleans an exited owner exactly", async (t) => {
  const lockRoot = path.join(suiteHome, "filesystem-lock-supervision");
  fs.mkdirSync(lockRoot, { recursive: true });
  const lockPath = path.join(lockRoot, "resource.lock");

  const liveOwner = createFilesystemLockWorkerOwner([lockPath]);
  const liveWorker = startFilesystemLockWorker(t, { lockPath, owner: liveOwner, holdMs: 300, staleMs: 30 });
  await waitForWorkerMessage(liveWorker, "locked");
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.throws(() => withFilesystemLock(lockPath, () => {}, { timeoutMs: 80, staleMs: 30 }), (error) => error?.code === "filesystem_lock_busy");
  await waitForWorkerMessage(liveWorker, "released");
  if (liveWorker.threadId !== -1) await once(liveWorker, "exit");
  assert.equal(withFilesystemLock(lockPath, () => "available", { timeoutMs: 500, staleMs: 30 }), "available");

  const abandonedOwner = createFilesystemLockWorkerOwner([lockPath]);
  const abandonedWorker = startFilesystemLockWorker(t, { lockPath, owner: abandonedOwner });
  await waitForWorkerMessage(abandonedWorker, "locked");
  await abandonedWorker.terminate();
  const cleanup = cleanupFilesystemLockWorkerOwner(abandonedOwner, { timeoutMs: 500, staleMs: 30 });
  assert.ok(cleanup.removed >= 1);
  withFilesystemLock(lockPath, ({ assertHeld }) => {
    cleanupFilesystemLockWorkerOwner(abandonedOwner, { timeoutMs: 500, staleMs: 30 });
    assert.doesNotThrow(assertHeld);
  }, { timeoutMs: 500, staleMs: 30 });
  assert.equal(fs.existsSync(lockPath), false);
});

test("filesystem lock rejects asynchronous critical sections", () => {
  const lockPath = path.join(suiteHome, "filesystem-lock-async", "resource.lock");
  assert.throws(
    () => withFilesystemLock(lockPath, () => Promise.resolve()),
    (error) => error?.code === "filesystem_lock_async_unsupported",
  );
  assert.equal(fs.existsSync(lockPath), false);
});

test("server read-only Worker reports never acquire the Hermes mutation lock", async () => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "worker-pool-cleanup-hermes");
  process.env.HERMES_HOME = hermesHome;
  let room = null;
  let listening = false;
  try {
    const cronDir = path.join(hermesHome, "cron");
    const sourceDir = path.join(cronDir, "jobs-md");
    const lockPath = path.join(cronDir, ".context-room.lock");
    const reclaimPath = `${lockPath}.reclaim`;
    fs.mkdirSync(sourceDir, { recursive: true });
    const jobs = [{ id: "pool", name: "Pool", prompt: "hello", schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true }];
    fs.writeFileSync(path.join(sourceDir, "pool.md"), "---\nname: Pool\nschedule: 0 9 * * *\nenabled: true\n---\n\nhello\n", "utf8");
    fs.writeFileSync(path.join(cronDir, "jobs.json"), JSON.stringify({ jobs }, null, 2) + "\n", "utf8");
    const root = makeProject("worker-pool-cleanup");
    const settings = readMemoryWebappSettings(root);
    writeMemoryWebappSettings(root, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    room = createMemoryServer({ root });
    await new Promise((resolve) => room.server.listen(0, "127.0.0.1", () => {
      listening = true;
      resolve();
    }));
    const response = await fetch(`http://127.0.0.1:${room.server.address().port}/api/reports?fresh=1`);
    assert.equal(response.status, 200, await response.text());
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(reclaimPath), false);
    await new Promise((resolve, reject) => room.server.close((error) => error ? reject(error) : resolve()));
    listening = false;
    assert.equal(fs.existsSync(lockPath), false);
    assert.equal(fs.existsSync(reclaimPath), false);
  } finally {
    if (room && listening) await new Promise((resolve) => room.server.close(() => resolve()));
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

async function deletionManifest(origin, headers, paths) {
  const response = await fetch(origin + "/api/files/delete-preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ paths }),
  });
  if (response.status !== 200) assert.fail(await response.text());
  return response.json();
}

async function waitForPath(filePath, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

async function withAnchoredChildPreload(name, source, env, action) {
  const preload = path.join(suiteHome, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);
  fs.writeFileSync(preload, source, "utf8");
  const keys = ["NODE_OPTIONS", ...Object.keys(env || {})];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.NODE_OPTIONS = [previous.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" ");
  for (const [key, value] of Object.entries(env || {})) process.env[key] = String(value);
  try {
    return await action();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

async function withParentDirectorySwap(name, { parent, movedParent, outside, targetName }, action) {
  const oncePath = path.join(suiteHome, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.once`);
  const preload = String.raw`
const fs = require("node:fs");
const originalMkdir = fs.mkdirSync;
fs.mkdirSync = function(target, ...rest) {
  if (String(target) === process.env.CR_MKDIR_TARGET && !fs.existsSync(process.env.CR_MKDIR_ONCE)) {
    fs.writeFileSync(process.env.CR_MKDIR_ONCE, "1\n", "utf8");
    fs.renameSync(process.env.CR_MKDIR_PARENT, process.env.CR_MKDIR_MOVED_PARENT);
    fs.symlinkSync(process.env.CR_MKDIR_OUTSIDE, process.env.CR_MKDIR_PARENT);
  }
  return originalMkdir.call(this, target, ...rest);
};
`;
  try {
    return await withAnchoredChildPreload(name, preload, {
      CR_MKDIR_ONCE: oncePath,
      CR_MKDIR_PARENT: parent,
      CR_MKDIR_MOVED_PARENT: movedParent,
      CR_MKDIR_OUTSIDE: outside,
      CR_MKDIR_TARGET: targetName,
    }, action);
  } finally {
    try {
      if (fs.lstatSync(parent).isSymbolicLink()) fs.unlinkSync(parent);
    } catch {}
    if (fs.existsSync(movedParent) && !fs.existsSync(parent)) fs.renameSync(movedParent, parent);
  }
}

function interruptOrdinarySaveAfterClaim(root, relPath, replacement = "# interrupted replacement\n") {
  const preload = path.join(suiteHome, `parent-claim-crash-${Date.now()}-${Math.random().toString(16).slice(2)}.cjs`);
  fs.writeFileSync(preload, String.raw`
const childProcess = require("node:child_process");
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function(file, args, options) {
  const input = String(options && options.input || "");
  const result = originalExecFileSync.apply(this, arguments);
  if (String(file) === process.execPath && input.includes('"kind":"claim-file"')) process.exit(97);
  return result;
};
`, "utf8");
  const moduleUrl = new URL("../src/context_room.mjs", import.meta.url).href;
  const source = `import { writeMemoryFile } from ${JSON.stringify(moduleUrl)}; writeMemoryFile(process.env.CR_ROOT, ${JSON.stringify(relPath)}, ${JSON.stringify(replacement)});`;
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      env: {
        ...process.env,
        CR_ROOT: root,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" "),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    (error) => error?.status === 97,
  );
}

function pendingFileMutationJournal(root) {
  const directory = path.join(root, ".context-room", "file-transactions");
  const names = fs.readdirSync(directory).filter((name) => name.endsWith(".json"));
  assert.equal(names.length, 1);
  return path.join(directory, names[0]);
}

function runRootSwapHttpMutation(root, {
  pathname,
  body = {},
  previewDeletePaths = null,
} = {}) {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const canonicalRoot = fs.realpathSync(root);
  const replacementRoot = `${canonicalRoot}-replacement-${suffix}`;
  const movedRoot = `${canonicalRoot}-moved-${suffix}`;
  const preload = path.join(suiteHome, `root-swap-${suffix}.cjs`);
  const arm = path.join(suiteHome, `root-swap-${suffix}.arm`);
  const swappedSignal = path.join(suiteHome, `root-swap-${suffix}.swapped`);
  fs.cpSync(canonicalRoot, replacementRoot, { recursive: true, preserveTimestamps: true });
  fs.writeFileSync(preload, String.raw`
const fs = require("node:fs");
const path = require("node:path");
const originalLstatSync = fs.lstatSync;
const originalRenameSync = fs.renameSync;
let swapped = false;
fs.lstatSync = function(candidate, ...args) {
  const stats = originalLstatSync.call(this, candidate, ...args);
  const stack = String(new Error().stack || "");
  if (!swapped
    && fs.existsSync(process.env.CR_ROOT_SWAP_ARM)
    && path.resolve(String(candidate)) === path.resolve(process.env.CR_ROOT)
    && stack.includes("routeRequest")) {
    originalRenameSync(process.env.CR_ROOT, process.env.CR_MOVED_ROOT);
    originalRenameSync(process.env.CR_REPLACEMENT_ROOT, process.env.CR_ROOT);
    fs.writeFileSync(process.env.CR_ROOT_SWAP_SIGNAL, "swapped\n", "utf8");
    swapped = true;
  }
  return stats;
};
require("node:module").syncBuiltinESMExports();
`, "utf8");
  const moduleUrl = new URL("../src/context_room.mjs", import.meta.url).href;
  const source = String.raw`
const { default: fs } = await import("node:fs");
const { createMemoryServer } = await import(${JSON.stringify(moduleUrl)});
const room = createMemoryServer({ root: process.env.CR_ROOT });
await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
const origin = "http://127.0.0.1:" + room.server.address().port;
const headers = {
  "content-type": "application/json",
  "x-context-room-owner-nonce": room.ownerMutationNonce,
  "x-context-room-project": room.projectId,
};
let body = JSON.parse(process.env.CR_REQUEST_BODY || "{}");
const previewDeletePaths = JSON.parse(process.env.CR_PREVIEW_DELETE_PATHS || "null");
if (Array.isArray(previewDeletePaths)) {
  const preview = await fetch(origin + "/api/files/delete-preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ paths: previewDeletePaths }),
  });
  if (preview.status !== 200) throw new Error("delete preview failed: " + await preview.text());
  body = await preview.json();
}
fs.writeFileSync(process.env.CR_ROOT_SWAP_ARM, "armed\n", "utf8");
const response = await fetch(origin + process.env.CR_REQUEST_PATH, {
  method: "POST",
  headers,
  body: JSON.stringify(body),
});
const text = await response.text();
await new Promise((resolve) => room.server.close(() => resolve()));
console.log(JSON.stringify({ status: response.status, text }));
`;
  let outcome;
  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      env: {
        ...process.env,
        CR_ROOT: canonicalRoot,
        CR_MOVED_ROOT: movedRoot,
        CR_REPLACEMENT_ROOT: replacementRoot,
        CR_ROOT_SWAP_ARM: arm,
        CR_ROOT_SWAP_SIGNAL: swappedSignal,
        CR_REQUEST_PATH: pathname,
        CR_REQUEST_BODY: JSON.stringify(body),
        CR_PREVIEW_DELETE_PATHS: JSON.stringify(previewDeletePaths),
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" "),
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 4_000_000,
    });
    outcome = JSON.parse(output.trim().split("\n").at(-1));
    assert.equal(fs.existsSync(swappedSignal), true, "the child must replace the root after routeRequest validates its pinned identity");
    assert.equal(fs.existsSync(movedRoot), true);
    assert.equal(fs.existsSync(canonicalRoot), true);
    fs.renameSync(canonicalRoot, replacementRoot);
    fs.renameSync(movedRoot, canonicalRoot);
    return { outcome, replacementRoot };
  } catch (error) {
    if (fs.existsSync(movedRoot)) {
      if (fs.existsSync(canonicalRoot) && !fs.existsSync(replacementRoot)) fs.renameSync(canonicalRoot, replacementRoot);
      if (!fs.existsSync(canonicalRoot)) fs.renameSync(movedRoot, canonicalRoot);
    }
    throw error;
  }
}

function reviewControlTreeSnapshot(root) {
  const targets = [
    path.join(root, ".context-room", "review-state.json"),
    path.join(root, ".context-room", "review-ledger.json"),
    path.join(root, ".context-room", "review-baselines"),
  ];
  const result = [];
  const visit = (candidate) => {
    let stats;
    try { stats = fs.lstatSync(candidate); } catch (error) { if (error?.code === "ENOENT") return; throw error; }
    const relative = path.relative(root, candidate);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      result.push([relative, "directory", stats.mode & 0o7777]);
      for (const name of fs.readdirSync(candidate).sort()) visit(path.join(candidate, name));
      return;
    }
    if (stats.isFile() && !stats.isSymbolicLink()) {
      result.push([relative, "file", stats.mode & 0o7777, fs.readFileSync(candidate).toString("base64")]);
      return;
    }
    result.push([relative, "unsafe"]);
  };
  for (const target of targets) visit(target);
  return result;
}

async function startPreopenedFdWriter(t, target, content, name) {
  const prefix = path.join(suiteHome, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const ready = `${prefix}.ready`;
  const signal = `${prefix}.signal`;
  const done = `${prefix}.done`;
  const writerSource = String.raw`
const fs = require("node:fs");
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const fd = fs.openSync(process.env.CR_TARGET, "r+");
fs.writeFileSync(process.env.CR_READY, "1");
const deadline = Date.now() + 5000;
while (!fs.existsSync(process.env.CR_SIGNAL)) {
  if (Date.now() >= deadline) process.exit(98);
  Atomics.wait(sleeper, 0, 0, 1);
}
const bytes = Buffer.from(process.env.CR_BYTES, "base64");
fs.ftruncateSync(fd, 0);
fs.writeSync(fd, bytes, 0, bytes.length, 0);
fs.fsyncSync(fd);
fs.writeFileSync(process.env.CR_DONE, "1");
fs.closeSync(fd);
`;
  const child = spawn(process.execPath, ["-e", writerSource], {
    stdio: "ignore",
    env: {
      ...process.env,
      NODE_OPTIONS: "",
      CR_TARGET: target,
      CR_READY: ready,
      CR_SIGNAL: signal,
      CR_DONE: done,
      CR_BYTES: Buffer.from(content).toString("base64"),
    },
  });
  const exited = once(child, "exit");
  t.after(() => { if (child.exitCode == null) child.kill(); });
  await waitForPath(ready);
  return { ready, signal, done, child, exited };
}

const signalBeforeExclusiveOpenPreload = String.raw`
const fs = require("node:fs");
const originalOpen = fs.openSync;
let fired = false;
const sleeper = new Int32Array(new SharedArrayBuffer(4));
fs.openSync = function(filePath, flags, ...rest) {
  const target = String(filePath);
  const matchesTarget = target === process.env.CR_TARGET_NAME || (process.env.CR_TARGET_PREFIX && target.startsWith(process.env.CR_TARGET_PREFIX));
  if (!fired && matchesTarget && (Number(flags) & fs.constants.O_EXCL)) {
    fired = true;
    fs.writeFileSync(process.env.CR_SIGNAL, "1");
    const deadline = Date.now() + 5000;
    while (!fs.existsSync(process.env.CR_DONE)) {
      if (Date.now() >= deadline) throw Object.assign(new Error("fd writer timeout"), { code: "ETIMEDOUT" });
      Atomics.wait(sleeper, 0, 0, 1);
    }
  }
  return originalOpen.call(this, filePath, flags, ...rest);
};
`;

test("stale diff revert cannot overwrite a newer tab save", async (t) => {
  const root = makeProject("stale-revert");
  const room = await startRoom(t, root);
  const filePath = "docs/README.md";
  const original = await (await fetch(room.origin + "/api/file?path=" + encodeURIComponent(filePath))).json();

  fs.writeFileSync(path.join(root, filePath), "# Version A\n", "utf8");
  const viewedDiff = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(filePath))).json();
  assert.ok(viewedDiff.revision);

  const newerContent = "# Version B from another tab\n";
  fs.writeFileSync(path.join(root, filePath), newerContent, "utf8");

  const staleRevert = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: filePath, expectedRevision: viewedDiff.revision }),
  });
  assert.equal(staleRevert.status, 409);
  assert.equal((await staleRevert.json()).code, "file_revision_conflict");
  assert.equal(fs.readFileSync(path.join(root, filePath), "utf8"), newerContent);

  const missingRevision = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: filePath }),
  });
  assert.equal(missingRevision.status, 400);
  assert.equal((await missingRevision.json()).code, "file_revision_required");
  assert.equal(fs.readFileSync(path.join(root, filePath), "utf8"), newerContent);

  const freshDiff = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(filePath))).json();
  const missingNonce = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify({ path: filePath, expectedRevision: freshDiff.revision }),
  });
  assert.equal(missingNonce.status, 403);
  assert.equal((await missingNonce.json()).code, "review_authority_nonce_required");

  fs.chmodSync(path.join(root, filePath), 0o755);
  const staleModeRevert = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: filePath, expectedRevision: freshDiff.revision }),
  });
  assert.equal(staleModeRevert.status, 409);
  assert.equal(fs.statSync(path.join(root, filePath)).mode & 0o777, 0o755);

  const currentDiff = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(filePath))).json();
  const reverted = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: filePath, expectedRevision: currentDiff.revision }),
  });
  assert.equal(reverted.status, 200, await reverted.text());
  assert.equal(fs.readFileSync(path.join(root, filePath), "utf8"), original.content);
});

test("stale local delete is atomic for files and folder membership", async (t) => {
  const root = makeProject("stale-delete");
  const room = await startRoom(t, root);
  const paths = ["docs/README.md", "docs/DELETE.md"];
  const staleManifest = await deletionManifest(room.origin, ownerHeaders(room), paths);

  fs.writeFileSync(path.join(root, "docs", "README.md"), "# Newer content\n", "utf8");
  const staleDelete = await fetch(room.origin + "/api/files/delete", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify(staleManifest),
  });
  assert.equal(staleDelete.status, 409);
  assert.equal((await staleDelete.json()).code, "file_revision_conflict");
  assert.equal(fs.existsSync(path.join(root, "docs", "README.md")), true);
  assert.equal(fs.existsSync(path.join(root, "docs", "DELETE.md")), true);

  const missingRevision = await fetch(room.origin + "/api/files/delete", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ paths: ["docs/DELETE.md"] }),
  });
  assert.equal(missingRevision.status, 400);
  assert.equal((await missingRevision.json()).code, "file_revision_required");
  assert.equal(fs.existsSync(path.join(root, "docs", "DELETE.md")), true);

  const folderManifest = await deletionManifest(room.origin, ownerHeaders(room), ["docs/"]);
  fs.writeFileSync(path.join(root, "docs", "LATE.md"), "# Added later\n", "utf8");
  const staleFolderDelete = await fetch(room.origin + "/api/files/delete", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify(folderManifest),
  });
  assert.equal(staleFolderDelete.status, 409);
  assert.equal(fs.existsSync(path.join(root, "docs", "README.md")), true);
  assert.equal(fs.existsSync(path.join(root, "docs", "DELETE.md")), true);
  assert.equal(fs.existsSync(path.join(root, "docs", "LATE.md")), true);

  const freshManifest = await deletionManifest(room.origin, ownerHeaders(room), paths);
  const missingNonce = await fetch(room.origin + "/api/files/delete", {
    method: "POST",
    headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
    body: JSON.stringify(freshManifest),
  });
  assert.equal(missingNonce.status, 403);
  assert.equal((await missingNonce.json()).code, "review_authority_nonce_required");

  const deleted = await fetch(room.origin + "/api/files/delete", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify(freshManifest),
  });
  assert.equal(deleted.status, 200, await deleted.text());
  assert.equal(fs.existsSync(path.join(root, "docs", "README.md")), false);
  assert.equal(fs.existsSync(path.join(root, "docs", "DELETE.md")), false);
  assert.equal(fs.existsSync(path.join(root, "docs", "LATE.md")), true);
});

test("direct deletion preflights every path before unlinking any file", () => {
  const root = makeProject("atomic-delete-preflight");
  assert.throws(
    () => deleteMemoryPaths(root, ["docs/DELETE.md", "outside.md"]),
    /Path not allowed in context room/,
  );
  assert.equal(fs.existsSync(path.join(root, "docs", "DELETE.md")), true);
});

test("delete preview returns bounded 4xx errors for invalid and oversized manifests", async (t) => {
  const root = makeProject("delete-limits");
  const room = await startRoom(t, root);
  const request = (paths) => fetch(room.origin + "/api/files/delete-preview", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ paths }),
  });

  const empty = await request([]);
  assert.equal(empty.status, 400);
  assert.equal((await empty.json()).code, "delete_paths_required");

  const outside = await request(["outside.md"]);
  assert.equal(outside.status, 400);
  assert.equal((await outside.json()).code, "delete_path_not_allowed");

  fs.writeFileSync(path.join(root, "docs", "huge.md"), Buffer.alloc(750_001, 0x61));
  const oversized = await request(["docs/huge.md"]);
  assert.equal(oversized.status, 413);
  assert.equal((await oversized.json()).code, "delete_file_too_large");

  const tooManyPaths = await request(Array.from({ length: 5_001 }, (_, index) => `docs/missing-${index}.md`));
  assert.equal(tooManyPaths.status, 413);
  assert.equal((await tooManyPaths.json()).code, "delete_manifest_too_many_paths");
});

test("delete preview caps aggregate bytes before hashing an unbounded folder", async (t) => {
  const root = makeProject("delete-aggregate-limit");
  const room = await startRoom(t, root);
  const chunk = Buffer.alloc(750_000, 0x61);
  for (let index = 0; index < 86; index += 1) {
    fs.writeFileSync(path.join(root, "docs", `bulk-${String(index).padStart(2, "0")}.md`), chunk);
  }
  const response = await fetch(room.origin + "/api/files/delete-preview", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ paths: ["docs/"] }),
  });
  assert.equal(response.status, 413);
  assert.equal((await response.json()).code, "delete_manifest_too_large");
});

test("delete stages and rolls back a boundary replacement and a mid-commit I/O failure", async (t) => {
  const root = makeProject("delete-transaction");
  const room = await startRoom(t, root);
  const first = path.join(root, "docs", "README.md");
  const second = path.join(root, "docs", "DELETE.md");

  const staleManifest = await deletionManifest(room.origin, ownerHeaders(room), ["docs/README.md", "docs/DELETE.md"]);
  const replaceBeforeClaimPreload = String.raw`
const fs = require("node:fs");
const originalRename = fs.renameSync;
let fired = false;
fs.renameSync = function(source, target) {
  if (!fired && String(source) === "README.md" && String(target).startsWith(".context-room-delete-")) {
    fired = true;
    fs.writeFileSync(source, "# Concurrent replacement\n", "utf8");
  }
  return originalRename.apply(this, arguments);
};
`;
  await withAnchoredChildPreload("replace-before-claim", replaceBeforeClaimPreload, {}, async () => {
    const response = await fetch(room.origin + "/api/files/delete", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify(staleManifest),
    });
    assert.equal(response.status, 409, await response.text());
  });
  assert.equal(fs.readFileSync(first, "utf8"), "# Concurrent replacement\n");
  assert.equal(fs.existsSync(second), true);

  const freshManifest = await deletionManifest(room.origin, ownerHeaders(room), ["docs/README.md", "docs/DELETE.md"]);
  const failureSentinel = path.join(suiteHome, "delete-mid-commit.once");
  const failSecondUnlinkPreload = String.raw`
const fs = require("node:fs");
const originalUnlink = fs.unlinkSync;
let stagedUnlinks = 0;
fs.unlinkSync = function(filePath) {
  if (String(filePath).startsWith(".context-room-delete-") && ++stagedUnlinks === 2 && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    throw Object.assign(new Error("injected unlink failure"), { code: "EIO" });
  }
  return originalUnlink.apply(this, arguments);
};
`;
  await withAnchoredChildPreload("fail-second-unlink", failSecondUnlinkPreload, { CR_ONCE: failureSentinel }, async () => {
    const response = await fetch(room.origin + "/api/files/delete", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify(freshManifest),
    });
    assert.equal(response.status, 500);
  });
  assert.equal(fs.readFileSync(first, "utf8"), "# Concurrent replacement\n");
  assert.equal(fs.readFileSync(second, "utf8"), "# Delete me\n");
  assert.deepEqual(fs.readdirSync(path.dirname(first)).filter((name) => name.startsWith(".context-room-delete-")), []);
});

test("deletion backups refuse a post-claim parent symlink swap without touching external bytes", async (t) => {
  const root = makeProject("deletion-backup-parent-swap");
  const room = await startRoom(t, root);
  const relPath = "docs/README.md";
  const source = path.join(root, relPath);
  const original = fs.readFileSync(source);
  const viewed = readMemoryFile(root, relPath, { readOnly: true });
  const canonicalRoot = fs.realpathSync(root);
  const outside = path.join(suiteHome, "deletion-backup-parent-swap-outside");
  const outsideVictim = path.join(outside, "README.md");
  const outsideBytes = Buffer.from("external backup victim must stay unchanged\n", "utf8");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(outsideVictim, outsideBytes, { mode: 0o640 });
  const outsideMode = fs.statSync(outsideVictim).mode & 0o777;

  const originalLstatSync = fs.lstatSync;
  let swappedParent = "";
  let movedParent = "";
  fs.lstatSync = function(candidate, ...args) {
    const stats = originalLstatSync.call(this, candidate, ...args);
    const resolved = path.resolve(String(candidate));
    if (!swappedParent
      && resolved.startsWith(path.join(canonicalRoot, ".context-room", "memory-webapp-backups") + path.sep)
      && path.basename(resolved) === "docs") {
      movedParent = `${resolved}-claimed-parent`;
      fs.renameSync(resolved, movedParent);
      fs.symlinkSync(outside, resolved, "dir");
      swappedParent = resolved;
    }
    return stats;
  };
  let response;
  try {
    response = await fetch(room.origin + "/api/file", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({
        path: relPath,
        content: "# replacement must not publish\n",
        expectedContentHash: viewed.contentHash,
      }),
    });
  } finally {
    fs.lstatSync = originalLstatSync;
  }

  const responseText = await response.text();
  assert.ok(swappedParent, `the backup parent must be swapped after its anchored creation was verified: ${response.status} ${responseText}`);
  assert.notEqual(response.status, 200, responseText);
  assert.deepEqual(fs.readFileSync(source), original);
  assert.deepEqual(fs.readdirSync(path.dirname(source)).filter((name) => name.startsWith(".context-room-delete-")), []);
  assert.deepEqual(fs.readFileSync(outsideVictim), outsideBytes);
  assert.equal(fs.statSync(outsideVictim).mode & 0o777, outsideMode);

  fs.unlinkSync(swappedParent);
  fs.renameSync(movedParent, swappedParent);
});

test("delete recovers claimed bytes when its anchored child exits mid-protocol", async (t) => {
  for (const phase of ["after-rename", "after-unlink", "before-json"]) {
    const root = makeProject(`delete-child-exit-${phase}`);
    const room = await startRoom(t, root);
    const abs = path.join(root, "docs", "README.md");
    const manifest = await deletionManifest(room.origin, ownerHeaders(room), ["docs/README.md"]);
    const oncePath = path.join(suiteHome, `child-exit-${phase}.once`);
    const exitMidProtocolPreload = String.raw`
const fs = require("node:fs");
const originalRename = fs.renameSync;
const originalUnlink = fs.unlinkSync;
const originalWrite = process.stdout.write.bind(process.stdout);
function fire() {
  if (fs.existsSync(process.env.CR_ONCE)) return false;
  fs.writeFileSync(process.env.CR_ONCE, "1");
  return true;
}
fs.renameSync = function(source, target) {
  const result = originalRename.apply(this, arguments);
  if (process.env.CR_PHASE === "after-rename" && String(source) === "README.md" && String(target).startsWith(".context-room-delete-") && fire()) process.exit(97);
  return result;
};
fs.unlinkSync = function(filePath) {
  const result = originalUnlink.apply(this, arguments);
  if (process.env.CR_PHASE === "after-unlink" && String(filePath).startsWith(".context-room-delete-") && fire()) process.exit(97);
  return result;
};
process.stdout.write = function(chunk, ...rest) {
  if (process.env.CR_PHASE === "before-json" && String(chunk).includes('"ok":true') && fire()) process.exit(97);
  return originalWrite(chunk, ...rest);
};
`;
    await withAnchoredChildPreload(`child-exit-${phase}`, exitMidProtocolPreload, { CR_ONCE: oncePath, CR_PHASE: phase }, async () => {
      const response = await fetch(room.origin + "/api/files/delete", {
        method: "POST",
        headers: ownerHeaders(room),
        body: JSON.stringify(manifest),
      });
      assert.equal(response.status, 500, `${phase}: ${await response.text()}`);
    });
    assert.equal(fs.readFileSync(abs, "utf8"), `# delete-child-exit-${phase}\n`);
    assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
  }
});

test("delete reports filesystem recovery required when claimed bytes can only be backed up", async (t) => {
  const root = makeProject("delete-recovery-required");
  const room = await startRoom(t, root);
  const abs = path.join(root, "docs", "README.md");
  const manifest = await deletionManifest(room.origin, ownerHeaders(room), ["docs/README.md"]);
  const oncePath = path.join(suiteHome, "delete-recovery-required.once");
  const unrecoverableClaimPreload = String.raw`
const fs = require("node:fs");
const originalRename = fs.renameSync;
const originalLink = fs.linkSync;
const originalOpen = fs.openSync;
fs.renameSync = function(source, target) {
  const result = originalRename.apply(this, arguments);
  if (String(source) === "README.md" && String(target).startsWith(".context-room-delete-") && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    process.exit(97);
  }
  return result;
};
fs.linkSync = function(source, target) {
  if (String(source).startsWith(".context-room-delete-") && String(target) === "README.md") throw Object.assign(new Error("recovery link denied"), { code: "EIO" });
  return originalLink.apply(this, arguments);
};
fs.openSync = function(filePath, flags, ...rest) {
  if (String(filePath) === "README.md"
    && process.cwd() === process.env.CR_DOCS
    && (Number(flags) & fs.constants.O_EXCL)) throw Object.assign(new Error("recovery install denied"), { code: "EIO" });
  return originalOpen.call(this, filePath, flags, ...rest);
};
`;
  await withAnchoredChildPreload("delete-recovery-required", unrecoverableClaimPreload, {
    CR_ONCE: oncePath,
    CR_DOCS: fs.realpathSync(path.dirname(abs)),
  }, async () => {
    const response = await fetch(room.origin + "/api/files/delete", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify(manifest),
    });
    const body = await response.json();
    assert.equal(response.status, 500, JSON.stringify(body));
    assert.equal(body.code, "filesystem_recovery_required");
  });
  assert.equal(fs.existsSync(abs), false);
  assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
  const backupsRoot = path.join(root, ".context-room", "memory-webapp-backups");
  const backupFiles = fs.readdirSync(backupsRoot, { recursive: true }).map(String).filter((name) => name.endsWith(path.join("docs", "README.md")));
  assert.equal(backupFiles.length > 0, true);
  assert.equal(fs.readFileSync(path.join(backupsRoot, backupFiles.at(-1)), "utf8"), "# delete-recovery-required\n");
});

test("doctor reports orphaned file-mutation staging without following symlinks", () => {
  const root = makeProject("doctor-orphaned-staging");
  const stagingFile = path.join(root, "docs", ".context-room-delete-orphan-file");
  const stagingDir = path.join(root, "docs", ".context-room-delete-orphan-dir");
  const outside = path.join(suiteHome, "doctor-orphaned-staging-outside");
  fs.writeFileSync(stagingFile, "recoverable", "utf8");
  fs.mkdirSync(stagingDir);
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, ".context-room-delete-external"), "outside", "utf8");
  fs.symlinkSync(outside, path.join(root, "docs", "external-link"));

  const issues = buildContextRoomDoctorReport(root).issues.filter((issue) => issue.type === "orphaned_file_mutation_staging");
  assert.deepEqual(issues.map((issue) => issue.path).sort(), [
    "docs/.context-room-delete-orphan-dir",
    "docs/.context-room-delete-orphan-file",
  ]);
  assert.equal(issues.every((issue) => issue.severity === "high"), true);
  assert.equal(fs.readFileSync(stagingFile, "utf8"), "recoverable");
  assert.equal(fs.statSync(stagingDir).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(outside, ".context-room-delete-external"), "utf8"), "outside");
});

test("doctor reports authorized Hermes cron staging without following or removing external symlinks", () => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "doctor-hermes-staging-home");
  process.env.HERMES_HOME = hermesHome;
  try {
    const root = makeProject("doctor-hermes-staging");
    const cronDir = path.join(hermesHome, "cron");
    const sourceDir = path.join(cronDir, "jobs-md");
    const outside = path.join(suiteHome, "doctor-hermes-staging-outside");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    const temporary = path.join(cronDir, ".context-room-cron-orphan.tmp");
    const stagedSource = path.join(sourceDir, ".context-room-delete-orphan-source");
    const outsideArtifact = path.join(outside, ".context-room-cron-external.recovery");
    const linkedArtifact = path.join(cronDir, ".context-room-cron-linked.recovery");
    fs.writeFileSync(temporary, "temporary", "utf8");
    fs.writeFileSync(stagedSource, "staged", "utf8");
    fs.writeFileSync(outsideArtifact, "external", "utf8");
    fs.symlinkSync(outsideArtifact, linkedArtifact);
    for (let index = 0; index < 260; index += 1) {
      fs.writeFileSync(path.join(root, "docs", `.context-room-delete-saturation-${index}`), "project staging", "utf8");
    }

    assert.deepEqual(
      buildContextRoomDoctorReport(root).issues.filter((issue) => issue.type === "orphaned_file_mutation_staging" && issue.path?.startsWith("~/.hermes/")),
      [],
    );
    const settings = readMemoryWebappSettings(root);
    writeMemoryWebappSettings(root, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    const reportIssues = buildContextRoomDoctorReport(root).issues.filter((issue) => issue.type === "orphaned_file_mutation_staging");
    const issues = reportIssues.filter((issue) => issue.path?.startsWith("~/.hermes/"));
    const projectIssues = reportIssues.filter((issue) => issue.path?.startsWith("docs/"));
    assert.equal(projectIssues.length, 256);
    assert.deepEqual(issues.map((issue) => issue.path).sort(), [
      "~/.hermes/cron/.context-room-cron-linked.recovery",
      "~/.hermes/cron/.context-room-cron-orphan.tmp",
      "~/.hermes/cron/jobs-md/.context-room-delete-orphan-source",
    ]);
    assert.equal(issues.every((issue) => issue.severity === "high"), true);
    assert.equal(fs.readFileSync(temporary, "utf8"), "temporary");
    assert.equal(fs.readFileSync(stagedSource, "utf8"), "staged");
    assert.equal(fs.readFileSync(outsideArtifact, "utf8"), "external");
    assert.equal(fs.lstatSync(linkedArtifact).isSymbolicLink(), true);
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

test("delete never follows a parent symlink swapped at the staging boundary", async (t) => {
  const root = makeProject("delete-parent-swap");
  const room = await startRoom(t, root);
  const docs = path.join(root, "docs");
  const movedDocs = path.join(root, "docs-old");
  const outside = path.join(suiteHome, "delete-parent-swap-outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "README.md"), "# Outside must survive\n", "utf8");
  const manifest = await deletionManifest(room.origin, ownerHeaders(room), ["docs/README.md"]);
  const oncePath = path.join(suiteHome, "delete-parent-swap.once");
  const swapAtUnlinkPreload = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const originalUnlink = fs.unlinkSync;
fs.unlinkSync = function(filePath) {
  if (String(filePath).startsWith(".context-room-delete-") && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    fs.writeFileSync(path.join(process.env.CR_OUTSIDE, String(filePath)), "outside-stage-sentinel", "utf8");
    fs.renameSync(process.env.CR_PARENT, process.env.CR_MOVED);
    fs.symlinkSync(process.env.CR_OUTSIDE, process.env.CR_PARENT);
  }
  return originalUnlink.apply(this, arguments);
};
`;
  await withAnchoredChildPreload("delete-parent-swap", swapAtUnlinkPreload, {
    CR_ONCE: oncePath,
    CR_PARENT: docs,
    CR_MOVED: movedDocs,
    CR_OUTSIDE: outside,
  }, async () => {
    const response = await fetch(room.origin + "/api/files/delete", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify(manifest),
    });
    assert.equal(response.status, 409, await response.text());
  });
  assert.equal(fs.readFileSync(path.join(outside, "README.md"), "utf8"), "# Outside must survive\n");
  assert.equal(fs.readdirSync(outside).filter((name) => name.startsWith(".context-room-delete-")).every((name) => fs.readFileSync(path.join(outside, name), "utf8") === "outside-stage-sentinel"), true);
  assert.equal(fs.readFileSync(path.join(movedDocs, "README.md"), "utf8"), `# delete-parent-swap\n`);
  assert.deepEqual(fs.readdirSync(movedDocs).filter((name) => name.startsWith(".context-room-delete-")), []);
  fs.unlinkSync(docs);
  fs.renameSync(movedDocs, docs);
});

test("byte-exact revisions reject invalid UTF-8 replacements for save, revert, and delete", async (t) => {
  const root = makeProject("byte-exact-revisions");
  const room = await startRoom(t, root);
  const relPath = "docs/BINARY.md";
  const abs = path.join(root, relPath);
  fs.writeFileSync(abs, Buffer.from([0x80]));
  const viewed = await (await fetch(room.origin + "/api/file?path=" + encodeURIComponent(relPath))).json();
  const diff = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(relPath))).json();
  const manifest = await deletionManifest(room.origin, ownerHeaders(room), [relPath]);

  fs.writeFileSync(abs, Buffer.from([0x81]));
  const staleSave = await fetch(room.origin + "/api/file", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: relPath, content: "replacement", expectedContentHash: viewed.contentHash }),
  });
  assert.equal(staleSave.status, 409);
  assert.deepEqual(fs.readFileSync(abs), Buffer.from([0x81]));

  const staleRevert = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: relPath, expectedRevision: diff.revision }),
  });
  assert.equal(staleRevert.status, 409);
  assert.deepEqual(fs.readFileSync(abs), Buffer.from([0x81]));

  const staleDelete = await fetch(room.origin + "/api/files/delete", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify(manifest),
  });
  assert.equal(staleDelete.status, 409);
  assert.deepEqual(fs.readFileSync(abs), Buffer.from([0x81]));
});

test("ordinary saves recover exact bytes when the atomic writer child exits mid-write", async (t) => {
  const root = makeProject("ordinary-save-atomic-crash");
  const room = await startRoom(t, root);
  const crashPartialAtomicWrite = String.raw`
const fs = require("node:fs");
const originalOpen = fs.openSync;
const originalWrite = fs.writeSync;
const atomicFds = new Set();
fs.openSync = function(filePath, flags, ...rest) {
  const fd = originalOpen.call(this, filePath, flags, ...rest);
  if (String(filePath).startsWith(".context-room-file-") && String(filePath).endsWith(".tmp")) atomicFds.add(fd);
  return fd;
};
fs.writeSync = function(fd, buffer, offset, length, position) {
  if (atomicFds.has(fd)) {
    originalWrite.call(this, fd, buffer, offset, Math.min(Number(length), 3), position);
    process.exit(97);
  }
  return originalWrite.apply(this, arguments);
};
`;
  for (const [relPath, initial, replacement] of [
    ["docs/README.md", "# ordinary-save-atomic-crash\n", "# replacement existing\n"],
    ["docs/NEW.md", null, "# replacement new\n"],
  ]) {
    const abs = path.join(root, relPath);
    const viewed = await (await fetch(room.origin + "/api/file?path=" + encodeURIComponent(relPath))).json();
    await withAnchoredChildPreload(`ordinary-save-crash-${path.basename(relPath)}`, crashPartialAtomicWrite, {}, async () => {
      const response = await fetch(room.origin + "/api/file", {
        method: "POST",
        headers: ownerHeaders(room),
        body: JSON.stringify({ path: relPath, content: replacement, expectedContentHash: viewed.contentHash }),
      });
      const body = await response.json();
      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(body.code, "file_filesystem_transaction_failed");
    });
    if (initial == null) assert.equal(fs.existsSync(abs), false);
    else assert.equal(fs.readFileSync(abs, "utf8"), initial);
    assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-file-") || name.startsWith(".context-room-delete-")), []);
  }
});

test("startup restores an ordinary save killed in the parent immediately after its file claim", () => {
  const root = makeProject("ordinary-save-parent-crash-recovery");
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  const baseline = fs.readFileSync(abs);
  const preload = path.join(suiteHome, `parent-claim-crash-${Date.now()}.cjs`);
  fs.writeFileSync(preload, String.raw`
const childProcess = require("node:child_process");
const originalExecFileSync = childProcess.execFileSync;
childProcess.execFileSync = function(file, args, options) {
  const input = String(options && options.input || "");
  const result = originalExecFileSync.apply(this, arguments);
  if (String(file) === process.execPath && input.includes('"kind":"claim-file"')) process.exit(97);
  return result;
};
`, "utf8");
  const moduleUrl = new URL("../src/context_room.mjs", import.meta.url).href;
  const source = `import { writeMemoryFile } from ${JSON.stringify(moduleUrl)}; writeMemoryFile(process.env.CR_ROOT, ${JSON.stringify(relPath)}, "# replacement that must not hide baseline\\n");`;
  assert.throws(
    () => execFileSync(process.execPath, ["--input-type=module", "-e", source], {
      env: {
        ...process.env,
        CR_ROOT: root,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${preload}`].filter(Boolean).join(" "),
      },
      stdio: ["ignore", "pipe", "pipe"],
    }),
    (error) => error?.status === 97,
  );
  assert.equal(fs.existsSync(abs), false);
  assert.equal(fs.readdirSync(path.dirname(abs)).some((name) => name.startsWith(".context-room-delete-")), true);
  const journals = path.join(root, ".context-room", "file-transactions");
  assert.equal(fs.readdirSync(journals).some((name) => name.endsWith(".json")), true);

  createMemoryServer({ root });
  assert.deepEqual(fs.readFileSync(abs), baseline);
  assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
  assert.deepEqual(fs.readdirSync(journals).filter((name) => name.endsWith(".json")), []);
});

test("startup recovers an interrupted save when its PID now belongs to another process generation", (t) => {
  const processIdentity = filesystemProcessIdentity(process.pid);
  if (!processIdentity) {
    t.skip("This platform does not expose a stable process-generation identity");
    return;
  }
  const root = makeProject("ordinary-save-pid-reuse-recovery");
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  const baseline = fs.readFileSync(abs);
  interruptOrdinarySaveAfterClaim(root, relPath);
  assert.equal(fs.existsSync(abs), false);

  const journalPath = pendingFileMutationJournal(root);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  assert.equal(journal.version, 2);
  fs.writeFileSync(journalPath, JSON.stringify({
    ...journal,
    ownerPid: process.pid,
    ownerProcessIdentity: `${processIdentity}:reused`,
  }) + "\n", { mode: 0o600 });

  createMemoryServer({ root });
  assert.deepEqual(fs.readFileSync(abs), baseline);
  assert.equal(fs.existsSync(journalPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
});

test("startup gives legacy PID-only journals a bounded grace instead of trusting PID 1 forever", () => {
  const root = makeProject("ordinary-save-legacy-pid1-recovery");
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  const baseline = fs.readFileSync(abs);
  interruptOrdinarySaveAfterClaim(root, relPath);
  assert.equal(fs.existsSync(abs), false);

  const journalPath = pendingFileMutationJournal(root);
  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  const legacy = { ...journal, version: 1, ownerPid: 1, createdAt: "2000-01-01T00:00:00.000Z" };
  delete legacy.ownerProcessIdentity;
  fs.writeFileSync(journalPath, JSON.stringify(legacy) + "\n", { mode: 0o600 });
  fs.utimesSync(journalPath, new Date("2000-01-01T00:00:00.000Z"), new Date("2000-01-01T00:00:00.000Z"));

  createMemoryServer({ root });
  assert.deepEqual(fs.readFileSync(abs), baseline);
  assert.equal(fs.existsSync(journalPath), false);
  assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
});

test("ordinary save restores its claimed file when backup creation fails", async (t) => {
  const root = makeProject("ordinary-save-backup-failure");
  const room = await startRoom(t, root);
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  const original = fs.readFileSync(abs);
  const viewed = await (await fetch(room.origin + "/api/file?path=" + encodeURIComponent(relPath))).json();
  const backupsRoot = path.join(root, ".context-room", "memory-webapp-backups");
  fs.writeFileSync(backupsRoot, "not a directory", "utf8");
  const response = await fetch(room.origin + "/api/file", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: relPath, content: "# replacement\n", expectedContentHash: viewed.contentHash }),
  });
  assert.equal(response.status, 500, await response.text());
  assert.deepEqual(fs.readFileSync(abs), original);
  assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
});

test("save claims the expected file before installing new content", async (t) => {
  const root = makeProject("save-boundary-claim");
  const room = await startRoom(t, root);
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  const viewed = await (await fetch(room.origin + "/api/file?path=" + encodeURIComponent(relPath))).json();
  const writer = await startPreopenedFdWriter(t, abs, "# Concurrent save\n", "save-fd-writer");
  await withAnchoredChildPreload("save-fd-open", signalBeforeExclusiveOpenPreload, {
    CR_TARGET_PREFIX: ".context-room-file-",
    CR_SIGNAL: writer.signal,
    CR_DONE: writer.done,
  }, async () => {
    const response = await fetch(room.origin + "/api/file", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({ path: relPath, content: "# Client save\n", expectedContentHash: viewed.contentHash }),
    });
    assert.equal(response.status, 409, await response.text());
  });
  const [writerCode] = await writer.exited;
  assert.equal(writerCode, 0);
  assert.equal(fs.readFileSync(abs, "utf8"), "# Concurrent save\n");
  assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
});

test("revert claims an untracked file before deleting it", async () => {
  const root = makeProject("revert-boundary-claim");
  const relPath = "docs/UNTRACKED.md";
  const abs = path.join(root, relPath);
  fs.writeFileSync(abs, "# Viewed revision\n", "utf8");
  const revision = readFileDiff(root, relPath).revision;
  const atomicEditorBeforeClaimPreload = String.raw`
const fs = require("node:fs");
const originalRename = fs.renameSync;
let fired = false;
fs.renameSync = function(source, target) {
  if (!fired && String(source) === "UNTRACKED.md" && String(target).startsWith(".context-room-delete-")) {
    fired = true;
    fs.writeFileSync(".editor-B.tmp", "# Concurrent revision\n", "utf8");
    originalRename.call(this, ".editor-B.tmp", source);
  }
  return originalRename.apply(this, arguments);
};
`;
  await withAnchoredChildPreload("revert-untracked-atomic-editor", atomicEditorBeforeClaimPreload, {}, async () => {
    assert.throws(
      () => revertMemoryFile(root, relPath, { expectedRevision: revision }),
      (error) => error?.code === "file_revision_conflict",
    );
  });
  assert.equal(fs.readFileSync(abs, "utf8"), "# Concurrent revision\n");
  assert.deepEqual(fs.readdirSync(path.dirname(abs)).filter((name) => name.startsWith(".context-room-delete-")), []);
});

test("delete revalidates the pinned project root immediately before claiming files", () => {
  const root = makeProject("delete-root-swap");
  const relPath = "docs/DELETE.md";
  const original = fs.readFileSync(path.join(root, relPath));
  const { outcome, replacementRoot } = runRootSwapHttpMutation(root, {
    pathname: "/api/files/delete",
    previewDeletePaths: [relPath],
  });
  const body = JSON.parse(outcome.text);
  assert.equal(outcome.status, 409, outcome.text);
  assert.equal(body.code, "managed_context_room_state_unsafe");
  assert.deepEqual(fs.readFileSync(path.join(root, relPath)), original);
  assert.deepEqual(fs.readFileSync(path.join(replacementRoot, relPath)), original);
});

test("ordinary save revalidates the pinned project root before publishing content", () => {
  const root = makeProject("save-root-swap");
  const relPath = "docs/README.md";
  const original = fs.readFileSync(path.join(root, relPath));
  const viewed = readMemoryFile(root, relPath, { readOnly: true });
  const { outcome, replacementRoot } = runRootSwapHttpMutation(root, {
    pathname: "/api/file",
    body: { path: relPath, content: "# replacement must not publish\n", expectedContentHash: viewed.contentHash },
  });
  const body = JSON.parse(outcome.text);
  assert.equal(outcome.status, 409, outcome.text);
  assert.equal(body.code, "managed_context_room_state_unsafe");
  assert.deepEqual(fs.readFileSync(path.join(root, relPath)), original);
  assert.deepEqual(fs.readFileSync(path.join(replacementRoot, relPath)), original);
});

test("template application revalidates the pinned project root before publishing content", () => {
  const root = makeProject("template-root-swap");
  const relPath = "docs/EMPTY.md";
  fs.writeFileSync(path.join(root, relPath), "", "utf8");
  const { outcome, replacementRoot } = runRootSwapHttpMutation(root, {
    pathname: "/api/markdown/apply-template",
    body: { path: relPath, title: "Must not publish", templateId: "context-golden" },
  });
  const body = JSON.parse(outcome.text);
  assert.equal(outcome.status, 409, outcome.text);
  assert.equal(body.code, "managed_context_room_state_unsafe");
  assert.equal(fs.readFileSync(path.join(root, relPath), "utf8"), "");
  assert.equal(fs.readFileSync(path.join(replacementRoot, relPath), "utf8"), "");
});

test("revert revalidates the pinned project root immediately before its claim", () => {
  const root = makeProject("revert-root-swap");
  const relPath = "docs/README.md";
  const changed = "# changed bytes that must survive a root swap\n";
  fs.writeFileSync(path.join(root, relPath), changed, "utf8");
  const expectedRevision = readFileDiff(root, relPath).revision;
  const { outcome, replacementRoot } = runRootSwapHttpMutation(root, {
    pathname: "/api/file/revert",
    body: { path: relPath, expectedRevision },
  });
  const body = JSON.parse(outcome.text);
  assert.equal(outcome.status, 409, outcome.text);
  assert.equal(body.code, "managed_context_room_state_unsafe");
  assert.equal(fs.readFileSync(path.join(root, relPath), "utf8"), changed);
  assert.equal(fs.readFileSync(path.join(replacementRoot, relPath), "utf8"), changed);
});

test("review revalidates the pinned project root before publishing control state", () => {
  const root = makeProject("review-root-swap");
  const before = reviewControlTreeSnapshot(root);
  const { outcome, replacementRoot } = runRootSwapHttpMutation(root, {
    pathname: "/api/docqa/review-baseline",
    body: { path: "docs/README.md", note: "must not reach a replacement root" },
  });
  const body = JSON.parse(outcome.text);
  assert.equal(outcome.status, 409, outcome.text);
  assert.equal(body.code, "managed_context_room_state_unsafe");
  assert.deepEqual(reviewControlTreeSnapshot(root), before);
  assert.deepEqual(reviewControlTreeSnapshot(replacementRoot), before);
});

test("folder creation never follows a parent swapped to an external symlink", async (t) => {
  const root = makeProject("folder-mkdir-parent-swap");
  const room = await startRoom(t, root);
  const parent = path.join(root, "docs");
  const movedParent = path.join(root, "docs-held");
  const outside = path.join(suiteHome, "folder-mkdir-parent-swap-outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside folder sentinel\n", "utf8");

  await withParentDirectorySwap("folder-mkdir-parent-swap", {
    parent,
    movedParent,
    outside,
    targetName: "new-parent",
  }, async () => {
    const response = await fetch(room.origin + "/api/folder/create", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({ path: "docs/new-parent/deep" }),
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "managed_context_room_state_unsafe");
    assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
    assert.equal(fs.existsSync(path.join(movedParent, "new-parent")), false);
  });
});

test("markdown creation never follows a parent swapped to an external symlink", async (t) => {
  const root = makeProject("markdown-mkdir-parent-swap");
  const room = await startRoom(t, root);
  const parent = path.join(root, "docs");
  const movedParent = path.join(root, "docs-held");
  const outside = path.join(suiteHome, "markdown-mkdir-parent-swap-outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside markdown sentinel\n", "utf8");

  await withParentDirectorySwap("markdown-mkdir-parent-swap", {
    parent,
    movedParent,
    outside,
    targetName: "new-parent",
  }, async () => {
    const response = await fetch(room.origin + "/api/markdown/create", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({ path: "docs/new-parent/deep/note.md", title: "No escape", applyTemplate: false }),
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "managed_context_room_state_unsafe");
    assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
    assert.equal(fs.existsSync(path.join(movedParent, "new-parent")), false);
  });
});

test("revert parent creation never follows a swapped directory symlink", async (t) => {
  const root = makeProject("revert-mkdir-parent-swap");
  const settings = readMemoryWebappSettings(root);
  writeMemoryWebappSettings(root, {
    ...settings,
    allowedPaths: [...settings.allowedPaths, "current/"],
    watchAllow: [...settings.watchAllow, "current/"],
  });
  const trackedPath = "docs/archive/GUIDE.md";
  fs.mkdirSync(path.join(root, "docs", "archive"));
  fs.writeFileSync(path.join(root, trackedPath), "# Tracked guide\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Add nested guide"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "current"));
  execFileSync("git", ["mv", trackedPath, "current/GUIDE.md"], { cwd: root, stdio: "ignore" });
  fs.rmdirSync(path.join(root, "docs", "archive"));
  const currentPath = "current/GUIDE.md";
  const diff = readFileDiff(root, currentPath);
  assert.equal(diff.oldPath, trackedPath);
  const room = await startRoom(t, root);
  const parent = path.join(root, "docs");
  const movedParent = path.join(root, "docs-held");
  const outside = path.join(suiteHome, "revert-mkdir-parent-swap-outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "sentinel.txt"), "outside revert sentinel\n", "utf8");

  await withParentDirectorySwap("revert-mkdir-parent-swap", {
    parent,
    movedParent,
    outside,
    targetName: "archive",
  }, async () => {
    const response = await fetch(room.origin + "/api/file/revert", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({ path: currentPath, expectedRevision: diff.revision }),
    });
    const body = await response.json();
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal(body.code, "managed_context_room_state_unsafe");
    assert.deepEqual(fs.readdirSync(outside), ["sentinel.txt"]);
    assert.equal(fs.existsSync(path.join(movedParent, "archive")), false);
    assert.equal(fs.readFileSync(path.join(root, currentPath), "utf8"), "# Tracked guide\n");
  });
});

test("HTTP revert restores the approved old path of a Git rename", async (t) => {
  const root = makeProject("revert-git-rename");
  const room = await startRoom(t, root);
  execFileSync("git", ["mv", "docs/README.md", "docs/RENAMED.md"], { cwd: root });
  const diff = await (await fetch(room.origin + "/api/file/diff?path=docs%2FRENAMED.md")).json();
  assert.equal(diff.oldPath, "docs/README.md", JSON.stringify(diff));

  const response = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: "docs/RENAMED.md", expectedRevision: diff.revision }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.readFileSync(path.join(root, "docs", "README.md"), "utf8"), "# revert-git-rename\n");
  assert.equal(fs.existsSync(path.join(root, "docs", "RENAMED.md")), false);
  assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).trim(), "");
});

test("HTTP revert recreates a removed source parent for a cross-directory Git rename", async (t) => {
  const root = makeProject("revert-git-rename-missing-parent");
  const settings = readMemoryWebappSettings(root);
  writeMemoryWebappSettings(root, {
    ...settings,
    allowedPaths: [...settings.allowedPaths, "archive/"],
    watchAllow: [...settings.watchAllow, "archive/"],
  });
  const room = await startRoom(t, root);
  fs.unlinkSync(path.join(root, "docs", "DELETE.md"));
  execFileSync("git", ["add", "--", "docs/DELETE.md"], { cwd: root });
  execFileSync("git", ["commit", "-m", "Remove auxiliary fixture"], { cwd: root, stdio: "ignore" });
  fs.mkdirSync(path.join(root, "archive"));
  execFileSync("git", ["mv", "docs/README.md", "archive/README.md"], { cwd: root });
  fs.rmdirSync(path.join(root, "docs"));
  const diff = readFileDiff(root, "archive/README.md");
  assert.equal(diff.oldPath, "docs/README.md", JSON.stringify(diff));

  const response = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: "archive/README.md", expectedRevision: diff.revision }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.readFileSync(path.join(root, "docs", "README.md"), "utf8"), "# revert-git-rename-missing-parent\n");
  assert.equal(fs.existsSync(path.join(root, "archive", "README.md")), false);
  assert.deepEqual(fs.readdirSync(path.join(root, "archive")).filter((name) => name.startsWith(".context-room-")), []);
});

test("Git diff and revert treat exact pathspec metacharacters literally", async (t) => {
  const root = makeProject("literal-git-pathspecs");
  const room = await startRoom(t, root);
  const target = "docs/[a].md";
  const sibling = "docs/a.md";
  fs.writeFileSync(path.join(root, target), "# Literal original\n", "utf8");
  fs.writeFileSync(path.join(root, sibling), "# Sibling original\n", "utf8");
  execFileSync("git", ["add", "--", target, sibling], { cwd: root });
  execFileSync("git", ["commit", "-m", "Add literal pathspec fixtures"], { cwd: root, stdio: "ignore" });
  fs.writeFileSync(path.join(root, sibling), "# Sibling staged\n", "utf8");
  execFileSync("git", ["add", "--", sibling], { cwd: root });
  const siblingIndex = execFileSync("git", ["show", `:${sibling}`], { cwd: root });
  fs.writeFileSync(path.join(root, sibling), "# Sibling worktree\n", "utf8");
  fs.writeFileSync(path.join(root, target), "# Literal changed\n", "utf8");

  const diff = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(target))).json();
  assert.equal(diff.changed, true);
  assert.equal(diff.patch.includes("docs/a.md"), false, diff.patch);
  const response = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: target, expectedRevision: diff.revision }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.readFileSync(path.join(root, target), "utf8"), "# Literal original\n");
  assert.deepEqual(execFileSync("git", ["show", `:${sibling}`], { cwd: root }), siblingIndex);
  assert.equal(fs.readFileSync(path.join(root, sibling), "utf8"), "# Sibling worktree\n");
});

test("Git porcelain keeps Unicode and arrow-like rename paths byte exact", async (t) => {
  const root = makeProject("unicode-git-rename");
  const room = await startRoom(t, root);
  const oldPath = "docs/café -> ancien.md";
  const newPath = "docs/雪 -> nouveau.md";
  fs.writeFileSync(path.join(root, oldPath), "# Unicode path\n", "utf8");
  execFileSync("git", ["add", "--", oldPath], { cwd: root });
  execFileSync("git", ["commit", "-m", "Add Unicode path"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["mv", oldPath, newPath], { cwd: root });
  const diff = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(newPath))).json();
  assert.equal(diff.oldPath, oldPath);
  const response = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: newPath, expectedRevision: diff.revision }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.readFileSync(path.join(root, oldPath), "utf8"), "# Unicode path\n");
  assert.equal(fs.existsSync(path.join(root, newPath)), false);
});

test("a stale revert revision cannot clobber a newer staged blob", async (t) => {
  const root = makeProject("revert-index-revision-cas");
  const room = await startRoom(t, root);
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  fs.writeFileSync(abs, "# Staged B\n", "utf8");
  execFileSync("git", ["add", "--", relPath], { cwd: root });
  fs.writeFileSync(abs, "# Worktree C\n", "utf8");
  const stale = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(relPath))).json();
  fs.writeFileSync(abs, "# Staged D\n", "utf8");
  execFileSync("git", ["add", "--", relPath], { cwd: root });
  const stagedD = execFileSync("git", ["show", `:${relPath}`], { cwd: root });
  fs.writeFileSync(abs, "# Worktree C\n", "utf8");
  const current = readFileDiff(root, relPath);
  assert.notEqual(current.revision, stale.revision);

  const response = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: relPath, expectedRevision: stale.revision }),
  });
  assert.equal(response.status, 409, await response.text());
  assert.deepEqual(execFileSync("git", ["show", `:${relPath}`], { cwd: root }), stagedD);
  assert.equal(fs.readFileSync(abs, "utf8"), "# Worktree C\n");
});

test("Git revert restores the exact index when a post-publish HEAD check fails", async (t) => {
  const root = makeProject("revert-index-rollback");
  const room = await startRoom(t, root);
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  fs.writeFileSync(abs, "# Staged B\n", "utf8");
  execFileSync("git", ["add", "--", relPath], { cwd: root });
  const stagedB = execFileSync("git", ["show", `:${relPath}`], { cwd: root });
  fs.writeFileSync(abs, "# Worktree C\n", "utf8");
  const diff = await (await fetch(room.origin + "/api/file/diff?path=" + encodeURIComponent(relPath))).json();
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperDir = path.join(suiteHome, "git-post-publish-wrapper");
  const marker = path.join(wrapperDir, "reset.marker");
  const count = path.join(wrapperDir, "head.count");
  fs.mkdirSync(wrapperDir, { recursive: true });
  const wrapper = path.join(wrapperDir, "git");
  fs.writeFileSync(wrapper, `#!/bin/sh
if [ "$1" = "reset" ] && [ -n "$GIT_INDEX_FILE" ]; then
  "$CR_REAL_GIT" "$@"
  code=$?
  if [ "$code" -eq 0 ]; then : > "$CR_GIT_MARKER"; printf '0' > "$CR_GIT_COUNT"; fi
  exit "$code"
fi
if [ -f "$CR_GIT_MARKER" ] && [ "$1" = "rev-parse" ] && [ "$2" = "HEAD" ]; then
  value=$(/bin/cat "$CR_GIT_COUNT" 2>/dev/null || printf '0')
  value=$((value + 1))
  printf '%s' "$value" > "$CR_GIT_COUNT"
  if [ "$value" -eq 4 ]; then exit 42; fi
fi
exec "$CR_REAL_GIT" "$@"
`, { mode: 0o755 });
  const previous = {
    PATH: process.env.PATH,
    CR_REAL_GIT: process.env.CR_REAL_GIT,
    CR_GIT_MARKER: process.env.CR_GIT_MARKER,
    CR_GIT_COUNT: process.env.CR_GIT_COUNT,
  };
  process.env.PATH = `${wrapperDir}${path.delimiter}${process.env.PATH || ""}`;
  process.env.CR_REAL_GIT = realGit;
  process.env.CR_GIT_MARKER = marker;
  process.env.CR_GIT_COUNT = count;
  try {
    const response = await fetch(room.origin + "/api/file/revert", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({ path: relPath, expectedRevision: diff.revision }),
    });
    assert.equal(response.status, 500, await response.text());
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  assert.deepEqual(execFileSync("git", ["show", `:${relPath}`], { cwd: root }), stagedB);
  assert.equal(fs.readFileSync(abs, "utf8"), "# Worktree C\n");
});

test("verified review becomes fail-closed when staged content differs from the reviewed worktree", () => {
  const root = makeProject("review-index-binding");
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  fs.writeFileSync(abs, "# Staged B\n", "utf8");
  execFileSync("git", ["add", "--", relPath], { cwd: root });
  fs.writeFileSync(abs, "# Reviewed C\n", "utf8");
  assert.throws(
    () => writeDocReviewDecision(root, relPath, { status: "verified", note: "reviewed C" }),
    (error) => error?.code === "review_index_mismatch" && error?.statusCode === 409,
  );
  execFileSync("git", ["add", "--", relPath], { cwd: root });
  const verified = writeDocReviewDecision(root, relPath, { status: "verified", note: "reviewed C" });
  assert.equal(verified.status, "verified");
  fs.writeFileSync(abs, "# Staged D\n", "utf8");
  execFileSync("git", ["add", "--", relPath], { cwd: root });
  fs.writeFileSync(abs, "# Reviewed C\n", "utf8");
  const report = buildContextRoomReports(root);
  assert.equal(report.docqa.queue.some((item) => item.path === relPath), true);
});

test("verified review rejects an invalid UTF-8 staged blob that decodes like the reviewed worktree", () => {
  const root = makeProject("review-index-invalid-utf8");
  const relPath = "docs/README.md";
  const abs = path.join(root, relPath);
  fs.writeFileSync(abs, Buffer.from([0xff]));
  execFileSync("git", ["add", "--", relPath], { cwd: root });
  fs.writeFileSync(abs, "\ufffd", "utf8");
  assert.throws(
    () => writeDocReviewDecision(root, relPath, { status: "verified", note: "must bind exact staged bytes" }),
    (error) => error?.code === "git_index_unavailable" && error?.statusCode === 503,
  );
});

test("Git status output overflow and broken HEAD fail closed", () => {
  const root = makeProject("git-status-fail-closed");
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  const wrapperDir = path.join(suiteHome, "git-status-overflow-wrapper");
  fs.mkdirSync(wrapperDir, { recursive: true });
  const wrapper = path.join(wrapperDir, "git");
  fs.writeFileSync(wrapper, `#!/bin/sh
for arg in "$@"; do
  if [ "$arg" = "status" ]; then /usr/bin/yes x | /usr/bin/head -c 34603008; exit 0; fi
done
exec "$CR_REAL_GIT" "$@"
`, { mode: 0o755 });
  const previousPath = process.env.PATH;
  const previousRealGit = process.env.CR_REAL_GIT;
  process.env.PATH = `${wrapperDir}${path.delimiter}${process.env.PATH || ""}`;
  process.env.CR_REAL_GIT = realGit;
  try {
    assert.throws(() => buildContextRoomReports(root), (error) => error?.code === "git_status_unavailable" && error?.statusCode === 503);
  } finally {
    process.env.PATH = previousPath;
    if (previousRealGit === undefined) delete process.env.CR_REAL_GIT;
    else process.env.CR_REAL_GIT = previousRealGit;
  }

  const headRef = execFileSync("git", ["symbolic-ref", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
  const refPath = path.join(root, ".git", ...headRef.split("/"));
  fs.writeFileSync(refPath, "0000000000000000000000000000000000000000\n", "utf8");
  assert.throws(
    () => buildContextRoomReports(root),
    (error) => ["git_status_unavailable", "git_index_unavailable"].includes(error?.code),
  );
});

test("HTTP revert restores an inferred unstaged Git rename", async (t) => {
  const root = makeProject("revert-inferred-git-rename");
  const room = await startRoom(t, root);
  fs.renameSync(path.join(root, "docs", "README.md"), path.join(root, "docs", "RENAMED.md"));
  const diff = await (await fetch(room.origin + "/api/file/diff?path=docs%2FRENAMED.md")).json();
  assert.equal(diff.oldPath, "docs/README.md");

  const response = await fetch(room.origin + "/api/file/revert", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ path: "docs/RENAMED.md", expectedRevision: diff.revision }),
  });
  assert.equal(response.status, 200, await response.text());
  assert.equal(fs.readFileSync(path.join(root, "docs", "README.md"), "utf8"), "# revert-inferred-git-rename\n");
  assert.equal(fs.existsSync(path.join(root, "docs", "RENAMED.md")), false);
  assert.equal(execFileSync("git", ["status", "--porcelain=v1"], { cwd: root, encoding: "utf8" }).trim(), "");
});

test("external revert restores the reviewed mode as well as content", () => {
  const previousHome = process.env.HOME;
  const home = path.join(suiteHome, "external-mode-home");
  process.env.HOME = home;
  try {
    const root = path.join(home, "project");
    const externalDir = path.join(home, "shared");
    const abs = path.join(externalDir, "guide.md");
    fs.mkdirSync(root, { recursive: true });
    fs.mkdirSync(externalDir, { recursive: true });
    fs.writeFileSync(abs, "# Reviewed baseline\n", "utf8");
    fs.chmodSync(abs, 0o644);
    initializeContextRoomProject(root, { allowedPaths: ["~/shared/guide.md"], watchAllow: ["~/shared/guide.md"] });
    writeDocReviewBaseline(root, "~/shared/guide.md", { note: "approved external baseline" });
    fs.writeFileSync(abs, "# Changed\n", "utf8");
    fs.chmodSync(abs, 0o755);
    const diff = readFileDiff(root, "~/shared/guide.md");
    revertMemoryFile(root, "~/shared/guide.md", { expectedRevision: diff.revision });
    assert.equal(fs.readFileSync(abs, "utf8"), "# Reviewed baseline\n");
    assert.equal(fs.statSync(abs).mode & 0o777, 0o644);
  } finally {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
  }
});

test("revert does not install approved content through a swapped parent symlink", async (t) => {
  const root = makeProject("revert-parent-swap");
  const room = await startRoom(t, root);
  const docs = path.join(root, "docs");
  const movedDocs = path.join(root, "docs-old");
  const outside = path.join(suiteHome, "revert-parent-swap-outside");
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, "README.md"), "# Outside revert sentinel\n", "utf8");
  fs.writeFileSync(path.join(docs, "README.md"), "# Modified before revert\n", "utf8");
  const diff = await (await fetch(room.origin + "/api/file/diff?path=docs%2FREADME.md")).json();
  const oncePath = path.join(suiteHome, "revert-parent-swap.once");
  const swapAtInstallPreload = String.raw`
const fs = require("node:fs");
const originalOpen = fs.openSync;
fs.openSync = function(filePath, flags, ...rest) {
  if (String(filePath).startsWith(".context-room-file-") && (Number(flags) & fs.constants.O_EXCL) && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    fs.renameSync(process.env.CR_PARENT, process.env.CR_MOVED);
    fs.symlinkSync(process.env.CR_OUTSIDE, process.env.CR_PARENT);
  }
  return originalOpen.call(this, filePath, flags, ...rest);
};
`;
  await withAnchoredChildPreload("revert-parent-swap", swapAtInstallPreload, {
    CR_ONCE: oncePath,
    CR_PARENT: docs,
    CR_MOVED: movedDocs,
    CR_OUTSIDE: outside,
  }, async () => {
    const response = await fetch(room.origin + "/api/file/revert", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({ path: "docs/README.md", expectedRevision: diff.revision }),
    });
    assert.equal(response.status, 409, await response.text());
  });
  assert.equal(fs.readFileSync(path.join(outside, "README.md"), "utf8"), "# Outside revert sentinel\n");
  assert.equal(fs.readFileSync(path.join(movedDocs, "README.md"), "utf8"), "# Modified before revert\n");
  assert.deepEqual(fs.readdirSync(movedDocs).filter((name) => name.startsWith(".context-room-delete-")), []);
  fs.unlinkSync(docs);
  fs.renameSync(movedDocs, docs);
});

test("folder pruning never removes a directory reached through a swapped parent symlink", async (t) => {
  const root = makeProject("prune-parent-swap");
  const room = await startRoom(t, root);
  const target = path.join(root, "docs", "target");
  const movedDocs = path.join(root, "docs-old");
  const outside = path.join(suiteHome, "prune-parent-swap-outside");
  fs.mkdirSync(target, { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(target, "only.md"), "# Delete\n", "utf8");
  const manifest = await deletionManifest(room.origin, ownerHeaders(room), ["docs/target/"]);
  const oncePath = path.join(suiteHome, "prune-parent-swap.once");
  const swapAtRmdirPreload = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const originalRmdir = fs.rmdirSync;
fs.rmdirSync = function(dirPath) {
  if (String(dirPath).startsWith(".context-room-delete-") && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    fs.mkdirSync(path.join(process.env.CR_OUTSIDE, String(dirPath)));
    fs.renameSync(process.env.CR_PARENT, process.env.CR_MOVED);
    fs.symlinkSync(process.env.CR_OUTSIDE, process.env.CR_PARENT);
  }
  return originalRmdir.apply(this, arguments);
};
`;
  await withAnchoredChildPreload("prune-parent-swap", swapAtRmdirPreload, {
    CR_ONCE: oncePath,
    CR_PARENT: path.join(root, "docs"),
    CR_MOVED: movedDocs,
    CR_OUTSIDE: outside,
  }, async () => {
    const response = await fetch(room.origin + "/api/files/delete", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify(manifest),
    });
    assert.equal(response.status, 409, await response.text());
  });
  assert.equal(fs.existsSync(outside), true);
  const outsideStages = fs.readdirSync(outside).filter((name) => name.startsWith(".context-room-delete-"));
  assert.equal(outsideStages.length, 1);
  assert.equal(fs.statSync(path.join(outside, outsideStages[0])).isDirectory(), true);
  assert.equal(fs.readFileSync(path.join(movedDocs, "target", "only.md"), "utf8"), "# Delete\n");
  assert.deepEqual(fs.readdirSync(movedDocs).filter((name) => name.startsWith(".context-room-delete-")), []);
  fs.unlinkSync(path.join(root, "docs"));
  fs.renameSync(movedDocs, path.join(root, "docs"));
});

test("Hermes deletion preview is a pure snapshot and never reconciles Markdown sources", async (t) => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "hermes-delete-preview-pure-home");
  process.env.HERMES_HOME = hermesHome;
  try {
    const cronDir = path.join(hermesHome, "cron");
    const storePath = path.join(cronDir, "jobs.json");
    const sourcePath = path.join(cronDir, "jobs-md", "preview-only.md");
    fs.mkdirSync(cronDir, { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      jobs: [{ id: "preview-only", name: "Preview only", prompt: "do not materialize", schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true }],
    }, null, 2) + "\n", "utf8");
    const storeBefore = fs.readFileSync(storePath);
    const root = makeProject("hermes-delete-preview-pure");
    const settings = readMemoryWebappSettings(root);
    writeMemoryWebappSettings(root, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    const room = await startRoom(t, root);

    const response = await fetch(room.origin + "/api/files/delete-preview", {
      method: "POST",
      headers: ownerHeaders(room),
      body: JSON.stringify({ paths: ["~/.hermes/cron/jobs/preview-only.json"] }),
    });
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual(fs.readFileSync(storePath), storeBefore);
    assert.equal(fs.existsSync(sourcePath), false);
    assert.equal(fs.existsSync(path.dirname(sourcePath)), false);
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

test("raw Hermes cron save never backs up bytes through a swapped source symlink", async (t) => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "hermes-cron-backup-symlink-home");
  process.env.HERMES_HOME = hermesHome;
  try {
    const cronDir = path.join(hermesHome, "cron");
    const storePath = path.join(cronDir, "jobs.json");
    const originalPath = path.join(cronDir, "jobs.original.json");
    const outsideSecret = path.join(suiteHome, "hermes-cron-backup-outside-secret.json");
    const sentinel = path.join(suiteHome, "hermes-cron-backup-symlink.once");
    fs.mkdirSync(cronDir, { recursive: true });
    const baseline = JSON.stringify({ jobs: [{ id: "backup-safe", name: "Baseline", prompt: "safe", enabled: true }] }, null, 2) + "\n";
    const secret = '{"private":"must never enter a managed backup"}\n';
    fs.writeFileSync(storePath, baseline, "utf8");
    fs.writeFileSync(outsideSecret, secret, "utf8");

    const root = makeProject("cron-backup-source-symlink");
    const settings = readMemoryWebappSettings(root);
    writeMemoryWebappSettings(root, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    const room = await startRoom(t, root);
    const viewedResponse = await fetch(room.origin + "/api/file?path=" + encodeURIComponent("~/.hermes/cron/jobs.json"));
    const viewed = await viewedResponse.json();
    assert.equal(viewedResponse.status, 200, JSON.stringify(viewed));
    const next = JSON.parse(viewed.content);
    next.jobs[0].name = "Client update";

    const swapBeforeAnchoredBackupRead = String.raw`
const fs = require("node:fs");
const originalOpenSync = fs.openSync;
fs.openSync = function(filePath, flags) {
  if (!fs.existsSync(process.env.CR_ONCE)
    && String(filePath) === "jobs.json"
    && process.cwd() === process.env.CR_CRON_DIR
    && (Number(flags) & (fs.constants.O_WRONLY | fs.constants.O_RDWR)) === 0) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    fs.renameSync(process.env.CR_STORE, process.env.CR_ORIGINAL);
    fs.symlinkSync(process.env.CR_SECRET, process.env.CR_STORE);
  }
  return originalOpenSync.apply(this, arguments);
};
`;
    let mutationBody = null;
    await withAnchoredChildPreload("cron-backup-source-symlink", swapBeforeAnchoredBackupRead, {
      CR_ONCE: sentinel,
      CR_CRON_DIR: fs.realpathSync(cronDir),
      CR_STORE: storePath,
      CR_ORIGINAL: originalPath,
      CR_SECRET: outsideSecret,
    }, async () => {
      const response = await fetch(room.origin + "/api/file", {
        method: "POST",
        headers: ownerHeaders(room),
        body: JSON.stringify({
          path: "~/.hermes/cron/jobs.json",
          content: JSON.stringify(next, null, 2) + "\n",
          expectedContentHash: viewed.contentHash,
        }),
      });
      const body = await response.json();
      mutationBody = body;
      assert.equal(response.status, 409, JSON.stringify(body));
      assert.equal(body.code, "file_revision_conflict");
    });

    assert.equal(fs.existsSync(sentinel), true, JSON.stringify(mutationBody));
    assert.equal(fs.lstatSync(storePath).isSymbolicLink(), true);
    assert.equal(fs.readlinkSync(storePath), outsideSecret);
    assert.equal(fs.readFileSync(outsideSecret, "utf8"), secret);
    assert.equal(fs.readFileSync(originalPath, "utf8"), baseline);
    const backupsRoot = path.join(root, ".context-room", "memory-webapp-backups");
    const backupFiles = fs.existsSync(backupsRoot)
      ? fs.readdirSync(backupsRoot, { recursive: true }).map(String)
        .map((name) => path.join(backupsRoot, name))
        .filter((file) => fs.lstatSync(file).isFile())
      : [];
    assert.equal(backupFiles.some((file) => fs.readFileSync(file).includes(Buffer.from(secret))), false);
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

test("Hermes cron views require integration authority and delete JSON plus source atomically", async (t) => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "hermes-cron-home");
  process.env.HERMES_HOME = hermesHome;
  try {
    const cronDir = path.join(hermesHome, "cron");
    const sourceDir = path.join(cronDir, "jobs-md");
    const storePath = path.join(cronDir, "jobs.json");
    const sourcePath = path.join(sourceDir, "job-1.md");
    fs.mkdirSync(sourceDir, { recursive: true });
    const initialStore = { jobs: [{ id: "job-1", name: "Job 1", prompt: "hello", schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true }] };
    fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2) + "\n", "utf8");
    fs.writeFileSync(sourcePath, "---\nname: Job 1\nschedule: 0 9 * * *\nenabled: true\n---\n\nhello\n", "utf8");

    const disabledRoot = makeProject("cron-disabled");
    const disabledRoom = await startRoom(t, disabledRoot);
    const virtualPath = "~/.hermes/cron/jobs/job-1.json";
    const deniedRead = await fetch(disabledRoom.origin + "/api/file?path=" + encodeURIComponent(virtualPath));
    assert.equal(deniedRead.status, 403);
    const deniedWrite = await fetch(disabledRoom.origin + "/api/file", {
      method: "POST",
      headers: ownerHeaders(disabledRoom),
      body: JSON.stringify({ path: virtualPath, content: "{}", expectedContentHash: "irrelevant" }),
    });
    assert.equal(deniedWrite.status, 403);
    const deniedDelete = await fetch(disabledRoom.origin + "/api/files/delete-preview", {
      method: "POST",
      headers: ownerHeaders(disabledRoom),
      body: JSON.stringify({ paths: [virtualPath] }),
    });
    assert.equal(deniedDelete.status, 400);

    const enabledRoot = makeProject("cron-enabled");
    const settings = readMemoryWebappSettings(enabledRoot);
    writeMemoryWebappSettings(enabledRoot, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    const enabledRoom = await startRoom(t, enabledRoot);
    assert.equal((await fetch(enabledRoom.origin + "/api/files")).status, 200);
    const storeAfterFirstSync = fs.readFileSync(storePath);
    assert.equal((await fetch(enabledRoom.origin + "/api/files")).status, 200);
    assert.deepEqual(fs.readFileSync(storePath), storeAfterFirstSync);
    const viewedJob = await (await fetch(enabledRoom.origin + "/api/file?path=" + encodeURIComponent(virtualPath))).json();
    const clientJob = { ...JSON.parse(viewedJob.content), name: "Client save" };
    const concurrentStore = JSON.parse(fs.readFileSync(storePath, "utf8"));
    concurrentStore.jobs[0].name = "Concurrent save";
    const cronWriter = await startPreopenedFdWriter(t, storePath, JSON.stringify(concurrentStore, null, 2) + "\n", "cron-save-fd-writer");
    await withAnchoredChildPreload("cron-save-fd-open", signalBeforeExclusiveOpenPreload, {
      CR_TARGET_NAME: path.basename(storePath),
      CR_TARGET_PREFIX: ".context-room-cron-",
      CR_SIGNAL: cronWriter.signal,
      CR_DONE: cronWriter.done,
    }, async () => {
      const staleSave = await fetch(enabledRoom.origin + "/api/file", {
        method: "POST",
        headers: ownerHeaders(enabledRoom),
        body: JSON.stringify({ path: virtualPath, content: JSON.stringify(clientJob, null, 2) + "\n", expectedContentHash: viewedJob.contentHash }),
      });
      assert.equal(staleSave.status, 409, await staleSave.text());
    });
    const [cronWriterCode] = await cronWriter.exited;
    assert.equal(cronWriterCode, 0);
    assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs[0].name, "Concurrent save");

    const batchManifest = await deletionManifest(enabledRoom.origin, ownerHeaders(enabledRoom), ["docs/DELETE.md", virtualPath]);
    const cronFailureSentinel = path.join(suiteHome, "cron-delete-mid-commit.once");
    const failSecondCronUnlinkPreload = String.raw`
const fs = require("node:fs");
const originalUnlink = fs.unlinkSync;
let stagedUnlinks = 0;
fs.unlinkSync = function(filePath) {
  if (String(filePath).startsWith(".context-room-delete-") && ++stagedUnlinks === 2 && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    throw Object.assign(new Error("injected cron transaction failure"), { code: "EIO" });
  }
  return originalUnlink.apply(this, arguments);
};
`;
    await withAnchoredChildPreload("cron-fail-second-unlink", failSecondCronUnlinkPreload, { CR_ONCE: cronFailureSentinel }, async () => {
      const failed = await fetch(enabledRoom.origin + "/api/files/delete", {
        method: "POST",
        headers: ownerHeaders(enabledRoom),
        body: JSON.stringify(batchManifest),
      });
      assert.equal(failed.status, 500);
    });
    assert.equal(fs.existsSync(path.join(enabledRoot, "docs", "DELETE.md")), true);
    assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs.some((job) => job.id === "job-1"), true);
    assert.equal(fs.existsSync(sourcePath), true);

    const resurrectionManifest = await deletionManifest(enabledRoom.origin, ownerHeaders(enabledRoom), [virtualPath]);
    const concurrentSource = "---\nname: Resurrected\nschedule: 0 9 * * *\nenabled: true\n---\n\nconcurrent-new\n";
    const recreateSourcePreload = String.raw`
const fs = require("node:fs");
const originalUnlink = fs.unlinkSync;
let fired = false;
fs.unlinkSync = function(filePath) {
  if (!fired && String(filePath).startsWith(".context-room-delete-")) {
    fired = true;
    fs.writeFileSync(process.env.CR_SOURCE, Buffer.from(process.env.CR_SOURCE_BYTES, "base64"));
  }
  return originalUnlink.apply(this, arguments);
};
`;
    await withAnchoredChildPreload("cron-source-recreate", recreateSourcePreload, {
      CR_SOURCE: sourcePath,
      CR_SOURCE_BYTES: Buffer.from(concurrentSource).toString("base64"),
    }, async () => {
      const conflicted = await fetch(enabledRoom.origin + "/api/files/delete", {
        method: "POST",
        headers: ownerHeaders(enabledRoom),
        body: JSON.stringify(resurrectionManifest),
      });
      assert.equal(conflicted.status, 409, await conflicted.text());
    });
    assert.equal(fs.readFileSync(sourcePath, "utf8"), concurrentSource);
    assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs.some((job) => job.id === "job-1"), true);

    const manifest = await deletionManifest(enabledRoom.origin, ownerHeaders(enabledRoom), [virtualPath]);
    const storeAfterPreview = fs.readFileSync(storePath);
    const refreshed = await fetch(enabledRoom.origin + "/api/files");
    assert.equal(refreshed.status, 200, await refreshed.text());
    assert.deepEqual(fs.readFileSync(storePath), storeAfterPreview);
    const deleted = await fetch(enabledRoom.origin + "/api/files/delete", {
      method: "POST",
      headers: ownerHeaders(enabledRoom),
      body: JSON.stringify(manifest),
    });
    assert.equal(deleted.status, 200, await deleted.text());
    assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs.some((job) => job.id === "job-1"), false);
    assert.equal(fs.existsSync(sourcePath), false);
    fs.writeFileSync(sourcePath, concurrentSource, "utf8");
    const listed = await fetch(enabledRoom.origin + "/api/files");
    assert.equal(listed.status, 200, await listed.text());
    assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).jobs.some((job) => job.id === "job-1"), false);
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

test("cron atomic publication rolls back child crashes and preserves later external writes", async (t) => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "hermes-cron-atomic-home");
  process.env.HERMES_HOME = hermesHome;
  try {
    const cronDir = path.join(hermesHome, "cron");
    const sourceDir = path.join(cronDir, "jobs-md");
    const storePath = path.join(cronDir, "jobs.json");
    fs.mkdirSync(sourceDir, { recursive: true });
    const initialStore = { jobs: [{ id: "job-atomic", name: "Baseline", prompt: "hello", schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true }] };
    fs.writeFileSync(storePath, JSON.stringify(initialStore, null, 2) + "\n", "utf8");
    fs.writeFileSync(path.join(sourceDir, "job-atomic.md"), "---\nname: Baseline\nschedule: 0 9 * * *\nenabled: true\n---\n\nhello\n", "utf8");
    const root = makeProject("cron-atomic-publication");
    const settings = readMemoryWebappSettings(root);
    writeMemoryWebappSettings(root, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    const room = await startRoom(t, root);
    assert.equal((await fetch(room.origin + "/api/files")).status, 200);
    const baseline = fs.readFileSync(storePath);
    const client = JSON.parse(baseline.toString("utf8"));
    client.jobs[0].name = "Context Room C";
    const clientBytes = Buffer.from(JSON.stringify(client, null, 2) + "\n");
    const assertNoArtifacts = () => {
      const names = [
        ...fs.readdirSync(cronDir),
        ...fs.readdirSync(sourceDir),
      ];
      assert.deepEqual(names.filter((name) => name.startsWith(".context-room-cron-") || name.startsWith(".context-room-delete-")), []);
    };
    const saveRawStore = async () => {
      const currentResponse = await fetch(room.origin + `/api/file?path=${encodeURIComponent("~/.hermes/cron/jobs.json")}`);
      const current = await currentResponse.json();
      assert.equal(currentResponse.status, 200, JSON.stringify(current));
      return fetch(room.origin + "/api/file", {
        method: "POST",
        headers: ownerHeaders(room),
        body: JSON.stringify({
          path: "~/.hermes/cron/jobs.json",
          content: clientBytes.toString("utf8"),
          expectedContentHash: current.contentHash,
        }),
      });
    };

    for (const phase of ["before-link", "after-link", "prepare-before-json", "after-temp-unlink", "after-stage-unlink", "finalize-before-json", "recovery-after-link", "recovery-after-witness-unlink"]) {
      const sentinel = path.join(suiteHome, `cron-atomic-crash-${phase}.once`);
      const crashPreload = String.raw`
const fs = require("node:fs");
const phase = process.env.CR_PHASE;
const originalLink = fs.linkSync;
const originalUnlink = fs.unlinkSync;
fs.linkSync = function(source, target) {
  const matches = String(source).startsWith(".context-room-cron-") && String(target) === "jobs.json" && !fs.existsSync(process.env.CR_ONCE);
  if (matches && phase === "before-link") {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    process.exit(97);
  }
  const result = originalLink.apply(this, arguments);
  if (matches && phase === "after-link") {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    process.exit(97);
  }
  if (phase === "recovery-after-link" && String(source).endsWith(".recovery") && String(target) === "jobs.json" && fs.existsSync(process.env.CR_ONCE) && fs.readFileSync(process.env.CR_ONCE, "utf8") === "finalize") {
    fs.writeFileSync(process.env.CR_ONCE, "recovery");
    process.exit(97);
  }
  return result;
};
fs.unlinkSync = function(target) {
  const result = originalUnlink.apply(this, arguments);
  const isTemp = String(target).startsWith(".context-room-cron-") && String(target).endsWith(".tmp");
  const isStage = String(target).startsWith(".context-room-delete-");
  const isRecovery = String(target).startsWith(".context-room-cron-") && String(target).endsWith(".recovery");
  if (phase === "recovery-after-witness-unlink" && isRecovery && fs.existsSync(process.env.CR_ONCE) && fs.readFileSync(process.env.CR_ONCE, "utf8") === "finalize") {
    fs.writeFileSync(process.env.CR_ONCE, "recovery-unlinked");
    process.exit(97);
  }
  if (!fs.existsSync(process.env.CR_ONCE) && ((phase === "after-temp-unlink" && isTemp) || ((phase === "after-stage-unlink" || phase === "recovery-after-link" || phase === "recovery-after-witness-unlink") && isStage))) {
    fs.writeFileSync(process.env.CR_ONCE, phase.startsWith("recovery-") ? "finalize" : "1");
    process.exit(97);
  }
  return result;
};
if (phase === "prepare-before-json" || phase === "finalize-before-json") {
  const originalReadFile = fs.readFileSync;
  let anchoredRequest = "";
  fs.readFileSync = function(filePath) {
    const result = originalReadFile.apply(this, arguments);
    if (filePath === 0) anchoredRequest = String(result);
    return result;
  };
  const originalWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = function() {
    const expectedKind = phase === "prepare-before-json" ? '"kind":"atomic-install' : '"kind":"atomic-finalize"';
    if (anchoredRequest.includes(expectedKind)) {
      fs.writeFileSync(process.env.CR_ONCE, "1");
      process.exit(97);
    }
    return originalWrite.apply(process.stdout, arguments);
  };
}
`;
      await withAnchoredChildPreload(`cron-atomic-crash-${phase}`, crashPreload, { CR_PHASE: phase, CR_ONCE: sentinel }, async () => {
        const response = await saveRawStore();
        const body = await response.json();
        assert.equal(response.status, 500, JSON.stringify(body));
        assert.equal(body.code, phase === "recovery-after-witness-unlink" ? "filesystem_recovery_required" : "cron_filesystem_transaction_failed");
      });
      assert.deepEqual(fs.readFileSync(storePath), baseline);
      assertNoArtifacts();
    }

    for (const mode of ["rename", "in-place", "identical"]) {
      fs.writeFileSync(storePath, baseline);
      const external = JSON.parse(baseline.toString("utf8"));
      external.jobs[0].name = `External B ${mode}`;
      const externalBytes = mode === "identical" ? clientBytes : Buffer.from(JSON.stringify(external, null, 2) + "\n");
      const sentinel = path.join(suiteHome, `cron-atomic-external-${mode}.once`);
      const externalPreload = String.raw`
const fs = require("node:fs");
const originalLink = fs.linkSync;
fs.linkSync = function(source, target) {
  const result = originalLink.apply(this, arguments);
  if (String(source).startsWith(".context-room-cron-") && String(target) === "jobs.json" && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "started");
    const bytes = Buffer.from(process.env.CR_EXTERNAL_BYTES, "base64");
    if (process.env.CR_MODE === "rename") {
      const replacement = "jobs.external.json";
      fs.writeFileSync(replacement, bytes);
      fs.renameSync(replacement, target);
    } else {
      fs.writeFileSync(target, bytes);
    }
    const stat = fs.lstatSync(target, { bigint: true });
    fs.writeFileSync(process.env.CR_ONCE, JSON.stringify({ dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o777n) }));
  }
  return result;
};
`;
      await withAnchoredChildPreload(`cron-atomic-external-${mode}`, externalPreload, {
        CR_MODE: mode === "in-place" ? "in-place" : "rename",
        CR_ONCE: sentinel,
        CR_EXTERNAL_BYTES: externalBytes.toString("base64"),
      }, async () => {
        const response = await saveRawStore();
        const body = await response.json();
        assert.equal(response.status, 409, JSON.stringify(body));
        assert.equal(body.code, "file_revision_conflict");
      });
      assert.deepEqual(fs.readFileSync(storePath), externalBytes);
      const injectedIdentity = JSON.parse(fs.readFileSync(sentinel, "utf8"));
      const finalIdentity = fs.lstatSync(storePath, { bigint: true });
      assert.deepEqual(
        { dev: finalIdentity.dev.toString(), ino: finalIdentity.ino.toString(), mode: Number(finalIdentity.mode & 0o777n) },
        injectedIdentity,
      );
      assertNoArtifacts();
    }
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

test("cron atomic publication covers virtual, Markdown, and delete HTTP mutations", async (t) => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "hermes-cron-atomic-surfaces-home");
  process.env.HERMES_HOME = hermesHome;
  try {
    const cronDir = path.join(hermesHome, "cron");
    const sourceDir = path.join(cronDir, "jobs-md");
    const storePath = path.join(cronDir, "jobs.json");
    const sourcePath = path.join(sourceDir, "job-surfaces.md");
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify({
      jobs: [{ id: "job-surfaces", name: "Surface baseline", prompt: "hello", schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true }],
    }, null, 2) + "\n", "utf8");
    fs.writeFileSync(sourcePath, "---\nname: Surface baseline\nschedule: 0 9 * * *\nenabled: true\n---\n\nhello\n", "utf8");
    const root = makeProject("cron-atomic-surfaces");
    const settings = readMemoryWebappSettings(root);
    writeMemoryWebappSettings(root, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    const room = await startRoom(t, root);
    assert.equal((await fetch(room.origin + "/api/files")).status, 200);
    const baselineStore = fs.readFileSync(storePath);
    const baselineSource = fs.readFileSync(sourcePath);
    const virtualPath = "~/.hermes/cron/jobs/job-surfaces.json";
    const markdownPath = "~/.hermes/cron/jobs-md/job-surfaces.md";
    const assertNoArtifacts = () => assert.deepEqual([
      ...fs.readdirSync(cronDir),
      ...fs.readdirSync(sourceDir),
    ].filter((name) => name.startsWith(".context-room-cron-") || name.startsWith(".context-room-delete-")), []);
    const crashAfterAtomicLink = String.raw`
const fs = require("node:fs");
const originalLink = fs.linkSync;
fs.linkSync = function(source, target) {
  const result = originalLink.apply(this, arguments);
  if (String(source).startsWith(".context-room-cron-") && String(source).endsWith(".tmp") && String(target) === "jobs.json" && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, "1");
    process.exit(97);
  }
  return result;
};
`;
    const savePath = async (relPath, mutate) => {
      const readResponse = await fetch(room.origin + `/api/file?path=${encodeURIComponent(relPath)}`);
      const current = await readResponse.json();
      assert.equal(readResponse.status, 200, JSON.stringify(current));
      return fetch(room.origin + "/api/file", {
        method: "POST",
        headers: ownerHeaders(room),
        body: JSON.stringify({ path: relPath, content: mutate(current.content), expectedContentHash: current.contentHash }),
      });
    };

    for (const [surface, relPath, mutate] of [
      ["virtual", virtualPath, (content) => JSON.stringify({ ...JSON.parse(content), name: "Virtual C" }, null, 2) + "\n"],
      ["markdown", markdownPath, (content) => content.replace("name: Surface baseline", "name: Markdown C")],
    ]) {
      fs.writeFileSync(storePath, baselineStore);
      fs.writeFileSync(sourcePath, baselineSource);
      const sentinel = path.join(suiteHome, `cron-atomic-${surface}-surface.once`);
      await withAnchoredChildPreload(`cron-atomic-${surface}-surface`, crashAfterAtomicLink, { CR_ONCE: sentinel }, async () => {
        const response = await savePath(relPath, mutate);
        const body = await response.json();
        assert.equal(response.status, 500, JSON.stringify(body));
        assert.equal(body.code, "cron_filesystem_transaction_failed");
      });
      assert.deepEqual(fs.readFileSync(storePath), baselineStore);
      assert.deepEqual(fs.readFileSync(sourcePath), baselineSource);
      assertNoArtifacts();
    }

    fs.writeFileSync(storePath, baselineStore);
    fs.writeFileSync(sourcePath, baselineSource);
    const manifest = await deletionManifest(room.origin, ownerHeaders(room), [virtualPath]);
    const deleteSentinel = path.join(suiteHome, "cron-atomic-delete-surface.once");
    await withAnchoredChildPreload("cron-atomic-delete-surface", crashAfterAtomicLink, { CR_ONCE: deleteSentinel }, async () => {
      const response = await fetch(room.origin + "/api/files/delete", {
        method: "POST",
        headers: ownerHeaders(room),
        body: JSON.stringify(manifest),
      });
      const body = await response.json();
      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(body.code, "cron_filesystem_transaction_failed");
    });
    assert.deepEqual(fs.readFileSync(storePath), baselineStore);
    assert.deepEqual(fs.readFileSync(sourcePath), baselineSource);
    assertNoArtifacts();
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

test("cron recovery never clobbers an external writer that appears during cleanup restoration", async (t) => {
  const previousHermesHome = process.env.HERMES_HOME;
  const hermesHome = path.join(suiteHome, "hermes-cron-cleanup-race-home");
  process.env.HERMES_HOME = hermesHome;
  try {
    const cronDir = path.join(hermesHome, "cron");
    const sourceDir = path.join(cronDir, "jobs-md");
    const storePath = path.join(cronDir, "jobs.json");
    fs.mkdirSync(sourceDir, { recursive: true });
    const baseline = Buffer.from(JSON.stringify({ jobs: [{ id: "cleanup-race", name: "Baseline A", prompt: "hello", schedule: { kind: "cron", expr: "0 9 * * *" }, enabled: true }] }, null, 2) + "\n");
    const client = JSON.parse(baseline.toString("utf8"));
    client.jobs[0].name = "Client C";
    const clientBytes = Buffer.from(JSON.stringify(client, null, 2) + "\n");
    const external = JSON.parse(baseline.toString("utf8"));
    external.jobs[0].name = "External B during cleanup";
    const externalBytes = Buffer.from(JSON.stringify(external, null, 2) + "\n");
    fs.writeFileSync(storePath, baseline);
    fs.writeFileSync(path.join(sourceDir, "cleanup-race.md"), "---\nname: Baseline A\nschedule: 0 9 * * *\nenabled: true\n---\n\nhello\n", "utf8");
    const root = makeProject("cron-cleanup-restoration-race");
    const settings = readMemoryWebappSettings(root);
    writeMemoryWebappSettings(root, { ...settings, integrations: { ...(settings.integrations || {}), hermes: true } });
    const room = await startRoom(t, root);
    assert.equal((await fetch(room.origin + "/api/files")).status, 200);
    const transactionBaseline = fs.readFileSync(storePath);
    const currentResponse = await fetch(room.origin + `/api/file?path=${encodeURIComponent("~/.hermes/cron/jobs.json")}`);
    const current = await currentResponse.json();
    assert.equal(currentResponse.status, 200, JSON.stringify(current));
    const sentinel = path.join(suiteHome, "cron-cleanup-restoration-race.json");
    const preload = String.raw`
const fs = require("node:fs");
const originalLink = fs.linkSync;
const originalRename = fs.renameSync;
fs.linkSync = function(source, target) {
  const result = originalLink.apply(this, arguments);
  if (String(source).startsWith(".context-room-cron-") && String(source).endsWith(".tmp") && String(target) === "jobs.json" && !fs.existsSync(process.env.CR_ONCE)) {
    fs.writeFileSync(process.env.CR_ONCE, JSON.stringify({ state: "recover" }));
    throw Object.assign(new Error("force atomic recovery"), { code: "EIO" });
  }
  return result;
};
fs.renameSync = function(source, target) {
  const inject = String(source) === "jobs.json" && String(target).endsWith(".cleanup") && fs.existsSync(process.env.CR_ONCE) && JSON.parse(fs.readFileSync(process.env.CR_ONCE, "utf8")).state === "recover";
  const result = originalRename.apply(this, arguments);
  if (inject) {
    fs.writeFileSync(target, Buffer.from(process.env.CR_CLEANUP_BYTES, "base64"));
    const replacement = "jobs.external-cleanup-race.json";
    fs.writeFileSync(replacement, Buffer.from(process.env.CR_EXTERNAL_BYTES, "base64"));
    originalRename.call(this, replacement, source);
    const stat = fs.lstatSync(source, { bigint: true });
    fs.writeFileSync(process.env.CR_ONCE, JSON.stringify({ state: "external", dev: stat.dev.toString(), ino: stat.ino.toString(), mode: Number(stat.mode & 0o777n) }));
  }
  return result;
};
`;
    await withAnchoredChildPreload("cron-cleanup-restoration-race", preload, {
      CR_ONCE: sentinel,
      CR_EXTERNAL_BYTES: externalBytes.toString("base64"),
      CR_CLEANUP_BYTES: Buffer.from("private cleanup witness changed during restoration\n").toString("base64"),
    }, async () => {
      const response = await fetch(room.origin + "/api/file", {
        method: "POST",
        headers: ownerHeaders(room),
        body: JSON.stringify({
          path: "~/.hermes/cron/jobs.json",
          content: clientBytes.toString("utf8"),
          expectedContentHash: current.contentHash,
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 500, JSON.stringify(body));
      assert.equal(body.code, "filesystem_recovery_required");
    });
    assert.deepEqual(fs.readFileSync(storePath), externalBytes);
    const injectedIdentity = JSON.parse(fs.readFileSync(sentinel, "utf8"));
    const finalIdentity = fs.lstatSync(storePath, { bigint: true });
    assert.deepEqual(
      { dev: finalIdentity.dev.toString(), ino: finalIdentity.ino.toString(), mode: Number(finalIdentity.mode & 0o777n) },
      { dev: injectedIdentity.dev, ino: injectedIdentity.ino, mode: injectedIdentity.mode },
    );
    const artifacts = fs.readdirSync(cronDir).filter((name) => name.startsWith(".context-room-cron-") || name.startsWith(".context-room-delete-"));
    assert.equal(artifacts.some((name) => name.endsWith(".cleanup")), true);
    const reported = buildContextRoomDoctorReport(root).issues.filter((issue) => issue.type === "orphaned_file_mutation_staging" && issue.path?.startsWith("~/.hermes/cron/"));
    assert.deepEqual(reported.map((issue) => path.basename(issue.path)).sort(), [...artifacts].sort());
    assert.equal(artifacts.every((name) => fs.existsSync(path.join(cronDir, name))), true);
    const backupsRoot = path.join(root, ".context-room", "memory-webapp-backups");
    const backups = fs.readdirSync(backupsRoot, { recursive: true }).map(String).filter((name) => name.endsWith(path.join("cron", "jobs.json")));
    assert.equal(backups.length > 0, true);
    assert.deepEqual(fs.readFileSync(path.join(backupsRoot, backups.at(-1))), transactionBaseline);
  } finally {
    if (previousHermesHome === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previousHermesHome;
  }
});

test("global Explorer delete rejects a stale target revision", async (t) => {
  const host = makeProject("global-delete-host");
  const target = makeProject("global-delete-target");
  registerContextHubProject(host);
  const targetEntry = registerContextHubProject(target);
  const room = await startRoom(t, host);
  const request = (action, payload) => fetch(room.origin + "/api/context-hub/project-explorer/action", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ projectId: targetEntry.id, action, ...payload }),
  });

  const previewResponse = await request("delete-preview", { paths: ["docs/DELETE.md"] });
  if (previewResponse.status !== 200) assert.fail(await previewResponse.text());
  const preview = (await previewResponse.json()).result;
  fs.writeFileSync(path.join(target, "docs", "DELETE.md"), "# New target revision\n", "utf8");

  const staleDelete = await request("delete", preview);
  assert.equal(staleDelete.status, 409);
  assert.equal((await staleDelete.json()).code, "file_revision_conflict");
  assert.equal(fs.readFileSync(path.join(target, "docs", "DELETE.md"), "utf8"), "# New target revision\n");

  const freshPreview = (await (await request("delete-preview", { paths: ["docs/DELETE.md"] })).json()).result;
  const deleted = await request("delete", freshPreview);
  assert.equal(deleted.status, 200, await deleted.text());
  assert.equal(fs.existsSync(path.join(target, "docs", "DELETE.md")), false);
});

test("Context Hub rejects only the exact local review revision shown", async (t) => {
  const host = makeProject("reject-host");
  const target = makeProject("reject-target");
  registerContextHubProject(host);
  const targetEntry = registerContextHubProject(target);
  fs.writeFileSync(path.join(target, "docs", "README.md"), "# Version A\n", "utf8");
  const room = await startRoom(t, host);

  const refresh = async () => {
    const response = await fetch(room.origin + "/api/context-hub/refresh", {
      method: "POST",
      headers: { "content-type": "application/json", "x-context-room-project": room.projectId },
      body: "{}",
    });
    if (response.status !== 200) assert.fail(await response.text());
    return response.json();
  };
  const reviewFrom = (hub) => {
    const group = hub.items.find((item) => item.type === "local" && item.reviews?.some((review) => review.worktreeId === targetEntry.id && review.path === "docs/README.md"));
    assert.ok(group);
    const review = group.reviews.find((item) => item.worktreeId === targetEntry.id && item.path === "docs/README.md");
    return {
      id: `${group.id}:worktree:${review.worktreeId}:file:${review.path}`,
      review,
      revisionToken: `local:${review.resourceState}:${review.resourceVersion || "-"}:${review.currentHash}`,
    };
  };

  const viewed = reviewFrom(await refresh());
  fs.writeFileSync(path.join(target, "docs", "README.md"), "# Version B\n", "utf8");
  const staleReject = await fetch(room.origin + "/api/context-hub/reject", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ items: [{ id: viewed.id, revisionToken: viewed.revisionToken }] }),
  });
  assert.equal(staleReject.status, 409);
  assert.equal((await staleReject.json()).code, "context_hub_reject_stale");

  const fresh = reviewFrom(await refresh());
  const rejected = await fetch(room.origin + "/api/context-hub/reject", {
    method: "POST",
    headers: ownerHeaders(room),
    body: JSON.stringify({ items: [{ id: fresh.id, revisionToken: fresh.revisionToken }] }),
  });
  if (rejected.status !== 200) assert.fail(await rejected.text());
  assert.equal((await rejected.json()).summary.localReviews, 1);
});
