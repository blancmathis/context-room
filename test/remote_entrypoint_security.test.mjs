import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  attestSharedProjectCapability,
  createSharedProposal,
  initializeSharedRepository,
  materializeSharedReview,
  publishSharedProposal,
} from "../src/shared_context.mjs";
import { contextHubRepositoryIdentity } from "../src/context_hub.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const remoteEntrypoint = path.join(repositoryRoot, "bin", "context-room-remote.mjs");
const canonicalTemporaryRoot = fs.realpathSync(os.tmpdir());
const buildRevision = "a".repeat(40);

function removeWritableTree(root) {
  if (!fs.existsSync(root)) return;
  const visit = (target) => {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink()) return;
    try { fs.chmodSync(target, stat.isDirectory() ? 0o700 : 0o600); } catch {}
    if (stat.isDirectory()) for (const name of fs.readdirSync(target)) visit(path.join(target, name));
  };
  visit(root);
  fs.rmSync(root, { recursive: true, force: true });
}

function temporaryDirectory(t, name) {
  const root = fs.mkdtempSync(path.join(canonicalTemporaryRoot, `context-room-${name}-`));
  t.after(() => removeWritableTree(root));
  return root;
}

function snapshotNode(target) {
  try {
    const stat = fs.lstatSync(target);
    return {
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode & 0o7777,
      type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      ...(stat.isSymbolicLink() ? { target: fs.readlinkSync(target) } : {}),
      ...(stat.isFile() ? { nlink: stat.nlink, bytes: fs.readFileSync(target).toString("base64") } : {}),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function snapshotTree(root) {
  const entries = [];
  const visit = (target, relative = ".") => {
    const stat = fs.lstatSync(target);
    entries.push({
      path: relative,
      dev: stat.dev,
      ino: stat.ino,
      mode: stat.mode & 0o7777,
      nlink: stat.nlink,
      size: stat.size,
      type: stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other",
      ...(stat.isSymbolicLink() ? { target: fs.readlinkSync(target) } : {}),
      ...(stat.isFile() ? { bytes: fs.readFileSync(target).toString("base64") } : {}),
    });
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name), relative === "." ? name : `${relative}/${name}`);
    }
  };
  if (fs.existsSync(root)) visit(root);
  return entries;
}

function writePrivateFile(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { encoding: "utf8", mode });
  fs.chmodSync(file, mode);
  return file;
}

function minimalEntrypointEnvironment(dataRoot, overrides = {}) {
  const inheritedRuntimePaths = Object.fromEntries(
    ["TMPDIR", "TMP", "TEMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
  return {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || os.homedir(),
    ...inheritedRuntimePaths,
    CONTEXT_ROOM_REMOTE: "1",
    CONTEXT_ROOM_BUILD_REVISION: buildRevision,
    CONTEXT_ROOM_DATA_ROOT: dataRoot,
    CONTEXT_ROOM_SHARED_REPOSITORY: "https://github.com/example/context-room-shared.git",
    CONTEXT_ROOM_PROJECT_IDS: "demo",
    CONTEXT_ROOM_PUBLIC_HOST: "context.example.test",
    ...overrides,
  };
}

function runEntrypoint(dataRoot, overrides = {}, timeout = 10_000) {
  return spawnSync(process.execPath, [remoteEntrypoint], {
    env: minimalEntrypointEnvironment(dataRoot, overrides),
    encoding: "utf8",
    timeout,
  });
}

function signingFiles(root) {
  return {
    CONTEXT_ROOM_HUMAN_SECRET_FILE: writePrivateFile(path.join(root, "human.secret"), "human-".padEnd(48, "h")),
    CONTEXT_ROOM_AGENT_SECRET_FILE: writePrivateFile(path.join(root, "agent.secret"), "agent-".padEnd(48, "a")),
    CONTEXT_ROOM_HEALTH_SECRET_FILE: writePrivateFile(path.join(root, "health.secret"), "health-".padEnd(48, "z")),
  };
}

function completeEntrypointEnvironment(dataRoot, externalRoot, overrides = {}) {
  return minimalEntrypointEnvironment(dataRoot, {
    ...signingFiles(externalRoot),
    CONTEXT_ROOM_ADMIN_SUBJECTS: "mathis",
    CONTEXT_ROOM_HOST: "127.0.0.1",
    CONTEXT_ROOM_PORT: "43179",
    ...overrides,
  });
}

function assertPreEffectFailure(result, before, root, pattern) {
  assert.equal(result.signal, null, result.stderr || result.stdout);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stderr, pattern);
  assert.doesNotMatch(result.stderr, /human-hhhhh|agent-aaaaa|health-zzzzz/);
  assert.deepEqual(snapshotTree(root), before);
}

function repositoryId(owner, name) {
  return createHash("sha256").update(`github:${owner.toLowerCase()}/${name.toLowerCase()}`).digest("hex").slice(0, 24);
}

function sharedCacheId(repository) {
  return createHash("sha256").update(contextHubRepositoryIdentity(repository)).digest("hex").slice(0, 16);
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: options.stdio || ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...options.env },
  });
}

function createSharedGitFixture(base, name, projectIds) {
  const remote = path.join(base, `${name}.git`);
  const seed = path.join(base, `${name}-seed`);
  git(base, ["init", "--bare", "--initial-branch=main", remote]);
  git(base, ["clone", remote, seed]);
  git(seed, ["config", "user.name", "Context Room test"]);
  git(seed, ["config", "user.email", "context-room-test@example.test"]);
  initializeSharedRepository(seed, { name: `${name} Shared Context` });
  fs.writeFileSync(path.join(seed, "projects.json"), `${JSON.stringify({
    version: 1,
    projects: projectIds.map((id) => ({ id, title: id })),
  }, null, 2)}\n`, "utf8");
  for (const projectId of projectIds) {
    const document = path.join(seed, "projects", projectId, "docs", "README.md");
    fs.mkdirSync(path.dirname(document), { recursive: true });
    fs.writeFileSync(document, `# ${projectId}\n\nAccepted shared documentation.\n`, "utf8");
  }
  git(seed, ["add", "."]);
  git(seed, ["commit", "-m", `Initialize ${name}`]);
  git(seed, ["push", "origin", "main"]);
  return { remote, seed };
}

