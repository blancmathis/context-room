import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  contextHubRepositoryIdentity,
  readContextHubRegistry,
  registerContextHubSharedRepository,
} from "../src/context_hub.mjs";
import { initializeContextRoomProject } from "../src/context_room.mjs";
import {
  connectSharedContext,
  createSharedProposal,
  disconnectSharedContext,
  initializeSharedRepository,
  publishSharedProposal,
  readSharedProjectConnection,
} from "../src/shared_context.mjs";

const cli = path.resolve("bin/context-room.mjs");

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return String(result.stdout || "").trim();
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

function makeRemote(base) {
  const remote = path.join(base, "shared.git");
  const seed = path.join(base, "seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  git(seed, ["config", "user.name", "Shared CLI fixture"]);
  git(seed, ["config", "user.email", "shared-cli@example.test"]);
  initializeSharedRepository(seed, { name: "Shared CLI fixture" });
  fs.writeFileSync(path.join(seed, "projects.json"), JSON.stringify({
    version: 1,
    projects: [{ id: "demo", title: "Demo" }],
  }, null, 2) + "\n");
  fs.mkdirSync(path.join(seed, "projects", "demo", "docs"), { recursive: true });
  fs.writeFileSync(path.join(seed, "projects", "demo", "docs", "README.md"), "# Demo\n\nAccepted shared guidance.\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize Shared CLI fixture"]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed };
}

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-bin-shared-cli-"));
  const home = path.join(base, "home");
  const sharedHome = path.join(home, ".context-room", "shared");
  const hubHome = path.join(home, ".context-room", "hub");
  const project = path.join(base, "project");
  const unrelated = path.join(base, "unrelated");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(project);
  fs.mkdirSync(unrelated);
  const env = {
    ...process.env,
    HOME: home,
    CONTEXT_ROOM_SHARED_HOME: sharedHome,
    CONTEXT_ROOM_HUB_HOME: hubHome,
    GIT_CONFIG_GLOBAL: path.join(base, "empty-global-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    NODE_TEST_CONTEXT: "",
  };
  const previous = Object.fromEntries([
    "HOME",
    "CONTEXT_ROOM_SHARED_HOME",
    "CONTEXT_ROOM_HUB_HOME",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_NOSYSTEM",
    "GIT_TERMINAL_PROMPT",
    "NODE_TEST_CONTEXT",
  ].map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    removeWritableTree(base);
  });
  return { base, env, hubHome, sharedHome, project, unrelated, ...makeRemote(base) };
}

function runCli(args, env, cwd) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
}

function activeHubSharedJournals(hubHome) {
  const directory = path.join(hubHome, "shared-transactions");
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).filter((entry) => entry.endsWith(".json")).sort()
    : [];
}

function writeHubWalProbe(base, { blockAfterDurableWrite = false } = {}) {
  const preload = path.join(base, `hub-wal-probe-${blockAfterDurableWrite ? "blocking" : "recording"}.mjs`);
  fs.writeFileSync(preload, `
    import fs from "node:fs";
    const normalize = (value) => String(value || "").replaceAll("\\\\", "/");
    const isJournal = (value) => normalize(value).includes("/shared-transactions/") && normalize(value).endsWith(".json");
    const record = (event, target) => fs.appendFileSync(process.env.HUB_WAL_WITNESS, JSON.stringify({ event, target: String(target) }) + "\\n");
    const originalRename = fs.renameSync;
    fs.renameSync = function(source, target) {
      const result = originalRename.call(this, source, target);
      if (isJournal(target)) record("write", target);
      return result;
    };
    const originalChmod = fs.chmodSync;
    fs.chmodSync = function(target, mode) {
      const result = originalChmod.call(this, target, mode);
      ${blockAfterDurableWrite ? `
        if (isJournal(target)) {
          fs.writeFileSync(process.env.HUB_WAL_MARKER, String(target));
          const signal = new Int32Array(new SharedArrayBuffer(4));
          while (true) Atomics.wait(signal, 0, 0, 1_000);
        }
      ` : ""}
      return result;
    };
    const originalUnlink = fs.unlinkSync;
    fs.unlinkSync = function(target) {
      if (isJournal(target)) {
        record("unlink", target);
      }
      return originalUnlink.call(this, target);
    };
  `);
  return preload;
}

function walProbeEnv(env, preload, witness, marker = "") {
  const importOption = `--import=${pathToFileURL(preload).href}`;
  return {
    ...env,
    NODE_OPTIONS: [env.NODE_OPTIONS, importOption].filter(Boolean).join(" "),
    HUB_WAL_WITNESS: witness,
    ...(marker ? { HUB_WAL_MARKER: marker } : {}),
  };
}

