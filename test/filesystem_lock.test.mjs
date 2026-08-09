import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import test from "node:test";
import { Worker } from "node:worker_threads";

import {
  acquireFilesystemLock,
  cleanupFilesystemLockWorkerOwner,
  createFilesystemLockWorkerOwner,
  withFilesystemLock,
} from "../src/filesystem_lock.mjs";

const suiteRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-filesystem-lock-"));
const moduleUrl = new URL("../src/filesystem_lock.mjs", import.meta.url).href;

test.after(() => {
  fs.rmSync(suiteRoot, { recursive: true, force: true });
});

function testRoot(name) {
  const root = path.join(suiteRoot, name);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

async function waitForWorkerMessage(worker, type) {
  while (true) {
    const [message] = await once(worker, "message");
    if (message?.type === "error") {
      throw Object.assign(new Error(message.message), { code: message.code });
    }
    if (message?.type === type) return message;
  }
}

function registerWorkerCleanup(t, worker) {
  t.after(async () => {
    if (worker.threadId !== -1) await worker.terminate();
  });
}

async function startHoldingWorker(t, { lockPath, owner, staleMs = 20 }) {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const control = new Int32Array(controlBuffer);
  const worker = new Worker(String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.controlBuffer);
parentPort.postMessage({ type: "ready" });
Atomics.wait(control, 0, 0);
import(workerData.moduleUrl).then(({ withFilesystemLock }) => {
  withFilesystemLock(workerData.lockPath, () => {
    parentPort.postMessage({ type: "locked" });
    Atomics.wait(control, 1, 0);
  }, { timeoutMs: 1_000, staleMs: workerData.staleMs });
  parentPort.postMessage({ type: "released" });
}).catch((error) => parentPort.postMessage({
  type: "error",
  code: error?.code,
  message: error?.message,
}));
`, {
    eval: true,
    workerData: {
      controlBuffer,
      filesystemLockOwner: owner,
      lockPath,
      moduleUrl,
      staleMs,
    },
  });
  registerWorkerCleanup(t, worker);
  await waitForWorkerMessage(worker, "ready");
  const locked = waitForWorkerMessage(worker, "locked");
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
  await locked;
  return { control, worker };
}

async function startWorkerPausedBeforeTempUnlink(t, { lockPath, owner, staleMs = 20 }) {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
  const control = new Int32Array(controlBuffer);
  const worker = new Worker(String.raw`
const fs = require("node:fs");
const path = require("node:path");
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.controlBuffer);
const originalUnlinkSync = fs.unlinkSync;
let paused = false;
fs.unlinkSync = function patchedUnlinkSync(filePath) {
  const name = path.basename(String(filePath));
  if (!paused && name.startsWith(workerData.tempPrefix) && name.endsWith(".tmp")) {
    paused = true;
    parentPort.postMessage({ type: "published" });
    Atomics.wait(control, 1, 0);
  }
  return originalUnlinkSync.apply(this, arguments);
};
parentPort.postMessage({ type: "ready" });
Atomics.wait(control, 0, 0);
import(workerData.moduleUrl).then(({ withFilesystemLock }) => {
  withFilesystemLock(workerData.lockPath, () => {}, { timeoutMs: 1_000, staleMs: workerData.staleMs });
  parentPort.postMessage({ type: "released" });
}).catch((error) => parentPort.postMessage({ type: "error", code: error?.code, message: error?.message }));
`, {
    eval: true,
    workerData: {
      controlBuffer,
      filesystemLockOwner: owner,
      lockPath,
      moduleUrl,
      staleMs,
      tempPrefix: `.context-room-filesystem-lock-${owner.id}-`,
    },
  });
  registerWorkerCleanup(t, worker);
  await waitForWorkerMessage(worker, "ready");
  const published = waitForWorkerMessage(worker, "published");
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
  await published;
  return { control, worker };
}

async function releaseHoldingWorker(holder) {
  const released = waitForWorkerMessage(holder.worker, "released");
  const exited = once(holder.worker, "exit");
  Atomics.store(holder.control, 1, 1);
  Atomics.notify(holder.control, 1);
  await released;
  await exited;
}

async function runWorkerLockProbe(t, { lockPath, owner }) {
  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(controlBuffer);
  const worker = new Worker(String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.controlBuffer);
parentPort.postMessage({ type: "ready" });
Atomics.wait(control, 0, 0);
import(workerData.moduleUrl).then(({ withFilesystemLock }) => {
  let operationRan = false;
  try {
    withFilesystemLock(workerData.lockPath, () => { operationRan = true; });
    parentPort.postMessage({ type: "result", ok: true, operationRan });
  } catch (error) {
    parentPort.postMessage({
      type: "result",
      ok: false,
      operationRan,
      code: error?.code,
      message: error?.message,
    });
  }
}).catch((error) => parentPort.postMessage({ type: "error", code: error?.code, message: error?.message }));
`, {
    eval: true,
    workerData: {
      controlBuffer,
      ...(owner ? { filesystemLockOwner: owner } : {}),
      lockPath,
      moduleUrl,
    },
  });
  registerWorkerCleanup(t, worker);
  await waitForWorkerMessage(worker, "ready");
  const result = waitForWorkerMessage(worker, "result");
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);
  return result;
}

