#!/usr/bin/env node

import { availableParallelism, tmpdir, userInfo } from "node:os";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEST_DIRECTORY = path.join(ROOT, "test");
const SHARED_CONTEXT_TEST = "test/shared_context.test.mjs";
const SHARED_CONTEXT_ISOLATED_TESTS = [
  { label: 'performance', name: 'large proposal acceptance returns a durable exact HTTP projection within one second' },
  { label: 'network timeout', name: 'proposal rejection bounds a stalled archive push without recording a terminal decision' },
  { label: 'fetch timeout', name: 'shared repository refresh bounds a stalled Git fetch' },
];
const JOB_TIMEOUT_MS = 300_000;
const SLOW_JOB_TIMEOUT_MS = 600_000;
// GitHub-hosted runners expose several logical CPUs but the Git-heavy suites
// compete for a much smaller I/O and process budget. Keep release CI serial so
// timing and filesystem assertions measure product behavior instead of runner
// saturation; local runs still use up to three isolated processes.
const MAX_CONCURRENCY = Math.min(process.env.CI ? 1 : 3, Math.max(1, availableParallelism()));
const TEST_GIT_EMAIL = ["context-room", "example.test"].join("@");

function testFiles() {
  return fs.readdirSync(TEST_DIRECTORY)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `test/${name}`)
    .sort();
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Large files run as several processes, each a fixed subset of their top-level test names.
const SPLIT_FILES = { [SHARED_CONTEXT_TEST]: 4, "test/context_hub.test.mjs": 2, "test/context_room.test.mjs": 2 };
// Seconds per test process on a GitHub runner (Node 24, run 43255230396, 2026-11-12). Only used to balance
// `--shard=i/n`; a missing or stale entry makes one shard slower, never skips a test. Default: 1 s.
const JOB_SECONDS = {
  "test/context_hub.test.mjs": 110, "test/context_room.test.mjs": 95, [SHARED_CONTEXT_TEST]: 250,
  "test/cli_contract_regressions.test.mjs": 52, "test/revision_integrity.test.mjs": 49, "test/cli_args.test.mjs": 28,
  "test/trust_current.test.mjs": 19, "test/context_hub_lock_wait.test.mjs": 15, "test/documentation_workflow.test.mjs": 14,
  "test/notebook_shared.test.mjs": 13, "test/bin_context_room_shared_cli.test.mjs": 13, "test/lisiere_migration.test.mjs": 10,
  "test/lisiere_cutover.test.mjs": 10, "test/hub_durable_identity.test.mjs": 9, "test/shared_terminal_cas.test.mjs": 8,
  "test/documentation.test.mjs": 8, "test/shared_context_p1_regressions.test.mjs": 8, "test/lisiere_tablet_drafts.test.mjs": 7,
  "test/agent_cli.test.mjs": 7, "test/context_cli_adapters.test.mjs": 7, "test/shared_refresh_nonblocking.test.mjs": 7,
  "test/acceptance_timeout.test.mjs": 6, "test/location_attestation.test.mjs": 6, "test/mac_installation.test.mjs": 6,
  "test/backup.test.mjs": 5, "test/shared_project_creation.test.mjs": 5, "test/goto_search.test.mjs": 5,
};

function nameShards(file, count, isolatedTests = []) {
  const source = fs.readFileSync(path.join(ROOT, file), "utf8");
  // A name is a "string" or a `template` (a test declared in a loop); `${…}` matches any text.
  const parsed = [...source.matchAll(/^\s*test\(\s*("(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`)/gm)]
    .map((match) => match[1].startsWith('"')
      ? { name: JSON.parse(match[1]), pattern: escapePattern(JSON.parse(match[1])) }
      : { name: match[1].slice(1, -1), pattern: match[1].slice(1, -1).split(/\$\{[^}]*\}/).map(escapePattern).join(".+") });
  if (parsed.length === 0) {
    throw new Error(`No tests found in ${file}`);
  }
  // A test the name parser misses would run in no shard: refuse instead of hiding it.
  const declared = source.match(/^\s*test\(/gm).length;
  if (declared !== parsed.length) throw new Error(`${file}: ${declared - parsed.length} test(...) call(s) have a name the shard parser cannot read.`);
  const names = parsed.map((item) => item.name);
  const shards = Array.from({ length: count }, () => []);
  const isolated = new Set(isolatedTests.map(item => item.name));
  if ([...isolated].some(name => !names.includes(name))) throw new Error('An isolated Shared contract was renamed or removed.');
  parsed.filter((item) => !isolated.has(item.name))
    .forEach((item, index) => shards[index % count].push(item.pattern));
  const weight = (JOB_SECONDS[file] ?? 1) / count;
  return [...shards.map((shard, index) => ({
    label: `${file} [${index + 1}/${count}]`,
    weight,
    args: [
      "--test",
      `--test-name-pattern=^(?:${shard.join("|")})$`,
      file,
    ],
  })), ...isolatedTests.map(({ label, name }) => ({
    label: `${file} [${label}]`,
    weight: 2,
    args: [
      "--test",
      `--test-name-pattern=^${escapePattern(name)}$`,
      file,
    ],
    exclusive: true,
  }))];
}

function allJobs() {
  return [
    ...testFiles()
      .filter((file) => !SPLIT_FILES[file])
      // The CLI discovery contract performs real clones inside a one-second
      // budget. Keep that deadline while isolating its test-process I/O load.
      .map((file) => ({ label: file, weight: JOB_SECONDS[file] ?? 1, args: ["--test", file], exclusive: file === "test/cli_contract_regressions.test.mjs" })),
    ...Object.entries(SPLIT_FILES).flatMap(([file, count]) =>
      nameShards(file, count, file === SHARED_CONTEXT_TEST ? SHARED_CONTEXT_ISOLATED_TESTS : [])),
  ];
}

// `--shard=i/n` keeps the jobs of shard i out of n, balanced by JOB_SECONDS (longest first, into the lightest
// shard). Every job lands in exactly one shard, so the n shards together run the whole suite once.
function jobs(argv = process.argv.slice(2)) {
  const option = argv.find((value) => value.startsWith("--shard="));
  const all = allJobs();
  if (!option) return all;
  const match = /^--shard=(\d+)\/(\d+)$/.exec(option);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || count < 1 || index < 1 || index > count) throw new Error(`Invalid ${option}; expected --shard=i/n with 1 <= i <= n.`);
  const loads = Array.from({ length: count }, () => ({ seconds: 0, jobs: [] }));
  const ordered = [...all].sort((a, b) => b.weight - a.weight || a.label.localeCompare(b.label));
  for (const job of ordered) {
    const lightest = loads.reduce((best, load) => (load.seconds < best.seconds ? load : best));
    lightest.seconds += job.weight;
    lightest.jobs.push(job);
  }
  return loads[index - 1].jobs;
}

function removeTemporaryTestTree(root) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("context-room-test-")) {
    throw new Error(`Refusing to remove an unexpected test directory: ${resolved}`);
  }
  const makeWritable = (target) => {
    let stats;
    try { stats = fs.lstatSync(target); } catch { return; }
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      fs.chmodSync(target, 0o700);
      for (const entry of fs.readdirSync(target)) makeWritable(path.join(target, entry));
    } else if (!stats.isSymbolicLink()) {
      fs.chmodSync(target, 0o600);
    }
  };
  makeWritable(resolved);
  fs.rmSync(resolved, { recursive: true, force: true });
}

