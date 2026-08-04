import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("the signed main image dispatches the exact Peerlab QM deployment", () => {
  const workflow = readFileSync(".github/workflows/remote-image.yml", "utf8");
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
  assert.match(workflow, /-f source_sha="\$\{GITHUB_SHA\}"/);
  assert.match(workflow, /-f image="\$\{image\}"/);
  assert.match(workflow, /GH_TOKEN: \$\{\{ steps\.qm-deploy-token\.outputs\.token \}\}/);
  assert.doesNotMatch(workflow, /PEERLAB_QM_DEPLOY_APP_PRIVATE_KEY[^\n]*run:/);
  assert.match(deploymentDoc, /successful signed image build dispatches the exact commit and digest/);
  assert.match(deploymentDoc, /No polling is involved/);
});
