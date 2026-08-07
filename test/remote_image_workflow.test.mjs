import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { parse } from "yaml";

const workflowSource = () => readFileSync(".github/workflows/remote-image.yml", "utf8");

function workflowDocument() {
  return parse(workflowSource());
}

test("the signed main image dispatches the exact Peerlab QM deployment", () => {
  const workflow = workflowSource();
  const deploymentDoc = readFileSync("docs/remote-qm.md", "utf8");

  assert.match(workflow, /actions\/create-github-app-token@[a-f0-9]{40}/);
  assert.match(workflow, /client-id: \$\{\{ vars\.PEERLAB_QM_DEPLOY_APP_CLIENT_ID \}\}/);
  assert.match(workflow, /private-key: \$\{\{ secrets\.PEERLAB_QM_DEPLOY_APP_PRIVATE_KEY \}\}/);
  assert.match(workflow, /owner: blancmathis/);
  assert.match(workflow, /repositories: peerlab-qm/);
  assert.match(workflow, /permission-actions: write/);
  assert.match(workflow, /gh workflow run update-context-room-image\.yml/);
  assert.match(workflow, /--repo blancmathis\/peerlab-qm/);
  assert.match(workflow, /--ref main/);
  assert.match(workflow, /-f source_sha="\$\{SOURCE_SHA\}"/);
  assert.match(workflow, /-f image="\$\{image\}"/);
  assert.match(workflow, /-f correlation_id="\$\{CORRELATION_ID\}"/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.qm-deploy-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow, /PEERLAB_QM_DEPLOY_APP_PRIVATE_KEY[^\n]*run:/);
  assert.match(deploymentDoc, /starts only after the `CI` workflow has completed successfully for a same-repository push on `main`/);
  assert.match(deploymentDoc, /locates exactly one downstream run/);
  assert.match(deploymentDoc, /waits for the exact `Validate and deploy · <correlation-id>` run/);
  assert.doesNotMatch(deploymentDoc, /No polling is involved/);
});

