import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { contextHubRegistryLockAttemptMs, contextHubRegistryLockPath, listContextHubProjectsAsync, registerContextHubProject } from "../src/context_hub.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";
import { acquireFilesystemLock } from "../src/filesystem_lock.mjs";

const SOURCE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HOLD_MS = 1500;

function makeProject(base, name) {
  const root = path.join(base, name);
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "README.md"), `# ${name}\n`, "utf8");
  execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "hub@example.test"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Context Hub Test"], { cwd: root, stdio: "ignore" });
  initializeContextRoomProject(root, { title: name, allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial"], { cwd: root, stdio: "ignore" });
  return root;
}

// Another process (attention task, refresh worker, CLI) holds the Hub registry lock.
function holdRegistryLockInOtherProcess(lockPath, env = process.env) {
  const lockModule = pathToFileURL(path.join(SOURCE_ROOT, "src", "filesystem_lock.mjs")).href;
  const script = `
    const { withFilesystemLock } = await import(${JSON.stringify(lockModule)});
    withFilesystemLock(${JSON.stringify(lockPath)}, () => {
      process.stdout.write("locked\\n");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${HOLD_MS});
    }, { timeoutMs: 10000 });
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { env, stdio: ["ignore", "pipe", "inherit"] });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const locked = new Promise((resolve, reject) => {
    child.stdout.on("data", (chunk) => { if (String(chunk).includes("locked")) resolve(); });
    child.once("exit", (code) => reject(new Error(`lock holder exited early (${code})`)));
  });
  return { child, locked, exited };
}

async function startHub(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-lock-wait-"));
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  const hubHome = path.join(base, "hub");
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  let room = null;
  let holder = null;
  // One ordered cleanup: stop the holder and the server (and the refreshes it
  // still runs) before the Hub home goes away, or a late write keeps it busy.
  t.after(async () => {
    try {
      if (holder && holder.child.exitCode === null) holder.child.kill("SIGKILL");
      if (room?.server.listening) await new Promise((resolve) => room.server.close(resolve));
      if (room) await room.waitForShutdown();
    } finally {
      if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
      else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  });
  const root = makeProject(base, "alpha");
  const registered = registerContextHubProject(root, { title: "Alpha" });

  room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "x-context-room-project": room.projectId };
  const ownerHeaders = { ...headers, "x-context-room-owner-nonce": room.ownerMutationNonce };
  const warm = await fetch(`${origin}/api/context-hub`, { headers });
  assert.equal(warm.status, 200);
  await warm.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const holdLock = async () => {
    holder = holdRegistryLockInOtherProcess(contextHubRegistryLockPath(), { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome });
    await holder.locked;
    return holder;
  };
  return { origin, headers, ownerHeaders, holdLock, project: registered };
}

// The server shares this process: a synchronous lock wait freezes every timer here.
// Time spent in fsync is the disk, not a lock wait: on a slow disk (ci /data)
// one durable write stalls up to 1.8 s whatever the lock does. It is left out
// of each gap and reported apart; a synchronous lock wait (Atomics.wait) stays.
function watchEventLoop(t) {
  let lastTick = performance.now();
  let maxGapMs = 0;
  let rawMaxGapMs = 0;
  let syncMs = 0;
  let totalSyncMs = 0;
  const fsyncSync = fs.fsyncSync;
  const timedFsyncSync = function (...args) {
    const startedAt = performance.now();
    try { return fsyncSync.apply(this, args); } finally {
      const elapsed = performance.now() - startedAt;
      syncMs += elapsed;
      totalSyncMs += elapsed;
    }
  };
  fs.fsyncSync = timedFsyncSync;
  const sample = () => {
    const now = performance.now();
    rawMaxGapMs = Math.max(rawMaxGapMs, now - lastTick);
    maxGapMs = Math.max(maxGapMs, now - lastTick - syncMs);
    lastTick = now;
    syncMs = 0;
  };
  const ticker = setInterval(sample, 10);
  const restore = () => {
    clearInterval(ticker);
    if (fs.fsyncSync === timedFsyncSync) fs.fsyncSync = fsyncSync;
  };
  t.after(restore);
  return () => {
    sample();
    restore();
    return { maxGapMs, rawMaxGapMs, totalSyncMs };
  };
}

// A frozen loop (a synchronous wait on the lock held 1.5 s) pauses >= 1 s; the
// old stacked 1 ms attempts paused ~370 ms. GC, fsync of durable files
// and refresh begin/commit pause the loop too, with or without the lock: a
// baseline pass of the same load without the lock sets the allowance.
// The cap keeps a noisy baseline from hiding a real freeze (>= 1 s).
function allowedGapMs(baselineGapMs) {
  return Math.min(800, Math.max(250, baselineGapMs + 150));
}

// A slow disk: every fsync of this process blocks for delayMs first.
function slowFsync(t, delayMs) {
  const fsyncSync = fs.fsyncSync;
  const slow = function (...args) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
    return fsyncSync.apply(this, args);
  };
  fs.fsyncSync = slow;
  const restore = () => { if (fs.fsyncSync === slow) fs.fsyncSync = fsyncSync; };
  t.after(restore);
  return restore;
}

async function killedLockHolder(lockPath) {
  const holder = holdRegistryLockInOtherProcess(lockPath);
  await holder.locked;
  holder.child.kill("SIGKILL");
  await holder.exited;
}

async function measureLoad(t, run, { holdLock = null, after = null } = {}) {
  const holder = holdLock ? await holdLock() : null;
  const stop = watchEventLoop(t);
  const results = await run();
  if (holder) await holder.exited;
  if (after) await after();
  // Let the refreshes the requests scheduled run against the free lock too.
  await new Promise((resolve) => setTimeout(resolve, 300));
  return { results, ...stop() };
}

function assertSucceeded(results) {
  for (const result of results) {
    assert.ok(result.status === 200 || result.status === 201, `${result.pathname}: ${result.status} ${result.body.slice(0, 300)}`);
  }
}

test("Hub event loop stays responsive while another process holds the registry lock", async (t) => {
  const { origin, headers, holdLock } = await startHub(t);
  const load = async () => {
    const hub = await fetch(`${origin}/api/context-hub`, { headers });
    const body = await hub.json();
    assert.ok(Array.isArray(body.projects));
    const health = await fetch(`${origin}/api/health`);
    await health.arrayBuffer();
    return [{ pathname: "/api/context-hub", status: hub.status, body: "" }, { pathname: "/api/health", status: health.status, body: "" }];
  };
  const baseline = await measureLoad(t, load);
  assertSucceeded(baseline.results);
  const held = await measureLoad(t, load, { holdLock });
  assertSucceeded(held.results);
  const allowed = allowedGapMs(baseline.maxGapMs);
  assert.ok(held.maxGapMs < allowed, `the Hub event loop was blocked ${Math.round(held.maxGapMs)} ms by the registry lock of another process (baseline ${Math.round(baseline.maxGapMs)} ms, allowed ${Math.round(allowed)} ms; raw ${Math.round(held.rawMaxGapMs)} ms with ${Math.round(held.totalSyncMs)} ms of fsync left out)`);
});

// A project click sends POST /project and about six reads at once; each read
// also schedules a refresh. None of them may wait for the lock synchronously.
test("Hub event loop never freezes for parallel reads and a project open while the registry lock is held", async (t) => {
  const { origin, headers, holdLock, project } = await startHub(t);
  const load = () => Promise.all([
    ...[
      "/api/context-hub",
      "/api/context-hub",
      "/api/context-hub/catalog",
      "/api/context-hub/review-queue",
      "/api/context-hub/sections",
      "/api/review-cleanup",
    ].map((pathname) => fetch(`${origin}${pathname}`, { headers }).then(async (response) => ({ pathname, status: response.status, body: await response.text() }))),
    fetch(`${origin}/api/context-hub/project`, {
      method: "POST",
      headers,
      body: JSON.stringify({ projectId: project.id }),
    }).then(async (response) => ({ pathname: "POST /project", status: response.status, body: await response.text() })),
  ]);
  const health = async () => {
    const response = await fetch(`${origin}/api/health`);
    assert.equal(response.status, 200);
    await response.arrayBuffer();
  };
  const baseline = await measureLoad(t, load, { after: health });
  assertSucceeded(baseline.results);
  const held = await measureLoad(t, load, { holdLock, after: health });
  assertSucceeded(held.results);
  const allowed = allowedGapMs(baseline.maxGapMs);
  assert.ok(held.maxGapMs < allowed, `the Hub event loop was blocked ${Math.round(held.maxGapMs)} ms by the registry lock of another process (baseline ${Math.round(baseline.maxGapMs)} ms, allowed ${Math.round(allowed)} ms; raw ${Math.round(held.rawMaxGapMs)} ms with ${Math.round(held.totalSyncMs)} ms of fsync left out)`);
});

// After a mutation, the durable snapshot invalidation takes the registry lock:
// /accept, /reject, /review-undo, /notebooks/move, /project-explorer/action and
// POST /project-settings must await it, not wait synchronously.
test("Hub event loop never freezes when a mutation invalidates the snapshot while the registry lock is held", async (t) => {
  const { origin, headers, ownerHeaders, holdLock, project } = await startHub(t);
  const settingsUrl = `${origin}/api/context-hub/project-settings?projectId=${encodeURIComponent(project.id)}`;
  const save = async () => {
    const current = await fetch(settingsUrl, { headers });
    assert.equal(current.status, 200);
    const { revision } = await current.json();
    return { revision };
  };
  const post = (revision) => fetch(`${origin}/api/context-hub/project-settings`, {
    method: "POST",
    headers: ownerHeaders,
    body: JSON.stringify({ projectId: project.id, expectedRevision: revision, settings: {} }),
  }).then(async (response) => [{ pathname: "POST /project-settings", status: response.status, body: await response.text() }]);
  const first = await save();
  const baseline = await measureLoad(t, () => post(first.revision));
  assertSucceeded(baseline.results);
  const second = await save();
  const held = await measureLoad(t, () => post(second.revision), { holdLock });
  assertSucceeded(held.results);
  const allowed = allowedGapMs(baseline.maxGapMs);
  assert.ok(held.maxGapMs < allowed, `POST /project-settings blocked the Hub event loop ${Math.round(held.maxGapMs)} ms on the registry lock of another process (baseline ${Math.round(baseline.maxGapMs)} ms, allowed ${Math.round(allowed)} ms; raw ${Math.round(held.rawMaxGapMs)} ms with ${Math.round(held.totalSyncMs)} ms of fsync left out)`);
});

// A stale lock needs two durable records; on a slow disk (fsync > 1 s) a fixed
// short window never finishes them and every request answers 409.
// The last step is the time left before the request deadline. A window is a
// deadline for disk work: the wait on the main thread stays capped at 25 ms.
test("Registry lock attempts grow by steps only while the lock is stale", () => {
  assert.deepEqual(contextHubRegistryLockAttemptMs({ stale: false, failedReclaims: 9 }), { timeoutMs: 1, maxWaitMs: 1 });
  const steps = [0, 1, 2, 3, 4, 20].map((failedReclaims) => contextHubRegistryLockAttemptMs({ stale: true, failedReclaims }));
  assert.deepEqual(steps.map((step) => step.timeoutMs), [25, 100, 250, 1000, Infinity, Infinity]);
  assert.ok(steps.every((step) => step.maxWaitMs === 25));
});

// Advice B (review PR #129): a long reclaim window must not become a long
// synchronous wait when a live process holds the lock.
test("A lock attempt with a long deadline waits at most maxWaitMs for a live holder", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-lock-budget-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const lockPath = path.join(base, "registry.lock");
  const holder = holdRegistryLockInOtherProcess(lockPath);
  t.after(() => { if (holder.child.exitCode === null) holder.child.kill("SIGKILL"); });
  await holder.locked;
  const startedAt = performance.now();
  assert.throws(
    () => acquireFilesystemLock(lockPath, { timeoutMs: 1000, maxWaitMs: 25, staleMs: 1000, busyCode: "probe_busy" }),
    (error) => error?.code === "probe_busy",
  );
  const elapsed = performance.now() - startedAt;
  assert.ok(elapsed < 200, `the attempt waited ${Math.round(elapsed)} ms for a live holder (cap 25 ms)`);
  await holder.exited;
});

// Advice A: the reclaim record's fsync may outlast the window (1.8 s seen on ci
// /data). The reclaim must still finish, or every attempt fails the same way.
test("A stale lock is reclaimed in one attempt even when fsync takes 1.8 s", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-lock-slow-fsync-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const lockPath = path.join(base, "registry.lock");
  await killedLockHolder(lockPath);
  const restore = slowFsync(t, 1800);
  let lease = null;
  try {
    lease = acquireFilesystemLock(lockPath, { timeoutMs: 1000, maxWaitMs: 25, staleMs: 1000, durableRecord: false, busyCode: "probe_busy" });
  } finally {
    restore();
  }
  assert.ok(lease, "the stale lock was not reclaimed");
  lease.assertHeld();
  lease.release();
});

// Advice D: with a slow disk (fsync 150 ms) the old fixed 25 ms reclaim window
// (3097084) never finished the reclaim and answered 409 after 5 s.
test("Hub takes over the registry lock of a killed process without answering 409", async (t) => {
  const { origin, headers, holdLock, project } = await startHub(t);
  const holder = await holdLock();
  holder.child.kill("SIGKILL");
  await holder.exited;
  const restore = slowFsync(t, 150);
  const response = await fetch(`${origin}/api/context-hub/project`, {
    method: "POST",
    headers,
    body: JSON.stringify({ projectId: project.id }),
  }).finally(restore);
  const body = await response.text();
  assert.ok(response.status === 200 || response.status === 201, `POST /project after a killed lock holder: ${response.status} ${body.slice(0, 300)}`);
});

// Advice D, without a server: only the asynchronous path may reclaim (no sync
// 5 s caller, no refresh worker). On 3097084 its fixed 25 ms reclaim window
// could not finish a 150 ms fsync and every attempt failed until busy (409).
test("The asynchronous registry path reclaims a killed holder's lock on a slow disk", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-lock-killed-"));
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub");
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  });
  registerContextHubProject(makeProject(base, "alpha"), { title: "Alpha" });
  await killedLockHolder(contextHubRegistryLockPath());
  const restore = slowFsync(t, 150);
  const projects = await listContextHubProjectsAsync().finally(restore);
  assert.equal(projects.length, 1);
});
