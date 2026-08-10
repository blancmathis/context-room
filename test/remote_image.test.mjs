import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the remote image contains the built-in documentation profile required at boot", () => {
  const dockerfile = fs.readFileSync(path.join(repositoryRoot, "Dockerfile.remote"), "utf8");
  const dockerignore = fs.readFileSync(path.join(repositoryRoot, ".dockerignore"), "utf8");
  const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "remote-image.yml"), "utf8");
  const entrypoint = fs.readFileSync(path.join(repositoryRoot, "bin", "context-room-remote.mjs"), "utf8");

  assert.match(dockerfile, /^COPY docs \.\/docs$/m);
  assert.match(dockerfile, /^COPY profiles \.\/profiles$/m);
  assert.match(dockerfile, /org\.opencontainers\.image\.revision="\$\{CONTEXT_ROOM_BUILD_REVISION\}"/);
  assert.match(dockerfile, /org\.opencontainers\.image\.version="\$\{CONTEXT_ROOM_BUILD_VERSION\}"/);
  assert.match(dockerfile, /\/\^\[a-f0-9\]\{40\}\$\//);
  assert.match(dockerfile, /const semver = \/\^\(0\|\[1-9\]\[0-9\]\*\)/);
  const semverLiteral = dockerfile.match(/const semver = (\/\^[^;]+\/);/)?.[1];
  assert.ok(semverLiteral);
  const strictSemver = Function(`"use strict"; return (${semverLiteral});`)();
  assert.equal(strictSemver.test("1.2.3-01"), false);
  assert.equal(strictSemver.test("01.2.3"), false);
  assert.equal(strictSemver.test("1.2.3-alpha.1+build.01"), true);
  assert.match(workflow, /const semver = \/\^\(0\|\[1-9\]\[0-9\]\*\)/);
  assert.match(dockerfile, /version !== require\("\.\/package\.json"\)\.version/);
  assert.match(dockerfile, /> \/app\/\.context-room-build-revision/);
  assert.doesNotMatch(dockerfile, /chown[^\n]*\/app/);
  assert.ok(dockerfile.indexOf("RUN npm ci --omit=dev") < dockerfile.indexOf("ARG CONTEXT_ROOM_BUILD_REVISION"));
  assert.match(dockerfile, /^ENV CONTEXT_ROOM_BUILD_REVISION=\$\{CONTEXT_ROOM_BUILD_REVISION\}$/m);
  assert.match(dockerfile, /^FROM node:24-slim@sha256:[a-f0-9]{64}$/m);
  assert.match(dockerfile, /^USER context-room$/m);
  assert.deepEqual(dockerignore.trim().split("\n"), [
    "**",
    "!Dockerfile.remote",
    "!package.json",
    "!package-lock.json",
    "!bin/",
    "!bin/**",
    "!docs/",
    "!docs/**",
    "!profiles/",
    "!profiles/**",
    "!schemas/",
    "!schemas/**",
    "!src/",
    "!src/**",
  ]);
  assert.match(workflow, /^  workflow_run:$/m);
  assert.match(workflow, /^    workflows: \[CI\]$/m);
  assert.match(workflow, /github\.event\.workflow_run\.head_sha/);
  assert.doesNotMatch(workflow, /^  push:$/m);
  assert.match(workflow, /initializeContextRoomProject/);
  assert.match(workflow, /CONTEXT_ROOM_BUILD_REVISION=\$\{\{ env\.SOURCE_SHA \}\}/);
  assert.match(workflow, /CONTEXT_ROOM_BUILD_VERSION=\$\{\{ steps\.package\.outputs\.version \}\}/);
  assert.match(workflow, /org\.opencontainers\.image\.revision/);
  assert.match(entrypoint, /\.context-room-build-revision/);
  assert.match(entrypoint, /configured !== baked/);

  const firstProjectImport = entrypoint.indexOf('import("../src/');
  assert.ok(firstProjectImport > 0, "the remote entrypoint must dynamically import project modules");
  assert.doesNotMatch(entrypoint, /^import\s+[\s\S]*?from\s+["']\.\.\/src\//m);
  assert.deepEqual(
    [...entrypoint.matchAll(/\bimport\("(\.\.\/src\/[^"\n]+)"\)/g)].map((match) => match[1]),
    [
      "../src/filesystem_lock.mjs",
      "../src/github_app_token.mjs",
      "../src/shared_context.mjs",
      "../src/context_room.mjs",
    ],
  );
  for (const environmentName of [
    "CONTEXT_ROOM_DATA_ROOT",
    "HOME",
    "CONTEXT_ROOM_HUB_HOME",
    "CONTEXT_ROOM_SHARED_HOME",
    "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME",
    "CONTEXT_ROOM_SNAPSHOT_HOME",
    "CODEX_HOME",
    "HERMES_HOME",
  ]) {
    const assignment = entrypoint.indexOf(`process.env.${environmentName} =`);
    assert.ok(assignment > 0, `${environmentName} must be assigned by the remote entrypoint`);
    assert.ok(
      assignment < firstProjectImport,
      `${environmentName} must be isolated before project modules are imported`,
    );
  }

  assert.match(entrypoint, /CONTEXT_ROOM_SHARED_REPOSITORIES_FILE/);
  assert.match(entrypoint, /const configured = entries\.map\(\(entry\) => \{/);
  assert.match(entrypoint, /repositoryIdentities\.has\(repository\.identity\)/);
  assert.match(entrypoint, /projectIdentities\.has\(projectId\)/);
  assert.match(entrypoint, /const repositoryIds = new Set\(configured\.map\(\(entry\) => entry\.repositoryId\)\)/);
  assert.match(entrypoint, /repositoryIds\.has\(projectId\)/);
  assert.match(entrypoint, /projectIds: Object\.freeze\(projectIds\)/);
  assert.match(entrypoint, /scopes: Object\.freeze\(scopes\)/);
  assert.match(entrypoint, /return Object\.freeze\(configured\)/);
  assert.match(entrypoint, /for \(const entry of configuration\.sharedRepositories\)/);
  assert.match(
    entrypoint,
    /sharedRepositories: configuration\.sharedRepositories\.map\(\(\{ repository, projectIds, scopes \}\) => \(\{ repository, projectIds, scopes \}\)\)/,
  );
  assert.doesNotMatch(entrypoint, /\b(?:registerContextHubProject|unregisterContextHubProject|contextHubUiState|writeContextHubSnapshot|refreshContextHubSnapshot|readContextHubSnapshot|readContextHubRegistry)\b/);
  assert.equal(
    fs.existsSync(path.join(repositoryRoot, "profiles", "context-room-documentation.profile.json")),
    true,
  );
});