test("the main image is built only after CI succeeds for the exact main commit", () => {
  const workflow = workflowSource();
  const document = workflowDocument();

  assert.match(workflow, /workflow_run:/);
  assert.doesNotMatch(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /^  push:/m);
  assert.match(workflow, /workflows:\s*\[CI\]/);
  assert.match(workflow, /types:\s*\[completed\]/);
  assert.match(workflow, /branches:\s*\[main\]/);
  assert.match(
    workflow,
    /if:\s*(?:\$\{\{\s*)?github\.event\.workflow_run\.conclusion\s*==\s*['"]success['"][^\n]*github\.event\.workflow_run\.head_branch\s*==\s*['"]main['"]/
  );
  assert.match(workflow, /github\.event\.workflow_run\.event\s*==\s*['"]push['"]/);
  assert.match(workflow, /github\.event\.workflow_run\.head_repository\.full_name\s*==\s*github\.repository/);
  assert.match(workflow, /ref:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/);
  assert.match(workflow, /SOURCE_SHA:\s*\$\{\{\s*github\.event\.workflow_run\.head_sha\s*\}\}/);
  assert.match(workflow, /tags:[^\n]*(?:\$\{\{\s*env\.SOURCE_SHA\s*\}\}|\$\{SOURCE_SHA\})/);
  assert.match(workflow, /name:\s*context-room-remote-\$\{\{\s*env\.SOURCE_SHA\s*\}\}/);
  assert.match(workflow, /-f source_sha="(?:\$\{SOURCE_SHA\}|\$\{\{\s*env\.SOURCE_SHA\s*\}\})"/);
  assert.doesNotMatch(workflow, /-f source_sha="\$\{GITHUB_SHA\}"/);
  assert.doesNotMatch(workflow, /github\.sha/i);
  assert.equal(document.concurrency, undefined);
  assert.deepEqual(document.jobs.image.concurrency, {
    group: "context-room-remote-main",
    "cancel-in-progress": true,
  });
  assert.equal(document.jobs.image["timeout-minutes"], 90);
});

test("stale CI reruns cannot build or dispatch an obsolete main image", () => {
  const document = workflowDocument();
  const eligibility = document.jobs.eligibility;
  const steps = document.jobs.image.steps;
  const currentMainChecks = steps.filter((step) => step.run?.includes("git ls-remote --exit-code origin refs/heads/main"));

  assert.equal(eligibility.concurrency, undefined);
  assert.equal(eligibility.outputs.current, "${{ steps.source-current.outputs.current }}");
  assert.match(eligibility.steps[0].run, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/git\/ref\/heads\/main"/);
  assert.equal(document.jobs.image.needs, "eligibility");
  assert.equal(document.jobs.image.if, "needs.eligibility.outputs.current == 'true'");
  assert.equal(currentMainChecks.length, 2);
  assert.equal(currentMainChecks[0].id, "source-current-before-build");
  assert.equal(currentMainChecks[1].name, "Dispatch the exact signed image to Peerlab QM");
  assert.match(currentMainChecks[0].run, /current=false/);
  assert.match(currentMainChecks[1].run, /Not dispatching obsolete CI source/);

  const buildStep = steps.find((step) => step.id === "build");
  const appTokenStep = steps.find((step) => step.id === "qm-deploy-token");
  const dispatchStep = steps.find((step) => step.name === "Dispatch the exact signed image to Peerlab QM");
  assert.equal(buildStep.if, "steps.source-current-before-build.outputs.current == 'true'");
  assert.equal(appTokenStep.if, "steps.source-current-before-build.outputs.current == 'true'");
  assert.equal(dispatchStep.if, "steps.source-current-before-build.outputs.current == 'true'");

  const finalFreshnessCheck = dispatchStep.run.lastIndexOf("git ls-remote --exit-code origin refs/heads/main");
  const downstreamDispatch = dispatchStep.run.indexOf("gh workflow run update-context-room-image.yml");
  assert.ok(finalFreshnessCheck > 0);
  assert.ok(downstreamDispatch > finalFreshnessCheck);
  assert.doesNotMatch(dispatchStep.run.slice(finalFreshnessCheck, downstreamDispatch), /sleep|gh run list|gh run watch/);
});

test("image reruns use distinct correlations and wait for the exact Peerlab QM run", () => {
  const workflow = workflowSource();
  const document = workflowDocument();
  const correlationTemplate = document.jobs.image.env.CORRELATION_ID;

  assert.equal(
    correlationTemplate,
    "context-room-${{ github.event.workflow_run.head_sha }}-${{ github.run_id }}-${{ github.run_attempt }}",
  );
  const firstAttempt = correlationTemplate
    .replace("${{ github.event.workflow_run.head_sha }}", "a".repeat(40))
    .replace("${{ github.run_id }}", "4100")
    .replace("${{ github.run_attempt }}", "1");
  const rerunAttempt = correlationTemplate
    .replace("${{ github.event.workflow_run.head_sha }}", "a".repeat(40))
    .replace("${{ github.run_id }}", "4100")
    .replace("${{ github.run_attempt }}", "2");
  assert.notEqual(firstAttempt, rerunAttempt);
  assert.doesNotMatch(workflow, /CORRELATION_ID:[^\n]*github\.event\.workflow_run\.(?:id|run_attempt)/);
  assert.match(workflow, /gh workflow run update-context-room-image\.yml/);
  assert.match(workflow, /gh run list[\s\S]*--workflow\s+update-context-room-image\.yml/);
  assert.match(workflow, /gh run list[\s\S]*--event\s+workflow_dispatch/);
  assert.match(workflow, /gh run list[\s\S]*--json databaseId,displayTitle/);
  assert.match(workflow, /expected_title="Update Context Room image · \$\{CORRELATION_ID\}"/);
  assert.match(workflow, /select\(\.displayTitle == \\"\$\{expected_title\}\\"\)/);
  assert.match(workflow, /for attempt in \$\(seq 1 30\)/);
  assert.match(workflow, /More than one Peerlab QM updater run matched the exact correlation ID/);
  assert.match(workflow, /did not appear within 60 seconds/);
  assert.match(workflow, /gh run watch[\s\S]*--repo\s+blancmathis\/peerlab-qm/);
  assert.match(workflow, /gh run watch[\s\S]*--exit-status/);
  assert.doesNotMatch(workflow, /baseline_runs|dispatch_started_at|createdAt/);
});

test("the exact updater run is watched with a freshly issued repository-scoped token", () => {
  const document = workflowDocument();
  const steps = document.jobs.image.steps;
  const tokenSteps = steps.filter((step) => step.uses?.startsWith("actions/create-github-app-token@"));
  const dispatchStep = steps.find((step) => step.id === "qm-dispatch");
  const watchTokenStep = steps.find((step) => step.id === "qm-watch-token");
  const watchStep = steps.find((step) => step.name === "Watch the exact Peerlab QM deployment");

  assert.equal(tokenSteps.length, 2);
  assert.equal(tokenSteps[0].id, "qm-deploy-token");
  assert.equal(tokenSteps[1].id, "qm-watch-token");
  assert.match(dispatchStep.run, /run_id=%s\\n[^\n]*\$\{run_id\}[^\n]*GITHUB_OUTPUT/);
  assert.doesNotMatch(dispatchStep.run, /gh run watch/);
  assert.equal(watchStep.env.GH_TOKEN, "${{ steps.qm-watch-token.outputs.token }}");
  assert.equal(watchStep.env.QM_RUN_ID, "${{ steps.qm-dispatch.outputs.run_id }}");
  assert.match(watchStep.run, /gh run watch "\$\{QM_RUN_ID\}"/);
  assert.match(watchStep.run, /--exit-status/);
  assert.equal(steps.indexOf(watchTokenStep), steps.indexOf(watchStep) - 1);
});

test("the workflow YAML and embedded Bash scripts are syntactically valid", () => {
  const document = workflowDocument();
  assert.equal(document.name, "Build remote Context Room image");

  for (const job of Object.values(document.jobs)) {
    for (const step of job.steps) {
      if (!step.run) continue;
      const result = spawnSync("bash", ["-n"], { input: step.run, encoding: "utf8" });
      assert.equal(result.status, 0, `${step.name || step.id || "unnamed step"}: ${result.stderr}`);
    }
  }
});