function writeOwnerRecord(filePath, owner, { kind, token }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    pid: owner.pid,
    threadId: 999,
    ownerInstanceId: owner.id,
    kind,
    token,
    acquiredAt: new Date().toISOString(),
  }) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
}

function recordToken(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8")).token;
}

test("Worker supervision paths are trimmed, empty entries are ignored, and empty-only input is refused", () => {
  const root = testRoot("owner-paths");
  const lockPath = path.join(root, "resource.lock");
  const owner = createFilesystemLockWorkerOwner(["", "  ", null, `  ${lockPath}\t`, lockPath]);

  assert.deepEqual(owner.paths, [path.resolve(lockPath)]);
  assert.equal(Object.isFrozen(owner.paths), true);
  assert.throws(
    () => createFilesystemLockWorkerOwner(["", " \n\t", null, undefined]),
    /At least one filesystem lock path is required/,
  );
  assert.throws(
    () => createFilesystemLockWorkerOwner(
      Array.from({ length: 33 }, (_, index) => path.join(root, `${index}.lock`)),
    ),
    (error) => error?.code === "filesystem_lock_worker_paths_limit",
  );
});

test("unsupervised Workers and out-of-allowlist Worker locks fail before creating lock state", async (t) => {
  const root = testRoot("worker-fail-closed");
  const unsupervisedLock = path.join(root, "unsupervised", "resource.lock");
  const unsupervised = await runWorkerLockProbe(t, { lockPath: unsupervisedLock });
  assert.deepEqual(
    { ok: unsupervised.ok, operationRan: unsupervised.operationRan, code: unsupervised.code },
    { ok: false, operationRan: false, code: "filesystem_lock_worker_unsupervised" },
  );
  assert.equal(fs.existsSync(path.dirname(unsupervisedLock)), false);

  const allowedLock = path.join(root, "allowed", "resource.lock");
  const outsideLock = path.join(root, "outside", "resource.lock");
  const owner = createFilesystemLockWorkerOwner([allowedLock]);
  const outside = await runWorkerLockProbe(t, { lockPath: outsideLock, owner });
  assert.deepEqual(
    { ok: outside.ok, operationRan: outside.operationRan, code: outside.code },
    { ok: false, operationRan: false, code: "filesystem_lock_worker_unsupervised" },
  );
  assert.equal(fs.existsSync(path.dirname(outsideLock)), false);

  const reservedLock = path.join(root, "legitimate.reclaim");
  const reservedOwner = createFilesystemLockWorkerOwner([reservedLock]);
  const reserved = await startHoldingWorker(t, { lockPath: reservedLock, owner: reservedOwner });
  assert.equal(fs.existsSync(reservedLock), true);
  await releaseHoldingWorker(reserved);
  assert.equal(fs.existsSync(reservedLock), false);
});

test("a fully published Worker record remains complete and exactly cleanable if termination precedes temp unlink", async (t) => {
  const root = testRoot("atomic-record-publication");
  const lockPath = path.join(root, "resource.lock");
  const owner = createFilesystemLockWorkerOwner([lockPath]);
  const holder = await startWorkerPausedBeforeTempUnlink(t, { lockPath, owner, staleMs: 15 });
  const tempPrefix = `.context-room-filesystem-lock-${owner.id}-`;

  const tempNames = fs.readdirSync(root).filter((name) => name.startsWith(tempPrefix) && name.endsWith(".tmp"));
  assert.equal(tempNames.length, 1);
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).ownerInstanceId, owner.id);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.throws(
    () => withFilesystemLock(lockPath, () => {}, { timeoutMs: 40, staleMs: 15 }),
    (error) => error?.code === "filesystem_lock_busy",
  );

  const exited = once(holder.worker, "exit");
  await holder.worker.terminate();
  await exited;
  assert.deepEqual(
    cleanupFilesystemLockWorkerOwner(owner, { timeoutMs: 300, staleMs: 15 }),
    { removed: 2 },
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.deepEqual(
    fs.readdirSync(root).filter((name) => name.startsWith(tempPrefix) && name.endsWith(".tmp")),
    [],
  );
});

