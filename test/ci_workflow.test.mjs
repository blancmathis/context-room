import assert from "node:assert/strict";
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