function assertConnectedRegistries(project, remote, hubHome) {
  const canonicalProject = fs.realpathSync(project);
  const shared = readSharedProjectConnection(project);
  assert.ok(shared, `Shared registry has no binding for ${project}`);
  assert.equal(shared.projectId, "demo");
  assert.equal(contextHubRepositoryIdentity(shared.repository), contextHubRepositoryIdentity(remote));

  const hubProject = readContextHubRegistry().projects.find((entry) => {
    try { return fs.realpathSync(entry.root) === canonicalProject; } catch { return false; }
  });
  assert.ok(hubProject, `Context Hub has no project for ${project}`);
  assert.equal(hubProject.shared?.projectId, "demo");
  assert.equal(contextHubRepositoryIdentity(hubProject.shared?.repository), contextHubRepositoryIdentity(remote));
  assert.deepEqual(activeHubSharedJournals(hubHome), []);
}

function assertDisconnectedRegistries(project, hubHome) {
  const canonicalProject = fs.realpathSync(project);
  assert.equal(readSharedProjectConnection(project), null);
  const hubProject = readContextHubRegistry().projects.find((entry) => {
    try { return fs.realpathSync(entry.root) === canonicalProject; } catch { return false; }
  });
  assert.ok(hubProject, `Context Hub has no project for ${project}`);
  assert.equal(hubProject.shared, null);
  assert.deepEqual(activeHubSharedJournals(hubHome), []);
}

async function waitForFile(filePath, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(filePath) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(fs.existsSync(filePath), true, `Timed out waiting for ${filePath}`);
}

async function runCliUntilWalPrepared(args, env, cwd, marker) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const exited = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    await waitForFile(marker);
  } catch (error) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await exited;
    error.cause = Buffer.concat(output).toString("utf8");
    throw error;
  }
  child.kill("SIGKILL");
  await exited;
  assert.equal(child.signalCode, "SIGKILL", Buffer.concat(output).toString("utf8"));
}

function sharedConnectionCliArgs(action, project, remote) {
  const selector = action === "connect" ? "--shared-project=demo" : "--project=demo";
  return ["shared", action, `--root=${project}`, `--repository=${remote}`, selector, "--format=json"];
}