test("a live Worker lock is not stolen after staleMs, and exit cleanup removes only its exact generation", async (t) => {
  const root = testRoot("worker-generation");
  const lockPath = path.join(root, "resource.lock");
  const firstOwner = createFilesystemLockWorkerOwner([lockPath]);
  const first = await startHoldingWorker(t, { lockPath, owner: firstOwner, staleMs: 15 });

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.throws(
    () => withFilesystemLock(lockPath, () => {}, { timeoutMs: 45, staleMs: 15 }),
    (error) => error?.code === "filesystem_lock_busy",
  );
  assert.equal(fs.existsSync(lockPath), true);

  const exited = once(first.worker, "exit");
  const cleanupAfterExit = exited.then(() => cleanupFilesystemLockWorkerOwner(firstOwner, {
    timeoutMs: 300,
    staleMs: 15,
  }));
  await first.worker.terminate();
  const cleanup = await cleanupAfterExit;
  assert.equal(cleanup.removed, 1);
  assert.equal(fs.existsSync(lockPath), false);

  const successorOwner = createFilesystemLockWorkerOwner([lockPath]);
  const successor = await startHoldingWorker(t, { lockPath, owner: successorOwner, staleMs: 15 });
  assert.deepEqual(
    cleanupFilesystemLockWorkerOwner(firstOwner, { timeoutMs: 100, staleMs: 15 }),
    { removed: 0 },
  );
  assert.throws(
    () => withFilesystemLock(lockPath, () => {}, { timeoutMs: 35, staleMs: 15 }),
    (error) => error?.code === "filesystem_lock_busy",
  );
  await releaseHoldingWorker(successor);
  assert.equal(fs.existsSync(lockPath), false);
});

test("cleanup removes abandoned coordination records exactly and preserves successor records", () => {
  const root = testRoot("coordination-cleanup");
  const lockPath = path.join(root, "resource.lock");
  const reclaimPath = `${lockPath}.reclaim`;
  const ticketPath = path.join(`${lockPath}.reclaimers`, "00000000000000000000.ticket");
  const firstOwner = createFilesystemLockWorkerOwner([lockPath]);
  const successorOwner = createFilesystemLockWorkerOwner([lockPath]);

  writeOwnerRecord(lockPath, firstOwner, { kind: "owner", token: "first-lock" });
  writeOwnerRecord(reclaimPath, firstOwner, { kind: "coordination", token: "first-reclaim" });
  writeOwnerRecord(ticketPath, firstOwner, { kind: "coordination", token: "first-ticket" });
  assert.deepEqual(
    cleanupFilesystemLockWorkerOwner(firstOwner, { timeoutMs: 300, staleMs: 10_000 }),
    { removed: 3 },
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(reclaimPath), false);
  assert.equal(fs.existsSync(ticketPath), false);

  writeOwnerRecord(lockPath, successorOwner, { kind: "owner", token: "successor-lock" });
  writeOwnerRecord(reclaimPath, successorOwner, { kind: "coordination", token: "successor-reclaim" });
  writeOwnerRecord(ticketPath, successorOwner, { kind: "coordination", token: "successor-ticket" });
  assert.throws(
    () => cleanupFilesystemLockWorkerOwner(firstOwner, { timeoutMs: 35, staleMs: 10_000 }),
    (error) => error?.code === "filesystem_lock_cleanup_busy",
  );
  assert.equal(recordToken(lockPath), "successor-lock");
  assert.equal(recordToken(reclaimPath), "successor-reclaim");
  assert.equal(recordToken(ticketPath), "successor-ticket");
});