function installCountingGitWrapper(base, repositoryMap, {
  requireGitHubAuthorization = false,
  forbiddenCredentialValues = [],
} = {}) {
  const wrapperRoot = path.join(base, "git-wrapper");
  const countFile = path.join(base, "git-operations.jsonl");
  const wrapper = path.join(wrapperRoot, "git");
  fs.mkdirSync(wrapperRoot, { recursive: true });
  fs.writeFileSync(wrapper, `#!/usr/bin/env node
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const { createHash } = require("node:crypto");
const path = require("node:path");
const args = process.argv.slice(2);
let commandIndex = 0;
while (args[commandIndex] === "-c" && commandIndex + 1 < args.length) commandIndex += 2;
const operation = args[commandIndex] || "";
const replacements = JSON.parse(process.env.CR_TEST_REPOSITORY_MAP || "{}");
let clonedLogicalRepository = "";
let matchedLogicalRepository = false;
let logicalRepository = "";
for (let index = 0; index < args.length; index += 1) {
  if (!Object.prototype.hasOwnProperty.call(replacements, args[index])) continue;
  matchedLogicalRepository = true;
  logicalRepository = args[index];
  if (operation === "clone") clonedLogicalRepository = args[index];
  args[index] = replacements[args[index]];
}
let authenticated = false;
let credentialHash = "";
let helperConfigured = false;
let brokerRoot = "";
let brokerDirectoryMode = 0;
let socketMode = 0;
if (matchedLogicalRepository && ["clone", "fetch", "push", "ls-remote"].includes(operation)) {
  const prefix = args.slice(0, commandIndex);
  const helper = prefix.find((value) => String(value).includes(" credential-cache ")) || "";
  const socketMatch = String(helper).match(/--socket=(?:'([^']+)'|"([^"]+)"|([^ ]+))/);
  helperConfigured = Boolean(socketMatch);
  if (socketMatch) {
    const socketPath = socketMatch[1] || socketMatch[2] || socketMatch[3];
    brokerRoot = path.dirname(socketPath);
    try { brokerDirectoryMode = fs.statSync(brokerRoot).mode & 511; } catch {}
    try { socketMode = fs.lstatSync(socketPath).mode & 511; } catch {}
  }
  const parsed = new URL(logicalRepository);
  const input = Buffer.from("protocol=https\\nhost=github.com\\npath=" + parsed.pathname.slice(1) + "\\n\\n", "utf8");
  const filled = spawnSync(process.env.CR_TEST_REAL_GIT, [...prefix, "credential", "fill"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: process.env.CR_TEST_ORIGINAL_PATH },
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  input.fill(0);
  const password = String(filled.stdout || "").split("\\n").find((line) => line.startsWith("password="))?.slice("password=".length) || "";
  authenticated = filled.status === 0 && Boolean(password);
  credentialHash = authenticated ? createHash("sha256").update(password).digest("hex") : "";
  const forbidden = new Set(JSON.parse(process.env.CR_TEST_FORBIDDEN_CREDENTIAL_HASHES || "[]"));
  const containsForbidden = (values) => values.some((value) => forbidden.has(createHash("sha256").update(String(value)).digest("hex")));
  const procEntries = (file) => {
    try { return fs.readFileSync(file).toString("utf8").split("\\0").filter(Boolean); } catch { return []; }
  };
  fs.appendFileSync(process.env.CR_TEST_GIT_AUTH_FILE, JSON.stringify({
    operation,
    authenticated,
    credentialHash,
    helperConfigured,
    brokerRoot,
    brokerDirectoryMode,
    socketMode,
    environmentContainsCredential: containsForbidden(Object.values(process.env)),
    argvContainsCredential: containsForbidden(args),
    procEnvironmentContainsCredential: containsForbidden(procEntries("/proc/self/environ").map((entry) => entry.slice(entry.indexOf("=") + 1))),
    procArgvContainsCredential: containsForbidden(procEntries("/proc/self/cmdline")),
  }) + "\\n");
  if (process.env.CR_TEST_REQUIRE_GITHUB_AUTH === "1" && !authenticated) process.exit(87);
}
if (operation === "clone" || operation === "fetch" || operation === "ls-remote") {
  fs.appendFileSync(process.env.CR_TEST_GIT_COUNT_FILE, JSON.stringify({ operation, args }) + "\\n");
}
if (operation === "clone" || operation === "fetch") {
  const failOnce = process.env.CR_TEST_FAIL_GIT_ONCE_FILE;
  if (failOnce && !fs.existsSync(failOnce)) {
    fs.writeFileSync(failOnce, operation);
    process.exit(86);
  }
}
let effectiveArgs = args;
if (operation === "fetch" || operation === "push") {
  const origin = spawnSync(process.env.CR_TEST_REAL_GIT, ["config", "--get", "remote.origin.url"], {
    cwd: process.cwd(),
    env: { ...process.env, PATH: process.env.CR_TEST_ORIGINAL_PATH },
    encoding: "utf8",
  });
  const fixture = replacements[String(origin.stdout || "").trim()];
  if (fixture) effectiveArgs = ["-c", "remote.origin.url=" + fixture, ...args];
}
const result = spawnSync(process.env.CR_TEST_REAL_GIT, effectiveArgs, {
  cwd: process.cwd(),
  env: { ...process.env, PATH: process.env.CR_TEST_ORIGINAL_PATH },
  stdio: "inherit",
});
if (result.error) throw result.error;
if (result.status === 0 && operation === "clone" && clonedLogicalRepository) {
  const checkout = args[args.length - 1];
  const restored = spawnSync(process.env.CR_TEST_REAL_GIT, ["-C", checkout, "remote", "set-url", "origin", clonedLogicalRepository], {
    env: { ...process.env, PATH: process.env.CR_TEST_ORIGINAL_PATH },
    stdio: "inherit",
  });
  if (restored.error) throw restored.error;
  if (restored.status !== 0) process.exit(restored.status === null ? 1 : restored.status);
}
process.exit(result.status === null ? 1 : result.status);
`, { mode: 0o700 });
  fs.chmodSync(wrapper, 0o700);
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  return {
    countFile,
    authFile: path.join(base, "git-authorization.jsonl"),
    env: {
      PATH: `${wrapperRoot}${path.delimiter}${process.env.PATH || "/usr/bin:/bin"}`,
      CR_TEST_REPOSITORY_MAP: JSON.stringify(repositoryMap),
      CR_TEST_GIT_COUNT_FILE: countFile,
      CR_TEST_REAL_GIT: realGit,
      CR_TEST_ORIGINAL_PATH: process.env.PATH || "/usr/bin:/bin",
      CR_TEST_GIT_AUTH_FILE: path.join(base, "git-authorization.jsonl"),
      CR_TEST_FORBIDDEN_CREDENTIAL_HASHES: JSON.stringify(forbiddenCredentialValues
        .map((value) => createHash("sha256").update(String(value)).digest("hex"))),
      ...(requireGitHubAuthorization ? { CR_TEST_REQUIRE_GITHUB_AUTH: "1" } : {}),
    },
  };
}