test("Shared binding conflicts fail before any Git transport is invoked", (t) => {
  const { base, env, project, remote } = fixture(t);
  initializeContextRoomProject(project, { title: "Bound project", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  connectSharedContext(project, { repository: remote, projectId: "demo" });

  const marker = path.join(base, "network-invoked");
  const sshProbe = path.join(base, "ssh-probe.sh");
  fs.writeFileSync(sshProbe, `#!/bin/sh\n: > '${marker.replaceAll("'", `'"'"'`)}'\nexit 1\n`);
  fs.chmodSync(sshProbe, 0o755);
  const probeEnv = { ...env, GIT_SSH_COMMAND: sshProbe };

  const equivalentRepository = runCli([
    "shared", "connect", `--root=${project}`, `--repository=${pathToFileURL(remote).href}`, "--shared-project=demo", "--dry-run", "--format=json",
  ], probeEnv, project);
  assert.equal(equivalentRepository.status, 0, equivalentRepository.stderr);
  assert.equal(JSON.parse(equivalentRepository.stdout).data.dryRun, true);

  const conflictingRepository = "ssh://context-room.invalid/shared.git";
  const cases = [
    ["shared", "connect", `--root=${project}`, `--repository=${conflictingRepository}`, "--shared-project=demo", "--format=json"],
    ["shared", "bind", `--root=${project}`, `--repository=${conflictingRepository}`, "--project=demo", "--format=json"],
    ["shared", "setup", `--root=${project}`, `--repository=${conflictingRepository}`, "--project=demo", "--format=json"],
  ];

  for (const args of cases) {
    const result = runCli(args, probeEnv, project);
    assert.equal(result.status, 5, result.stderr);
    assert.equal(JSON.parse(result.stderr).error.code, "shared-binding-conflict");
    assert.equal(fs.existsSync(marker), false, `${args[1]} invoked Git transport before rejecting the binding`);
  }
});

test("non-Shared machine failures use the neutral retryable error contract", (t) => {
  const { env, project } = fixture(t);
  initializeContextRoomProject(project, { title: "Local docs", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  fs.mkdirSync(path.join(project, "docs"), { recursive: true });
  fs.writeFileSync(path.join(project, "docs", "README.md"), "# Local docs\n");

  const result = runCli(["docs", "read", "connection refused", `--root=${project}`, "--format=json"], env, project);
  assert.equal(result.status, 3, result.stderr);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.command, "docs.read");
  assert.equal(failure.error.code, "operation-failed");
  assert.equal(failure.error.retryable, true);
});

test("context bundle supports an explicit Shared-only target without local resolution", (t) => {
  const { env, unrelated, remote } = fixture(t);
  const result = runCli([
    "context", "bundle", "--task=Read accepted shared guidance", `--repository=${remote}`, "--shared-project=demo", "--format=json",
  ], env, unrelated);

  assert.equal(result.status, 0, result.stderr);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.command, "context.bundle");
  assert.equal(payload.target.localEnvironment, "unavailable");
  assert.equal(payload.target.shared.repository, remote);
  assert.equal(payload.target.shared.projectId, "demo");
  assert.equal(payload.data.environment.localEnvironment, "unavailable");
});

test("edit open forwards exact repository and optional Shared project selectors", (t) => {
  const { env, project, unrelated, remote } = fixture(t);
  initializeContextRoomProject(project, { title: "Proposal source", allowedPaths: ["docs/"], watchAllow: ["docs/"] });
  connectSharedContext(project, { repository: remote, projectId: "demo" });
  const proposal = createSharedProposal(project, { title: "Open exact proposal", branch: "proposal/demo/open-exact" });
  git(proposal.root, ["config", "user.name", "Shared CLI fixture"]);
  git(proposal.root, ["config", "user.email", "shared-cli@example.test"]);
  fs.writeFileSync(path.join(proposal.root, "projects", "demo", "docs", "README.md"), "# Demo\n\nOpen this exact proposal.\n");
  publishSharedProposal(project, { proposal: proposal.branch });
  disconnectSharedContext(project);
  registerContextHubSharedRepository(remote);

  const positional = runCli(["edit", "open", proposal.branch, `--repository=${remote}`, "--format=json"], env, unrelated);
  assert.equal(positional.status, 0, positional.stderr);
  assert.equal(JSON.parse(positional.stdout).data.proposal.branch, proposal.branch);

  const named = runCli([
    "edit", "open", `--proposal=${proposal.branch}`, `--repository=${remote}`, "--shared-project=demo", "--format=json",
  ], env, unrelated);
  assert.equal(named.status, 0, named.stderr);
  const handle = JSON.parse(named.stdout).data;
  assert.equal(handle.proposal.branch, proposal.branch);
  assert.equal(handle.proposal.projectId, "demo");
});

test("shared connect, bind, and setup commit coherent Hub and Shared registries through the Hub WAL", (t) => {
  const { base, env, hubHome, remote } = fixture(t);
  const preload = writeHubWalProbe(base);

  for (const action of ["connect", "bind", "setup"]) {
    const project = path.join(base, `wal-${action}`);
    const witness = path.join(base, `wal-${action}.jsonl`);
    fs.mkdirSync(project);
    initializeContextRoomProject(project, { title: `WAL ${action}`, allowedPaths: ["docs/"], watchAllow: ["docs/"] });

    const result = runCli(
      sharedConnectionCliArgs(action, project, remote),
      walProbeEnv(env, preload, witness),
      project,
    );
    assert.equal(result.status, 0, `${action}: ${result.stderr || result.stdout}`);

    const events = fs.readFileSync(witness, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    const writes = events.filter((event) => event.event === "write").map((event) => event.target);
    const unlinks = events.filter((event) => event.event === "unlink").map((event) => event.target);
    assert.ok(writes.length >= 1, `${action} did not durably create a Hub Shared journal`);
    assert.ok(unlinks.includes(writes.at(-1)), `${action} did not clean up the Hub Shared journal it created`);
    assertConnectedRegistries(project, remote, hubHome);
  }
});

test("shared connect, bind, and setup recover coherently after SIGKILL immediately after durable Hub WAL prepare", async (t) => {
  const { base, env, hubHome, remote } = fixture(t);
  const preload = writeHubWalProbe(base, { blockAfterDurableWrite: true });

  for (const action of ["connect", "bind", "setup"]) {
    const project = path.join(base, `crash-${action}`);
    const witness = path.join(base, `crash-${action}.jsonl`);
    const marker = path.join(base, `crash-${action}.marker`);
    fs.mkdirSync(project);
    initializeContextRoomProject(project, { title: `Crash ${action}`, allowedPaths: ["docs/"], watchAllow: ["docs/"] });

    await runCliUntilWalPrepared(
      sharedConnectionCliArgs(action, project, remote),
      walProbeEnv(env, preload, witness, marker),
      project,
      marker,
    );
    assert.equal(activeHubSharedJournals(hubHome).length, 1, `${action} must leave its durable journal after SIGKILL`);

    assertDisconnectedRegistries(project, hubHome);
    const events = fs.readFileSync(witness, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.ok(events.some((event) => event.event === "write"), `${action} did not create a Hub Shared journal before SIGKILL`);
    assert.equal(events.some((event) => event.event === "unlink"), false, `${action} unexpectedly cleaned its journal before SIGKILL`);
  }
});
