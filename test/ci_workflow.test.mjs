import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

const workflowSource = readFileSync(".github/workflows/ci.yml", "utf8");
const workflow = parse(workflowSource);

test("CI covers supported Node runtimes behind one explicit gate", () => {
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.unit.strategy.matrix["node-version"], [20, "22.23.0", 24]);
  assert.equal(workflow.jobs.unit["timeout-minutes"], 25);
  assert.equal(workflow.jobs.browser.steps.find((step) => step.uses?.includes("setup-node")).with["node-version"], 24);
  assert.equal(workflow.jobs.soak.steps.find((step) => step.uses?.includes("setup-node")).with["node-version"], 24);
  assert.equal(workflow.jobs.browser.strategy["fail-fast"], false);
  assert.deepEqual(workflow.jobs.browser.strategy.matrix.include, [
    { project: "chromium-desktop", browser: "chromium" },
    { project: "chromium-mobile", browser: "chromium" },
    { project: "firefox-desktop", browser: "firefox" },
    { project: "webkit-desktop", browser: "webkit" },
  ]);
  assert.deepEqual(workflow.jobs.gate.needs, ["unit", "browser", "soak"]);
  assert.equal(workflow.jobs.gate.if, "always()");
});

test("CI actions are immutable and jobs receive only their required token permissions", () => {
  assert.deepEqual(workflow.jobs.unit.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.browser.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.soak.permissions, { contents: "read" });
  assert.deepEqual(workflow.jobs.gate.permissions, {});

  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with?.["persist-credentials"], false);
      }
    }
  }
});

test("browser failures retain diagnostic artifacts without weakening the gate", () => {
  for (const [jobName, artifactPrefix] of [["browser", "playwright-browser"], ["soak", "playwright-soak"]]) {
    const job = workflow.jobs[jobName];
    const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
    assert.ok(upload, `${jobName} must upload Playwright diagnostics`);
    assert.equal(upload.if, "failure()");
    assert.match(upload.with.name, new RegExp(`^${artifactPrefix}-`));
    assert.equal(upload.with.path, "test-results/");
    assert.equal(upload.with["if-no-files-found"], "warn");
    assert.equal(upload.with["retention-days"], 14);
  }
  assert.match(workflow.jobs.browser.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@")).with.name, /matrix\.project/);
});

test("each browser shard preserves layout, smoke, and accessibility coverage", () => {
  const commands = workflow.jobs.browser.steps.map((step) => step.run).filter(Boolean);
  assert.ok(commands.includes("npx playwright install --with-deps ${{ matrix.browser }}"));
  assert.ok(commands.includes("npm run test:layout -- --project=${{ matrix.project }}"));
  assert.ok(commands.includes("npm run test:ux-smoke -- --project=${{ matrix.project }}"));
  assert.ok(commands.includes("npm run test:a11y -- --project=${{ matrix.project }}"));
  const performance = workflow.jobs.browser.steps.find((step) => step.name === "Test performance budgets");
  assert.equal(performance.if, "matrix.project == 'chromium-desktop'");
  assert.equal(performance.run, "npm run test:perf");
});

const prWorkflow = parse(readFileSync(".github/workflows/pr.yml", "utf8"));

test("pull requests run the fast gate; the full matrix runs on main, nightly and on demand", () => {
  assert.deepEqual(Object.keys(workflow.on).sort(), ["push", "schedule", "workflow_dispatch"]);
  assert.deepEqual(workflow.on.push.branches, ["main"]);
  assert.deepEqual(prWorkflow.on, { pull_request: { branches: ["main"] } });
  assert.deepEqual(prWorkflow.concurrency, { group: "ci-${{ github.ref }}", "cancel-in-progress": true });
  assert.deepEqual(prWorkflow.permissions, {});
  assert.deepEqual(prWorkflow.jobs.unit.strategy.matrix.shard, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.ok(prWorkflow.jobs.unit.steps.some((step) => step.run === "npm test -- --shard=${{ matrix.shard }}/12"));
  assert.ok(prWorkflow.jobs.browser.steps.some((step) => step.run === "npm run test:perf"));
  assert.equal(prWorkflow.jobs.gate.name, "PR gate");
  assert.deepEqual(prWorkflow.jobs.gate.needs, ["unit", "browser"]);
  assert.equal(prWorkflow.jobs.gate.if, "always()");
  for (const job of Object.values(prWorkflow.jobs)) {
    assert.deepEqual(job.permissions, job === prWorkflow.jobs.gate ? {} : { contents: "read" });
    for (const step of job.steps) if (step.uses) assert.match(step.uses, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
  }
});

test("the PR unit shards together run every test process exactly once", () => {
  const list = (...args) => execFileSync(process.execPath, ["scripts/run-tests.mjs", ...args, "--list"], { encoding: "utf8" })
    .trim().split("\n").map((line) => line.split("\t")[1]);
  const all = list();
  const sharded = Array.from({ length: 12 }, (_, index) => list(`--shard=${index + 1}/12`)).flat();
  assert.ok(all.length > 100);
  assert.deepEqual([...sharded].sort(), [...all].sort());
  assert.ok(all.includes("test/ci_workflow.test.mjs"));
});