function countedGitOperations(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function jsonLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function installTemporaryEnvironment(overrides) {
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  return () => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function credentialRepresentations(token) {
  const userPassword = `x-access-token:${token}`;
  const encoded = Buffer.from(userPassword, "utf8").toString("base64");
  return [token, userPassword, encoded, `Authorization: Basic ${encoded}`];
}

function assertTreeExcludesBytes(root, forbidden) {
  const needles = forbidden.map((value) => Buffer.from(String(value), "utf8"));
  for (const entry of snapshotTree(root).filter((item) => item.type === "file")) {
    const bytes = Buffer.from(entry.bytes, "base64");
    for (const needle of needles) {
      assert.equal(bytes.includes(needle), false, `secret bytes persisted in ${entry.path}`);
    }
  }
}

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startRemoteEntrypoint(env, timeoutMs = 30_000) {
  const child = spawn(process.execPath, [remoteEntrypoint], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const exit = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Remote entrypoint did not listen in time\n${stdout}\n${stderr}`)), timeoutMs);
    const inspect = () => {
      if (!stdout.includes("remote server listening")) return;
      clearTimeout(timer);
      resolve();
    };
    child.stdout.on("data", inspect);
    exit.then(({ code, signal }) => {
      if (stdout.includes("remote server listening")) return;
      clearTimeout(timer);
      reject(new Error(`Remote entrypoint exited before listening (${code || signal})\n${stdout}\n${stderr}`));
    });
  });
  return { child, exit, stdout: () => stdout, stderr: () => stderr };
}

async function stopRemoteEntrypoint(instance) {
  instance.child.kill("SIGTERM");
  const result = await Promise.race([
    instance.exit,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Remote entrypoint did not stop after SIGTERM")), 10_000)),
  ]);
  assert.equal(result.signal, null, instance.stderr());
  assert.equal(result.code, 0, instance.stderr());
}

test("remote data root rejects protected roots and every symlink component before startup effects", (t) => {
  const base = temporaryDirectory(t, "remote-data-root-boundary");
  const protectedCandidates = new Set([
    path.parse(repositoryRoot).root,
    "/Applications", "/app", "/bin", "/boot", "/dev", "/etc", "/home", "/Library",
    "/lib", "/lib32", "/lib64", "/libx32", "/media", "/mnt", "/opt", "/private",
    "/proc", "/root", "/run", "/sbin", "/srv", "/sys", "/System", "/tmp", "/Users",
    "/usr", "/var", "/Volumes",
    process.env.HOME || "", os.homedir(), os.tmpdir(), fs.realpathSync(os.tmpdir()),
    process.cwd(), repositoryRoot,
    ...["SystemRoot", "windir", "ProgramFiles", "ProgramW6432", "ProgramFiles(x86)", "ProgramData", "USERPROFILE", "PUBLIC", "ALLUSERSPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP"].map((name) => process.env[name] || ""),
  ]);
  for (const candidate of [...protectedCandidates].filter((value) => path.isAbsolute(value))) {
    const before = snapshotNode(candidate);
    const result = runEntrypoint(candidate);
    assert.notEqual(result.status, 0, `${candidate}\n${result.stderr}`);
    assert.match(
      result.stderr,
      /CONTEXT_ROOM_DATA_ROOT must (?:be a dedicated application data directory|not contain symlinked path components)/,
      candidate,
    );
    assert.doesNotMatch(result.stderr, /CONTEXT_ROOM_HUMAN_SECRET_FILE is required/);
    assert.deepEqual(snapshotNode(candidate), before, candidate);
  }

  const external = path.join(base, "external");
  fs.mkdirSync(path.join(external, "nested"), { recursive: true });
  writePrivateFile(path.join(external, "sentinel.txt"), "parent-symlink-sentinel", 0o640);
  const parentLink = path.join(base, "parent-link");
  const leafLink = path.join(base, "leaf-link");
  const brokenLink = path.join(base, "broken-link");
  fs.symlinkSync(external, parentLink, "dir");
  fs.symlinkSync(path.join(external, "nested"), leafLink, "dir");
  fs.symlinkSync(path.join(base, "missing-target"), brokenLink, "dir");
  for (const candidate of [path.join(parentLink, "nested"), leafLink, brokenLink]) {
    const before = snapshotTree(base);
    const result = runEntrypoint(candidate);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, /CONTEXT_ROOM_DATA_ROOT must not contain symlinked path components/);
    assert.deepEqual(snapshotTree(base), before);
  }

  const validExisting = path.join(base, "valid-existing");
  fs.mkdirSync(validExisting, { mode: 0o751 });
  writePrivateFile(path.join(validExisting, "sentinel.txt"), "valid-root-remains-identical", 0o640);
  const beforeExisting = snapshotTree(validExisting);
  const existingResult = runEntrypoint(validExisting);
  assert.match(existingResult.stderr, /CONTEXT_ROOM_HUMAN_SECRET_FILE is required/);
  assert.deepEqual(snapshotTree(validExisting), beforeExisting);

  const validMissing = path.join(base, "valid-missing");
  const beforeBase = snapshotTree(base);
  const missingResult = runEntrypoint(validMissing);
  assert.match(missingResult.stderr, /CONTEXT_ROOM_HUMAN_SECRET_FILE is required/);
  assert.equal(fs.existsSync(validMissing), false);
  assert.deepEqual(snapshotTree(base), beforeBase);
});

test("remote startup rejects aliased, repeated, in-root, and incomplete credential files before effects", (t) => {
  const base = temporaryDirectory(t, "remote-secret-boundary");
  const makeCase = (name) => {
    const root = path.join(base, name);
    const dataRoot = path.join(root, "data");
    const external = path.join(root, "external");
    fs.mkdirSync(external, { recursive: true });
    return { root, dataRoot, external };
  };

  {
    const fixture = makeCase("same-path");
    const shared = writePrivateFile(path.join(fixture.external, "shared.secret"), "same-secret-".padEnd(48, "s"));
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
        CONTEXT_ROOM_HUMAN_SECRET_FILE: shared,
        CONTEXT_ROOM_AGENT_SECRET_FILE: shared,
        CONTEXT_ROOM_HEALTH_SECRET_FILE: shared,
      });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
    });
    assertPreEffectFailure(result, before, fixture.root, /must not reuse the same file/);
    assert.equal(fs.existsSync(fixture.dataRoot), false);
  }

  {
    const fixture = makeCase("hardlinks");
    const first = writePrivateFile(path.join(fixture.external, "first.secret"), "hardlinked-secret-".padEnd(48, "h"));
    const second = path.join(fixture.external, "second.secret");
    const third = path.join(fixture.external, "third.secret");
    fs.linkSync(first, second);
    fs.linkSync(first, third);
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
        CONTEXT_ROOM_HUMAN_SECRET_FILE: first,
        CONTEXT_ROOM_AGENT_SECRET_FILE: second,
        CONTEXT_ROOM_HEALTH_SECRET_FILE: third,
      });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
    });
    assertPreEffectFailure(result, before, fixture.root, /private regular file with exactly one link/);
  }

  {
    const fixture = makeCase("same-bytes");
    const paths = ["human", "agent", "health"].map((name) => writePrivateFile(
      path.join(fixture.external, `identical-${name}.secret`),
      "three-separate-files-with-identical-secret-bytes",
    ));
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
        CONTEXT_ROOM_HUMAN_SECRET_FILE: paths[0],
        CONTEXT_ROOM_AGENT_SECRET_FILE: paths[1],
        CONTEXT_ROOM_HEALTH_SECRET_FILE: paths[2],
      });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
    });
    assertPreEffectFailure(result, before, fixture.root, /must not reuse the same bytes|must contain three distinct secrets/);
  }

  {
    const fixture = makeCase("secret-under-data");
    fs.mkdirSync(fixture.dataRoot, { recursive: true, mode: 0o751 });
    const inRootSecret = writePrivateFile(path.join(fixture.dataRoot, "gitconfig-global-empty"), "must-never-be-truncated-".padEnd(48, "x"), 0o640);
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
        CONTEXT_ROOM_HUMAN_SECRET_FILE: inRootSecret,
      });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
    });
    assertPreEffectFailure(result, before, fixture.root, /must be mounted outside CONTEXT_ROOM_DATA_ROOT/);
  }

  {
    const fixture = makeCase("secret-parent-symlink");
    const actual = path.join(fixture.external, "actual");
    fs.mkdirSync(actual);
    const human = writePrivateFile(path.join(actual, "human.secret"), "symlink-parent-secret-".padEnd(48, "p"));
    const alias = path.join(fixture.external, "alias");
    fs.symlinkSync(actual, alias, "dir");
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
        CONTEXT_ROOM_HUMAN_SECRET_FILE: path.join(alias, path.basename(human)),
      });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
    });
    assertPreEffectFailure(result, before, fixture.root, /CONTEXT_ROOM_HUMAN_SECRET_FILE must not contain symlinked path components/);
  }

  {
    const fixture = makeCase("repositories-under-data");
    fs.mkdirSync(fixture.dataRoot, { recursive: true, mode: 0o751 });
    const repositoriesFile = writePrivateFile(path.join(fixture.dataRoot, "repositories.json"), JSON.stringify([{
      repository: "https://github.com/example/context-room-shared.git",
      projectIds: ["demo"],
    }]));
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
      CONTEXT_ROOM_SHARED_REPOSITORIES_FILE: repositoriesFile,
    });
    delete env.CONTEXT_ROOM_SHARED_REPOSITORY;
    delete env.CONTEXT_ROOM_PROJECT_IDS;
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], { env, encoding: "utf8" });
    assertPreEffectFailure(result, before, fixture.root, /CONTEXT_ROOM_SHARED_REPOSITORIES_FILE must be mounted outside CONTEXT_ROOM_DATA_ROOT/);
  }

  {
    const fixture = makeCase("config-as-secret");
    const repositoriesFile = writePrivateFile(path.join(fixture.external, "repositories.json"), JSON.stringify([{
      repository: "https://github.com/example/context-room-shared.git",
      projectIds: ["demo"],
    }]));
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
      CONTEXT_ROOM_SHARED_REPOSITORIES_FILE: repositoriesFile,
      CONTEXT_ROOM_HUMAN_SECRET_FILE: repositoriesFile,
    });
    delete env.CONTEXT_ROOM_SHARED_REPOSITORY;
    delete env.CONTEXT_ROOM_PROJECT_IDS;
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], { env, encoding: "utf8" });
    assertPreEffectFailure(result, before, fixture.root, /must not reuse the same file/);
  }

  {
    const fixture = makeCase("ssh-without-pinned-files");
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
        CONTEXT_ROOM_SHARED_REPOSITORY: "git@github.com:example/context-room-shared.git",
      });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
    });
    assertPreEffectFailure(result, before, fixture.root, /SSH Shared repositories require CONTEXT_ROOM_PROPOSAL_SSH_KEY_FILE and CONTEXT_ROOM_GIT_KNOWN_HOSTS_FILE/);
  }

  {
    const fixture = makeCase("invalid-late-config");
    fs.mkdirSync(fixture.dataRoot, { recursive: true, mode: 0o751 });
    writePrivateFile(path.join(fixture.dataRoot, "sentinel.txt"), "late-invalid-config-no-effects", 0o640);
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, { CONTEXT_ROOM_PORT: "0" });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
    });
    assertPreEffectFailure(result, before, fixture.root, /CONTEXT_ROOM_PORT must be an integer between 1 and 65535/);
  }

  const rsaPrivateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const ecPrivateKey = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const githubAppCase = (name, privateKey, appId, installationId, pattern) => {
    const fixture = makeCase(name);
    const keyFile = writePrivateFile(path.join(fixture.external, "github-app.pem"), privateKey);
    const env = completeEntrypointEnvironment(fixture.dataRoot, fixture.external, {
      CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE: keyFile,
      CONTEXT_ROOM_GITHUB_APP_ID: appId,
      CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID: installationId,
    });
    const before = snapshotTree(fixture.root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], { env, encoding: "utf8" });
    assertPreEffectFailure(result, before, fixture.root, pattern);
  };
  githubAppCase(
    "github-app-invalid-pem",
    "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----\n",
    "123",
    "456",
    /must contain a valid unencrypted RSA private key/,
  );
  githubAppCase(
    "github-app-ec-key",
    ecPrivateKey,
    "123",
    "456",
    /must contain a valid unencrypted RSA private key/,
  );
  githubAppCase(
    "github-app-zero-id",
    rsaPrivateKey,
    "0",
    "456",
    /must be positive bounded decimal identifiers/,
  );
  githubAppCase(
    "github-app-unbounded-id",
    rsaPrivateKey,
    "123",
    "99999999999999999999",
    /must be positive bounded decimal identifiers/,
  );
});

test("remote startup refuses every incomplete project and Shared registry migration before Git or state mutation", (t) => {
  const base = temporaryDirectory(t, "remote-layout-boundary");
  const configuredRepository = "https://github.com/example/context-room-shared.git";
  const configuredRepositoryId = repositoryId("example", "context-room-shared");
  const wrongRepository = "https://github.com/attacker/wrong-shared.git";

  const makeCase = (name, mutate, pattern = /operator-verified atomic change before remote startup/) => {
    const root = path.join(base, name);
    const dataRoot = path.join(root, "data");
    const external = path.join(root, "external");
    fs.mkdirSync(path.join(dataRoot, "home", ".context-room", "shared"), { recursive: true, mode: 0o750 });
    fs.mkdirSync(path.join(dataRoot, "projects"), { recursive: true, mode: 0o750 });
    writePrivateFile(path.join(dataRoot, "gitconfig-global-empty"), `gitconfig-sentinel-${name}`, 0o640);
    fs.mkdirSync(external, { recursive: true });
    const expectedRoot = path.join(dataRoot, "projects", configuredRepositoryId, "demo");
    const registryFile = path.join(dataRoot, "home", ".context-room", "shared", "registry.json");
    const writeRegistry = (binding, version = 1) => writePrivateFile(registryFile, `${JSON.stringify({
      version,
      bindings: binding === null ? [] : [binding],
    }, null, 2)}\n`);
    const validBinding = {
      repository: configuredRepository,
      projectId: "demo",
      sourceRoot: expectedRoot,
      projectRoots: [expectedRoot],
    };
    mutate({ root, dataRoot, external, expectedRoot, registryFile, validBinding, writeRegistry });
    const env = completeEntrypointEnvironment(dataRoot, external, {
      CONTEXT_ROOM_SHARED_REPOSITORY: configuredRepository,
    });
    const before = snapshotTree(root);
    const result = spawnSync(process.execPath, [remoteEntrypoint], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assertPreEffectFailure(result, before, root, pattern);
    assert.doesNotMatch(result.stderr, /gitconfig-sentinel|attacker/);
  };

  makeCase("unknown-flat-root", ({ dataRoot }) => {
    fs.mkdirSync(path.join(dataRoot, "projects", "legacy-demo"));
  });
  makeCase("unknown-repository-id", ({ dataRoot }) => {
    fs.mkdirSync(path.join(dataRoot, "projects", "f".repeat(24)));
  });
  makeCase("unexpected-project", ({ dataRoot }) => {
    fs.mkdirSync(path.join(dataRoot, "projects", configuredRepositoryId, "other"), { recursive: true });
  });
  makeCase("missing-registry", ({ expectedRoot }) => {
    fs.mkdirSync(expectedRoot, { recursive: true });
  });
  makeCase("missing-binding", ({ expectedRoot, writeRegistry }) => {
    fs.mkdirSync(expectedRoot, { recursive: true });
    writeRegistry(null);
  });
  makeCase("wrong-repository", ({ expectedRoot, validBinding, writeRegistry }) => {
    fs.mkdirSync(expectedRoot, { recursive: true });
    writeRegistry({ ...validBinding, repository: wrongRepository });
  });
  makeCase("stale-source-root", ({ dataRoot, expectedRoot, validBinding, writeRegistry }) => {
    fs.mkdirSync(expectedRoot, { recursive: true });
    const legacyRoot = path.join(dataRoot, "projects", "demo");
    writeRegistry({ ...validBinding, sourceRoot: legacyRoot, projectRoots: [legacyRoot] });
  });
  makeCase("stale-project-roots", ({ expectedRoot, validBinding, writeRegistry }) => {
    fs.mkdirSync(expectedRoot, { recursive: true });
    writeRegistry({ ...validBinding, projectRoots: [path.dirname(expectedRoot)] });
  });
  makeCase("invalid-registry-version", ({ expectedRoot, validBinding, writeRegistry }) => {
    fs.mkdirSync(expectedRoot, { recursive: true });
    writeRegistry(validBinding, 2);
  });
  makeCase("missing-bound-root", ({ validBinding, writeRegistry }) => {
    writeRegistry(validBinding);
  });
  makeCase("partial-flat-and-namespaced", ({ dataRoot, expectedRoot, validBinding, writeRegistry }) => {
    fs.mkdirSync(expectedRoot, { recursive: true });
    fs.mkdirSync(path.join(dataRoot, "projects", "demo"));
    writeRegistry(validBinding);
  });
  makeCase("conflicting-shared-home", ({ dataRoot }) => {
    fs.mkdirSync(path.join(dataRoot, "shared"));
    writePrivateFile(path.join(dataRoot, "shared", "registry.json"), "conflicting-state");
  });
  makeCase("dangling-projects-root", ({ dataRoot }) => {
    fs.rmSync(path.join(dataRoot, "projects"), { recursive: true });
    fs.symlinkSync(path.join(dataRoot, "missing-projects"), path.join(dataRoot, "projects"), "dir");
  }, /Context Room projects root must not be a symlink/);
  makeCase("dangling-reserved-home", ({ dataRoot }) => {
    fs.rmSync(path.join(dataRoot, "home"), { recursive: true });
    fs.symlinkSync(path.join(dataRoot, "missing-home"), path.join(dataRoot, "home"), "dir");
  }, /HOME must not be a symlink/);
  makeCase("dangling-shared-state", ({ dataRoot }) => {
    const shared = path.join(dataRoot, "home", ".context-room", "shared");
    fs.rmSync(shared, { recursive: true });
    fs.symlinkSync(path.join(dataRoot, "missing-shared-state"), shared, "dir");
  });
  makeCase("dangling-gitconfig", ({ dataRoot }) => {
    const gitConfig = path.join(dataRoot, "gitconfig-global-empty");
    fs.rmSync(gitConfig);
    fs.symlinkSync(path.join(dataRoot, "missing-gitconfig"), gitConfig, "file");
  }, /GIT_CONFIG_GLOBAL must be a private regular file/);
  makeCase("dangling-repository-root", ({ dataRoot }) => {
    fs.symlinkSync(
      path.join(dataRoot, "missing-repository-root"),
      path.join(dataRoot, "projects", configuredRepositoryId),
      "dir",
    );
  }, /Shared repository .* must not be a symlink/);
  makeCase("dangling-project-root", ({ dataRoot, expectedRoot }) => {
    fs.mkdirSync(path.dirname(expectedRoot), { recursive: true });
    fs.symlinkSync(path.join(dataRoot, "missing-project-root"), expectedRoot, "dir");
  }, /Shared project demo must not be a symlink/);
  makeCase("dangling-registry", ({ dataRoot, registryFile }) => {
    fs.symlinkSync(path.join(dataRoot, "missing-registry"), registryFile, "file");
  }, /Hosted Shared registry must not contain symlinked path components/);
  makeCase("dangling-context-state", ({ dataRoot }) => {
    const contextState = path.join(dataRoot, "home", ".context-room");
    fs.rmSync(contextState, { recursive: true });
    fs.symlinkSync(path.join(dataRoot, "missing-context-state"), contextState, "dir");
  });
  makeCase("dangling-conflicting-shared", ({ dataRoot }) => {
    fs.symlinkSync(path.join(dataRoot, "missing-conflicting-shared"), path.join(dataRoot, "shared"), "dir");
  });
  for (const [directory, label] of [
    ["hub", "CONTEXT_ROOM_HUB_HOME"],
    ["review-authority", "CONTEXT_ROOM_REVIEW_AUTHORITY_HOME"],
    ["snapshots", "CONTEXT_ROOM_SNAPSHOT_HOME"],
    ["codex", "CODEX_HOME"],
    ["hermes", "HERMES_HOME"],
    ["host", "Context Room host root"],
  ]) {
    makeCase(`dangling-reserved-${directory}`, ({ dataRoot }) => {
      fs.symlinkSync(path.join(dataRoot, `missing-${directory}`), path.join(dataRoot, directory), "dir");
    }, new RegExp(`${label} must not be a symlink`));
  }
  makeCase("invalid-bootstrap-marker", ({ dataRoot }) => {
    writePrivateFile(path.join(dataRoot, ".bootstrap-incomplete.json"), "not-json");
  }, /bootstrap recovery marker is invalid/);
  makeCase("mismatched-bootstrap-marker", ({ dataRoot }) => {
    writePrivateFile(path.join(dataRoot, ".bootstrap-incomplete.json"), JSON.stringify({ version: 1, repositories: [] }));
  }, /bootstrap recovery marker does not match the exact current repository configuration/);
  makeCase("dangling-bootstrap-marker", ({ dataRoot }) => {
    fs.symlinkSync(path.join(dataRoot, "missing-bootstrap-marker"), path.join(dataRoot, ".bootstrap-incomplete.json"), "file");
  }, /Hosted bootstrap recovery marker must not contain symlinked path components/);
});

test("remote process starts multiple repositories once and preserves exact historical Shared proposal and review state", async (t) => {
  const base = temporaryDirectory(t, "remote-process-continuity");
  const dataRoot = path.join(base, "data");
  const external = path.join(base, "external");
  fs.mkdirSync(external, { recursive: true });

  const repositories = [
    {
      repository: "https://github.com/Context-Room-QA/Shared-One",
      projectIds: ["atlas", "beacon", "comet"],
      fixture: createSharedGitFixture(base, "shared-one", ["atlas", "beacon", "comet"]),
    },
    {
      repository: "https://github.com/context-room-qa/shared-two.git",
      projectIds: ["delta", "ember"],
      fixture: createSharedGitFixture(base, "shared-two", ["delta", "ember"]),
    },
  ];
  const repositoriesFile = writePrivateFile(path.join(external, "repositories.json"), `${JSON.stringify(
    repositories.map(({ repository, projectIds }) => ({ repository, projectIds })),
    null,
    2,
  )}\n`);
  const gitWrapper = installCountingGitWrapper(
    base,
    Object.fromEntries(repositories.map((entry) => [entry.repository, entry.fixture.remote])),
  );
  const environment = completeEntrypointEnvironment(dataRoot, external, {
    ...gitWrapper.env,
    CONTEXT_ROOM_SHARED_REPOSITORIES_FILE: repositoriesFile,
    CONTEXT_ROOM_PORT: String(await availablePort()),
  });
  delete environment.CONTEXT_ROOM_SHARED_REPOSITORY;
  delete environment.CONTEXT_ROOM_PROJECT_IDS;

  let running = null;
  t.after(async () => {
    if (!running || running.child.exitCode !== null || running.child.signalCode !== null) return;
    running.child.kill("SIGTERM");
    await running.exit;
  });

  running = await startRemoteEntrypoint(environment);
  await stopRemoteEntrypoint(running);
  running = null;

  let operations = countedGitOperations(gitWrapper.countFile);
  assert.equal(operations.filter((item) => item.operation === "clone").length, 2, JSON.stringify(operations));
  assert.equal(operations.filter((item) => item.operation === "fetch").length, 2, JSON.stringify(operations));

  const sharedHome = path.join(dataRoot, "home", ".context-room", "shared");
  const registryFile = path.join(sharedHome, "registry.json");
  assert.equal(fs.existsSync(sharedHome), true);
  assert.equal(fs.existsSync(path.join(dataRoot, "shared")), false);
  const registry = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  assert.equal(registry.version, 1);
  assert.equal(registry.bindings.length, 5);
  for (const entry of repositories) {
    const id = repositoryId("context-room-qa", path.basename(entry.repository).replace(/\.git$/i, ""));
    for (const projectId of entry.projectIds) {
      const projectRoot = path.join(dataRoot, "projects", id, projectId);
      const binding = registry.bindings.find((item) => item.projectId === projectId);
      assert.deepEqual(binding, {
        repository: entry.repository,
        repositoryIdentity: contextHubRepositoryIdentity(entry.repository),
        projectId,
        sourceRoot: projectRoot,
        projectRoots: [projectRoot],
        capabilityVersion: 1,
        projectCapabilities: [attestSharedProjectCapability(projectRoot)],
      });
      const projectConfiguration = JSON.parse(fs.readFileSync(path.join(projectRoot, ".context-room", "config.json"), "utf8"));
      assert.equal(projectConfiguration.sharedContext.repository, entry.repository);
      assert.equal(projectConfiguration.sharedContext.projectId, projectId);
      assert.equal(
        fs.existsSync(path.join(sharedHome, sharedCacheId(entry.repository), "current", "projects", projectId, "docs", "README.md")),
        true,
      );
    }
  }

  const first = repositories[0];
  const firstRepositoryId = repositoryId("context-room-qa", "shared-one");
  const firstProjectRoot = path.join(dataRoot, "projects", firstRepositoryId, "atlas");
  const historicalToken = ["historical", "continuity", "installation", "token"].join("-");
  const historicalCredential = {
    url: first.repository,
    token: historicalToken,
    expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    timeoutMs: 30_000,
  };
  const historicalGitWrapper = installCountingGitWrapper(
    path.join(base, "historical-git"),
    { [first.repository]: first.fixture.remote },
    {
      requireGitHubAuthorization: true,
      forbiddenCredentialValues: credentialRepresentations(historicalToken),
    },
  );
  const restoreEnvironment = installTemporaryEnvironment({
    ...historicalGitWrapper.env,
    CONTEXT_ROOM_SHARED_HOME: sharedHome,
    HOME: path.join(dataRoot, "home"),
  });
  let proposal;
  let review;
  try {
    proposal = createSharedProposal(firstProjectRoot, {
      title: "Keep exact hosted continuity",
      description: "Prove that a live proposal remains attached to the historical Shared state key.",
      branch: "proposal/atlas/hosted-continuity",
      sessionId: "remote-entrypoint-continuity",
      push: historicalCredential,
    });
    fs.appendFileSync(
      path.join(proposal.root, "projects", "atlas", "docs", "README.md"),
      "\nProposed continuity clarification.\n",
      "utf8",
    );
    const published = publishSharedProposal(firstProjectRoot, {
      proposal: proposal.branch,
      message: "Prove hosted state continuity",
      author: { name: "Context Room test", email: "context-room-test@example.test" },
      push: historicalCredential,
    });
    review = materializeSharedReview(firstProjectRoot, {
      proposal: published.branch,
      expectedHead: published.head,
      push: historicalCredential,
    });
  } finally {
    restoreEnvironment();
  }
  const historicalAuthenticatedOperations = jsonLines(historicalGitWrapper.authFile);
  assert.deepEqual(
    historicalAuthenticatedOperations.map((item) => item.operation),
    ["fetch", "fetch", "push", "fetch"],
  );
  assert.equal(historicalAuthenticatedOperations.every((item) => item.authenticated && item.helperConfigured), true);
  assert.equal(historicalAuthenticatedOperations.every((item) => !item.environmentContainsCredential && !item.argvContainsCredential), true);
  assert.equal(historicalAuthenticatedOperations.every((item) => !item.procEnvironmentContainsCredential && !item.procArgvContainsCredential), true);
  assert.equal(new Set(historicalAuthenticatedOperations.map((item) => item.credentialHash)).size, 1);

  const reviewStateFile = writePrivateFile(
    path.join(review.reviewRoot, ".context-room", "review-state.json"),
    `${JSON.stringify({ version: 2, reviews: { "projects/atlas/docs/README.md": { decision: "reviewed", partial: true } } }, null, 2)}\n`,
  );
  const receiptFile = writePrivateFile(
    path.join(sharedHome, "review-authority", "continuity-receipt.json"),
    `${JSON.stringify({ kind: "continuity-receipt", proposal: proposal.branch, status: "pending-human-acceptance" }, null, 2)}\n`,
  );
  const proposalRegistryFile = path.join(sharedHome, sharedCacheId(first.repository), "proposals.json");
  const authorityFile = path.join(sharedHome, "review-authority", `${review.metadata.authorityId}.json`);
  const continuityBefore = {
    proposalRegistry: snapshotNode(proposalRegistryFile),
    proposalWorkspace: snapshotTree(proposal.root),
    reviewWorkspace: snapshotTree(review.reviewRoot),
    reviewState: snapshotNode(reviewStateFile),
    authority: snapshotNode(authorityFile),
    receipt: snapshotNode(receiptFile),
  };

  environment.CONTEXT_ROOM_PORT = String(await availablePort());
  running = await startRemoteEntrypoint(environment);
  await stopRemoteEntrypoint(running);
  running = null;

  operations = countedGitOperations(gitWrapper.countFile);
  assert.equal(operations.filter((item) => item.operation === "clone").length, 2, JSON.stringify(operations));
  assert.equal(operations.filter((item) => item.operation === "fetch").length, 4, JSON.stringify(operations));
  assert.deepEqual({
    proposalRegistry: snapshotNode(proposalRegistryFile),
    proposalWorkspace: snapshotTree(proposal.root),
    reviewWorkspace: snapshotTree(review.reviewRoot),
    reviewState: snapshotNode(reviewStateFile),
    authority: snapshotNode(authorityFile),
    receipt: snapshotNode(receiptFile),
  }, continuityBefore);

  const equivalentRepositories = repositories.map(({ repository, projectIds }, index) => ({
    repository: index === 0 ? `${repository}.git` : repository,
    projectIds,
  }));
  fs.writeFileSync(repositoriesFile, `${JSON.stringify(equivalentRepositories, null, 2)}\n`, "utf8");
  fs.chmodSync(repositoriesFile, 0o600);
  const beforeRejectedMigration = snapshotTree(dataRoot);
  const operationCountBeforeRejectedMigration = countedGitOperations(gitWrapper.countFile).length;
  const rejected = spawnSync(process.execPath, [remoteEntrypoint], {
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(rejected.signal, null, rejected.stderr);
  assert.notEqual(rejected.status, 0, rejected.stderr);
  assert.match(rejected.stderr, /changes the exact repository address that keys persistent Shared state/);
  assert.deepEqual(snapshotTree(dataRoot), beforeRejectedMigration);
  assert.equal(countedGitOperations(gitWrapper.countFile).length, operationCountBeforeRejectedMigration);
});

test("remote process never listens after Git failure and resumes only from its exact bootstrap recovery marker", async (t) => {
  const base = temporaryDirectory(t, "remote-bootstrap-recovery");
  const dataRoot = path.join(base, "data");
  const external = path.join(base, "external");
  fs.mkdirSync(external, { recursive: true });
  const repository = "https://github.com/context-room-qa/bootstrap-recovery.git";
  const projectId = "recovery";
  const fixture = createSharedGitFixture(base, "bootstrap-recovery", [projectId]);
  const repositoriesFile = writePrivateFile(path.join(external, "repositories.json"), `${JSON.stringify([{
    repository,
    projectIds: [projectId],
  }], null, 2)}\n`);
  const gitWrapper = installCountingGitWrapper(base, { [repository]: fixture.remote });
  const failOnceFile = path.join(base, "git-failed-once");
  const environment = completeEntrypointEnvironment(dataRoot, external, {
    ...gitWrapper.env,
    CR_TEST_FAIL_GIT_ONCE_FILE: failOnceFile,
    CONTEXT_ROOM_SHARED_REPOSITORIES_FILE: repositoriesFile,
    CONTEXT_ROOM_PORT: String(await availablePort()),
  });
  delete environment.CONTEXT_ROOM_SHARED_REPOSITORY;
  delete environment.CONTEXT_ROOM_PROJECT_IDS;

  const failed = spawnSync(process.execPath, [remoteEntrypoint], {
    env: environment,
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(failed.signal, null, failed.stderr);
  assert.notEqual(failed.status, 0, failed.stderr);
  assert.doesNotMatch(failed.stdout, /remote server listening/);
  const markerFile = path.join(dataRoot, ".bootstrap-incomplete.json");
  assert.equal(fs.existsSync(markerFile), true, `${failed.stderr}\n${JSON.stringify(countedGitOperations(gitWrapper.countFile))}`);
  const marker = JSON.parse(fs.readFileSync(markerFile, "utf8"));
  assert.deepEqual(marker.repositories.map(({ repository: value, projectIds }) => ({ repository: value, projectIds })), [{
    repository,
    projectIds: [projectId],
  }]);

  const registryFile = path.join(dataRoot, "home", ".context-room", "shared", "registry.json");
  assert.equal(fs.existsSync(registryFile), true);
  fs.unlinkSync(registryFile);
  environment.CONTEXT_ROOM_PORT = String(await availablePort());
  const recovered = await startRemoteEntrypoint(environment);
  await stopRemoteEntrypoint(recovered);
  assert.equal(fs.existsSync(markerFile), false);
  assert.equal(fs.existsSync(registryFile), true);
  const operations = countedGitOperations(gitWrapper.countFile);
  assert.equal(operations.filter((item) => item.operation === "clone").length, 2, JSON.stringify(operations));
  assert.equal(operations.filter((item) => item.operation === "fetch").length, 1, JSON.stringify(operations));
});

test("a virgin Hosted HTTPS private data root bootstraps with one ephemeral repository-scoped GitHub App credential", { timeout: 30_000 }, async (t) => {
  const base = temporaryDirectory(t, "remote-private-bootstrap");
  const dataRoot = path.join(base, "data");
  const external = path.join(base, "external");
  fs.mkdirSync(external, { recursive: true });
  const repository = "https://github.com/context-room-qa/private-bootstrap.git";
  const projectId = "private-bootstrap";
  const fixture = createSharedGitFixture(base, "private-bootstrap", [projectId]);
  const repositoriesFile = writePrivateFile(path.join(external, "repositories.json"), `${JSON.stringify([{
    repository,
    projectIds: [projectId],
  }], null, 2)}\n`);
  const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  }).privateKey;
  const privateKeyFile = writePrivateFile(path.join(external, "github-app.pem"), privateKey);
  const token = "private-bootstrap-installation-token";
  const forbiddenCredentials = credentialRepresentations(token);
  const requestLog = path.join(base, "github-token-requests.jsonl");
  const preload = writePrivateFile(path.join(external, "mock-github-fetch.mjs"), `
import fs from "node:fs";
globalThis.fetch = async (url, options = {}) => {
  fs.appendFileSync(process.env.CR_TEST_GITHUB_REQUEST_LOG, JSON.stringify({
    url: String(url),
    method: String(options.method || ""),
    body: String(options.body || ""),
    hasSignal: Boolean(options.signal),
  }) + "\\n");
  return {
    ok: true,
    status: 201,
    json: async () => ({
      token: ["private", "bootstrap", "installation", "token"].join("-"),
      expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
    }),
  };
};
`);
  const gitWrapper = installCountingGitWrapper(base, { [repository]: fixture.remote }, {
    requireGitHubAuthorization: true,
    forbiddenCredentialValues: forbiddenCredentials,
  });
  const environment = completeEntrypointEnvironment(dataRoot, external, {
    ...gitWrapper.env,
    NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
    CR_TEST_GITHUB_REQUEST_LOG: requestLog,
    CONTEXT_ROOM_SHARED_REPOSITORIES_FILE: repositoriesFile,
    CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE: privateKeyFile,
    CONTEXT_ROOM_GITHUB_APP_ID: "123456",
    CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID: "987654",
    CONTEXT_ROOM_PORT: String(await availablePort()),
  });
  delete environment.CONTEXT_ROOM_SHARED_REPOSITORY;
  delete environment.CONTEXT_ROOM_PROJECT_IDS;

  assert.equal(fs.existsSync(dataRoot), false);
  assert.equal(Object.values(environment).some((value) => String(value).includes(token)), false);
  const running = await startRemoteEntrypoint(environment);
  const command = execFileSync("ps", ["-ww", "-o", "command=", "-p", String(running.child.pid)], { encoding: "utf8" });
  assert.equal(command.includes(token), false);
  if (process.platform === "linux" && fs.existsSync(`/proc/${running.child.pid}/environ`)) {
    const environmentBytes = fs.readFileSync(`/proc/${running.child.pid}/environ`);
    assert.equal(forbiddenCredentials.some((secret) => environmentBytes.includes(Buffer.from(secret, "utf8"))), false);
  }
  await stopRemoteEntrypoint(running);

  const requests = jsonLines(requestLog);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://api.github.com/app/installations/987654/access_tokens");
  assert.equal(requests[0].method, "POST");
  assert.equal(requests[0].hasSignal, true);
  assert.deepEqual(JSON.parse(requests[0].body), {
    repositories: ["private-bootstrap"],
    permissions: { contents: "write" },
  });
  const authenticatedOperations = jsonLines(gitWrapper.authFile);
  assert.deepEqual(authenticatedOperations.map((item) => item.operation), ["clone", "fetch"]);
  assert.equal(authenticatedOperations.every((item) => item.authenticated && item.helperConfigured && /^[a-f0-9]{64}$/.test(item.credentialHash)), true);
  assert.equal(new Set(authenticatedOperations.map((item) => item.credentialHash)).size, 1);
  assert.equal(authenticatedOperations.every((item) => item.brokerDirectoryMode === 0o700 && item.socketMode === 0o600), true);
  assert.equal(authenticatedOperations.every((item) => !item.environmentContainsCredential && !item.argvContainsCredential), true);
  assert.equal(authenticatedOperations.every((item) => !item.procEnvironmentContainsCredential && !item.procArgvContainsCredential), true);
  assert.equal(authenticatedOperations.every((item) => !fs.existsSync(item.brokerRoot)), true);
  const connection = JSON.parse(fs.readFileSync(path.join(
    dataRoot,
    "projects",
    repositoryId("context-room-qa", "private-bootstrap"),
    projectId,
    ".context-room",
    "config.json",
  ), "utf8")).sharedContext;
  assert.deepEqual(connection, { enabled: true, repository, projectId });
  assertTreeExcludesBytes(base, forbiddenCredentials);
});

for (const scenario of [
  { name: "no GitHub App", githubApp: false, expiresInMs: 0 },
  { name: "an expired GitHub App token", githubApp: true, expiresInMs: -1_000 },
]) {
  test(`virgin Hosted private bootstrap fails before application-state mutation with ${scenario.name}`, { timeout: 20_000 }, (t) => {
    const base = temporaryDirectory(t, `remote-private-bootstrap-${scenario.githubApp ? "expired" : "no-app"}`);
    const dataRoot = path.join(base, "data");
    const external = path.join(base, "external");
    fs.mkdirSync(external, { recursive: true });
    const repository = "https://github.com/context-room-qa/private-bootstrap-failure.git";
    const projectId = "private-failure";
    const fixture = createSharedGitFixture(base, "private-bootstrap-failure", [projectId]);
    const repositoriesFile = writePrivateFile(path.join(external, "repositories.json"), JSON.stringify([{ repository, projectIds: [projectId] }]));
    const gitWrapper = installCountingGitWrapper(base, { [repository]: fixture.remote }, {
      requireGitHubAuthorization: true,
    });
    const overrides = {
      ...gitWrapper.env,
      CONTEXT_ROOM_SHARED_REPOSITORIES_FILE: repositoriesFile,
    };
    if (scenario.githubApp) {
      const privateKey = generateKeyPairSync("rsa", {
        modulusLength: 2048,
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      }).privateKey;
      overrides.CONTEXT_ROOM_GITHUB_APP_PRIVATE_KEY_FILE = writePrivateFile(path.join(external, "github-app.pem"), privateKey);
      overrides.CONTEXT_ROOM_GITHUB_APP_ID = "123456";
      overrides.CONTEXT_ROOM_GITHUB_APP_INSTALLATION_ID = "987654";
      const preload = writePrivateFile(path.join(external, "mock-expired-github-fetch.mjs"), `
globalThis.fetch = async () => ({
  ok: true,
  status: 201,
  json: async () => ({ token: ["expired", "private", "bootstrap", "token"].join("-"), expires_at: new Date(Date.now() - 1_000).toISOString() }),
});
`);
      overrides.NODE_OPTIONS = `--import=${pathToFileURL(preload).href}`;
    }
    const environment = completeEntrypointEnvironment(dataRoot, external, overrides);
    delete environment.CONTEXT_ROOM_SHARED_REPOSITORY;
    delete environment.CONTEXT_ROOM_PROJECT_IDS;
    const result = spawnSync(process.execPath, [remoteEntrypoint], { env: environment, encoding: "utf8", timeout: 20_000 });
    assert.equal(result.signal, null, result.stderr);
    assert.notEqual(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(dataRoot), false, result.stderr);
    assert.equal(countedGitOperations(gitWrapper.countFile).filter((item) => ["clone", "fetch"].includes(item.operation)).length, 0);
    assert.equal(result.stderr.includes("expired-private-bootstrap-token"), false);
  });
}

test("one live remote process exclusively owns its Hosted data root", async (t) => {
  const base = temporaryDirectory(t, "remote-instance-singleton");
  const dataRoot = path.join(base, "data");
  const external = path.join(base, "external");
  fs.mkdirSync(external, { recursive: true });
  const repository = "https://github.com/context-room-qa/instance-singleton.git";
  const projectId = "singleton";
  const fixture = createSharedGitFixture(base, "instance-singleton", [projectId]);
  const repositoriesFile = writePrivateFile(path.join(external, "repositories.json"), `${JSON.stringify([{
    repository,
    projectIds: [projectId],
  }], null, 2)}\n`);
  const gitWrapper = installCountingGitWrapper(base, { [repository]: fixture.remote });
  const environment = completeEntrypointEnvironment(dataRoot, external, {
    ...gitWrapper.env,
    CONTEXT_ROOM_SHARED_REPOSITORIES_FILE: repositoriesFile,
    CONTEXT_ROOM_PORT: String(await availablePort()),
  });
  delete environment.CONTEXT_ROOM_SHARED_REPOSITORY;
  delete environment.CONTEXT_ROOM_PROJECT_IDS;

  const first = await startRemoteEntrypoint(environment);
  const operationsBeforeContender = countedGitOperations(gitWrapper.countFile);
  const markerFile = path.join(dataRoot, ".bootstrap-incomplete.json");
  assert.equal(fs.existsSync(markerFile), false);

  const contenderEnvironment = { ...environment, CONTEXT_ROOM_PORT: String(await availablePort()) };
  const contender = spawnSync(process.execPath, [remoteEntrypoint], {
    env: contenderEnvironment,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(contender.signal, null, contender.stderr);
  assert.notEqual(contender.status, 0, contender.stderr);
  assert.match(contender.stderr, /Hosted Context Room data root is already owned by another live process/);
  assert.deepEqual(countedGitOperations(gitWrapper.countFile), operationsBeforeContender);
  assert.equal(fs.existsSync(markerFile), false);

  await stopRemoteEntrypoint(first);
  const successor = await startRemoteEntrypoint({
    ...environment,
    CONTEXT_ROOM_PORT: String(await availablePort()),
  });
  await stopRemoteEntrypoint(successor);
  assert.equal(fs.existsSync(path.join(dataRoot, ".context-room-instance.lock")), false);
});

test("remote restart reclaims a stale legacy same-PID instance lock", (t) => {
  const base = temporaryDirectory(t, "remote-instance-reused-pid");
  const dataRoot = path.join(base, "data");
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dataRoot, ".context-room-instance.lock");
  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", String.raw`
import fs from "node:fs";
const lockPath = process.env.CR_TEST_LEGACY_SAME_PID_LOCK;
fs.writeFileSync(lockPath, JSON.stringify({
  pid: process.pid,
  threadId: 0,
  kind: "owner",
  token: "legacy-container-generation",
  acquiredAt: new Date(Date.now() - 10_000).toISOString(),
}) + "\n", { encoding: "utf8", flag: "wx", mode: 0o600 });
const staleDate = new Date(Date.now() - 10_000);
fs.utimesSync(lockPath, staleDate, staleDate);
await import(process.env.CR_TEST_REMOTE_ENTRYPOINT_URL);
`], {
    env: {
      ...minimalEntrypointEnvironment(dataRoot),
      CR_TEST_LEGACY_SAME_PID_LOCK: lockPath,
      CR_TEST_REMOTE_ENTRYPOINT_URL: pathToFileURL(remoteEntrypoint).href,
    },
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.signal, null, result.stderr);
  assert.notEqual(result.status, 0, result.stderr);
  assert.match(result.stderr, /CONTEXT_ROOM_HUMAN_SECRET_FILE is required/);
  assert.doesNotMatch(result.stderr, /already owned by another live process/);
  assert.equal(fs.existsSync(lockPath), false);
  assert.equal(fs.existsSync(path.join(dataRoot, ".bootstrap-incomplete.json")), false);
  assert.equal(fs.existsSync(path.join(dataRoot, "projects")), false);
});

test("remote startup rejects a reclaimers symlink before lock, configuration, or external effects", (t) => {
  const base = temporaryDirectory(t, "remote-instance-reclaimers-symlink");
  const dataRoot = path.join(base, "data");
  const external = path.join(base, "external");
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  fs.mkdirSync(external, { recursive: true, mode: 0o700 });
  const sentinel = writePrivateFile(path.join(external, "sentinel.txt"), "unchanged\n");
  const reclaimersPath = path.join(dataRoot, ".context-room-instance.lock.reclaimers");
  fs.symlinkSync(external, reclaimersPath, "dir");
  const dataBefore = snapshotTree(dataRoot);
  const externalBefore = snapshotTree(external);

  const result = runEntrypoint(dataRoot);

  assertPreEffectFailure(result, dataBefore, dataRoot, /Filesystem lock reclaimers must be a direct non-symlink directory/);
  assert.deepEqual(snapshotTree(external), externalBefore);
  assert.equal(fs.readFileSync(sentinel, "utf8"), "unchanged\n");
});

test("remote entrypoint statically enforces one repository sync and non-interactive pinned SSH", () => {
  const source = fs.readFileSync(remoteEntrypoint, "utf8");
  assert.equal((source.match(/\bsyncSharedContext\(/g) || []).length, 1);
  assert.doesNotMatch(source, /\bconnectSharedContext\b/);
  assert.match(source, /for \(const entry of configuration\.sharedRepositories\) \{\s*const firstProjectId = entry\.projectIds\[0\];\s*const push = bootstrapSharedCredentials\.get\(entry\.repository\) \|\| null;\s*syncSharedContext\(projectRoots\[firstProjectId\], \{\s*allowOffline: true,\s*\.\.\.\(push \? \{ push, timeoutMs: push\.timeoutMs \} : \{\}\),\s*\}\);/s);
  assert.match(source, /try \{\s*for \(const entry of configuration\.sharedRepositories\)[\s\S]*\} finally \{\s*bootstrapSharedCredentials\.clear\(\);\s*\}/);
  assert.match(source, /const anonymousSharedReadRepositories = new Set\(\)/);
  assert.match(source, /execFileSync\("git", \["ls-remote", "--heads", entry\.repository\][\s\S]*anonymousSharedReadRepositories\.add\(entry\.repository\)/);
  assert.match(source, /anonymousSharedReadRepositories: \[\.\.\.anonymousSharedReadRepositories\]/);
  assert.match(source, /writeHostedSharedRegistry\(dataRoot, configuration\.sharedRepositories, attestSharedProjectCapability\)/);
  assert.match(source, /"BatchMode=yes"/);
  assert.match(source, /"IdentityAgent=none"/);
  assert.match(source, /"IdentitiesOnly=yes"/);
  assert.match(source, /"StrictHostKeyChecking=yes"/);
  assert.match(source, /"SSH_ASKPASS_REQUIRE"/);
  assert.match(source, /path\.join\(homeRoot, "\.context-room"\)/);
  assert.doesNotMatch(source, /ensurePrivateDirectory\(path\.join\(dataRoot, "shared"\)/);
  assert.match(source, /repositoryIdIdentities\.get\(repository\.repositoryId\)/);
  assert.match(source, /binding\.repository\) !== target\.repository/);
  assert.doesNotMatch(source, /Normalized validated GitHub transport/);
  assert.doesNotMatch(source, /fs\.existsSync/);
  assert.match(source, /createPrivateKey\(privateKey\)/);
  assert.match(source, /const bootstrapMarker = writeHostedBootstrapMarker[\s\S]*syncSharedContext[\s\S]*clearHostedBootstrapMarker/);
});