function runJob(job) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const hubHome = fs.mkdtempSync(path.join(tmpdir(), "context-room-test-hub-"));
    const sharedHome = fs.mkdtempSync(path.join(tmpdir(), "context-room-test-shared-"));
    const environment = {
        ...process.env,
        CONTEXT_ROOM_HUB_HOME: hubHome,
        CONTEXT_ROOM_SHARED_HOME: sharedHome,
        GIT_AUTHOR_NAME: "Context Room Test",
        GIT_AUTHOR_EMAIL: TEST_GIT_EMAIL,
        GIT_COMMITTER_NAME: "Context Room Test",
        GIT_COMMITTER_EMAIL: TEST_GIT_EMAIL,
        GIT_TERMINAL_PROMPT: "0",
        GCM_INTERACTIVE: "Never",
      };
    // The cutover fixture creates all of its writers inside this process scope.
    // Isolate this job, not the whole suite: earlier tests may have started
    // processes whose file descriptors the runner is not allowed to inspect.
    // Production still refuses incomplete visibility; no guard is substituted.
    const isolated = process.platform === 'linux' && process.env.CI
      && process.env.CONTEXT_ROOM_TEST_PID_NAMESPACE === '1' && job.label === 'test/lisiere_cutover.test.mjs';
    const forwarded = ['PATH', 'CI', 'CONTEXT_ROOM_HUB_HOME', 'CONTEXT_ROOM_SHARED_HOME',
      'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE'];
    const argumentsForJob = isolated ? ['-n', 'unshare', '--pid', '--fork', '--mount-proc', '--kill-child=TERM',
      'runuser', '-u', userInfo().username, '--', 'env',
      ...forwarded.filter(key => environment[key] !== undefined).map(key => `${key}=${environment[key]}`),
      process.execPath, ...job.args] : job.args;
    const child = spawn(isolated ? 'sudo' : process.execPath, argumentsForJob, {
      cwd: ROOT,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    let timedOut = false;
    const timeoutMs = job.label === "test/context_hub.test.mjs"
      || job.label.startsWith(`${SHARED_CONTEXT_TEST} [`)
      ? SLOW_JOB_TIMEOUT_MS
      : JOB_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, timeoutMs);
    timeout.unref();
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      removeTemporaryTestTree(hubHome);
      removeTemporaryTestTree(sharedHome);
      resolve({
        ...job,
        code: timedOut ? 124 : (code ?? 1),
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        output: Buffer.concat(output).toString("utf8"),
      });
    });
  });
}

async function main() {
  const pending = jobs();
  if (process.argv.includes("--list")) {
    for (const job of pending) process.stdout.write(`${job.weight}\t${job.label}\n`);
    return;
  }
  const queue = pending.filter((job) => !job.exclusive);
  const exclusive = pending.filter((job) => job.exclusive);
  const results = [];
  let cursor = 0;
  async function worker() {
    while (cursor < queue.length) {
      const job = queue[cursor++];
      const result = await runJob(job);
      results.push(result);
      const seconds = (result.durationMs / 1_000).toFixed(1);
      process.stdout.write(`${result.code === 0 ? "ok" : "not ok"} - ${result.label} (${seconds}s)\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(MAX_CONCURRENCY, queue.length) }, worker));
  for (const job of exclusive) {
    const result = await runJob(job);
    results.push(result);
    const seconds = (result.durationMs / 1_000).toFixed(1);
    process.stdout.write(`${result.code === 0 ? "ok" : "not ok"} - ${result.label} (${seconds}s)\n`);
  }
  const failures = results.filter((result) => result.code !== 0);
  for (const failure of failures) {
    process.stderr.write(`\n--- ${failure.label}${failure.timedOut ? " timed out" : " failed"} ---\n`);
    process.stderr.write(failure.output);
    if (failure.signal) process.stderr.write(`\nSignal: ${failure.signal}\n`);
  }
  process.stdout.write(`\n${results.length - failures.length}/${results.length} test processes passed.\n`);
  process.exitCode = failures.length === 0 ? 0 : 1;
}

await main();
