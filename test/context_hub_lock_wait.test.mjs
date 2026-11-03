import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { contextHubRegistryLockPath, registerContextHubProject } from "../src/context_hub.mjs";
import { createMemoryServer, initializeContextRoomProject } from "../src/context_room.mjs";

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
function holdRegistryLockInOtherProcess(lockPath, env) {
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

test("Hub event loop stays responsive while another process holds the registry lock", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-hub-lock-wait-"));
  const previousHubHome = process.env.CONTEXT_ROOM_HUB_HOME;
  const hubHome = path.join(base, "hub");
  process.env.CONTEXT_ROOM_HUB_HOME = hubHome;
  t.after(() => {
    if (previousHubHome === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHubHome;
    fs.rmSync(base, { recursive: true, force: true });
  });
  const root = makeProject(base, "alpha");
  registerContextHubProject(root, { title: "Alpha" });

  const room = createMemoryServer({ root });
  await new Promise((resolve) => room.server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    if (room.server.listening) await new Promise((resolve) => room.server.close(resolve));
    await room.waitForShutdown();
  });
  const origin = `http://127.0.0.1:${room.server.address().port}`;
  const headers = { "x-context-room-project": room.projectId };
  const warm = await fetch(`${origin}/api/context-hub`, { headers });
  assert.equal(warm.status, 200);
  await warm.arrayBuffer();
  await new Promise((resolve) => setTimeout(resolve, 300));

  const holder = holdRegistryLockInOtherProcess(contextHubRegistryLockPath(), { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome });
  t.after(() => { if (holder.child.exitCode === null) holder.child.kill("SIGKILL"); });
  await holder.locked;

  // The server shares this process: a synchronous lock wait freezes every timer here.
  let lastTick = performance.now();
  let maxGapMs = 0;
  const ticker = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - lastTick);
    lastTick = now;
  }, 10);
  t.after(() => clearInterval(ticker));
  const hubResponse = await fetch(`${origin}/api/context-hub`, { headers });
  const health = await fetch(`${origin}/api/health`);
  assert.equal(health.status, 200);
  await health.arrayBuffer();
  clearInterval(ticker);
  assert.ok(maxGapMs < 300, `the Hub event loop was blocked ${Math.round(maxGapMs)} ms by the registry lock of another process`);
  assert.equal(hubResponse.status, 200);
  const body = await hubResponse.json();
  assert.ok(Array.isArray(body.projects));
  await holder.exited;
});
