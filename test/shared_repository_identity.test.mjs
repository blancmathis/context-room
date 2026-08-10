import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  contextHubRepositoryIdentity,
  readContextHubRegistry,
  registerContextHubSharedRepository,
} from "../src/context_hub.mjs";
import {
  detectSharedProject,
  initializeSharedRepository,
  readSharedMainRevision,
  readSharedProjectConnection,
} from "../src/shared_context.mjs";

function git(cwd, args, options = {}) {
  return String(execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
  }) || "").trim();
}

function configureGit(root) {
  git(root, ["config", "user.email", "identity@example.test"]);
  git(root, ["config", "user.name", "Shared identity test"]);
}

function writeFile(root, relativePath, content) {
  const target = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content, "utf8");
}

function withHomes(t, base) {
  const previousShared = process.env.CONTEXT_ROOM_SHARED_HOME;
  const previousHub = process.env.CONTEXT_ROOM_HUB_HOME;
  process.env.CONTEXT_ROOM_SHARED_HOME = path.join(base, "shared-home");
  process.env.CONTEXT_ROOM_HUB_HOME = path.join(base, "hub-home");
  t.after(() => {
    if (previousShared === undefined) delete process.env.CONTEXT_ROOM_SHARED_HOME;
    else process.env.CONTEXT_ROOM_SHARED_HOME = previousShared;
    if (previousHub === undefined) delete process.env.CONTEXT_ROOM_HUB_HOME;
    else process.env.CONTEXT_ROOM_HUB_HOME = previousHub;
  });
}

function makeSharedRepository(base, projects) {
  const remote = path.join(base, "shared.git");
  const seed = path.join(base, "shared-seed");
  git(base, ["init", "--bare", "--initial-branch=main", remote], { stdio: "ignore" });
  git(base, ["clone", remote, seed], { stdio: "ignore" });
  configureGit(seed);
  initializeSharedRepository(seed, { name: "Repository identity fixture" });
  writeFile(seed, "projects.json", JSON.stringify({ version: 1, projects }, null, 2) + "\n");
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", "Initialize identity fixture"]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed };
}

function makeSourceRepository(base, remotes) {
  const root = path.join(base, "source");
  fs.mkdirSync(root, { recursive: true });
  git(root, ["init"]);
  configureGit(root);
  writeFile(root, "README.md", "# Source\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "Initialize source"]);
  for (const [name, remote] of remotes) git(root, ["remote", "add", name, remote]);
  return root;
}

function cacheKey(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

test("Shared source detection preserves non-GitHub SSH users and transport forms", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-source-identity-"));
  withHomes(t, base);
  const aliceScp = "alice@git.example.test:team/product.git";
  const repository = makeSharedRepository(base, [
    { id: "bob", source: { remotes: ["bob@git.example.test:team/product.git"], subpath: "." } },
    { id: "alice-url", source: { remotes: ["ssh://alice@git.example.test/team/product.git"], subpath: "." } },
    { id: "alice-scp", source: { remotes: [aliceScp], subpath: "." } },
  ]);
  const source = makeSourceRepository(base, [["origin", aliceScp]]);

  const detected = detectSharedProject(source, { repository: repository.remote });
  assert.equal(detected.projectId, "alice-scp");
});

test("Shared binding resolution rejects equally specific origin and upstream matches", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-binding-ambiguity-"));
  withHomes(t, base);
  const origin = "alice@git-a.example.test:team/product.git";
  const upstream = "alice@git-b.example.test:team/product.git";
  const source = makeSourceRepository(base, [["origin", origin], ["upstream", upstream]]);
  const sharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  fs.mkdirSync(sharedHome, { recursive: true });
  fs.writeFileSync(path.join(sharedHome, "registry.json"), JSON.stringify({
    version: 1,
    bindings: [
      {
        repository: path.join(base, "shared-a.git"),
        repositoryIdentity: contextHubRepositoryIdentity(path.join(base, "shared-a.git")),
        projectId: "project-a",
        sourceIdentityVersion: 2,
        sourceRemotes: [origin],
        sourceRemoteIdentities: [contextHubRepositoryIdentity(origin)],
        sourceSubpath: ".",
        projectRoots: [],
      },
      {
        repository: path.join(base, "shared-b.git"),
        repositoryIdentity: contextHubRepositoryIdentity(path.join(base, "shared-b.git")),
        projectId: "project-b",
        sourceIdentityVersion: 2,
        sourceRemotes: [upstream],
        sourceRemoteIdentities: [contextHubRepositoryIdentity(upstream)],
        sourceSubpath: ".",
        projectRoots: [],
      },
    ],
  }, null, 2) + "\n");

  assert.throws(
    () => readSharedProjectConnection(source),
    (error) => error?.code === "shared_context_binding_ambiguous"
      && error?.statusCode === 409
      && error?.details?.candidates?.length === 2,
  );
});

test("short-host SCP repositories remain SSH transports independent of cwd", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-short-scp-"));
  withHomes(t, base);
  const repository = "buildbox:team/repo.git";
  assert.equal(contextHubRepositoryIdentity(repository), "scp:buildbox:team/repo.git");
  assert.equal(registerContextHubSharedRepository(repository).repository, repository);
  assert.equal(readContextHubRegistry().sharedRepositories.length, 1);
});

test("macOS local-host file URLs share one identity and cache while non-local hosts fail closed", {
  skip: process.platform !== "darwin",
}, (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-file-host-"));
  withHomes(t, base);
  const repository = makeSharedRepository(base, [{ id: "demo", title: "Demo" }]);
  const hostedUrl = pathToFileURL(repository.remote);
  hostedUrl.hostname = os.hostname();

  const localIdentity = contextHubRepositoryIdentity(repository.remote);
  assert.equal(contextHubRepositoryIdentity(hostedUrl.href), localIdentity);
  assert.throws(
    () => contextHubRepositoryIdentity(`file://not-local.invalid${repository.remote}`),
    (error) => error?.code === "shared_repository_file_host_not_local",
  );

  readSharedMainRevision(repository.remote);
  readSharedMainRevision(hostedUrl.href);
  const sharedHome = process.env.CONTEXT_ROOM_SHARED_HOME;
  const activeCaches = fs.readdirSync(sharedHome)
    .filter((name) => /^[a-f0-9]{16}$/.test(name) && fs.existsSync(path.join(sharedHome, name, "repository")));
  assert.equal(activeCaches.length, 1);

  const duplicateCache = path.join(sharedHome, cacheKey(hostedUrl.href));
  fs.mkdirSync(duplicateCache, { recursive: true });
  fs.writeFileSync(path.join(duplicateCache, "repository-identity.json"), JSON.stringify({
    version: 1,
    repository: hostedUrl.href,
    identity: localIdentity,
  }, null, 2) + "\n");
  assert.throws(
    () => readSharedMainRevision(repository.remote, { refresh: false }),
    (error) => error?.code === "shared-repository-identity-mismatch"
      && /Multiple Shared repository caches/.test(error.message),
  );
});
