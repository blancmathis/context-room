import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { initializeContextRoomProject } from "../src/context_room.mjs";
import { connectSharedContext, initializeSharedRepository } from "../src/shared_context.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function git(cwd, args) {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) || "").trim();
}

function write(root, rel, content) {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content, "utf8");
}

// A git:// remote in its own process. It serves through `git daemon --inetd`
// while live and, once muted, accepts connections without ever answering
// (captive portal, weak Wi-Fi). Own process: connect below is synchronous.
const REMOTE_SCRIPT = `
  const net = await import("node:net");
  const { spawn } = await import("node:child_process");
  const basePath = process.argv[1];
  let mute = false;
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (mute) return;
    const daemon = spawn("git", ["daemon", "--inetd", "--export-all", "--base-path=" + basePath], { stdio: ["pipe", "pipe", "ignore"] });
    socket.pipe(daemon.stdin);
    daemon.stdout.pipe(socket);
    daemon.stdin.on("error", () => {});
    daemon.on("exit", () => socket.end());
    socket.on("close", () => daemon.kill());
  });
  process.stdin.on("data", () => { mute = true; process.stdout.write("muted\\n"); });
  process.stdin.on("end", () => process.exit(0));
  server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
`;

function readLine(stream) {
  return new Promise((resolve) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      stream.off("data", onData);
      resolve(buffer.split("\n")[0]);
    };
    stream.on("data", onData);
  });
}

async function startSwitchableGitRemote(basePath) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", REMOTE_SCRIPT, basePath], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdout.setEncoding("utf8");
  const port = Number(await readLine(child.stdout));
  return {
    port,
    async mute() {
      const muted = readLine(child.stdout);
      child.stdin.write("mute\n");
      await muted;
    },
    close() { child.kill("SIGKILL"); },
  };
}

function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  const makeWritable = (target) => {
    let stats;
    try { stats = fs.lstatSync(target); } catch { return; }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      try { fs.chmodSync(target, 0o755); } catch {}
      for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
    } else if (!stats.isSymbolicLink()) {
      try { fs.chmodSync(target, 0o644); } catch {}
    }
  };
  makeWritable(root);
  fs.rmSync(root, { recursive: true, force: true });
}

test("a stalled Shared remote does not freeze the Hub during a Shared refresh", { timeout: 90_000 }, async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-shared-stall-"));
  const env = {
    ...process.env,
    HOME: path.join(base, "home"),
    CONTEXT_ROOM_HUB_HOME: path.join(base, "home", "hub"),
    CONTEXT_ROOM_SHARED_HOME: path.join(base, "home", "shared"),
  };
  const previous = Object.fromEntries(["HOME", "CONTEXT_ROOM_HUB_HOME", "CONTEXT_ROOM_SHARED_HOME"].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: env.HOME, CONTEXT_ROOM_HUB_HOME: env.CONTEXT_ROOM_HUB_HOME, CONTEXT_ROOM_SHARED_HOME: env.CONTEXT_ROOM_SHARED_HOME });
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  // Registered early so it runs last: the Hub and the remote are stopped first.
  t.after(() => removeWritableTree(base));

  const remote = path.join(base, "remote.git");
  const seed = path.join(base, "seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  git(seed, ["config", "user.email", "stall@example.test"]);
  git(seed, ["config", "user.name", "Stall Test"]);
  initializeSharedRepository(seed, { name: "Stall fixture" });
  write(seed, "projects.json", JSON.stringify({ version: 1, projects: [{ id: "demo", title: "Demo" }] }, null, 2) + "\n");
  write(seed, "projects/demo/docs/README.md", "# Demo\n\nInitial.\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize"]);
  git(seed, ["push", "origin", "main"]);

  const root = path.join(base, "project");
  write(root, "docs/README.md", "# Project\n");
  git(root, ["init"]);
  git(root, ["config", "user.email", "stall@example.test"]);
  git(root, ["config", "user.name", "Stall Test"]);
  initializeContextRoomProject(root, { title: "Project", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Initial"]);

  const gitRemote = await startSwitchableGitRemote(base);
  t.after(() => gitRemote.close());
  connectSharedContext(root, { repository: `git://127.0.0.1:${gitRemote.port}/remote.git`, projectId: "demo" });
  await gitRemote.mute();

  // The Hub runs in its own process: a blocked event loop must be visible
  // to this test, which keeps measuring from outside.
  const hubScript = `
    const { createMemoryServer } = await import(${JSON.stringify(new URL("../src/context_room.mjs", import.meta.url).href)});
    const room = createMemoryServer({ root: ${JSON.stringify(root)}, sharedRefreshTimeoutMs: 4000 });
    room.server.listen(0, "127.0.0.1", () => {
      process.stdout.write(JSON.stringify({ port: room.server.address().port, projectId: room.projectId, nonce: room.ownerMutationNonce }) + "\\n");
    });
    process.on("SIGTERM", () => process.exit(0));
  `;
  const hub = spawn(process.execPath, ["--input-type=module", "--eval", hubScript], { cwd: repoRoot, env, stdio: ["ignore", "pipe", "inherit"] });
  t.after(() => hub.kill("SIGKILL"));
  const ready = await new Promise((resolve, reject) => {
    let buffer = "";
    hub.stdout.on("data", (chunk) => {
      buffer += chunk;
      if (buffer.includes("\n")) resolve(JSON.parse(buffer.split("\n")[0]));
    });
    hub.on("exit", (code) => reject(new Error(`Hub exited early: ${code}`)));
  });
  const origin = `http://127.0.0.1:${ready.port}`;

  const refreshStartedAt = Date.now();
  const refresh = fetch(origin + "/api/shared-context/refresh", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-context-room-project": ready.projectId,
      "x-context-room-owner-nonce": ready.nonce,
    },
    body: "{}",
  }).then(async (response) => ({ status: response.status, body: await response.json(), elapsed: Date.now() - refreshStartedAt }));

  await new Promise((resolve) => setTimeout(resolve, 1000));
  const healthStartedAt = Date.now();
  const health = await fetch(origin + "/api/health", { signal: AbortSignal.timeout(60_000) });
  const healthElapsed = Date.now() - healthStartedAt;
  assert.equal(health.status, 200);
  assert.ok(healthElapsed < 1000, `/api/health took ${healthElapsed} ms while a Shared refresh was stalled`);

  const refreshed = await refresh;
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.status.online, false);
  assert.ok(refreshed.body.status.fetchError);
});