test("Worker-owner cleanup uses one global deadline across every supervised path", async (t) => {
  const root = testRoot("global-cleanup-deadline");
  const lockPaths = [0, 1, 2].map((index) => path.join(root, `resource-${index}.lock`));
  const cleanupOwner = createFilesystemLockWorkerOwner(lockPaths);
  const blockingOwner = createFilesystemLockWorkerOwner(lockPaths);
  for (const [index, lockPath] of lockPaths.entries()) {
    writeOwnerRecord(`${lockPath}.reclaim`, blockingOwner, {
      kind: "coordination",
      token: `blocker-${index}`,
    });
  }

  const controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const control = new Int32Array(controlBuffer);
  const remover = new Worker(String.raw`
const fs = require("node:fs");
const { parentPort, workerData } = require("node:worker_threads");
const control = new Int32Array(workerData.controlBuffer);
parentPort.postMessage({ type: "ready" });
Atomics.wait(control, 0, 0);
for (const reclaimPath of workerData.reclaimPaths) {
  Atomics.wait(control, 0, 1, workerData.intervalMs);
  try { fs.unlinkSync(reclaimPath); } catch (error) { if (error?.code !== "ENOENT") throw error; }
}
parentPort.postMessage({ type: "done" });
`, {
    eval: true,
    workerData: {
      controlBuffer,
      intervalMs: 30,
      reclaimPaths: lockPaths.map((lockPath) => `${lockPath}.reclaim`),
    },
  });
  registerWorkerCleanup(t, remover);
  await waitForWorkerMessage(remover, "ready");
  const done = waitForWorkerMessage(remover, "done");
  Atomics.store(control, 0, 1);
  Atomics.notify(control, 0);

  const startedAt = performance.now();
  let cleanupError = null;
  try {
    cleanupFilesystemLockWorkerOwner(cleanupOwner, { timeoutMs: 75, staleMs: 10_000 });
  } catch (error) {
    cleanupError = error;
  }
  const elapsedMs = performance.now() - startedAt;
  await done;

  assert.equal(cleanupError?.code, "filesystem_lock_cleanup_busy");
  assert.ok(elapsedMs >= 25, `cleanup returned too early (${elapsedMs.toFixed(1)}ms)`);
  assert.ok(elapsedMs < 250, `cleanup exceeded its bounded attempt (${elapsedMs.toFixed(1)}ms)`);
});

test("asynchronous filesystem lock critical sections are rejected and released", () => {
  const root = testRoot("async-operation");
  const lockPath = path.join(root, "resource.lock");
  const asyncLockPath = path.join(root, "not-created", "resource.lock");
  let asyncOperationRan = false;
  assert.throws(
    () => withFilesystemLock(asyncLockPath, async () => { asyncOperationRan = true; }),
    (error) => error?.code === "filesystem_lock_async_unsupported",
  );
  assert.equal(asyncOperationRan, false);
  assert.equal(fs.existsSync(path.dirname(asyncLockPath)), false);
  assert.throws(
    () => withFilesystemLock(lockPath, () => Promise.resolve("unsupported")),
    (error) => error?.code === "filesystem_lock_async_unsupported",
  );
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(withFilesystemLock(lockPath, () => "reacquired"), "reacquired");
});

test("an explicit filesystem lock lease remains exclusive until its owner releases it", () => {
  const root = testRoot("explicit-lease");
  const lockPath = path.join(root, "resource.lock");
  const lease = acquireFilesystemLock(lockPath, { timeoutMs: 100, staleMs: 10 });

  lease.assertHeld();
  assert.equal(fs.existsSync(lockPath), true);
  assert.throws(
    () => withFilesystemLock(lockPath, () => {}, { timeoutMs: 35, staleMs: 10 }),
    (error) => error?.code === "filesystem_lock_busy",
  );
  assert.equal(lease.release(), true);
  assert.equal(lease.release(), false);
  assert.equal(fs.existsSync(lockPath), false);
  assert.throws(() => lease.assertHeld(), (error) => error?.code === "filesystem_lock_busy");
  assert.equal(withFilesystemLock(lockPath, () => "successor"), "successor");
});

