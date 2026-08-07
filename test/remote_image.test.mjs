import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the remote image contains the built-in documentation profile required at boot", () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, "Dockerfile.remote"), "utf8");
  const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "remote-image.yml"), "utf8");
  const entrypoint = fs.readFileSync(path.join(repositoryRoot, "bin", "context-room-remote.mjs"), "utf8");

  assert.match(dockerfile, /^COPY docs \.\/docs$/m);
  assert.match(dockerfile, /^COPY profiles \.\/profiles$/m);
  assert.match(workflow, /^  workflow_run:$/m);
  assert.match(workflow, /^    workflows: \[CI\]$/m);
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.doesNotMatch(workflow, /^  push:$/m);
  assert.match(workflow, /initializeContextRoomProject/);
  assert.match(entrypoint, /unregisterContextHubProject\(root\)/);
  assert.doesNotMatch(entrypoint, /(?:^|[^A-Za-z])registerContextHubProject\(root/m);
  assert.match(entrypoint, /contextHubUiState\(hostRoot/);
  assert.match(entrypoint, /writeContextHubSnapshot\(initialContextHub/);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "profiles", "context-room-documentation.profile.json")),
    true,
  );
});
