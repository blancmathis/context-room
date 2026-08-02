import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the remote image contains the built-in documentation profile required at boot", () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, "Dockerfile.remote"), "utf8");
  const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "remote-image.yml"), "utf8");

  assert.match(dockerfile, /^COPY docs \.\/docs$/m);
  assert.match(dockerfile, /^COPY profiles \.\/profiles$/m);
  assert.match(workflow, /^      - docs\/\*\*$/m);
  assert.match(workflow, /^      - profiles\/\*\*$/m);
  assert.match(workflow, /initializeContextRoomProject/);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "profiles", "context-room-documentation.profile.json")),
    true,
  );
});