test("a stale lock from a reused live PID is recovered only when its process identity differs", () => {
  const root = testRoot("reused-live-pid");
  const lockPath = path.join(root, "resource.lock");
  const original = acquireFilesystemLock(lockPath, { timeoutMs: 100, staleMs: 10 });
  const previousOwner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(previousOwner.pid, process.pid);
  assert.ok(previousOwner.processIdentity, "lock records must bind the PID to a verifiable process identity");
  original.release();

  previousOwner.token = "previous-process-generation";
  previousOwner.processIdentity = `${previousOwner.processIdentity}:previous`;
  fs.writeFileSync(lockPath, `${JSON.stringify(previousOwner)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const staleDate = new Date(Date.now() - 5_000);
  fs.utimesSync(lockPath, staleDate, staleDate);

  const successor = acquireFilesystemLock(lockPath, { timeoutMs: 250, staleMs: 10 });
  assert.notEqual(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, previousOwner.token);
  successor.release();
  assert.equal(fs.existsSync(lockPath), false);
});

test("Hosted identity enforcement migrates a stale same-thread legacy PID generation without stealing live generations", () => {
  const root = testRoot("legacy-reused-live-pid");
  const lockPath = path.join(root, "resource.lock");
  fs.writeFileSync(lockPath, `${JSON.stringify({
    pid: process.pid,
    threadId: 0,
    kind: "owner",
    token: "legacy-previous-process-generation",
    acquiredAt: new Date(Date.now() - 10_000).toISOString(),
  })}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  const staleDate = new Date(Date.now() - 5_000);
  fs.utimesSync(lockPath, staleDate, staleDate);

  const successor = acquireFilesystemLock(lockPath, {
    timeoutMs: 250,
    staleMs: 10,
    requireProcessIdentity: true,
  });
  const successorToken = JSON.parse(fs.readFileSync(lockPath, "utf8")).token;
  assert.notEqual(successorToken, "legacy-previous-process-generation");
  const successorStaleDate = new Date(Date.now() - 5_000);
  fs.utimesSync(lockPath, successorStaleDate, successorStaleDate);
  assert.throws(
    () => acquireFilesystemLock(lockPath, {
      timeoutMs: 35,
      staleMs: 10,
      requireProcessIdentity: true,
    }),
    (error) => error?.code === "filesystem_lock_busy",
  );
  assert.equal(JSON.parse(fs.readFileSync(lockPath, "utf8")).token, successorToken);
  successor.release();
});

test("Hosted identity enforcement keeps an identity-less legacy owner in another live thread fail-closed", () => {
  const root = testRoot("legacy-other-thread");
  const lockPath = path.join(root, "resource.lock");
  writeOwnerRecord(lockPath, { pid: process.pid, id: "" }, {
    kind: "owner",
    token: "live-other-thread-generation",
  });
  const staleDate = new Date(Date.now() - 5_000);
  fs.utimesSync(lockPath, staleDate, staleDate);

  assert.throws(
    () => acquireFilesystemLock(lockPath, {
      timeoutMs: 35,
      staleMs: 10,
      requireProcessIdentity: true,
    }),
    (error) => error?.code === "filesystem_lock_busy",
  );
  assert.equal(recordToken(lockPath), "live-other-thread-generation");
  fs.unlinkSync(lockPath);
});

test("stale recovery rejects a reclaimers symlink without touching its external target", () => {
  const root = testRoot("reclaimers-symlink");
  const external = testRoot("reclaimers-symlink-external");
  const lockPath = path.join(root, "resource.lock");
  const reclaimPath = `${lockPath}.reclaim`;
  const reclaimersPath = `${lockPath}.reclaimers`;
  const sentinel = path.join(external, "sentinel.txt");
  fs.writeFileSync(sentinel, "must remain unchanged\n", { encoding: "utf8", mode: 0o600 });
  writeOwnerRecord(reclaimPath, { pid: 999_999, id: "" }, {
    kind: "coordination",
    token: "abandoned-reclaim",
  });
  const staleDate = new Date(Date.now() - 5_000);
  fs.utimesSync(reclaimPath, staleDate, staleDate);
  fs.symlinkSync(external, reclaimersPath, "dir");
  const externalBefore = fs.readdirSync(external).sort();
  const sentinelBefore = fs.readFileSync(sentinel);
  const reclaimBefore = fs.readFileSync(reclaimPath);

  let lease = null;
  let acquisitionError = null;
  try {
    lease = acquireFilesystemLock(lockPath, { timeoutMs: 100, staleMs: 10 });
  } catch (error) {
    acquisitionError = error;
  } finally {
    lease?.release();
  }

  assert.equal(acquisitionError?.code, "filesystem_lock_unsafe_sidecar");
  assert.deepEqual(fs.readdirSync(external).sort(), externalBefore);
  assert.deepEqual(fs.readFileSync(sentinel), sentinelBefore);
  assert.deepEqual(fs.readFileSync(reclaimPath), reclaimBefore);
  assert.equal(fs.lstatSync(reclaimersPath).isSymbolicLink(), true);
  assert.equal(fs.existsSync(lockPath), false);
});
