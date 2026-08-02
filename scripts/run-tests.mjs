#!/usr/bin/env node

import { availableParallelism, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const TEST_DIRECTORY = path.join(ROOT, "test");
const SHARED_CONTEXT_TEST = "test/shared_context.test.mjs";
const JOB_TIMEOUT_MS = 170_000;
const MAX_CONCURRENCY = Math.min(6, Math.max(2, availableParallelism()));

function testFiles() {
  return fs.readdirSync(TEST_DIRECTORY)
    .filter((name) => name.endsWith(".test.mjs"))
    .map((name) => `test/${name}`)
    .sort();
}

function escapePattern(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sharedContextShards(count = 4) {
  const source = fs.readFileSync(path.join(ROOT, SHARED_CONTEXT_TEST), "utf8");
  const names = [...source.matchAll(/^test\(\s*("(?:[^"\\]|\\.)*")/gm)]
    .map((match) => JSON.parse(match[1]));
  if (names.length === 0) {
    throw new Error(`No tests found in ${SHARED_CONTEXT_TEST}`);
  }
  const shards = Array.from({ length: count }, () => []);
  names.forEach((name, index) => shards[index % count].push(name));
  return shards.map((shard, index) => ({
    label: `${SHARED_CONTEXT_TEST} [${index + 1}/${count}]`,
    args: [
      "--test",
      `--test-name-pattern=^(?:${shard.map(escapePattern).join("|")})$`,
      SHARED_CONTEXT_TEST,
    ],
  }));
}

function jobs() {
  return [
    ...testFiles()
      .filter((file) => file !== SHARED_CONTEXT_TEST)
      .map((file) => ({ label: file, args: ["--test", file] })),
    ...sharedContextShards(),
  ];
}

function runJob(job) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const hubHome = fs.mkdtempSync(path.join(tmpdir(), "context-room-test-hub-"));
    const child = spawn(process.execPath, job.args, {
      cwd: ROOT,
      env: { ...process.env, CONTEXT_ROOM_HUB_HOME: hubHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = [];
    child.stdout.on("data", (chunk) => output.push(chunk));
    child.stderr.on("data", (chunk) => output.push(chunk));
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, JOB_TIMEOUT_MS);
    timeout.unref();
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      fs.rmSync(hubHome, { recursive: true, force: true });
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
  const queue = jobs();
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
