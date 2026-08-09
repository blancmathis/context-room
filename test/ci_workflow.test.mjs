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
});
