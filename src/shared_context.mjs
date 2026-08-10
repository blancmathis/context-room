import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isUtf8 } from "node:buffer";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { parseDocument } from "yaml";
import { parse as parseJsonc } from "jsonc-parser";
import { appendContextRoomEvent } from "./event_journal.mjs";
import { filesystemProcessIdentity, withFilesystemLock } from "./filesystem_lock.mjs";
import { assertFreshGitHubAppCredential, withGitHubAppGitCredential } from "./github_app_token.mjs";
import { parseDocMetadata } from "./doc_metadata.mjs";
import { contextProviderProfile } from "./provider_profiles.mjs";
import { inspectOwnerProposalDecisions, inspectOwnerTrustedState, recordOwnerProposalDecision } from "./review_authority.mjs";
import { contextHubRepositoryIdentity } from "./context_hub.mjs";

export const SHARED_REPOSITORY_CONFIG = ".context-room/shared-repository.json";
export const SHARED_REVIEW_CONFIG = ".context-room/shared-review.json";
export const SHARED_REPOSITORY_SCHEMA_VERSION = 1;
export const SHARED_SKILL_LOCATIONS_SCHEMA_VERSION = 1;
export const SHARED_RESOURCE_LOCAL_STATE_VERSION = 3;
export const SHARED_SKILL_LOCAL_STATE_VERSION = SHARED_RESOURCE_LOCAL_STATE_VERSION;
export const SHARED_INSTRUCTION_LOCATIONS_SCHEMA_VERSION = 1;
export const DEFAULT_SHARED_DELIVERY_TIMEOUT_MS = 120_000;
export const DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS = 30_000;
const SHARED_TERMINAL_DECISION_LEASE_MS = 15 * 60_000;
const MAX_SHARED_TEXT_BYTES = 750_000;
const SHARED_REPOSITORY_SCHEMA_URL = "https://unpkg.com/context-room@latest/schemas/shared-repository.schema.json";
const SHARED_PROJECTS_SCHEMA_URL = "https://unpkg.com/context-room@latest/schemas/shared-projects.schema.json";
const SHARED_SKILL_LOCATIONS_SCHEMA_URL = "https://unpkg.com/context-room@latest/schemas/shared-skill-locations.schema.json";
const SHARED_INSTRUCTION_LOCATIONS_SCHEMA_URL = "https://unpkg.com/context-room@latest/schemas/shared-instruction-locations.schema.json";
const SHARED_REVIEW_TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".csv", ".tsv", ".txt", ".json", ".jsonc", ".jsonl", ".yaml", ".yml", ".toml", ".ini",
  ".mjs", ".cjs", ".js", ".jsx", ".ts", ".tsx", ".py", ".sh", ".bash", ".zsh", ".css", ".scss", ".sass",
  ".html", ".htm", ".xml", ".sql", ".graphql", ".gql", ".rs", ".go", ".java", ".kt", ".swift", ".rb", ".php",
  ".c", ".cc", ".cpp", ".h", ".hpp",
]);
const SHARED_REVIEW_TEXT_FILENAMES = new Set([
  "Dockerfile", "Containerfile", "Makefile", "Rakefile", "Gemfile", "Procfile", "README", "LICENSE", "CHANGELOG",
  ".dockerignore", ".editorconfig", ".eslintignore", ".gitattributes", ".gitignore", ".markdownlintignore", ".node-version",
  ".npmignore", ".nvmrc", ".prettierignore", ".python-version", ".ruby-version", ".tool-versions",
]);
const SHARED_PROPOSAL_STATE_PREFIX = "context-room-state/";

const DEFAULT_REPOSITORY_CONFIG = {
  version: SHARED_REPOSITORY_SCHEMA_VERSION,
  name: "Shared Context",
  defaultBranch: "main",
  proposalPrefix: "proposal/",
  acceptancePrefix: "accepted/",
  rejectionPrefix: "rejected/",
  globalSkillsPath: "skills/global",
  skillLocationsFile: "skill-locations.json",
  instructionLocationsFile: "instruction-locations.json",
  projectsPath: "projects",
  projectsFile: "projects.json",
};
const GITHUB_RULESET_PREFIX = "Context Room: protect ";
const MAX_PROPOSAL_TITLE_LENGTH = 160;
const MAX_PROPOSAL_DESCRIPTION_LENGTH = 6_000;
const PROPOSAL_REGISTRY_LOCK_TIMEOUT_MS = DEFAULT_SHARED_DELIVERY_TIMEOUT_MS;
const PROPOSAL_REGISTRY_LOCK_STALE_MS = 30_000;
const SHARED_REGISTRY_LOCK_TIMEOUT_MS = DEFAULT_SHARED_DELIVERY_TIMEOUT_MS;
const SHARED_REGISTRY_LOCK_STALE_MS = 30_000;
const SHARED_REPOSITORY_CLONE_LOCK_STALE_MS = 30_000;

function sharedHome() {
  return process.env.CONTEXT_ROOM_SHARED_HOME
    ? path.resolve(process.env.CONTEXT_ROOM_SHARED_HOME)
    : path.join(process.env.HOME || os.homedir(), ".context-room", "shared");
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + "\n", "utf8");
  return value;
}

function writePrivateJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, filePath);
  fs.chmodSync(filePath, 0o600);
  return value;
}

function managedDestinationsRegistryPath() {
  return path.join(sharedHome(), "managed-destinations.json");
}

function destinationLockPath(destination) {
  return path.join(sharedHome(), "locks", `${hashKey(path.resolve(destination), 24)}.lock`);
}

function processExists(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
}

function sharedTerminalLocalOwnerAlive(owner, ownerHost, expired) {
  if (owner?.host !== ownerHost) return false;
  const pid = Number(owner?.pid);
  if (!processExists(pid)) return false;
  const recordedIdentity = typeof owner?.processIdentity === "string" && owner.processIdentity.length <= 512
    ? owner.processIdentity
    : "";
  if (!recordedIdentity) return !expired;
  const observedIdentity = filesystemProcessIdentity(pid);
  return !observedIdentity || observedIdentity === recordedIdentity;
}

function withDestinationLock(destination, callback) {
  const lock = destinationLockPath(destination);
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 2_000;
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      writePrivateJson(path.join(lock, "owner.json"), { pid: process.pid, createdAt: new Date().toISOString(), destination: path.resolve(destination) });
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const owner = readJson(path.join(lock, "owner.json"), {});
      const age = Date.now() - Date.parse(owner.createdAt || 0);
      if (age > 30_000 && !processExists(Number(owner.pid))) {
        try { fs.rmSync(lock, { recursive: true, force: true }); } catch {}
        continue;
      }
      if (Date.now() >= deadline) throw Object.assign(new Error(`Managed destination is busy: ${destination}`), { code: "reconcile-lock-timeout" });
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try { return callback(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch {} }
}

function managedDestinationOwner(destination) {
  const registry = readJson(managedDestinationsRegistryPath(), { version: 1, destinations: {} });
  return registry.destinations?.[path.resolve(destination)] || null;
}

function recordManagedDestination(destination, owner = null) {
  const filePath = managedDestinationsRegistryPath();
  return withDestinationLock(filePath, () => {
    const registry = readJson(filePath, { version: 1, destinations: {} });
    const key = path.resolve(destination);
    if (owner) registry.destinations[key] = { ...owner, destination: key, updatedAt: new Date().toISOString() };
    else delete registry.destinations[key];
    return writePrivateJson(filePath, registry);
  });
}

function replaceManagedResourceLink(linkPath, targetPath, { managedRoot, owner }) {
  return withDestinationLock(linkPath, () => {
    const existingOwner = managedDestinationOwner(linkPath);
    if (existingOwner && (existingOwner.repository !== owner.repository || existingOwner.assignmentId !== owner.assignmentId)) {
      const error = new Error(`Destination is managed by another shared resource: ${linkPath}`);
      error.code = "shared-owner-conflict";
      error.owner = existingOwner;
      throw error;
    }
    const changed = replaceSymlink(linkPath, targetPath, { managedRoot });
    recordManagedDestination(linkPath, { ...owner, target: path.resolve(targetPath) });
    return changed;
  });
}

function removeManagedResourceLink(linkPath, { managedRoot, repository, assignmentId = "" }) {
  return withDestinationLock(linkPath, () => {
    const owner = managedDestinationOwner(linkPath);
    if (owner && (owner.repository !== repository || (assignmentId && owner.assignmentId !== assignmentId))) return false;
    const state = managedSymlinkTarget(linkPath, managedRoot);
    if (!state.symbolic || !state.managed) return false;
    fs.unlinkSync(linkPath);
    recordManagedDestination(linkPath, null);
    return true;
  });
}

const BOUNDED_GIT_SUPERVISOR = String.raw`
  const { spawn } = require("node:child_process");
  const [rawArguments, rawTimeoutMs] = process.argv.slice(1);
  const gitArguments = JSON.parse(rawArguments);
  const timeoutMs = Math.max(1, Number(rawTimeoutMs) || 1);
  const detached = process.platform !== "win32";
  let finished = false;
  let timedOut = false;
  let timeout = null;
  let killTimeout = null;
  const git = spawn("git", gitArguments, { detached, stdio: "inherit" });
  const terminate = (signal) => {
    try { process.kill(detached ? -git.pid : git.pid, signal); } catch {}
  };
  const finish = (status) => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    clearTimeout(killTimeout);
    process.exit(status);
  };
  git.once("error", (error) => {
    process.stderr.write(String(error?.message || error) + "\n");
    finish(127);
  });
  git.once("exit", (status, signal) => {
    if (timedOut) return;
    finish(Number.isInteger(status) ? status : (signal ? 1 : 0));
  });
  timeout = setTimeout(() => {
    timedOut = true;
    terminate("SIGTERM");
    killTimeout = setTimeout(() => {
      terminate("SIGKILL");
      finish(124);
    }, 100);
  }, timeoutMs);
`;

function runGit(cwd, args, options = {}) {
  const timeoutMs = Number(options.timeoutMs);
  const execute = ({ gitArguments = [], environment = null } = {}) => {
    const bounded = Number.isFinite(timeoutMs) && timeoutMs > 0;
    const stdio = options.stdio || ["ignore", "pipe", "pipe"];
    const commandOptions = {
      cwd,
      encoding: options.encoding === null ? null : "utf8",
      stdio,
      maxBuffer: options.maxBuffer || 64 * 1024 * 1024,
      env: environment || { ...process.env, ...options.env },
      ...(bounded ? { timeout: Math.floor(timeoutMs), killSignal: "SIGTERM" } : {}),
    };
    if (!bounded) {
      return execFileSync("git", [...gitArguments, ...args], commandOptions);
    }

    // A timed-out Git process may leave a remote helper alive. Capture output
    // outside pipes and supervise Git in its own process group so the public
    // timeout applies to Git and every transport helper it launched.
    const captureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "context-room-git-capture-"));
    const captures = new Map();
    const normalizedStdio = Array.isArray(stdio)
      ? [...stdio]
      : stdio === "pipe"
        ? ["pipe", "pipe", "pipe"]
        : [stdio, stdio, stdio];
    const boundedStdio = [...normalizedStdio];
    for (const index of [1, 2]) {
      if (normalizedStdio[index] !== "pipe") continue;
      const capturePath = path.join(captureRoot, index === 1 ? "stdout" : "stderr");
      const descriptor = fs.openSync(capturePath, "w+");
      captures.set(index, { capturePath, descriptor });
      boundedStdio[index] = descriptor;
    }
    const readCapture = (index) => {
      const capture = captures.get(index);
      if (!capture) return options.encoding === null ? Buffer.alloc(0) : "";
      const bytes = fs.readFileSync(capture.capturePath);
      return options.encoding === null ? bytes : bytes.toString("utf8");
    };
    try {
      execFileSync(process.execPath, [
        "--input-type=commonjs",
        "--eval",
        BOUNDED_GIT_SUPERVISOR,
        JSON.stringify([...gitArguments, ...args]),
        String(Math.floor(timeoutMs)),
      ], {
        ...commandOptions,
        encoding: null,
        stdio: boundedStdio,
        timeout: Math.floor(timeoutMs) + 2_000,
      });
      return captures.has(1) ? readCapture(1) : null;
    } catch (error) {
      if (captures.has(1)) error.stdout = readCapture(1);
      if (captures.has(2)) error.stderr = readCapture(2);
      if (error?.status === 124) error.code = "ETIMEDOUT";
      throw error;
    } finally {
      for (const { descriptor } of captures.values()) {
        try { fs.closeSync(descriptor); } catch {}
      }
      try { fs.rmSync(captureRoot, { recursive: true, force: true }); } catch {}
    }
  };
  if (!options.credential) return execute();
  return withGitHubAppGitCredential(
    options.credential,
    options.credential.repository,
    execute,
    {
      baseEnvironment: { ...process.env, ...options.env },
      timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
    },
  );
}

function sharedGitNetworkTimeoutError(operation, timeoutMs, cause = null) {
  const error = new Error(`${operation} timed out after ${Math.floor(Number(timeoutMs))} ms`);
  error.code = "shared-git-timeout";
  error.retryable = true;
  error.details = { timeoutMs: Math.floor(Number(timeoutMs)) };
  if (cause) error.cause = cause;
  return error;
}

function runSharedNetworkGit(cwd, args, {
  operation = "Git network operation",
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  timeoutBudgetMs = timeoutMs,
  ...options
} = {}) {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS;
  const boundedBudgetTimeoutMs = Number.isFinite(Number(timeoutBudgetMs)) && Number(timeoutBudgetMs) > 0
    ? Math.floor(Number(timeoutBudgetMs))
    : boundedTimeoutMs;
  try {
    return runGit(cwd, args, { ...options, timeoutMs: boundedTimeoutMs });
  } catch (error) {
    if (isGitCommandTimeout(error)) throw sharedGitNetworkTimeoutError(operation, boundedBudgetTimeoutMs, error);
    throw error;
  }
}

function sharedGitNetworkBudget(timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS) {
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS;
  return { timeoutMs: boundedTimeoutMs, deadline: Date.now() + boundedTimeoutMs };
}

function remainingSharedGitNetworkTimeout(budget, operation) {
  const remaining = Math.floor(Number(budget?.deadline) - Date.now());
  if (remaining <= 0) throw sharedGitNetworkTimeoutError(operation, budget?.timeoutMs || DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS);
  return remaining;
}

function tryGit(cwd, args) {
  try {
    return String(runGit(cwd, args)).trim();
  } catch {
    return "";
  }
}

function gitObjectExists(cwd, object) {
  return spawnSync("git", ["cat-file", "-e", String(object)], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "ignore", "ignore"],
  }).status === 0;
}

function splitNull(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value || ""));
  return buffer.toString("utf8").split("\0").filter(Boolean);
}

function gitChangedPaths(cwd, range) {
  return splitNull(runGit(cwd, ["diff", "--name-only", "-z", range, "--"], { encoding: null }));
}

function gitTreeEntries(cwd, revision, prefixes = []) {
  const args = ["ls-tree", "-r", "-z", revision, "--", ...prefixes];
  return splitNull(runGit(cwd, args, { encoding: null })).map((record) => {
    const separator = record.indexOf("\t");
    if (separator < 0) throw new Error(`Unable to parse Git tree entry at ${revision}`);
    const [mode, type, object] = record.slice(0, separator).split(" ");
    return { mode, type, object, path: record.slice(separator + 1) };
  });
}

function sharedDocumentDependencyReviewPaths(cwd, baseRevision, headRevision, changedFiles = [], prefixes = []) {
  const indexAt = (revision) => {
    const byId = new Map();
    for (const entry of gitTreeEntries(cwd, revision, prefixes).filter((item) => /\.(?:md|mdx|html?)$/i.test(item.path))) {
      const metadata = parseDocMetadata(String(runGit(cwd, ["show", `${revision}:${entry.path}`])), entry.path);
      if (!metadata.id || !metadata.idValid) continue;
      if (!byId.has(metadata.id)) byId.set(metadata.id, []);
      byId.get(metadata.id).push({ path: entry.path, version: entry.object, metadata });
    }
    return byId;
  };
  const base = indexAt(baseRevision);
  const head = indexAt(headRevision);
  const changedIds = new Set();
  for (const id of new Set([...base.keys(), ...head.keys()])) {
    const before = base.get(id) || [];
    const after = head.get(id) || [];
    if (before.length !== 1 || after.length !== 1 || before[0].version !== after[0].version) changedIds.add(id);
  }
  const changed = new Set(changedFiles);
  const reviews = [];
  for (const [id, candidates] of head) {
    if (candidates.length !== 1 || changed.has(candidates[0].path)) continue;
    const dependencies = (candidates[0].metadata.dependsOn || []).filter((dependencyId) => changedIds.has(dependencyId));
    if (dependencies.length) reviews.push({ path: candidates[0].path, documentId: id, dependencies });
  }
  return reviews.sort((left, right) => left.path.localeCompare(right.path, "en"));
}

function assertSafeTreeEntries(cwd, revision, prefixes) {
  for (const entry of gitTreeEntries(cwd, revision, prefixes)) {
    if (!["100644", "100755"].includes(entry.mode) || entry.type !== "blob") {
      throw new Error(`Shared context rejects symlinks, gitlinks, and special files: ${entry.path}`);
    }
  }
}

function assertReviewableChangedPaths(cwd, baseRevision, headRevision, changedPaths) {
  for (const filePath of changedPaths) {
    const base = path.posix.basename(filePath);
    if (!SHARED_REVIEW_TEXT_EXTENSIONS.has(path.posix.extname(base)) && !SHARED_REVIEW_TEXT_FILENAMES.has(base)) {
      throw new Error(`Shared proposal file type is not reviewable in Context Room: ${filePath}`);
    }
  }
  for (const revision of [baseRevision, headRevision]) {
    const entries = new Map(gitTreeEntries(cwd, revision, changedPaths).map((entry) => [entry.path, entry]));
    for (const filePath of changedPaths) {
      const entry = entries.get(filePath);
      if (!entry) continue;
      if (!["100644", "100755"].includes(entry.mode) || entry.type !== "blob") {
        throw new Error(`Shared proposals reject symlinks, gitlinks, and special files: ${filePath}`);
      }
      const content = runGit(cwd, ["cat-file", "blob", entry.object], { encoding: null, maxBuffer: MAX_SHARED_TEXT_BYTES + 1 });
      if (content.length > MAX_SHARED_TEXT_BYTES) throw new Error(`Shared proposal file is too large to review: ${filePath}`);
      if (!isUtf8(content) || content.includes(0)) throw new Error(`Shared proposals only support reviewable UTF-8 text files: ${filePath}`);
    }
  }
}

function hashKey(value, length = 16) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, length);
}

function safeId(value, label = "id") {
  const result = String(value || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(result)) {
    throw new Error(`${label} must use lowercase letters, numbers, and single hyphens`);
  }
  return result;
}

function safeRelativePath(value, label) {
  const clean = String(value || "").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  const segments = clean.split("/");
  if (!clean || path.posix.isAbsolute(clean) || clean.includes("\0") || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`${label} must be a safe repository-relative path`);
  }
  if (segments.includes(".git")) throw new Error(`${label} must not enter .git`);
  if (path.posix.normalize(clean) !== clean) throw new Error(`${label} must be normalized`);
  return clean;
}

function unsafeSharedFilesystemPath(message) {
  const error = new Error(message);
  error.code = "shared-path-unsafe";
  return error;
}

function lstatIfPresent(filePath, options = undefined) {
  try {
    return fs.lstatSync(filePath, options);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function physicalPathIsContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}

function inspectSharedPathNoFollow(root, relativePath, { createParents = false } = {}) {
  const normalized = safeRelativePath(relativePath, "shared filesystem path");
  const resolvedRoot = path.resolve(root);
  const rootStats = lstatIfPresent(resolvedRoot);
  if (!rootStats?.isDirectory() || rootStats.isSymbolicLink()) {
    throw unsafeSharedFilesystemPath(`Shared filesystem root must be a real directory: ${resolvedRoot}`);
  }
  const physicalRoot = fs.realpathSync(resolvedRoot);
  const segments = normalized.split("/");
  let parent = resolvedRoot;
  for (const segment of segments.slice(0, -1)) {
    const candidate = path.join(parent, segment);
    let stats = lstatIfPresent(candidate);
    if (!stats && createParents) {
      try {
        fs.mkdirSync(candidate, { mode: 0o755 });
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      stats = lstatIfPresent(candidate);
    }
    if (!stats) {
      return { exists: false, parentMissing: true, target: path.join(resolvedRoot, ...segments) };
    }
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw unsafeSharedFilesystemPath(`Shared filesystem path contains a non-directory or symbolic-link parent: ${candidate}`);
    }
    const physicalCandidate = fs.realpathSync(candidate);
    if (!physicalPathIsContained(physicalRoot, physicalCandidate)) {
      throw unsafeSharedFilesystemPath(`Shared filesystem path escapes its physical root: ${candidate}`);
    }
    parent = candidate;
  }
  const parentStats = fs.lstatSync(parent, { bigint: true });
  const target = path.join(parent, segments.at(-1));
  const targetStats = lstatIfPresent(target);
  if (targetStats?.isSymbolicLink()) {
    throw unsafeSharedFilesystemPath(`Shared filesystem target must not be a symbolic link: ${target}`);
  }
  return { exists: Boolean(targetStats), parent, parentStats, physicalRoot, target };
}

function assertInspectedSharedParentUnchanged(inspected) {
  const currentParent = lstatIfPresent(inspected.parent, { bigint: true });
  if (!currentParent
    || currentParent.isSymbolicLink()
    || !currentParent.isDirectory()
    || currentParent.dev !== inspected.parentStats.dev
    || currentParent.ino !== inspected.parentStats.ino
    || !physicalPathIsContained(inspected.physicalRoot, fs.realpathSync(inspected.parent))) {
    throw unsafeSharedFilesystemPath(`Shared filesystem parent changed during file creation: ${inspected.parent}`);
  }
}

function createSharedFileNoFollow(root, relativePath, content, { stagingRoot } = {}) {
  const inspected = inspectSharedPathNoFollow(root, relativePath, { createParents: true });
  if (inspected.exists) throw new Error(`Shared document already exists: ${safeRelativePath(relativePath, "shared document path")}`);
  const staging = inspectSharedPathNoFollow(
    stagingRoot,
    `staging/${process.pid}-${randomUUID()}.tmp`,
    { createParents: true },
  );
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  let stagedStats = null;
  let linked = false;
  let completed = false;
  try {
    descriptor = fs.openSync(staging.target, flags, 0o600);
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile()) throw unsafeSharedFilesystemPath(`Shared staging target must be a regular file: ${staging.target}`);
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.fchmodSync(descriptor, 0o644);
    fs.closeSync(descriptor);
    descriptor = undefined;
    stagedStats = fs.lstatSync(staging.target, { bigint: true });
    assertInspectedSharedParentUnchanged(inspected);
    fs.linkSync(staging.target, inspected.target);
    linked = true;
    const targetStats = fs.lstatSync(inspected.target, { bigint: true });
    assertInspectedSharedParentUnchanged(inspected);
    if (!targetStats.isFile() || targetStats.dev !== stagedStats.dev || targetStats.ino !== stagedStats.ino) {
      throw unsafeSharedFilesystemPath(`Shared filesystem target changed during file creation: ${inspected.target}`);
    }
    completed = true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (linked && !completed) {
      try {
        const targetStats = fs.lstatSync(inspected.target, { bigint: true });
        if (stagedStats && targetStats.dev === stagedStats.dev && targetStats.ino === stagedStats.ino) {
          fs.unlinkSync(inspected.target);
        }
      } catch {}
    }
    try { fs.unlinkSync(staging.target); } catch {}
  }
  return inspected.target;
}

function safeBranchName(value, label = "branch") {
  const branch = String(value || "").trim();
  const invalid = !branch
    || branch.startsWith("-")
    || branch.startsWith("/")
    || branch.endsWith("/")
    || branch.endsWith(".")
    || branch.includes("..")
    || branch.includes("//")
    || branch.includes("@{")
    || /[\x00-\x20\x7f~^:?*\[\\]/.test(branch)
    || branch.split("/").some((segment) => !segment || segment.startsWith(".") || segment.endsWith(".lock"));
  if (invalid) throw new Error(`Invalid ${label}: ${branch || "(empty)"}`);
  return branch;
}

function safeRepository(value) {
  const repository = String(value || "").trim();
  if (!repository || repository.startsWith("-") || /[\x00-\x1f\x7f]/.test(repository)) throw new Error("repository is required");
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)) {
    let parsed;
    try { parsed = new URL(repository); } catch { throw new Error("repository must be a valid Git URL or local path"); }
    if (parsed.password || (parsed.username && parsed.protocol !== "ssh:")) {
      throw new Error("repository URLs must not contain embedded credentials");
    }
  }
  return repository;
}

function sharedRepositoryIdentity(repository) {
  const identity = contextHubRepositoryIdentity(safeRepository(repository));
  if (!identity.startsWith("local:")) return identity;
  const requestedPath = path.resolve(identity.slice("local:".length));
  let existing = requestedPath;
  const suffix = [];
  while (!lstatIfPresent(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  let physical = existing;
  try { physical = fs.realpathSync(existing); } catch {}
  return `local:${path.join(physical, ...suffix)}`;
}

function sameSharedRepository(left, right) {
  try {
    return sharedRepositoryIdentity(left) === sharedRepositoryIdentity(right);
  } catch {
    return false;
  }
}

function authenticatedSharedGit(repository, push = null, timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS) {
  if (!push) return null;
  const remote = safeRepository(push.url);
  let parsed;
  try { parsed = new URL(remote); } catch {
    const error = new Error("GitHub App credential remote is invalid");
    error.code = "github-app-credential-invalid";
    throw error;
  }
  if (parsed.protocol !== "https:"
    || parsed.hostname.toLowerCase() !== "github.com"
    || parsed.username
    || parsed.password
    || parsed.search
    || parsed.hash
    || !/^\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+(?:\.git)?$/.test(parsed.pathname)
    || !sameSharedRepository(repository, remote)) {
    const error = new Error("GitHub App credential does not match the exact Shared repository");
    error.code = "github-app-credential-invalid";
    throw error;
  }
  const boundedTimeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
    ? Math.floor(Number(timeoutMs))
    : DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS;
  const credential = assertFreshGitHubAppCredential(push, {
    minimumValidityMs: Math.max(1_000, Math.min(boundedTimeoutMs, 30_000)),
  });
  return {
    remote,
    credential: { ...credential, repository: remote },
    timeoutMs: boundedTimeoutMs,
  };
}

function replaceSharedFileNoFollow(root, relativePath, content) {
  const inspected = inspectSharedPathNoFollow(root, relativePath);
  if (!inspected.exists) throw new Error(`Shared file does not exist: ${safeRelativePath(relativePath, "shared file path")}`);
  const current = fs.lstatSync(inspected.target, { bigint: true });
  if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1n) {
    throw unsafeSharedFilesystemPath(`Shared filesystem target must be one regular file: ${inspected.target}`);
  }
  const temporary = path.join(inspected.parent, `.context-room-${process.pid}-${randomUUID()}.tmp`);
  const flags = fs.constants.O_WRONLY
    | fs.constants.O_CREAT
    | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  let completed = false;
  try {
    descriptor = fs.openSync(temporary, flags, Number(current.mode & 0o777n));
    fs.writeFileSync(descriptor, content, "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    assertInspectedSharedParentUnchanged(inspected);
    const beforeInstall = fs.lstatSync(inspected.target, { bigint: true });
    if (!beforeInstall.isFile()
      || beforeInstall.isSymbolicLink()
      || beforeInstall.dev !== current.dev
      || beforeInstall.ino !== current.ino
      || beforeInstall.nlink !== 1n) {
      throw unsafeSharedFilesystemPath(`Shared filesystem target changed during replacement: ${inspected.target}`);
    }
    fs.renameSync(temporary, inspected.target);
    completed = true;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    if (!completed) {
      try { fs.unlinkSync(temporary); } catch {}
    }
  }
}

function safeRevision(value, label = "revision") {
  const revision = String(value || "").trim().toLowerCase();
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(revision)) throw new Error(`Invalid ${label}`);
  return revision;
}

function safeSessionId(value, { optional = true } = {}) {
  const sessionId = String(value || "").trim();
  if (!sessionId && optional) return "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(sessionId)) {
    throw new Error("session must use letters, numbers, dots, underscores, or hyphens");
  }
  return sessionId;
}

function proposalTitle(value, fallback = "Shared context proposal") {
  const title = String(value || fallback).trim();
  if (!title) throw new Error("proposal title is required");
  if (/\r|\n/.test(title)) throw new Error("proposal title must stay on one line");
  if (title.length > MAX_PROPOSAL_TITLE_LENGTH) throw new Error(`proposal title must be ${MAX_PROPOSAL_TITLE_LENGTH} characters or fewer`);
  return title;
}

function proposalDescription(value, { optional = true } = {}) {
  const description = String(value || "").replaceAll("\r\n", "\n").trim();
  if (!description && !optional) throw new Error("proposal description is required");
  if (description.length > MAX_PROPOSAL_DESCRIPTION_LENGTH) {
    throw new Error(`proposal description must be ${MAX_PROPOSAL_DESCRIPTION_LENGTH} characters or fewer`);
  }
  return description;
}

export function validateSharedProposalInput({
  title,
  description = "",
  scope = "project",
  branch = "",
  sessionId = "",
} = {}) {
  if (!["project", "global", "skills", "instructions"].includes(scope)) {
    throw new Error("Proposal scope must be project, global, skills, or instructions");
  }
  return {
    title: proposalTitle(title),
    description: proposalDescription(description),
    scope,
    branch: branch ? safeBranchName(branch, "proposal branch") : "",
    sessionId: safeSessionId(sessionId),
  };
}

export function validateSharedProposalPublicationInput({ title, description } = {}) {
  return {
    ...(title === undefined ? {} : { title: proposalTitle(title) }),
    ...(description === undefined ? {} : { description: proposalDescription(description) }),
  };
}

function encodeProposalDescription(value) {
  const description = proposalDescription(value);
  return description ? Buffer.from(description, "utf8").toString("base64url") : "";
}

function decodeProposalDescription(value) {
  const encoded = String(value || "").trim();
  if (!encoded) return "";
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return "";
  try {
    const decoded = Buffer.from(encoded, "base64url");
    if (decoded.toString("base64url") !== encoded) return "";
    return proposalDescription(decoded.toString("utf8"));
  } catch {
    return "";
  }
}

function pathsOverlap(left, right) {
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

function normalizedRepositoryConfig(raw = {}) {
  const version = Number(raw.version || SHARED_REPOSITORY_SCHEMA_VERSION);
  if (version !== SHARED_REPOSITORY_SCHEMA_VERSION) throw new Error(`Unsupported shared repository version: ${version}`);
  const defaultBranch = safeBranchName(raw.defaultBranch || "main", "shared default branch");
  const proposalPrefix = String(raw.proposalPrefix || "proposal/").trim();
  if (!proposalPrefix.endsWith("/")) throw new Error("Proposal prefix must end with /");
  safeBranchName(proposalPrefix + "example", "proposal prefix");
  const acceptancePrefix = String(raw.acceptancePrefix || "accepted/").trim();
  if (!acceptancePrefix.endsWith("/")) throw new Error("Acceptance prefix must end with /");
  safeBranchName(acceptancePrefix + "example", "acceptance prefix");
  const rejectionPrefix = String(raw.rejectionPrefix || "rejected/").trim();
  if (!rejectionPrefix.endsWith("/")) throw new Error("Rejection prefix must end with /");
  safeBranchName(rejectionPrefix + "example", "rejection prefix");
  if (new Set([proposalPrefix, acceptancePrefix, rejectionPrefix]).size !== 3) {
    throw new Error("proposalPrefix, acceptancePrefix, and rejectionPrefix must be different");
  }
  const config = {
    version,
    name: String(raw.name || "Shared Context").trim() || "Shared Context",
    defaultBranch,
    proposalPrefix,
    acceptancePrefix,
    rejectionPrefix,
    globalSkillsPath: safeRelativePath(raw.globalSkillsPath || "skills/global", "globalSkillsPath"),
    skillLocationsFile: safeRelativePath(raw.skillLocationsFile || "skill-locations.json", "skillLocationsFile"),
    instructionLocationsFile: safeRelativePath(raw.instructionLocationsFile || "instruction-locations.json", "instructionLocationsFile"),
    projectsPath: safeRelativePath(raw.projectsPath || "projects", "projectsPath"),
    projectsFile: safeRelativePath(raw.projectsFile || "projects.json", "projectsFile"),
  };
  if (pathsOverlap(config.globalSkillsPath, config.projectsPath)) throw new Error("globalSkillsPath and projectsPath must not overlap");
  if ([config.globalSkillsPath, config.skillLocationsFile, config.instructionLocationsFile, config.projectsPath, config.projectsFile].some((value) => value === ".context-room" || value.startsWith(".context-room/"))) {
    throw new Error("Shared content paths must stay outside .context-room runtime state");
  }
  if (pathsOverlap(config.projectsFile, config.globalSkillsPath) || pathsOverlap(config.projectsFile, config.projectsPath)) {
    throw new Error("projectsFile must stay outside the shared content roots");
  }
  if ([config.globalSkillsPath, config.projectsPath, config.projectsFile].some((value) => pathsOverlap(config.skillLocationsFile, value))) {
    throw new Error("skillLocationsFile must stay outside shared content roots and projectsFile");
  }
  if ([config.globalSkillsPath, config.projectsPath, config.projectsFile, config.skillLocationsFile].some((value) => pathsOverlap(config.instructionLocationsFile, value))) {
    throw new Error("instructionLocationsFile must stay outside shared content roots, projectsFile, and skillLocationsFile");
  }
  return config;
}

function githubRepositoryCoordinates(repository) {
  const value = safeRepository(repository).replace(/\.git$/i, "");
  let match = value.match(/^git@github\.com:([^/]+)\/(.+)$/i);
  if (!match) match = value.match(/^ssh:\/\/(?:git@)?github\.com\/([^/]+)\/(.+)$/i);
  if (!match) match = value.match(/^https?:\/\/github\.com\/([^/]+)\/(.+)$/i);
  if (!match) throw new Error("GitHub security setup requires a github.com repository remote");
  const owner = match[1];
  const repo = match[2];
  if (!owner || !repo || repo.includes("/")) throw new Error("Unable to resolve GitHub owner/repository from the shared remote");
  return { owner, repo, fullName: `${owner}/${repo}` };
}

function githubPullRequestUrl(repository, baseBranch, headBranch) {
  try {
    const { owner, repo } = githubRepositoryCoordinates(repository);
    return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(headBranch)}?expand=1`;
  } catch {
    return "";
  }
}

function safeSourceSubpath(value) {
  const clean = String(value || ".").trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return clean === "." ? "." : safeRelativePath(clean, "project source subpath");
}

function normalizedProjectsCatalog(raw = {}) {
  if (Number(raw.version || 1) !== 1) throw new Error(`Unsupported shared projects version: ${raw.version}`);
  if (!Array.isArray(raw.projects)) throw new Error("Shared projects catalog must contain a projects array");
  const seen = new Set();
  const projects = raw.projects.map((item) => {
    const id = safeId(item?.id, "project id");
    if (["global", "skills", "instructions"].includes(id)) {
      throw new Error(`Shared project id is reserved for a built-in proposal scope: ${id}`);
    }
    if (seen.has(id)) throw new Error(`Duplicate shared project id: ${id}`);
    seen.add(id);
    const source = item?.source && typeof item.source === "object" ? {
      remotes: [...new Set((item.source.remotes || []).map((remote) => sharedRepositoryIdentity(safeRepository(remote))).filter(Boolean))],
      subpath: safeSourceSubpath(item.source.subpath || "."),
    } : null;
    if (source && !source.remotes.length) throw new Error(`Shared project ${id} source.remotes must not be empty`);
    return { id, title: String(item?.title || id).trim() || id, source };
  });
  return { version: 1, projects };
}

const SHARED_SKILL_PROVIDER_PROFILES = Object.freeze(Object.fromEntries(
  ["codex", "claude-code", "opencode"].map((id) => {
    const profile = contextProviderProfile(id);
    return [id, Object.freeze({
      id,
      label: profile.label,
      globalPath: profile.skills.global[0],
      projectPath: profile.skills.project[0],
      instructionDeviceRoot: profile.instructions.deviceRoot,
      nativeInstructionTargets: profile.instructions.nativeTargets,
      configuredInstructionTargets: profile.instructions.configuredTargets,
      profileVersion: profile.version,
    })];
  }),
));

function safeSkillName(value, label = "skill name") {
  const name = String(value || "").trim();
  if (name === "*") return name;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name)) throw new Error(`Invalid ${label}: ${name || "(empty)"}`);
  return name;
}

function normalizedSkillSelection(values, fallback = []) {
  const source = Array.isArray(values) ? values : fallback;
  return [...new Set(source.map((value) => safeSkillName(value)).filter(Boolean))];
}

function assertSharedCollectionPathIsolated(kind, id, collectionPath, repositoryConfig) {
  if (!repositoryConfig) return;
  const reservedPaths = [
    ".context-room",
    repositoryConfig.projectsFile,
    repositoryConfig.skillLocationsFile,
    repositoryConfig.instructionLocationsFile,
  ];
  const reservedPath = reservedPaths.find((candidate) => pathsOverlap(collectionPath, candidate));
  if (reservedPath) {
    throw new Error(`Shared ${kind} collection ${id} overlaps reserved shared path: ${reservedPath}`);
  }
}

function normalizedSharedSkillLocations(raw = {}, { repositoryConfig, catalog } = {}) {
  const version = Number(raw.version || SHARED_SKILL_LOCATIONS_SCHEMA_VERSION);
  if (version !== SHARED_SKILL_LOCATIONS_SCHEMA_VERSION) throw new Error(`Unsupported shared skill locations version: ${version}`);
  if (!Array.isArray(raw.collections) || !Array.isArray(raw.assignments)) {
    throw new Error("Shared skill locations must contain collections and assignments arrays");
  }
  const collectionIds = new Set();
  const collectionPaths = [];
  const collections = raw.collections.map((item) => {
    const id = safeId(item?.id, "skill collection id");
    if (collectionIds.has(id)) throw new Error(`Duplicate shared skill collection id: ${id}`);
    collectionIds.add(id);
    const collectionPath = safeRelativePath(item?.path, `skill collection ${id} path`);
    assertSharedCollectionPathIsolated("skill", id, collectionPath, repositoryConfig);
    if (collectionPaths.some((existing) => pathsOverlap(existing, collectionPath))) {
      throw new Error(`Shared skill collections must not overlap: ${collectionPath}`);
    }
    collectionPaths.push(collectionPath);
    return { id, title: String(item?.title || id).trim() || id, path: collectionPath };
  });
  const projectIds = new Set((catalog?.projects || []).map((project) => project.id));
  const assignmentIds = new Set();
  const assignments = raw.assignments.map((item) => {
    const id = safeId(item?.id, "skill assignment id");
    if (assignmentIds.has(id)) throw new Error(`Duplicate shared skill assignment id: ${id}`);
    assignmentIds.add(id);
    const collectionId = safeId(item?.collectionId, `skill assignment ${id} collectionId`);
    if (!collectionIds.has(collectionId)) throw new Error(`Skill assignment ${id} references unknown collection: ${collectionId}`);
    const scope = String(item?.scope || "").trim();
    if (!new Set(["project", "shared", "device"]).has(scope)) throw new Error(`Invalid skill assignment scope: ${scope || "(empty)"}`);
    const providers = [...new Set((item?.providers || []).map((provider) => safeId(provider, `skill assignment ${id} provider`)))];
    if (!providers.length) throw new Error(`Skill assignment ${id} must declare at least one provider`);
    const unknownProvider = providers.find((provider) => !SHARED_SKILL_PROVIDER_PROFILES[provider]);
    if (unknownProvider) throw new Error(`Skill assignment ${id} references unsupported provider: ${unknownProvider}`);
    const projectIdsForAssignment = [...new Set((item?.projectIds || []).map((projectId) => safeId(projectId, `skill assignment ${id} projectId`)))];
    if (scope === "project" && !projectIdsForAssignment.length) throw new Error(`Project skill assignment ${id} must declare projectIds`);
    if (scope !== "project" && projectIdsForAssignment.length) throw new Error(`Skill assignment ${id} may use projectIds only with project scope`);
    const unknownProject = projectIdsForAssignment.find((projectId) => catalog && !projectIds.has(projectId));
    if (unknownProject) throw new Error(`Skill assignment ${id} references unknown project: ${unknownProject}`);
    const include = normalizedSkillSelection(item?.include, ["*"]);
    const exclude = normalizedSkillSelection(item?.exclude, []);
    if (include.includes("*") && include.length > 1) throw new Error(`Skill assignment ${id} cannot combine * with named includes`);
    if (exclude.includes("*")) throw new Error(`Skill assignment ${id} cannot exclude *`);
    return { id, collectionId, scope, projectIds: projectIdsForAssignment, providers, include, exclude };
  });
  return { version, collections, assignments, legacy: false };
}

function legacySharedSkillLocations(repositoryConfig, catalog) {
  const collections = [{ id: "global", title: "Global skills", path: repositoryConfig.globalSkillsPath }];
  const assignments = [{ id: "global-codex", collectionId: "global", scope: "device", projectIds: [], providers: ["codex"], include: ["*"], exclude: [] }];
  for (const project of catalog.projects || []) {
    const collectionId = `project-${project.id}`;
    collections.push({ id: collectionId, title: `${project.title} skills`, path: `${repositoryConfig.projectsPath}/${project.id}/skills` });
    assignments.push({ id: `${collectionId}-codex`, collectionId, scope: "project", projectIds: [project.id], providers: ["codex"], include: ["*"], exclude: [] });
  }
  return { version: SHARED_SKILL_LOCATIONS_SCHEMA_VERSION, collections, assignments, legacy: true };
}

function readSharedSkillLocationsFromRoot(root, repositoryConfig, catalog, { allowLegacy = true } = {}) {
  const filePath = path.join(root, repositoryConfig.skillLocationsFile);
  if (!fs.existsSync(filePath)) {
    if (!allowLegacy) throw new Error(`Missing ${repositoryConfig.skillLocationsFile}`);
    return legacySharedSkillLocations(repositoryConfig, catalog);
  }
  return normalizedSharedSkillLocations(readJson(filePath), { repositoryConfig, catalog });
}

function readSharedSkillLocationsFromRevision(checkout, revision, repositoryConfig, catalog, { allowLegacy = true } = {}) {
  if (!gitObjectExists(checkout, `${revision}:${repositoryConfig.skillLocationsFile}`)) {
    if (!allowLegacy) throw new Error(`Missing ${repositoryConfig.skillLocationsFile}`);
    return legacySharedSkillLocations(repositoryConfig, catalog);
  }
  const raw = JSON.parse(String(runGit(checkout, ["show", `${revision}:${repositoryConfig.skillLocationsFile}`])));
  return normalizedSharedSkillLocations(raw, { repositoryConfig, catalog });
}

function sharedSkillLocationsDocument(locations) {
  return {
    $schema: SHARED_SKILL_LOCATIONS_SCHEMA_URL,
    version: SHARED_SKILL_LOCATIONS_SCHEMA_VERSION,
    collections: locations.collections.map(({ id, title, path: collectionPath }) => ({ id, title, path: collectionPath })),
    assignments: locations.assignments.map(({ id, collectionId, scope, projectIds, providers, include, exclude }) => ({
      id,
      collectionId,
      scope,
      ...(scope === "project" ? { projectIds } : {}),
      providers,
      include,
      exclude,
    })),
  };
}

function safeInstructionPath(value, label = "instruction path") {
  const result = safeRelativePath(value, label);
  if (result === ".context-room" || result.startsWith(".context-room/")) throw new Error(`${label} must stay outside .context-room runtime state`);
  if (!/\.mdx?$/i.test(result)) throw new Error(`${label} must point to a Markdown instruction file`);
  return result;
}

function normalizedSharedInstructionLocations(raw = {}, { repositoryConfig, catalog } = {}) {
  const version = Number(raw.version || SHARED_INSTRUCTION_LOCATIONS_SCHEMA_VERSION);
  if (version !== SHARED_INSTRUCTION_LOCATIONS_SCHEMA_VERSION) throw new Error(`Unsupported shared instruction locations version: ${version}`);
  if (!Array.isArray(raw.collections) || !Array.isArray(raw.assignments)) {
    throw new Error("Shared instruction locations must contain collections and assignments arrays");
  }
  const collectionIds = new Set();
  const collectionPaths = [];
  const collections = raw.collections.map((item) => {
    const id = safeId(item?.id, "instruction collection id");
    if (collectionIds.has(id)) throw new Error(`Duplicate shared instruction collection id: ${id}`);
    collectionIds.add(id);
    const collectionPath = safeRelativePath(item?.path, `instruction collection ${id} path`);
    assertSharedCollectionPathIsolated("instruction", id, collectionPath, repositoryConfig);
    if (collectionPaths.some((existing) => pathsOverlap(existing, collectionPath))) {
      throw new Error(`Shared instruction collections must not overlap: ${collectionPath}`);
    }
    collectionPaths.push(collectionPath);
    return { id, title: String(item?.title || id).trim() || id, path: collectionPath };
  });
  const knownProjects = new Set((catalog?.projects || []).map((project) => project.id));
  const assignmentIds = new Set();
  const assignments = raw.assignments.map((item) => {
    const id = safeId(item?.id, "instruction assignment id");
    if (assignmentIds.has(id)) throw new Error(`Duplicate shared instruction assignment id: ${id}`);
    assignmentIds.add(id);
    const collectionId = safeId(item?.collectionId, `instruction assignment ${id} collectionId`);
    if (!collectionIds.has(collectionId)) throw new Error(`Instruction assignment ${id} references unknown collection: ${collectionId}`);
    const scope = String(item?.scope || "").trim();
    if (!new Set(["project", "shared", "device"]).has(scope)) throw new Error(`Invalid instruction assignment scope: ${scope || "(empty)"}`);
    const projectIds = [...new Set((item?.projectIds || []).map((projectId) => safeId(projectId, `instruction assignment ${id} projectId`)))];
    if (scope === "project" && !projectIds.length) throw new Error(`Project instruction assignment ${id} must declare projectIds`);
    if (scope !== "project" && projectIds.length) throw new Error(`Instruction assignment ${id} may use projectIds only with project scope`);
    const unknownProject = projectIds.find((projectId) => catalog && !knownProjects.has(projectId));
    if (unknownProject) throw new Error(`Instruction assignment ${id} references unknown project: ${unknownProject}`);
    if (!Array.isArray(item?.files) || !item.files.length) throw new Error(`Instruction assignment ${id} must declare files`);
    const seenFiles = new Set();
    const files = item.files.map((file) => {
      const source = safeInstructionPath(file?.source, `instruction assignment ${id} source`);
      const target = safeInstructionPath(file?.target, `instruction assignment ${id} target`);
      const providers = [...new Set((file?.providers || []).map((provider) => safeId(provider, `instruction assignment ${id} provider`)))];
      if (!providers.length) throw new Error(`Instruction assignment ${id} file ${source} must declare providers`);
      const unknownProvider = providers.find((provider) => !SHARED_SKILL_PROVIDER_PROFILES[provider]);
      if (unknownProvider) throw new Error(`Instruction assignment ${id} references unsupported provider: ${unknownProvider}`);
      const identity = `${source}\0${target}\0${providers.join(",")}`;
      if (seenFiles.has(identity)) throw new Error(`Instruction assignment ${id} contains a duplicate file mapping: ${source}`);
      seenFiles.add(identity);
      return { source, target, providers };
    });
    return { id, collectionId, scope, projectIds, files };
  });
  return { version, collections, assignments };
}

function emptySharedInstructionLocations() {
  return { version: SHARED_INSTRUCTION_LOCATIONS_SCHEMA_VERSION, collections: [], assignments: [] };
}

function readSharedInstructionLocationsFromRoot(root, repositoryConfig, catalog) {
  const filePath = path.join(root, repositoryConfig.instructionLocationsFile);
  return fs.existsSync(filePath)
    ? normalizedSharedInstructionLocations(readJson(filePath), { repositoryConfig, catalog })
    : emptySharedInstructionLocations();
}

function readSharedInstructionLocationsFromRevision(checkout, revision, repositoryConfig, catalog) {
  const manifest = `${revision}:${repositoryConfig.instructionLocationsFile}`;
  if (!gitObjectExists(checkout, manifest)) return emptySharedInstructionLocations();
  return normalizedSharedInstructionLocations(
    JSON.parse(String(runGit(checkout, ["show", manifest]))),
    { repositoryConfig, catalog },
  );
}

function sharedCollectionAssignmentApplies(assignment, projectId) {
  return assignment.scope === "device"
    || assignment.scope === "shared"
    || (assignment.scope === "project" && assignment.projectIds.includes(projectId));
}

function assertSharedCollectionVisibility(kind, collection, locations, repositoryConfig, catalog) {
  const assignments = (locations.assignments || []).filter((assignment) => assignment.collectionId === collection.id);
  const globalRoot = repositoryConfig.globalSkillsPath;
  if (collection.path === globalRoot || collection.path.startsWith(globalRoot + "/")) {
    if (!assignments.some((assignment) => assignment.scope === "device" || assignment.scope === "shared")) {
      throw new Error(`Shared ${kind} collection ${collection.id} overlaps always-visible global skills without a shared or device assignment: ${globalRoot}`);
    }
  } else if (globalRoot.startsWith(collection.path + "/")) {
    throw new Error(`Shared ${kind} collection ${collection.id} is an ancestor of always-visible global skills: ${globalRoot}`);
  }

  if (collection.path === repositoryConfig.projectsPath || repositoryConfig.projectsPath.startsWith(collection.path + "/")) {
    throw new Error(`Shared ${kind} collection ${collection.id} is an ancestor of the shared projects root: ${repositoryConfig.projectsPath}`);
  }
  for (const project of catalog.projects || []) {
    for (const suffix of ["docs", "skills"]) {
      const visibleRoot = `${repositoryConfig.projectsPath}/${project.id}/${suffix}`;
      if (collection.path === visibleRoot || collection.path.startsWith(visibleRoot + "/")) {
        if (!assignments.some((assignment) => sharedCollectionAssignmentApplies(assignment, project.id))) {
          throw new Error(`Shared ${kind} collection ${collection.id} overlaps an always-visible root without an assignment for ${project.id}: ${visibleRoot}`);
        }
      } else if (visibleRoot.startsWith(collection.path + "/")) {
        throw new Error(`Shared ${kind} collection ${collection.id} is an ancestor of an always-visible project root: ${visibleRoot}`);
      }
    }
  }
}

function sharedCollectionPathIsAlwaysVisible(collection, repositoryConfig, catalog) {
  const visibleRoots = [
    repositoryConfig.globalSkillsPath,
    ...(catalog.projects || []).flatMap((project) => [
      `${repositoryConfig.projectsPath}/${project.id}/docs`,
      `${repositoryConfig.projectsPath}/${project.id}/skills`,
    ]),
  ];
  return visibleRoots.some((visibleRoot) => collection.path === visibleRoot || collection.path.startsWith(visibleRoot + "/"));
}

function assertSharedCollectionManifestsDisjoint(skillLocations, instructionLocations, repositoryConfig, catalog) {
  for (const skillCollection of skillLocations.collections || []) {
    for (const instructionCollection of instructionLocations.collections || []) {
      if (!pathsOverlap(skillCollection.path, instructionCollection.path)) continue;
      throw new Error(
        `Shared skill collection ${skillCollection.id} overlaps shared instruction collection ${instructionCollection.id}: ${skillCollection.path} and ${instructionCollection.path}`,
      );
    }
  }
  for (const collection of skillLocations.collections || []) {
    assertSharedCollectionVisibility("skill", collection, skillLocations, repositoryConfig, catalog);
  }
  for (const collection of instructionLocations.collections || []) {
    assertSharedCollectionVisibility("instruction", collection, instructionLocations, repositoryConfig, catalog);
  }
}

function readValidatedSharedLocationsFromRoot(root, repositoryConfig, catalog) {
  const skillLocations = readSharedSkillLocationsFromRoot(root, repositoryConfig, catalog);
  const instructionLocations = readSharedInstructionLocationsFromRoot(root, repositoryConfig, catalog);
  assertSharedCollectionManifestsDisjoint(skillLocations, instructionLocations, repositoryConfig, catalog);
  return { skillLocations, instructionLocations };
}

function readValidatedSharedLocationsFromRevision(checkout, revision, repositoryConfig, catalog) {
  const skillLocations = readSharedSkillLocationsFromRevision(checkout, revision, repositoryConfig, catalog);
  const instructionLocations = readSharedInstructionLocationsFromRevision(checkout, revision, repositoryConfig, catalog);
  assertSharedCollectionManifestsDisjoint(skillLocations, instructionLocations, repositoryConfig, catalog);
  return { skillLocations, instructionLocations };
}

function sharedInstructionLocationsDocument(locations) {
  return {
    $schema: SHARED_INSTRUCTION_LOCATIONS_SCHEMA_URL,
    version: SHARED_INSTRUCTION_LOCATIONS_SCHEMA_VERSION,
    collections: locations.collections.map(({ id, title, path: collectionPath }) => ({ id, title, path: collectionPath })),
    assignments: locations.assignments.map(({ id, collectionId, scope, projectIds, files }) => ({
      id,
      collectionId,
      scope,
      ...(scope === "project" ? { projectIds } : {}),
      files: files.map(({ source, target, providers }) => ({ source, target, providers })),
    })),
  };
}

function registryPath() {
  return path.join(sharedHome(), "registry.json");
}

function writeSharedRegistry(registry) {
  const written = writePrivateJson(registryPath(), { ...registry, version: 1, bindings: registry.bindings || [] });
  const fileDescriptor = fs.openSync(registryPath(), "r");
  try { fs.fsyncSync(fileDescriptor); } finally { fs.closeSync(fileDescriptor); }
  const directoryDescriptor = fs.openSync(path.dirname(registryPath()), "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  return written;
}

function sharedRegistryLockPath() {
  return `${registryPath()}.lock`;
}

function sharedRepositoryCloneLockPath(repository) {
  return path.join(sharedHome(), "locks", `repository-${hashKey(sharedRepositoryIdentity(repository), 24)}.lock`);
}

// Cross-process lock order is Shared registry -> repository transaction -> managed destinations.
// Code holding a later lock must never acquire an earlier one.
function withSharedRegistryLock(operation, { allowRecoveryIssues = false } = {}) {
  const lockPath = sharedRegistryLockPath();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return withFilesystemLock(lockPath, (lease) => {
    const recoveredSharedTransactions = recoverSharedDisconnectTransactionsUnderLock();
    const sharedRecoveryIssues = readInvalidSharedDisconnectRecoveryIssuesUnderLock();
    if (sharedRecoveryIssues.length && !allowRecoveryIssues) {
      const error = sharedContextError(
        "shared-disconnect-recovery-required",
        "Shared Context quarantined an unreadable disconnect journal; review and acknowledge the global recovery issue before making more Shared changes",
        {
          scope: "global",
          issues: sharedRecoveryIssues.map((issue) => ({
            quarantineId: issue.quarantineId,
            revision: issue.revision,
            code: issue.code,
          })),
        },
      );
      error.statusCode = 409;
      throw error;
    }
    return operation({ ...lease, recoveredSharedTransactions, sharedRecoveryIssues });
  }, {
    timeoutMs: SHARED_REGISTRY_LOCK_TIMEOUT_MS,
    staleMs: SHARED_REGISTRY_LOCK_STALE_MS,
    busyMessage: "Shared Context registry is busy in another process",
    busyCode: "shared_context_registry_busy",
  });
}

export function recoverSharedContextTransactions() {
  return withSharedRegistryLock(({ recoveredSharedTransactions }) => ({
    recovered: recoveredSharedTransactions,
  }));
}

function withSharedRepositoryCloneLock(repository, operation, timeoutMs) {
  const lockPath = sharedRepositoryCloneLockPath(repository);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  return withFilesystemLock(lockPath, operation, {
    timeoutMs: Math.max(1, Math.min(
      DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
      Number.isFinite(Number(timeoutMs)) ? Math.floor(Number(timeoutMs)) : DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
    )),
    staleMs: SHARED_REPOSITORY_CLONE_LOCK_STALE_MS,
    busyMessage: "Shared Context repository clone is busy in another process",
    busyCode: "shared_repository_clone_busy",
  });
}

function registeredRepositoryTransport(repository, registry = null) {
  const requested = safeRepository(repository);
  const current = registry || readJson(registryPath(), { version: 1, bindings: [] });
  const existing = (current.bindings || []).find((binding) => {
    try { return safeRepository(binding?.repository) === requested; } catch { return false; }
  }) || (current.bindings || []).find((binding) => sameSharedRepository(binding?.repository, requested));
  return existing ? safeRepository(existing.repository) : requested;
}

function historicalRepositoryTransports(repository, registry = null) {
  const requested = safeRepository(repository);
  const current = registry || readJson(registryPath(), { version: 1, bindings: [] });
  const identity = sharedRepositoryIdentity(requested);
  const transports = new Set([requested]);
  for (const binding of current.bindings || []) {
    try {
      const transport = safeRepository(binding?.repository);
      if (sharedRepositoryIdentity(transport) === identity) transports.add(transport);
    } catch {}
  }
  if (identity.startsWith("local:")) {
    const canonicalPath = identity.slice("local:".length);
    const paths = new Set([canonicalPath]);
    if (process.platform === "darwin" && canonicalPath.startsWith("/private/var/")) {
      paths.add(canonicalPath.slice("/private".length));
    }
    for (const localPath of paths) {
      transports.add(localPath);
      const localUrl = pathToFileURL(localPath);
      transports.add(localUrl.href);
      if (process.platform === "darwin") {
        localUrl.hostname = os.hostname();
        transports.add(localUrl.href);
      }
    }
  } else if (identity.startsWith("github:")) {
    const repositoryPath = identity.slice("github:".length);
    for (const suffix of [repositoryPath, `${repositoryPath}.git`]) {
      transports.add(`https://github.com/${suffix}`);
      transports.add(`git@github.com:${suffix}`);
      transports.add(`ssh://git@github.com/${suffix}`);
    }
  }
  return [...transports];
}

function sourceIdentity(root) {
  const resolved = stableRoot(root);
  const topLevel = tryGit(resolved, ["rev-parse", "--show-toplevel"]);
  if (!topLevel) return null;
  const transports = tryGit(topLevel, ["remote"]).split("\n").filter(Boolean)
    .flatMap((name) => tryGit(topLevel, ["remote", "get-url", "--all", name]).split("\n"))
    .map((remote) => String(remote || "").trim()).filter(Boolean);
  if (!transports.length) return null;
  const stableTopLevel = stableRoot(topLevel);
  const sourceSubpath = path.relative(stableTopLevel, resolved).replaceAll(path.sep, "/") || ".";
  return {
    topLevel: stableTopLevel,
    transports: [...new Set(transports)],
    remotes: [...new Set(transports.map(sharedRepositoryIdentity))],
    sourceSubpath,
  };
}

function stableRoot(root) {
  const resolved = path.resolve(root);
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function bindingMatchesSource(binding, source) {
  if (Number(binding?.sourceIdentityVersion) !== 2
    || !Array.isArray(binding?.sourceRemotes)
    || !Array.isArray(binding?.sourceRemoteIdentities)) return false;
  const transports = binding.sourceRemotes.map((remote) => String(remote || "").trim()).filter(Boolean);
  let bindingRemotes;
  try {
    bindingRemotes = [...new Set(transports.map(sharedRepositoryIdentity))];
  } catch {
    return false;
  }
  const recorded = [...new Set(binding.sourceRemoteIdentities.map((identity) => String(identity || "").trim()).filter(Boolean))];
  if (bindingRemotes.length !== recorded.length || bindingRemotes.some((identity) => !recorded.includes(identity))) return false;
  if (!source || !source.remotes.some((remote) => bindingRemotes.includes(remote))) return false;
  const bindingPath = String(binding.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const sourcePath = String(source.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  return bindingPath === "." || sourcePath === bindingPath || sourcePath.startsWith(bindingPath + "/");
}

function bindingProjectCapability(binding, root) {
  const resolvedRoot = path.resolve(root);
  const candidates = Array.isArray(binding?.projectCapabilities) ? binding.projectCapabilities : [];
  return candidates.map((candidate) => normalizedSharedProjectCapability(candidate))
    .find((candidate) => candidate?.root === resolvedRoot) || null;
}

function bindingAttestsProjectRoot(binding, root) {
  const capability = bindingProjectCapability(binding, root);
  if (!capability) return false;
  try { return sameSharedProjectCapability(capability, currentSharedProjectCapability(capability.root)); }
  catch { return false; }
}

function registerSourceBindingUnderLock(root, connection, { projectCapability = null } = {}) {
  const source = sourceIdentity(root);
  const registry = readJson(registryPath(), { version: 1, bindings: [] });
  const repository = registeredRepositoryTransport(connection.repository, registry);
  const repositoryIdentity = sharedRepositoryIdentity(repository);
  const existingBindings = (registry.bindings || []).map((item) => (
    sameSharedRepository(item?.repository, repository)
      ? { ...item, repository, repositoryIdentity: String(item.repositoryIdentity || repositoryIdentity) }
      : item
  ));
  const registeredRoot = stableRoot(root);
  const registeredCapability = projectCapability
    ? assertSharedProjectCapability(projectCapability, "Shared binding project")
    : currentSharedProjectCapability(registeredRoot);
  if (registeredCapability.root !== registeredRoot) {
    throw sharedContextError("shared-project-capability-mismatch", "Shared binding capability does not match its exact project root");
  }
  const previous = existingBindings.find((item) => (
    source
      ? String(item.sourceSubpath || ".") === source.sourceSubpath && bindingMatchesSource(item, source)
      : item.sourceRoot && stableRoot(item.sourceRoot) === registeredRoot
  ));
  const stableRepositoryIdentity = String(previous?.repositoryIdentity || repositoryIdentity);
  const projectCapabilities = [
    ...(Array.isArray(previous?.projectCapabilities) ? previous.projectCapabilities : [])
      .map((candidate) => normalizedSharedProjectCapability(candidate))
      .filter((candidate) => candidate && candidate.root !== registeredRoot),
    registeredCapability,
  ];
  const binding = source ? {
    repository,
    repositoryIdentity: stableRepositoryIdentity,
    projectId: connection.projectId,
    sourceIdentityVersion: 2,
    sourceRemotes: source.transports,
    sourceRemoteIdentities: source.remotes,
    sourceSubpath: source.sourceSubpath,
    projectRoots: [...new Set([...(previous?.projectRoots || []), registeredRoot])],
    capabilityVersion: 1,
    projectCapabilities,
  } : {
    repository,
    repositoryIdentity: stableRepositoryIdentity,
    projectId: connection.projectId,
    sourceRoot: registeredRoot,
    projectRoots: [...new Set([...(previous?.projectRoots || []), registeredRoot])],
    capabilityVersion: 1,
    projectCapabilities,
  };
  registry.bindings = [...existingBindings.filter((item) => !(
    source
      ? String(item.sourceSubpath || ".") === binding.sourceSubpath && bindingMatchesSource(item, source)
      : item.sourceRoot && stableRoot(item.sourceRoot) === binding.sourceRoot
  )), binding];
  writeSharedRegistry(registry);
  return binding;
}

function registerSourceBinding(root, connection) {
  return withSharedRegistryLock(() => registerSourceBindingUnderLock(root, connection));
}

function ambiguousSharedBinding(candidates, sourceSubpath) {
  const error = new Error("This Git worktree matches multiple equally specific Shared bindings");
  error.code = "shared_context_binding_ambiguous";
  error.statusCode = 409;
  error.details = {
    sourceSubpath: String(sourceSubpath || "."),
    candidates: candidates.map((binding) => ({
      repository: safeRepository(binding.repository),
      projectId: safeId(binding.projectId, "projectId"),
      sourceSubpath: String(binding.sourceSubpath || "."),
    })),
  };
  return error;
}

function selectRegisteredBinding(matches, sourceSubpath, specificity) {
  if (!matches.length) return null;
  const topSpecificity = Math.max(...matches.map(specificity));
  const top = matches.filter((binding) => specificity(binding) === topSpecificity);
  const distinct = new Map();
  for (const binding of top) {
    const identity = `${sharedRepositoryIdentity(binding.repository)}\0${safeId(binding.projectId, "projectId")}\0${String(binding.sourceSubpath || binding.sourceRoot || ".")}`;
    if (!distinct.has(identity)) distinct.set(identity, binding);
  }
  if (distinct.size > 1) throw ambiguousSharedBinding([...distinct.values()], sourceSubpath);
  return top[0];
}

function resolveRegisteredConnection(root) {
  const source = sourceIdentity(root);
  const registry = readJson(registryPath(), { bindings: [] });
  if (!source) {
    const resolved = stableRoot(root);
    const matches = (registry.bindings || []).filter((binding) => {
      if (!binding.sourceRoot) return false;
      const bindingRoot = stableRoot(binding.sourceRoot);
      return resolved === bindingRoot || resolved.startsWith(bindingRoot + path.sep);
    });
    const binding = selectRegisteredBinding(matches, ".", (candidate) => String(candidate.sourceRoot || "").length);
    const projectRoot = binding ? stableRoot(binding.sourceRoot) : "";
    return binding && bindingAttestsProjectRoot(binding, projectRoot) ? {
      version: 1,
      repository: registeredRepositoryTransport(binding.repository, registry),
      projectId: safeId(binding.projectId, "projectId"),
      projectRoot,
    } : null;
  }
  const matches = (registry.bindings || []).filter((binding) => bindingMatchesSource(binding, source));
  const binding = selectRegisteredBinding(matches, source.sourceSubpath, (candidate) => String(candidate.sourceSubpath || ".").length);
  if (!binding) return null;
  const sourceSubpath = String(binding.sourceSubpath || ".").replace(/^\.\//, "").replace(/\/$/, "") || ".";
  const projectRoot = sourceSubpath === "." ? source.topLevel : path.join(source.topLevel, ...sourceSubpath.split("/"));
  const stableProjectRoot = stableRoot(projectRoot);
  if (!bindingAttestsProjectRoot(binding, stableProjectRoot)) return null;
  return {
    version: 1,
    repository: registeredRepositoryTransport(binding.repository, registry),
    projectId: safeId(binding.projectId, "projectId"),
    projectRoot: stableProjectRoot,
  };
}

function registeredProjectRoots(connection) {
  const repository = registeredRepositoryTransport(connection.repository);
  const projectId = safeId(connection.projectId, "projectId");
  const registry = readJson(registryPath(), { bindings: [] });
  return [...new Set((registry.bindings || [])
    .filter((binding) => sameSharedRepository(binding.repository, repository) && String(binding.projectId || "") === projectId)
    .flatMap((binding) => binding.projectRoots || (binding.sourceRoot ? [binding.sourceRoot] : []))
    .map(stableRoot)
    .filter((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isDirectory())
    .filter((candidate) => (registry.bindings || []).some((binding) => (
      sameSharedRepository(binding.repository, repository)
      && String(binding.projectId || "") === projectId
      && bindingAttestsProjectRoot(binding, candidate)
    ))))];
}

function registeredRepositoryProjectLocations(repository) {
  const safeRemote = registeredRepositoryTransport(repository);
  const registry = readJson(registryPath(), { bindings: [] });
  const locations = (registry.bindings || []).filter((binding) => sameSharedRepository(binding.repository, safeRemote))
    .flatMap((binding) => (binding.projectRoots || (binding.sourceRoot ? [binding.sourceRoot] : [])).map((root) => ({ binding, projectId: safeId(binding.projectId, "projectId"), root: stableRoot(root) })))
    .filter((item) => fs.existsSync(item.root) && fs.statSync(item.root).isDirectory())
    .filter((item) => bindingAttestsProjectRoot(item.binding, item.root))
    .map(({ projectId, root }) => ({ projectId, root }));
  return [...new Map(locations.map((item) => [`${item.projectId}:${item.root}`, item])).values()]
    .sort((left, right) => `${left.projectId}:${left.root}`.localeCompare(`${right.projectId}:${right.root}`, "en"));
}

export function listRegisteredSharedProjectLocations(repository) {
  return registeredRepositoryProjectLocations(repository);
}

function repositoryCacheRoot(repository) {
  const registry = readJson(registryPath(), { version: 1, bindings: [] });
  const transport = registeredRepositoryTransport(repository, registry);
  const registered = (registry.bindings || []).find((binding) => {
    try { return safeRepository(binding?.repository) === transport; } catch { return false; }
  }) || (registry.bindings || []).find((binding) => sameSharedRepository(binding?.repository, transport));
  const identity = sharedRepositoryIdentity(transport);
  if (registered?.repositoryIdentity && String(registered.repositoryIdentity) !== identity) {
    throw sharedRepositoryIdentityMismatch("Shared repository binding identity requires an explicit migration", {
      repository: transport,
      recordedIdentity: String(registered.repositoryIdentity),
      expectedIdentity: identity,
    });
  }
  const legacyTransports = historicalRepositoryTransports(repository, registry)
    .filter((candidate) => sameSharedRepository(candidate, transport));
  const legacyRoots = legacyTransports.map((candidate) => path.join(sharedHome(), hashKey(candidate)));
  const canonical = path.join(sharedHome(), hashKey(identity));
  const candidates = new Set();
  const unclaimedCandidates = new Set();
  for (const candidate of [...legacyRoots, canonical]) {
    if (!lstatIfPresent(candidate)) continue;
    const claimPath = path.join(candidate, "repository-identity.json");
    const claimStats = lstatIfPresent(claimPath);
    if (!claimStats && repositoryCacheRootContainsOnlyUnclaimedMetadata(candidate)) {
      continue;
    }
    if (claimStats) {
      assertRepositoryIdentityClaim(candidate, transport, { allowMissing: false });
    } else {
      assertHistoricalRepositoryCacheCandidate(candidate, transport);
      unclaimedCandidates.add(candidate);
    }
    candidates.add(candidate);
  }
  try {
    const physicalHome = fs.realpathSync(sharedHome());
    const legacyNames = fs.readdirSync(sharedHome()).filter((candidate) => /^[a-f0-9]{16}$/.test(candidate)).sort();
    if (legacyNames.length > 256) {
      throw sharedRepositoryIdentityMismatch("Too many legacy Shared repository caches exist to adopt one safely", {
        repository: transport,
        expectedIdentity: identity,
        cacheCount: legacyNames.length,
      });
    }
    for (const name of legacyNames) {
      const candidate = path.join(sharedHome(), name);
      const candidateStats = lstatIfPresent(candidate);
      if (!candidateStats || candidateStats.isSymbolicLink() || !candidateStats.isDirectory()) continue;
      if (fs.realpathSync(candidate) !== path.join(physicalHome, name)) continue;
      const claimPath = path.join(candidate, "repository-identity.json");
      const claimStats = lstatIfPresent(claimPath);
      if (!claimStats) {
        if (repositoryCacheRootContainsOnlyUnclaimedMetadata(candidate)) continue;
        try {
          assertHistoricalRepositoryCacheCandidate(candidate, transport);
        } catch (error) {
          if (error?.code === "shared-repository-identity-mismatch") continue;
          throw error;
        }
        candidates.add(candidate);
        unclaimedCandidates.add(candidate);
        continue;
      }
      if (claimStats.isSymbolicLink() || !claimStats.isFile()) continue;
      let claim = null;
      try { claim = readJson(claimPath, null); } catch { continue; }
      if (!claim || claim.version !== 1) continue;
      let claimRepository = "";
      let claimIdentity = "";
      try {
        claimRepository = safeRepository(claim.repository);
        claimIdentity = sharedRepositoryIdentity(claimRepository);
      } catch {
        continue;
      }
      if (claimIdentity !== identity || !sameSharedRepository(claimRepository, transport)) continue;
      if (String(claim.identity || "") !== claimIdentity) {
        throw sharedRepositoryIdentityMismatch("Shared repository cache identity requires an explicit migration", {
          repository: transport,
          cacheRoot: candidate,
          recordedIdentity: String(claim.identity || ""),
          expectedIdentity: claimIdentity,
        });
      }
      candidates.add(candidate);
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (candidates.size > 1) {
    throw sharedRepositoryIdentityMismatch("Multiple Shared repository caches claim the same canonical identity", {
      repository: transport,
      expectedIdentity: identity,
      cacheRoots: [...candidates].sort(),
    });
  }
  const [selected] = candidates;
  if (selected && unclaimedCandidates.has(selected)) writeRepositoryIdentityClaim(selected, transport);
  return selected || canonical;
}

function repositoryCacheRootContainsOnlyUnclaimedMetadata(cacheRoot) {
  const cacheStats = lstatIfPresent(cacheRoot);
  if (!cacheStats || cacheStats.isSymbolicLink() || !cacheStats.isDirectory()) return false;
  const entries = fs.readdirSync(cacheRoot, { withFileTypes: true });
  if (entries.length > 64) return false;
  return entries.every((entry) => {
    if (entry.isSymbolicLink()) return false;
    if (entry.name === "proposals.json.lock.reclaimers") return entry.isDirectory();
    if (entry.name === "proposals.json.lock" || entry.name === "proposals.json.lock.reclaim") {
      return entry.isFile();
    }
    if (entry.name === "github-security.json") return entry.isFile();
    return entry.isFile()
      && entry.name.startsWith(".context-room-filesystem-lock-")
      && entry.name.endsWith(".tmp");
  });
}

function assertHistoricalRepositoryCacheCandidate(cacheRoot, repository) {
  const transport = safeRepository(repository);
  const checkout = path.join(cacheRoot, "repository");
  assertSharedCacheDirectoryNoFollow(cacheRoot, "Historical Shared repository cache");
  assertSharedCacheDirectoryNoFollow(checkout, "Historical Shared repository checkout");
  assertSharedCacheDirectoryNoFollow(path.join(checkout, ".git"), "Historical Shared repository Git directory");
  try {
    assertRepositoryCheckoutIdentity(transport, checkout);
  } catch (error) {
    if (error?.code === "shared-repository-identity-mismatch") throw error;
    throw sharedRepositoryIdentityMismatch("Historical Shared repository cache origin cannot prove the requested repository identity", {
      repository: transport,
      cacheRoot,
      cause: String(error?.message || error),
    });
  }
  return cacheRoot;
}

function sharedRepositoryIdentityMismatch(message, details = {}) {
  return sharedContextError("shared-repository-identity-mismatch", message, details);
}

function assertRepositoryIdentityClaim(cacheRoot, repository, { allowMissing = true } = {}) {
  const transport = safeRepository(repository);
  const expectedIdentity = sharedRepositoryIdentity(transport);
  const claimPath = path.join(cacheRoot, "repository-identity.json");
  const claimStats = lstatIfPresent(claimPath, { bigint: true });
  if (!claimStats) {
    if (allowMissing) return null;
    throw sharedRepositoryIdentityMismatch("Shared repository cache has no identity claim", {
      repository: transport,
      cacheRoot,
    });
  }
  if (claimStats.isSymbolicLink() || !claimStats.isFile() || claimStats.nlink !== 1n) {
    throw unsafeSharedFilesystemPath(`Shared repository identity claim must be a single-link physical file: ${claimPath}`);
  }
  let claim;
  try {
    claim = readJson(claimPath, null);
  } catch {
    throw sharedRepositoryIdentityMismatch("Shared repository cache identity claim is invalid", {
      repository: transport,
      cacheRoot,
    });
  }
  let claimedRepository;
  let claimedIdentity;
  try {
    claimedRepository = safeRepository(claim?.repository);
    claimedIdentity = sharedRepositoryIdentity(claimedRepository);
  } catch {
    throw sharedRepositoryIdentityMismatch("Shared repository cache identity claim is invalid", {
      repository: transport,
      cacheRoot,
    });
  }
  if (claim?.version !== 1
    || String(claim.identity || "") !== claimedIdentity
    || claimedIdentity !== expectedIdentity
    || !sameSharedRepository(claimedRepository, transport)) {
    throw sharedRepositoryIdentityMismatch("Shared repository cache identity does not match the requested repository", {
      repository: transport,
      cacheRoot,
      claimedRepository,
      claimedIdentity: String(claim?.identity || ""),
      expectedIdentity,
    });
  }
  return { repository: claimedRepository, identity: claimedIdentity };
}

function writeRepositoryIdentityClaim(cacheRoot, repository) {
  const claimPath = path.join(cacheRoot, "repository-identity.json");
  const claimStats = lstatIfPresent(claimPath);
  if (claimStats && (claimStats.isSymbolicLink() || !claimStats.isFile())) {
    throw unsafeSharedFilesystemPath(`Shared repository identity claim must be a physical file: ${claimPath}`);
  }
  if (claimStats) assertRepositoryIdentityClaim(cacheRoot, repository, { allowMissing: false });
  const transport = safeRepository(repository);
  writePrivateJson(claimPath, {
    version: 1,
    repository: transport,
    identity: sharedRepositoryIdentity(transport),
  });
}

function assertRepositoryCheckoutIdentity(repository, checkout) {
  const transport = safeRepository(repository);
  const expectedIdentity = sharedRepositoryIdentity(transport);
  const configuredOrigins = tryGit(checkout, ["config", "--get-all", "remote.origin.url"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (!configuredOrigins.length || configuredOrigins.some((origin) => !sameSharedRepository(origin, transport))) {
    throw sharedRepositoryIdentityMismatch("Shared repository checkout origin does not match the requested repository", {
      repository: transport,
      checkout,
      expectedIdentity,
      configuredOrigins,
    });
  }
  const fetchSpecs = tryGit(checkout, ["config", "--get-all", "remote.origin.fetch"])
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);
  if (fetchSpecs.length !== 1 || fetchSpecs[0] !== "+refs/heads/*:refs/remotes/origin/*") {
    throw sharedRepositoryIdentityMismatch("Shared repository checkout has an unexpected origin fetch mapping", {
      repository: transport,
      checkout,
      fetchSpecs,
    });
  }
  return { repository: transport, identity: expectedIdentity, configuredOrigins };
}

function repositoryCheckout(repository) {
  return path.join(repositoryCacheRoot(repository), "repository");
}

function assertSharedCacheDirectoryNoFollow(directory, label) {
  const expected = path.resolve(directory);
  const stats = lstatIfPresent(expected);
  if (!stats || stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafeSharedFilesystemPath(`${label} must be a physical directory: ${expected}`);
  }
  const configuredHome = path.resolve(sharedHome());
  const relative = path.relative(configuredHome, expected);
  if (!physicalPathIsContained(configuredHome, expected) || !relative) {
    throw unsafeSharedFilesystemPath(`${label} is outside the Shared cache root: ${expected}`);
  }
  const physicalHome = fs.realpathSync(configuredHome);
  const physicalDirectory = fs.realpathSync(expected);
  const expectedPhysicalDirectory = path.resolve(physicalHome, relative);
  if (physicalDirectory !== expectedPhysicalDirectory) {
    throw unsafeSharedFilesystemPath(`${label} crosses a symbolic filesystem boundary: ${expected}`);
  }
  return stats;
}

function assertRepositoryCheckoutNoFollow(repository, checkout = repositoryCheckout(repository)) {
  const cacheRoot = repositoryCacheRoot(repository);
  assertSharedCacheDirectoryNoFollow(cacheRoot, "Shared repository cache");
  assertSharedCacheDirectoryNoFollow(checkout, "Shared repository checkout");
  assertSharedCacheDirectoryNoFollow(path.join(checkout, ".git"), "Shared repository Git directory");
  return checkout;
}

function sharedStatePath(repository) {
  return path.join(repositoryCacheRoot(repository), "state.json");
}

function sharedConnectionReceiptPath(repository, projectRoot) {
  return path.join(repositoryCacheRoot(repository), "connection-receipts", `${hashKey(path.resolve(projectRoot), 24)}.json`);
}

function sharedProjectRootIdentity(projectRoot) {
  const stats = fs.lstatSync(path.resolve(projectRoot), { bigint: true });
  if (stats.isSymbolicLink() || !stats.isDirectory()) throw new Error("Shared connection receipt requires an exact physical project root");
  return { dev: stats.dev.toString(), ino: stats.ino.toString() };
}

function normalizedSharedFilesystemEntryIdentity(value = null) {
  const dev = String(value?.dev || "");
  const ino = String(value?.ino || "");
  const mode = String(value?.mode || "");
  const kind = String(value?.kind || "");
  return /^\d+$/.test(dev) && /^\d+$/.test(ino) && /^\d+$/.test(mode) && ["file", "directory"].includes(kind)
    ? { dev, ino, mode, kind }
    : null;
}

function sharedFilesystemEntryIdentity(filePath) {
  const stats = fs.lstatSync(filePath, { bigint: true });
  const kind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : "";
  if (!kind || stats.isSymbolicLink()) throw new Error(`Unsupported Shared project filesystem entry: ${filePath}`);
  return { dev: stats.dev.toString(), ino: stats.ino.toString(), mode: stats.mode.toString(), kind };
}

function normalizedSharedWorktreeIdentity(value = null) {
  const kind = String(value?.kind || "");
  if (kind === "path") return { kind: "path" };
  if (kind !== "git") return null;
  const commonDir = path.resolve(String(value?.commonDir || ""));
  const commonDirIdentity = value?.commonDirIdentity && {
    dev: String(value.commonDirIdentity.dev || ""),
    ino: String(value.commonDirIdentity.ino || ""),
  };
  const relativeRoot = String(value?.relativeRoot || "");
  const gitDir = path.resolve(String(value?.gitDir || ""));
  const gitDirIdentity = value?.gitDirIdentity && {
    dev: String(value.gitDirIdentity.dev || ""),
    ino: String(value.gitDirIdentity.ino || ""),
  };
  const gitEntryIdentity = normalizedSharedFilesystemEntryIdentity(value?.gitEntryIdentity);
  if (
    !commonDirIdentity || !/^\d+$/.test(commonDirIdentity.dev) || !/^\d+$/.test(commonDirIdentity.ino)
    || !relativeRoot || path.isAbsolute(relativeRoot) || relativeRoot.split(/[\\/]+/).includes("..")
    || !gitDirIdentity || !/^\d+$/.test(gitDirIdentity.dev) || !/^\d+$/.test(gitDirIdentity.ino)
    || !gitEntryIdentity
  ) return null;
  return { kind: "git", commonDir, commonDirIdentity, relativeRoot, gitDir, gitDirIdentity, gitEntryIdentity };
}

function normalizedSharedProjectCapability(value = null) {
  const root = path.resolve(String(value?.root || ""));
  const rootIdentity = value?.rootIdentity && {
    dev: String(value.rootIdentity.dev || ""),
    ino: String(value.rootIdentity.ino || ""),
  };
  const worktreeIdentity = normalizedSharedWorktreeIdentity(value?.worktreeIdentity);
  if (root === path.parse(root).root
    || !rootIdentity || !/^\d+$/.test(rootIdentity.dev) || !/^\d+$/.test(rootIdentity.ino)
    || !worktreeIdentity) return null;
  return { root, rootIdentity, worktreeIdentity };
}

function currentSharedProjectCapability(root) {
  const projectRoot = path.resolve(root);
  const rootStats = fs.lstatSync(projectRoot, { bigint: true });
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink() || fs.realpathSync(projectRoot) !== projectRoot) {
    throw new Error(`Shared project root identity changed: ${projectRoot}`);
  }
  const rootIdentity = { dev: rootStats.dev.toString(), ino: rootStats.ino.toString() };
  const gitRootValue = tryGit(projectRoot, ["rev-parse", "--show-toplevel"]);
  const commonDirValue = tryGit(projectRoot, ["rev-parse", "--git-common-dir"]);
  const gitDirValue = tryGit(projectRoot, ["rev-parse", "--git-dir"]);
  if (!gitRootValue || !commonDirValue || !gitDirValue) {
    return { root: projectRoot, rootIdentity, worktreeIdentity: { kind: "path" } };
  }
  const gitRoot = stableRoot(gitRootValue);
  // Git reports these paths relative to the command cwd, which can be a
  // nested project root rather than the repository top level.
  const commonDir = stableRoot(path.resolve(projectRoot, commonDirValue));
  const gitDir = stableRoot(path.resolve(projectRoot, gitDirValue));
  const commonDirIdentity = sharedProjectRootIdentity(commonDir);
  const gitDirIdentity = sharedProjectRootIdentity(gitDir);
  const relativeRoot = path.relative(gitRoot, projectRoot).replaceAll(path.sep, "/") || ".";
  return {
    root: projectRoot,
    rootIdentity,
    worktreeIdentity: {
      kind: "git",
      commonDir,
      commonDirIdentity,
      relativeRoot,
      gitDir,
      gitDirIdentity,
      gitEntryIdentity: sharedFilesystemEntryIdentity(path.join(gitRoot, ".git")),
    },
  };
}

export function attestSharedProjectCapability(root) {
  return currentSharedProjectCapability(root);
}

function sameSharedProjectCapability(left, right) {
  const expected = normalizedSharedProjectCapability(left);
  const current = normalizedSharedProjectCapability(right);
  if (!expected || !current
    || expected.root !== current.root
    || expected.rootIdentity.dev !== current.rootIdentity.dev
    || expected.rootIdentity.ino !== current.rootIdentity.ino
    || expected.worktreeIdentity.kind !== current.worktreeIdentity.kind) return false;
  if (expected.worktreeIdentity.kind === "path") return true;
  return expected.worktreeIdentity.commonDir === current.worktreeIdentity.commonDir
    && expected.worktreeIdentity.commonDirIdentity.dev === current.worktreeIdentity.commonDirIdentity.dev
    && expected.worktreeIdentity.commonDirIdentity.ino === current.worktreeIdentity.commonDirIdentity.ino
    && expected.worktreeIdentity.relativeRoot === current.worktreeIdentity.relativeRoot
    && expected.worktreeIdentity.gitDir === current.worktreeIdentity.gitDir
    && expected.worktreeIdentity.gitDirIdentity.dev === current.worktreeIdentity.gitDirIdentity.dev
    && expected.worktreeIdentity.gitDirIdentity.ino === current.worktreeIdentity.gitDirIdentity.ino
    && expected.worktreeIdentity.gitEntryIdentity.dev === current.worktreeIdentity.gitEntryIdentity.dev
    && expected.worktreeIdentity.gitEntryIdentity.ino === current.worktreeIdentity.gitEntryIdentity.ino
    && expected.worktreeIdentity.gitEntryIdentity.mode === current.worktreeIdentity.gitEntryIdentity.mode
    && expected.worktreeIdentity.gitEntryIdentity.kind === current.worktreeIdentity.gitEntryIdentity.kind;
}

function assertSharedProjectCapability(capability, label = "Shared project") {
  const expected = normalizedSharedProjectCapability(capability);
  if (!expected) throw sharedContextError("shared-project-capability-invalid", `${label} requires an exact physical root and Git membership capability`);
  let current = null;
  try { current = currentSharedProjectCapability(expected.root); } catch {}
  if (!current || !sameSharedProjectCapability(expected, current)) {
    const error = sharedContextError("shared-project-capability-changed", `${label} changed after Context Hub authorized this Shared transaction`, { projectRoot: expected.root });
    error.statusCode = 409;
    throw error;
  }
  return expected;
}

function writeSharedConnectionReceipt(projectRoot, connection, revision, receiptId, repositoryConfig) {
  const exactReceiptId = String(receiptId || "").trim();
  if (!exactReceiptId) return null;
  if (!/^[0-9a-f-]{36}$/.test(exactReceiptId)) throw new Error("Shared connection receipt ID is invalid");
  const exactRoot = path.resolve(projectRoot);
  const receipt = {
    version: 1,
    receiptId: exactReceiptId,
    repository: connection.repository,
    repositoryIdentity: sharedRepositoryIdentity(connection.repository),
    projectId: connection.projectId,
    projectRoot: exactRoot,
    rootIdentity: sharedProjectRootIdentity(exactRoot),
    revision: safeRevision(revision, "Shared connection receipt revision"),
    projectsPath: safeRelativePath(repositoryConfig?.projectsPath, "Shared connection receipt projectsPath"),
    completedAt: new Date().toISOString(),
  };
  const receiptPath = sharedConnectionReceiptPath(connection.repository, exactRoot);
  writePrivateJson(receiptPath, receipt);
  const receiptDescriptor = fs.openSync(receiptPath, "r");
  try { fs.fsyncSync(receiptDescriptor); } finally { fs.closeSync(receiptDescriptor); }
  const directoryDescriptor = fs.openSync(path.dirname(receiptPath), "r");
  try { fs.fsyncSync(directoryDescriptor); } finally { fs.closeSync(directoryDescriptor); }
  return receipt;
}

function syncSharedRepositoryStateUnderLock(safeRemote, {
  allowOffline = true,
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  env = null,
  fetchRemote = "origin",
  push = null,
} = {}) {
  const budget = sharedGitNetworkBudget(timeoutMs);
  const cloneAuth = authenticatedSharedGit(safeRemote, push, remainingSharedGitNetworkTimeout(budget, "Git clone"));
  const checkout = ensureRepositoryCloneUnderLock(safeRemote, {
    timeoutMs: remainingSharedGitNetworkTimeout(budget, "Git clone"),
    timeoutBudgetMs: budget.timeoutMs,
    env,
    credential: cloneAuth?.credential || null,
    remote: cloneAuth?.remote || safeRemote,
  });
  let fetchError = "";
  try {
    const fetchAuth = authenticatedSharedGit(safeRemote, push, remainingSharedGitNetworkTimeout(budget, "Git fetch"));
    const remote = fetchAuth?.remote || String(fetchRemote || "origin");
    const fetchArgs = remote === "origin"
      ? ["fetch", "--prune", "origin"]
      : ["fetch", "--force", "--prune", "--no-tags", remote, "+refs/heads/*:refs/remotes/origin/*"];
    runSharedNetworkGit(checkout, fetchArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      ...(env ? { env } : {}),
      ...(fetchAuth ? { credential: fetchAuth.credential } : {}),
      operation: "Git fetch",
      timeoutMs: remainingSharedGitNetworkTimeout(budget, "Git fetch"),
      timeoutBudgetMs: budget.timeoutMs,
    });
  } catch (error) {
    fetchError = String(error.stderr || error.message || error).trim();
    if (String(error?.code || "").startsWith("github-app-")) throw error;
    if (!allowOffline) {
      if (error?.code === "shared-git-timeout") throw error;
      throw new Error(`Unable to refresh shared context: ${fetchError}`);
    }
  }
  const state = readJson(sharedStatePath(safeRemote), {});
  let descriptor;
  try {
    descriptor = readRemoteSharedDescriptor(checkout, state.defaultBranch || "");
  } catch (error) {
    if (!fetchError || !state.revision) throw error;
    const cachedRevision = safeRevision(state.revision, "cached shared revision");
    if (!gitObjectExists(checkout, `${cachedRevision}^{commit}`)) throw error;
    descriptor = readSharedDescriptorAtRevision(checkout, cachedRevision);
    const cachedRemoteRef = `refs/remotes/origin/${descriptor.config.defaultBranch}`;
    if (!gitObjectExists(checkout, `${cachedRemoteRef}^{commit}`)
      || !gitIsAncestor(checkout, cachedRevision, cachedRemoteRef)) {
      throw sharedContextError("shared-cache-unverified", "Cached Shared state is not reachable from its repository origin", {
        repository: safeRemote,
        revision: cachedRevision,
        defaultBranch: descriptor.config.defaultBranch,
      });
    }
  }
  assertSafeTreeEntries(checkout, descriptor.revision, []);
  const cacheRoot = repositoryCacheRoot(safeRemote);
  const snapshot = path.join(cacheRoot, "snapshots", descriptor.revision);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  materializeSnapshot(checkout, descriptor.revision, snapshot);
  const repositoryConfig = readSharedRepositoryConfig(snapshot);
  const catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
  readValidatedSharedLocationsFromRoot(snapshot, repositoryConfig, catalog);
  const nextState = {
    version: 1,
    repository: safeRemote,
    defaultBranch: repositoryConfig.defaultBranch,
    revision: descriptor.revision,
    syncedAt: new Date().toISOString(),
    online: !fetchError,
    fetchError,
    repositoryConfig,
    catalog,
  };
  writePrivateJson(sharedStatePath(safeRemote), nextState);
  return {
    connection: { repository: safeRemote, projectId: "global", projectRoot: "" },
    repositoryConfig,
    catalog,
    revision: descriptor.revision,
    online: !fetchError,
    fetchError,
    cacheRoot,
    snapshot,
  };
}

function syncSharedRepositoryState(repository, options = {}) {
  const safeRemote = registeredRepositoryTransport(repository);
  authenticatedSharedGit(safeRemote, options.push, options.timeoutMs);
  return withSharedRepositoryCloneLock(
    safeRemote,
    () => syncSharedRepositoryStateUnderLock(safeRemote, options),
    options.timeoutMs,
  );
}

function cachedSharedRepositoryStateUnderLock(safeRemote, { projectId = "global", projectRoot = "" } = {}) {
  const state = readJson(sharedStatePath(safeRemote), {});
  if (!state.revision) {
    return syncSharedRepositoryStateUnderLock(safeRemote, { allowOffline: true });
  }
  const revision = safeRevision(state.revision, "cached shared revision");
  const checkout = ensureRepositoryCloneUnderLock(safeRemote);
  if (!gitObjectExists(checkout, `${revision}^{commit}`)) {
    return syncSharedRepositoryStateUnderLock(safeRemote, { allowOffline: true });
  }
  const descriptor = readSharedDescriptorAtRevision(checkout, revision);
  const remoteRef = `refs/remotes/origin/${descriptor.config.defaultBranch}`;
  if (!gitObjectExists(checkout, `${remoteRef}^{commit}`) || !gitIsAncestor(checkout, revision, remoteRef)) {
    return syncSharedRepositoryStateUnderLock(safeRemote, { allowOffline: true });
  }
  const cacheRoot = repositoryCacheRoot(safeRemote);
  const snapshot = path.join(cacheRoot, "snapshots", revision);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  materializeSnapshot(checkout, revision, snapshot);
  const repositoryConfig = readSharedRepositoryConfig(snapshot);
  const catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
  readValidatedSharedLocationsFromRoot(snapshot, repositoryConfig, catalog);
  return {
    connection: { repository: safeRemote, projectId, projectRoot },
    repositoryConfig,
    catalog,
    revision,
    online: state.online !== false,
    fetchError: String(state.fetchError || ""),
    cacheRoot,
    snapshot,
  };
}

function cachedSharedRepositoryState(repository, options = {}) {
  const safeRemote = registeredRepositoryTransport(repository);
  return withSharedRepositoryCloneLock(
    safeRemote,
    () => cachedSharedRepositoryStateUnderLock(safeRemote, options),
    options.timeoutMs,
  );
}

function ensureRepositoryCloneUnderLock(transport, {
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  timeoutBudgetMs = timeoutMs,
  env = null,
  credential = null,
  remote = transport,
} = {}) {
  const cacheRoot = repositoryCacheRoot(transport);
  const checkout = path.join(cacheRoot, "repository");
  const existingCheckout = lstatIfPresent(checkout);
  if (existingCheckout) {
    assertRepositoryCheckoutNoFollow(transport, checkout);
    assertRepositoryIdentityClaim(cacheRoot, transport);
    assertRepositoryCheckoutIdentity(transport, checkout);
    writeRepositoryIdentityClaim(cacheRoot, transport);
    configureExistingSharedAgentGit(transport, checkout);
    assertRepositoryCheckoutNoFollow(transport, checkout);
    assertRepositoryCheckoutIdentity(transport, checkout);
    return checkout;
  }
  fs.mkdirSync(cacheRoot, { recursive: true });
  assertSharedCacheDirectoryNoFollow(cacheRoot, "Shared repository cache");
  if (lstatIfPresent(checkout)) throw unsafeSharedFilesystemPath(`Shared repository checkout appeared before clone: ${checkout}`);
  const options = {
    stdio: ["ignore", "ignore", "pipe"],
    ...(env ? { env } : {}),
    ...(credential ? { credential } : {}),
  };
  runSharedNetworkGit(
    cacheRoot,
    ["clone", "--origin", "origin", "--no-checkout", safeRepository(remote), checkout],
    { ...options, operation: "Git clone", timeoutMs, timeoutBudgetMs },
  );
  assertRepositoryCheckoutNoFollow(transport, checkout);
  assertRepositoryCheckoutIdentity(transport, checkout);
  writeRepositoryIdentityClaim(cacheRoot, transport);
  configureExistingSharedAgentGit(transport, checkout);
  assertRepositoryCheckoutNoFollow(transport, checkout);
  assertRepositoryCheckoutIdentity(transport, checkout);
  return checkout;
}

function ensureRepositoryClone(repository, options = {}) {
  const transport = registeredRepositoryTransport(repository);
  return withSharedRepositoryCloneLock(
    transport,
    () => ensureRepositoryCloneUnderLock(transport, options),
    options.timeoutMs,
  );
}

function remoteRevision(checkout, branch) {
  const safeBranch = safeBranchName(branch, "remote branch");
  const revision = tryGit(checkout, ["rev-parse", `refs/remotes/origin/${safeBranch}^{commit}`]);
  if (!revision) throw new Error(`The shared repository has no origin/${branch} commit`);
  return safeRevision(revision);
}

function remoteHeadBranch(checkout) {
  const value = tryGit(checkout, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]);
  if (!value.startsWith("origin/")) return "";
  try { return safeBranchName(value.slice("origin/".length), "remote default branch"); } catch { return ""; }
}

function readRemoteSharedDescriptor(checkout, fallbackBranch = "") {
  const bootstrapBranch = fallbackBranch || remoteHeadBranch(checkout) || "main";
  let revision = remoteRevision(checkout, bootstrapBranch);
  let descriptor = readSharedDescriptorAtRevision(checkout, revision);
  let config = descriptor.config;
  if (config.defaultBranch !== bootstrapBranch) {
    const selectedBranch = config.defaultBranch;
    revision = remoteRevision(checkout, selectedBranch);
    descriptor = readSharedDescriptorAtRevision(checkout, revision);
    config = descriptor.config;
    if (config.defaultBranch !== selectedBranch) throw new Error("Shared defaultBranch must be stable across the selected branch");
  }
  return descriptor;
}

function readSharedDescriptorAtRevision(checkout, revision) {
  const acceptedRevision = safeRevision(revision, "shared descriptor revision");
  const config = normalizedRepositoryConfig(JSON.parse(runGit(checkout, ["show", `${acceptedRevision}:${SHARED_REPOSITORY_CONFIG}`])));
  const catalog = normalizedProjectsCatalog(JSON.parse(runGit(checkout, ["show", `${acceptedRevision}:${config.projectsFile}`])));
  return { revision: acceptedRevision, config, catalog };
}

function sharedContextError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function sharedDeliveryTimeoutError(operation, timeoutMs, cause = null) {
  const error = sharedContextError(
    "shared-delivery-timeout",
    `${operation} timed out after ${Math.floor(Number(timeoutMs))} ms`,
    { timeoutMs: Math.floor(Number(timeoutMs)) },
  );
  error.retryable = true;
  if (cause) error.cause = cause;
  return error;
}

function isGitCommandTimeout(error) {
  return error?.code === "ETIMEDOUT" || error?.signal === "SIGTERM";
}

function runSharedDeliveryGit(cwd, args, { operation, timeoutMs = 0, ...options }) {
  try {
    return runGit(cwd, args, { ...options, timeoutMs });
  } catch (error) {
    if (Number(timeoutMs) > 0 && isGitCommandTimeout(error)) {
      throw sharedDeliveryTimeoutError(operation, timeoutMs, error);
    }
    throw error;
  }
}

export function sharedDeliveryTimeoutBudget(push = null, overrideTimeoutMs = 0) {
  for (const value of [push?.timeoutMs, overrideTimeoutMs]) {
    const configured = Number(value);
    if (Number.isFinite(configured) && configured > 0) return Math.floor(configured);
  }
  return DEFAULT_SHARED_DELIVERY_TIMEOUT_MS;
}

function commitTrailerMap(checkout, revision) {
  const body = String(runGit(checkout, ["show", "-s", "--format=%B", safeRevision(revision)]));
  const trailers = {};
  for (const line of body.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9-]+):\s*(.*)$/);
    if (match && match[1].startsWith("Context-Room-")) trailers[match[1]] = match[2].trim();
  }
  return trailers;
}

function parseDependencyProof(value = "") {
  if (!value) return { proof: null, error: "" };
  try {
    const parsed = JSON.parse(Buffer.from(String(value), "base64url").toString("utf8"));
    if (parsed?.version !== 1 || !Array.isArray(parsed.documents)) throw new Error("Dependency proof has an unsupported shape");
    return {
      proof: {
        version: 1,
        documents: parsed.documents.map((item) => ({
          path: String(item?.path || "").replaceAll("\\", "/").replace(/^\.\//, ""),
          blob: String(item?.blob || ""),
          mode: String(item?.mode || item?.resourceMode || ""),
          contentHash: String(item?.contentHash || ""),
          dependencies: item?.dependencies && typeof item.dependencies === "object" ? { ...item.dependencies } : {},
        })).filter((item) => item.path),
      },
      error: "",
    };
  } catch (error) {
    return { proof: null, error: error.message };
  }
}

function verifiedDependencyProofPaths(checkout, revision, proof) {
  const reviewedPaths = new Set();
  const errors = [];
  const documents = Array.isArray(proof?.documents) ? proof.documents : [];
  const pathCounts = new Map();
  for (const item of documents) pathCounts.set(item.path, (pathCounts.get(item.path) || 0) + 1);
  for (const item of documents) {
    let filePath;
    try {
      filePath = safeRelativePath(item.path, "dependency proof path");
    } catch (error) {
      errors.push(`${item.path || "<missing>"}: ${error.message}`);
      continue;
    }
    if (pathCounts.get(item.path) !== 1) {
      errors.push(`${filePath}: dependency proof path is duplicated`);
      continue;
    }
    let entry;
    try {
      entry = gitTreeEntries(checkout, revision, [filePath]).find((candidate) => candidate.path === filePath) || null;
    } catch (error) {
      errors.push(`${filePath}: dependency proof tree lookup failed: ${error.message}`);
      continue;
    }
    if (!entry || entry.type !== "blob") {
      errors.push(`${filePath}: dependency proof target is missing from the current tree`);
      continue;
    }
    if (item.blob !== entry.object) {
      errors.push(`${filePath}: dependency proof blob does not match the current tree`);
      continue;
    }
    if (item.mode !== entry.mode || !["100644", "100755"].includes(item.mode)) {
      errors.push(`${filePath}: dependency proof mode does not match the current tree`);
      continue;
    }
    let content;
    try {
      content = runGit(checkout, ["cat-file", "blob", entry.object], { encoding: null, maxBuffer: MAX_SHARED_TEXT_BYTES + 1 });
    } catch (error) {
      errors.push(`${filePath}: dependency proof blob could not be verified: ${String(error.stderr || error.message || error).trim()}`);
      continue;
    }
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (item.contentHash !== contentHash) {
      errors.push(`${filePath}: dependency proof content hash does not match the current tree`);
      continue;
    }
    reviewedPaths.add(filePath);
  }
  return { reviewedPaths, errors };
}

function sharedMainCommit(checkout, revision, previousRevision = "") {
  const commit = safeRevision(revision, "shared main commit");
  const metadata = String(runGit(checkout, ["show", "-s", "--format=%cI%x00%an%x00%ae%x00%s", commit]))
    .split("\0");
  const parent = previousRevision || tryGit(checkout, ["rev-parse", `${commit}^1`]);
  const files = parent
    ? gitChangedPaths(checkout, `${safeRevision(parent, "shared main parent")}..${commit}`)
    : splitNull(runGit(checkout, ["ls-tree", "-r", "--name-only", "-z", commit], { encoding: null }));
  const trailers = commitTrailerMap(checkout, commit);
  const dependencyProofResult = parseDependencyProof(trailers["Context-Room-Dependency-Proof"] || "");
  const dependencyProofValidation = verifiedDependencyProofPaths(checkout, commit, dependencyProofResult.proof);
  const reviewedDependencyPaths = dependencyProofValidation.reviewedPaths;
  const dependencyReviewRequired = parent && files.some((filePath) => /\.(?:md|mdx|html?)$/i.test(filePath))
    ? sharedDocumentDependencyReviewPaths(checkout, parent, commit, files)
      .filter((item) => !reviewedDependencyPaths.has(item.path))
    : [];
  let acceptance = null;
  let acceptanceError = "";
  if (trailers["Context-Room-Proposal"] || trailers["Context-Room-Proposal-Head"]) {
    try {
      if (!trailers["Context-Room-Proposal"] || !trailers["Context-Room-Proposal-Head"]) throw new Error("Acceptance trailers are incomplete");
      acceptance = {
        proposal: safeBranchName(trailers["Context-Room-Proposal"], "proposal branch"),
        proposalHead: safeRevision(trailers["Context-Room-Proposal-Head"], "proposal head"),
        projectId: trailers["Context-Room-Project"] ? safeId(trailers["Context-Room-Project"], "projectId") : "",
        sessionId: trailers["Context-Room-Session"] ? safeSessionId(trailers["Context-Room-Session"]) : "",
      };
    } catch (error) {
      acceptanceError = error.message;
    }
  }
  return {
    revision: commit,
    previousRevision: parent ? safeRevision(parent, "shared main parent") : "",
    committedAt: metadata[0] || "",
    author: { name: metadata[1] || "", email: metadata[2] || "" },
    subject: metadata[3] || "",
    files,
    trailers,
    dependencyProof: dependencyProofResult.proof,
    dependencyProofError: [dependencyProofResult.error, ...dependencyProofValidation.errors].filter(Boolean).join("; "),
    dependencyReviewRequired,
    acceptance,
    acceptanceError,
  };
}

function resolveSharedMainRevisionUnderLock(safeRemote, {
  refresh = true,
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  push = null,
} = {}) {
  const budget = sharedGitNetworkBudget(timeoutMs);
  const cloneAuth = authenticatedSharedGit(
    safeRemote,
    push,
    remainingSharedGitNetworkTimeout(budget, "Git clone"),
  );
  const checkout = ensureRepositoryCloneUnderLock(safeRemote, {
    timeoutMs: remainingSharedGitNetworkTimeout(budget, "Git clone"),
    timeoutBudgetMs: budget.timeoutMs,
    credential: cloneAuth?.credential || null,
    remote: cloneAuth?.remote || safeRemote,
  });
  if (refresh) {
    try {
      const fetchAuth = authenticatedSharedGit(
        safeRemote,
        push,
        remainingSharedGitNetworkTimeout(budget, "Git fetch"),
      );
      runSharedNetworkGit(checkout, fetchAuth
        ? ["fetch", "--force", "--prune", "--no-tags", fetchAuth.remote, "+refs/heads/*:refs/remotes/origin/*"]
        : ["fetch", "--prune", "origin"], {
        stdio: ["ignore", "ignore", "pipe"],
        ...(fetchAuth ? { credential: fetchAuth.credential } : {}),
        operation: "Git fetch",
        timeoutMs: remainingSharedGitNetworkTimeout(budget, "Git fetch"),
        timeoutBudgetMs: budget.timeoutMs,
      });
    } catch (error) {
      if (
        error?.code === "shared-git-timeout"
        || String(error?.code || "").startsWith("github-app-")
      ) throw error;
      throw sharedContextError("shared-freshness-unverified", `Unable to verify the accepted shared revision: ${String(error.stderr || error.message || error).trim()}`, { repository: safeRemote });
    }
  }
  let descriptor;
  try {
    descriptor = readRemoteSharedDescriptor(checkout, readJson(sharedStatePath(safeRemote), {}).defaultBranch || "");
  } catch (error) {
    throw sharedContextError("shared-main-unavailable", error.message, { repository: safeRemote });
  }
  readValidatedSharedLocationsFromRevision(checkout, descriptor.revision, descriptor.config, descriptor.catalog);
  const remoteRef = `refs/remotes/origin/${descriptor.config.defaultBranch}`;
  if (!gitIsAncestor(checkout, descriptor.revision, remoteRef)) {
    throw sharedContextError("shared-main-unreachable", "The selected shared revision is not reachable from the configured remote branch", {
      repository: safeRemote,
      defaultBranch: descriptor.config.defaultBranch,
      revision: descriptor.revision,
    });
  }
  return {
    repository: safeRemote,
    checkout,
    defaultBranch: descriptor.config.defaultBranch,
    revision: descriptor.revision,
    repositoryConfig: descriptor.config,
    catalog: descriptor.catalog,
    online: refresh,
    commit: sharedMainCommit(checkout, descriptor.revision),
  };
}

function withSharedMainRevision(repository, options, operation) {
  const safeRemote = registeredRepositoryTransport(repository);
  authenticatedSharedGit(safeRemote, options.push, options.timeoutMs);
  return withSharedRepositoryCloneLock(
    safeRemote,
    () => operation(resolveSharedMainRevisionUnderLock(safeRemote, options)),
    options.timeoutMs,
  );
}

function resolveSharedMainRevision(repository, options = {}) {
  return withSharedMainRevision(repository, options, (main) => main);
}

export function readSharedMainRevision(repository, options = {}) {
  const { checkout: _checkout, ...main } = resolveSharedMainRevision(repository, options);
  return main;
}

export function diffSharedMainRevisions(repository, {
  fromRevision,
  toRevision = "",
  projectId = "",
  refresh = false,
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  push = null,
} = {}) {
  const main = resolveSharedMainRevision(repository, { refresh, timeoutMs, push });
  const checkout = main.checkout;
  const from = safeRevision(fromRevision, "fromRevision");
  const to = toRevision ? safeRevision(toRevision, "toRevision") : main.revision;
  for (const revision of [from, to]) {
    if (!gitObjectExists(checkout, `${revision}^{commit}`)) {
      throw sharedContextError("shared-revision-not-accepted", "A compared revision is not reachable from the configured shared main branch", {
        repository: main.repository,
        defaultBranch: main.defaultBranch,
        revision,
        acceptedRevision: main.revision,
      });
    }
    if (!gitIsAncestor(checkout, revision, main.revision)) {
      if (revision === from) {
        throw sharedContextError("shared-history-diverged", "The previously accepted shared revision is no longer reachable from the configured main branch", {
          fromRevision: from,
          acceptedRevision: main.revision,
        });
      }
      throw sharedContextError("shared-revision-not-accepted", "The target revision is not reachable from the configured shared main branch", {
        repository: main.repository,
        defaultBranch: main.defaultBranch,
        revision,
        acceptedRevision: main.revision,
      });
    }
  }
  if (!gitIsAncestor(checkout, from, to)) {
    throw sharedContextError("shared-history-diverged", "The shared main history diverged; no accepted transition can be inferred", { fromRevision: from, toRevision: to });
  }
  const revisions = tryGit(checkout, ["rev-list", "--first-parent", "--reverse", `${from}..${to}`])
    .split("\n")
    .filter(Boolean)
    .map((revision) => safeRevision(revision, "shared main transition"));
  let previous = from;
  const transitions = revisions.map((revision) => {
    const item = sharedMainCommit(checkout, revision, previous);
    previous = revision;
    return item;
  });
  const normalizedProjectId = projectId ? safeId(projectId, "projectId") : "";
  const applicablePrefixes = normalizedProjectId ? [
    `${main.repositoryConfig.projectsPath}/${normalizedProjectId}`,
    main.repositoryConfig.globalSkillsPath,
  ] : [];
  const applicableExact = normalizedProjectId ? new Set([
    SHARED_REPOSITORY_CONFIG,
    main.repositoryConfig.projectsFile,
    main.repositoryConfig.skillLocationsFile,
  ]) : new Set();
  const isApplicable = (filePath) => !normalizedProjectId
    || applicableExact.has(filePath)
    || applicablePrefixes.some((prefix) => filePath === prefix || filePath.startsWith(prefix + "/"));
  return {
    repository: main.repository,
    defaultBranch: main.defaultBranch,
    acceptedRevision: main.revision,
    fromRevision: from,
    toRevision: to,
    projectId: normalizedProjectId,
    commitCount: transitions.length,
    transitions: transitions.map((transition) => ({ ...transition, applicableFiles: transition.files.filter(isApplicable) })),
    changedPaths: [...new Set(transitions.flatMap((transition) => transition.files))],
    applicablePaths: [...new Set(transitions.flatMap((transition) => transition.files.filter(isApplicable)))],
  };
}

function gitNameStatusChanges(checkout, fromRevision, toRevision) {
  const records = splitNull(runGit(checkout, ["diff", "--name-status", "-z", "-M", "-C", "--find-copies-harder", `${fromRevision}...${toRevision}`, "--"], { encoding: null }));
  const changes = [];
  for (let index = 0; index < records.length;) {
    const rawStatus = records[index++];
    const status = rawStatus[0];
    if (["R", "C"].includes(status)) {
      const fromPath = records[index++];
      const filePath = records[index++];
      if (!fromPath || !filePath) throw new Error("Unable to parse renamed shared proposal path");
      changes.push({ status, score: Number(rawStatus.slice(1)) || null, fromPath, path: filePath });
    } else {
      const filePath = records[index++];
      if (!filePath) throw new Error("Unable to parse shared proposal path");
      changes.push({ status, path: filePath });
    }
  }
  return changes;
}

function proposalChangePaths(changes = []) {
  return [...new Set((Array.isArray(changes) ? changes : []).flatMap((change) => [change?.path, change?.fromPath].filter(Boolean)))];
}

function remoteProposalBranchesAtRevision(checkout, repositoryConfig, revision) {
  const proposalRefPrefix = `refs/remotes/origin/${repositoryConfig.proposalPrefix}`;
  return tryGit(checkout, ["for-each-ref", "--points-at", revision, "--format=%(refname:strip=3)", proposalRefPrefix])
    .split("\n")
    .filter(Boolean)
    .map((branch) => safeBranchName(branch, "proposal branch"));
}

function diffSharedProposalRevisionsUnderLock(main, { fromRevision, toRevision } = {}) {
  const checkout = main.checkout;
  const from = safeRevision(fromRevision, "proposal base revision");
  const to = safeRevision(toRevision, "proposal head revision");
  if (!gitObjectExists(checkout, `${from}^{commit}`) || !gitIsAncestor(checkout, from, main.revision)) {
    throw sharedContextError("shared-history-diverged", "The proposal base is not reachable from the configured shared main branch", {
      fromRevision: from,
      acceptedRevision: main.revision,
    });
  }
  if (!gitObjectExists(checkout, `${to}^{commit}`)) {
    throw sharedContextError("shared-proposal-revision-unavailable", "The exact proposal revision is not available after refreshing the shared repository", { toRevision: to });
  }
  const proposalRefs = remoteProposalBranchesAtRevision(checkout, main.repositoryConfig, to);
  if (!proposalRefs.length) {
    throw sharedContextError("shared-proposal-revision-unavailable", "The exact revision is not the published head of an active proposal branch", { toRevision: to });
  }
  const mergeBase = safeRevision(tryGit(checkout, ["merge-base", from, to]), "proposal merge base");
  const changes = gitNameStatusChanges(checkout, from, to);
  return {
    repository: main.repository,
    defaultBranch: main.defaultBranch,
    acceptedRevision: main.revision,
    fromRevision: from,
    toRevision: to,
    proposalBranches: proposalRefs,
    truthState: "proposal",
    accepted: false,
    mergeBase,
    rebaseRequired: mergeBase !== main.revision || from !== main.revision,
    hasConflict: proposalHasConflict(checkout, main.revision, to),
    changes,
    files: changes.map((change) => change.path),
  };
}

export function diffSharedProposalRevisions(repository, options = {}) {
  const refresh = options.refresh ?? true;
  return withSharedMainRevision(
    repository,
    { refresh, timeoutMs: options.timeoutMs, push: options.push || null },
    (main) => diffSharedProposalRevisionsUnderLock(main, options),
  );
}

export function readSharedRevisionDocuments(repository, revision, {
  refresh = true,
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  push = null,
} = {}) {
  const main = resolveSharedMainRevision(repository, { refresh, timeoutMs, push });
  const wanted = safeRevision(revision, "shared document revision");
  if (!gitObjectExists(main.checkout, `${wanted}^{commit}`)) {
    throw sharedContextError("shared-revision-unavailable", "The requested shared document revision is unavailable", { revision: wanted });
  }
  return gitTreeEntries(main.checkout, wanted)
    .filter((entry) => /\.(?:md|mdx|html?)$/i.test(entry.path))
    .map((entry) => ({
      path: entry.path,
      content: String(runGit(main.checkout, ["show", `${wanted}:${entry.path}`])),
      version: safeRevision(tryGit(main.checkout, ["rev-parse", `${wanted}:${entry.path}`]), `shared document ${entry.path}`),
    }));
}

function sharedSkillLocationsAtRevision(checkout, revision) {
  const repositoryConfig = normalizedRepositoryConfig(JSON.parse(String(runGit(checkout, ["show", `${revision}:${SHARED_REPOSITORY_CONFIG}`]))));
  const catalog = normalizedProjectsCatalog(JSON.parse(String(runGit(checkout, ["show", `${revision}:${repositoryConfig.projectsFile}`]))));
  const { skillLocations: locations } = readValidatedSharedLocationsFromRevision(checkout, revision, repositoryConfig, catalog);
  const collections = locations.collections.map((collection) => {
    const prefix = collection.path + "/";
    const skills = [...new Set(gitTreeEntries(checkout, revision, [collection.path]).flatMap((entry) => {
      if (!entry.path.startsWith(prefix) || !entry.path.endsWith("/SKILL.md")) return [];
      const relative = entry.path.slice(prefix.length);
      const segments = relative.split("/");
      return segments.length === 2 && segments[1] === "SKILL.md" ? [segments[0]] : [];
    }))].sort((left, right) => left.localeCompare(right, "en"));
    const skillVersions = skills.map((name) => ({
      name,
      version: safeRevision(tryGit(checkout, ["rev-parse", `${revision}:${collection.path}/${name}`]), `shared skill ${name} tree`),
    }));
    return { ...collection, skills, skillVersions };
  });
  return { repositoryConfig, catalog, locations: { ...locations, collections } };
}

function logicalSkillDestinations(assignment) {
  return assignment.providers.map((provider) => ({
    assignmentId: assignment.id,
    collectionId: assignment.collectionId,
    provider,
    scope: assignment.scope,
    projectIds: assignment.scope === "project" ? assignment.projectIds : [],
    destination: assignment.scope === "device" ? "provider-global" : "project-provider",
  }));
}

function diffLogicalRecords(beforeRecords, afterRecords) {
  const before = new Map(beforeRecords.map((item) => [item.id, item]));
  const after = new Map(afterRecords.map((item) => [item.id, item]));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort((left, right) => left.localeCompare(right, "en"));
  return ids.flatMap((id) => {
    const previous = before.get(id) || null;
    const next = after.get(id) || null;
    if (!previous) return [{ id, change: "added", before: null, after: next }];
    if (!next) return [{ id, change: "removed", before: previous, after: null }];
    if (JSON.stringify(previous) !== JSON.stringify(next)) return [{ id, change: "modified", before: previous, after: next }];
    return [];
  });
}

function diffSharedSkillLocationsRevisionsUnderLock(main, { fromRevision, toRevision } = {}) {
  const checkout = main.checkout;
  const from = safeRevision(fromRevision, "shared skill base revision");
  const to = safeRevision(toRevision, "shared skill target revision");
  if (!gitObjectExists(checkout, `${from}^{commit}`) || !gitIsAncestor(checkout, from, main.revision)) {
    throw sharedContextError("shared-history-diverged", "The Shared Skills base is not reachable from the configured shared main branch", { fromRevision: from, acceptedRevision: main.revision });
  }
  if (!gitObjectExists(checkout, `${to}^{commit}`)) {
    throw sharedContextError("shared-skill-revision-unavailable", "The exact Shared Skills target revision is unavailable", { toRevision: to });
  }
  const toAccepted = gitIsAncestor(checkout, to, main.revision);
  const proposalBranches = toAccepted ? [] : remoteProposalBranchesAtRevision(checkout, main.repositoryConfig, to);
  if (!toAccepted && !proposalBranches.length) {
    throw sharedContextError("shared-skill-revision-unavailable", "The Shared Skills target is neither accepted main history nor an exact published proposal head", { toRevision: to });
  }
  const before = sharedSkillLocationsAtRevision(checkout, from);
  const after = sharedSkillLocationsAtRevision(checkout, to);
  const collectionChanges = diffLogicalRecords(before.locations.collections, after.locations.collections);
  const assignmentChanges = diffLogicalRecords(before.locations.assignments, after.locations.assignments);
  const affectedCollectionIds = new Set(collectionChanges.map((change) => change.id));
  const affectedAssignmentIds = new Set(assignmentChanges.map((change) => change.id));
  for (const assignment of [...before.locations.assignments, ...after.locations.assignments]) {
    if (affectedCollectionIds.has(assignment.collectionId)) affectedAssignmentIds.add(assignment.id);
  }
  const affectedAssignments = [...before.locations.assignments, ...after.locations.assignments]
    .filter((assignment) => affectedAssignmentIds.has(assignment.id));
  const logicalDestinations = [...new Map(affectedAssignments.flatMap(logicalSkillDestinations).map((destination) => [
    JSON.stringify(destination),
    destination,
  ])).values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right), "en"));
  const changes = gitNameStatusChanges(checkout, from, to);
  const collectionPaths = new Set([...before.locations.collections, ...after.locations.collections]
    .filter((collection) => affectedCollectionIds.has(collection.id))
    .map((collection) => collection.path));
  return {
    repository: main.repository,
    defaultBranch: main.defaultBranch,
    acceptedRevision: main.revision,
    fromRevision: from,
    fromTruthState: "accepted",
    toRevision: to,
    toTruthState: toAccepted ? "accepted" : "proposal",
    proposalBranches,
    manifestPaths: [...new Set([before.repositoryConfig.skillLocationsFile, after.repositoryConfig.skillLocationsFile])],
    collectionChanges,
    assignmentChanges,
    providersAffected: [...new Set(affectedAssignments.flatMap((assignment) => assignment.providers))].sort((left, right) => left.localeCompare(right, "en")),
    logicalDestinations,
    repositoryChanges: changes.filter((change) => {
      const paths = [change.path, change.fromPath].filter(Boolean);
      return paths.some((filePath) => collectionPaths.has(filePath)
        || [...collectionPaths].some((collectionPath) => filePath.startsWith(collectionPath + "/"))
        || filePath === before.repositoryConfig.skillLocationsFile
        || filePath === after.repositoryConfig.skillLocationsFile);
    }),
    changed: collectionChanges.length > 0 || assignmentChanges.length > 0,
    materializedLocalState: false,
  };
}

export function diffSharedSkillLocationsRevisions(repository, options = {}) {
  const refresh = options.refresh ?? true;
  return withSharedMainRevision(
    repository,
    { refresh, timeoutMs: options.timeoutMs, push: options.push || null },
    (main) => diffSharedSkillLocationsRevisionsUnderLock(main, options),
  );
}

export function detectSharedProject(root, { repository, projectId = "" } = {}) {
  const resolvedRoot = stableRoot(root);
  const safeRemote = registeredRepositoryTransport(repository);
  return withSharedRepositoryCloneLock(safeRemote, () => {
    const checkout = ensureRepositoryCloneUnderLock(safeRemote);
    runSharedNetworkGit(checkout, ["fetch", "--prune", "origin"], {
      stdio: ["ignore", "ignore", "pipe"],
      operation: "Git fetch",
    });
    const descriptor = readRemoteSharedDescriptor(checkout);
    const source = sourceIdentity(resolvedRoot);
    const explicitProjectId = projectId ? safeId(projectId, "projectId") : "";
    if (explicitProjectId) {
      const project = descriptor.catalog.projects.find((item) => item.id === explicitProjectId);
      if (!project) throw new Error(`Shared project is not registered in ${descriptor.config.projectsFile}: ${explicitProjectId}`);
      const sourceMatches = source && project.source?.remotes.some((remote) => source.remotes.includes(remote));
      const projectRoot = sourceMatches
        ? project.source.subpath === "."
          ? source.topLevel
          : path.join(source.topLevel, ...project.source.subpath.split("/"))
        : resolvedRoot;
      return { projectId: project.id, projectRoot: stableRoot(projectRoot), repository: safeRemote, revision: descriptor.revision };
    }
    if (!source) throw new Error("--project is required because this directory has no Git remote identity");
    const matches = descriptor.catalog.projects.filter((project) => {
      if (!project.source || !project.source.remotes.some((remote) => source.remotes.includes(remote))) return false;
      return project.source.subpath === "."
        || source.sourceSubpath === project.source.subpath
        || source.sourceSubpath.startsWith(project.source.subpath + "/");
    }).sort((left, right) => right.source.subpath.length - left.source.subpath.length);
    const topSpecificity = matches[0]?.source?.subpath?.length || 0;
    const topMatches = matches.filter((project) => project.source.subpath.length === topSpecificity);
    if (new Set(topMatches.map((project) => project.id)).size > 1) {
      const error = new Error("This Git worktree matches multiple equally specific Shared projects");
      error.code = "shared_context_project_ambiguous";
      error.statusCode = 409;
      error.details = {
        sourceSubpath: source.sourceSubpath,
        candidates: topMatches.map((project) => ({ projectId: project.id, sourceSubpath: project.source.subpath })),
      };
      throw error;
    }
    const project = topMatches[0];
    if (!project) throw new Error("No shared project matches this Git remote and repository subpath; pass --project explicitly");
    const projectRoot = project.source.subpath === "."
      ? source.topLevel
      : path.join(source.topLevel, ...project.source.subpath.split("/"));
    return { projectId: project.id, projectRoot: stableRoot(projectRoot), repository: safeRemote, revision: descriptor.revision };
  });
}

function sharedSnapshotIntegrityError(message, details = {}) {
  return sharedContextError("shared-snapshot-integrity", message, details);
}

function expectedSnapshotTree(checkout, revision) {
  const acceptedRevision = safeRevision(revision, "shared snapshot revision");
  assertSafeTreeEntries(checkout, acceptedRevision, []);
  const entries = gitTreeEntries(checkout, acceptedRevision, []).map((entry) => {
    const normalizedPath = safeRelativePath(entry.path, "shared snapshot Git path");
    if (normalizedPath !== entry.path) {
      throw sharedSnapshotIntegrityError("Shared snapshot contains a non-canonical Git path", {
        revision: acceptedRevision,
        path: entry.path,
      });
    }
    return { ...entry, path: normalizedPath };
  });
  const objectFormat = String(runGit(checkout, ["rev-parse", "--show-object-format"])).trim().toLowerCase();
  if (!["sha1", "sha256"].includes(objectFormat)) {
    throw sharedSnapshotIntegrityError("Shared snapshot uses an unsupported Git object format", {
      revision: acceptedRevision,
      objectFormat,
    });
  }
  return { revision: acceptedRevision, entries, objectFormat };
}

function stableSnapshotFile(filePath) {
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, flags);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n) {
      throw sharedSnapshotIntegrityError("Shared snapshot contains a non-regular or hard-linked file", { filePath });
    }
    const content = fs.readFileSync(descriptor);
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (!after.isFile()
      || after.nlink !== 1n
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.size !== before.size
      || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      throw sharedSnapshotIntegrityError("Shared snapshot file changed while it was being verified", { filePath });
    }
    return { content, mode: Number(after.mode) };
  } catch (error) {
    if (error?.code === "shared-snapshot-integrity") throw error;
    throw sharedSnapshotIntegrityError("Unable to read a Shared snapshot file safely", {
      filePath,
      cause: String(error?.message || error),
    });
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function snapshotFilesystemIndex(root) {
  const files = new Map();
  const directories = new Set([""]);
  const walk = (directory, prefix = "") => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw sharedSnapshotIntegrityError("Unable to enumerate Shared snapshot content", {
        directory,
        cause: String(error?.message || error),
      });
    }
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      let normalizedPath;
      try { normalizedPath = safeRelativePath(relativePath, "shared snapshot path"); }
      catch (error) {
        throw sharedSnapshotIntegrityError("Shared snapshot contains an unsafe filesystem path", {
          path: relativePath,
          cause: error.message,
        });
      }
      if (normalizedPath !== relativePath) {
        throw sharedSnapshotIntegrityError("Shared snapshot contains a non-canonical filesystem path", { path: relativePath });
      }
      const target = path.join(directory, entry.name);
      const stats = lstatIfPresent(target, { bigint: true });
      if (!stats || stats.isSymbolicLink()) {
        throw sharedSnapshotIntegrityError("Shared snapshot contains a missing or symbolic filesystem entry", { path: relativePath });
      }
      if (stats.isDirectory()) {
        directories.add(relativePath);
        walk(target, relativePath);
      } else if (stats.isFile() && stats.nlink === 1n) {
        files.set(relativePath, target);
      } else {
        throw sharedSnapshotIntegrityError("Shared snapshot contains a special or hard-linked filesystem entry", { path: relativePath });
      }
    }
  };
  walk(root);
  return { files, directories };
}

function assertSnapshotMatchesRevision(checkout, revision, root, expectedTree = null) {
  const expected = expectedTree || expectedSnapshotTree(checkout, revision);
  const actual = snapshotFilesystemIndex(root);
  const expectedFiles = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const expectedDirectories = new Set([""]);
  for (const entry of expected.entries) {
    const segments = entry.path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  const expectedPaths = [...expectedFiles.keys()].sort((left, right) => left.localeCompare(right, "en"));
  const actualPaths = [...actual.files.keys()].sort((left, right) => left.localeCompare(right, "en"));
  const expectedDirectoryPaths = [...expectedDirectories].sort((left, right) => left.localeCompare(right, "en"));
  const actualDirectoryPaths = [...actual.directories].sort((left, right) => left.localeCompare(right, "en"));
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)
    || JSON.stringify(actualDirectoryPaths) !== JSON.stringify(expectedDirectoryPaths)) {
    throw sharedSnapshotIntegrityError("Shared snapshot filesystem entries do not match the accepted Git tree", {
      revision: expected.revision,
      expectedFileCount: expectedPaths.length,
      actualFileCount: actualPaths.length,
      expectedDirectoryCount: expectedDirectoryPaths.length,
      actualDirectoryCount: actualDirectoryPaths.length,
    });
  }
  for (const [relativePath, entry] of expectedFiles) {
    const file = stableSnapshotFile(actual.files.get(relativePath));
    const executable = Boolean(file.mode & 0o111);
    if (executable !== (entry.mode === "100755")) {
      throw sharedSnapshotIntegrityError("Shared snapshot executable mode does not match the accepted Git tree", {
        revision: expected.revision,
        path: relativePath,
      });
    }
    const header = Buffer.from(`blob ${file.content.length}\0`, "utf8");
    const object = createHash(expected.objectFormat).update(header).update(file.content).digest("hex");
    if (object !== entry.object) {
      throw sharedSnapshotIntegrityError("Shared snapshot file content does not match the accepted Git tree", {
        revision: expected.revision,
        path: relativePath,
      });
    }
  }
  return { revision: expected.revision, fileCount: expectedPaths.length };
}

function buildSnapshotStaging(checkout, expected, temporary) {
  fs.mkdirSync(temporary, { mode: 0o700 });
  assertSharedCacheDirectoryNoFollow(temporary, "Shared snapshot staging directory");
  for (const entry of expected.entries) {
    const inspected = inspectSharedPathNoFollow(temporary, entry.path, { createParents: true });
    if (inspected.exists) {
      throw sharedSnapshotIntegrityError("Shared snapshot staging path already exists", { path: entry.path });
    }
    const content = runGit(checkout, ["cat-file", "blob", entry.object], { encoding: null });
    const flags = fs.constants.O_WRONLY
      | fs.constants.O_CREAT
      | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0);
    let descriptor;
    try {
      descriptor = fs.openSync(inspected.target, flags, entry.mode === "100755" ? 0o700 : 0o600);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      fs.fchmodSync(descriptor, entry.mode === "100755" ? 0o555 : 0o444);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  assertSnapshotMatchesRevision(checkout, expected.revision, temporary, expected);
  makeTreeReadOnly(temporary);
  assertSnapshotMatchesRevision(checkout, expected.revision, temporary, expected);
  // macOS refuses to rename a directory without owner-write permission even
  // when both parents are writable. Keep only the staging root writable until
  // the atomic publication step; every file and child directory stays sealed.
  fs.chmodSync(temporary, 0o700);
  return temporary;
}

function quarantineSharedSnapshot(cacheRoot, destination, revision, reason) {
  assertSharedCacheDirectoryNoFollow(destination, "Shared snapshot root");
  const quarantineRoot = path.join(cacheRoot, "quarantine");
  fs.mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  assertSharedCacheDirectoryNoFollow(quarantineRoot, "Shared snapshot quarantine");
  const quarantined = path.join(quarantineRoot, `snapshot-${revision.slice(0, 12)}-${Date.now()}-${randomUUID()}`);
  const before = fs.lstatSync(destination, { bigint: true });
  fs.chmodSync(destination, 0o700);
  try {
    fs.renameSync(destination, quarantined);
  } catch (error) {
    try { fs.chmodSync(destination, 0o555); } catch {}
    throw error;
  }
  const after = fs.lstatSync(quarantined, { bigint: true });
  if (after.dev !== before.dev || after.ino !== before.ino || !after.isDirectory() || after.isSymbolicLink()) {
    throw unsafeSharedFilesystemPath("Shared snapshot changed while it was being quarantined");
  }
  writePrivateJson(`${quarantined}.json`, {
    version: 1,
    revision,
    quarantinedAt: new Date().toISOString(),
    reason: String(reason || "Shared snapshot integrity mismatch").slice(0, 2_000),
  });
  return quarantined;
}

function materializeSnapshot(checkout, revision, destination) {
  const acceptedRevision = safeRevision(revision, "shared snapshot revision");
  const cacheRoot = path.dirname(path.dirname(destination));
  const snapshotsRoot = path.dirname(destination);
  assertSharedCacheDirectoryNoFollow(cacheRoot, "Shared repository cache");
  fs.mkdirSync(snapshotsRoot, { recursive: true });
  assertSharedCacheDirectoryNoFollow(snapshotsRoot, "Shared snapshot directory");
  const expected = expectedSnapshotTree(checkout, acceptedRevision);
  const existing = lstatIfPresent(destination);
  if (existing) {
    assertSharedCacheDirectoryNoFollow(destination, "Shared snapshot root");
    try {
      assertSnapshotMatchesRevision(checkout, acceptedRevision, destination, expected);
      makeTreeReadOnly(destination);
      assertSnapshotMatchesRevision(checkout, acceptedRevision, destination, expected);
      return destination;
    } catch (error) {
      if (error?.code !== "shared-snapshot-integrity") throw error;
      const temporary = path.join(cacheRoot, `snapshot-${acceptedRevision.slice(0, 12)}-${process.pid}-${randomUUID()}.tmp`);
      try {
        buildSnapshotStaging(checkout, expected, temporary);
        quarantineSharedSnapshot(cacheRoot, destination, acceptedRevision, error.message);
        fs.renameSync(temporary, destination);
        assertSharedCacheDirectoryNoFollow(destination, "Shared snapshot root");
        makeTreeReadOnly(destination);
        assertSnapshotMatchesRevision(checkout, acceptedRevision, destination, expected);
      } finally {
        if (fs.existsSync(temporary)) {
          makeTreeWritable(temporary);
          fs.rmSync(temporary, { recursive: true, force: true });
        }
      }
      return destination;
    }
  }
  const temporary = path.join(cacheRoot, `snapshot-${acceptedRevision.slice(0, 12)}-${process.pid}-${randomUUID()}.tmp`);
  try {
    buildSnapshotStaging(checkout, expected, temporary);
    fs.renameSync(temporary, destination);
    assertSharedCacheDirectoryNoFollow(destination, "Shared snapshot root");
    makeTreeReadOnly(destination);
    assertSnapshotMatchesRevision(checkout, acceptedRevision, destination, expected);
  } finally {
    if (fs.existsSync(temporary)) {
      makeTreeWritable(temporary);
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  }
  return destination;
}

function makeTreeReadOnly(root) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) {
      makeTreeReadOnly(target);
      fs.chmodSync(target, 0o555);
    } else if (entry.isFile()) {
      const executable = Boolean(fs.statSync(target).mode & 0o111);
      fs.chmodSync(target, executable ? 0o555 : 0o444);
    }
  }
  fs.chmodSync(root, 0o555);
}

function makeTreeWritable(root) {
  try { fs.chmodSync(root, 0o755); } catch {}
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(root, entry.name);
    if (entry.isDirectory()) makeTreeWritable(target);
    else if (entry.isFile()) try { fs.chmodSync(target, 0o644); } catch {}
  }
}

function replaceSymlink(linkPath, targetPath, { managedRoot = "" } = {}) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  let existing = null;
  try {
    existing = fs.lstatSync(linkPath);
  } catch {}
  if (existing && !existing.isSymbolicLink()) throw new Error(`Refusing to replace existing non-link path: ${linkPath}`);
  const existingTarget = existing?.isSymbolicLink() ? path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath)) : "";
  if (existingTarget === path.resolve(targetPath)) return false;
  if (existingTarget && managedRoot && existingTarget !== path.resolve(managedRoot) && !existingTarget.startsWith(path.resolve(managedRoot) + path.sep)) {
    throw new Error(`Refusing to replace unmanaged skill link: ${linkPath}`);
  }
  const temporary = `${linkPath}.context-room-${process.pid}.tmp`;
  try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  fs.symlinkSync(targetPath, temporary, "dir");
  fs.renameSync(temporary, linkPath);
  return true;
}

function skillDirectories(root) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(root, entry.name, "SKILL.md")))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function homeVirtualPath(absolutePath, trailingSlash = false) {
  const home = path.resolve(process.env.HOME || os.homedir());
  const absolute = path.resolve(absolutePath);
  if (absolute !== home && !absolute.startsWith(home + path.sep)) throw new Error(`Shared cache must stay inside the user home: ${absolute}`);
  const value = "~/" + path.relative(home, absolute).replaceAll(path.sep, "/");
  return trailingSlash ? value.replace(/\/$/, "") + "/" : value;
}

function appendUnique(values, next) {
  return [...new Set([...(values || []), ...next].filter(Boolean))];
}

function managedSymlinkTarget(linkPath, managedRoot) {
  let stats;
  try { stats = fs.lstatSync(linkPath); } catch { return { exists: false, symbolic: false, target: "" }; }
  if (!stats.isSymbolicLink()) return { exists: true, symbolic: false, target: "" };
  const target = path.resolve(path.dirname(linkPath), fs.readlinkSync(linkPath));
  const root = path.resolve(managedRoot);
  return { exists: true, symbolic: true, target, managed: target === root || target.startsWith(root + path.sep) };
}

function skillLinkRegistryPath(repository, projectRoot) {
  return path.join(repositoryCacheRoot(repository), "skill-links", `${hashKey(stableRoot(projectRoot))}.json`);
}

function skillLocationPreferencesPath(repository) {
  return path.join(repositoryCacheRoot(repository), "shared-resources-local.json");
}

function legacySkillLocationPreferencesPath(repository) {
  return path.join(repositoryCacheRoot(repository), "skill-locations-local.json");
}

function skillProviderPreferencesPath() {
  return path.join(sharedHome(), "skill-provider-preferences.json");
}

function normalizeProviderPreference(value, fallback = "enabled") {
  const state = String(value || fallback).trim();
  if (!["inherit", "enabled", "disabled"].includes(state)) throw new Error(`Invalid skill provider preference: ${state}`);
  return state;
}

export function sharedSkillProviderPreferences() {
  const raw = readJson(skillProviderPreferencesPath(), { version: 1, providers: {} });
  return {
    version: 1,
    providers: Object.fromEntries(Object.keys(SHARED_SKILL_PROVIDER_PROFILES).map((provider) => [provider, normalizeProviderPreference(raw.providers?.[provider], "enabled")])),
  };
}

export function writeSharedSkillProviderPreferences({ providers = {} } = {}) {
  const current = sharedSkillProviderPreferences();
  const next = {
    version: 1,
    providers: Object.fromEntries(Object.keys(SHARED_SKILL_PROVIDER_PROFILES).map((provider) => [provider, normalizeProviderPreference(providers[provider], current.providers[provider])])),
  };
  writePrivateJson(skillProviderPreferencesPath(), next);
  return next;
}

export function setSharedSkillProviderPreferences(root, input = {}) {
  const preferences = writeSharedSkillProviderPreferences(input);
  const registry = readJson(registryPath(), { bindings: [] });
  const rootsByRepository = new Map();
  for (const binding of registry.bindings || []) {
    const candidate = (binding.projectRoots || (binding.sourceRoot ? [binding.sourceRoot] : [])).find((item) => fs.existsSync(item));
    if (candidate && !rootsByRepository.has(binding.repository)) rootsByRepository.set(binding.repository, candidate);
  }
  const reconciled = [];
  const errors = [];
  for (const [repository, candidate] of rootsByRepository) {
    try {
      syncSharedContext(candidate, { allowOffline: true, forceReconcile: true });
      reconciled.push(repository);
    } catch (error) {
      errors.push({ repository, message: error.message });
    }
  }
  return {
    preferences,
    reconciled,
    errors,
    status: root && readSharedProjectConnection(root) ? sharedSkillLocationsStatus(root, { refresh: false }) : null,
    instructionStatus: root && readSharedProjectConnection(root) ? sharedInstructionLocationsStatus(root, { refresh: false }) : null,
  };
}

function privateFileSnapshot(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return { exists: true, content: fs.readFileSync(filePath), mode: stats.mode & 0o777 };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, content: null, mode: 0o600 };
    throw error;
  }
}

function restorePrivateFile(filePath, snapshot) {
  if (!snapshot.exists) {
    try { fs.unlinkSync(filePath); } catch (error) { if (error.code !== "ENOENT") throw error; }
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.restore.tmp`;
  try {
    fs.writeFileSync(temporary, snapshot.content, { mode: snapshot.mode });
    fs.chmodSync(temporary, snapshot.mode);
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function sharedMutationPathSnapshot(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isSymbolicLink()) {
      return { kind: "symlink", target: fs.readlinkSync(filePath) };
    }
    if (stats.isFile()) {
      return { kind: "file", content: fs.readFileSync(filePath), mode: stats.mode & 0o777 };
    }
    if (stats.isDirectory()) return { kind: "directory" };
    throw new Error(`Shared reconciliation cannot snapshot a special file: ${filePath}`);
  } catch (error) {
    if (error.code === "ENOENT") return { kind: "missing" };
    throw error;
  }
}

function removeSharedMutationLeaf(filePath) {
  try {
    const stats = fs.lstatSync(filePath);
    if (stats.isDirectory() && !stats.isSymbolicLink()) {
      throw new Error(`Shared reconciliation refuses to replace a directory during rollback: ${filePath}`);
    }
    fs.unlinkSync(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function restoreSharedMutationPath(filePath, snapshot) {
  if (snapshot.kind === "directory") {
    const stats = fs.lstatSync(filePath);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Shared reconciliation cannot restore the original directory: ${filePath}`);
    }
    return;
  }
  if (snapshot.kind === "missing") {
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isSymbolicLink()) {
        throw new Error(`Shared reconciliation refuses to remove new unmanaged content during rollback: ${filePath}`);
      }
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return;
  }
  if (snapshot.kind === "symlink") {
    try {
      const stats = fs.lstatSync(filePath);
      if (!stats.isSymbolicLink()) {
        throw new Error(`Shared reconciliation refuses to replace new unmanaged content during rollback: ${filePath}`);
      }
      fs.unlinkSync(filePath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    fs.symlinkSync(snapshot.target, filePath);
    return;
  }
  removeSharedMutationLeaf(filePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.reconcile-restore.tmp`;
  try {
    fs.writeFileSync(temporary, snapshot.content, { mode: snapshot.mode });
    fs.chmodSync(temporary, snapshot.mode);
    fs.renameSync(temporary, filePath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

function createSharedMutationTransaction(label = "shared reconciliation") {
  const snapshots = new Map();
  const moves = [];
  return {
    capture(filePath) {
      const resolved = path.resolve(filePath);
      if (!snapshots.has(resolved)) snapshots.set(resolved, sharedMutationPathSnapshot(resolved));
      return resolved;
    },
    recordMove(source, backup) {
      moves.push({ source: path.resolve(source), backup: path.resolve(backup) });
    },
    absorb(child) {
      for (const [filePath, snapshot] of child.snapshots) {
        if (!snapshots.has(filePath)) snapshots.set(filePath, snapshot);
      }
      moves.push(...child.moves);
    },
    rollback({ projectCapabilities = [] } = {}) {
      const errors = [];
      const exactCapabilities = (Array.isArray(projectCapabilities) ? projectCapabilities : [])
        .map((capability) => normalizedSharedProjectCapability(capability))
        .filter(Boolean)
        .sort((left, right) => right.root.length - left.root.length);
      const rollbackPathIsAuthorized = (filePath) => {
        const resolved = path.resolve(filePath);
        const capability = exactCapabilities.find((candidate) => (
          resolved === candidate.root || resolved.startsWith(candidate.root + path.sep)
        ));
        if (!capability) return true;
        try { return sameSharedProjectCapability(capability, currentSharedProjectCapability(capability.root)); }
        catch { return false; }
      };
      for (const move of [...moves].reverse()) {
        if (!rollbackPathIsAuthorized(move.source)) continue;
        try {
          if (!fs.existsSync(move.backup)) continue;
          let sourceStats = null;
          try { sourceStats = fs.lstatSync(move.source); } catch (error) { if (error.code !== "ENOENT") throw error; }
          if (sourceStats) {
            if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) {
              throw new Error(`Shared reconciliation refuses to overwrite a directory while restoring ${move.source}`);
            }
            fs.unlinkSync(move.source);
          }
          fs.mkdirSync(path.dirname(move.source), { recursive: true, mode: 0o700 });
          fs.renameSync(move.backup, move.source);
          const backupRoot = path.dirname(move.backup);
          try { if (fs.readdirSync(backupRoot).length === 0) fs.rmdirSync(backupRoot); } catch {}
        } catch (error) {
          errors.push(`${move.source}: ${error.message}`);
        }
      }
      for (const [filePath, snapshot] of [...snapshots.entries()].reverse()) {
        if (!rollbackPathIsAuthorized(filePath)) continue;
        try { restoreSharedMutationPath(filePath, snapshot); }
        catch (error) { errors.push(`${filePath}: ${error.message}`); }
      }
      if (errors.length) {
        const error = new Error(`${label} rollback failed: ${errors.join("; ")}`);
        error.code = "shared-reconcile-rollback-failed";
        error.rollbackErrors = errors;
        throw error;
      }
    },
    snapshots,
    moves,
  };
}

function serializedSharedMutationSnapshot(snapshot) {
  if (snapshot.kind === "file") {
    return { kind: "file", content: snapshot.content.toString("base64"), mode: snapshot.mode };
  }
  if (snapshot.kind === "symlink") return { kind: "symlink", target: snapshot.target };
  return { kind: snapshot.kind };
}

function deserializedSharedMutationSnapshot(snapshot) {
  const kind = String(snapshot?.kind || "");
  if (kind === "file") {
    const mode = Number(snapshot.mode);
    if (!Number.isInteger(mode) || mode < 0 || mode > 0o777) throw new Error("Invalid Shared transaction file mode");
    const content = String(snapshot.content || "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(content)) {
      throw new Error("Invalid Shared transaction file content");
    }
    return { kind, content: Buffer.from(content, "base64"), mode };
  }
  if (kind === "symlink") {
    const target = String(snapshot.target || "");
    if (!target || target.includes("\0")) throw new Error("Invalid Shared transaction symlink target");
    return { kind, target };
  }
  if (kind === "missing" || kind === "directory") return { kind };
  throw new Error("Invalid Shared transaction snapshot kind");
}

function sharedDisconnectTransactionsRoot() {
  return path.join(sharedHome(), "transactions", "disconnect");
}

function invalidSharedDisconnectTransactionsRoot() {
  return path.join(sharedDisconnectTransactionsRoot(), "invalid");
}

function abandonedInvalidSharedDisconnectTransactionsRoot() {
  return path.join(sharedDisconnectTransactionsRoot(), "abandoned-invalid");
}

function ensurePrivateSharedRecoveryDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stats = fs.lstatSync(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw unsafeSharedFilesystemPath(`Shared recovery path must be a physical directory: ${directory}`);
  }
  fs.chmodSync(directory, 0o700);
  return directory;
}

function fsyncSharedDirectory(directory) {
  const descriptor = fs.openSync(directory, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function fsyncSharedFileAndDirectory(filePath) {
  const descriptor = fs.openSync(filePath, "r");
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
  fsyncSharedDirectory(path.dirname(filePath));
}

function sharedDisconnectJournalPath(repository, binding, root) {
  const identity = JSON.stringify({
    repositoryIdentity: sharedRepositoryIdentity(repository),
    projectId: binding.projectId,
    sourceRoot: binding.sourceRoot || "",
    sourceSubpath: binding.sourceSubpath || "",
    sourceRemotes: binding.sourceRemotes || [],
    root: stableRoot(root),
  });
  return path.join(sharedDisconnectTransactionsRoot(), `${hashKey(identity, 32)}.json`);
}

function writeSharedDisconnectJournal(repository, binding, projectRoots, transaction, root, {
  projectCapabilities = [],
} = {}) {
  const exactCapabilities = (Array.isArray(projectCapabilities) ? projectCapabilities : [])
    .map((capability) => normalizedSharedProjectCapability(capability));
  const exactRoots = [...new Set(projectRoots.map((projectRoot) => path.resolve(projectRoot)))];
  if (exactCapabilities.some((capability) => !capability)
    || exactCapabilities.length !== exactRoots.length
    || !exactRoots.every((projectRoot) => exactCapabilities.some((capability) => capability.root === projectRoot))) {
    throw sharedContextError("shared-disconnect-capability-required", "A durable Shared disconnect journal requires one exact project capability per root");
  }
  const journalPath = sharedDisconnectJournalPath(repository, binding, root);
  writePrivateJson(journalPath, {
    version: 2,
    kind: "shared-disconnect",
    repository,
    repositoryIdentity: sharedRepositoryIdentity(repository),
    binding,
    projectRoots: exactRoots,
    projectCapabilities: exactCapabilities,
    root: stableRoot(root),
    createdAt: new Date().toISOString(),
    snapshots: [...transaction.snapshots].map(([filePath, snapshot]) => ({
      path: filePath,
      snapshot: serializedSharedMutationSnapshot(snapshot),
    })),
  });
  fsyncSharedFileAndDirectory(journalPath);
  return journalPath;
}

function removeSharedDisconnectJournal(journalPath) {
  try { fs.unlinkSync(journalPath); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { fsyncSharedDirectory(path.dirname(journalPath)); } catch (error) { if (error.code !== "ENOENT") throw error; }
  try { if (fs.readdirSync(path.dirname(journalPath)).length === 0) fs.rmdirSync(path.dirname(journalPath)); } catch {}
}

function sharedDisconnectRecoveryRevision(issueDirectory) {
  const digest = createHash("sha256");
  digest.update(path.basename(issueDirectory));
  for (const name of ["journal", "meta.json"]) {
    const filePath = path.join(issueDirectory, name);
    try {
      const stats = fs.lstatSync(filePath, { bigint: true });
      digest.update(`\0${name}\0${stats.dev}\0${stats.ino}\0${stats.size}\0${stats.mtimeNs}`);
      if (stats.isFile() && !stats.isSymbolicLink() && stats.size <= 2_097_152n) digest.update(fs.readFileSync(filePath));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      digest.update(`\0${name}\0missing`);
    }
  }
  return digest.digest("hex");
}

function quarantineInvalidSharedDisconnectTransactionUnderLock(journalPath, cause) {
  const originalName = path.basename(journalPath);
  const quarantineId = randomUUID();
  const invalidRoot = ensurePrivateSharedRecoveryDirectory(invalidSharedDisconnectTransactionsRoot());
  const issueDirectory = ensurePrivateSharedRecoveryDirectory(path.join(invalidRoot, quarantineId));
  const quarantinedPath = path.join(issueDirectory, "journal");
  fs.renameSync(journalPath, quarantinedPath);
  fs.chmodSync(quarantinedPath, 0o600);
  fsyncSharedFileAndDirectory(quarantinedPath);
  const quarantinedAt = new Date().toISOString();
  writePrivateJson(path.join(issueDirectory, "meta.json"), {
    version: 1,
    kind: "invalid-shared-disconnect-journal",
    quarantineId,
    originalName,
    quarantinedAt,
    code: String(cause?.code || "shared-disconnect-recovery-invalid").slice(0, 160),
    message: String(cause?.message || cause || "Unreadable Shared disconnect recovery journal").slice(0, 500),
  });
  fsyncSharedFileAndDirectory(path.join(issueDirectory, "meta.json"));
  fsyncSharedDirectory(issueDirectory);
  fsyncSharedDirectory(invalidRoot);
  fsyncSharedDirectory(sharedDisconnectTransactionsRoot());
  return { quarantineId, issueDirectory, quarantinedAt };
}

function genericInvalidSharedDisconnectRecoveryIssue(issueDirectory, quarantineId, message = "") {
  return {
    status: "recovery-required",
    scope: "global",
    kind: "invalid-journal",
    recoverySystem: "shared-disconnect",
    quarantineId,
    originalName: "",
    quarantinedAt: "",
    code: "shared-disconnect-recovery-quarantine-invalid",
    message: String(message || "A Shared disconnect recovery quarantine is incomplete or unreadable").slice(0, 500),
    revision: sharedDisconnectRecoveryRevision(issueDirectory),
    issueDirectory,
  };
}

function readInvalidSharedDisconnectRecoveryIssue(issueDirectory) {
  const quarantineId = path.basename(issueDirectory);
  let meta;
  try { meta = readJson(path.join(issueDirectory, "meta.json"), null); }
  catch (error) { return genericInvalidSharedDisconnectRecoveryIssue(issueDirectory, quarantineId, error.message); }
  const quarantinedPath = path.join(issueDirectory, "journal");
  try {
    const directoryStats = fs.lstatSync(issueDirectory);
    const journalStats = fs.lstatSync(quarantinedPath);
    if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()
      || journalStats.isSymbolicLink() || !journalStats.isFile()
      || meta?.version !== 1
      || meta?.kind !== "invalid-shared-disconnect-journal"
      || meta?.quarantineId !== quarantineId
      || !/^[0-9a-f-]{36}$/.test(quarantineId)
      || !Number.isFinite(Date.parse(String(meta?.quarantinedAt || "")))) {
      return genericInvalidSharedDisconnectRecoveryIssue(issueDirectory, quarantineId);
    }
  } catch (error) {
    return genericInvalidSharedDisconnectRecoveryIssue(issueDirectory, quarantineId, error.message);
  }
  return {
    status: "recovery-required",
    scope: "global",
    kind: "invalid-journal",
    recoverySystem: "shared-disconnect",
    quarantineId,
    originalName: String(meta.originalName || "").slice(0, 255),
    quarantinedAt: String(meta.quarantinedAt),
    code: String(meta.code || "shared-disconnect-recovery-invalid").slice(0, 160),
    message: String(meta.message || "An unreadable Shared disconnect recovery journal was quarantined").slice(0, 500),
    revision: sharedDisconnectRecoveryRevision(issueDirectory),
    issueDirectory,
  };
}

function readInvalidSharedDisconnectRecoveryIssuesUnderLock() {
  const directory = invalidSharedDisconnectTransactionsRoot();
  if (!fs.existsSync(directory)) return [];
  const directoryStats = fs.lstatSync(directory);
  if (directoryStats.isSymbolicLink() || !directoryStats.isDirectory()) {
    throw unsafeSharedFilesystemPath(`Shared disconnect recovery quarantine must be a physical directory: ${directory}`);
  }
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.startsWith("."))
    .slice(0, 1_024)
    .map((entry) => readInvalidSharedDisconnectRecoveryIssue(path.join(directory, entry.name)))
    .sort((left, right) => String(left.quarantinedAt).localeCompare(String(right.quarantinedAt), "en"));
}

export function listSharedDisconnectRecoveryIssues() {
  return withSharedRegistryLock(({ sharedRecoveryIssues }) => sharedRecoveryIssues.map((issue) => ({
    status: issue.status,
    scope: issue.scope,
    kind: issue.kind,
    recoverySystem: issue.recoverySystem,
    quarantineId: issue.quarantineId,
    originalName: issue.originalName,
    quarantinedAt: issue.quarantinedAt,
    code: issue.code,
    message: issue.message,
    revision: issue.revision,
  })), { allowRecoveryIssues: true });
}

export function peekSharedDisconnectRecoveryIssues() {
  return readInvalidSharedDisconnectRecoveryIssuesUnderLock().map((issue) => ({
    status: issue.status,
    scope: issue.scope,
    kind: issue.kind,
    recoverySystem: issue.recoverySystem,
    quarantineId: issue.quarantineId,
    originalName: issue.originalName,
    quarantinedAt: issue.quarantinedAt,
    code: issue.code,
    message: issue.message,
    revision: issue.revision,
  }));
}

export function abandonInvalidSharedDisconnectTransaction({ quarantineId = "", expectedRevision = "" } = {}) {
  const exactQuarantineId = String(quarantineId || "").trim();
  const exactRevision = String(expectedRevision || "").trim();
  if (!exactQuarantineId || !exactRevision) {
    const error = sharedContextError("shared-disconnect-recovery-identity-required", "Exact quarantine ID and revision are required to acknowledge unreadable Shared disconnect recovery");
    error.statusCode = 400;
    throw error;
  }
  return withSharedRegistryLock(({ sharedRecoveryIssues }) => {
    const issue = sharedRecoveryIssues.find((candidate) => candidate.quarantineId === exactQuarantineId);
    if (!issue) {
      const error = sharedContextError("shared-disconnect-recovery-not-found", "The quarantined Shared disconnect recovery issue no longer exists");
      error.statusCode = 404;
      throw error;
    }
    if (issue.revision !== exactRevision) {
      const error = sharedContextError("shared-disconnect-recovery-conflict", "The quarantined Shared disconnect recovery issue changed");
      error.statusCode = 409;
      throw error;
    }
    const archiveRoot = ensurePrivateSharedRecoveryDirectory(abandonedInvalidSharedDisconnectTransactionsRoot());
    const archivedIssueDirectory = path.join(archiveRoot, issue.quarantineId);
    if (fs.existsSync(archivedIssueDirectory)) {
      const error = sharedContextError("shared-disconnect-recovery-conflict", "This quarantined Shared disconnect recovery issue was already acknowledged");
      error.statusCode = 409;
      throw error;
    }
    fs.renameSync(issue.issueDirectory, archivedIssueDirectory);
    fsyncSharedDirectory(archiveRoot);
    fsyncSharedDirectory(invalidSharedDisconnectTransactionsRoot());
    fsyncSharedDirectory(sharedDisconnectTransactionsRoot());
    return {
      abandoned: true,
      quarantineId: issue.quarantineId,
      revision: issue.revision,
      scope: "global",
      recoverySystem: "shared-disconnect",
      archivedIssueDirectory,
    };
  }, { allowRecoveryIssues: true });
}

function exactSharedRegistryBindingExists(registry, binding) {
  const expected = JSON.stringify(binding);
  return (registry.bindings || []).some((candidate) => JSON.stringify(candidate) === expected);
}

function validatedSharedDisconnectJournal(journalPath) {
  const journal = readJson(journalPath);
  if (journal?.version !== 2 || journal?.kind !== "shared-disconnect") throw new Error("Unsupported Shared disconnect recovery journal");
  const repository = safeRepository(journal.repository);
  if (journal.repositoryIdentity !== sharedRepositoryIdentity(repository)) throw new Error("Shared disconnect recovery repository identity changed");
  const projectRoots = [...new Set((journal.projectRoots || []).map((item) => {
    const candidate = path.resolve(String(item || ""));
    if (candidate === path.parse(candidate).root) throw new Error("Unsafe Shared disconnect recovery project root");
    return candidate;
  }))];
  if (!projectRoots.length || !journal.binding || typeof journal.binding !== "object") throw new Error("Invalid Shared disconnect recovery binding");
  const projectCapabilities = Array.isArray(journal.projectCapabilities)
    ? journal.projectCapabilities.map((capability) => normalizedSharedProjectCapability(capability))
    : [];
  if (projectCapabilities.some((capability) => !capability)
    || projectCapabilities.length !== projectRoots.length
    || !projectRoots.every((projectRoot) => projectCapabilities.some((capability) => capability.root === projectRoot))) {
    throw new Error("Shared disconnect recovery capabilities do not match its exact project roots");
  }
  const allowedFiles = new Set([
    registryPath(),
    managedDestinationsRegistryPath(),
    ...projectRoots.flatMap((projectRoot) => [
      skillLinkRegistryPath(repository, projectRoot),
      instructionLinkRegistryPath(repository, projectRoot, "project"),
      instructionLinkRegistryPath(repository, projectRoot, "device"),
      path.join(projectRoot, ".context-room", "config.json"),
    ]),
  ].map((item) => path.resolve(item)));
  const entries = Array.isArray(journal.snapshots) ? journal.snapshots : [];
  if (!entries.length || entries.length > 10_000) throw new Error("Invalid Shared disconnect recovery snapshot count");
  const ownerEntry = entries.find((entry) => path.resolve(String(entry?.path || "")) === path.resolve(managedDestinationsRegistryPath()));
  const ownerSnapshot = deserializedSharedMutationSnapshot(ownerEntry?.snapshot);
  if (!new Set(["file", "missing"]).has(ownerSnapshot.kind)) throw new Error("Shared disconnect recovery owner registry is invalid");
  const owners = ownerSnapshot.kind === "file"
    ? JSON.parse(ownerSnapshot.content.toString("utf8"))?.destinations || {}
    : {};
  const managedRoot = repositoryCacheRoot(repository);
  const snapshots = new Map();
  for (const entry of entries) {
    const filePath = path.resolve(String(entry?.path || ""));
    if (!entry?.path || filePath === path.parse(filePath).root || snapshots.has(filePath)) {
      throw new Error("Invalid Shared disconnect recovery snapshot path");
    }
    const snapshot = deserializedSharedMutationSnapshot(entry.snapshot);
    if (!allowedFiles.has(filePath)) {
      const owner = owners[filePath];
      const resolvedTarget = snapshot.kind === "symlink"
        ? path.resolve(path.dirname(filePath), snapshot.target)
        : "";
      if (
        snapshot.kind !== "symlink"
        || !owner
        || !sameSharedRepository(owner.repository, repository)
        || resolvedTarget !== path.resolve(String(owner.target || ""))
        || (resolvedTarget !== managedRoot && !resolvedTarget.startsWith(managedRoot + path.sep))
      ) {
        throw new Error(`Unsafe Shared disconnect recovery link: ${filePath}`);
      }
    }
    snapshots.set(filePath, snapshot);
  }
  return { journal, repository, snapshots, projectCapabilities };
}

function recoverSharedDisconnectTransactionsUnderLock() {
  const directory = sharedDisconnectTransactionsRoot();
  if (!fs.existsSync(directory)) return [];
  const recovered = [];
  for (const name of fs.readdirSync(directory).filter((item) => item.endsWith(".json")).sort()) {
    const journalPath = path.join(directory, name);
    let recovery;
    try {
      recovery = validatedSharedDisconnectJournal(journalPath);
    } catch (cause) {
      const issue = quarantineInvalidSharedDisconnectTransactionUnderLock(journalPath, cause);
      recovered.push({ journalPath, action: "quarantined", quarantineId: issue.quarantineId });
      continue;
    }
    const registry = readJson(registryPath(), { version: 1, bindings: [] });
    if (exactSharedRegistryBindingExists(registry, recovery.journal.binding)) {
      try {
        for (const capability of recovery.projectCapabilities) {
          assertSharedProjectCapability(capability, "Shared disconnect recovery project");
        }
      } catch (cause) {
        const issue = quarantineInvalidSharedDisconnectTransactionUnderLock(journalPath, cause);
        recovered.push({ journalPath, action: "quarantined", quarantineId: issue.quarantineId, repository: recovery.repository });
        continue;
      }
      const errors = [];
      for (const [filePath, snapshot] of [...recovery.snapshots].reverse()) {
        try {
          for (const capability of recovery.projectCapabilities) {
            assertSharedProjectCapability(capability, "Shared disconnect recovery project");
          }
          restoreSharedMutationPath(filePath, snapshot);
        }
        catch (error) { errors.push(`${filePath}: ${error.message}`); }
      }
      if (errors.length) {
        const cause = new Error(`Shared disconnect recovery failed: ${errors.join("; ")}`);
        cause.code = "shared-disconnect-recovery-failed";
        cause.rollbackErrors = errors;
        const issue = quarantineInvalidSharedDisconnectTransactionUnderLock(journalPath, cause);
        recovered.push({ journalPath, action: "quarantined", quarantineId: issue.quarantineId, repository: recovery.repository });
        continue;
      }
      recovered.push({ journalPath, action: "rolled-back", repository: recovery.repository });
    } else {
      recovered.push({ journalPath, action: "committed", repository: recovery.repository });
    }
    removeSharedDisconnectJournal(journalPath);
  }
  return recovered;
}

function normalizedProviderSettingsInput(connection, { providers = {}, projectOverrides = {} } = {}) {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) throw new Error("providers must be an object keyed by provider id");
  const unknownGlobal = Object.keys(providers).find((provider) => !SHARED_SKILL_PROVIDER_PROFILES[provider]);
  if (unknownGlobal) throw new Error(`Unknown shared skill provider: ${unknownGlobal}`);
  const currentProviders = sharedSkillProviderPreferences().providers;
  const nextProviders = Object.fromEntries(Object.keys(SHARED_SKILL_PROVIDER_PROFILES).map((provider) => [
    provider,
    normalizeProviderPreference(providers[provider], currentProviders[provider]),
  ]));
  const entries = [];
  if (Array.isArray(projectOverrides)) {
    for (const item of projectOverrides) entries.push(item);
  } else {
    if (!projectOverrides || typeof projectOverrides !== "object") throw new Error("projectOverrides must be an object or array");
    const directProviderKeys = Object.keys(projectOverrides).filter((key) => SHARED_SKILL_PROVIDER_PROFILES[key]);
    const unknownDirectKeys = Object.keys(projectOverrides).filter((key) => !SHARED_SKILL_PROVIDER_PROFILES[key]);
    if (directProviderKeys.length) {
      if (unknownDirectKeys.length) throw new Error(`Unknown shared skill provider: ${unknownDirectKeys[0]}`);
      for (const provider of directProviderKeys) entries.push({ projectId: connection.projectId, provider, state: projectOverrides[provider] });
    } else {
      for (const [projectId, values] of Object.entries(projectOverrides)) {
        if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error(`Project provider overrides for ${projectId} must be an object`);
        const unknownProvider = Object.keys(values).find((provider) => !SHARED_SKILL_PROVIDER_PROFILES[provider]);
        if (unknownProvider) throw new Error(`Unknown shared skill provider: ${unknownProvider}`);
        for (const [provider, state] of Object.entries(values)) entries.push({ projectId, provider, state });
      }
    }
  }
  const normalizedOverrides = entries.map((item) => {
    const projectId = safeId(item?.projectId || connection.projectId, "skill provider override projectId");
    const provider = safeId(item?.provider, "skill provider override provider");
    if (!SHARED_SKILL_PROVIDER_PROFILES[provider]) throw new Error(`Unknown shared skill provider: ${provider}`);
    return { projectId, provider, state: normalizeProviderPreference(item?.state, "inherit") };
  });
  const duplicate = normalizedOverrides.find((item, index) => normalizedOverrides.findIndex((candidate) => candidate.projectId === item.projectId && candidate.provider === item.provider) !== index);
  if (duplicate) throw new Error(`Duplicate provider override for ${duplicate.projectId}:${duplicate.provider}`);
  return { nextProviders, normalizedOverrides };
}

export function setSharedSkillProviderSettings(root, input = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding");
  const { nextProviders, normalizedOverrides } = normalizedProviderSettingsInput(connection, input);
  const preferences = readSkillLocationPreferences(connection.repository);
  const registeredProjects = new Set(registeredRepositoryProjectLocations(connection.repository).map((location) => location.projectId));
  const unknownProject = normalizedOverrides.find((item) => !registeredProjects.has(item.projectId));
  if (unknownProject) throw new Error(`Provider override targets an unregistered shared project: ${unknownProject.projectId}`);
  const changedGlobalProviders = Object.keys(nextProviders).filter((provider) => sharedSkillProviderPreferences().providers[provider] !== nextProviders[provider]);
  const nextOverrides = [...preferences.providerOverrides];
  for (const override of normalizedOverrides) {
    const index = nextOverrides.findIndex((item) => item.projectId === override.projectId && item.provider === override.provider);
    if (index >= 0) nextOverrides.splice(index, 1);
    if (override.state !== "inherit") nextOverrides.push(override);
  }
  const changedProjectProviders = normalizedOverrides.filter((override) => {
    const previous = preferences.providerOverrides.find((item) => item.projectId === override.projectId && item.provider === override.provider)?.state || "inherit";
    return previous !== override.state;
  }).map((override) => override.provider);
  const affectedProviders = [...new Set([...changedGlobalProviders, ...changedProjectProviders])];
  const globalPath = skillProviderPreferencesPath();
  const localPath = skillLocationPreferencesPath(connection.repository);
  const beforeGlobal = privateFileSnapshot(globalPath);
  const beforeLocal = privateFileSnapshot(localPath);
  const nextLocal = { ...preferences, providerOverrides: nextOverrides };
  const repositoryRoots = new Map();
  if (changedGlobalProviders.length) {
    const registry = readJson(registryPath(), { bindings: [] });
    for (const binding of registry.bindings || []) {
      const candidate = (binding.projectRoots || (binding.sourceRoot ? [binding.sourceRoot] : [])).find((item) => fs.existsSync(item));
      if (candidate && !repositoryRoots.has(binding.repository)) repositoryRoots.set(binding.repository, candidate);
    }
  } else {
    repositoryRoots.set(connection.repository, connection.projectRoot || path.resolve(root));
  }
  if (!affectedProviders.length) {
    return { changed: false, providers: { version: 1, providers: nextProviders }, projectOverrides: nextOverrides, reconciled: [], status: sharedSkillLocationsStatus(root, { refresh: false }) };
  }
  try {
    writePrivateJson(globalPath, { version: 1, providers: nextProviders });
    writeSkillLocationPreferences(connection.repository, nextLocal);
    const reconciled = [];
    for (const [repository, candidate] of repositoryRoots) {
      const synced = syncSharedContext(candidate, { allowOffline: true, forceReconcile: true, providers: affectedProviders });
      const failures = [
        ...(synced.skillDestinations || []).filter((destination) => ["error", "worktree-error"].includes(destination.status)),
        ...(synced.instructionLinks || []).filter((link) => link.status === "error"),
      ];
      if (failures.length) throw new Error(`Unable to reconcile shared resource provider settings: ${failures[0].message || failures[0].status}`);
      reconciled.push(repository);
    }
    return {
      changed: true,
      providers: { version: 1, providers: nextProviders },
      projectOverrides: nextOverrides,
      affectedProviders,
      reconciled,
      status: sharedSkillLocationsStatus(root, { refresh: false }),
      instructionStatus: sharedInstructionLocationsStatus(root, { refresh: false }),
    };
  } catch (error) {
    restorePrivateFile(globalPath, beforeGlobal);
    restorePrivateFile(localPath, beforeLocal);
    for (const candidate of repositoryRoots.values()) {
      try { syncSharedContext(candidate, { allowOffline: true, forceReconcile: true, providers: affectedProviders }); } catch {}
    }
    throw error;
  }
}

function readSkillLocationPreferences(repository) {
  const currentPath = skillLocationPreferencesPath(repository);
  const legacyPath = legacySkillLocationPreferencesPath(repository);
  const raw = fs.existsSync(currentPath)
    ? readJson(currentPath)
    : readJson(legacyPath, { version: 2, mounts: [], overrides: [], providerOverrides: [], pendingImports: [] });
  const version = Number(raw?.version || 1);
  if (![1, 2, SHARED_RESOURCE_LOCAL_STATE_VERSION].includes(version)) throw new Error(`Unsupported shared resource local state version: ${version}`);
  const mountsSource = raw.skillMounts || raw.mounts;
  const mounts = Array.isArray(mountsSource) ? mountsSource.flatMap((item) => {
    try {
      const id = safeId(item?.id, "local skill mount id");
      const collectionId = safeId(item?.collectionId, `local skill mount ${id} collectionId`);
      const rawDestination = String(item?.destination || "").trim();
      if (!rawDestination) throw new Error("destination is required");
      const destination = path.resolve(rawDestination);
      if (!destination || destination === path.parse(destination).root) throw new Error("destination is unsafe");
      return [{ id, assignmentId: item?.assignmentId ? safeId(item.assignmentId, `local skill mount ${id} assignmentId`) : "", collectionId, destination, provider: item?.provider ? safeId(item.provider, `local skill mount ${id} provider`) : "custom", scope: ["project", "shared", "device"].includes(item?.scope) ? item.scope : "project", projectId: item?.projectId ? safeId(item.projectId, `local skill mount ${id} projectId`) : "", include: normalizedSkillSelection(item?.include, ["*"]), exclude: normalizedSkillSelection(item?.exclude, []), enabled: item?.enabled !== false }];
    } catch { return []; }
  }) : [];
  const overridesSource = raw.skillOverrides || raw.overrides;
  const overrides = Array.isArray(overridesSource) ? overridesSource.flatMap((item) => {
    try {
      return [{ assignmentId: safeId(item?.assignmentId, "skill assignment override id"), projectId: item?.projectId ? safeId(item.projectId, "skill assignment override projectId") : "", disabled: Boolean(item?.disabled), exclude: normalizedSkillSelection(item?.exclude, []) }];
    } catch { return []; }
  }) : [];
  const providerOverrides = Array.isArray(raw.providerOverrides) ? raw.providerOverrides.flatMap((item) => {
    try {
      return [{ projectId: safeId(item?.projectId, "skill provider override projectId"), provider: safeId(item?.provider, "skill provider override provider"), state: normalizeProviderPreference(item?.state, "inherit") }];
    } catch { return []; }
  }) : [];
  const skillImportsSource = raw.pendingSkillImports || raw.pendingImports;
  const pendingImports = Array.isArray(skillImportsSource) ? skillImportsSource.flatMap((item) => {
    try {
      const sourceDirectory = String(item?.sourceDirectory || "").trim();
      const destination = String(item?.destination || "").trim();
      if (!sourceDirectory || !destination) throw new Error("pending import paths are required");
      return [{ id: safeId(item?.id, "pending skill import id"), proposal: safeBranchName(item?.proposal, "pending skill import proposal"), proposalHead: item?.proposalHead ? safeRevision(item.proposalHead, "pending skill import proposal head") : "", collectionId: safeId(item?.collectionId, "pending skill import collectionId"), sourceDirectory: path.resolve(sourceDirectory), destination: path.resolve(destination), skills: normalizedSkillSelection(item?.skills, []), createdAt: String(item?.createdAt || "") }];
    } catch { return []; }
  }) : [];
  const pendingInstructionImports = Array.isArray(raw.pendingInstructionImports) ? raw.pendingInstructionImports.flatMap((item) => {
    try {
      const files = Array.isArray(item?.files) ? item.files.map((file) => ({
        localPath: path.resolve(String(file?.localPath || "")),
        contentHash: String(file?.contentHash || ""),
        source: safeInstructionPath(file?.source, "pending instruction import source"),
        target: safeInstructionPath(file?.target, "pending instruction import target"),
        providers: [...new Set((file?.providers || []).map((provider) => safeId(provider, "pending instruction import provider")))],
        destinations: Array.isArray(file?.destinations) ? file.destinations.map((destination) => path.resolve(String(destination))) : [],
      })) : [];
      if (!files.length || files.some((file) => !file.localPath || !file.contentHash)) throw new Error("pending instruction import files are required");
      return [{
        id: safeId(item?.id, "pending instruction import id"),
        proposal: safeBranchName(item?.proposal, "pending instruction import proposal"),
        proposalHead: item?.proposalHead ? safeRevision(item.proposalHead, "pending instruction import proposal head") : "",
        collectionId: safeId(item?.collectionId, "pending instruction import collectionId"),
        assignmentId: safeId(item?.assignmentId, "pending instruction import assignmentId"),
        scope: ["project", "shared", "device"].includes(item?.scope) ? item.scope : "project",
        projectId: item?.projectId ? safeId(item.projectId, "pending instruction import projectId") : "",
        files,
        createdAt: String(item?.createdAt || ""),
        error: String(item?.error || ""),
      }];
    } catch { return []; }
  }) : [];
  return { version: SHARED_RESOURCE_LOCAL_STATE_VERSION, mounts, overrides, providerOverrides, pendingImports, pendingInstructionImports, updatedAt: String(raw.updatedAt || "") };
}

function writeSkillLocationPreferences(repository, preferences) {
  writePrivateJson(skillLocationPreferencesPath(repository), {
    $schema: "https://unpkg.com/context-room@latest/schemas/shared-resource-local-state.schema.json",
    version: SHARED_RESOURCE_LOCAL_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    skillMounts: preferences.mounts || [],
    skillOverrides: preferences.overrides || [],
    providerOverrides: preferences.providerOverrides || [],
    pendingSkillImports: preferences.pendingImports || [],
    pendingInstructionImports: preferences.pendingInstructionImports || [],
  });
}

export function readSharedSkillLocalState(root) {
  const connection = readSharedProjectConnection(root);
  if (!connection) return { connected: false, version: SHARED_RESOURCE_LOCAL_STATE_VERSION, mounts: [], overrides: [], providerOverrides: [], pendingImports: [], pendingInstructionImports: [] };
  return { connected: true, repository: connection.repository, projectId: connection.projectId, ...readSkillLocationPreferences(connection.repository) };
}

function expandUserPath(value) {
  const raw = String(value || "").trim();
  if (raw === "~") return path.resolve(process.env.HOME || os.homedir());
  if (raw.startsWith("~/")) return path.join(process.env.HOME || os.homedir(), raw.slice(2));
  return path.resolve(raw);
}

function providerSkillDestination(providerId, scope, projectRoot) {
  const profile = SHARED_SKILL_PROVIDER_PROFILES[providerId];
  if (!profile) return null;
  return scope === "device" ? expandUserPath(profile.globalPath) : path.resolve(projectRoot, profile.projectPath);
}

function instructionLinkRegistryPath(repository, projectRoot, scope = "project") {
  const identity = scope === "device" ? "device" : hashKey(stableRoot(projectRoot));
  return path.join(repositoryCacheRoot(repository), "instruction-links", `${identity}.json`);
}

function providerInstructionRoot(providerId, scope, projectRoot) {
  const profile = contextProviderProfile(providerId);
  if (!profile) return null;
  return scope === "device" ? expandUserPath(profile.instructions.deviceRoot) : path.resolve(projectRoot);
}

function fileContentHash(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readOptionalText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function normalizedInstructionRelativeTarget(target) {
  return String(target || "").replaceAll("\\", "/").replace(/^\.\//, "");
}

function codexFallbackTargets(projectRoot) {
  const candidates = [path.join(expandUserPath("~/.codex"), "config.toml"), path.join(projectRoot, ".codex", "config.toml")];
  const result = new Set();
  for (const candidate of candidates) {
    const text = readOptionalText(candidate);
    const match = text.match(/project_doc_fallback_filenames\s*=\s*\[([\s\S]*?)\]/m);
    if (!match) continue;
    for (const item of match[1].matchAll(/["']([^"']+)["']/g)) result.add(normalizedInstructionRelativeTarget(item[1]));
  }
  return result;
}

function claudeImportedTargets(projectRoot) {
  const result = new Set();
  const candidates = [path.join(expandUserPath("~/.claude"), "CLAUDE.md"), path.join(projectRoot, "CLAUDE.md"), path.join(projectRoot, ".claude", "CLAUDE.md"), path.join(projectRoot, "CLAUDE.local.md")];
  for (const candidate of candidates) {
    const text = readOptionalText(candidate);
    for (const match of text.matchAll(/(?:^|\s)@([^\s`]+)/gm)) {
      const raw = match[1].replace(/[),.;]+$/, "");
      const absolute = raw.startsWith("~/") ? expandUserPath(raw) : path.resolve(path.dirname(candidate), raw);
      if (absolute === projectRoot || !absolute.startsWith(projectRoot + path.sep)) continue;
      result.add(normalizedInstructionRelativeTarget(path.relative(projectRoot, absolute)));
    }
  }
  return result;
}

function opencodeConfiguredTargets(projectRoot) {
  const result = new Set();
  for (const candidate of [path.join(expandUserPath("~/.config/opencode"), "opencode.json"), path.join(projectRoot, "opencode.json"), path.join(projectRoot, "opencode.jsonc")]) {
    const text = readOptionalText(candidate);
    if (!text) continue;
    try {
      const parsed = parseJsonc(text);
      for (const item of Array.isArray(parsed?.instructions) ? parsed.instructions : []) {
        if (typeof item === "string" && !/[?*\[\]{}]/.test(item)) result.add(normalizedInstructionRelativeTarget(item));
      }
    } catch {}
  }
  return result;
}

function providerInstructionActivation(providerId, relativeTarget, scope, projectRoot, { plannedTargets = [] } = {}) {
  const profile = contextProviderProfile(providerId);
  const target = normalizedInstructionRelativeTarget(relativeTarget);
  const basename = path.posix.basename(target);
  const native = new Set(profile.instructions.nativeTargets || []);
  if (native.has(target) || native.has(basename)) return { status: "active", reason: `Discovered as native ${profile.label} instructions`, source: "provider-profile" };
  if (providerId === "claude-code" && /^\.claude\/rules\/.+\.md$/i.test(target)) return { status: "active", reason: "Discovered by Claude Code project rules", source: "provider-profile" };
  const configured = providerId === "codex" ? codexFallbackTargets(projectRoot)
    : providerId === "claude-code" ? claudeImportedTargets(projectRoot)
      : opencodeConfiguredTargets(projectRoot);
  if (configured.has(target) || configured.has(basename)) {
    if (providerId === "codex") {
      const directory = path.posix.dirname(target) === "." ? "" : path.posix.dirname(target);
      const nativeSibling = [...new Set([...(profile.instructions.nativeTargets || []), ...plannedTargets])].find((candidate) => {
        const normalized = normalizedInstructionRelativeTarget(candidate);
        const candidateDirectory = path.posix.dirname(normalized) === "." ? "" : path.posix.dirname(normalized);
        const candidateBasename = path.posix.basename(normalized);
        if (candidateDirectory !== directory || !native.has(candidateBasename)) return false;
        const destinationRoot = providerInstructionRoot(providerId, scope, projectRoot);
        return plannedTargets.includes(candidate) || fs.existsSync(path.resolve(destinationRoot, ...normalized.split("/")));
      });
      if (nativeSibling) return { status: "shadowed", reason: `Codex uses ${path.posix.basename(nativeSibling)} before configured fallback ${target}`, source: profile.instructions.configuredTargets };
    }
    return { status: "configured", reason: `Discovered through explicit ${profile.label} configuration`, source: profile.instructions.configuredTargets };
  }
  if (scope === "device" && providerId === "claude-code" && basename === "CLAUDE.md") return { status: "active", reason: "Discovered as Claude Code user memory", source: "provider-profile" };
  return { status: "inactive", reason: `Installed target ${target} is not discovered by ${profile.label}`, source: "provider-profile" };
}

function instructionAssignmentApplies(assignment, projectId) {
  return assignment.scope === "device" || assignment.scope === "shared" || (assignment.scope === "project" && assignment.projectIds.includes(projectId));
}

function resolvedInstructionLinkPlan(root, connection, repositoryConfig, catalog, currentRoot, { includeDevice = true, providers = null } = {}) {
  const locations = readSharedInstructionLocationsFromRoot(currentRoot, repositoryConfig, catalog);
  const preferences = readSkillLocationPreferences(connection.repository);
  const providerSet = providers?.length ? new Set(providers) : null;
  const collections = locations.collections.map((collection) => ({ ...collection, source: path.join(currentRoot, collection.path) }));
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const plannedTargets = new Map();
  for (const assignment of locations.assignments) {
    if (!instructionAssignmentApplies(assignment, connection.projectId) || (assignment.scope === "device" && !includeDevice)) continue;
    for (const file of assignment.files) for (const provider of file.providers) {
      if (providerSet && !providerSet.has(provider)) continue;
      plannedTargets.set(provider, [...(plannedTargets.get(provider) || []), file.target]);
    }
  }
  const links = [];
  for (const assignment of locations.assignments) {
    if (!instructionAssignmentApplies(assignment, connection.projectId)) continue;
    if (assignment.scope === "device" && !includeDevice) continue;
    const collection = collectionById.get(assignment.collectionId);
    if (!collection) continue;
    for (const file of assignment.files) {
      const source = path.resolve(collection.source, ...file.source.split("/"));
      if (source !== collection.source && !source.startsWith(collection.source + path.sep)) throw new Error(`Instruction source escapes collection ${collection.id}`);
      for (const provider of file.providers) {
        if (providerSet && !providerSet.has(provider)) continue;
        const destinationRoot = providerInstructionRoot(provider, assignment.scope, root);
        const providerPreference = effectiveSkillProviderState(preferences, provider, connection.projectId, assignment.scope);
        const activation = providerInstructionActivation(provider, file.target, assignment.scope, root, { plannedTargets: plannedTargets.get(provider) || [] });
        const disabled = providerPreference.state === "disabled";
        links.push({
          id: `${assignment.id}:${provider}:${hashKey(file.target, 10)}`,
          assignmentId: assignment.id,
          collectionId: collection.id,
          scope: assignment.scope,
          projectId: assignment.scope === "device" ? "" : connection.projectId,
          provider,
          source: file.source,
          target: source,
          destination: destinationRoot ? path.resolve(destinationRoot, ...file.target.split("/")) : "",
          relativeTarget: file.target,
          status: disabled ? "provider-disabled" : destinationRoot ? "pending" : "provider-unavailable",
          materializationStatus: disabled ? "provider-disabled" : destinationRoot ? "pending" : "provider-unavailable",
          activationStatus: disabled ? "inactive" : activation.status,
          activationReason: activation.reason,
          activationSource: activation.source,
          providerPreference,
          message: disabled ? `Provider ${provider} is disabled for this project` : destinationRoot ? "" : `No instruction destination is configured for ${provider}`,
        });
      }
    }
  }
  return { locations, preferences, collections, links, currentRoot };
}

function importTerminalAuthority(plan, connection, pending) {
  if (!pending.proposalHead) return { status: "pending", error: "terminal-authority-missing" };
  const checkout = repositoryCheckout(connection.repository);
  const revision = safeRevision(path.basename(plan.currentRoot || ""), "accepted shared revision");
  const proposal = safeBranchName(pending.proposal, "pending import proposal");
  const proposalHead = safeRevision(pending.proposalHead, "pending import proposal head");
  const evidence = proposalTerminalEvidence({
    connection: { repository: connection.repository },
    repositoryConfig: plan.locations?.repositoryConfig || readSharedRepositoryConfig(plan.currentRoot),
    revision,
  }, checkout, proposal, proposalHead);
  const acceptedCommit = evidence.remoteState?.acceptedCommit || "";
  const accepted = Boolean(
    !evidence.contradictory
    && evidence.remoteAccepted
    && evidence.remoteAcceptedVerified
    && evidence.signedAccepted
    && evidence.signedAcceptanceVerified
    && evidence.signedAcceptedCommit === acceptedCommit
    && evidence.exactMainCandidate?.commit === acceptedCommit
  );
  if (accepted) return { status: "accepted", acceptedCommit };
  const rejected = Boolean(
    !evidence.contradictory
    && evidence.remoteRejected
    && evidence.remoteRejectedVerified
    && evidence.signedRejected
    && evidence.decision?.archiveRef === evidence.rejection.expectedArchive
  );
  if (rejected) return { status: "rejected" };
  const activeHead = remoteBranchRevision(checkout, proposal);
  const invalid = evidence.contradictory
    || evidence.remoteState?.status === "invalid"
    || (evidence.remoteState?.status && evidence.remoteState.status !== "missing" && evidence.remoteState.status !== "active");
  return {
    status: invalid ? "invalid" : "pending",
    error: invalid ? "terminal-authority-invalid" : (activeHead ? "" : "terminal-authority-missing"),
  };
}

function archiveAcceptedInstructionImports(plan, connection, root, transaction = null) {
  if (!plan.preferences.pendingInstructionImports.length) return [];
  const completed = [];
  const remaining = [];
  for (const pending of plan.preferences.pendingInstructionImports) {
    const authority = importTerminalAuthority(plan, connection, pending);
    if (authority.status !== "accepted") {
      if (authority.status !== "rejected") remaining.push(authority.error ? { ...pending, error: authority.error } : pending);
      continue;
    }
    const acceptedLinks = plan.links.filter((link) => link.collectionId === pending.collectionId && link.assignmentId === pending.assignmentId);
    const missingMapping = pending.files.find((file) => !acceptedLinks.some((link) => link.source === file.source && file.providers.includes(link.provider) && fs.existsSync(link.target)));
    if (missingMapping) {
      remaining.push({ ...pending, error: `Accepted instruction mapping is missing from main: ${missingMapping.source}` });
      continue;
    }
    const backupRoot = path.join(repositoryCacheRoot(connection.repository), "instruction-import-backups", `${Date.now()}-${pending.id}`);
    const moved = [];
    let changed = null;
    let deferred = false;
    try {
      for (const file of pending.files) {
        if (!fs.existsSync(file.localPath)) continue;
        if (fileContentHash(file.localPath) !== file.contentHash) {
          changed = file.localPath;
          break;
        }
        const fileLinks = acceptedLinks.filter((link) => link.source === file.source && file.providers.includes(link.provider));
        const destinations = fileLinks.map((link) => path.resolve(link.destination));
        if (!destinations.includes(stableRoot(file.localPath))) continue;
        const installableAtSource = fileLinks.some((link) => path.resolve(link.destination) === stableRoot(file.localPath) && link.materializationStatus !== "provider-disabled");
        if (!installableAtSource) {
          deferred = true;
          continue;
        }
        fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
        const backup = path.join(backupRoot, `${hashKey(file.localPath, 12)}-${path.basename(file.localPath)}`);
        transaction?.recordMove(file.localPath, backup);
        fs.renameSync(file.localPath, backup);
        moved.push({ source: file.localPath, backup });
      }
      if (changed) throw Object.assign(new Error(`Imported instruction changed locally: ${changed}`), { code: "import-source-changed" });
      if (deferred) remaining.push({ ...pending, error: "provider-disabled" });
      else completed.push({ ...pending, backupRoot: moved.length ? backupRoot : "", archived: moved.map((item) => item.backup) });
    } catch (error) {
      for (const item of moved.reverse()) {
        try { fs.renameSync(item.backup, item.source); } catch {}
      }
      remaining.push({ ...pending, error: error.code === "import-source-changed" ? error.code : error.message });
    }
  }
  plan.preferences.pendingInstructionImports = remaining;
  writeSkillLocationPreferences(connection.repository, plan.preferences);
  return completed;
}

function reconcileInstructionLinks(root, connection, repositoryConfig, currentRoot, catalog, { includeDevice = true, providers = null, transaction = null } = {}) {
  const plan = resolvedInstructionLinkPlan(root, connection, repositoryConfig, catalog, currentRoot, { includeDevice, providers });
  const completedImports = archiveAcceptedInstructionImports(plan, connection, root, transaction);
  const managedRoot = repositoryCacheRoot(connection.repository);
  const grouped = new Map();
  grouped.set(instructionLinkRegistryPath(connection.repository, root, "project"), []);
  if (includeDevice) grouped.set(instructionLinkRegistryPath(connection.repository, root, "device"), []);
  for (const item of plan.links) {
    const registryScope = item.scope === "device" ? "device" : "project";
    const registryFile = instructionLinkRegistryPath(connection.repository, root, registryScope);
    grouped.set(registryFile, [...(grouped.get(registryFile) || []), item]);
  }
  const results = [];
  const providerSet = providers?.length ? new Set(providers) : null;
  for (const [registryFile, desiredItems] of grouped) {
    const previous = readJson(registryFile, { version: 1, links: [] });
    const untouched = providerSet ? (previous.links || []).filter((item) => !providerSet.has(item.provider)) : [];
    const byDestination = new Map();
    for (const item of desiredItems) byDestination.set(path.resolve(item.destination || "/"), [...(byDestination.get(path.resolve(item.destination || "/")) || []), item]);
    const conflicts = [];
    for (const items of byDestination.values()) {
      const targets = [...new Set(items.map((item) => path.resolve(item.target)))];
      if (items[0].destination && targets.length > 1) {
        conflicts.push({ path: items[0].destination, reason: `Several shared instructions target the same file (${items.map((item) => item.assignmentId).join(", ")})` });
      }
    }
    const conflictPaths = new Set(conflicts.map((item) => path.resolve(item.path)));
    const next = [];
    for (const item of desiredItems) {
      if (item.materializationStatus === "provider-disabled") {
        const state = item.destination ? managedSymlinkTarget(item.destination, managedRoot) : { symbolic: false, managed: false };
        if (state.symbolic && state.managed) {
          try { removeManagedResourceLink(item.destination, { managedRoot, repository: connection.repository, assignmentId: item.assignmentId }); } catch {}
        }
        next.push({ ...item, status: "provider-disabled", materializationStatus: "provider-disabled" });
        continue;
      }
      if (!item.destination) {
        next.push(item);
        continue;
      }
      if (!fs.existsSync(item.target) || !fs.statSync(item.target).isFile()) {
        next.push({ ...item, status: "source-missing", materializationStatus: "source-missing", message: `Shared instruction is missing: ${item.source}` });
        continue;
      }
      if (conflictPaths.has(path.resolve(item.destination))) {
        next.push({ ...item, status: "conflict", materializationStatus: "collision", conflicts: conflicts.filter((conflict) => path.resolve(conflict.path) === path.resolve(item.destination)), message: "Several assignments target this instruction file" });
        continue;
      }
      const state = managedSymlinkTarget(item.destination, managedRoot);
      const existingOwner = managedDestinationOwner(item.destination);
      if (existingOwner && existingOwner.repository !== connection.repository) {
        next.push({ ...item, status: "conflict", materializationStatus: "shared-owner-conflict", owner: existingOwner, conflicts: [{ path: item.destination, reason: `Destination is managed by ${existingOwner.repository}` }], message: "Managed by another shared context" });
        continue;
      }
      if (state.exists && (!state.symbolic || !state.managed)) {
        next.push({ ...item, status: "conflict", materializationStatus: "unmanaged-conflict", conflicts: [{ path: item.destination, reason: "Destination already contains an unmanaged instruction file" }], message: "Unmanaged instruction file preserved" });
        continue;
      }
      try {
        replaceManagedResourceLink(item.destination, item.target, { managedRoot, owner: { repository: connection.repository, resourceType: "instruction", assignmentId: item.assignmentId, provider: item.provider, revision: path.basename(currentRoot) } });
        next.push({ ...item, status: "ready", materializationStatus: "installed", owner: managedDestinationOwner(item.destination), conflicts: [] });
      } catch (error) {
        next.push({ ...item, status: error.code === "shared-owner-conflict" ? "conflict" : "error", materializationStatus: error.code === "shared-owner-conflict" ? "shared-owner-conflict" : "error", owner: error.owner || null, message: error.message, conflicts: error.owner ? [{ path: item.destination, reason: `Destination is managed by ${error.owner.repository}` }] : [] });
      }
    }
    const desiredPaths = new Set(desiredItems.filter((item) => item.destination).map((item) => path.resolve(item.destination)));
    for (const stale of (previous.links || []).filter((item) => !providerSet || providerSet.has(item.provider))) {
      if (!stale.destination || desiredPaths.has(path.resolve(stale.destination))) continue;
      const state = managedSymlinkTarget(stale.destination, managedRoot);
      if (state.symbolic && state.managed) {
        try { removeManagedResourceLink(stale.destination, { managedRoot, repository: connection.repository, assignmentId: stale.assignmentId }); } catch {}
      }
    }
    writePrivateJson(registryFile, { version: 1, repository: connection.repository, projectRoot: root, revision: path.basename(currentRoot), links: [...untouched, ...next] });
    results.push(...untouched, ...next);
  }
  return { ...plan, links: results, completedImports };
}

export function sharedInstructionLocationsStatus(root, { refresh = true } = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) return { connected: false, collections: [], assignments: [], links: [], conflicts: [], providers: Object.values(SHARED_SKILL_PROVIDER_PROFILES) };
  const synced = refresh ? syncSharedContext(root, { allowOffline: true }) : cachedSharedRepositoryState(connection.repository, { projectId: connection.projectId, projectRoot: connection.projectRoot || path.resolve(root) });
  const snapshot = synced.snapshot || path.join(synced.cacheRoot, "snapshots", synced.revision);
  const locations = readSharedInstructionLocationsFromRoot(snapshot, synced.repositoryConfig, synced.catalog);
  const projectRegistry = readJson(instructionLinkRegistryPath(connection.repository, connection.projectRoot || path.resolve(root)), { links: [] });
  const deviceRegistry = readJson(instructionLinkRegistryPath(connection.repository, connection.projectRoot || path.resolve(root), "device"), { links: [] });
  const links = [...(projectRegistry.links || []), ...(deviceRegistry.links || [])];
  const preferences = readSkillLocationPreferences(connection.repository);
  const providerPreferences = sharedSkillProviderPreferences();
  return {
    connected: true,
    repository: connection.repository,
    projectId: connection.projectId,
    projects: synced.catalog.projects,
    revision: synced.revision,
    online: synced.online !== false,
    freshness: synced.online === false ? "offline" : "fresh",
    manifestPath: synced.repositoryConfig.instructionLocationsFile,
    collections: locations.collections.map((collection) => ({ ...collection, fileCount: (() => {
      const source = path.join(snapshot, collection.path);
      if (!fs.existsSync(source)) return 0;
      let count = 0;
      const walk = (directory) => { for (const entry of fs.readdirSync(directory, { withFileTypes: true })) { const child = path.join(directory, entry.name); if (entry.isDirectory()) walk(child); else if (entry.isFile() && /\.mdx?$/i.test(entry.name)) count += 1; } };
      walk(source);
      return count;
    })() })),
    assignments: locations.assignments,
    links,
    conflicts: links.flatMap((item) => item.conflicts || []),
    providers: Object.values(SHARED_SKILL_PROVIDER_PROFILES).map((profile) => ({
      ...profile,
      globalPreference: providerPreferences.providers[profile.id] || "enabled",
      projectOverride: preferences.providerOverrides.find((item) => item.projectId === connection.projectId && item.provider === profile.id)?.state || "inherit",
      effective: effectiveSkillProviderState(preferences, profile.id, connection.projectId, "project"),
    })),
    pendingImports: preferences.pendingInstructionImports,
  };
}

function assignmentAppliesToProject(assignment, projectId) {
  return assignment.scope === "device" || assignment.scope === "shared" || (assignment.scope === "project" && assignment.projectIds.includes(projectId));
}

function selectedSkillsForLocation(skillNames, include, exclude) {
  const selected = include.includes("*") ? skillNames : skillNames.filter((name) => include.includes(name));
  return selected.filter((name) => !exclude.includes(name));
}

function localOverrideForAssignment(preferences, assignmentId, projectId) {
  return preferences.overrides.find((item) => item.assignmentId === assignmentId && (!item.projectId || item.projectId === projectId)) || null;
}

function effectiveSkillProviderState(preferences, provider, projectId, scope = "project") {
  if (!SHARED_SKILL_PROVIDER_PROFILES[provider]) return { state: "unavailable", source: "provider" };
  const override = scope === "device" ? null : preferences.providerOverrides.find((item) => item.provider === provider && item.projectId === projectId);
  const globalState = sharedSkillProviderPreferences().providers[provider] || "enabled";
  const state = override && override.state !== "inherit" ? override.state : globalState;
  return { state, source: override && override.state !== "inherit" ? "project-override" : "device" };
}

function resolvedSkillLinkPlan(root, connection, repositoryConfig, catalog, currentRoot) {
  const locations = readSharedSkillLocationsFromRoot(currentRoot, repositoryConfig, catalog);
  const preferences = readSkillLocationPreferences(connection.repository);
  const collections = locations.collections.map((collection) => {
    const source = path.join(currentRoot, collection.path);
    return { ...collection, source, skills: skillDirectories(source) };
  });
  const collectionById = new Map(collections.map((collection) => [collection.id, collection]));
  const assignmentById = new Map(locations.assignments.map((assignment) => [assignment.id, assignment]));
  const destinations = [];
  for (const assignment of locations.assignments) {
    if (!assignmentAppliesToProject(assignment, connection.projectId)) continue;
    const collection = collectionById.get(assignment.collectionId);
    if (!collection) continue;
    const override = localOverrideForAssignment(preferences, assignment.id, connection.projectId);
    for (const provider of assignment.providers) {
      const providerPreference = effectiveSkillProviderState(preferences, provider, connection.projectId, assignment.scope);
      const destination = providerSkillDestination(provider, assignment.scope, root);
      if (!destination) {
        destinations.push({ id: `${assignment.id}:${provider}`, assignmentId: assignment.id, collectionId: collection.id, provider, scope: assignment.scope, destination: "", skills: [], status: "provider-unavailable", providerPreference, origin: "shared-assignment", message: `No skill destination is configured for ${provider}` });
        continue;
      }
      const excluded = [...new Set([...assignment.exclude, ...(override?.exclude || [])])];
      const disabled = providerPreference.state === "disabled";
      destinations.push({ id: `${assignment.id}:${provider}`, assignmentId: assignment.id, collectionId: collection.id, provider, scope: assignment.scope, destination, skills: disabled || override?.disabled ? [] : selectedSkillsForLocation(collection.skills, assignment.include, excluded), status: disabled ? "provider-disabled" : override?.disabled ? "local-override" : "pending", providerPreference, origin: "shared-assignment", message: disabled ? `Provider ${provider} is disabled for this project` : override?.disabled ? "Disabled by a local override" : "" });
    }
  }
  for (const mount of preferences.mounts) {
    if (!mount.enabled || (mount.scope === "project" && mount.projectId && mount.projectId !== connection.projectId)) continue;
    const assignment = mount.assignmentId ? assignmentById.get(mount.assignmentId) : null;
    const collection = collectionById.get(assignment?.collectionId || mount.collectionId);
    if (!collection) {
      destinations.push({ ...mount, skills: [], status: "collection-missing", message: `Collection ${mount.collectionId} no longer exists` });
      continue;
    }
    const providerPreference = mount.provider === "custom" ? { state: "enabled", source: "custom" } : effectiveSkillProviderState(preferences, mount.provider, connection.projectId, mount.scope);
    const disabled = providerPreference.state === "disabled";
    destinations.push({ ...mount, collectionId: collection.id, assignmentId: mount.assignmentId || "", skills: disabled ? [] : selectedSkillsForLocation(collection.skills, mount.include, mount.exclude), status: disabled ? "provider-disabled" : "pending", providerPreference, origin: "local-destination", message: disabled ? `Provider ${mount.provider} is disabled for this project` : "" });
  }
  return { locations, preferences, collections, destinations, currentRoot };
}

function reconcileSkillDestination(destinationPlan, collection, managedRoot, previousLinks, desiredOverride = null, ownerBase = null) {
  if (!destinationPlan.destination) return { ...destinationPlan, links: [], status: destinationPlan.status || "provider-unavailable" };
  const destination = path.resolve(destinationPlan.destination);
  const desired = desiredOverride || destinationPlan.skills.map((name) => ({ scope: destinationPlan.scope, provider: destinationPlan.provider, assignmentId: destinationPlan.assignmentId || "", mountId: destinationPlan.assignmentId ? "" : destinationPlan.id, collectionId: collection.id, name, link: path.join(destination, name), target: path.join(collection.source, name), destination }));
  const previous = previousLinks.filter((item) => path.resolve(item.destination || path.dirname(item.link)) === destination);
  const desiredPaths = new Set(desired.map((item) => path.resolve(item.link)));
  const stale = previous.filter((item) => !desiredPaths.has(path.resolve(item.link)));
  const before = new Map();
  const conflicts = [];
  for (const item of [...desired, ...stale]) {
    const link = path.resolve(item.link);
    if (path.dirname(link) !== destination) throw new Error(`Unsafe managed skill link path: ${link}`);
    const state = managedSymlinkTarget(link, managedRoot);
    before.set(link, state);
    const existingOwner = desired.includes(item) ? managedDestinationOwner(link) : null;
    if (desired.includes(item) && existingOwner && ownerBase && existingOwner.repository !== ownerBase.repository) conflicts.push({ skill: item.name, path: link, reason: `Destination is managed by ${existingOwner.repository}`, owner: existingOwner });
    else if (desired.includes(item) && state.exists && (!state.symbolic || !state.managed)) conflicts.push({ skill: item.name, path: link, reason: "Destination already contains an unmanaged skill" });
  }
  if (conflicts.length) return { ...destinationPlan, links: previous, status: "conflict", conflicts, message: `${conflicts.length} unmanaged destination conflict${conflicts.length === 1 ? "" : "s"}` };
  try {
    fs.mkdirSync(destination, { recursive: true });
    for (const item of desired) {
      if (ownerBase) replaceManagedResourceLink(item.link, item.target, { managedRoot, owner: { ...ownerBase, resourceType: "skill", assignmentId: item.assignmentId, provider: item.provider, name: item.name } });
      else replaceSymlink(item.link, item.target, { managedRoot });
    }
    for (const item of stale) {
      const state = managedSymlinkTarget(item.link, managedRoot);
      if (state.symbolic && state.managed) {
        if (ownerBase) removeManagedResourceLink(item.link, { managedRoot, repository: ownerBase.repository, assignmentId: item.assignmentId });
        else fs.unlinkSync(item.link);
      }
    }
  } catch (error) {
    for (const [link, state] of [...before.entries()].reverse()) {
      try {
        const current = managedSymlinkTarget(link, managedRoot);
        if (!state.exists && current.symbolic && current.managed) {
          if (ownerBase) removeManagedResourceLink(link, { managedRoot, repository: ownerBase.repository });
          else fs.unlinkSync(link);
        }
        else if (state.symbolic && state.managed) replaceSymlink(link, state.target, { managedRoot });
      } catch {}
    }
    return { ...destinationPlan, links: previous, status: "error", message: error.message };
  }
  return { ...destinationPlan, links: desired.map((item) => ({ ...item, owner: managedDestinationOwner(item.link) })), status: ["local-override", "provider-disabled"].includes(destinationPlan.status) ? destinationPlan.status : "ready", conflicts: [] };
}

function archiveAcceptedSkillImports(plan, connection, transaction = null) {
  if (!plan.preferences.pendingImports.length) return [];
  const collectionById = new Map(plan.collections.map((collection) => [collection.id, collection]));
  const completed = [];
  const remaining = [];
  for (const pending of plan.preferences.pendingImports) {
    const authority = importTerminalAuthority(plan, connection, pending);
    if (authority.status !== "accepted") {
      if (authority.status !== "rejected") remaining.push(authority.error ? { ...pending, error: authority.error } : pending);
      continue;
    }
    const collection = collectionById.get(pending.collectionId);
    if (!collection || !pending.skills.every((name) => collection.skills.includes(name))) {
      remaining.push(pending);
      continue;
    }
    const backupRoot = path.join(repositoryCacheRoot(connection.repository), "skill-import-backups", `${Date.now()}-${pending.id}`);
    const moved = [];
    try {
      for (const name of pending.skills) {
        const source = path.join(pending.sourceDirectory, name);
        let stats;
        try { stats = fs.lstatSync(source); } catch { continue; }
        if (stats.isSymbolicLink()) continue;
        fs.mkdirSync(backupRoot, { recursive: true });
        const backup = path.join(backupRoot, name);
        transaction?.recordMove(source, backup);
        fs.renameSync(source, backup);
        moved.push({ source, backup });
      }
      completed.push({ ...pending, backupRoot, archived: moved.map((item) => item.backup) });
    } catch (error) {
      for (const item of moved.reverse()) {
        try { fs.renameSync(item.backup, item.source); } catch {}
      }
      remaining.push({ ...pending, error: `Unable to archive imported skills: ${error.message}` });
    }
  }
  plan.preferences.pendingImports = remaining;
  writeSkillLocationPreferences(connection.repository, plan.preferences);
  return completed;
}

function configureProjectRoom(root, connection, repositoryConfig, currentRoot, skillLocations = null, instructionLocations = null) {
  const configPath = path.join(root, ".context-room", "config.json");
  if (!fs.existsSync(configPath)) return { updated: false, reason: "Context Room is not initialized yet" };
  const config = readJson(configPath, {});
  const previousRepository = config.sharedContext?.repository
    ? safeRepository(config.sharedContext.repository)
    : "";
  if (previousRepository) {
    const previousPrefix = homeVirtualPath(path.join(repositoryCacheRoot(previousRepository), "current"), true);
    const keepNonManaged = (value) => !String(value || "").startsWith(previousPrefix);
    config.allowedPaths = (config.allowedPaths || []).filter(keepNonManaged);
    config.readOnlyPaths = (config.readOnlyPaths || []).filter(keepNonManaged);
  }
  const projectRoot = path.join(currentRoot, repositoryConfig.projectsPath, connection.projectId);
  const docs = homeVirtualPath(path.join(projectRoot, "docs"), true);
  const projectSkills = homeVirtualPath(path.join(projectRoot, "skills"), true);
  const globalSkills = homeVirtualPath(path.join(currentRoot, repositoryConfig.globalSkillsPath), true);
  const applicableSkillCollectionIds = new Set((skillLocations?.assignments || [])
    .filter((assignment) => assignmentAppliesToProject(assignment, connection.projectId))
    .map((assignment) => assignment.collectionId));
  const applicableInstructionCollectionIds = new Set((instructionLocations?.assignments || [])
    .filter((assignment) => instructionAssignmentApplies(assignment, connection.projectId))
    .map((assignment) => assignment.collectionId));
  const visibleSkillCollections = (skillLocations?.collections || [])
    .filter((collection) => applicableSkillCollectionIds.has(collection.id));
  const visibleInstructionCollections = (instructionLocations?.collections || [])
    .filter((collection) => applicableInstructionCollectionIds.has(collection.id));
  const collectionPaths = visibleSkillCollections.map((collection) => homeVirtualPath(path.join(currentRoot, collection.path), true));
  const instructionCollectionPaths = visibleInstructionCollections.map((collection) => homeVirtualPath(path.join(currentRoot, collection.path), true));
  config.allowedPaths = appendUnique(config.allowedPaths, [docs, projectSkills, globalSkills, ...collectionPaths, ...instructionCollectionPaths]);
  config.readOnlyPaths = appendUnique(config.readOnlyPaths, [docs, projectSkills, globalSkills, ...collectionPaths, ...instructionCollectionPaths]);
  const section = {
    id: "shared-context",
    title: "Shared context",
    description: `${repositoryConfig.name} accepted main snapshot. Changes must go through proposal branches.`,
    cards: [
      { id: "shared-docs", title: "Shared project docs", path: docs, description: `Accepted documentation for ${connection.projectId}.` },
      { id: "shared-project-skills", title: "Shared project skills", path: projectSkills, description: `Accepted skills for ${connection.projectId}.` },
      { id: "shared-global-skills", title: "Shared global skills", path: globalSkills, description: "Accepted skills shared across projects." },
      ...(skillLocations && !skillLocations.legacy ? visibleSkillCollections.map((collection) => ({ id: `shared-skill-collection-${collection.id}`, title: collection.title, path: homeVirtualPath(path.join(currentRoot, collection.path), true), description: `Accepted shared skill collection · ${collection.id}.` })) : []),
      ...(instructionLocations ? visibleInstructionCollections.map((collection) => ({ id: `shared-instruction-collection-${collection.id}`, title: collection.title, path: homeVirtualPath(path.join(currentRoot, collection.path), true), description: `Accepted shared instruction collection · ${collection.id}.` })) : []),
    ],
  };
  config.hubSections = [...(config.hubSections || []).filter((item) => item?.id !== section.id), section];
  config.sharedContext = { enabled: true, projectId: connection.projectId, repository: connection.repository };
  writeJson(configPath, config);
  return { updated: true, configPath, paths: { docs, projectSkills, globalSkills } };
}

function syncSkillLinks(root, connection, repositoryConfig, currentRoot, catalog, { providers = null, transaction = null } = {}) {
  const plan = resolvedSkillLinkPlan(root, connection, repositoryConfig, catalog, currentRoot);
  const completedImports = archiveAcceptedSkillImports(plan, connection, transaction);
  const managedRoot = repositoryCacheRoot(connection.repository);
  const registryFile = skillLinkRegistryPath(connection.repository, root);
  const previous = readJson(registryFile, { version: 2, links: [], destinations: [] });
  const collectionById = new Map(plan.collections.map((collection) => [collection.id, collection]));
  const providerSet = providers?.length ? new Set(providers.map((provider) => safeId(provider, "provider"))) : null;
  const selectedPhysicalDestinations = new Set(plan.destinations
    .filter((destination) => providerSet?.has(destination.provider) && destination.destination)
    .map((destination) => path.resolve(destination.destination)));
  const selectedDestinations = providerSet
    ? plan.destinations.filter((destination) => providerSet.has(destination.provider) || (destination.destination && selectedPhysicalDestinations.has(path.resolve(destination.destination))))
    : plan.destinations;
  const untouchedDestinations = providerSet
    ? (previous.destinations || []).filter((destination) => !providerSet.has(destination.provider) && (!destination.destination || !selectedPhysicalDestinations.has(path.resolve(destination.destination))))
    : [];
  const noDestination = selectedDestinations.filter((destination) => !destination.destination)
    .map((destination) => reconcileSkillDestination(destination, collectionById.get(destination.collectionId) || { id: destination.collectionId, source: "" }, managedRoot, previous.links || [], null, { repository: connection.repository, revision: path.basename(currentRoot) }));
  const destinationGroups = new Map();
  for (const destination of selectedDestinations.filter((item) => item.destination)) {
    const key = path.resolve(destination.destination);
    destinationGroups.set(key, [...(destinationGroups.get(key) || []), destination]);
  }
  const destinations = [...untouchedDestinations, ...noDestination];
  for (const [physicalDestination, group] of destinationGroups) {
    const desired = group.flatMap((destination) => {
      const collection = collectionById.get(destination.collectionId) || { id: destination.collectionId, source: "" };
      return destination.skills.map((name) => ({ scope: destination.scope, provider: destination.provider, assignmentId: destination.assignmentId || "", mountId: destination.assignmentId ? "" : destination.id, collectionId: collection.id, name, link: path.join(physicalDestination, name), target: path.join(collection.source, name), destination: physicalDestination }));
    });
    const byName = new Map();
    for (const item of desired) byName.set(item.name, [...(byName.get(item.name) || []), item]);
    const explicitConflicts = [...byName.entries()].flatMap(([name, items]) => {
      const targets = [...new Set(items.map((item) => path.resolve(item.target)))];
      return targets.length > 1 ? [{ skill: name, path: path.join(physicalDestination, name), reason: `Several shared collections target the same destination (${items.map((item) => item.collectionId).join(", ")})` }] : [];
    });
    if (explicitConflicts.length) {
      const retained = (previous.links || []).filter((item) => path.resolve(item.destination || path.dirname(item.link)) === physicalDestination);
      for (const destination of group) destinations.push({ ...destination, links: retained.filter((item) => item.assignmentId === (destination.assignmentId || "") && item.mountId === (destination.assignmentId ? "" : destination.id)), status: "conflict", conflicts: explicitConflicts, message: `${explicitConflicts.length} explicit shared skill collision${explicitConflicts.length === 1 ? "" : "s"}` });
      continue;
    }
    const uniqueDesired = [...new Map(desired.map((item) => [path.resolve(item.link), item])).values()];
    const combined = reconcileSkillDestination({ ...group[0], id: `destination:${hashKey(physicalDestination).slice(0, 12)}`, skills: [] }, { id: "combined", source: "" }, managedRoot, previous.links || [], uniqueDesired, { repository: connection.repository, revision: path.basename(currentRoot) });
    for (const destination of group) {
      const ownLinks = (combined.links || []).filter((item) => item.assignmentId === (destination.assignmentId || "") && item.mountId === (destination.assignmentId ? "" : destination.id));
      destinations.push({ ...destination, links: ownLinks, status: ["local-override", "provider-disabled"].includes(destination.status) ? destination.status : combined.status, conflicts: combined.conflicts || [], message: combined.message || destination.message || "" });
    }
  }
  const plannedDestinationPaths = new Set(selectedDestinations.filter((item) => item.destination).map((item) => path.resolve(item.destination)));
  const orphaned = (previous.links || []).filter((item) => (!providerSet || providerSet.has(item.provider)) && !plannedDestinationPaths.has(path.resolve(item.destination || path.dirname(item.link))));
  const blockedProviders = new Set(destinations
    .filter((destination) => ["conflict", "error"].includes(destination.status))
    .map((destination) => destination.provider));
  const retainedOrphaned = orphaned.filter((item) => blockedProviders.has(item.provider));
  for (const item of orphaned.filter((candidate) => !blockedProviders.has(candidate.provider))) {
    const state = managedSymlinkTarget(item.link, managedRoot);
    if (state.symbolic && state.managed) {
      try { removeManagedResourceLink(item.link, { managedRoot, repository: connection.repository, assignmentId: item.assignmentId }); } catch {}
    }
  }
  const links = [...destinations.flatMap((destination) => destination.links || []), ...retainedOrphaned];
  const migrations = [...new Map(orphaned.map((item) => [
    `${item.provider}:${path.resolve(item.destination || path.dirname(item.link))}`,
    {
      provider: item.provider,
      previousDestination: path.resolve(item.destination || path.dirname(item.link)),
      nextDestinations: [...new Set(selectedDestinations.filter((destination) => destination.provider === item.provider && destination.destination).map((destination) => path.resolve(destination.destination)))],
      status: blockedProviders.has(item.provider) ? "blocked" : "migrated",
    },
  ])).values()];
  writeJson(registryFile, { version: 2, repository: connection.repository, projectRoot: stableRoot(root), revision: path.basename(currentRoot), links, destinations });
  return { ...plan, links, destinations, migrations, completedImports };
}

function detachInstalledSkillLinks(root, installed) {
  if (!installed?.repository) return [];
  const repository = safeRepository(installed.repository);
  const managedRoot = repositoryCacheRoot(repository);
  const registry = readJson(skillLinkRegistryPath(repository, root), { links: [] });
  const keepDeviceLinks = installed.projectId && registeredProjectRoots({ repository, projectId: installed.projectId }).some((candidate) => stableRoot(candidate) !== stableRoot(root));
  const removed = [];
  try {
    for (const item of registry.links || []) {
      if (item.scope === "device" && keepDeviceLinks) continue;
      const link = path.resolve(String(item.link || ""));
      const destination = path.resolve(String(item.destination || path.dirname(link)));
      if (path.dirname(link) !== destination) continue;
      const state = managedSymlinkTarget(link, managedRoot);
      if (!state.symbolic || !state.managed) continue;
      const owner = managedDestinationOwner(link);
      const removedLink = removeManagedResourceLink(link, {
        managedRoot,
        repository,
        assignmentId: item.assignmentId || "",
      });
      if (!removedLink) continue;
      removed.push({ link, target: state.target, managedRoot, owner });
    }
  } catch (error) {
    restoreDetachedSkillLinks(removed);
    throw error;
  }
  return removed;
}

function restoreDetachedSkillLinks(links) {
  for (const item of links) {
    try {
      if (item.owner) replaceManagedResourceLink(item.link, item.target, { managedRoot: item.managedRoot, owner: item.owner });
      else replaceSymlink(item.link, item.target, { managedRoot: item.managedRoot });
    } catch {}
  }
}

function registryLinkPaths(registryFile, field) {
  try {
    const registry = readJson(registryFile, { links: [] });
    return (registry.links || []).flatMap((item) => {
      const value = String(item?.[field] || "").trim();
      if (!value) return [];
      const resolved = path.resolve(value);
      return resolved === path.parse(resolved).root ? [] : [resolved];
    });
  } catch {
    return [];
  }
}

function captureSharedReconcileLocation(
  transaction,
  root,
  connection,
  repositoryConfig,
  snapshot,
  catalog,
  { includeDevice = true, providers = null } = {},
) {
  const projectRoot = path.resolve(root);
  const skillRegistry = skillLinkRegistryPath(connection.repository, projectRoot);
  const instructionRegistry = instructionLinkRegistryPath(connection.repository, projectRoot, "project");
  const deviceInstructionRegistry = instructionLinkRegistryPath(connection.repository, projectRoot, "device");
  transaction.capture(path.join(projectRoot, ".context-room", "config.json"));
  transaction.capture(skillLocationPreferencesPath(connection.repository));
  transaction.capture(managedDestinationsRegistryPath());
  transaction.capture(skillRegistry);
  transaction.capture(instructionRegistry);
  if (includeDevice) transaction.capture(deviceInstructionRegistry);

  const skillPlan = resolvedSkillLinkPlan(projectRoot, connection, repositoryConfig, catalog, snapshot);
  const skillPaths = [
    ...skillPlan.destinations.flatMap((destination) => (
      destination.destination
        ? destination.skills.map((name) => path.join(destination.destination, name))
        : []
    )),
    ...registryLinkPaths(skillRegistry, "link"),
  ];
  const instructionPlan = resolvedInstructionLinkPlan(
    projectRoot,
    connection,
    repositoryConfig,
    catalog,
    snapshot,
    { includeDevice, providers },
  );
  const instructionPaths = [
    ...instructionPlan.links.flatMap((item) => item.destination ? [item.destination] : []),
    ...registryLinkPaths(instructionRegistry, "destination"),
    ...(includeDevice ? registryLinkPaths(deviceInstructionRegistry, "destination") : []),
  ];
  for (const candidate of [...new Set([...skillPaths, ...instructionPaths].map((item) => path.resolve(item)))]) {
    transaction.capture(candidate);
  }
  return { skillPlan, instructionPlan };
}

function sharedBindingForRoot(root, connection, registry) {
  const source = sourceIdentity(root);
  const candidates = (registry.bindings || []).filter((binding) => {
    try {
      if (!sameSharedRepository(binding.repository, connection.repository) || String(binding.projectId || "") !== connection.projectId) return false;
      if (source) return bindingMatchesSource(binding, source);
      if (!binding.sourceRoot) return false;
      const bindingRoot = stableRoot(binding.sourceRoot);
      const selectedRoot = stableRoot(root);
      return selectedRoot === bindingRoot || selectedRoot.startsWith(bindingRoot + path.sep);
    } catch {
      return false;
    }
  });
  candidates.sort((left, right) => String(right.sourceSubpath || right.sourceRoot || "").length - String(left.sourceSubpath || left.sourceRoot || "").length);
  return candidates[0] || null;
}

function detachManagedRegistryLinks(registryFile, {
  repository,
  managedRoot,
  pathKey,
  keep = () => false,
  dropStaleOwned = false,
  protectedRoots = [],
} = {}) {
  const registry = readJson(registryFile, { version: 1, links: [] });
  const detached = [];
  const retained = [];
  for (const item of registry.links || []) {
    if (keep(item)) {
      retained.push(item);
      continue;
    }
    const link = path.resolve(String(item[pathKey] || ""));
    if (!item[pathKey] || link === path.parse(link).root) {
      retained.push(item);
      continue;
    }
    const owner = managedDestinationOwner(link);
    const protectedProjectPath = (Array.isArray(protectedRoots) ? protectedRoots : []).some((root) => {
      const protectedRoot = path.resolve(root);
      return link === protectedRoot || link.startsWith(protectedRoot + path.sep);
    });
    if (protectedProjectPath) {
      if (owner) {
        let ownedByRepository = false;
        try { ownedByRepository = sameSharedRepository(owner.repository, repository); } catch {}
        if (ownedByRepository) recordManagedDestination(link, null);
      }
      if (!dropStaleOwned) retained.push(item);
      continue;
    }
    const state = managedSymlinkTarget(link, managedRoot);
    if (!state.symbolic || !state.managed || !owner || !sameSharedRepository(owner.repository, repository)) {
      if (dropStaleOwned && owner) {
        let ownedByRepository = false;
        try { ownedByRepository = sameSharedRepository(owner.repository, repository); } catch {}
        if (ownedByRepository) {
          recordManagedDestination(link, null);
          continue;
        }
      }
      retained.push(item);
      continue;
    }
    const removed = removeManagedResourceLink(link, {
      managedRoot,
      repository,
      assignmentId: item.assignmentId || "",
    });
    if (removed) detached.push({ link, target: state.target, managedRoot, owner });
    else retained.push(item);
  }
  writePrivateJson(registryFile, {
    ...registry,
    revision: "",
    links: retained,
    destinations: (registry.destinations || []).filter((item) => keep(item)),
  });
  return detached;
}

function captureDisconnectManagedLinks(transaction, registryFile, {
  repository,
  managedRoot,
  pathKey,
  keep = () => false,
  protectedRoots = [],
} = {}) {
  const registry = readJson(registryFile, { version: 1, links: [] });
  for (const item of registry.links || []) {
    if (keep(item)) continue;
    const value = String(item?.[pathKey] || "").trim();
    if (!value) continue;
    const link = path.resolve(value);
    if (link === path.parse(link).root) continue;
    if ((Array.isArray(protectedRoots) ? protectedRoots : []).some((root) => {
      const protectedRoot = path.resolve(root);
      return link === protectedRoot || link.startsWith(protectedRoot + path.sep);
    })) continue;
    const state = managedSymlinkTarget(link, managedRoot);
    const owner = managedDestinationOwner(link);
    if (!state.symbolic || !state.managed || !owner || !sameSharedRepository(owner.repository, repository)) continue;
    transaction.capture(link);
  }
}

function removeSharedContextFromProjectConfig(root, connection) {
  const configPath = path.join(root, ".context-room", "config.json");
  if (!fs.existsSync(configPath)) return null;
  const previous = fs.readFileSync(configPath, "utf8");
  const config = JSON.parse(previous);
  let configuredRepository = "";
  try { configuredRepository = config.sharedContext?.repository ? safeRepository(config.sharedContext.repository) : ""; }
  catch { return { configPath, previous, changed: false }; }
  if (!config.sharedContext || !sameSharedRepository(configuredRepository, connection.repository) || String(config.sharedContext.projectId || "") !== connection.projectId) return { configPath, previous, changed: false };
  const managedPrefix = homeVirtualPath(path.join(repositoryCacheRoot(connection.repository), "current"), true);
  const keepUnmanaged = (value) => !String(value || "").startsWith(managedPrefix);
  config.allowedPaths = (config.allowedPaths || []).filter(keepUnmanaged);
  config.readOnlyPaths = (config.readOnlyPaths || []).filter(keepUnmanaged);
  config.hubSections = (config.hubSections || []).filter((section) => section?.id !== "shared-context");
  delete config.sharedContext;
  writeJson(configPath, config);
  return { configPath, previous, changed: true };
}

function disconnectSharedContextUnderLock(root, {
  projectRoots: requestedProjectRoots = [],
  projectCapabilities = [],
} = {}) {
  const exactCapabilities = Array.isArray(projectCapabilities)
    ? projectCapabilities.map((capability) => normalizedSharedProjectCapability(capability))
    : [];
  if (exactCapabilities.some((capability) => !capability)) {
    throw sharedContextError("shared-project-capability-invalid", "Shared disconnection project capabilities are invalid");
  }
  for (const capability of exactCapabilities) assertSharedProjectCapability(capability, "Shared disconnection project");
  const resolvedRoot = exactCapabilities.length ? path.resolve(root) : stableRoot(root);
  const connection = readSharedProjectConnection(resolvedRoot);
  if (!connection) return { disconnected: false, reason: "not-connected" };
  const registry = readJson(registryPath(), { version: 1, bindings: [] });
  const exactRequestedRoots = [...new Set([
    resolvedRoot,
    ...(exactCapabilities.length
      ? exactCapabilities.map((capability) => capability.root)
      : (Array.isArray(requestedProjectRoots) ? requestedProjectRoots : [])),
  ].map((candidate) => exactCapabilities.length ? path.resolve(candidate) : stableRoot(candidate)))];
  if (exactRequestedRoots.length > 1_024) throw new Error("Too many project roots were requested for one Shared disconnection");
  if (exactCapabilities.length && (
    exactCapabilities.length !== exactRequestedRoots.length
    || !exactRequestedRoots.every((candidate) => exactCapabilities.some((capability) => capability.root === candidate))
  )) throw sharedContextError("shared-project-capability-mismatch", "Shared disconnection roots do not match the exact Context Hub project group");
  const capabilityByRoot = new Map(exactCapabilities.map((capability) => [capability.root, capability]));
  const bindings = exactRequestedRoots.map((projectRoot) => {
    const capability = capabilityByRoot.get(projectRoot);
    if (capability) assertSharedProjectCapability(capability, "Shared disconnection project");
    const candidateConnection = readSharedProjectConnection(projectRoot);
    if (!candidateConnection
      || !sameSharedRepository(candidateConnection.repository, connection.repository)
      || candidateConnection.projectId !== connection.projectId) {
      throw new Error(`The requested worktree no longer has the exact Shared binding: ${projectRoot}`);
    }
    const candidate = sharedBindingForRoot(projectRoot, connection, registry);
    if (!candidate) throw new Error(`The requested worktree Shared binding is no longer registered: ${projectRoot}`);
    return candidate;
  });
  const removedBindings = new Set(bindings);
  const binding = bindings[0];
  const remainingBindings = (registry.bindings || [])
    .filter((candidate) => !removedBindings.has(candidate))
    .map((candidate) => sameSharedRepository(candidate?.repository, connection.repository)
      ? { ...candidate, repository: connection.repository }
      : candidate);
  const keepRepositoryDeviceLinks = remainingBindings.some((candidate) => {
    return sameSharedRepository(candidate.repository, connection.repository);
  });
  const projectRoots = [...new Set([
    ...exactRequestedRoots,
    ...bindings.flatMap((candidate) => [...(candidate.projectRoots || []), candidate.sourceRoot]),
    connection.projectRoot,
  ].filter(Boolean).map(stableRoot))];
  if (exactCapabilities.length && projectRoots.some((projectRoot) => !capabilityByRoot.has(path.resolve(projectRoot)))) {
    throw sharedContextError("shared-project-capability-mismatch", "The Shared binding owns a root outside the exact Context Hub project group");
  }
  const managedRoot = repositoryCacheRoot(connection.repository);
  const deviceInstructionRegistry = instructionLinkRegistryPath(connection.repository, resolvedRoot, "device");
  const transactionPaths = new Set([
    registryPath(),
    managedDestinationsRegistryPath(),
    ...projectRoots.flatMap((projectRoot) => [
      skillLinkRegistryPath(connection.repository, projectRoot),
      instructionLinkRegistryPath(connection.repository, projectRoot, "project"),
      path.join(projectRoot, ".context-room", "config.json"),
    ]),
    ...(!keepRepositoryDeviceLinks ? [deviceInstructionRegistry] : []),
  ]);
  const transaction = createSharedMutationTransaction("Shared Context disconnect");
  for (const capability of exactCapabilities) assertSharedProjectCapability(capability, "Shared disconnection project");
  for (const filePath of transactionPaths) transaction.capture(filePath);
  for (const projectRoot of projectRoots) {
    const capability = capabilityByRoot.get(path.resolve(projectRoot));
    if (capability) assertSharedProjectCapability(capability, "Shared disconnection project");
    captureDisconnectManagedLinks(transaction, skillLinkRegistryPath(connection.repository, projectRoot), {
      repository: connection.repository,
      managedRoot,
      pathKey: "link",
      keep: (item) => item.scope === "device" && keepRepositoryDeviceLinks,
    });
    captureDisconnectManagedLinks(transaction, instructionLinkRegistryPath(connection.repository, projectRoot, "project"), {
      repository: connection.repository,
      managedRoot,
      pathKey: "destination",
    });
  }
  if (!keepRepositoryDeviceLinks) {
    captureDisconnectManagedLinks(transaction, deviceInstructionRegistry, {
      repository: connection.repository,
      managedRoot,
      pathKey: "destination",
    });
  }
  for (const capability of exactCapabilities) assertSharedProjectCapability(capability, "Shared disconnection project");
  const journalCapabilities = projectRoots.map((projectRoot) => (
    capabilityByRoot.get(path.resolve(projectRoot)) || currentSharedProjectCapability(projectRoot)
  ));
  const journalPath = writeSharedDisconnectJournal(connection.repository, binding, projectRoots, transaction, resolvedRoot, {
    projectCapabilities: journalCapabilities,
  });
  const detached = [];
  try {
    for (const projectRoot of projectRoots) {
      const capability = capabilityByRoot.get(path.resolve(projectRoot));
      if (capability) assertSharedProjectCapability(capability, "Shared disconnection project");
      const skillRegistry = skillLinkRegistryPath(connection.repository, projectRoot);
      detached.push(...detachManagedRegistryLinks(skillRegistry, {
        repository: connection.repository,
        managedRoot,
        pathKey: "link",
        keep: (item) => item.scope === "device" && keepRepositoryDeviceLinks,
      }));
      if (capability) assertSharedProjectCapability(capability, "Shared disconnection project");
      const instructionRegistry = instructionLinkRegistryPath(connection.repository, projectRoot, "project");
      detached.push(...detachManagedRegistryLinks(instructionRegistry, {
        repository: connection.repository,
        managedRoot,
        pathKey: "destination",
      }));
      if (capability) assertSharedProjectCapability(capability, "Shared disconnection project");
      removeSharedContextFromProjectConfig(projectRoot, connection);
    }
    if (!keepRepositoryDeviceLinks) {
      detached.push(...detachManagedRegistryLinks(deviceInstructionRegistry, {
        repository: connection.repository,
        managedRoot,
        pathKey: "destination",
      }));
    }
    for (const capability of exactCapabilities) assertSharedProjectCapability(capability, "Shared disconnection project");
    writeSharedRegistry({ ...registry, bindings: remainingBindings });
    for (const capability of exactCapabilities) assertSharedProjectCapability(capability, "Shared disconnection project");
    removeSharedDisconnectJournal(journalPath);
    return {
      disconnected: true,
      connection,
      projectRoots,
      removedManagedLinks: detached.length,
    };
  } catch (error) {
    if (!exactCapabilities.length) restoreDetachedSkillLinks(detached);
    try {
      transaction.rollback({ projectCapabilities: exactCapabilities });
      removeSharedDisconnectJournal(journalPath);
    } catch (rollbackError) {
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
}

export function disconnectSharedContext(root, options = {}) {
  return withSharedRegistryLock(() => disconnectSharedContextUnderLock(root, options));
}

export function removeOrphanedSharedContextBindings({
  repository,
  projectId,
  projectRoots = [],
} = {}) {
  const exactProjectId = safeId(projectId, "projectId");
  const expectedRoots = Array.isArray(projectRoots) ? projectRoots.map((entry) => {
    const root = path.resolve(String(entry?.root || ""));
    const dev = String(entry?.rootIdentity?.dev || "");
    const ino = String(entry?.rootIdentity?.ino || "");
    const worktreeIdentity = entry?.worktreeIdentity ? normalizedSharedWorktreeIdentity(entry.worktreeIdentity) : null;
    if (root === path.parse(root).root || !/^\d+$/.test(dev) || !/^\d+$/.test(ino)) {
      throw sharedContextError("shared-orphan-identity-required", "Exact lost project root identities are required to remove an orphaned Shared binding");
    }
    if (entry?.worktreeIdentity && !worktreeIdentity) {
      throw sharedContextError("shared-orphan-identity-required", "Lost project worktree identities must be exact and anchored");
    }
    return { root, rootIdentity: { dev, ino }, ...(worktreeIdentity ? { worktreeIdentity } : {}) };
  }) : [];
  if (!expectedRoots.length || expectedRoots.length > 1_024) {
    throw sharedContextError("shared-orphan-identity-required", "One bounded project root group is required to remove an orphaned Shared binding");
  }
  if (new Set(expectedRoots.map((entry) => entry.root)).size !== expectedRoots.length) {
    throw sharedContextError("shared-orphan-identity-required", "Orphaned Shared binding roots must be unique");
  }
  return withSharedRegistryLock(() => {
    for (const expected of expectedRoots) {
      try {
        const current = sharedProjectRootIdentity(expected.root);
        if (current.dev === expected.rootIdentity.dev && current.ino === expected.rootIdentity.ino) {
          const error = sharedContextError("shared-orphan-root-still-present", "The original project root still exists; use the normal Shared disconnect action");
          error.statusCode = 409;
          throw error;
        }
      } catch (error) {
        if (error?.code === "shared-orphan-root-still-present") throw error;
      }
    }
    const registry = readJson(registryPath(), { version: 1, bindings: [] });
    const safeRemote = registeredRepositoryTransport(repository, registry);
    const expectedRootSet = new Set(expectedRoots.map((entry) => entry.root));
    const matchingBindings = (registry.bindings || []).filter((binding) => (
      sameSharedRepository(binding?.repository, safeRemote)
      && String(binding?.projectId || "") === exactProjectId
    ));
    const selectedBindings = matchingBindings.filter((binding) => (
      [...(binding.projectRoots || []), binding.sourceRoot]
        .filter(Boolean)
        .some((root) => expectedRootSet.has(path.resolve(String(root))))
    ));
    for (const binding of selectedBindings) {
      const bindingRoots = [...new Set([...(binding.projectRoots || []), binding.sourceRoot]
        .filter(Boolean)
        .map((root) => path.resolve(String(root))))];
      if (bindingRoots.some((root) => !expectedRootSet.has(root))) {
        const error = sharedContextError(
          "shared-orphan-binding-scope-conflict",
          "The orphaned Shared binding also owns another project root and cannot be removed from this recovery action",
        );
        error.statusCode = 409;
        throw error;
      }
    }
    if (!selectedBindings.length) return { removed: false, removedBindings: 0, projectRoots: expectedRoots.map((entry) => entry.root), removedManagedLinks: 0 };
    const selected = new Set(selectedBindings);
    const remainingBindings = (registry.bindings || []).filter((binding) => !selected.has(binding));
    const keepRepositoryDeviceLinks = remainingBindings.some((binding) => {
      try { return sameSharedRepository(binding?.repository, safeRemote); } catch { return false; }
    });
    const orphanRoots = expectedRoots.map((entry) => entry.root);
    const managedRoot = repositoryCacheRoot(safeRemote);
    const skillRegistries = orphanRoots.map((projectRoot) => skillLinkRegistryPath(safeRemote, projectRoot));
    const instructionRegistries = orphanRoots.map((projectRoot) => instructionLinkRegistryPath(safeRemote, projectRoot, "project"));
    const deviceInstructionRegistries = keepRepositoryDeviceLinks
      ? []
      : [...new Set(orphanRoots.map((projectRoot) => instructionLinkRegistryPath(safeRemote, projectRoot, "device")))];
    const transaction = createSharedMutationTransaction("orphaned Shared Context cleanup");
    for (const filePath of [
      registryPath(),
      managedDestinationsRegistryPath(),
      ...skillRegistries,
      ...instructionRegistries,
      ...deviceInstructionRegistries,
    ]) transaction.capture(filePath);
    for (const registryFile of skillRegistries) {
      captureDisconnectManagedLinks(transaction, registryFile, {
        repository: safeRemote,
        managedRoot,
        pathKey: "link",
        keep: (item) => item.scope === "device" && keepRepositoryDeviceLinks,
        protectedRoots: orphanRoots,
      });
    }
    for (const registryFile of instructionRegistries) {
      captureDisconnectManagedLinks(transaction, registryFile, {
        repository: safeRemote,
        managedRoot,
        pathKey: "destination",
        protectedRoots: orphanRoots,
      });
    }
    for (const registryFile of deviceInstructionRegistries) {
      captureDisconnectManagedLinks(transaction, registryFile, {
        repository: safeRemote,
        managedRoot,
        pathKey: "destination",
        protectedRoots: orphanRoots,
      });
    }
    const journalPath = writeSharedDisconnectJournal(
      safeRemote,
      selectedBindings[0],
      orphanRoots,
      transaction,
      orphanRoots[0],
      {
        projectCapabilities: orphanRoots.map((projectRoot) => {
          const expected = expectedRoots.find((entry) => entry.root === projectRoot);
          const stored = selectedBindings
            .map((binding) => bindingProjectCapability(binding, projectRoot))
            .find(Boolean);
          if (stored && (
            stored.rootIdentity.dev !== expected.rootIdentity.dev
            || stored.rootIdentity.ino !== expected.rootIdentity.ino
          )) {
            throw sharedContextError("shared-orphan-binding-scope-conflict", "The orphaned Shared binding capability does not match the exact lost root identity");
          }
          return stored || {
            root: projectRoot,
            rootIdentity: expected.rootIdentity,
            worktreeIdentity: expected.worktreeIdentity || { kind: "path" },
          };
        }),
      },
    );
    let removedManagedLinks = 0;
    try {
      for (const registryFile of skillRegistries) {
        removedManagedLinks += detachManagedRegistryLinks(registryFile, {
          repository: safeRemote,
          managedRoot,
          pathKey: "link",
          keep: (item) => item.scope === "device" && keepRepositoryDeviceLinks,
          dropStaleOwned: true,
          protectedRoots: orphanRoots,
        }).length;
      }
      for (const registryFile of instructionRegistries) {
        removedManagedLinks += detachManagedRegistryLinks(registryFile, {
          repository: safeRemote,
          managedRoot,
          pathKey: "destination",
          dropStaleOwned: true,
          protectedRoots: orphanRoots,
        }).length;
      }
      for (const registryFile of deviceInstructionRegistries) {
        removedManagedLinks += detachManagedRegistryLinks(registryFile, {
          repository: safeRemote,
          managedRoot,
          pathKey: "destination",
          dropStaleOwned: true,
          protectedRoots: orphanRoots,
        }).length;
      }
      writeSharedRegistry({ ...registry, bindings: remainingBindings });
      removeSharedDisconnectJournal(journalPath);
      return {
        removed: true,
        removedBindings: selectedBindings.length,
        projectRoots: orphanRoots,
        removedManagedLinks,
      };
    } catch (error) {
      try {
        transaction.rollback();
        removeSharedDisconnectJournal(journalPath);
      } catch (rollbackError) {
        rollbackError.cause = error;
        throw rollbackError;
      }
      throw error;
    }
  });
}

export function initializeSharedRepository(root, options = {}) {
  const resolvedRoot = path.resolve(root);
  fs.mkdirSync(resolvedRoot, { recursive: true });
  const configPath = path.join(resolvedRoot, SHARED_REPOSITORY_CONFIG);
  if (fs.existsSync(configPath)) return { configPath, config: readSharedRepositoryConfig(resolvedRoot), created: false };
  const config = normalizedRepositoryConfig({ ...DEFAULT_REPOSITORY_CONFIG, ...options });
  writeJson(configPath, { $schema: SHARED_REPOSITORY_SCHEMA_URL, ...config });
  fs.mkdirSync(path.join(resolvedRoot, config.globalSkillsPath), { recursive: true });
  const globalKeep = path.join(resolvedRoot, config.globalSkillsPath, ".gitkeep");
  if (!fs.existsSync(globalKeep)) fs.writeFileSync(globalKeep, "", "utf8");
  fs.mkdirSync(path.join(resolvedRoot, config.projectsPath), { recursive: true });
  if (!fs.existsSync(path.join(resolvedRoot, config.projectsFile))) {
    writeJson(path.join(resolvedRoot, config.projectsFile), { $schema: SHARED_PROJECTS_SCHEMA_URL, version: 1, projects: [] });
  }
  return { configPath, config, created: true };
}

export function readSharedRepositoryConfig(root) {
  const configPath = path.join(path.resolve(root), SHARED_REPOSITORY_CONFIG);
  const raw = readJson(configPath);
  if (!raw) throw new Error(`Missing ${SHARED_REPOSITORY_CONFIG}`);
  return normalizedRepositoryConfig(raw);
}

export function readSharedProjectConnection(root) {
  return resolveRegisteredConnection(root);
}

export function connectSharedContext(root, {
  repository,
  projectId,
  sync = true,
  connectionReceiptId = "",
  projectRoots = [],
  projectCapabilities = [],
} = {}) {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot) || !fs.statSync(resolvedRoot).isDirectory()) throw new Error(`Project root does not exist: ${resolvedRoot}`);
  return withSharedRegistryLock(({ assertHeld }) => {
    const previousRegistry = readJson(registryPath(), { version: 1, bindings: [] });
    const safeRemote = registeredRepositoryTransport(repository, previousRegistry);
    const detected = detectSharedProject(resolvedRoot, { repository: safeRemote, projectId });
    const bindingRoot = detected.projectRoot;
    const connection = { version: 1, repository: safeRemote, projectId: detected.projectId, projectRoot: bindingRoot };
    const exactCapabilities = Array.isArray(projectCapabilities)
      ? projectCapabilities.map((capability) => normalizedSharedProjectCapability(capability))
      : [];
    if (exactCapabilities.some((capability) => !capability)) {
      throw sharedContextError("shared-project-capability-invalid", "Shared connection project capabilities are invalid");
    }
    if (connectionReceiptId && !exactCapabilities.length) {
      throw sharedContextError("shared-project-capability-required", "Context Hub Shared connections require exact project capabilities");
    }
    const capabilityRoots = exactCapabilities.map((capability) => capability.root);
    const requestedRoots = [...new Set([
      bindingRoot,
      ...(capabilityRoots.length ? capabilityRoots : (Array.isArray(projectRoots) ? projectRoots : [])),
    ].map((candidate) => path.resolve(candidate)))];
    if (requestedRoots.length > 1_024) throw new Error("Too many project roots were requested for one Shared connection");
    if (exactCapabilities.length && (
      exactCapabilities.length !== requestedRoots.length
      || !requestedRoots.every((candidate) => exactCapabilities.some((capability) => capability.root === candidate))
    )) {
      throw sharedContextError("shared-project-capability-mismatch", "Shared connection roots do not match the exact Context Hub project group");
    }
    const capabilityByRoot = new Map(exactCapabilities.map((capability) => [capability.root, capability]));
    try {
      for (const candidate of requestedRoots) {
        const capability = capabilityByRoot.get(candidate);
        if (capability) assertSharedProjectCapability(capability, "Shared connection project");
        else if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) throw new Error(`Project root does not exist: ${candidate}`);
        const candidateProject = detectSharedProject(candidate, { repository: safeRemote, projectId: detected.projectId });
        if (path.resolve(candidateProject.projectRoot) !== candidate || candidateProject.projectId !== detected.projectId) {
          throw new Error(`Shared project ${detected.projectId} does not resolve to the requested project root: ${candidate}`);
        }
        if (capability) assertSharedProjectCapability(capability, "Shared connection project");
        registerSourceBindingUnderLock(candidate, { ...connection, projectRoot: candidate }, { projectCapability: capability });
      }
      for (const capability of exactCapabilities) assertSharedProjectCapability(capability, "Shared connection project");
      if (!sync) return { connection, connected: true };
      return syncSharedContextInternal(bindingRoot, {
        connectionReceiptId,
        connectionReceiptRoots: requestedRoots,
        projectCapabilities: exactCapabilities,
      }, { registryLockHeld: true });
    } catch (error) {
      assertHeld();
      writeSharedRegistry(previousRegistry);
      throw error;
    }
  });
}

function syncSharedContextInternal(root, options = {}, { registryLockHeld = false, repositoryLockHeld = false } = {}) {
  const {
    allowOffline = true,
    forceReconcile = false,
    providers = null,
    connectionReceiptId = "",
    connectionReceiptRoots = [],
    projectCapabilities = [],
    timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  } = options;
  const resolvedRoot = path.resolve(root);
  const connection = readSharedProjectConnection(resolvedRoot);
  if (!connection) throw new Error("This project has no approved shared-context binding; run context-room shared setup first");
  authenticatedSharedGit(connection.repository, options.push, timeoutMs);
  const localProjectRoot = connection.projectRoot || resolvedRoot;
  const exactProjectCapabilities = Array.isArray(projectCapabilities)
    ? projectCapabilities.map((capability) => normalizedSharedProjectCapability(capability))
    : [];
  if (exactProjectCapabilities.some((capability) => !capability)) {
    throw sharedContextError("shared-project-capability-invalid", "Shared synchronization project capabilities are invalid");
  }
  const capabilityByRoot = new Map(exactProjectCapabilities.map((capability) => [capability.root, capability]));
  const localCapability = capabilityByRoot.get(path.resolve(localProjectRoot));
  if (connectionReceiptId && (!localCapability || exactProjectCapabilities.length !== new Set(connectionReceiptRoots.map((candidate) => path.resolve(candidate))).size)) {
    throw sharedContextError("shared-project-capability-mismatch", "Shared synchronization roots do not match the exact Context Hub project group");
  }
  if (localCapability) assertSharedProjectCapability(localCapability, "Shared synchronization project");
  if (registryLockHeld) registerSourceBindingUnderLock(localProjectRoot, { ...connection, projectRoot: localProjectRoot }, { projectCapability: localCapability });
  else registerSourceBinding(localProjectRoot, { ...connection, projectRoot: localProjectRoot });
  const operation = () => {
  const budget = sharedGitNetworkBudget(timeoutMs);
  const cloneAuth = authenticatedSharedGit(connection.repository, options.push, remainingSharedGitNetworkTimeout(budget, "Git clone"));
  const checkout = ensureRepositoryCloneUnderLock(connection.repository, {
    timeoutMs: remainingSharedGitNetworkTimeout(budget, "Git clone"),
    timeoutBudgetMs: budget.timeoutMs,
    credential: cloneAuth?.credential || null,
    remote: cloneAuth?.remote || connection.repository,
  });
  let fetchError = "";
  try {
    const fetchAuth = authenticatedSharedGit(connection.repository, options.push, remainingSharedGitNetworkTimeout(budget, "Git fetch"));
    runSharedNetworkGit(checkout, fetchAuth
      ? ["fetch", "--force", "--prune", "--no-tags", fetchAuth.remote, "+refs/heads/*:refs/remotes/origin/*"]
      : ["fetch", "--prune", "origin"], {
      stdio: ["ignore", "ignore", "pipe"],
      ...(fetchAuth ? { credential: fetchAuth.credential } : {}),
      operation: "Git fetch",
      timeoutMs: remainingSharedGitNetworkTimeout(budget, "Git fetch"),
      timeoutBudgetMs: budget.timeoutMs,
    });
  } catch (error) {
    fetchError = String(error.stderr || error.message || error).trim();
    if (String(error?.code || "").startsWith("github-app-")) throw error;
    if (!allowOffline) {
      if (error?.code === "shared-git-timeout") throw error;
      throw new Error(`Unable to refresh shared context: ${fetchError}`);
    }
  }
  const state = readJson(sharedStatePath(connection.repository), {});
  const previousRevision = state.revision ? safeRevision(state.revision, "previous shared revision") : "";
  let repositoryConfig;
  let revision;
  let catalog;
  try {
    const descriptor = readRemoteSharedDescriptor(checkout, state.defaultBranch || "");
    ({ revision, config: repositoryConfig, catalog } = descriptor);
  } catch (error) {
    if (!fetchError || !state.revision) throw error;
    revision = safeRevision(state.revision, "cached shared revision");
    if (!gitObjectExists(checkout, `${revision}^{commit}`)) throw error;
    const descriptor = readSharedDescriptorAtRevision(checkout, revision);
    ({ config: repositoryConfig, catalog } = descriptor);
    const cachedRemoteRef = `refs/remotes/origin/${repositoryConfig.defaultBranch}`;
    if (!gitObjectExists(checkout, `${cachedRemoteRef}^{commit}`)
      || !gitIsAncestor(checkout, revision, cachedRemoteRef)) {
      throw sharedContextError("shared-cache-unverified", "Cached Shared state is not reachable from its repository origin", {
        repository: connection.repository,
        revision,
        defaultBranch: repositoryConfig.defaultBranch,
      });
    }
  }
  assertSafeTreeEntries(checkout, revision, []);
  const cacheRoot = repositoryCacheRoot(connection.repository);
  const snapshot = path.join(cacheRoot, "snapshots", revision);
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  materializeSnapshot(checkout, revision, snapshot);
  repositoryConfig = readSharedRepositoryConfig(snapshot);
  catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
  if (!catalog.projects.some((project) => project.id === connection.projectId)) {
    throw new Error(`Shared project is not registered in ${repositoryConfig.projectsFile}: ${connection.projectId}`);
  }
  const sharedProjectRoot = path.join(snapshot, repositoryConfig.projectsPath, connection.projectId);
  if (!fs.existsSync(sharedProjectRoot) || !fs.statSync(sharedProjectRoot).isDirectory()) {
    throw new Error(`Shared project does not exist in origin/${repositoryConfig.defaultBranch}: ${connection.projectId}`);
  }
  for (const capability of exactProjectCapabilities) assertSharedProjectCapability(capability, "Shared synchronization project");
  const current = path.join(cacheRoot, "current");
  const configPath = path.join(localProjectRoot, ".context-room", "config.json");
  const previousConfig = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : null;
  let installedSharedContext = null;
  if (previousConfig !== null) {
    try { installedSharedContext = JSON.parse(previousConfig).sharedContext || null; } catch {}
  }
  const switchingSharedContext = installedSharedContext?.repository && (
    !sameSharedRepository(installedSharedContext.repository, connection.repository)
    || installedSharedContext.projectId !== connection.projectId
  );
  let detachedSkillLinks = [];
  let links;
  let instructionLinks;
  let room;
  const completedConnectionRoots = new Set();
  const revisionChanged = previousRevision !== revision;
  const { skillLocations, instructionLocations } = readValidatedSharedLocationsFromRoot(snapshot, repositoryConfig, catalog);
  const transaction = createSharedMutationTransaction("Shared Context sync");
  transaction.capture(current);
  transaction.capture(sharedStatePath(connection.repository));
  const exactConnectionReceiptRoots = connectionReceiptId
    ? [...new Set((Array.isArray(connectionReceiptRoots) && connectionReceiptRoots.length
      ? connectionReceiptRoots
      : [localProjectRoot]).map((candidate) => path.resolve(candidate)))]
    : [];
  for (const receiptRoot of exactConnectionReceiptRoots) {
    const capability = capabilityByRoot.get(receiptRoot);
    if (connectionReceiptId && !capability) throw sharedContextError("shared-project-capability-mismatch", "Shared receipt root is outside the exact Context Hub project group");
    if (capability) assertSharedProjectCapability(capability, "Shared receipt project");
    transaction.capture(sharedConnectionReceiptPath(connection.repository, receiptRoot));
  }
  if (localCapability) assertSharedProjectCapability(localCapability, "Shared synchronization project");
  captureSharedReconcileLocation(
    transaction,
    localProjectRoot,
    connection,
    repositoryConfig,
    snapshot,
    catalog,
    { includeDevice: true, providers },
  );
  const reconcileLocation = (locationRoot, locationConnection, reconcileTransaction) => {
    const registryFile = skillLinkRegistryPath(connection.repository, locationRoot);
    const existing = readJson(registryFile, null);
    if (!forceReconcile && !revisionChanged && existing?.revision === revision) {
      const plan = resolvedSkillLinkPlan(locationRoot, locationConnection, repositoryConfig, catalog, snapshot);
      return { ...plan, links: existing.links || [], destinations: existing.destinations || [], migrations: [], completedImports: [], skipped: true };
    }
    return syncSkillLinks(locationRoot, locationConnection, repositoryConfig, snapshot, catalog, { providers, transaction: reconcileTransaction });
  };
  try {
    if (localCapability) assertSharedProjectCapability(localCapability, "Shared synchronization project");
    if (switchingSharedContext) detachedSkillLinks = detachInstalledSkillLinks(localProjectRoot, installedSharedContext);
    if (localCapability) assertSharedProjectCapability(localCapability, "Shared synchronization project");
    replaceSymlink(current, snapshot, { managedRoot: cacheRoot });
    if (localCapability) assertSharedProjectCapability(localCapability, "Shared synchronization project");
    room = configureProjectRoom(localProjectRoot, connection, repositoryConfig, current, skillLocations, instructionLocations);
    if (localCapability) assertSharedProjectCapability(localCapability, "Shared synchronization project");
    links = reconcileLocation(localProjectRoot, connection, transaction);
    if (localCapability) assertSharedProjectCapability(localCapability, "Shared synchronization project");
    instructionLinks = reconcileInstructionLinks(localProjectRoot, connection, repositoryConfig, snapshot, catalog, { includeDevice: true, providers, transaction });
    completedConnectionRoots.add(path.resolve(localProjectRoot));
    for (const location of registeredRepositoryProjectLocations(connection.repository)) {
      if (location.projectId === connection.projectId && stableRoot(location.root) === stableRoot(localProjectRoot)) continue;
      const locationRoot = path.resolve(location.root);
      const locationCapability = capabilityByRoot.get(locationRoot);
      if (connectionReceiptId && !locationCapability) continue;
      const locationConnection = { ...connection, projectId: location.projectId, projectRoot: location.root };
      const locationTransaction = createSharedMutationTransaction(`Shared Context worktree ${location.root}`);
      try {
        if (locationCapability) assertSharedProjectCapability(locationCapability, "Shared synchronization worktree");
        captureSharedReconcileLocation(
          locationTransaction,
          location.root,
          locationConnection,
          repositoryConfig,
          snapshot,
          catalog,
          { includeDevice: false, providers },
        );
        if (locationCapability) assertSharedProjectCapability(locationCapability, "Shared synchronization worktree");
        configureProjectRoom(location.root, locationConnection, repositoryConfig, current, skillLocations, instructionLocations);
        if (locationCapability) assertSharedProjectCapability(locationCapability, "Shared synchronization worktree");
        reconcileLocation(location.root, locationConnection, locationTransaction);
        if (locationCapability) assertSharedProjectCapability(locationCapability, "Shared synchronization worktree");
        const reconciledInstructions = reconcileInstructionLinks(location.root, locationConnection, repositoryConfig, snapshot, catalog, { includeDevice: false, providers, transaction: locationTransaction });
        instructionLinks.links.push(...reconciledInstructions.links);
        transaction.absorb(locationTransaction);
        completedConnectionRoots.add(path.resolve(location.root));
      } catch (error) {
        try { locationTransaction.rollback({ projectCapabilities: locationCapability ? [locationCapability] : [] }); }
        catch (rollbackError) {
          rollbackError.cause = error;
          throw rollbackError;
        }
        links.destinations.push({ id: `worktree:${hashKey(location.root).slice(0, 12)}`, assignmentId: "", collectionId: "", provider: "", scope: "project", destination: location.root, skills: [], links: [], status: "worktree-error", message: `Unable to reconcile registered worktree: ${error.message}`, conflicts: [] });
      }
    }
    const incompleteReceiptRoot = exactConnectionReceiptRoots.find((receiptRoot) => !completedConnectionRoots.has(receiptRoot));
    if (incompleteReceiptRoot) {
      throw sharedContextError(
        "shared-connection-incomplete",
        `Unable to finish Shared synchronization for registered worktree: ${incompleteReceiptRoot}`,
        { projectRoot: incompleteReceiptRoot, projectId: connection.projectId },
      );
    }
    for (const capability of exactProjectCapabilities) assertSharedProjectCapability(capability, "Shared synchronization project");
    writePrivateJson(sharedStatePath(connection.repository), {
      version: 1,
      repository: connection.repository,
      defaultBranch: repositoryConfig.defaultBranch,
      revision,
      syncedAt: new Date().toISOString(),
      online: !fetchError,
      fetchError,
      repositoryConfig,
      catalog,
    });
    if (connectionReceiptId) {
      for (const receiptRoot of exactConnectionReceiptRoots) {
        assertSharedProjectCapability(capabilityByRoot.get(receiptRoot), "Shared receipt project");
        writeSharedConnectionReceipt(
          receiptRoot,
          { ...connection, projectRoot: receiptRoot },
          revision,
          connectionReceiptId,
          repositoryConfig,
        );
      }
    }
  } catch (error) {
    if (!exactProjectCapabilities.length) restoreDetachedSkillLinks(detachedSkillLinks);
    try { transaction.rollback({ projectCapabilities: exactProjectCapabilities }); }
    catch (rollbackError) {
      rollbackError.cause = error;
      throw rollbackError;
    }
    throw error;
  }
  let commitCount = 0;
  if (revisionChanged) {
    if (previousRevision && gitObjectExists(checkout, `${previousRevision}^{commit}`) && gitIsAncestor(checkout, previousRevision, revision)) {
      commitCount = Number(tryGit(checkout, ["rev-list", "--first-parent", "--count", `${previousRevision}..${revision}`])) || 0;
    } else if (!previousRevision) {
      commitCount = 1;
    }
    appendContextRoomEvent("shared.synced", {
      projectId: connection.projectId,
      sharedRepository: connection.repository,
      resource: { revision },
      data: { previousRevision, revision, commitCount, online: !fetchError, fetchError: fetchError || "" },
    });
  }
  return { connection: { ...connection, projectRoot: localProjectRoot }, repositoryConfig, catalog, previousRevision, revision, revisionChanged, commitCount, online: !fetchError, fetchError, cacheRoot, current, skillLocations: links.locations, skillCollections: links.collections, skillDestinations: links.destinations, skillMigrations: links.migrations || [], links: links.links, instructionLocations: instructionLinks.locations, instructionCollections: instructionLinks.collections, instructionLinks: instructionLinks.links, room };
  };
  return repositoryLockHeld
    ? operation()
    : withSharedRepositoryCloneLock(connection.repository, operation, timeoutMs);
}

export function syncSharedContext(root, options = {}) {
  const connection = readSharedProjectConnection(root);
  if (connection) authenticatedSharedGit(connection.repository, options.push, options.timeoutMs);
  return withSharedRegistryLock(() => syncSharedContextInternal(root, options, { registryLockHeld: true }));
}

export function reconcileSharedSkillLocations(root, { provider = "all", allowOffline = true } = {}) {
  const providerId = String(provider || "all").trim();
  if (providerId !== "all" && !SHARED_SKILL_PROVIDER_PROFILES[providerId]) throw new Error(`Unknown shared skill provider: ${providerId}`);
  const synced = syncSharedContext(root, {
    allowOffline,
    forceReconcile: true,
    providers: providerId === "all" ? null : [providerId],
  });
  return {
    repository: synced.connection.repository,
    projectId: synced.connection.projectId,
    revision: synced.revision,
    provider: providerId,
    destinations: synced.skillDestinations.filter((destination) => providerId === "all" || destination.provider === providerId),
    conflicts: synced.skillDestinations.flatMap((destination) => destination.conflicts || []),
  };
}

export function sharedContextStatus(root) {
  const connection = readSharedProjectConnection(root);
  if (!connection) return { connected: false };
  const state = readJson(sharedStatePath(connection.repository), {});
  const security = readJson(path.join(repositoryCacheRoot(connection.repository), "github-security.json"), null);
  return {
    connected: true,
    connection,
    ...state,
    cacheRoot: repositoryCacheRoot(connection.repository),
    permissionBoundary: {
      verified: Boolean(security?.verified),
      checkedAt: security?.checkedAt || null,
      enforcement: "Agents publish proposal branches; the reviewed result reaches main only through the in-app human acceptance action, using a normal fast-forward push",
      note: security?.verified
        ? `Legacy pull-request protection is active for ${security.repository}:${security.defaultBranch} and will block direct in-app acceptance until removed or changed.`
        : "The shared remote must allow Context Room to fast-forward the default branch when the human accepts a completed proposal.",
    },
  };
}

export function readSharedConnectionReceipt(root, {
  repository,
  projectId,
  receiptId,
} = {}) {
  const exactRoot = path.resolve(root);
  const exactReceiptId = String(receiptId || "").trim();
  if (!repository || !projectId || !exactReceiptId) return null;
  const receipt = readJson(sharedConnectionReceiptPath(repository, exactRoot), null);
  if (!receipt || Number(receipt.version) !== 1) return null;
  const currentRootIdentity = sharedProjectRootIdentity(exactRoot);
  if (
    receipt.receiptId !== exactReceiptId
    || receipt.repositoryIdentity !== sharedRepositoryIdentity(repository)
    || !sameSharedRepository(receipt.repository, repository)
    || receipt.projectId !== String(projectId)
    || path.resolve(receipt.projectRoot || "") !== exactRoot
    || String(receipt.rootIdentity?.dev || "") !== currentRootIdentity.dev
    || String(receipt.rootIdentity?.ino || "") !== currentRootIdentity.ino
    || !receipt.revision
    || safeRelativePath(receipt.projectsPath, "Shared connection receipt projectsPath") !== receipt.projectsPath
    || !Number.isFinite(Date.parse(receipt.completedAt || ""))
  ) return null;
  return receipt;
}

export function readAcceptedSharedMetadataProfiles(root) {
  const connection = readSharedProjectConnection(root);
  if (!connection) return [];
  const synced = cachedSharedRepositoryState(connection.repository, {
    projectId: connection.projectId,
    projectRoot: connection.projectRoot || path.resolve(root),
  });
  const snapshot = synced.snapshot;
  const directory = path.join(snapshot, ".context-room", "profiles");
  if (!fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) return [];
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:json|ya?ml)$/i.test(entry.name))
    .slice(0, 100)
    .flatMap((entry) => {
      const filePath = path.join(directory, entry.name);
      const raw = fs.readFileSync(filePath, "utf8");
      try {
        let definition;
        if (/\.json$/i.test(entry.name)) definition = JSON.parse(raw);
        else {
          const document = parseDocument(raw, { strict: true, uniqueKeys: true, merge: false, schema: "core" });
          if (document.errors.length) throw new Error(document.errors.map((error) => error.message).join("; "));
          definition = document.toJS({ maxAliasCount: 50 });
        }
        return definition && typeof definition === "object" && !Array.isArray(definition)
          ? [{ ...definition, origin: "shared", filePath: `.context-room/profiles/${entry.name}`, sharedRevision: synced.revision }]
          : [];
      } catch {
        return [{ id: `invalid-shared-profile-${entry.name}`, schemaVersion: "context-room.metadata-profile/1", version: "invalid", match: ["**/*"], origin: "shared", filePath: `.context-room/profiles/${entry.name}`, sharedRevision: synced.revision, invalidSource: true }];
      }
    });
}

export function sharedSkillProviderProfiles() {
  return Object.values(SHARED_SKILL_PROVIDER_PROFILES).map((profile) => ({ ...profile }));
}

export function sharedSkillLocationsStatus(root, { refresh = true } = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) return { connected: false, providers: sharedSkillProviderProfiles(), providerPreferences: sharedSkillProviderPreferences(), collections: [], destinations: [], conflicts: [] };
  const synced = refresh ? syncSharedContext(root, { allowOffline: true }) : cachedSharedRepositoryState(connection.repository, { projectId: connection.projectId, projectRoot: connection.projectRoot || path.resolve(root) });
  let collections = synced.skillCollections;
  let destinations = synced.skillDestinations;
  let locations = synced.skillLocations;
  if (!collections || !destinations || !locations) {
    const snapshot = synced.current || synced.snapshot || path.join(synced.cacheRoot, "snapshots", synced.revision);
    const plan = resolvedSkillLinkPlan(connection.projectRoot || path.resolve(root), { ...connection, projectId: connection.projectId }, synced.repositoryConfig, synced.catalog, snapshot);
    locations = plan.locations;
    collections = plan.collections;
    const registry = readJson(skillLinkRegistryPath(connection.repository, connection.projectRoot || path.resolve(root)), { destinations: [] });
    destinations = registry.destinations?.length ? registry.destinations : plan.destinations;
  }
  const publicCollections = collections.map((collection) => ({ id: collection.id, title: collection.title, path: collection.path, skills: collection.skills, skillCount: collection.skills.length }));
  const preferences = readSkillLocationPreferences(connection.repository);
  const registeredLocations = registeredRepositoryProjectLocations(connection.repository);
  const assignmentById = new Map(locations.assignments.map((assignment) => [assignment.id, assignment]));
  const publicDestinations = destinations.map((destination) => {
    const assignment = assignmentById.get(destination.assignmentId || "") || null;
    const localOverride = assignment ? localOverrideForAssignment(preferences, assignment.id, connection.projectId) : null;
    const consumers = assignment?.scope === "device"
      ? [{ scope: "device", projectId: "", projectRoot: "" }]
      : registeredLocations
        .filter((location) => assignment?.scope === "shared" || assignment?.projectIds.includes(location.projectId))
        .map((location) => ({ scope: assignment?.scope || destination.scope, projectId: location.projectId, projectRoot: location.root }));
    return {
      id: destination.id,
      assignmentId: destination.assignmentId || "",
      collectionId: destination.collectionId,
      provider: destination.provider,
      scope: destination.scope,
      origin: destination.origin || (destination.assignmentId ? "shared-assignment" : "local-destination"),
      revision: synced.revision,
      destination: destination.destination,
      target: (destination.links || []).map((link) => ({ skill: link.name, link: link.link, target: link.target })),
      skills: destination.skills || [],
      filters: assignment ? { include: assignment.include, exclude: assignment.exclude, localExclude: localOverride?.exclude || [] } : { include: destination.include || ["*"], exclude: destination.exclude || [], localExclude: [] },
      localOverride: localOverride ? { disabled: localOverride.disabled, exclude: localOverride.exclude } : null,
      consumers,
      status: destination.status,
      reason: destination.message || (destination.status === "ready" ? "Accepted shared assignment is materialized at this managed destination" : ""),
      providerPreference: destination.providerPreference || effectiveSkillProviderState(preferences, destination.provider, connection.projectId, destination.scope),
      message: destination.message || "",
      conflicts: destination.conflicts || [],
      unmanagedContentPreserved: (destination.conflicts || []).some((conflict) => conflict.reason?.includes("unmanaged")),
    };
  });
  return {
    connected: true,
    repository: connection.repository,
    repositoryName: synced.repositoryConfig.name,
    projectId: connection.projectId,
    projects: synced.catalog.projects.map((project) => ({ id: project.id, title: project.title })),
    revision: synced.revision,
    online: synced.online,
    legacy: Boolean(locations.legacy),
    manifestPath: synced.repositoryConfig.skillLocationsFile,
    providers: sharedSkillProviderProfiles(),
    providerPreferences: sharedSkillProviderPreferences(),
    localStateVersion: preferences.version,
    projectProviderOverrides: Object.fromEntries(Object.keys(SHARED_SKILL_PROVIDER_PROFILES).map((provider) => [provider, preferences.providerOverrides.find((item) => item.projectId === connection.projectId && item.provider === provider)?.state || "inherit"])),
    scopeDescriptions: {
      project: "Declared projectIds and all of their registered locations",
      shared: "Every registered project location for this shared repository",
      device: "One global provider destination on this device",
    },
    collections: publicCollections,
    assignments: locations.assignments,
    destinations: publicDestinations,
    conflicts: publicDestinations.flatMap((destination) => destination.conflicts.map((conflict) => ({ ...conflict, destinationId: destination.id, collectionId: destination.collectionId }))),
  };
}

export function sharedSkillEffectiveProjection(root, { refresh = false, provider = "all" } = {}) {
  const status = sharedSkillLocationsStatus(root, { refresh });
  if (!status.connected) return status;
  const providerId = String(provider || "all").trim();
  if (providerId !== "all" && !SHARED_SKILL_PROVIDER_PROFILES[providerId]) throw new Error(`Unknown shared skill provider: ${providerId}`);
  const destinations = status.destinations.filter((destination) => providerId === "all" || destination.provider === providerId);
  return {
    ...status,
    provider: providerId,
    destinations,
    conflicts: destinations.flatMap((destination) => destination.conflicts.map((conflict) => ({ ...conflict, destinationId: destination.id, collectionId: destination.collectionId }))),
  };
}

export function previewSharedSkillLocation(root, { assignmentId = "", collectionId, destination = "", provider = "custom", scope = "project", include = ["*"], exclude = [] } = {}) {
  const status = sharedSkillLocationsStatus(root, { refresh: false });
  if (!status.connected) throw new Error("This project has no approved shared-context binding");
  const normalizedAssignmentId = String(assignmentId || "").trim();
  const assignment = normalizedAssignmentId
    ? status.assignments.find((item) => item.id === safeId(normalizedAssignmentId, "assignmentId"))
    : status.assignments.find((item) => item.collectionId === safeId(collectionId, "collectionId") && (provider === "custom" || item.providers.includes(provider)) && item.scope === scope && assignmentAppliesToProject(item, status.projectId));
  if (!assignment) throw new Error("A local destination can link only an accepted shared skill assignment");
  if (provider !== "custom" && !assignment.providers.includes(provider)) throw new Error(`Provider ${provider} is not part of accepted assignment ${assignment.id}`);
  const collection = status.collections.find((item) => item.id === assignment.collectionId);
  if (!collection) throw new Error(`Unknown shared skill collection: ${assignment.collectionId}`);
  const resolvedDestination = destination
    ? expandUserPath(destination)
    : providerSkillDestination(safeId(provider, "provider"), assignment.scope === "device" ? "device" : "project", path.resolve(root));
  if (!resolvedDestination) throw new Error(`No destination is configured for provider ${provider}`);
  const skills = selectedSkillsForLocation(collection.skills, normalizedSkillSelection(include, ["*"]), normalizedSkillSelection(exclude, []));
  const managedRoot = repositoryCacheRoot(status.repository);
  const conflicts = skills.flatMap((name) => {
    const link = path.join(resolvedDestination, name);
    const state = managedSymlinkTarget(link, managedRoot);
    return state.exists && (!state.symbolic || !state.managed) ? [{ skill: name, path: link, reason: "Destination already contains an unmanaged skill" }] : [];
  });
  return { assignment, collection, provider, scope: assignment.scope, destination: resolvedDestination, skills, conflicts, ready: conflicts.length === 0 };
}

export function linkSharedSkillLocation(root, options = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding");
  const preview = previewSharedSkillLocation(root, options);
  if (preview.conflicts.length) throw new Error(`Skill destination has unmanaged conflicts: ${preview.conflicts.map((item) => item.skill).join(", ")}`);
  const preferences = readSkillLocationPreferences(connection.repository);
  const id = options.id ? safeId(options.id, "mount id") : `mount-${hashKey(`${preview.assignment.id}:${preview.destination}`).slice(0, 12)}`;
  const mount = {
    id,
    assignmentId: preview.assignment.id,
    collectionId: preview.assignment.collectionId,
    destination: preview.destination,
    provider: options.provider ? safeId(options.provider, "provider") : "custom",
    scope: preview.assignment.scope,
    projectId: preview.assignment.scope === "device" ? "" : connection.projectId,
    include: normalizedSkillSelection(options.include, ["*"]),
    exclude: normalizedSkillSelection(options.exclude, []),
    enabled: true,
  };
  preferences.mounts = [...preferences.mounts.filter((item) => item.id !== id), mount];
  writeSkillLocationPreferences(connection.repository, preferences);
  const synced = syncSharedContext(root, { allowOffline: true, forceReconcile: true });
  return { mount, status: sharedSkillLocationsStatus(root, { refresh: false }), online: synced.online };
}

export function unlinkSharedSkillLocation(root, { id } = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding");
  const mountId = safeId(id, "mount id");
  const preferences = readSkillLocationPreferences(connection.repository);
  const existing = preferences.mounts.find((item) => item.id === mountId);
  if (!existing) throw new Error(`Unknown local skill mount: ${mountId}`);
  preferences.mounts = preferences.mounts.filter((item) => item.id !== mountId);
  writeSkillLocationPreferences(connection.repository, preferences);
  syncSharedContext(root, { allowOffline: true, forceReconcile: true });
  return { unlinked: true, mount: existing, status: sharedSkillLocationsStatus(root, { refresh: false }) };
}

export function setSharedSkillLocationOverride(root, { assignmentId, disabled = false, exclude = [] } = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding");
  const id = safeId(assignmentId, "assignmentId");
  const status = sharedSkillLocationsStatus(root, { refresh: false });
  if (!status.assignments.some((assignment) => assignment.id === id)) throw new Error(`Unknown shared skill assignment: ${id}`);
  const preferences = readSkillLocationPreferences(connection.repository);
  const normalizedExclude = normalizedSkillSelection(exclude, []);
  const override = Boolean(disabled) || normalizedExclude.length
    ? { assignmentId: id, projectId: connection.projectId, disabled: Boolean(disabled), exclude: normalizedExclude }
    : null;
  preferences.overrides = [
    ...preferences.overrides.filter((item) => !(item.assignmentId === id && item.projectId === connection.projectId)),
    ...(override ? [override] : []),
  ];
  writeSkillLocationPreferences(connection.repository, preferences);
  syncSharedContext(root, { allowOffline: true, forceReconcile: true });
  return { override, status: sharedSkillLocationsStatus(root, { refresh: false }) };
}

export function setSharedSkillProviderOverride(root, { provider, state = "inherit" } = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding");
  const providerId = safeId(provider, "provider");
  if (!SHARED_SKILL_PROVIDER_PROFILES[providerId]) throw new Error(`Unknown shared skill provider: ${providerId}`);
  const normalizedState = normalizeProviderPreference(state, "inherit");
  const preferences = readSkillLocationPreferences(connection.repository);
  preferences.providerOverrides = [
    ...preferences.providerOverrides.filter((item) => !(item.projectId === connection.projectId && item.provider === providerId)),
    ...(normalizedState === "inherit" ? [] : [{ projectId: connection.projectId, provider: providerId, state: normalizedState }]),
  ];
  writeSkillLocationPreferences(connection.repository, preferences);
  syncSharedContext(root, { allowOffline: true, forceReconcile: true });
  return { provider: providerId, state: normalizedState, status: sharedSkillLocationsStatus(root, { refresh: false }) };
}

function skillDirectoryDigest(root) {
  const hash = createHash("sha256");
  const visit = (directory, prefix = "") => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name, "en"))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stats = fs.lstatSync(absolute);
      if (stats.isSymbolicLink() || (!stats.isDirectory() && !stats.isFile())) throw new Error(`Shared skill import rejects links and special files: ${relative}`);
      hash.update(`${relative}\0${stats.mode & 0o777}\0`);
      if (stats.isDirectory()) visit(absolute, relative);
      else {
        if (stats.size > MAX_SHARED_TEXT_BYTES) throw new Error(`Shared skill import file is too large: ${relative}`);
        const content = fs.readFileSync(absolute);
        if (!isUtf8(content)) throw new Error(`Shared skill import requires UTF-8 text files: ${relative}`);
        hash.update(content);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}

function copySharedSkillDirectory(source, destination) {
  skillDirectoryDigest(source);
  if (fs.existsSync(destination)) {
    if (skillDirectoryDigest(destination) === skillDirectoryDigest(source)) return { copied: false, identical: true };
    throw new Error(`Shared collection already contains a different skill: ${path.basename(destination)}`);
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
  return { copied: true, identical: false };
}

export function previewSharedSkillImport(root, { sourceDirectory, collectionId = "", collectionPath = "", skills = [] } = {}) {
  const status = sharedSkillLocationsStatus(root, { refresh: true });
  if (!status.connected) throw new Error("This project has no approved shared-context binding");
  const source = path.resolve(String(sourceDirectory || ""));
  if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) throw new Error(`Skill source folder does not exist: ${source}`);
  const available = skillDirectories(source);
  const selected = skills.length ? normalizedSkillSelection(skills).filter((name) => available.includes(name)) : available;
  if (!selected.length) throw new Error("The selected folder contains no importable skill directories with SKILL.md");
  for (const name of selected) skillDirectoryDigest(path.join(source, name));
  const existingCollection = collectionId ? status.collections.find((collection) => collection.id === safeId(collectionId, "collectionId")) : null;
  const targetPath = existingCollection?.path || safeRelativePath(collectionPath, "collectionPath");
  return { sourceDirectory: source, available, selected, collection: existingCollection || { id: safeId(collectionId, "collectionId"), title: collectionId, path: targetPath }, targetPath, manifestLegacy: status.legacy };
}

function sharedSkillAssignmentInput(status, { assignmentId = "", collectionId, scope = "project", projectIds = [], providers = ["codex"], include = ["*"], exclude = [] } = {}) {
  const collection = status.collections.find((item) => item.id === safeId(collectionId, "collectionId"));
  if (!collection) throw new Error(`Unknown shared skill collection: ${collectionId}`);
  const normalizedScope = String(scope || "project").trim();
  if (!new Set(["project", "shared", "device"]).has(normalizedScope)) throw new Error(`Invalid skill assignment scope: ${normalizedScope}`);
  const normalizedProjects = normalizedScope === "project"
    ? [...new Set((projectIds.length ? projectIds : [status.projectId]).map((projectId) => safeId(projectId, "projectId")))]
    : [];
  if (normalizedScope === "project" && !normalizedProjects.length) throw new Error("Project assignments require at least one projectId");
  const knownProjects = new Set((status.projects || []).map((project) => project.id));
  const unknownProject = normalizedProjects.find((projectId) => !knownProjects.has(projectId));
  if (unknownProject) throw new Error(`Unknown shared project: ${unknownProject}`);
  const providerIds = [...new Set(providers.map((provider) => safeId(provider, "provider")))];
  if (!providerIds.length) throw new Error("Skill assignments require at least one provider");
  const unknownProvider = providerIds.find((provider) => !SHARED_SKILL_PROVIDER_PROFILES[provider]);
  if (unknownProvider) throw new Error(`Unknown shared skill provider: ${unknownProvider}`);
  const base = `${collection.id}-${normalizedScope}`;
  const id = assignmentId
    ? safeId(assignmentId, "assignmentId")
    : safeId(base.length <= 63 ? base : `${collection.id.slice(0, 42)}-${hashKey(base).slice(0, 12)}`, "assignmentId");
  return { id, collectionId: collection.id, scope: normalizedScope, projectIds: normalizedProjects, providers: providerIds, include: normalizedSkillSelection(include, ["*"]), exclude: normalizedSkillSelection(exclude, []) };
}

export function previewSharedSkillAssignment(root, options = {}) {
  const status = sharedSkillLocationsStatus(root, { refresh: true });
  if (!status.connected) throw new Error("This project has no approved shared-context binding");
  const assignment = sharedSkillAssignmentInput(status, options);
  const existing = status.assignments.find((item) => item.id === assignment.id) || null;
  const registered = registeredRepositoryProjectLocations(status.repository)
    .filter((location) => assignment.scope === "shared" || assignment.scope === "device" || assignment.projectIds.includes(location.projectId));
  const affectedLocations = [...new Set((assignment.scope === "device"
    ? assignment.providers.map((provider) => providerSkillDestination(provider, "device", path.resolve(root))).filter(Boolean)
    : registered.map((location) => location.root)))]
    .sort((left, right) => left.localeCompare(right, "en"));
  const collection = status.collections.find((item) => item.id === assignment.collectionId);
  const selectedSkills = selectedSkillsForLocation(collection?.skills || [], assignment.include, assignment.exclude);
  const destinations = assignment.scope === "device"
    ? assignment.providers.map((provider) => ({ provider, projectId: "", projectRoot: "", destination: providerSkillDestination(provider, "device", path.resolve(root)) }))
    : registered.flatMap((location) => assignment.providers.map((provider) => ({ provider, projectId: location.projectId, projectRoot: location.root, destination: providerSkillDestination(provider, "project", location.root) })));
  const managedRoot = repositoryCacheRoot(status.repository);
  const preferences = readSkillLocationPreferences(status.repository);
  const destinationPreview = destinations.map((destination) => {
    const providerPreference = effectiveSkillProviderState(preferences, destination.provider, destination.projectId || status.projectId, assignment.scope);
    const localOverride = localOverrideForAssignment(preferences, assignment.id, destination.projectId || status.projectId);
    const effectiveSkills = providerPreference.state === "disabled" || localOverride?.disabled
      ? []
      : selectedSkills.filter((skill) => !(localOverride?.exclude || []).includes(skill));
    const conflicts = effectiveSkills.flatMap((skill) => {
      const link = path.join(destination.destination, skill);
      const state = managedSymlinkTarget(link, managedRoot);
      return state.exists && (!state.symbolic || !state.managed) ? [{ skill, path: link, reason: "Destination already contains an unmanaged skill" }] : [];
    });
    return { ...destination, providerPreference, localOverride, skills: effectiveSkills, conflicts };
  });
  return {
    assignment,
    existing,
    collection: collection ? { id: collection.id, title: collection.title, path: collection.path, skills: selectedSkills } : null,
    providers: assignment.providers.map((provider) => ({ provider, preference: effectiveSkillProviderState(preferences, provider, status.projectId, assignment.scope) })),
    destinations: destinationPreview,
    conflicts: destinationPreview.flatMap((destination) => destination.conflicts.map((conflict) => ({ ...conflict, provider: destination.provider, destination: destination.destination }))),
    affectedLocations,
    action: existing ? "reassign" : "assign",
    proposalRequired: true,
    sharedChanges: { manifestPath: status.manifestPath, assignment },
    localChanges: [],
  };
}

export function proposeSharedSkillAssignment(root, { title = "Assign shared skills", description = "Update the shared skill assignment and provider scope.", sessionId = process.env.CODEX_THREAD_ID || "", ...options } = {}) {
  const preview = previewSharedSkillAssignment(root, options);
  const proposal = ensureSharedProposal(root, { title, description, scope: "skills", sessionId });
  const repositoryConfig = readSharedRepositoryConfig(proposal.root);
  const catalog = normalizedProjectsCatalog(readJson(path.join(proposal.root, repositoryConfig.projectsFile)));
  const current = readSharedSkillLocationsFromRoot(proposal.root, repositoryConfig, catalog);
  const next = { ...current, collections: current.collections.map((item) => ({ ...item })), assignments: [...current.assignments.filter((item) => item.id !== preview.assignment.id), preview.assignment] };
  const normalized = normalizedSharedSkillLocations(next, { repositoryConfig, catalog });
  writeJson(path.join(proposal.root, repositoryConfig.skillLocationsFile), sharedSkillLocationsDocument(normalized));
  const published = publishSharedProposal(root, { proposal: proposal.branch, title, description, message: title });
  return { proposal: published, assignment: preview.assignment, action: preview.action, affectedLocations: preview.affectedLocations, localFilesChanged: false };
}

export function previewSharedSkillUnassignment(root, { assignmentId } = {}) {
  const status = sharedSkillLocationsStatus(root, { refresh: true });
  if (!status.connected) throw new Error("This project has no approved shared-context binding");
  const id = safeId(assignmentId, "assignmentId");
  const assignment = status.assignments.find((item) => item.id === id);
  if (!assignment) throw new Error(`Unknown shared skill assignment: ${id}`);
  return { assignment, action: "unassign", proposalRequired: true };
}

export function proposeSharedSkillUnassignment(root, { assignmentId, title = "Unassign shared skills", description = "Remove the shared skill assignment without deleting local unmanaged content.", sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const preview = previewSharedSkillUnassignment(root, { assignmentId });
  const proposal = ensureSharedProposal(root, { title, description, scope: "skills", sessionId });
  const repositoryConfig = readSharedRepositoryConfig(proposal.root);
  const catalog = normalizedProjectsCatalog(readJson(path.join(proposal.root, repositoryConfig.projectsFile)));
  const current = readSharedSkillLocationsFromRoot(proposal.root, repositoryConfig, catalog);
  const assignments = current.assignments.filter((item) => item.id !== preview.assignment.id);
  const collectionRemoved = !assignments.some((item) => item.collectionId === preview.assignment.collectionId)
    && current.collections.some((item) => item.id === preview.assignment.collectionId && sharedCollectionPathIsAlwaysVisible(item, repositoryConfig, catalog));
  const collections = current.collections
    .filter((item) => !collectionRemoved || item.id !== preview.assignment.collectionId)
    .map((item) => ({ ...item }));
  const normalized = normalizedSharedSkillLocations({ ...current, collections, assignments }, { repositoryConfig, catalog });
  writeJson(path.join(proposal.root, repositoryConfig.skillLocationsFile), sharedSkillLocationsDocument(normalized));
  const published = publishSharedProposal(root, { proposal: proposal.branch, title, description, message: title });
  return { proposal: published, assignment: preview.assignment, action: "unassign", collectionRemoved, localFilesChanged: false };
}

export function importSharedSkills(root, {
  sourceDirectory,
  collectionId,
  collectionTitle = "",
  collectionPath = "",
  skills = [],
  scope = "project",
  projectIds = [],
  providers = ["codex"],
  destination = "",
  title = "Import shared skills",
  description = "Import selected skills into the shared canonical library and link their accepted snapshot.",
  sessionId = process.env.CODEX_THREAD_ID || "",
} = {}) {
  const preview = previewSharedSkillImport(root, { sourceDirectory, collectionId, collectionPath, skills });
  const connection = readSharedProjectConnection(root);
  const proposal = ensureSharedProposal(root, { title, description, scope: "skills", sessionId });
  const repositoryConfig = readSharedRepositoryConfig(proposal.root);
  const catalog = normalizedProjectsCatalog(readJson(path.join(proposal.root, repositoryConfig.projectsFile)));
  const existingLocations = readSharedSkillLocationsFromRoot(proposal.root, repositoryConfig, catalog);
  const next = { ...existingLocations, collections: existingLocations.collections.map((item) => ({ ...item })), assignments: existingLocations.assignments.map((item) => ({ ...item, projectIds: [...item.projectIds], providers: [...item.providers], include: [...item.include], exclude: [...item.exclude] })) };
  let collection = next.collections.find((item) => item.id === preview.collection.id);
  if (!collection) {
    collection = { id: preview.collection.id, title: String(collectionTitle || preview.collection.id).trim() || preview.collection.id, path: preview.targetPath };
    next.collections.push(collection);
  }
  const providerIds = [...new Set(providers.map((provider) => safeId(provider, "provider")))];
  const assignmentBase = `${collection.id}-${scope}`;
  const assignmentId = safeId(assignmentBase.length <= 63 ? assignmentBase : `${collection.id.slice(0, 42)}-${hashKey(assignmentBase).slice(0, 12)}`, "assignment id");
  const normalizedScope = new Set(["project", "shared", "device"]).has(scope) ? scope : "project";
  const assignment = { id: assignmentId, collectionId: collection.id, scope: normalizedScope, projectIds: normalizedScope === "project" ? [...new Set((projectIds.length ? projectIds : [connection.projectId]).map((projectId) => safeId(projectId, "projectId")))] : [], providers: providerIds, include: ["*"], exclude: [] };
  next.assignments = [...next.assignments.filter((item) => item.id !== assignmentId), assignment];
  const normalized = normalizedSharedSkillLocations(next, { repositoryConfig, catalog });
  writeJson(path.join(proposal.root, repositoryConfig.skillLocationsFile), sharedSkillLocationsDocument(normalized));
  const copied = preview.selected.map((name) => ({ name, ...copySharedSkillDirectory(path.join(preview.sourceDirectory, name), path.join(proposal.root, collection.path, name)) }));
  const published = publishSharedProposal(root, { proposal: proposal.branch, title, description, message: title });
  const preferences = readSkillLocationPreferences(connection.repository);
  const resolvedDestination = destination
    ? expandUserPath(destination)
    : providerIds.length === 1 ? providerSkillDestination(providerIds[0], scope === "device" ? "device" : "project", connection.projectRoot || path.resolve(root)) : preview.sourceDirectory;
  if (resolvedDestination && !preferences.mounts.some((mount) => mount.collectionId === collection.id && mount.destination === resolvedDestination)) {
    const defaultProviderDestination = providerIds.length === 1 ? providerSkillDestination(providerIds[0], scope === "device" ? "device" : "project", connection.projectRoot || path.resolve(root)) : "";
    if (destination || !defaultProviderDestination || path.resolve(defaultProviderDestination) !== path.resolve(resolvedDestination)) {
      preferences.mounts.push({ id: `mount-${hashKey(`${collection.id}:${resolvedDestination}`).slice(0, 12)}`, collectionId: collection.id, destination: resolvedDestination, provider: providerIds.length === 1 ? providerIds[0] : "custom", scope: scope === "device" ? "device" : "project", projectId: scope === "device" ? "" : connection.projectId, include: ["*"], exclude: [], enabled: true });
    }
  }
  const pendingId = `import-${hashKey(`${published.branch}:${preview.sourceDirectory}`).slice(0, 12)}`;
  preferences.pendingImports = [...preferences.pendingImports.filter((item) => item.id !== pendingId), { id: pendingId, proposal: published.branch, proposalHead: published.head, collectionId: collection.id, sourceDirectory: preview.sourceDirectory, destination: resolvedDestination || preview.sourceDirectory, skills: preview.selected, createdAt: new Date().toISOString() }];
  writeSkillLocationPreferences(connection.repository, preferences);
  return { proposal: published, collection, assignment, copied, pendingImport: preferences.pendingImports.find((item) => item.id === pendingId), localFilesChanged: false };
}

function normalizedInstructionFiles(files, assignmentId = "preview") {
  return normalizedSharedInstructionLocations({
    version: 1,
    collections: [{ id: "collection", title: "Collection", path: "instructions/collection" }],
    assignments: [{ id: safeId(assignmentId, "instruction assignment id"), collectionId: "collection", scope: "device", files }],
  }).assignments[0].files;
}

function affectedInstructionLocations(repository, assignment) {
  if (assignment.scope === "device") return [{ projectId: "", root: "", scope: "device" }];
  return registeredRepositoryProjectLocations(repository)
    .filter((location) => assignment.scope === "shared" || assignment.projectIds.includes(location.projectId))
    .map((location) => ({ ...location, scope: assignment.scope }));
}

function previewInstructionMappings(status, root, assignment, collection) {
  const affectedLocations = affectedInstructionLocations(status.repository, assignment);
  const preferences = readSkillLocationPreferences(status.repository);
  const mappings = affectedLocations.flatMap((location) => assignment.files.flatMap((file) => file.providers.map((provider) => {
    const projectRoot = location.root || path.resolve(root);
    const destinationRoot = providerInstructionRoot(provider, assignment.scope, projectRoot);
    const destination = destinationRoot ? path.resolve(destinationRoot, ...file.target.split("/")) : "";
    const activation = providerInstructionActivation(provider, file.target, assignment.scope, projectRoot, { plannedTargets: assignment.files.filter((candidate) => candidate.providers.includes(provider)).map((candidate) => candidate.target) });
    const providerPreference = effectiveSkillProviderState(preferences, provider, location.projectId || status.projectId, assignment.scope);
    const owner = destination ? managedDestinationOwner(destination) : null;
    const destinationState = destination ? managedSymlinkTarget(destination, repositoryCacheRoot(status.repository)) : { exists: false };
    const conflict = destination && ((owner && owner.repository !== status.repository) || (destinationState.exists && (!destinationState.symbolic || !destinationState.managed)));
    const disabled = providerPreference.state === "disabled";
    return {
      source: `${collection.path}/${file.source}`,
      target: file.target,
      provider,
      scope: assignment.scope,
      projectId: location.projectId || "",
      projectRoot: location.root || "",
      destination,
      activationStatus: disabled ? "inactive" : activation.status,
      activationReason: disabled ? `Provider ${provider} is disabled here` : activation.reason,
      configurationRequired: !disabled && activation.status === "inactive",
      materializationStatus: disabled ? "provider-disabled" : conflict ? "conflict" : "pending",
      providerPreference,
      owner,
      localBehavior: disabled ? "Leave the local destination untouched while this provider is disabled." : "Install a managed link after exact acceptance; preserve unmanaged content.",
    };
  })));
  return { affectedLocations, mappings, conflicts: mappings.filter((item) => item.materializationStatus === "conflict") };
}

export function previewSharedInstructionAssignment(root, { assignmentId = "", collectionId, scope = "project", projectIds = [], files = [] } = {}) {
  const status = sharedInstructionLocationsStatus(root, { refresh: true });
  if (!status.connected) throw new Error("This project has no approved shared-context binding");
  const collection = status.collections.find((item) => item.id === safeId(collectionId, "collectionId"));
  if (!collection) throw new Error(`Unknown shared instruction collection: ${collectionId}`);
  const normalizedScope = String(scope || "project");
  const id = assignmentId ? safeId(assignmentId, "assignmentId") : safeId(`${collection.id}-${normalizedScope}`.slice(0, 63), "assignmentId");
  const assignment = normalizedSharedInstructionLocations({
    version: 1,
    collections: status.collections,
    assignments: [{ id, collectionId: collection.id, scope: normalizedScope, ...(normalizedScope === "project" ? { projectIds: projectIds.length ? projectIds : [status.projectId] } : {}), files }],
  }, { catalog: { projects: status.projects || [] } }).assignments[0];
  const preview = previewInstructionMappings(status, root, assignment, collection);
  return {
    action: status.assignments.some((item) => item.id === assignment.id) ? "reassign" : "assign",
    proposalRequired: true,
    assignment,
    collection,
    affectedLocations: preview.affectedLocations,
    mappings: preview.mappings,
    conflicts: preview.conflicts,
    sharedChanges: { manifestPath: status.manifestPath, assignment },
    localChanges: [],
  };
}

export function proposeSharedInstructionAssignment(root, { title = "Assign shared instructions", description = "Update the shared instruction assignment and its project/provider targets.", sessionId = process.env.CODEX_THREAD_ID || "", ...options } = {}) {
  const preview = previewSharedInstructionAssignment(root, options);
  const proposal = ensureSharedProposal(root, { title, description, scope: "instructions", sessionId });
  const repositoryConfig = readSharedRepositoryConfig(proposal.root);
  const catalog = normalizedProjectsCatalog(readJson(path.join(proposal.root, repositoryConfig.projectsFile)));
  const current = readSharedInstructionLocationsFromRoot(proposal.root, repositoryConfig, catalog);
  const next = normalizedSharedInstructionLocations({ ...current, assignments: [...current.assignments.filter((item) => item.id !== preview.assignment.id), preview.assignment] }, { repositoryConfig, catalog });
  writeJson(path.join(proposal.root, repositoryConfig.instructionLocationsFile), sharedInstructionLocationsDocument(next));
  const published = publishSharedProposal(root, { proposal: proposal.branch, title, description, message: title });
  return { proposal: published, assignment: preview.assignment, action: preview.action, affectedLocations: preview.affectedLocations, localFilesChanged: false };
}

export function previewSharedInstructionUnassignment(root, { assignmentId } = {}) {
  const status = sharedInstructionLocationsStatus(root, { refresh: true });
  const id = safeId(assignmentId, "assignmentId");
  const assignment = status.assignments.find((item) => item.id === id);
  if (!assignment) throw new Error(`Unknown shared instruction assignment: ${id}`);
  return { action: "unassign", proposalRequired: true, assignment, affectedLocations: affectedInstructionLocations(status.repository, assignment) };
}

export function proposeSharedInstructionUnassignment(root, { assignmentId, title = "Unassign shared instructions", description = "Remove the shared instruction assignment without deleting unmanaged local files.", sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const preview = previewSharedInstructionUnassignment(root, { assignmentId });
  const proposal = ensureSharedProposal(root, { title, description, scope: "instructions", sessionId });
  const repositoryConfig = readSharedRepositoryConfig(proposal.root);
  const catalog = normalizedProjectsCatalog(readJson(path.join(proposal.root, repositoryConfig.projectsFile)));
  const current = readSharedInstructionLocationsFromRoot(proposal.root, repositoryConfig, catalog);
  const next = normalizedSharedInstructionLocations({ ...current, assignments: current.assignments.filter((item) => item.id !== preview.assignment.id) }, { repositoryConfig, catalog });
  writeJson(path.join(proposal.root, repositoryConfig.instructionLocationsFile), sharedInstructionLocationsDocument(next));
  const published = publishSharedProposal(root, { proposal: proposal.branch, title, description, message: title });
  return { proposal: published, assignment: preview.assignment, action: "unassign", localFilesChanged: false };
}

export function previewSharedInstructionImport(root, { collectionId = "", collectionTitle = "", collectionPath = "", files = [], scope = "project", projectIds = [] } = {}) {
  const status = sharedInstructionLocationsStatus(root, { refresh: true });
  const id = safeId(collectionId || collectionTitle, "collectionId");
  const existing = status.collections.find((item) => item.id === id);
  const targetPath = existing?.path || safeRelativePath(collectionPath || `instructions/${id}`, "instruction collection path");
  if (!Array.isArray(files) || !files.length) throw new Error("Select at least one local instruction file");
  const selected = files.map((item) => {
    const localPath = path.resolve(String(item?.localPath || ""));
    if (!fs.existsSync(localPath) || !fs.statSync(localPath).isFile()) throw new Error(`Instruction file does not exist: ${localPath}`);
    if (!/\.mdx?$/i.test(localPath)) throw new Error(`Instruction imports support Markdown files only: ${localPath}`);
    const source = safeInstructionPath(item?.source || path.basename(localPath), "shared instruction source");
    const target = safeInstructionPath(item?.target || path.basename(localPath), "instruction target");
    const providers = normalizedInstructionFiles([{ source, target, providers: item?.providers || ["codex"] }])[0].providers;
    return { localPath, source, target, providers };
  });
  const collection = { id, title: String(collectionTitle || existing?.title || id).trim() || id, path: targetPath };
  const normalizedScope = new Set(["project", "shared", "device"]).has(scope) ? scope : "project";
  const assignment = normalizedSharedInstructionLocations({
    version: 1,
    collections: [collection],
    assignments: [{ id: safeId(`${collection.id}-${normalizedScope}`.slice(0, 63), "assignmentId"), collectionId: collection.id, scope: normalizedScope, projectIds: normalizedScope === "project" ? (projectIds.length ? projectIds : [status.projectId]) : [], files: selected.map(({ source, target, providers }) => ({ source, target, providers })) }],
  }, { catalog: { projects: status.projects || [] } }).assignments[0];
  const projection = previewInstructionMappings(status, root, assignment, collection);
  const mappings = projection.mappings.map((mapping) => {
    const imported = selected.find((item) => `${collection.path}/${item.source}` === mapping.source);
    const replacesSource = imported && mapping.destination && stableRoot(imported.localPath) === path.resolve(mapping.destination);
    return { ...mapping, localSource: imported?.localPath || "", localBehavior: replacesSource ? "Archive the unchanged local source after exact acceptance, then install the managed link." : mapping.localBehavior };
  });
  return { collection, assignment, existing: Boolean(existing), files: selected, affectedLocations: projection.affectedLocations, mappings, conflicts: mappings.filter((item) => item.materializationStatus === "conflict"), proposalRequired: true, localFilesChanged: false };
}

export function importSharedInstructions(root, {
  collectionId,
  collectionTitle = "",
  collectionPath = "",
  files = [],
  scope = "project",
  projectIds = [],
  title = "Import shared instructions",
  description = "Import selected instruction files into the shared canonical library and assign their accepted snapshot.",
  sessionId = process.env.CODEX_THREAD_ID || "",
} = {}) {
  const preview = previewSharedInstructionImport(root, { collectionId, collectionTitle, collectionPath, files, scope, projectIds });
  const connection = readSharedProjectConnection(root);
  const proposal = ensureSharedProposal(root, { title, description, scope: "instructions", sessionId });
  const repositoryConfig = readSharedRepositoryConfig(proposal.root);
  const catalog = normalizedProjectsCatalog(readJson(path.join(proposal.root, repositoryConfig.projectsFile)));
  const current = readSharedInstructionLocationsFromRoot(proposal.root, repositoryConfig, catalog);
  const collection = preview.collection;
  const normalizedScope = new Set(["project", "shared", "device"]).has(scope) ? scope : "project";
  const assignmentId = safeId(`${collection.id}-${normalizedScope}`.slice(0, 63), "assignmentId");
  const previousAssignment = current.assignments.find((item) => item.id === assignmentId);
  const importedFiles = preview.files.map(({ source, target, providers }) => ({ source, target, providers }));
  const importedDestinations = new Set(importedFiles.flatMap((item) => item.providers.map((provider) => `${provider}:${item.target}`)));
  const preservedFiles = (previousAssignment?.files || []).filter((item) => (
    !item.providers.some((provider) => importedDestinations.has(`${provider}:${item.target}`))
  ));
  const assignment = {
    id: assignmentId,
    collectionId: collection.id,
    scope: normalizedScope,
    projectIds: normalizedScope === "project" ? [...new Set((projectIds.length ? projectIds : [connection.projectId]).map((id) => safeId(id, "projectId")))] : [],
    files: [...preservedFiles, ...importedFiles],
  };
  const next = normalizedSharedInstructionLocations({
    version: 1,
    collections: [...current.collections.filter((item) => item.id !== collection.id), collection],
    assignments: [...current.assignments.filter((item) => item.id !== assignment.id), assignment],
  }, { repositoryConfig, catalog });
  for (const item of preview.files) {
    const destination = path.join(proposal.root, collection.path, ...item.source.split("/"));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(item.localPath, destination);
  }
  writeJson(path.join(proposal.root, repositoryConfig.instructionLocationsFile), sharedInstructionLocationsDocument(next));
  const published = publishSharedProposal(root, { proposal: proposal.branch, title, description, message: title });
  const preferences = readSkillLocationPreferences(connection.repository);
  const projectRoot = connection.projectRoot || path.resolve(root);
  const pendingId = `instruction-${hashKey(`${published.branch}:${collection.id}`, 12)}`;
  const pendingImport = {
    id: pendingId,
    proposal: published.branch,
    proposalHead: published.head,
    collectionId: collection.id,
    assignmentId: assignment.id,
    scope: normalizedScope,
    projectId: connection.projectId,
    files: preview.files.map((item) => ({
      localPath: item.localPath,
      contentHash: fileContentHash(item.localPath),
      source: item.source,
      target: item.target,
      providers: item.providers,
      destinations: item.providers.map((provider) => path.resolve(providerInstructionRoot(provider, normalizedScope, projectRoot), ...item.target.split("/"))),
    })),
    createdAt: new Date().toISOString(),
  };
  preferences.pendingInstructionImports = [...preferences.pendingInstructionImports.filter((item) => item.id !== pendingId), pendingImport];
  writeSkillLocationPreferences(connection.repository, preferences);
  return { proposal: published, collection, assignment, imported: preview.files.map((item) => ({ source: item.localPath, sharedPath: `${collection.path}/${item.source}` })), pendingImport, localFilesChanged: false };
}

export function reconcileSharedInstructionLocations(root, { allowOffline = true, provider = "all" } = {}) {
  const providerId = String(provider || "all").trim();
  if (providerId !== "all" && !SHARED_SKILL_PROVIDER_PROFILES[providerId]) throw new Error(`Unknown shared instruction provider: ${providerId}`);
  const synced = syncSharedContext(root, { allowOffline, forceReconcile: true, providers: providerId === "all" ? null : [providerId] });
  return { connected: true, repository: synced.connection.repository, projectId: synced.connection.projectId, revision: synced.revision, provider: providerId, links: (synced.instructionLinks || []).filter((link) => providerId === "all" || link.provider === providerId), status: sharedInstructionLocationsStatus(root, { refresh: false }) };
}

function sharedSecurityTarget(root) {
  const resolvedRoot = path.resolve(root);
  const connection = readSharedProjectConnection(resolvedRoot);
  if (connection) {
    const state = readJson(sharedStatePath(connection.repository), {});
    let repositoryConfig = state.repositoryConfig ? normalizedRepositoryConfig(state.repositoryConfig) : null;
    if (!repositoryConfig) {
      repositoryConfig = withSharedRepositoryCloneLock(connection.repository, () => {
        const checkout = ensureRepositoryCloneUnderLock(connection.repository);
        runSharedNetworkGit(checkout, ["fetch", "--prune", "origin"], {
          stdio: ["ignore", "ignore", "pipe"],
          operation: "Git fetch",
        });
        return readRemoteSharedDescriptor(checkout).config;
      });
    }
    return { repository: connection.repository, repositoryConfig, gitRoots: [repositoryCheckout(connection.repository)] };
  }
  if (fs.existsSync(path.join(resolvedRoot, SHARED_REPOSITORY_CONFIG))) {
    const repository = tryGit(resolvedRoot, ["remote", "get-url", "origin"]);
    if (!repository) throw new Error("The shared repository has no origin remote");
    const cachedCheckout = repositoryCheckout(repository);
    const gitRoots = [resolvedRoot];
    if (fs.existsSync(path.join(cachedCheckout, ".git"))) gitRoots.push(cachedCheckout);
    return { repository, repositoryConfig: readSharedRepositoryConfig(resolvedRoot), gitRoots };
  }
  throw new Error("Run this command from a shared repository or a project connected to shared context");
}

function sharedAgentCredential(repository) {
  const directory = path.join(repositoryCacheRoot(repository), "credentials");
  return {
    directory,
    privateKey: path.join(directory, "agent_ed25519"),
    publicKey: path.join(directory, "agent_ed25519.pub"),
    title: `Context Room agent ${hashKey(repository, 8)}`,
  };
}

function ensureSharedAgentCredential(repository) {
  const cacheRoot = repositoryCacheRoot(repository);
  fs.mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
  assertSharedCacheDirectoryNoFollow(cacheRoot, "Shared repository cache");
  writeRepositoryIdentityClaim(cacheRoot, repository);
  const credential = sharedAgentCredential(repository);
  fs.mkdirSync(credential.directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(credential.directory, 0o700);
  if (!fs.existsSync(credential.privateKey) || !fs.existsSync(credential.publicKey)) {
    if (fs.existsSync(credential.privateKey) || fs.existsSync(credential.publicKey)) {
      throw new Error(`Incomplete shared agent SSH credential at ${credential.directory}`);
    }
    const result = spawnSync("ssh-keygen", [
      "-q", "-t", "ed25519", "-N", "", "-C", credential.title, "-f", credential.privateKey,
    ], { encoding: "utf8" });
    if (result.error?.code === "ENOENT") throw new Error("ssh-keygen is required to create the restricted agent credential");
    if (result.status !== 0) throw new Error(`Unable to create the restricted agent credential: ${String(result.stderr || result.stdout).trim()}`);
  }
  fs.chmodSync(credential.privateKey, 0o600);
  fs.chmodSync(credential.publicKey, 0o644);
  return { ...credential, key: fs.readFileSync(credential.publicKey, "utf8").trim() };
}

function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function configureSharedAgentGit(repository, github, gitRoots) {
  const credential = sharedAgentCredential(repository);
  if (!fs.existsSync(credential.privateKey)) throw new Error("Restricted shared agent credential is missing");
  const sshCommand = `ssh -i ${shellSingleQuote(credential.privateKey)} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new`;
  const remote = `git@github.com:${github.fullName}.git`;
  for (const gitRoot of gitRoots) {
    if (!fs.existsSync(path.join(gitRoot, ".git"))) throw new Error(`Shared Git checkout is missing: ${gitRoot}`);
    runGit(gitRoot, ["remote", "set-url", "origin", remote]);
    runGit(gitRoot, ["config", "core.sshCommand", sshCommand]);
  }
  return { privateKey: credential.privateKey, remote, gitRoots };
}

function configureExistingSharedAgentGit(repository, gitRoot) {
  const credential = sharedAgentCredential(repository);
  if (!fs.existsSync(credential.privateKey)) return;
  let github;
  try { github = githubRepositoryCoordinates(repository); } catch { return; }
  configureSharedAgentGit(repository, github, [gitRoot]);
}

function normalizedSshPublicKey(value) {
  return String(value || "").trim().split(/\s+/).slice(0, 2).join(" ");
}

function inspectSharedAgentGit(repository, github, gitRoots, deployKeys) {
  const credential = sharedAgentCredential(repository);
  const publicKey = fs.existsSync(credential.publicKey) ? fs.readFileSync(credential.publicKey, "utf8").trim() : "";
  const deployKey = (deployKeys || []).find((item) => (
    item.title === credential.title
    && (!publicKey || normalizedSshPublicKey(item.key) === normalizedSshPublicKey(publicKey))
  ));
  const expectedRemote = `git@github.com:${github.fullName}.git`;
  const localConfigured = Boolean(publicKey && fs.existsSync(credential.privateKey) && gitRoots.every((gitRoot) => (
    tryGit(gitRoot, ["remote", "get-url", "origin"]) === expectedRemote
    && tryGit(gitRoot, ["config", "--get", "core.sshCommand"]).includes(credential.privateKey)
  )));
  return {
    deployKey,
    checks: {
      writableAgentDeployKey: Boolean(deployKey && deployKey.read_only === false),
      localAgentCredential: localConfigured,
    },
    credential: { title: credential.title, publicKey: credential.publicKey, privateKey: credential.privateKey },
  };
}

function runGitHubApi(endpoint, { method = "GET", body = null } = {}) {
  const args = [
    "api",
    endpoint,
    "-H", "Accept: application/vnd.github+json",
    "-H", "X-GitHub-Api-Version: 2022-11-28",
  ];
  if (method !== "GET") args.push("--method", method);
  if (body !== null) args.push("--input", "-");
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    input: body === null ? undefined : JSON.stringify(body),
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error?.code === "ENOENT") throw new Error("GitHub CLI is required; install gh and authenticate an owner account");
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || "GitHub API request failed").trim().split("\n")[0];
    throw new Error(`GitHub API request failed: ${detail}`);
  }
  try {
    return result.stdout ? JSON.parse(result.stdout) : null;
  } catch {
    throw new Error("GitHub API returned an invalid JSON response");
  }
}

function githubRulesetName(defaultBranch) {
  return `${GITHUB_RULESET_PREFIX}${defaultBranch}`;
}

function githubReviewRulesetName(kind) {
  return `${GITHUB_RULESET_PREFIX}${kind} review refs`;
}

function githubPrefixPattern(prefix) {
  return `refs/heads/${String(prefix).replace(/\/$/, "")}/**/*`;
}

function githubTerminalStatePattern() {
  return `refs/heads/${SHARED_PROPOSAL_STATE_PREFIX.replace(/\/$/, "")}/*`;
}

function githubRulesetPayload(defaultBranch) {
  return {
    name: githubRulesetName(defaultBranch),
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${defaultBranch}`], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      {
        type: "pull_request",
        parameters: {
          allowed_merge_methods: ["merge", "squash", "rebase"],
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: true,
          required_approving_review_count: 1,
          required_review_thread_resolution: true,
        },
      },
    ],
  };
}

function githubReviewRulesetPayload(config, kind) {
  const rejected = kind === "rejected";
  const terminalState = kind === "state";
  const prefix = rejected ? config.rejectionPrefix : config.proposalPrefix;
  return {
    name: githubReviewRulesetName(kind),
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [terminalState ? githubTerminalStatePattern() : githubPrefixPattern(prefix)], exclude: [] } },
    rules: rejected
      ? [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "update" }]
      : terminalState
        ? [{ type: "deletion" }, { type: "non_fast_forward" }]
        : [{ type: "deletion" }],
  };
}

function inspectGitHubRuleset(ruleset, defaultBranch) {
  const types = new Map((ruleset?.rules || []).map((rule) => [rule.type, rule]));
  const pullRequest = types.get("pull_request");
  const checks = {
    active: ruleset?.enforcement === "active",
    branchTarget: ruleset?.target === "branch",
    exactDefaultBranch: ruleset?.conditions?.ref_name?.include?.includes(`refs/heads/${defaultBranch}`) === true,
    noBypassActors: Array.isArray(ruleset?.bypass_actors) && ruleset.bypass_actors.length === 0,
    requiresPullRequest: Boolean(pullRequest),
    requiresHumanApproval: Number(pullRequest?.parameters?.required_approving_review_count || 0) >= 1,
    dismissesStaleApproval: pullRequest?.parameters?.dismiss_stale_reviews_on_push === true,
    requiresLastPushApproval: pullRequest?.parameters?.require_last_push_approval === true,
    resolvesReviewThreads: pullRequest?.parameters?.required_review_thread_resolution === true,
    blocksDeletion: types.has("deletion"),
    blocksForcePush: types.has("non_fast_forward"),
  };
  return { verified: Object.values(checks).every(Boolean), checks };
}

function inspectGitHubReviewRuleset(ruleset, config, kind) {
  const types = new Set((ruleset?.rules || []).map((rule) => rule.type));
  const rejected = kind === "rejected";
  const terminalState = kind === "state";
  const checks = {
    active: ruleset?.enforcement === "active",
    branchTarget: ruleset?.target === "branch",
    exactPattern: ruleset?.conditions?.ref_name?.include?.includes(
      terminalState ? githubTerminalStatePattern() : githubPrefixPattern(rejected ? config.rejectionPrefix : config.proposalPrefix),
    ) === true,
    noBypassActors: Array.isArray(ruleset?.bypass_actors) && ruleset.bypass_actors.length === 0,
    blocksDeletion: types.has("deletion"),
    ...(rejected
      ? { blocksForcePush: types.has("non_fast_forward"), blocksUpdates: types.has("update") }
      : terminalState
        ? { blocksForcePush: types.has("non_fast_forward") }
        : {}),
  };
  return { verified: Object.values(checks).every(Boolean), checks };
}

function prefixedChecks(prefix, checks) {
  return Object.fromEntries(Object.entries(checks).map(([name, value]) => [`${prefix}${name[0].toUpperCase()}${name.slice(1)}`, value]));
}

function findGitHubRulesetSummary(rulesets, name) {
  return (rulesets || []).find((item) => item.name === name) || null;
}

function readGitHubRuleset(github, summary) {
  return summary?.id
    ? runGitHubApi(`repos/${github.fullName}/rulesets/${summary.id}?includes_parents=false`)
    : null;
}

function writeGitHubSecurityState(repository, result) {
  return writeJson(path.join(repositoryCacheRoot(repository), "github-security.json"), result);
}

export function checkSharedGitHubSecurity(root) {
  const { repository, repositoryConfig, gitRoots } = sharedSecurityTarget(root);
  const github = githubRepositoryCoordinates(repository);
  const rulesets = runGitHubApi(`repos/${github.fullName}/rulesets?includes_parents=false&targets=branch`);
  const mainRuleset = readGitHubRuleset(github, findGitHubRulesetSummary(rulesets, githubRulesetName(repositoryConfig.defaultBranch)));
  const proposalRuleset = readGitHubRuleset(github, findGitHubRulesetSummary(rulesets, githubReviewRulesetName("proposal")));
  const rejectedRuleset = readGitHubRuleset(github, findGitHubRulesetSummary(rulesets, githubReviewRulesetName("rejected")));
  const stateRuleset = readGitHubRuleset(github, findGitHubRulesetSummary(rulesets, githubReviewRulesetName("state")));
  const mainInspected = inspectGitHubRuleset(mainRuleset, repositoryConfig.defaultBranch);
  const proposalInspected = inspectGitHubReviewRuleset(proposalRuleset, repositoryConfig, "proposal");
  const rejectedInspected = inspectGitHubReviewRuleset(rejectedRuleset, repositoryConfig, "rejected");
  const stateInspected = inspectGitHubReviewRuleset(stateRuleset, repositoryConfig, "state");
  const deployKeys = runGitHubApi(`repos/${github.fullName}/keys?per_page=100`);
  const agentGit = inspectSharedAgentGit(repository, github, gitRoots, deployKeys);
  const checks = {
    ...prefixedChecks("main", mainInspected.checks),
    ...prefixedChecks("proposal", proposalInspected.checks),
    ...prefixedChecks("rejected", rejectedInspected.checks),
    ...prefixedChecks("state", stateInspected.checks),
    ...agentGit.checks,
  };
  return writeGitHubSecurityState(repository, {
    verified: Object.values(checks).every(Boolean),
    checkedAt: new Date().toISOString(),
    repository: github.fullName,
    defaultBranch: repositoryConfig.defaultBranch,
    rulesetId: mainRuleset?.id || null,
    rulesetIds: {
      main: mainRuleset?.id || null,
      proposal: proposalRuleset?.id || null,
      rejected: rejectedRuleset?.id || null,
      state: stateRuleset?.id || null,
    },
    rulesetUrl: mainRuleset?._links?.html?.href || `https://github.com/${github.fullName}/settings/rules`,
    deployKeyId: agentGit.deployKey?.id || null,
    agentCredential: agentGit.credential,
    checks,
  });
}

export function secureSharedGitHubRepository(root) {
  const { repository, repositoryConfig, gitRoots } = sharedSecurityTarget(root);
  const github = githubRepositoryCoordinates(repository);
  const rulesets = runGitHubApi(`repos/${github.fullName}/rulesets?includes_parents=false&targets=branch`);
  const payloads = [
    githubRulesetPayload(repositoryConfig.defaultBranch),
    githubReviewRulesetPayload(repositoryConfig, "proposal"),
    githubReviewRulesetPayload(repositoryConfig, "rejected"),
    githubReviewRulesetPayload(repositoryConfig, "state"),
  ];
  let createdRulesets = 0;
  let updatedRulesets = 0;
  for (const payload of payloads) {
    const existing = findGitHubRulesetSummary(rulesets, payload.name);
    if (existing?.id) {
      runGitHubApi(`repos/${github.fullName}/rulesets/${existing.id}`, { method: "PUT", body: payload });
      updatedRulesets += 1;
    } else {
      runGitHubApi(`repos/${github.fullName}/rulesets`, { method: "POST", body: payload });
      createdRulesets += 1;
    }
  }
  const credential = ensureSharedAgentCredential(repository);
  const deployKeys = runGitHubApi(`repos/${github.fullName}/keys?per_page=100`);
  let deployKey = (deployKeys || []).find((item) => (
    item.title === credential.title
    && normalizedSshPublicKey(item.key) === normalizedSshPublicKey(credential.key)
  ));
  if (deployKey?.read_only) throw new Error(`GitHub deploy key ${credential.title} exists but is read-only`);
  if (!deployKey) {
    deployKey = runGitHubApi(`repos/${github.fullName}/keys`, {
      method: "POST",
      body: { title: credential.title, key: credential.key, read_only: false },
    });
  }
  configureSharedAgentGit(repository, github, gitRoots);
  const result = checkSharedGitHubSecurity(root);
  if (!result.verified) throw new Error("GitHub created the ruleset but its effective security checks did not pass");
  return {
    ...result,
    rulesetCreated: createdRulesets > 0,
    rulesetUpdated: updatedRulesets > 0,
    createdRulesets,
    updatedRulesets,
    deployKeyId: deployKey.id || result.deployKeyId,
  };
}

function proposalScopePrefixes(config, projectId, scope, options = {}) {
  if (scope === "global") return [config.globalSkillsPath.replace(/\/$/, "") + "/"];
  if (scope === "skills") {
    let locations = options.locations || null;
    if (!locations && options.root) {
      const catalog = options.catalog || normalizedProjectsCatalog(readJson(path.join(options.root, config.projectsFile)));
      ({ skillLocations: locations } = readValidatedSharedLocationsFromRoot(options.root, config, catalog));
    }
    if (!locations && options.checkout && options.revision) {
      const catalog = options.catalog || normalizedProjectsCatalog(JSON.parse(String(runGit(options.checkout, ["show", `${options.revision}:${config.projectsFile}`]))));
      ({ skillLocations: locations } = readValidatedSharedLocationsFromRevision(options.checkout, options.revision, config, catalog));
    }
    return (locations?.collections || []).map((collection) => collection.path.replace(/\/$/, "") + "/");
  }
  if (scope === "instructions") {
    let locations = options.instructionLocations || null;
    if (!locations && options.root) {
      const catalog = options.catalog || normalizedProjectsCatalog(readJson(path.join(options.root, config.projectsFile)));
      ({ instructionLocations: locations } = readValidatedSharedLocationsFromRoot(options.root, config, catalog));
    }
    if (!locations && options.checkout && options.revision) {
      const catalog = options.catalog || normalizedProjectsCatalog(JSON.parse(String(runGit(options.checkout, ["show", `${options.revision}:${config.projectsFile}`]))));
      ({ instructionLocations: locations } = readValidatedSharedLocationsFromRevision(options.checkout, options.revision, config, catalog));
    }
    return (locations?.collections || []).map((collection) => collection.path.replace(/\/$/, "") + "/");
  }
  if (scope !== "project") throw new Error("Proposal scope must be project, global, skills, or instructions");
  const projectRoot = `${config.projectsPath.replace(/\/$/, "")}/${safeId(projectId, "projectId")}`;
  return [`${projectRoot}/docs/`, `${projectRoot}/skills/`];
}

function sharedProjectCatalogText(config, options = {}, { accepted = false } = {}) {
  const cwd = options.root || options.checkout || "";
  if (!cwd) return "";
  if (accepted) {
    return String(tryGit(cwd, ["show", `refs/remotes/origin/${config.defaultBranch}:${config.projectsFile}`]) || "");
  }
  if (options.root) {
    try { return fs.readFileSync(path.join(options.root, config.projectsFile), "utf8"); } catch { return ""; }
  }
  if (options.checkout && options.revision) {
    try { return String(runGit(options.checkout, ["show", `${options.revision}:${config.projectsFile}`])); } catch { return ""; }
  }
  return "";
}

function projectCreationProposalPolicy(config, projectId, options = {}) {
  const proposedText = sharedProjectCatalogText(config, options);
  if (!proposedText) return null;
  let proposedRaw;
  let proposedCatalog;
  try {
    proposedRaw = JSON.parse(proposedText);
    proposedCatalog = normalizedProjectsCatalog(proposedRaw);
  } catch {
    return null;
  }
  let acceptedCatalog = options.catalog || null;
  const acceptedText = sharedProjectCatalogText(config, options, { accepted: true });
  let acceptedRaw = null;
  if (acceptedText) {
    try { acceptedRaw = JSON.parse(acceptedText); } catch { return null; }
  }
  if (!acceptedCatalog && acceptedText) {
    try { acceptedCatalog = normalizedProjectsCatalog(acceptedRaw); } catch {}
  }
  if (!acceptedCatalog) return null;
  const acceptedProject = acceptedCatalog.projects.find((project) => project.id === projectId) || null;
  const proposedProject = proposedCatalog.projects.find((project) => project.id === projectId) || null;
  if (!proposedProject) return null;

  // An existing project's proposal never gains catalog authority unless its
  // projects.json is byte-for-byte the current accepted catalog. This keeps a
  // concurrent creation visible after another identical proposal lands while
  // still rejecting catalog edits from ordinary project proposals.
  if (acceptedProject) {
    if (!acceptedText || proposedText.trimEnd() !== acceptedText.trimEnd()) return null;
    return {
      createsProject: false,
      projectTitle: acceptedProject.title,
      projectPath: `${config.projectsPath}/${projectId}`,
    };
  }

  // A creation proposal may append exactly one source-less project entry. It
  // cannot rename, reorder, delete, or remap any accepted project.
  if (!acceptedRaw) return null;
  if (proposedCatalog.projects.length !== acceptedCatalog.projects.length + 1) return null;
  if (proposedCatalog.projects.at(-1)?.id !== projectId || proposedProject.source) return null;
  const acceptedPrefix = proposedCatalog.projects.slice(0, -1);
  if (JSON.stringify(acceptedPrefix) !== JSON.stringify(acceptedCatalog.projects)) return null;
  const appendedRaw = proposedRaw.projects?.at(-1);
  if (!appendedRaw
    || JSON.stringify(Object.keys(appendedRaw).sort()) !== JSON.stringify(["id", "title"])
    || appendedRaw.id !== projectId
    || appendedRaw.title !== proposedProject.title) return null;
  const exactAppend = { ...acceptedRaw, projects: [...acceptedRaw.projects, appendedRaw] };
  if (JSON.stringify(proposedRaw) !== JSON.stringify(exactAppend)) return null;
  return {
    createsProject: true,
    projectTitle: proposedProject.title,
    projectPath: `${config.projectsPath}/${projectId}`,
  };
}

function proposalIdentity(config, branch, options = {}) {
  const safeBranch = safeBranchName(branch, "proposal branch");
  if (!safeBranch.startsWith(config.proposalPrefix)) throw new Error(`Proposal branch must start with ${config.proposalPrefix}`);
  const suffix = safeBranch.slice(config.proposalPrefix.length);
  const segments = suffix.split("/");
  if (segments.length < 2 || !segments.slice(1).join("/")) throw new Error("Proposal branch must include a scope and proposal name");
  const scopeId = safeId(segments[0], "proposal scope");
  const scope = scopeId === "global" ? "global" : scopeId === "skills" ? "skills" : scopeId === "instructions" ? "instructions" : "project";
  const projectCreation = scope === "project" ? projectCreationProposalPolicy(config, scopeId, options) : null;
  return {
    branch: safeBranch,
    projectId: scopeId,
    scope,
    allowedExact: scope === "skills"
      ? [config.skillLocationsFile]
      : scope === "instructions"
        ? [config.instructionLocationsFile]
        : projectCreation?.createsProject === true
          ? [config.projectsFile]
          : [],
    allowedPrefixes: projectCreation?.createsProject === true
      ? [`${projectCreation.projectPath}/docs/`]
      : proposalScopePrefixes(config, scopeId, scope, options),
    ...(projectCreation || {}),
  };
}

function assertPathsInProposalScope(files, policy) {
  const outside = files.filter((file) => !(policy.allowedExact || []).includes(file) && !policy.allowedPrefixes.some((prefix) => file.startsWith(prefix)));
  if (!outside.length) return;
  const message = ["project", "global"].includes(policy.scope)
    ? `Proposal changes files outside ${policy.allowedPrefixes.join(" or ")}: ${outside.join(", ")}`
    : `Proposal changes files outside its allowed shared manifest or collections: ${outside.join(", ")}`;
  const error = new Error(message);
  error.code = "shared-proposal-scope-violation";
  error.statusCode = 403;
  throw error;
}

function assertProjectCreationProposalBundle(files, policy) {
  if (policy.createsProject !== true) return;
  const changed = [...new Set((files || []).map((filePath) => safeRelativePath(filePath, "shared project proposal path")))];
  const catalogPath = (policy.allowedExact || [])[0] || "";
  const documentPrefix = `${policy.projectPath}/docs/`;
  const documents = changed.filter((filePath) => filePath.startsWith(documentPrefix) && filePath.toLowerCase().endsWith(".md"));
  if (changed.length === 2 && catalogPath && changed.includes(catalogPath) && documents.length === 1) return;
  const error = new Error(`A Shared project creation proposal must change exactly ${catalogPath || "projects.json"} and one Markdown file below ${documentPrefix}`);
  error.code = "shared-proposal-scope-violation";
  error.statusCode = 403;
  throw error;
}

function proposalBranch(config, projectId, title, scope, explicit = "") {
  const scopeId = scope === "global" || scope === "skills" || scope === "instructions" ? scope : safeId(projectId, "projectId");
  if (!['project', 'global', 'skills', 'instructions'].includes(scope)) throw new Error("Proposal scope must be project, global, skills, or instructions");
  if (explicit) {
    const identity = proposalIdentity(config, explicit);
    if (identity.projectId !== scopeId) throw new Error(`Proposal branch scope must be ${config.proposalPrefix}${scopeId}/`);
    return identity.branch;
  }
  const slug = String(title || "change").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "change";
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  const uniqueSuffix = randomUUID().replaceAll("-", "");
  return `${config.proposalPrefix}${scopeId}/${stamp}-${slug}-${uniqueSuffix}`;
}

function proposalRegistryPath(repository) {
  return path.join(repositoryCacheRoot(repository), "proposals.json");
}

function proposalRegistryLockPath(repository) {
  return `${proposalRegistryPath(repository)}.lock`;
}

function withProposalRegistryLock(repository, operation, options = {}) {
  return withFilesystemLock(proposalRegistryLockPath(repository), operation, {
    timeoutMs: Number.isFinite(Number(options.timeoutMs))
      ? Math.max(1, Math.floor(Number(options.timeoutMs)))
      : PROPOSAL_REGISTRY_LOCK_TIMEOUT_MS,
    staleMs: PROPOSAL_REGISTRY_LOCK_STALE_MS,
    busyMessage: String(options.busyMessage || "Shared proposal registry is busy in another process"),
    busyCode: String(options.busyCode || "shared_proposal_registry_busy"),
  });
}

const TERMINAL_PROPOSAL_REGISTRY_LOCK_OPTIONS = Object.freeze({
  timeoutMs: 50,
  busyMessage: "Another proposal mutation or terminal decision is already in progress",
  busyCode: "shared-terminal-decision-busy",
});

function readProposalRegistry(repository) {
  const registry = readJson(proposalRegistryPath(repository), { version: 1, proposals: {} });
  if (!registry || registry.version !== 1 || !registry.proposals || typeof registry.proposals !== "object" || Array.isArray(registry.proposals)) {
    throw new Error("Shared proposal registry is invalid");
  }
  return registry;
}

function writeProposalRegistry(repository, registry) {
  return writePrivateJson(proposalRegistryPath(repository), {
    version: 1,
    proposals: registry.proposals || {},
  });
}

function proposalBranchInUse(checkout, repository, registry, branch) {
  return Boolean(
    registry.proposals?.[branch]
    || fs.existsSync(path.join(repositoryCacheRoot(repository), "proposals", hashKey(branch)))
    || tryGit(checkout, ["show-ref", "--verify", `refs/heads/${branch}`])
    || tryGit(checkout, ["show-ref", "--verify", `refs/remotes/origin/${branch}`])
  );
}

function availableProposalBranch(config, projectId, title, scope, explicit, checkout, repository, registry) {
  const base = proposalBranch(config, projectId, title, scope, explicit);
  if (explicit) return base;
  let candidate = base;
  for (let suffix = 2; proposalBranchInUse(checkout, repository, registry, candidate); suffix += 1) {
    candidate = safeBranchName(`${base}-${suffix}`, "proposal branch");
  }
  return candidate;
}

function proposalObservationsPath(repository) {
  return path.join(repositoryCacheRoot(repository), "proposal-observations.json");
}

function proposalObservationsLockPath(repository) {
  return path.join(sharedHome(), "locks", `observations-${hashKey(sharedRepositoryIdentity(repository), 24)}.lock`);
}

function withProposalObservationsLock(repository, operation) {
  return withFilesystemLock(proposalObservationsLockPath(repository), operation, {
    timeoutMs: PROPOSAL_REGISTRY_LOCK_TIMEOUT_MS,
    staleMs: PROPOSAL_REGISTRY_LOCK_STALE_MS,
    busyMessage: "Shared proposal observations are busy in another process",
    busyCode: "shared_proposal_observations_busy",
  });
}

function proposalDecisionAuthorityOptions(repository) {
  return {
    authorityHome: path.join(sharedHome(), "review-authority"),
    repositoryIdentity: sharedRepositoryIdentity(repository),
  };
}

function observedProposalValue(item, state = "active") {
  return {
    branch: String(item.branch || ""),
    projectId: String(item.projectId || ""),
    scope: String(item.scope || "project"),
    repository: String(item.repository || ""),
    repositoryName: String(item.repositoryName || ""),
    projectTitle: String(item.projectTitle || ""),
    createsProject: item.createsProject === true,
    projectPath: String(item.projectPath || ""),
    head: String(item.head || ""),
    baseRevision: String(item.baseRevision || ""),
    updatedAt: String(item.updatedAt || ""),
    author: item.author || { name: "", email: "" },
    title: String(item.title || item.branch || "Shared context proposal"),
    description: String(item.description || ""),
    sessionId: String(item.sessionId || ""),
    sourceRemote: String(item.sourceRemote || ""),
    sourceBranch: String(item.sourceBranch || ""),
    sourceCommit: String(item.sourceCommit || ""),
    semanticReviewRequired: Boolean(item.semanticReviewRequired),
    files: Array.isArray(item.files) ? item.files.map(String) : [],
    fileCount: Number(item.fileCount || item.files?.length || 0),
    state,
    lastSeenAt: new Date().toISOString(),
  };
}

function readProposalObservations(repository) {
  const repositoryIdentity = sharedRepositoryIdentity(repository);
  const state = readJson(proposalObservationsPath(repository), { version: 1, repository, repositoryIdentity, proposals: {} });
  let stateIdentity = String(state?.repositoryIdentity || "");
  if (!stateIdentity && state?.repository) {
    try { stateIdentity = sharedRepositoryIdentity(state.repository); } catch {}
  }
  if (state?.version !== 1 || stateIdentity !== repositoryIdentity || !state.proposals || typeof state.proposals !== "object") {
    return { version: 1, repository, repositoryIdentity, proposals: {} };
  }
  const proposals = Object.fromEntries(Object.entries(state.proposals).map(([branch, proposal]) => [
    branch,
    { ...proposal, repository },
  ]));
  return { ...state, repository, repositoryIdentity, proposals };
}

function writeProposalObservations(repository, state) {
  return writePrivateJson(proposalObservationsPath(repository), {
    version: 1,
    repository,
    repositoryIdentity: sharedRepositoryIdentity(repository),
    proposals: state.proposals || {},
    updatedAt: new Date().toISOString(),
  });
}

function rememberProposalObservation(repository, item, state = "active") {
  return withProposalObservationsLock(repository, () => {
    const observations = readProposalObservations(repository);
    observations.proposals[item.branch] = observedProposalValue(item, state);
    return writeProposalObservations(repository, observations);
  });
}

function sharedProjectRepositoryState(repository, projectId, options = {}) {
  const synced = syncSharedRepositoryState(repository, {
    allowOffline: false,
    timeoutMs: options.timeoutMs,
    push: options.push || null,
  });
  const normalizedProjectId = safeId(projectId, "projectId");
  const project = synced.catalog.projects.find((item) => item.id === normalizedProjectId);
  if (!project) throw new Error(`Shared project is not registered in ${synced.repositoryConfig.projectsFile}: ${normalizedProjectId}`);
  return {
    ...synced,
    connection: {
      repository: synced.connection.repository,
      projectId: normalizedProjectId,
      projectRoot: "",
    },
  };
}

function createSharedProposalFromStateLocked(synced, { sourceRoot = "", title, description = "", scope = "project", branch = "", sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const { connection, repositoryConfig, revision } = synced;
  const safeTitle = proposalTitle(title);
  const safeDescription = proposalDescription(description);
  const checkout = repositoryCheckout(connection.repository);
  const registry = readProposalRegistry(connection.repository);
  const proposal = availableProposalBranch(
    repositoryConfig,
    connection.projectId,
    safeTitle,
    scope,
    branch,
    checkout,
    connection.repository,
    registry,
  );
  const acceptedCandidate = sharedMainAcceptanceCandidates(synced, checkout).get(proposal) || null;
  if (acceptedCandidate) {
    throw sharedContextError(
      "shared-proposal-terminal",
      "An accepted proposal branch identifier cannot be reused",
      {
        proposal,
        proposalHead: acceptedCandidate.proposalHead,
        reviewStatus: "accepted",
        acceptedCommit: acceptedCandidate.commit,
      },
    );
  }
  const existingRemoteHead = remoteBranchRevision(checkout, proposal);
  const existingRemoteState = checkedRemoteProposalState(checkout, proposal, existingRemoteHead);
  if (
    existingRemoteHead
    || existingRemoteState.status !== "missing"
    || proposalBranchInUse(checkout, connection.repository, registry, proposal)
  ) {
    throw sharedContextError(
      "shared-proposal-branch-in-use",
      `Proposal branch identifier is already in use: ${proposal}`,
      {
        proposal,
        proposalHead: existingRemoteHead || existingRemoteState.proposalHead || "",
        reviewStatus: existingRemoteState.status,
        stateRef: existingRemoteState.ref || "",
      },
    );
  }
  const proposalRoot = path.join(repositoryCacheRoot(connection.repository), "proposals", hashKey(proposal));
  if (fs.existsSync(proposalRoot)) throw new Error(`Proposal workspace already exists: ${proposalRoot}`);
  const resolvedSourceRoot = connection.projectRoot || (sourceRoot ? path.resolve(sourceRoot) : "");
  const source = resolvedSourceRoot ? sourceIdentity(resolvedSourceRoot) : null;
  const sourceCommit = resolvedSourceRoot ? tryGit(resolvedSourceRoot, ["rev-parse", "HEAD"]) : "";
  const sourceBranch = resolvedSourceRoot ? tryGit(resolvedSourceRoot, ["branch", "--show-current"]) : "";
  runGit(checkout, ["worktree", "add", "-b", proposal, proposalRoot, revision], { stdio: ["ignore", "ignore", "pipe"] });
  registry.proposals[proposal] = {
    branch: proposal,
    root: proposalRoot,
    baseRevision: revision,
    projectId: connection.projectId,
    scope,
    title: safeTitle,
    description: safeDescription,
    sourceRoot: resolvedSourceRoot ? stableRoot(resolvedSourceRoot) : "",
    sourceRemote: source?.remotes?.[0] || "",
    sourceBranch,
    sourceCommit: /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sourceCommit) ? sourceCommit : "",
    sessionId: safeSessionId(sessionId),
    createdAt: new Date().toISOString(),
  };
  writeProposalRegistry(connection.repository, registry);
  return registry.proposals[proposal];
}

function discardUnpublishedSharedProposalLocked(synced, proposal) {
  const checkout = repositoryCheckout(synced.connection.repository);
  let removalError = null;
  try {
    runGit(checkout, ["worktree", "remove", "--force", proposal.root], { stdio: ["ignore", "ignore", "ignore"] });
  } catch (error) {
    removalError = error;
  }
  const registeredWorktrees = runGit(checkout, ["worktree", "list", "--porcelain"])
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => path.resolve(line.slice("worktree ".length)));
  if (removalError || lstatIfPresent(proposal.root) || registeredWorktrees.includes(path.resolve(proposal.root))) {
    throw sharedContextError(
      "filesystem_recovery_required",
      "The unsafe unpublished proposal could not be removed; its registry entry was preserved for recovery",
      { proposal: proposal.branch, root: proposal.root },
    );
  }
  try {
    runGit(checkout, ["branch", "-D", proposal.branch], { stdio: ["ignore", "ignore", "pipe"] });
  } catch (error) {
    if (tryGit(checkout, ["show-ref", "--verify", `refs/heads/${proposal.branch}`])) {
      throw sharedContextError(
        "filesystem_recovery_required",
        "The unsafe unpublished proposal branch could not be removed; its registry entry was preserved for recovery",
        { proposal: proposal.branch, root: proposal.root },
      );
    }
  }
  const registry = readProposalRegistry(synced.connection.repository);
  if (registry.proposals?.[proposal.branch]?.root === proposal.root) {
    delete registry.proposals[proposal.branch];
    writeProposalRegistry(synced.connection.repository, registry);
  }
}

export function createSharedProposal(root, options = {}) {
  const synced = syncSharedContext(root, {
    allowOffline: false,
    timeoutMs: options.timeoutMs,
    push: options.push || null,
  });
  return withProposalRegistryLock(synced.connection.repository, () => (
    createSharedProposalFromStateLocked(synced, { ...options, sourceRoot: root })
  ));
}

function proposalScopeId(connection, scope) {
  if (scope === "global" || scope === "skills" || scope === "instructions") return scope;
  if (scope !== "project") throw new Error("Proposal scope must be project, global, skills, or instructions");
  return safeId(connection.projectId, "projectId");
}

function proposalSessionMatches(entry, connection, scope, sessionId) {
  return entry
    && safeSessionId(entry.sessionId) === sessionId
    && String(entry.scope || "project") === scope
    && String(["global", "skills", "instructions"].includes(entry.scope) ? entry.scope : entry.projectId) === proposalScopeId(connection, scope);
}

function remoteBranchRevision(checkout, branch) {
  const safeBranch = safeBranchName(branch, "proposal branch");
  const revision = tryGit(checkout, ["rev-parse", `refs/remotes/origin/${safeBranch}^{commit}`]);
  return revision ? safeRevision(revision, "proposal head") : "";
}

function proposalStateBranch(proposal) {
  const branch = safeBranchName(proposal, "proposal branch");
  return safeBranchName(`${SHARED_PROPOSAL_STATE_PREFIX}${hashKey(branch, 64)}`, "proposal state branch");
}

function proposalStateRef(proposal) {
  return `refs/heads/${proposalStateBranch(proposal)}`;
}

function proposalTerminalMarkerCommit(checkout, {
  proposal,
  proposalHead,
  decision,
  acceptedCommit = "",
  archiveRef = "",
} = {}) {
  const branch = safeBranchName(proposal, "proposal branch");
  const head = safeRevision(proposalHead, "proposal head");
  const outcome = String(decision || "").trim();
  if (!new Set(["accepted", "rejected"]).has(outcome)) throw new Error("Terminal proposal marker decision must be accepted or rejected");
  const accepted = outcome === "accepted" ? safeRevision(acceptedCommit, "accepted commit") : "";
  const archive = outcome === "rejected" ? safeBranchName(archiveRef, "rejection branch") : "";
  const tree = safeRevision(tryGit(checkout, ["rev-parse", `${head}^{tree}`]), "proposal tree");
  const trailers = [
    `Context-Room-Terminal-Decision: ${outcome}`,
    `Context-Room-Proposal: ${branch}`,
    `Context-Room-Proposal-Head: ${head}`,
    accepted ? `Context-Room-Accepted-Commit: ${accepted}` : "",
    archive ? `Context-Room-Rejection-Archive: ${archive}` : "",
  ].filter(Boolean).join("\n");
  const message = `Context Room terminal proposal decision: ${outcome}\n\n${trailers}`;
  return safeRevision(runGit(checkout, ["commit-tree", tree, "-p", head, "-m", message], {
    env: {
      GIT_AUTHOR_NAME: "Context Room",
      GIT_AUTHOR_EMAIL: ["context-room", "localhost"].join("@"),
      GIT_COMMITTER_NAME: "Context Room",
      GIT_COMMITTER_EMAIL: ["context-room", "localhost"].join("@"),
    },
  }), "terminal proposal marker");
}

function remoteProposalState(checkout, proposal, currentProposalHead = "") {
  const branch = safeBranchName(proposal, "proposal branch");
  const currentHead = currentProposalHead ? safeRevision(currentProposalHead, "current proposal head") : "";
  const stateBranch = proposalStateBranch(branch);
  const stateRef = `refs/heads/${stateBranch}`;
  const stateHead = remoteBranchRevision(checkout, stateBranch);
  if (!stateHead) return { status: "missing", branch: stateBranch, ref: stateRef, head: "" };
  if (currentHead && stateHead === currentHead) {
    return { status: "active", branch: stateBranch, ref: stateRef, head: stateHead, proposalHead: stateHead };
  }
  try {
    const trailers = commitTrailerMap(checkout, stateHead);
    const markerProposal = safeBranchName(trailers["Context-Room-Proposal"], "terminal marker proposal");
    const markerProposalHead = safeRevision(trailers["Context-Room-Proposal-Head"], "terminal marker proposal head");
    const decision = String(trailers["Context-Room-Terminal-Decision"] || "").trim();
    const ancestry = tryGit(checkout, ["rev-list", "--parents", "-n", "1", stateHead]).split(/\s+/).filter(Boolean);
    const markerTree = safeRevision(tryGit(checkout, ["rev-parse", `${stateHead}^{tree}`]), "terminal marker tree");
    const proposalTree = safeRevision(tryGit(checkout, ["rev-parse", `${markerProposalHead}^{tree}`]), "terminal marker proposal tree");
    if (
      markerProposal !== branch
      || (currentHead && markerProposalHead !== currentHead)
      || !new Set(["accepted", "rejected"]).has(decision)
      || ancestry.length !== 2
      || ancestry[0] !== stateHead
      || ancestry[1] !== markerProposalHead
      || markerTree !== proposalTree
    ) {
      throw new Error("Terminal proposal marker binding is invalid");
    }
    const acceptedCommit = decision === "accepted"
      ? safeRevision(trailers["Context-Room-Accepted-Commit"], "terminal marker accepted commit")
      : "";
    const archiveRef = decision === "rejected"
      ? safeBranchName(trailers["Context-Room-Rejection-Archive"], "terminal marker rejection archive")
      : "";
    return {
      status: decision,
      branch: stateBranch,
      ref: stateRef,
      head: stateHead,
      proposalHead: markerProposalHead,
      acceptedCommit,
      archiveRef,
    };
  } catch (error) {
    if (!currentHead || stateHead !== currentHead) {
      return {
        status: "invalid",
        branch: stateBranch,
        ref: stateRef,
        head: stateHead,
        proposalHead: "",
        error: String(error.message || error),
      };
    }
    return { status: "active", branch: stateBranch, ref: stateRef, head: stateHead, proposalHead: stateHead };
  }
}

function checkedRemoteProposalState(checkout, proposal, proposalHead) {
  const branch = safeBranchName(proposal, "proposal branch");
  const head = proposalHead ? safeRevision(proposalHead, "proposal head") : "";
  const state = remoteProposalState(checkout, branch, head);
  if (state.status !== "invalid") return state;
  throw terminalProposalError(
    "shared-proposal-terminal-conflict",
    "The remote proposal state ref is not bound to the current exact proposal revision",
    branch,
    head,
    { stateRef: state.ref, stateHead: state.head },
  );
}

function remoteProposalStateIsTerminal(state) {
  return new Set(["accepted", "rejected"]).has(state?.status);
}

function remoteRefLease(ref, expected = "") {
  const safeRef = String(ref || "").trim();
  if (!safeRef.startsWith("refs/heads/")) throw new Error(`Unsafe remote lease ref: ${safeRef}`);
  const expectedHead = expected ? safeRevision(expected, "expected remote ref head") : "";
  return `--force-with-lease=${safeRef}:${expectedHead}`;
}

function atomicPushArguments(remote, updates) {
  const normalized = updates.map((update) => {
    const ref = String(update.ref || "").trim();
    if (!ref.startsWith("refs/heads/")) throw new Error(`Unsafe atomic push ref: ${ref}`);
    const source = safeRevision(update.source, "atomic push source");
    return {
      ref,
      expected: update.expected ? safeRevision(update.expected, "expected atomic push head") : "",
      refspec: `${update.force ? "+" : ""}${source}:${ref}`,
    };
  });
  return [
    "push",
    "--atomic",
    ...normalized.map((update) => remoteRefLease(update.ref, update.expected)),
    String(remote || "origin"),
    ...normalized.map((update) => update.refspec),
  ];
}

function atomicPushUnsupported(error) {
  return /(?:does not support|doesn't support).*atomic|atomic push.*not supported/i.test(String(error?.stderr || error?.message || error));
}

function throwAtomicPushError(error, operation) {
  if (!atomicPushUnsupported(error)) throw error;
  throw sharedContextError(
    "shared-atomic-push-unsupported",
    `${operation} requires a remote that supports atomic Git ref updates`,
  );
}

function ensureProposalWorktree(checkout, repository, proposal) {
  const proposalRoot = path.join(repositoryCacheRoot(repository), "proposals", hashKey(proposal.branch));
  if (fs.existsSync(proposalRoot)) {
    const actualHead = tryGit(proposalRoot, ["rev-parse", "HEAD"]);
    if (!actualHead) throw new Error(`Proposal workspace is not a Git worktree: ${proposalRoot}`);
    return proposalRoot;
  }
  fs.mkdirSync(path.dirname(proposalRoot), { recursive: true });
  const localHead = tryGit(checkout, ["rev-parse", `refs/heads/${proposal.branch}^{commit}`]);
  if (localHead && safeRevision(localHead, "local proposal head") !== proposal.head) {
    throw new Error(`Local proposal branch diverges from origin/${proposal.branch}; resolve it before resuming this session`);
  }
  if (localHead) {
    runGit(checkout, ["worktree", "add", proposalRoot, proposal.branch], { stdio: ["ignore", "ignore", "pipe"] });
  } else {
    runGit(checkout, ["worktree", "add", "-b", proposal.branch, proposalRoot, proposal.head], { stdio: ["ignore", "ignore", "pipe"] });
  }
  return proposalRoot;
}

function proposalRegistryEntryFromRemote(proposal, proposalRoot) {
  return {
    branch: proposal.branch,
    root: proposalRoot,
    baseRevision: proposal.baseRevision,
    projectId: proposal.projectId,
    scope: proposal.scope,
    title: proposal.title,
    description: proposal.description,
    sourceRemote: proposal.sourceRemote || "",
    sourceBranch: proposal.sourceBranch || "",
    sourceCommit: proposal.sourceCommit || "",
    sessionId: proposal.sessionId,
    createdAt: proposal.createdAt || proposal.updatedAt || new Date().toISOString(),
    updatedAt: proposal.updatedAt || new Date().toISOString(),
    lastPublishedHead: proposal.head,
  };
}

export function ensureSharedProposal(root, {
  title,
  description = "",
  scope = "project",
  branch = "",
  sessionId = process.env.CODEX_THREAD_ID || "",
  push = null,
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
} = {}) {
  const normalizedSession = safeSessionId(sessionId);
  const normalizedTitle = proposalTitle(title);
  const normalizedDescription = proposalDescription(description);
  if (!normalizedSession || branch) {
    return { ...createSharedProposal(root, {
      title: normalizedTitle,
      description: normalizedDescription,
      scope,
      branch,
      sessionId: normalizedSession,
      push,
      timeoutMs,
    }), reused: false };
  }
  const synced = syncSharedContext(root, { allowOffline: false, push, timeoutMs });
  return withProposalRegistryLock(synced.connection.repository, () => {
    const { connection } = synced;
    const registry = readProposalRegistry(connection.repository);
    const checkout = repositoryCheckout(connection.repository);
    const remoteProposals = listRemoteSharedProposals(synced);
    const terminalBranches = new Set(remoteProposals
      .filter((proposal) => ["accepted", "merged", "rejected", "unverified_rejection"].includes(proposal.reviewStatus))
      .map((proposal) => proposal.branch));
    const localMatches = Object.values(registry.proposals || {}).filter((entry) => (
      proposalSessionMatches(entry, connection, scope, normalizedSession)
      && fs.existsSync(entry.root)
      && !terminalBranches.has(entry.branch)
      && (() => {
        if (!entry.lastPublishedHead) return true;
        const remoteHead = remoteBranchRevision(checkout, entry.branch);
        if (!remoteHead) return false;
        return !remoteProposalStateIsTerminal(checkedRemoteProposalState(checkout, entry.branch, remoteHead));
      })()
    ));
    const remoteMatches = remoteProposals.filter((proposal) => (
      proposalSessionMatches(proposal, connection, scope, normalizedSession)
      && !proposal.authorityViolation
      && !["accepted", "merged", "rejected", "unverified_rejection"].includes(proposal.reviewStatus)
    ));
    const matches = new Map();
    for (const entry of localMatches) matches.set(entry.branch, { kind: "local", entry });
    for (const proposal of remoteMatches) matches.set(proposal.branch, { kind: "remote", proposal });
    if (matches.size > 1) {
      throw new Error(`Several open proposals match session ${normalizedSession} and scope ${proposalScopeId(connection, scope)}: ${[...matches.keys()].join(", ")}`);
    }
    const match = [...matches.values()][0];
    if (!match) {
      return {
        ...createSharedProposalFromStateLocked(synced, {
          sourceRoot: root,
          title: normalizedTitle,
          description: normalizedDescription,
          scope,
          sessionId: normalizedSession,
        }),
        reused: false,
      };
    }
    if (match.kind === "local") return { ...match.entry, reused: true };
    const proposalRoot = ensureProposalWorktree(checkout, connection.repository, match.proposal);
    const entry = proposalRegistryEntryFromRemote(match.proposal, proposalRoot);
    registry.proposals[entry.branch] = entry;
    writeProposalRegistry(connection.repository, registry);
    return { ...entry, reused: true };
  });
}

function proposalCommitMessage(entry, message) {
  const trailers = [
    `Context-Room-Title: ${proposalTitle(entry.title)}`,
    entry.description ? `Context-Room-Description-Base64: ${encodeProposalDescription(entry.description)}` : "",
    `Context-Room-Project: ${["global", "skills", "instructions"].includes(entry.scope) ? entry.scope : entry.projectId}`,
    `Context-Room-Base: ${entry.baseRevision}`,
    entry.sourceRemote ? `Context-Room-Source-Remote: ${entry.sourceRemote}` : "",
    entry.sourceBranch ? `Context-Room-Source-Branch: ${entry.sourceBranch}` : "",
    entry.sourceCommit ? `Context-Room-Source-Commit: ${entry.sourceCommit}` : "",
    entry.sessionId ? `Context-Room-Session: ${entry.sessionId}` : "",
    entry.semanticReviewRequired ? "Context-Room-Semantic-Review: required" : "",
  ].filter(Boolean);
  return `${String(message || entry.title || "Propose shared context changes").trim()}\n\n${trailers.join("\n")}`;
}

function proposalEntryForConnection(connection, branch) {
  const registry = readProposalRegistry(connection.repository);
  const entry = registry.proposals?.[branch];
  if (!entry || !fs.existsSync(entry.root)) throw new Error(`Unknown local proposal workspace: ${branch}`);
  return { connection, entry, registry };
}

function proposalEntry(root, branch) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding");
  return proposalEntryForConnection(connection, branch);
}

export function listSharedProposalWorkspaces(root, { sessionId = "", scope = "" } = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) return [];
  const selectedRoot = stableRoot(root);
  const registry = readJson(proposalRegistryPath(connection.repository), { version: 1, proposals: {} });
  const normalizedSession = safeSessionId(sessionId);
  return Object.values(registry.proposals || {}).flatMap((entry) => {
    if (!entry?.branch || !entry?.root || !fs.existsSync(entry.root)) return [];
    if (entry.sourceRoot && stableRoot(entry.sourceRoot) !== selectedRoot) return [];
    if (normalizedSession && safeSessionId(entry.sessionId) !== normalizedSession) return [];
    if (scope && String(entry.scope || "project") !== scope) return [];
    const status = tryGit(entry.root, ["status", "--porcelain=v1"]);
    const head = tryGit(entry.root, ["rev-parse", "HEAD"]);
    return [{
      ...entry,
      head,
      dirty: Boolean(status),
      conflict: Boolean(tryGit(entry.root, ["diff", "--name-only", "--diff-filter=U"])),
    }];
  }).sort((left, right) => String(right.updatedAt || right.createdAt || "").localeCompare(String(left.updatedAt || left.createdAt || "")));
}

function staleSharedProposalError(branch, expectedHead, actualHead) {
  const error = sharedContextError(
    "shared-proposal-stale",
    "Proposal changed after it was opened; refresh and reopen its current exact revision before continuing",
    { proposal: branch, expectedHead, actualHead },
  );
  error.statusCode = 409;
  error.retryable = true;
  return error;
}

function openSharedProposalWorkspaceFromStateLocked(synced, options = {}) {
  const { proposal, expectedHead } = options;
  const expectedHeadProvided = Object.prototype.hasOwnProperty.call(options, "expectedHead");
  const { connection, repositoryConfig } = synced;
  const branch = safeBranchName(String(proposal || "").trim(), "proposal branch");
  proposalIdentity(repositoryConfig, branch, {
    checkout: repositoryCheckout(connection.repository),
    revision: synced.revision,
    catalog: synced.catalog,
  });
  const checkout = repositoryCheckout(connection.repository);
  const currentRemoteHead = remoteBranchRevision(checkout, branch);
  const observedRemoteHead = expectedHeadProvided
    ? expectedHead
      ? safeRevision(expectedHead, "expected proposal head")
      : ""
    : currentRemoteHead;
  const terminalState = checkedRemoteProposalState(checkout, branch, currentRemoteHead);
  if (remoteProposalStateIsTerminal(terminalState)) {
    throw sharedContextError(
      "shared-proposal-terminal",
      `A ${terminalState.status} proposal cannot be reopened`,
      { proposal: branch, proposalHead: terminalState.proposalHead, reviewStatus: terminalState.status, stateRef: terminalState.ref },
    );
  }
  const acceptedMainCandidate = sharedMainAcceptanceCandidates(synced, checkout).get(branch) || null;
  if (acceptedMainCandidate) {
    throw sharedContextError(
      "shared-proposal-terminal",
      "A proposal branch identifier already recorded on shared main cannot be reopened",
      {
        proposal: branch,
        proposalHead: acceptedMainCandidate.proposalHead,
        reviewStatus: "accepted",
        acceptedCommit: acceptedMainCandidate.commit,
      },
    );
  }
  if (expectedHeadProvided && observedRemoteHead !== currentRemoteHead) {
    throw staleSharedProposalError(branch, observedRemoteHead, currentRemoteHead);
  }
  const registry = readProposalRegistry(connection.repository);
  const remote = listRemoteSharedProposals(synced, { requiredProposal: branch }).find((entry) => entry.branch === branch) || null;
  if (remote && ["accepted", "merged", "rejected", "unverified_rejection"].includes(remote.reviewStatus)) {
    throw sharedContextError(
      "shared-proposal-terminal",
      `A ${remote.reviewStatus} proposal cannot be reopened`,
      { proposal: branch, proposalHead: remote.head, reviewStatus: remote.reviewStatus },
    );
  }
  const remoteHead = remote?.head || remoteBranchRevision(checkout, branch);
  if (!remote && remoteHead) {
    const rejection = proposalRejectionEvidence(
      synced,
      checkout,
      branch,
      remoteHead,
      ownerProposalDecisionIndex(connection.repository),
    );
    if (rejection.verified) {
      throw sharedContextError(
        "shared-proposal-terminal",
        "A rejected proposal cannot be reopened",
        { proposal: branch, proposalHead: remoteHead, reviewStatus: "rejected" },
      );
    }
  }
  let entry = registry.proposals?.[branch] || null;
  if (!entry && !remote) throw new Error(`Open proposal not found: ${branch}`);
  if (!entry) entry = proposalRegistryEntryFromRemote(remote, ensureProposalWorktree(checkout, connection.repository, remote));
  if (!fs.existsSync(entry.root)) {
    const head = remote?.head || tryGit(checkout, ["rev-parse", `refs/heads/${branch}^{commit}`]);
    if (!head) throw new Error(`Proposal worktree cannot be restored because its branch is unavailable: ${branch}`);
    entry = { ...entry, root: ensureProposalWorktree(checkout, connection.repository, { branch, head }) };
  }
  let head = tryGit(entry.root, ["rev-parse", "HEAD"]);
  if (!head) throw new Error(`Proposal workspace is not a Git worktree: ${entry.root}`);
  if (remote?.head && remote.head !== head) {
    const remoteIsAhead = gitIsAncestor(entry.root, head, remote.head);
    const localIsAhead = gitIsAncestor(entry.root, remote.head, head);
    if (remoteIsAhead) {
      if (tryGit(entry.root, ["status", "--porcelain=v1"])) {
        throw new Error(`Proposal advanced remotely while its local worktree has unpublished changes: ${branch}`);
      }
      runGit(entry.root, ["merge", "--ff-only", remote.head], { stdio: ["ignore", "ignore", "pipe"] });
      head = remote.head;
    } else if (!localIsAhead) {
      throw new Error(`Local proposal branch diverges from origin/${branch}; resolve it before editing`);
    }
  }
  if (expectedHeadProvided && head !== observedRemoteHead) {
    throw staleSharedProposalError(branch, observedRemoteHead, head);
  }
  registry.proposals ||= {};
  registry.proposals[branch] = {
    ...entry,
    ...(remote?.head ? { lastPublishedHead: remote.head } : {}),
    updatedAt: new Date().toISOString(),
  };
  writeProposalRegistry(connection.repository, registry);
  return {
    ...registry.proposals[branch],
    head,
    remoteHead: remote?.head || "",
    dirty: Boolean(tryGit(entry.root, ["status", "--porcelain=v1"])),
    conflict: Boolean(tryGit(entry.root, ["diff", "--name-only", "--diff-filter=U"])),
    reviewStatus: remote?.reviewStatus || "editing",
    reused: true,
  };
}

export function openSharedProposalWorkspace(root, options = {}) {
  const synced = syncSharedContext(root, {
    allowOffline: false,
    timeoutMs: options.timeoutMs,
    push: options.push || null,
  });
  return withProposalRegistryLock(synced.connection.repository, () => (
    openSharedProposalWorkspaceFromStateLocked(synced, options)
  ));
}

export function openSharedRepositoryProposalWorkspace(repository, options = {}) {
  const safeRemote = registeredRepositoryTransport(repository);
  return withProposalRegistryLock(safeRemote, () => {
    const synced = options.refresh === false
      ? cachedSharedRepositoryState(safeRemote)
      : syncSharedRepositoryState(safeRemote, {
        allowOffline: false,
        timeoutMs: options.timeoutMs,
        push: options.push || null,
      });
    return openSharedProposalWorkspaceFromStateLocked(synced, options);
  });
}

function changedFiles(cwd, base) {
  const committed = gitChangedPaths(cwd, `${base}...HEAD`);
  const staged = splitNull(runGit(cwd, ["diff", "--cached", "--name-only", "-z", "HEAD", "--"], { encoding: null }));
  const working = splitNull(runGit(cwd, ["diff", "--name-only", "-z", "HEAD", "--"], { encoding: null }));
  const untracked = splitNull(runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z", "--"], { encoding: null }));
  return [...new Set([...committed, ...staged, ...working, ...untracked])];
}

function assertSharedTreeNoFollow(root, relativePath) {
  const inspected = inspectSharedPathNoFollow(root, relativePath);
  if (!inspected.exists) return;
  const pending = [inspected.target];
  while (pending.length) {
    const current = pending.pop();
    const stats = fs.lstatSync(current, { bigint: true });
    if (stats.isSymbolicLink()) {
      throw unsafeSharedFilesystemPath(`Shared proposal workspace contains a symbolic link: ${current}`);
    }
    if (stats.isDirectory()) {
      if (!physicalPathIsContained(inspected.physicalRoot, fs.realpathSync(current))) {
        throw unsafeSharedFilesystemPath(`Shared proposal workspace path escapes its physical root: ${current}`);
      }
      for (const entry of fs.readdirSync(current, { withFileTypes: true })) pending.push(path.join(current, entry.name));
      continue;
    }
    if (!stats.isFile()) {
      throw unsafeSharedFilesystemPath(`Shared proposal workspace contains a special file: ${current}`);
    }
    if (stats.nlink !== 1n) {
      throw unsafeSharedFilesystemPath(`Shared proposal workspace contains a hard-linked file: ${current}`);
    }
  }
}

function assertSharedProposalWorkspaceRootNoFollow(synced, entry) {
  const cacheRoot = repositoryCacheRoot(synced.connection.repository);
  const expectedRoot = path.join(cacheRoot, "proposals", hashKey(entry.branch));
  if (path.resolve(entry.root) !== expectedRoot) {
    throw unsafeSharedFilesystemPath(`Shared proposal workspace does not match its registered cache path: ${entry.root}`);
  }
  const rootSentinelPath = path.relative(cacheRoot, path.join(expectedRoot, SHARED_REPOSITORY_CONFIG)).split(path.sep).join("/");
  const rootSentinel = inspectSharedPathNoFollow(cacheRoot, rootSentinelPath);
  if (!rootSentinel.exists) {
    throw unsafeSharedFilesystemPath(`Shared proposal workspace is missing its repository configuration: ${entry.root}`);
  }
  const marker = { target: path.join(expectedRoot, ".git") };
  const markerStats = lstatIfPresent(marker.target);
  if (!markerStats?.isFile() || markerStats.isSymbolicLink()) {
    throw unsafeSharedFilesystemPath(`Shared proposal Git marker must be a real file: ${marker.target}`);
  }
  const match = fs.readFileSync(marker.target, "utf8").trim().match(/^gitdir:\s*(.+)$/);
  if (!match) throw unsafeSharedFilesystemPath(`Shared proposal Git marker is invalid: ${marker.target}`);
  const repositoryGitRoot = path.join(repositoryCheckout(synced.connection.repository), ".git");
  const gitRootStats = lstatIfPresent(repositoryGitRoot);
  if (!gitRootStats?.isDirectory() || gitRootStats.isSymbolicLink()) {
    throw unsafeSharedFilesystemPath(`Shared repository Git directory must be a real directory: ${repositoryGitRoot}`);
  }
  const worktreeGitRoot = path.resolve(entry.root, match[1]);
  const physicalRepositoryGitRoot = fs.realpathSync(repositoryGitRoot);
  const physicalWorktreeGitRoot = fs.realpathSync(worktreeGitRoot);
  const relativeGitRoot = path.relative(physicalRepositoryGitRoot, physicalWorktreeGitRoot);
  if (!physicalPathIsContained(physicalRepositoryGitRoot, physicalWorktreeGitRoot)
    || !relativeGitRoot
    || relativeGitRoot === ".."
    || relativeGitRoot.startsWith(`..${path.sep}`)) {
    throw unsafeSharedFilesystemPath(`Shared proposal Git marker escapes the repository cache: ${marker.target}`);
  }
  const gitHeadPath = `${relativeGitRoot.split(path.sep).join("/")}/HEAD`;
  const gitHead = inspectSharedPathNoFollow(physicalRepositoryGitRoot, gitHeadPath);
  if (!gitHead.exists || !fs.lstatSync(gitHead.target).isFile()) {
    throw unsafeSharedFilesystemPath(`Shared proposal Git worktree metadata is invalid: ${worktreeGitRoot}`);
  }
}

function assertSharedProposalPolicyNoFollow(synced, entry, identity, extraPaths = []) {
  assertSharedProposalWorkspaceRootNoFollow(synced, entry);
  const candidates = [
    ".context-room",
    ...(identity.allowedExact || []),
    ...(identity.allowedPrefixes || []).map((prefix) => prefix.replace(/\/$/, "")),
    ...extraPaths,
  ].map((candidate) => safeRelativePath(candidate, "shared proposal policy path"));
  const roots = [...new Set(candidates)]
    .sort((left, right) => left.length - right.length || left.localeCompare(right, "en"))
    .filter((candidate, index, values) => !values.slice(0, index).some((parent) => candidate.startsWith(parent + "/")));
  for (const candidate of roots) assertSharedTreeNoFollow(entry.root, candidate);
}

function publishSharedProposalFromStateLocked(synced, options = {}) {
  const {
    proposal,
    message = "",
    title,
    description,
    author = null,
    expectedHead,
    timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  } = options;
  const expectedHeadProvided = Object.prototype.hasOwnProperty.call(options, "expectedHead");
  const { connection, entry, registry } = proposalEntryForConnection(synced.connection, proposal);
  authenticatedSharedGit(connection.repository, options.push, timeoutMs);
  const commitEnv = author?.name && author?.email ? {
    GIT_AUTHOR_NAME: String(author.name),
    GIT_AUTHOR_EMAIL: String(author.email),
    GIT_COMMITTER_NAME: String(author.name),
    GIT_COMMITTER_EMAIL: String(author.email),
  } : {};
  assertSharedProposalWorkspaceRootNoFollow(synced, entry);
  assertSharedTreeNoFollow(entry.root, ".context-room");
  const config = readSharedRepositoryConfig(entry.root);
  for (const manifestPath of [config.projectsFile, config.skillLocationsFile, config.instructionLocationsFile]) {
    assertSharedTreeNoFollow(entry.root, manifestPath);
  }
  const identity = proposalIdentity(config, entry.branch, { root: entry.root, catalog: synced.catalog });
  const expectedScopeId = ["global", "skills", "instructions"].includes(entry.scope) ? entry.scope : entry.projectId;
  if (identity.projectId !== expectedScopeId) throw new Error(`Proposal branch scope must be ${config.proposalPrefix}${expectedScopeId}/`);
  const previousRemoteHead = tryGit(entry.root, ["rev-parse", "--verify", `refs/remotes/origin/${entry.branch}`]);
  const observedRemoteHead = expectedHeadProvided
    ? expectedHead
      ? safeRevision(expectedHead, "expected proposal head")
      : ""
    : entry.lastPublishedHead
      ? safeRevision(entry.lastPublishedHead, "last published proposal head")
      : "";
  if (observedRemoteHead !== previousRemoteHead && (observedRemoteHead || previousRemoteHead)) {
    throw staleSharedProposalError(entry.branch, observedRemoteHead, previousRemoteHead);
  }
  const initialProposalState = remoteProposalState(entry.root, entry.branch, previousRemoteHead);
  if (initialProposalState.status === "invalid") {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The remote proposal state ref is not bound to the current proposal head or a valid terminal decision",
      entry.branch,
      previousRemoteHead || observedRemoteHead,
      { stateRef: initialProposalState.ref, stateHead: initialProposalState.head },
    );
  }
  if (new Set(["accepted", "rejected"]).has(initialProposalState.status)) {
    throw sharedContextError(
      "shared-proposal-terminal",
      `A ${initialProposalState.status} proposal cannot be published again`,
      {
        proposal: entry.branch,
        proposalHead: initialProposalState.proposalHead,
        reviewStatus: initialProposalState.status,
        stateRef: initialProposalState.ref,
      },
    );
  }
  if (initialProposalState.status === "active" && initialProposalState.head !== previousRemoteHead) {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The remote proposal state ref does not match the published proposal head",
      entry.branch,
      previousRemoteHead || observedRemoteHead,
      { stateRef: initialProposalState.ref, stateHead: initialProposalState.head, remoteHead: previousRemoteHead },
    );
  }
  const checkout = repositoryCheckout(connection.repository);
  const exactMainCandidate = previousRemoteHead
    ? exactSharedMainAcceptanceCandidate(synced, checkout, entry.branch, previousRemoteHead)
    : null;
  const branchMainCandidate = sharedMainAcceptanceCandidates(synced, checkout).get(entry.branch) || null;
  const durableMainCandidate = exactMainCandidate || branchMainCandidate;
  if (durableMainCandidate) {
    throw sharedContextError(
      "shared-proposal-terminal",
      "A proposal branch identifier already recorded on shared main cannot be published again",
      {
        proposal: entry.branch,
        proposalHead: durableMainCandidate.proposalHead,
        reviewStatus: "acceptance_recovery_required",
        acceptedCommit: durableMainCandidate.commit,
      },
    );
  }
  if (previousRemoteHead) {
    const remoteProposal = listRemoteSharedProposals(synced, { requiredProposal: entry.branch }).find((item) => item.branch === entry.branch);
    let terminalStatus = gitIsAncestor(checkout, previousRemoteHead, synced.revision)
      ? "accepted"
      : ["accepted", "merged", "rejected", "unverified_rejection"].includes(remoteProposal?.reviewStatus)
        ? remoteProposal.reviewStatus
        : "";
    if (!terminalStatus && !remoteProposal) {
      const rejection = proposalRejectionEvidence(
        synced,
        checkout,
        entry.branch,
        previousRemoteHead,
        ownerProposalDecisionIndex(connection.repository),
      );
      if (rejection.verified) terminalStatus = "rejected";
    }
    if (terminalStatus) {
      throw sharedContextError(
        "shared-proposal-terminal",
        `A ${terminalStatus} proposal cannot be published again`,
        { proposal: entry.branch, proposalHead: previousRemoteHead, reviewStatus: terminalStatus },
      );
    }
  }
  if (previousRemoteHead && description === undefined) {
    throw new Error("--description is required whenever a published proposal is updated");
  }
  const nextTitle = proposalTitle(title === undefined ? entry.title : title);
  const nextDescription = proposalDescription(description === undefined ? entry.description : description, { optional: !previousRemoteHead });
  const pendingFiles = changedFiles(entry.root, entry.baseRevision);
  assertPathsInProposalScope(pendingFiles, identity);
  assertProjectCreationProposalBundle(pendingFiles, identity);
  if (!pendingFiles.length) throw new Error("Proposal has no changes");
  assertSharedProposalPolicyNoFollow(synced, entry, identity, pendingFiles);
  runGit(entry.root, ["add", "-A"]);
  let hasStagedChanges = false;
  try {
    runGit(entry.root, ["diff", "--cached", "--quiet"]);
  } catch {
    hasStagedChanges = true;
  }
  const metadataChanged = nextTitle !== entry.title || nextDescription !== (entry.description || "");
  entry.title = nextTitle;
  entry.description = nextDescription;
  if (hasStagedChanges || metadataChanged) {
    assertSharedProposalPolicyNoFollow(synced, entry, identity, pendingFiles);
    const commitArgs = ["commit"];
    if (!hasStagedChanges) commitArgs.push("--allow-empty");
    commitArgs.push("-m", proposalCommitMessage(entry, message));
    runGit(entry.root, commitArgs, { stdio: ["ignore", "ignore", "pipe"], env: commitEnv });
  }
  const unmerged = tryGit(entry.root, ["diff", "--name-only", "--diff-filter=U"]);
  if (unmerged) {
    entry.conflict = { status: "conflict", mainRevision: synced.revision, files: unmerged.split("\n").filter(Boolean), updatedAt: new Date().toISOString() };
    writeProposalRegistry(connection.repository, registry);
    throw new Error(`Proposal rebase conflict remains unresolved: ${entry.conflict.files.join(", ")}`);
  }
  const previousBaseRevision = entry.baseRevision;
  const rebased = synced.revision !== previousBaseRevision;
  if (rebased) {
    assertSharedProposalPolicyNoFollow(synced, entry, identity, pendingFiles);
    try {
      runGit(entry.root, ["rebase", "--onto", synced.revision, previousBaseRevision, entry.branch], { stdio: ["ignore", "ignore", "pipe"], env: commitEnv });
    } catch (error) {
      const files = tryGit(entry.root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
      entry.conflict = { status: "conflict", mainRevision: synced.revision, files, updatedAt: new Date().toISOString() };
      writeProposalRegistry(connection.repository, registry);
      appendContextRoomEvent("proposal.conflict", {
        projectId: connection.projectId,
        sharedRepository: connection.repository,
        resource: { proposal: entry.branch, files },
        data: { mainRevision: synced.revision },
      });
      throw new Error(`Proposal rebase conflict: ${files.join(", ") || String(error.stderr || error.message || error).trim()}`);
    }
    entry.baseRevision = synced.revision;
    entry.semanticReviewRequired = true;
    delete entry.conflict;
    runGit(entry.root, ["commit", "--allow-empty", "-m", proposalCommitMessage(entry, "Rebase proposal onto current shared main")], { stdio: ["ignore", "ignore", "pipe"], env: commitEnv });
  }
  const head = safeRevision(tryGit(entry.root, ["rev-parse", "HEAD"]), "proposal head");
  const proposalChanges = gitNameStatusChanges(entry.root, entry.baseRevision, head);
  const scopePaths = proposalChangePaths(proposalChanges);
  const files = [...new Set(proposalChanges.map((change) => change.path))];
  assertPathsInProposalScope(scopePaths, identity);
  assertReviewableChangedPaths(entry.root, entry.baseRevision, head, scopePaths);
  assertSharedProposalPolicyNoFollow(synced, entry, identity, scopePaths);
  if (previousRemoteHead && !rebased && !gitIsAncestor(entry.root, previousRemoteHead, head)) {
    throw sharedContextError(
      "shared-proposal-history-diverged",
      "Proposal history no longer descends from its exact published head",
      { proposal: entry.branch, previousRemoteHead, head },
    );
  }
  const stateRef = proposalStateRef(entry.branch);
  const expectedStateHead = initialProposalState.status === "active" ? initialProposalState.head : "";
  const pushAuth = authenticatedSharedGit(connection.repository, options.push, timeoutMs);
  const pushArgs = atomicPushArguments(pushAuth?.remote || "origin", [
    {
      source: head,
      ref: `refs/heads/${entry.branch}`,
      expected: previousRemoteHead,
      force: rebased,
    },
    {
      source: head,
      ref: stateRef,
      expected: expectedStateHead,
      force: true,
    },
  ]);
  try {
    runSharedNetworkGit(entry.root, pushArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      ...(pushAuth ? { credential: pushAuth.credential } : {}),
      operation: "Git push",
      timeoutMs,
    });
  } catch (error) {
    try {
      const refreshAuth = authenticatedSharedGit(connection.repository, options.push, timeoutMs);
      runSharedNetworkGit(entry.root, refreshAuth
        ? ["fetch", "--force", "--prune", "--no-tags", refreshAuth.remote, "+refs/heads/*:refs/remotes/origin/*"]
        : ["fetch", "--force", "--prune", "--no-tags", "origin"], {
        stdio: ["ignore", "ignore", "pipe"],
        ...(refreshAuth ? { credential: refreshAuth.credential } : {}),
        operation: "Git fetch after rejected atomic proposal update",
        timeoutMs,
      });
      const actualRemoteHead = remoteBranchRevision(entry.root, entry.branch);
      const actualState = remoteProposalState(entry.root, entry.branch, actualRemoteHead);
      if (new Set(["accepted", "rejected"]).has(actualState.status)) {
        throw terminalProposalError(
          "shared-proposal-terminal",
          `A ${actualState.status} proposal cannot be published again`,
          entry.branch,
          actualState.proposalHead,
          { reviewStatus: actualState.status, stateRef: actualState.ref },
        );
      }
      if (actualRemoteHead !== previousRemoteHead) {
        throw staleSharedProposalError(entry.branch, previousRemoteHead, actualRemoteHead);
      }
      if (actualState.status === "invalid" || (actualState.status === "active" && actualState.head !== previousRemoteHead)) {
        throw terminalProposalError(
          "shared-proposal-terminal-conflict",
          "The remote proposal state changed while publishing",
          entry.branch,
          previousRemoteHead,
          { stateRef: actualState.ref, stateHead: actualState.head },
        );
      }
    } catch (refreshError) {
      if (refreshError?.code?.startsWith?.("shared-proposal-")) throw refreshError;
    }
    throwAtomicPushError(error, "Shared proposal publication");
  }
  try {
    runGit(entry.root, ["branch", "--set-upstream-to", `origin/${entry.branch}`, entry.branch], {
      stdio: ["ignore", "ignore", "ignore"],
    });
  } catch {}
  entry.updatedAt = new Date().toISOString();
  entry.lastPublishedHead = head;
  writeProposalRegistry(connection.repository, registry);
  rememberProposalObservation(connection.repository, {
    ...identity,
    repository: connection.repository,
    repositoryName: synced.repositoryConfig.name,
    projectTitle: identity.projectTitle || synced.catalog.projects.find((project) => project.id === identity.projectId)?.title || identity.projectId,
    head,
    baseRevision: entry.baseRevision,
    updatedAt: entry.updatedAt,
    title: entry.title,
    description: entry.description,
    sessionId: entry.sessionId,
    sourceRemote: entry.sourceRemote,
    sourceBranch: entry.sourceBranch,
    sourceCommit: entry.sourceCommit,
    semanticReviewRequired: Boolean(entry.semanticReviewRequired),
    files,
    fileCount: files.length,
  });
  appendContextRoomEvent("proposal.published", {
    projectId: entry.projectId,
    sharedRepository: connection.repository,
    resource: { proposal: entry.branch, files },
    data: { head, baseRevision: entry.baseRevision, semanticReviewRequired: Boolean(entry.semanticReviewRequired) },
  });
  return { ...entry, head, files, rebased };
}

export function publishSharedProposal(root, options = {}) {
  const synced = syncSharedContext(root, {
    allowOffline: false,
    timeoutMs: options.timeoutMs,
    push: options.push || null,
  });
  return withProposalRegistryLock(synced.connection.repository, () => (
    publishSharedProposalFromStateLocked(synced, options)
  ));
}

export function publishSharedRepositoryProposal(repository, options = {}) {
  const safeRemote = registeredRepositoryTransport(repository);
  return withProposalRegistryLock(safeRemote, () => {
    const synced = syncSharedRepositoryState(safeRemote, {
      allowOffline: false,
      timeoutMs: options.timeoutMs,
      push: options.push || null,
    });
    return publishSharedProposalFromStateLocked(synced, options);
  });
}

function sharedDocumentSlug(value, fallback = "document") {
  return String(value || fallback)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || fallback;
}

function sharedDocumentId(projectId, relPath) {
  const withoutExtension = relPath.replace(/\.md$/i, "");
  const segments = withoutExtension.split("/").map((segment) => sharedDocumentSlug(segment)).filter(Boolean);
  return [safeId(projectId, "projectId"), "docs", ...segments].join(".");
}

function sharedMarkdownTemplate(projectId, relPath, title) {
  return [
    "---",
    "context_room:",
    `  id: ${sharedDocumentId(projectId, relPath)}`,
    "---",
    "",
    `# ${proposalTitle(title, "New document")}`,
    "",
    "## Summary",
    "",
    "## Defines",
    "",
    "## Does not define",
    "",
  ].join("\n");
}

function sharedProjectTitle(value) {
  const title = String(value || "").trim();
  if (!title) throw new Error("shared project title is required");
  if (/\r|\n/.test(title)) throw new Error("shared project title must stay on one line");
  if (title.length > 160) throw new Error("shared project title must be 160 characters or fewer");
  return title;
}

function sharedProjectInitialDocumentPath(value = "README.md") {
  let documentPath = safeRelativePath(value || "README.md", "shared project document path");
  const extension = path.posix.extname(documentPath);
  if (!extension) documentPath += ".md";
  else if (extension.toLowerCase() !== ".md") throw new Error("shared project documents must use the .md extension");
  if (documentPath.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error("shared project document path must not use hidden files or folders");
  }
  return documentPath;
}

export function validateSharedProjectProposalInput({
  projectId,
  title,
  path: requestedPath = "README.md",
  description,
  sessionId = "",
} = {}) {
  const requestedProjectId = String(projectId || "").trim();
  const normalizedProjectId = safeId(projectId, "shared project id");
  if (requestedProjectId !== normalizedProjectId) {
    throw new Error("shared project id must already use lowercase letters, numbers, and single hyphens");
  }
  return {
    projectId: normalizedProjectId,
    title: sharedProjectTitle(title),
    path: sharedProjectInitialDocumentPath(requestedPath),
    description: proposalDescription(description, { optional: false }),
    sessionId: safeSessionId(sessionId),
  };
}

export function proposeSharedProject(repository, options = {}) {
  const validated = validateSharedProjectProposalInput(options);
  const {
    projectId: normalizedProjectId,
    title: safeTitle,
    path: documentPath,
    description: safeDescription,
    sessionId,
  } = validated;
  const safeRemote = registeredRepositoryTransport(repository);
  authenticatedSharedGit(safeRemote, options.push, options.timeoutMs);
  return withProposalRegistryLock(safeRemote, () => {
    const syncedRepository = syncSharedRepositoryState(safeRemote, {
      allowOffline: false,
      timeoutMs: options.timeoutMs,
      push: options.push || null,
    });
    if (syncedRepository.catalog.projects.some((project) => project.id === normalizedProjectId)) {
      throw new Error(`Shared project already exists: ${normalizedProjectId}`);
    }
    const projectPath = safeRelativePath(
      `${syncedRepository.repositoryConfig.projectsPath}/${normalizedProjectId}`,
      "shared project repository path",
    );
    if (inspectSharedPathNoFollow(syncedRepository.snapshot, projectPath).exists) {
      throw new Error(`Unregistered shared project path already exists: ${projectPath}`);
    }
    const synced = {
      ...syncedRepository,
      connection: {
        repository: syncedRepository.connection.repository,
        projectId: normalizedProjectId,
        projectRoot: "",
      },
    };
    const proposal = createSharedProposalFromStateLocked(synced, {
      title: `Add ${safeTitle}`,
      description: safeDescription,
      scope: "project",
      sessionId,
    });
    let repositoryPath = "";
    try {
      const projectsPath = path.join(proposal.root, synced.repositoryConfig.projectsFile);
      const rawCatalog = readJson(projectsPath);
      normalizedProjectsCatalog(rawCatalog);
      const nextCatalog = {
        ...rawCatalog,
        version: 1,
        projects: [...rawCatalog.projects, { id: normalizedProjectId, title: safeTitle }],
      };
      normalizedProjectsCatalog(nextCatalog);
      replaceSharedFileNoFollow(proposal.root, synced.repositoryConfig.projectsFile, JSON.stringify(nextCatalog, null, 2) + "\n");
      repositoryPath = safeRelativePath(
        `${projectPath}/docs/${documentPath}`,
        "shared project document repository path",
      );
      createSharedFileNoFollow(
        proposal.root,
        repositoryPath,
        sharedMarkdownTemplate(normalizedProjectId, documentPath, safeTitle),
        { stagingRoot: synced.cacheRoot },
      );
    } catch (error) {
      try {
        discardUnpublishedSharedProposalLocked(synced, proposal);
      } catch (cleanupError) {
        cleanupError.cause = error;
        throw cleanupError;
      }
      throw error;
    }
    const published = publishSharedProposalFromStateLocked(synced, {
      proposal: proposal.branch,
      title: proposal.title,
      description: safeDescription,
      message: `Add shared project ${normalizedProjectId}`,
      author: { name: "Context Room", email: ["context-room", "local.invalid"].join("@") },
      push: options.push || null,
      timeoutMs: options.timeoutMs,
    });
    return {
      repository: synced.connection.repository,
      projectId: normalizedProjectId,
      projectTitle: safeTitle,
      projectPath,
      repositoryPath,
      documentPath,
      proposal: published,
    };
  });
}

export function validateSharedDocumentationProposalInput({
  projectId,
  path: requestedPath,
  title,
  description,
  sessionId = "",
} = {}) {
  const normalizedProjectId = safeId(projectId, "projectId");
  const safeTitle = proposalTitle(title, "New shared document");
  const suggestedPath = sharedDocumentSlug(safeTitle) + ".md";
  let documentPath = safeRelativePath(requestedPath || suggestedPath, "shared document path");
  const extension = path.posix.extname(documentPath);
  if (!extension) documentPath += ".md";
  else if (extension.toLowerCase() !== ".md") throw new Error("shared documents must use the .md extension");
  if (documentPath.split("/").some((segment) => segment.startsWith("."))) {
    throw new Error("shared document path must not use hidden files or folders");
  }
  return {
    projectId: normalizedProjectId,
    path: documentPath,
    title: safeTitle,
    description: proposalDescription(description, { optional: false }),
    sessionId: safeSessionId(sessionId),
  };
}

export function proposeSharedDocumentationFile(repository, options = {}) {
  const validated = validateSharedDocumentationProposalInput(options);
  const safeRemote = registeredRepositoryTransport(repository);
  authenticatedSharedGit(safeRemote, options.push, options.timeoutMs);
  return withProposalRegistryLock(safeRemote, () => {
    const synced = sharedProjectRepositoryState(safeRemote, validated.projectId, options);
    const repositoryPath = safeRelativePath(
      `${synced.repositoryConfig.projectsPath}/${synced.connection.projectId}/docs/${validated.path}`,
      "shared document repository path",
    );
    const acceptedTarget = inspectSharedPathNoFollow(synced.snapshot, repositoryPath);
    if (acceptedTarget.exists) throw new Error(`Shared document already exists: ${repositoryPath}`);
    const proposal = createSharedProposalFromStateLocked(synced, {
      title: `Create ${validated.title}`,
      description: validated.description,
      scope: "project",
      sessionId: validated.sessionId,
    });
    try {
      createSharedFileNoFollow(
        proposal.root,
        repositoryPath,
        sharedMarkdownTemplate(synced.connection.projectId, validated.path, validated.title),
        { stagingRoot: synced.cacheRoot },
      );
    } catch (error) {
      try {
        discardUnpublishedSharedProposalLocked(synced, proposal);
      } catch (cleanupError) {
        cleanupError.cause = error;
        throw cleanupError;
      }
      throw error;
    }
    const published = publishSharedProposalFromStateLocked(synced, {
      proposal: proposal.branch,
      title: proposal.title,
      description: validated.description,
      message: `Create shared document ${validated.path}`,
      author: { name: "Context Room", email: ["context-room", "local.invalid"].join("@") },
      push: options.push || null,
      timeoutMs: options.timeoutMs,
    });
    return {
      repository: synced.connection.repository,
      projectId: synced.connection.projectId,
      repositoryPath,
      documentPath: validated.path,
      proposal: published,
    };
  });
}

export function listSharedProposals(root, { allProjects = true, refresh = true } = {}) {
  const connection = readSharedProjectConnection(root);
  if (!connection) throw new Error("This project has no approved shared-context binding; run context-room shared setup first");
  const synced = refresh
    ? syncSharedContext(root, { allowOffline: true })
    : cachedSharedRepositoryState(connection.repository, {
        projectId: connection.projectId,
        projectRoot: connection.projectRoot || path.resolve(root),
      });
  return listRemoteSharedProposals(synced, { allProjects });
}

function sharedSessionProposalOverlay(synced, projectId, sessionId) {
  const normalizedSession = safeSessionId(sessionId);
  const normalizedProject = safeId(projectId, "projectId");
  const proposals = normalizedSession ? listRemoteSharedProposals(synced).filter((proposal) => (
    proposal.sessionId === normalizedSession
    && (["global", "skills", "instructions"].includes(proposal.scope) || (normalizedProject !== "global" && proposal.projectId === normalizedProject))
    && proposal.reviewStatus !== "merged"
  )).map((proposal) => ({
    branch: proposal.branch,
    head: proposal.head,
    baseRevision: proposal.baseRevision || synced.revision,
    projectId: proposal.projectId,
    scope: proposal.scope,
    title: proposal.title,
    description: proposal.description,
    files: proposal.files,
    reviewStatus: proposal.reviewStatus,
    hasConflict: proposal.hasConflict,
  })) : [];
  return {
    version: 1,
    sessionId: normalizedSession,
    repository: synced.connection.repository,
    projectId: normalizedProject,
    acceptedRevision: synced.revision,
    proposals,
  };
}

export function resolveSharedSessionProposals(root, { sessionId = process.env.CODEX_THREAD_ID || "" } = {}) {
  const normalizedSession = safeSessionId(sessionId);
  const connection = readSharedProjectConnection(root);
  if (!normalizedSession || !connection) return { version: 1, sessionId: normalizedSession, repository: "", projectId: "", proposals: [] };
  const synced = syncSharedContext(root, { allowOffline: true });
  return sharedSessionProposalOverlay(synced, synced.connection.projectId, normalizedSession);
}

export function resolveSharedDocumentationTarget(repository, {
  projectId,
  sessionId = process.env.CODEX_THREAD_ID || "",
  allowOffline = true,
  acceptedRevision = process.env.CONTEXT_ROOM_DOC_ACCEPTED_REVISION || "",
} = {}) {
  const frozenRevision = acceptedRevision ? safeRevision(acceptedRevision, "accepted shared revision") : "";
  let synced;
  if (frozenRevision) {
    const safeRemote = registeredRepositoryTransport(repository);
    synced = withSharedRepositoryCloneLock(safeRemote, () => {
      const checkout = ensureRepositoryCloneUnderLock(safeRemote);
      if (!gitObjectExists(checkout, `${frozenRevision}^{commit}`)) {
        throw new Error(`Accepted shared revision is unavailable locally: ${frozenRevision}`);
      }
      assertSafeTreeEntries(checkout, frozenRevision, []);
      const cacheRoot = repositoryCacheRoot(safeRemote);
      const snapshot = path.join(cacheRoot, "snapshots", frozenRevision);
      fs.mkdirSync(path.dirname(snapshot), { recursive: true });
      materializeSnapshot(checkout, frozenRevision, snapshot);
      const repositoryConfig = readSharedRepositoryConfig(snapshot);
      const catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, repositoryConfig.projectsFile)));
      const state = readJson(sharedStatePath(safeRemote), {});
      return {
        connection: { repository: safeRemote, projectId: "global", projectRoot: "" },
        repositoryConfig,
        catalog,
        revision: frozenRevision,
        online: Boolean(state.online),
        fetchError: String(state.fetchError || ""),
        cacheRoot,
        snapshot,
      };
    });
  } else synced = syncSharedRepositoryState(repository, { allowOffline });
  const normalizedProject = safeId(projectId, "projectId");
  const project = normalizedProject === "global"
    ? { id: "global", title: "Global skills" }
    : synced.catalog.projects.find((item) => item.id === normalizedProject);
  if (!project) throw new Error(`Shared project is not registered in ${synced.repositoryConfig.projectsFile}: ${normalizedProject}`);
  const projectRoot = normalizedProject === "global"
    ? ""
    : path.join(synced.snapshot, synced.repositoryConfig.projectsPath, normalizedProject);
  if (projectRoot && (!fs.existsSync(projectRoot) || !fs.statSync(projectRoot).isDirectory())) {
    throw new Error(`Shared project does not exist in origin/${synced.repositoryConfig.defaultBranch}: ${normalizedProject}`);
  }
  const roots = [];
  const addRoot = (repositoryPath) => {
    const absolutePath = path.join(synced.snapshot, ...repositoryPath.split("/"));
    if (fs.existsSync(absolutePath) && fs.statSync(absolutePath).isDirectory()) roots.push({ repositoryPath, absolutePath });
  };
  if (normalizedProject !== "global") {
    addRoot(`${synced.repositoryConfig.projectsPath}/${normalizedProject}/docs`);
    addRoot(`${synced.repositoryConfig.projectsPath}/${normalizedProject}/skills`);
  }
  addRoot(synced.repositoryConfig.globalSkillsPath);
  const { skillLocations, instructionLocations } = readValidatedSharedLocationsFromRoot(
    synced.snapshot,
    synced.repositoryConfig,
    synced.catalog,
  );
  const applicableSkillCollections = new Set(skillLocations.assignments
    .filter((assignment) => assignmentAppliesToProject(assignment, normalizedProject))
    .map((assignment) => assignment.collectionId));
  for (const collection of skillLocations.collections) {
    if (applicableSkillCollections.has(collection.id)) addRoot(collection.path);
  }
  const applicableInstructionCollections = new Set(instructionLocations.assignments
    .filter((assignment) => instructionAssignmentApplies(assignment, normalizedProject))
    .map((assignment) => assignment.collectionId));
  for (const collection of instructionLocations.collections) {
    if (applicableInstructionCollections.has(collection.id)) addRoot(collection.path);
  }
  return {
    mode: "shared-only",
    repository: synced.connection.repository,
    repositoryName: synced.repositoryConfig.name,
    projectId: normalizedProject,
    projectTitle: project.title,
    revision: synced.revision,
    defaultBranch: synced.repositoryConfig.defaultBranch,
    online: synced.online,
    fetchError: synced.fetchError,
    root: synced.snapshot,
    roots,
    proposalOverlay: sharedSessionProposalOverlay(synced, normalizedProject, sessionId),
  };
}

export function readSharedDocumentationProposalDocuments(target = {}, overlay = {}) {
  const sessionId = safeSessionId(overlay.sessionId || "");
  if (!sessionId || !Array.isArray(overlay.proposals) || !overlay.proposals.length) return [];
  const repository = safeRepository(target.repository);
  const projectId = safeId(target.projectId, "projectId");
  const acceptedRevision = safeRevision(target.revision || overlay.acceptedRevision, "accepted shared revision");
  if (safeRepository(overlay.repository) !== repository) throw new Error("Session proposal overlay repository does not match this project");
  if (safeId(overlay.projectId, "projectId") !== projectId) throw new Error("Session proposal overlay project does not match this project");
  if (safeRevision(overlay.acceptedRevision, "session proposal accepted revision") !== acceptedRevision) {
    throw new Error("Session proposal overlay accepted revision does not match this documentation target");
  }
  const safeRemote = registeredRepositoryTransport(repository);
  const accepted = withSharedRepositoryCloneLock(safeRemote, () => {
    const checkout = ensureRepositoryCloneUnderLock(safeRemote);
    if (!gitObjectExists(checkout, `${acceptedRevision}^{commit}`)) {
      throw new Error(`Accepted shared revision is unavailable locally: ${acceptedRevision}`);
    }
    const descriptor = readSharedDescriptorAtRevision(checkout, acceptedRevision);
    const remoteRef = `refs/remotes/origin/${descriptor.config.defaultBranch}`;
    if (!gitObjectExists(checkout, `${remoteRef}^{commit}`) || !gitIsAncestor(checkout, acceptedRevision, remoteRef)) {
      throw sharedContextError("shared-revision-not-accepted", "Session proposal base is not reachable from the configured shared main branch", {
        repository: safeRemote,
        revision: acceptedRevision,
        defaultBranch: descriptor.config.defaultBranch,
      });
    }
    const cacheRoot = repositoryCacheRoot(safeRemote);
    const snapshot = path.join(cacheRoot, "snapshots", acceptedRevision);
    fs.mkdirSync(path.dirname(snapshot), { recursive: true });
    materializeSnapshot(checkout, acceptedRevision, snapshot);
    const config = readSharedRepositoryConfig(snapshot);
    const catalog = normalizedProjectsCatalog(readJson(path.join(snapshot, config.projectsFile)));
    return { checkout, config, catalog };
  });
  const { checkout, config, catalog } = accepted;
  const documents = [];
  for (const rawProposal of overlay.proposals) {
    const head = safeRevision(rawProposal.head, "session proposal head");
    const identity = proposalIdentity(config, rawProposal.branch, { checkout, revision: head, catalog });
    if (!new Set(["global", "skills", "instructions"]).has(identity.scope) && (projectId === "global" || identity.projectId !== projectId)) {
      throw new Error(`Session proposal is outside this project: ${rawProposal.branch}`);
    }
    const baseRevision = safeRevision(rawProposal.baseRevision, "session proposal base");
    if (!gitObjectExists(checkout, `${head}^{commit}`)) throw new Error(`Session proposal commit is unavailable locally: ${head}`);
    const files = Array.isArray(rawProposal.files) && rawProposal.files.length
      ? rawProposal.files.map((file) => safeRelativePath(file, "session proposal file"))
      : gitChangedPaths(checkout, `${baseRevision}...${head}`);
    assertPathsInProposalScope(files, identity);
    assertReviewableChangedPaths(checkout, baseRevision, head, files);
    for (const filePath of files) {
      if (!/[.](?:md|mdx|html?|txt)$/i.test(filePath)) continue;
      const existsAtHead = gitObjectExists(checkout, `${head}:${filePath}`);
      const content = existsAtHead
        ? String(runGit(checkout, ["show", `${head}:${filePath}`]))
        : `# Deleted in session proposal\n\n${filePath} is deleted by ${rawProposal.branch}.\n`;
      documents.push({
        path: filePath,
        content,
        deleted: !existsAtHead,
        proposal: {
          branch: rawProposal.branch,
          head,
          baseRevision,
          sessionId,
          projectId: identity.projectId,
          scope: identity.scope,
          title: proposalTitle(rawProposal.title || rawProposal.branch),
          description: proposalDescription(rawProposal.description || ""),
          reviewStatus: String(rawProposal.reviewStatus || "ready"),
          hasConflict: Boolean(rawProposal.hasConflict),
        },
      });
    }
  }
  return documents;
}

export function readSharedSessionProposalDocuments(root, overlay = {}) {
  const connection = readSharedProjectConnection(root);
  const sessionId = safeSessionId(overlay.sessionId || "");
  if (!connection || !sessionId || !Array.isArray(overlay.proposals) || !overlay.proposals.length) return [];
  return readSharedDocumentationProposalDocuments({
    repository: connection.repository,
    projectId: connection.projectId,
    revision: overlay.acceptedRevision,
  }, overlay);
}

export function listRegisteredSharedRepositories() {
  const registry = readJson(registryPath(), { bindings: [] });
  const repositories = new Map();
  for (const binding of registry.bindings || []) {
    try {
      const repository = safeRepository(binding.repository);
      const identity = sharedRepositoryIdentity(repository);
      if (!repositories.has(identity)) repositories.set(identity, repository);
    } catch {}
  }
  return [...repositories.values()];
}

export function listRegisteredSharedBindings(repository = "") {
  const registry = readJson(registryPath(), { bindings: [] });
  const selectedRepository = repository ? registeredRepositoryTransport(repository, registry) : "";
  const bindings = (registry.bindings || []).flatMap((binding) => {
    try {
      const bindingRepository = safeRepository(binding.repository);
      if (selectedRepository && !sameSharedRepository(bindingRepository, selectedRepository)) return [];
      return [{
        repository: registeredRepositoryTransport(bindingRepository, registry),
        projectId: safeId(binding.projectId, "projectId"),
        sourceRoot: binding.sourceRoot ? stableRoot(binding.sourceRoot) : "",
        sourceSubpath: String(binding.sourceSubpath || "."),
        projectRoots: [...new Set((binding.projectRoots || []).map(stableRoot))],
      }];
    } catch {
      return [];
    }
  });
  return [...new Map(bindings.map((binding) => [JSON.stringify(binding), binding])).values()];
}

export function listSharedRepositoryProposals(repository, {
  allowOffline = true,
  refresh = true,
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
  push = null,
} = {}) {
  const safeRemote = registeredRepositoryTransport(repository);
  if (refresh) authenticatedSharedGit(safeRemote, push, timeoutMs);
  return withSharedRepositoryCloneLock(safeRemote, () => {
    const synced = refresh
      ? syncSharedRepositoryStateUnderLock(safeRemote, { allowOffline, timeoutMs, push })
      : cachedSharedRepositoryStateUnderLock(safeRemote);
    return {
      repository: synced.connection.repository,
      repositoryName: synced.repositoryConfig.name,
      status: {
        online: synced.online,
        fetchError: synced.fetchError,
        revision: synced.revision,
        defaultBranch: synced.repositoryConfig.defaultBranch,
        syncedAt: readJson(sharedStatePath(synced.connection.repository), {}).syncedAt || null,
      },
      projects: synced.catalog.projects,
      proposals: listRemoteSharedProposals(synced),
    };
  }, timeoutMs);
}

function rejectSharedRepositoryProposalFromStateLocked(synced, {
  proposal,
  expectedHead,
  actor = "human-ui",
  push = null,
  timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS,
} = {}) {
  const identity = proposalIdentity(synced.repositoryConfig, proposal);
  const reviewedHead = safeRevision(expectedHead, "expected proposal head");
  const checkout = repositoryCheckout(synced.connection.repository);
  const currentRemoteHead = remoteBranchRevision(checkout, identity.branch);
  const initialRemoteState = remoteProposalState(checkout, identity.branch, currentRemoteHead);
  if (initialRemoteState.status === "invalid") {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The remote proposal state ref is invalid; no terminal mutation is allowed",
      identity.branch,
      reviewedHead,
      { stateRef: initialRemoteState.ref, stateHead: initialRemoteState.head },
    );
  }
  if (
    initialRemoteState.status === "active"
    && initialRemoteState.head !== reviewedHead
  ) {
    throw staleSharedProposalError(identity.branch, reviewedHead, currentRemoteHead || initialRemoteState.head);
  }
  if (
    new Set(["accepted", "rejected"]).has(initialRemoteState.status)
    && initialRemoteState.proposalHead !== reviewedHead
  ) {
    throw staleSharedProposalError(identity.branch, reviewedHead, currentRemoteHead || initialRemoteState.proposalHead);
  }
  const initialTerminal = proposalTerminalEvidence(synced, checkout, identity.branch, reviewedHead);
  assertTerminalRejectionAllowed(initialTerminal, identity.branch, reviewedHead);
  let alreadyRejected = initialTerminal.remoteRejectedVerified || initialTerminal.rejection.archiveMatches;
  if (!alreadyRejected && currentRemoteHead !== reviewedHead) {
    throw staleSharedProposalError(identity.branch, reviewedHead, currentRemoteHead);
  }
  const current = alreadyRejected
    ? null
    : listRemoteSharedProposals(synced, { requiredProposal: identity.branch }).find((item) => item.branch === identity.branch);
  if (!alreadyRejected && !current) throw new Error(`Remote proposal not found: ${identity.branch}`);
  if (current && ["accepted", "merged"].includes(current.reviewStatus)) {
    throw terminalProposalError(
      "shared-proposal-terminal",
      "An accepted proposal revision cannot be rejected",
      identity.branch,
      reviewedHead,
      { reviewStatus: current.reviewStatus },
    );
  }

  const registry = readProposalRegistry(synced.connection.repository);
  const localEntry = registry.proposals?.[identity.branch];
  const unpublishedLocalChanges = localEntry?.root && fs.existsSync(localEntry.root)
    ? tryGit(localEntry.root, ["status", "--porcelain=v1", "--untracked-files=all"])
    : "";
  if (!alreadyRejected && unpublishedLocalChanges) {
    throw new Error("Proposal has unpublished local changes; publish or resolve them before rejecting it");
  }

  const proposalSuffix = identity.branch.slice(synced.repositoryConfig.proposalPrefix.length);
  const rejectionBranch = safeBranchName(
    `${synced.repositoryConfig.rejectionPrefix}${proposalSuffix}-${reviewedHead.slice(0, 12)}`,
    "rejection branch",
  );
  const existingArchiveHead = remoteBranchRevision(checkout, rejectionBranch);
  if (existingArchiveHead && existingArchiveHead !== reviewedHead) {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      `Rejected proposal archive does not match the exact proposal revision: ${rejectionBranch}`,
      identity.branch,
      reviewedHead,
      { rejectionBranch, archiveHead: existingArchiveHead },
    );
  }
  const deliveryTimeoutMs = sharedDeliveryTimeoutBudget(push, timeoutMs);
  authenticatedSharedGit(synced.connection.repository, push, deliveryTimeoutMs);
  let pushError = null;
  if (!initialTerminal.remoteRejectedVerified) {
    const marker = proposalTerminalMarkerCommit(checkout, {
      proposal: identity.branch,
      proposalHead: reviewedHead,
      decision: "rejected",
      archiveRef: rejectionBranch,
    });
    const updates = [];
    if (!existingArchiveHead) {
      updates.push({
        source: reviewedHead,
        ref: `refs/heads/${rejectionBranch}`,
        expected: "",
        force: false,
      });
    }
    updates.push({
      source: marker,
      ref: proposalStateRef(identity.branch),
      expected: initialRemoteState.status === "active" ? initialRemoteState.head : "",
      force: true,
    });
    try {
      const pushAuth = authenticatedSharedGit(synced.connection.repository, push, deliveryTimeoutMs);
      runSharedNetworkGit(checkout, atomicPushArguments(pushAuth?.remote || "origin", updates), {
        stdio: ["ignore", "ignore", "pipe"],
        ...(pushAuth ? { credential: pushAuth.credential } : {}),
        operation: "Git push",
        timeoutMs: deliveryTimeoutMs,
        timeoutBudgetMs: deliveryTimeoutMs,
      });
    } catch (error) {
      pushError = error;
    }
  }
  let fetchError = null;
  try {
    const fetchAuth = authenticatedSharedGit(synced.connection.repository, push, deliveryTimeoutMs);
    const fetchArgs = fetchAuth
      ? ["fetch", "--force", "--prune", "--no-tags", fetchAuth.remote, "+refs/heads/*:refs/remotes/origin/*"]
      : ["fetch", "--force", "--prune", "--no-tags", "origin"];
    runSharedNetworkGit(checkout, fetchArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      ...(fetchAuth ? { credential: fetchAuth.credential } : {}),
      operation: "Git fetch",
      timeoutMs: deliveryTimeoutMs,
      timeoutBudgetMs: deliveryTimeoutMs,
    });
  } catch (error) {
    fetchError = error;
  }
  if (fetchError) {
    if (pushError) throwAtomicPushError(pushError, "Shared proposal rejection");
    throw fetchError;
  }

  const refreshedSynced = {
    ...synced,
    revision: remoteRevision(checkout, synced.repositoryConfig.defaultBranch),
  };
  const terminalAfterArchive = proposalTerminalEvidence(refreshedSynced, checkout, identity.branch, reviewedHead);
  assertTerminalRejectionAllowed(terminalAfterArchive, identity.branch, reviewedHead);
  if (!terminalAfterArchive.remoteRejectedVerified) {
    const actualRemoteHead = remoteBranchRevision(checkout, identity.branch);
    const actualState = remoteProposalState(checkout, identity.branch, actualRemoteHead);
    if (actualState.status === "active" && actualState.head !== reviewedHead) {
      throw staleSharedProposalError(identity.branch, reviewedHead, actualRemoteHead || actualState.head);
    }
    if (pushError) throwAtomicPushError(pushError, "Shared proposal rejection");
    throw sharedContextError(
      "shared-rejection-delivery-unverified",
      "The rejected proposal archive and terminal state could not be verified at the exact proposal revision",
      {
        proposal: identity.branch,
        proposalHead: reviewedHead,
        rejectionBranch,
        stateRef: actualState.ref,
        stateHead: actualState.head,
      },
    );
  }
  if (pushError) alreadyRejected = true;

  recordOwnerProposalDecision(synced.connection.repository, {
    proposal: identity.branch,
    proposalHead: reviewedHead,
    decision: "rejected",
    archiveRef: rejectionBranch,
  }, { ...proposalDecisionAuthorityOptions(synced.connection.repository), actor });

  let localCleanupPending = Boolean(unpublishedLocalChanges);
  if (!localCleanupPending && localEntry?.root && fs.existsSync(localEntry.root)) {
    try {
      runGit(checkout, ["worktree", "remove", localEntry.root], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      localCleanupPending = fs.existsSync(localEntry.root);
    }
  }
  if (!localCleanupPending && registry.proposals?.[identity.branch]) {
    delete registry.proposals[identity.branch];
    writeProposalRegistry(synced.connection.repository, registry);
  }
  if (current) rememberProposalObservation(synced.connection.repository, current, "rejected");
  const result = {
    rejected: true,
    alreadyRejected,
    repository: synced.connection.repository,
    proposal: identity.branch,
    proposalHead: reviewedHead,
    rejectionBranch,
    localCleanupPending,
  };
  if (!alreadyRejected) {
    appendContextRoomEvent("proposal.rejected", {
      projectId: identity.projectId,
      sharedRepository: synced.connection.repository,
      resource: { proposal: identity.branch, proposalHead: reviewedHead, rejectionBranch },
    });
  }
  return result;
}

export function rejectSharedRepositoryProposal(repository, options = {}) {
  const safeRemote = registeredRepositoryTransport(repository);
  const proposal = safeBranchName(options.proposal, "proposal branch");
  const proposalHead = safeRevision(options.expectedHead, "expected proposal head");
  const push = options.push || null;
  const timeoutMs = sharedDeliveryTimeoutBudget(push, options.timeoutMs);
  authenticatedSharedGit(safeRemote, push, timeoutMs);
  return withProposalRegistryLock(safeRemote, () => withSharedTerminalDecisionLock({
    repository: safeRemote,
    proposal,
    proposalHead,
  }, () => withSharedRepositoryCloneLock(safeRemote, () => {
    const synced = syncSharedRepositoryStateUnderLock(safeRemote, {
      allowOffline: false,
      timeoutMs,
      push,
    });
    return rejectSharedRepositoryProposalFromStateLocked(synced, {
      ...options,
      proposal,
      expectedHead: proposalHead,
      push,
      timeoutMs,
    });
  }, timeoutMs)), TERMINAL_PROPOSAL_REGISTRY_LOCK_OPTIONS);
}

function gitIsAncestor(cwd, ancestor, descendant) {
  const result = spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], { cwd, encoding: "utf8" });
  return result.status === 0;
}

function commitHasExactProposalAcceptance(checkout, revision, proposal, proposalHead) {
  try {
    const trailers = commitTrailerMap(checkout, revision);
    return trailers["Context-Room-Proposal"] === proposal
      && trailers["Context-Room-Proposal-Head"] === proposalHead;
  } catch {
    return false;
  }
}

function proposalHasConflict(cwd, mainRevision, proposalHead) {
  const result = spawnSync("git", ["merge-tree", "--write-tree", mainRevision, proposalHead], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.status === 0) return false;
  if (result.status === 1) return true;
  return null;
}

function sharedReviewActivityIndex(repository, checkout, mainRevision, decisionIndex = ownerProposalDecisionIndex(repository)) {
  const authorityRoot = path.join(sharedHome(), "review-authority");
  const index = new Map();
  if (!fs.existsSync(authorityRoot)) return index;
  for (const name of fs.readdirSync(authorityRoot)) {
    if (!/^[a-f0-9-]{36}\.json$/i.test(name)) continue;
    try {
      const review = readJson(path.join(authorityRoot, name));
      if (!review || safeRepository(review.repository) !== repository) continue;
      const proposal = safeBranchName(review.proposal, "proposal branch");
      const proposalHead = safeRevision(review.proposalHead, "reviewed proposal head");
      const receipt = review.accepted?.accepted ? review.accepted : null;
      const acceptedCommit = receipt
        ? safeRevision(receipt.commit, "accepted commit")
        : "";
      const signedDecision = decisionIndex.decisions.get(`${proposal}\0${proposalHead}`) || null;
      const receiptMatches = Boolean(
        receipt
        && receipt.proposal === proposal
        && receipt.proposalHead === proposalHead
        && receipt.defaultBranch === review.defaultBranch
        && ["main", "pull-request"].includes(receipt.delivery),
      );
      let exactTreeVerified = false;
      if (acceptedCommit && receiptMatches && fs.existsSync(review.reviewRoot || "")) {
        try {
          const reviewed = reviewedAcceptanceState(review.reviewRoot, review, review, review.proposalFiles || []);
          exactTreeVerified = Boolean(
            reviewed.acceptedPatch.length
            && commitMatchesExactReviewedResult(checkout, acceptedCommit, reviewed.acceptedPatch, reviewed.policyPaths),
          );
        } catch {}
      }
      const signedDecisionMatches = Boolean(
        signedDecision
        && signedDecision.decision === "accepted"
        && signedDecision.acceptedCommit === acceptedCommit,
      );
      const accepted = acceptedCommit ? {
        accepted: true,
        acceptedAt: review.acceptedAt || null,
        commit: acceptedCommit,
        delivery: receipt.delivery === "main" ? "main" : "pull-request",
        acceptanceBranch: receipt.acceptanceBranch
          ? safeBranchName(receipt.acceptanceBranch, "acceptance branch")
          : "",
        pullRequestUrl: String(receipt.pullRequestUrl || ""),
        merged: receiptMatches
          && gitIsAncestor(checkout, acceptedCommit, mainRevision)
          && commitHasExactProposalAcceptance(checkout, acceptedCommit, proposal, proposalHead)
          && (signedDecisionMatches || exactTreeVerified),
      } : null;
      const activity = {
        proposalHead,
        openedAt: String(review.createdAt || ""),
        accepted,
      };
      if (!index.has(proposal)) index.set(proposal, []);
      index.get(proposal).push(activity);
    } catch {}
  }
  for (const activities of index.values()) {
    activities.sort((left, right) => String(right.accepted?.acceptedAt || right.openedAt).localeCompare(String(left.accepted?.acceptedAt || left.openedAt)));
  }
  return index;
}

function sharedRemoteAcceptanceIndex(synced, checkout) {
  const prefix = `refs/remotes/origin/${synced.repositoryConfig.acceptancePrefix}`;
  const output = tryGit(checkout, ["for-each-ref", "--format=%(refname:strip=3)%09%(objectname)%09%(committerdate:iso8601)", prefix]);
  const index = new Map();
  for (const line of output.split("\n").filter(Boolean)) {
    const [acceptanceBranch, commitValue, acceptedAt] = line.split("\t");
    try {
      const commit = safeRevision(commitValue, "accepted commit");
      const metadata = String(runGit(checkout, [
        "log",
        "-1",
        "--format=%(trailers:key=Context-Room-Proposal,valueonly)%x00%(trailers:key=Context-Room-Proposal-Head,valueonly)%x00%(trailers:key=Context-Room-Session,valueonly)",
        commit,
      ])).split("\0").map((value) => value.trim());
      if (!metadata[0] || !metadata[1]) continue;
      const proposal = safeBranchName(metadata[0], "proposal branch");
      const proposalHead = safeRevision(metadata[1], "proposal head");
      const item = {
        accepted: true,
        acceptedAt,
        commit,
        acceptanceBranch: safeBranchName(acceptanceBranch, "acceptance branch"),
        pullRequestUrl: githubPullRequestUrl(synced.connection.repository, synced.repositoryConfig.defaultBranch, acceptanceBranch),
        merged: gitIsAncestor(checkout, commit, synced.revision),
        proposalHead,
        sessionId: safeSessionId(metadata[2]),
      };
      const previous = index.get(proposal);
      if (!previous || String(item.acceptedAt).localeCompare(String(previous.acceptedAt)) > 0) index.set(proposal, item);
    } catch {}
  }
  return index;
}

function sharedMainAcceptanceCandidates(synced, checkout) {
  const candidates = new Map();
  const commits = tryGit(checkout, ["rev-list", "--first-parent", synced.revision]).split("\n").filter(Boolean);
  for (const revision of commits) {
    try {
      const item = sharedMainCommit(checkout, revision);
      if (!item.acceptance) continue;
      const accepted = {
        accepted: true,
        acceptedAt: item.committedAt,
        commit: item.revision,
        acceptanceBranch: "",
        pullRequestUrl: "",
        merged: false,
        proposalHead: item.acceptance.proposalHead,
        sessionId: item.acceptance.sessionId,
      };
      if (!candidates.has(item.acceptance.proposal)) candidates.set(item.acceptance.proposal, accepted);
    } catch {}
  }
  return candidates;
}

function exactSharedMainAcceptanceCandidate(synced, checkout, proposal, proposalHead) {
  const commits = tryGit(checkout, ["rev-list", "--first-parent", synced.revision]).split("\n").filter(Boolean);
  for (const revision of commits) {
    try {
      const item = sharedMainCommit(checkout, revision);
      if (
        item.acceptance?.proposal === proposal
        && item.acceptance.proposalHead === proposalHead
      ) {
        return {
          accepted: true,
          acceptedAt: item.committedAt,
          commit: item.revision,
          acceptanceBranch: "",
          pullRequestUrl: "",
          merged: false,
          proposalHead: item.acceptance.proposalHead,
          sessionId: item.acceptance.sessionId,
        };
      }
    } catch {}
  }
  return null;
}

function sharedMainAcceptanceIndex(synced, checkout, reviewActivity = null, decisionIndex = null) {
  const index = new Map();
  const decisions = decisionIndex || ownerProposalDecisionIndex(synced.connection.repository);
  const activities = reviewActivity || sharedReviewActivityIndex(
    synced.connection.repository,
    checkout,
    synced.revision,
    decisions,
  );
  for (const [proposal, candidate] of sharedMainAcceptanceCandidates(synced, checkout)) {
    const signedDecision = decisions.decisions.get(`${proposal}\0${candidate.proposalHead}`) || null;
    const signedDecisionMatches = Boolean(
      signedDecision
      && signedDecision.decision === "accepted"
      && signedDecision.acceptedCommit === candidate.commit,
    );
    const exactReviewMatches = (activities.get(proposal) || []).some((activity) => (
      activity.proposalHead === candidate.proposalHead
      && activity.accepted?.merged === true
      && activity.accepted.commit === candidate.commit
    ));
    if (signedDecisionMatches || exactReviewMatches) {
      index.set(proposal, { ...candidate, merged: true });
    }
  }
  return index;
}

export function listSharedMainAcceptances(repository, { refresh = true } = {}) {
  const main = resolveSharedMainRevision(repository, { refresh });
  const synced = {
    connection: { repository: main.repository },
    repositoryConfig: main.repositoryConfig,
    revision: main.revision,
  };
  const decisionIndex = ownerProposalDecisionIndex(main.repository);
  const reviewActivity = sharedReviewActivityIndex(main.repository, main.checkout, main.revision, decisionIndex);
  const verified = sharedMainAcceptanceIndex(synced, main.checkout, reviewActivity, decisionIndex);
  return [...sharedMainAcceptanceCandidates(synced, main.checkout).entries()].map(([proposal, accepted]) => ({
    proposal,
    ...(verified.get(proposal) || accepted),
  }));
}

function ownerProposalDecisionIndex(repository) {
  const inspected = inspectOwnerProposalDecisions(repository, proposalDecisionAuthorityOptions(repository));
  const decisions = new Map();
  if (["verified", "recovered"].includes(inspected.integrity)) {
    for (const decision of inspected.decisions) {
      decisions.set(`${decision.proposal}\0${decision.proposalHead}`, decision);
    }
  }
  return { ...inspected, decisions };
}

function expectedRejectionBranch(config, proposal, proposalHead) {
  const suffix = proposal.slice(config.proposalPrefix.length);
  return safeBranchName(`${config.rejectionPrefix}${suffix}-${proposalHead.slice(0, 12)}`, "rejection branch");
}

function proposalRejectionEvidence(synced, checkout, proposal, proposalHead, decisionIndex) {
  const expectedArchive = expectedRejectionBranch(synced.repositoryConfig, proposal, proposalHead);
  const archiveHead = remoteBranchRevision(checkout, expectedArchive);
  const decision = decisionIndex.decisions.get(`${proposal}\0${proposalHead}`) || null;
  const archiveMatches = archiveHead === proposalHead;
  const receiptMatches = decision?.decision === "rejected" && decision.archiveRef === expectedArchive;
  return {
    expectedArchive,
    archiveHead,
    decision,
    archiveMatches,
    receiptMatches,
    verified: archiveMatches && receiptMatches,
  };
}

function proposalTerminalEvidence(synced, checkout, proposal, proposalHead) {
  const decisionIndex = ownerProposalDecisionIndex(synced.connection.repository);
  const rejection = proposalRejectionEvidence(synced, checkout, proposal, proposalHead, decisionIndex);
  const decision = rejection.decision;
  const signedRejected = decision?.decision === "rejected";
  const signedAccepted = decision?.decision === "accepted";
  let signedAcceptedCommit = "";
  let signedAcceptanceVerified = false;
  if (signedAccepted) {
    try {
      signedAcceptedCommit = safeRevision(decision.acceptedCommit, "signed accepted commit");
      signedAcceptanceVerified = gitIsAncestor(checkout, signedAcceptedCommit, synced.revision)
        && commitHasExactProposalAcceptance(checkout, signedAcceptedCommit, proposal, proposalHead);
    } catch {}
  }
  const exactMainCandidate = exactSharedMainAcceptanceCandidate(synced, checkout, proposal, proposalHead);
  const currentProposalHead = remoteBranchRevision(checkout, proposal);
  const remoteState = remoteProposalState(checkout, proposal, currentProposalHead);
  const remoteStateMatchesExactProposal = remoteState.proposalHead === proposalHead;
  const remoteAccepted = remoteState.status === "accepted" && remoteStateMatchesExactProposal;
  const remoteRejected = remoteState.status === "rejected" && remoteStateMatchesExactProposal;
  const remoteAcceptedVerified = remoteAccepted
    && gitIsAncestor(checkout, remoteState.acceptedCommit, synced.revision)
    && commitHasExactProposalAcceptance(checkout, remoteState.acceptedCommit, proposal, proposalHead);
  const remoteRejectedVerified = remoteRejected
    && remoteState.archiveRef === rejection.expectedArchive
    && rejection.archiveHead === proposalHead;
  const rejectionReceiptMatches = !signedRejected || decision.archiveRef === rejection.expectedArchive;
  const contradictory = Boolean(
    remoteState.status === "invalid"
    || (remoteAccepted && !remoteAcceptedVerified)
    || (remoteRejected && !remoteRejectedVerified)
    || (rejection.archiveHead && rejection.archiveHead !== proposalHead)
    || !rejectionReceiptMatches
    || (signedAccepted && !signedAcceptanceVerified)
    || ((rejection.verified || signedRejected) && (signedAccepted || exactMainCandidate))
    || (remoteAccepted && (remoteState.acceptedCommit !== (exactMainCandidate?.commit || remoteState.acceptedCommit)))
    || (remoteAccepted && (rejection.verified || signedRejected))
    || (remoteRejected && (signedAccepted || exactMainCandidate))
    || (remoteAccepted && signedAccepted && remoteState.acceptedCommit !== signedAcceptedCommit)
  );
  return {
    decisionIndex,
    decision,
    rejection,
    remoteState,
    remoteAccepted,
    remoteAcceptedVerified,
    remoteRejected,
    remoteRejectedVerified,
    signedRejected,
    signedAccepted,
    signedAcceptedCommit,
    signedAcceptanceVerified,
    exactMainCandidate,
    contradictory,
  };
}

function terminalProposalError(code, message, proposal, proposalHead, details = {}) {
  const error = sharedContextError(code, message, { proposal, proposalHead, ...details });
  error.statusCode = 409;
  return error;
}

function assertProposalDecisionAuthorityWritable(evidence, proposal, proposalHead) {
  if (evidence.decisionIndex.writable !== false) return;
  throw terminalProposalError(
    "shared-proposal-decision-authority-unavailable",
    "Proposal decision authority is damaged or recovered; repair it before making a terminal decision",
    proposal,
    proposalHead,
    {
      integrity: evidence.decisionIndex.integrity,
      recoveredFrom: evidence.decisionIndex.recoveredFrom || "",
      authorityPath: evidence.decisionIndex.authorityPath || "",
    },
  );
}

function assertTerminalAcceptanceAllowed(evidence, proposal, proposalHead, acceptedCommit = "") {
  assertProposalDecisionAuthorityWritable(evidence, proposal, proposalHead);
  if (evidence.contradictory) {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The exact proposal has conflicting or unverifiable terminal evidence; no further terminal mutation is allowed",
      proposal,
      proposalHead,
      {
        archiveRef: evidence.rejection.expectedArchive,
        archiveHead: evidence.rejection.archiveHead,
        signedDecision: evidence.decision?.decision || "",
        signedAcceptedCommit: evidence.signedAcceptedCommit,
        mainCandidateCommit: evidence.exactMainCandidate?.commit || "",
        remoteStateRef: evidence.remoteState?.ref || "",
        remoteStateHead: evidence.remoteState?.head || "",
        remoteStateStatus: evidence.remoteState?.status || "",
      },
    );
  }
  if (evidence.remoteRejected || evidence.rejection.verified || evidence.signedRejected) {
    throw terminalProposalError(
      "shared-proposal-terminal",
      "A rejected proposal revision cannot be accepted",
      proposal,
      proposalHead,
      {
        reviewStatus: "rejected",
        rejectionBranch: evidence.rejection.expectedArchive,
        archiveVerified: evidence.remoteRejectedVerified || evidence.rejection.verified,
      },
    );
  }
  if (evidence.remoteAccepted && acceptedCommit && evidence.remoteState.acceptedCommit !== acceptedCommit) {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The remote proposal state is already bound to a different accepted commit",
      proposal,
      proposalHead,
      {
        reviewStatus: "accepted",
        acceptedCommit: evidence.remoteState.acceptedCommit,
        requestedCommit: acceptedCommit,
        remoteStateRef: evidence.remoteState.ref,
      },
    );
  }
  if (evidence.signedAccepted && acceptedCommit && evidence.signedAcceptedCommit !== acceptedCommit) {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The exact proposal is already bound to a different accepted commit",
      proposal,
      proposalHead,
      {
        reviewStatus: "accepted",
        acceptedCommit: evidence.signedAcceptedCommit,
        requestedCommit: acceptedCommit,
      },
    );
  }
  if (evidence.exactMainCandidate && acceptedCommit && evidence.exactMainCandidate.commit !== acceptedCommit) {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The exact proposal already has a different acceptance candidate on shared main",
      proposal,
      proposalHead,
      {
        reviewStatus: "accepted",
        acceptedCommit: evidence.exactMainCandidate.commit,
        requestedCommit: acceptedCommit,
      },
    );
  }
}

function assertTerminalRejectionAllowed(evidence, proposal, proposalHead) {
  assertProposalDecisionAuthorityWritable(evidence, proposal, proposalHead);
  if (evidence.contradictory) {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The exact proposal has conflicting or unverifiable terminal evidence; no further terminal mutation is allowed",
      proposal,
      proposalHead,
      {
        archiveRef: evidence.rejection.expectedArchive,
        archiveHead: evidence.rejection.archiveHead,
        signedDecision: evidence.decision?.decision || "",
        signedAcceptedCommit: evidence.signedAcceptedCommit,
        mainCandidateCommit: evidence.exactMainCandidate?.commit || "",
        remoteStateRef: evidence.remoteState?.ref || "",
        remoteStateHead: evidence.remoteState?.head || "",
        remoteStateStatus: evidence.remoteState?.status || "",
      },
    );
  }
  if (evidence.remoteAccepted || evidence.signedAccepted || evidence.exactMainCandidate) {
    throw terminalProposalError(
      "shared-proposal-terminal",
      evidence.remoteAccepted || evidence.signedAccepted
        ? "An accepted proposal revision cannot be rejected"
        : "The exact proposal has an acceptance candidate on shared main and must be recovered before any rejection",
      proposal,
      proposalHead,
      {
        reviewStatus: evidence.remoteAccepted || evidence.signedAccepted ? "accepted" : "acceptance_recovery_required",
        acceptedCommit: evidence.remoteState?.acceptedCommit || evidence.signedAcceptedCommit || evidence.exactMainCandidate?.commit || "",
      },
    );
  }
}

function proposalAuthorityViolation(item, reviewStatus, authorityMessage) {
  return {
    ...item,
    reviewStatus,
    authorityViolation: true,
    authorityMessage,
    available: reviewStatus !== "externally_deleted",
  };
}

function reconcileProposalObservations(synced, checkout, current, mainAcceptance, remoteAcceptance, decisionIndex) {
  if (!synced.online) return current;
  const repository = synced.connection.repository;
  return withProposalObservationsLock(repository, () => {
  const observations = readProposalObservations(repository);
  const visible = [];
  const currentBranches = new Set();

  for (const item of current) {
    currentBranches.add(item.branch);
    const rejection = proposalRejectionEvidence(synced, checkout, item.branch, item.head, decisionIndex);
    observations.proposals[item.branch] = observedProposalValue(item, rejection.verified ? "rejected" : "active");
    if (rejection.verified) continue;
    if (item.reviewStatus === "rejected") {
      visible.push(proposalAuthorityViolation(
        item,
        "unverified_rejection",
        "The remote terminal state says rejected, but this owner has not verified and recorded the human rejection decision. Confirm rejection to recover its authority receipt.",
      ));
      continue;
    }
    if (rejection.decision?.decision === "rejected") {
      visible.push(proposalAuthorityViolation(
        item,
        "rejection_archive_missing",
        "The owner decision receipt says rejected, but the immutable remote rejection archive is missing or does not match the reviewed revision.",
      ));
      continue;
    }
    visible.push(item);
  }

  for (const previous of Object.values(observations.proposals || {})) {
    if (!previous?.branch || currentBranches.has(previous.branch) || previous.state === "rejected") continue;
    const accepted = mainAcceptance.get(previous.branch) || remoteAcceptance.get(previous.branch);
    if (accepted?.proposalHead === previous.head) {
      observations.proposals[previous.branch] = { ...previous, state: "accepted", lastCheckedAt: new Date().toISOString() };
      continue;
    }
    const rejection = proposalRejectionEvidence(synced, checkout, previous.branch, previous.head, decisionIndex);
    if (rejection.verified) {
      observations.proposals[previous.branch] = { ...previous, state: "rejected", lastCheckedAt: new Date().toISOString() };
      continue;
    }
    observations.proposals[previous.branch] = { ...previous, state: "missing", lastCheckedAt: new Date().toISOString() };
    visible.push(proposalAuthorityViolation(
      {
        ...previous,
        reviewActivity: null,
        updatedSinceReview: false,
        mainAdvancedBy: 0,
        hasConflict: false,
      },
      "externally_deleted",
      "The proposal ref disappeared without a recorded human terminal decision. Restore the exact ref and inspect repository protections before continuing review.",
    ));
  }

  writeProposalObservations(repository, observations);
  return visible;
  });
}

function listRemoteSharedProposals(synced, { allProjects = true, requiredProposal = "" } = {}) {
  const checkout = repositoryCheckout(synced.connection.repository);
  const decisionIndex = ownerProposalDecisionIndex(synced.connection.repository);
  const reviewActivity = sharedReviewActivityIndex(synced.connection.repository, checkout, synced.revision, decisionIndex);
  const remoteAcceptance = sharedRemoteAcceptanceIndex(synced, checkout);
  const mainAcceptance = sharedMainAcceptanceIndex(synced, checkout, reviewActivity, decisionIndex);
  const prefix = `refs/remotes/origin/${synced.repositoryConfig.proposalPrefix}`;
  const output = tryGit(checkout, ["for-each-ref", "--format=%(refname:strip=3)%09%(objectname)%09%(committerdate:iso8601)%09%(authorname)%09%(authoremail)%09%(subject)", prefix]);
  const current = output.split("\n").filter(Boolean).flatMap((line) => {
    const [branch, head, updatedAt, authorName, authorEmail, subject] = line.split("\t");
    try {
      const proposalHead = safeRevision(head, "proposal head");
      const identity = proposalIdentity(synced.repositoryConfig, branch, { checkout, revision: proposalHead, catalog: synced.catalog });
      const remoteState = remoteProposalState(checkout, branch, proposalHead);
      let sessionId = "";
      let title = subject;
      let description = "";
      let baseRevision = "";
      let sourceRemote = "";
      let sourceBranch = "";
      let sourceCommit = "";
      let semanticReviewRequired = false;
      try {
        const metadata = String(runGit(checkout, [
          "log",
          "-1",
          "--format=%(trailers:key=Context-Room-Title,valueonly)%x00%(trailers:key=Context-Room-Description-Base64,valueonly)%x00%(trailers:key=Context-Room-Session,valueonly)%x00%(trailers:key=Context-Room-Base,valueonly)%x00%(trailers:key=Context-Room-Source-Remote,valueonly)%x00%(trailers:key=Context-Room-Source-Branch,valueonly)%x00%(trailers:key=Context-Room-Source-Commit,valueonly)%x00%(trailers:key=Context-Room-Semantic-Review,valueonly)",
          proposalHead,
        ])).split("\0").map((value) => value.trim());
        title = proposalTitle(metadata[0] || subject);
        description = decodeProposalDescription(metadata[1]);
        sessionId = safeSessionId(metadata[2]);
        baseRevision = metadata[3] ? safeRevision(metadata[3], "proposal base") : "";
        sourceRemote = String(metadata[4] || "");
        sourceBranch = String(metadata[5] || "");
        sourceCommit = metadata[6] ? safeRevision(metadata[6], "source commit") : "";
        semanticReviewRequired = metadata[7] === "required";
      } catch {}
      const proposalChanges = gitNameStatusChanges(checkout, synced.revision, proposalHead);
      const scopePaths = proposalChangePaths(proposalChanges);
      assertPathsInProposalScope(scopePaths, identity);
      assertProjectCreationProposalBundle(proposalChanges.map((change) => change.path), identity);
      const files = [...new Set(proposalChanges.map((change) => change.path))];
      const activities = reviewActivity.get(branch) || [];
      const currentActivity = activities.find((activity) => activity.proposalHead === proposalHead) || null;
      const latestActivity = activities[0] || null;
      const durableAccepted = mainAcceptance.get(branch) || remoteAcceptance.get(branch);
      const accepted = currentActivity?.accepted || (durableAccepted?.proposalHead === proposalHead ? durableAccepted : null);
      const reviewStatus = accepted?.merged
        ? "merged"
        : remoteProposalStateIsTerminal(remoteState)
          ? remoteState.status
          : accepted
            ? "accepted"
            : currentActivity
              ? "in_review"
              : latestActivity
                ? "updated"
                : "ready";
      let mainAdvancedBy = 0;
      if (baseRevision && baseRevision !== synced.revision && gitIsAncestor(checkout, baseRevision, synced.revision)) {
        mainAdvancedBy = Number(tryGit(checkout, ["rev-list", "--count", `${baseRevision}..${synced.revision}`])) || 0;
      }
      const item = {
        ...identity,
        repository: synced.connection.repository,
        repositoryName: synced.repositoryConfig.name,
        projectTitle: identity.projectTitle || synced.catalog.projects.find((project) => project.id === identity.projectId)?.title || (identity.projectId === "global" ? "Global skills" : identity.projectId === "skills" ? "Shared skill locations" : identity.projectId),
        head: proposalHead,
        baseRevision,
        updatedAt,
        author: { name: authorName, email: authorEmail },
        title,
        description,
        sessionId,
        sourceRemote,
        sourceBranch,
        sourceCommit,
        semanticReviewRequired,
        files,
        fileCount: files.length,
        reviewStatus,
        reviewActivity: currentActivity || latestActivity,
        updatedSinceReview: reviewStatus === "updated",
        mainAdvancedBy,
        hasConflict: mainAdvancedBy > 0 ? proposalHasConflict(checkout, synced.revision, proposalHead) : false,
      };
      if (remoteState.status === "invalid") {
        return [proposalAuthorityViolation(
          item,
          "externally_deleted",
          "The protected terminal proposal state is invalid or does not match this exact proposal revision. Repair the remote state before continuing review.",
        )];
      }
      return [item];
    } catch (error) {
      if (requiredProposal && branch === requiredProposal) throw error;
      return [];
    }
  });
  return reconcileProposalObservations(synced, checkout, current, mainAcceptance, remoteAcceptance, decisionIndex)
    .filter((item) => allProjects || item.projectId === synced.connection.projectId || item.projectId === "global" || item.projectId === "skills")
    .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
}

export function materializeSharedReview(root, options = {}) {
  const { proposal, expectedHead = "", push = null, timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS } = options;
  const initialConnection = readSharedProjectConnection(root);
  if (initialConnection) authenticatedSharedGit(initialConnection.repository, push, timeoutMs);
  return withSharedRegistryLock(() => {
    const connection = readSharedProjectConnection(root);
    if (!connection) throw new Error("This project has no approved shared-context binding; run context-room shared setup first");
    return withSharedRepositoryCloneLock(connection.repository, () => {
      const synced = syncSharedContextInternal(
        root,
        { allowOffline: false, push, timeoutMs },
        { registryLockHeld: true, repositoryLockHeld: true },
      );
      return materializeSharedReviewFromState(synced, { proposal, expectedHead });
    });
  });
}

export function materializeSharedRepositoryReview(repository, options = {}) {
  const { proposal, expectedHead = "", push = null, timeoutMs = DEFAULT_SHARED_GIT_NETWORK_TIMEOUT_MS } = options;
  const safeRemote = registeredRepositoryTransport(repository);
  authenticatedSharedGit(safeRemote, push, timeoutMs);
  return withSharedRepositoryCloneLock(safeRemote, () => {
    const synced = syncSharedRepositoryStateUnderLock(safeRemote, { allowOffline: false, push, timeoutMs });
    return materializeSharedReviewFromState(synced, { proposal, expectedHead });
  });
}

function reusableSharedReview(synced, match) {
  const authorityRoot = path.join(sharedHome(), "review-authority");
  if (!fs.existsSync(authorityRoot)) return null;
  const candidates = fs.readdirSync(authorityRoot)
    .filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name))
    .map((name) => {
      try { return readJson(path.join(authorityRoot, name)); } catch { return null; }
    })
    .filter((review) => (
      review
      && !review.accepted
      && review.repository === synced.connection.repository
      && review.proposal === match.branch
      && review.proposalHead === match.head
      && review.baseRevision === synced.revision
    ))
    .sort((left, right) => String(right.createdAt || "").localeCompare(String(left.createdAt || "")));
  for (const candidate of candidates) {
    try {
      const reviewRoot = path.resolve(candidate.reviewRoot);
      if (!fs.existsSync(reviewRoot)) continue;
      const review = readSharedReview(reviewRoot, { repositoryLockHeld: true });
      if (tryGit(reviewRoot, ["rev-parse", "HEAD"]) !== review.baseRevision) continue;
      const workspace = reviewWorkspaceChanges(reviewRoot, review.baseRevision);
      assertPathsInProposalScope(workspace.files, match);
      assertReviewWorkspaceFiles(reviewRoot, workspace.files);
      return { reviewRoot, metadata: review, repositoryConfig: synced.repositoryConfig, reused: true };
    } catch {}
  }
  return null;
}

function materializeSharedReviewFromState(synced, { proposal, expectedHead = "" } = {}) {
  const match = listRemoteSharedProposals(synced, { requiredProposal: proposal }).find((item) => item.branch === proposal);
  if (!match) throw new Error(`Remote proposal not found: ${proposal}`);
  if (match.authorityViolation || ["accepted", "merged", "rejected", "unverified_rejection"].includes(match.reviewStatus)) {
    throw sharedContextError(
      "shared-proposal-terminal",
      `A ${match.reviewStatus} proposal cannot be reviewed again`,
      { proposal: match.branch, proposalHead: match.head, reviewStatus: match.reviewStatus },
    );
  }
  if (expectedHead) {
    const observedHead = safeRevision(expectedHead, "expected proposal head");
    if (match.head !== observedHead) throw staleSharedProposalError(match.branch, observedHead, match.head);
  }
  const reusable = reusableSharedReview(synced, match);
  if (reusable) return reusable;
  const checkout = repositoryCheckout(synced.connection.repository);
  const proposalChanges = gitNameStatusChanges(checkout, synced.revision, match.head).map((change) => ({
    path: change.path,
    status: change.status,
    fromPath: change.fromPath || null,
    score: change.score || null,
    reviewKind: "proposal-change",
  }));
  const scopePaths = proposalChangePaths(proposalChanges);
  const changedFiles = [...new Set(proposalChanges.map((change) => change.path))];
  if (!changedFiles.length) throw new Error("Proposal has no changes relative to shared main");
  assertPathsInProposalScope(scopePaths, match);
  assertProjectCreationProposalBundle(changedFiles, match);
  const policyPaths = [...(match.allowedExact || []), ...match.allowedPrefixes];
  assertSafeTreeEntries(checkout, synced.revision, policyPaths);
  assertSafeTreeEntries(checkout, match.head, policyPaths);
  assertReviewableChangedPaths(checkout, synced.revision, match.head, scopePaths);
  const dependencyReviewPrefixes = match.scope === "project"
    ? [`${synced.repositoryConfig.projectsPath}/${match.projectId}`]
    : [...(match.allowedPrefixes || [])];
  const dependencyReviews = sharedDocumentDependencyReviewPaths(checkout, synced.revision, match.head, changedFiles, dependencyReviewPrefixes);
  const proposalReviewFiles = [...new Set([...changedFiles, ...dependencyReviews.map((item) => item.path)])];
  const reviewRoot = path.join(repositoryCacheRoot(synced.connection.repository), "reviews", `${hashKey(proposal)}-${Date.now()}`);
  let worktreeCreated = false;
  try {
    runGit(checkout, ["worktree", "add", "--detach", reviewRoot, synced.revision], { stdio: ["ignore", "ignore", "pipe"] });
    worktreeCreated = true;
    const patch = runGit(checkout, ["diff", "--binary", "--full-index", `${synced.revision}...${match.head}`, "--"], { encoding: null });
    const applied = spawnSync("git", ["apply", "--whitespace=nowarn", "-"], { cwd: reviewRoot, input: patch, encoding: "utf8" });
    if (applied.status !== 0) throw new Error(applied.stderr || "Unable to materialize proposal diff");
    const authorityId = randomUUID();
    const metadata = {
      version: 1,
      authorityId,
      reviewRoot: stableRoot(reviewRoot),
      repository: synced.connection.repository,
      projectId: match.projectId,
      scope: match.scope,
      createsProject: match.createsProject === true,
      projectTitle: match.projectTitle || "",
      projectPath: match.projectPath || "",
      allowedExact: match.allowedExact || [],
      allowedPrefixes: match.allowedPrefixes,
      proposalFiles: proposalReviewFiles,
      dependencyReviews,
      proposalChanges: [
        ...proposalChanges,
        ...dependencyReviews
          .filter((item) => !proposalChanges.some((change) => change.path === item.path))
          .map((item) => ({ path: item.path, status: null, fromPath: null, score: null, reviewKind: "dependency-review" })),
      ],
      proposal: match.branch,
      proposalHead: match.head,
      title: match.title,
      description: match.description,
      semanticReviewRequired: Boolean(match.semanticReviewRequired),
      sessionId: match.sessionId,
      baseRevision: synced.revision,
      defaultBranch: synced.repositoryConfig.defaultBranch,
      createdAt: new Date().toISOString(),
    };
    writeJson(path.join(sharedHome(), "review-authority", `${authorityId}.json`), metadata);
    writeJson(path.join(reviewRoot, SHARED_REVIEW_CONFIG), {
      version: 1,
      authorityId,
      proposal: match.branch,
      proposalHead: match.head,
    });
    return { reviewRoot, metadata, repositoryConfig: synced.repositoryConfig };
  } catch (error) {
    if (worktreeCreated) {
      try { runGit(checkout, ["worktree", "remove", "--force", reviewRoot], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
    }
    throw error;
  }
}

export function readSharedReview(root, { repositoryLockHeld = false } = {}) {
  const pointer = readJson(path.join(path.resolve(root), SHARED_REVIEW_CONFIG));
  if (!pointer) throw new Error(`Missing ${SHARED_REVIEW_CONFIG}`);
  const authorityId = String(pointer.authorityId || "");
  if (!/^[a-f0-9-]{36}$/i.test(authorityId)) throw new Error("Invalid shared review authority");
  const metadata = readJson(path.join(sharedHome(), "review-authority", `${authorityId}.json`));
  if (!metadata || stableRoot(metadata.reviewRoot) !== stableRoot(root)) throw new Error("Shared review authority does not match this worktree");
  safeRepository(metadata.repository);
  safeId(metadata.projectId, "projectId");
  safeBranchName(metadata.proposal, "proposal branch");
  safeBranchName(metadata.defaultBranch, "default branch");
  safeRevision(metadata.proposalHead, "proposal head");
  safeRevision(metadata.baseRevision, "review base");
  if (!Array.isArray(metadata.proposalChanges)) {
    const dependencyPaths = new Set((metadata.dependencyReviews || []).map((item) => item.path));
    let changes = [];
    try {
      const checkout = repositoryLockHeld
        ? ensureRepositoryCloneUnderLock(metadata.repository)
        : ensureRepositoryClone(metadata.repository);
      changes = gitNameStatusChanges(checkout, metadata.baseRevision, metadata.proposalHead).map((change) => ({
        path: change.path,
        status: change.status,
        fromPath: change.fromPath || null,
        score: change.score || null,
        reviewKind: "proposal-change",
      }));
    } catch {}
    const changedPaths = new Set(changes.map((change) => change.path));
    metadata.proposalChanges = [
      ...changes,
      ...(metadata.proposalFiles || [])
        .filter((filePath) => !changedPaths.has(filePath))
        .map((filePath) => ({
          path: filePath,
          status: null,
          fromPath: null,
          score: null,
          reviewKind: dependencyPaths.has(filePath) ? "dependency-review" : "proposal-change",
        })),
    ];
  }
  return metadata;
}

function isContextRoomControlPath(filePath) {
  return filePath === ".context-room" || filePath.startsWith(".context-room/");
}

function reviewWorkspaceChanges(reviewRoot, baseRevision) {
  const tracked = gitChangedPaths(reviewRoot, baseRevision);
  const untracked = splitNull(runGit(reviewRoot, ["ls-files", "--others", "--exclude-standard", "-z", "--"], { encoding: null }));
  return {
    files: [...new Set([...tracked, ...untracked])].filter((filePath) => !isContextRoomControlPath(filePath)),
    untracked: untracked.filter((filePath) => !isContextRoomControlPath(filePath)),
  };
}

function assertReviewWorkspaceFiles(reviewRoot, files) {
  const stableReviewRoot = stableRoot(reviewRoot);
  for (const filePath of files) {
    const base = path.posix.basename(filePath);
    if (!SHARED_REVIEW_TEXT_EXTENSIONS.has(path.posix.extname(base)) && !SHARED_REVIEW_TEXT_FILENAMES.has(base)) {
      throw new Error(`Shared review file type is not reviewable in Context Room: ${filePath}`);
    }
    const absolute = path.join(reviewRoot, ...filePath.split("/"));
    let stats;
    try {
      stats = fs.lstatSync(absolute);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile()) throw new Error(`Shared reviews reject symlinks and special files: ${filePath}`);
    const real = fs.realpathSync(absolute);
    if (real !== stableReviewRoot && !real.startsWith(stableReviewRoot + path.sep)) throw new Error(`Shared review path escapes its worktree: ${filePath}`);
    const content = fs.readFileSync(absolute);
    if (content.length > MAX_SHARED_TEXT_BYTES) throw new Error(`Shared review file is too large: ${filePath}`);
    if (!isUtf8(content) || content.includes(0)) throw new Error(`Shared reviews only support UTF-8 text files: ${filePath}`);
  }
}

function assertSharedAcceptedTreeValid(root) {
  const repositoryConfig = readSharedRepositoryConfig(root);
  const catalog = normalizedProjectsCatalog(readJson(path.join(root, repositoryConfig.projectsFile)));
  const { instructionLocations } = readValidatedSharedLocationsFromRoot(root, repositoryConfig, catalog);
  const collections = new Map(instructionLocations.collections.map((collection) => [collection.id, collection]));
  for (const assignment of instructionLocations.assignments) {
    const collection = collections.get(assignment.collectionId);
    for (const mapping of assignment.files) {
      const source = path.join(root, collection.path, ...mapping.source.split("/"));
      if (!fs.existsSync(source) || !fs.lstatSync(source).isFile()) {
        throw new Error(`Instruction assignment ${assignment.id} references a missing accepted file: ${collection.path}/${mapping.source}`);
      }
    }
  }
}

function assertSharedAcceptedRevisionValid(checkout, revision) {
  const repositoryConfig = normalizedRepositoryConfig(JSON.parse(String(runGit(checkout, ["show", `${revision}:${SHARED_REPOSITORY_CONFIG}`]))));
  const catalog = normalizedProjectsCatalog(JSON.parse(String(runGit(checkout, ["show", `${revision}:${repositoryConfig.projectsFile}`]))));
  const { instructionLocations } = readValidatedSharedLocationsFromRevision(checkout, revision, repositoryConfig, catalog);
  const collections = new Map(instructionLocations.collections.map((collection) => [collection.id, collection]));
  for (const assignment of instructionLocations.assignments) {
    const collection = collections.get(assignment.collectionId);
    for (const mapping of assignment.files) {
      const source = `${collection.path}/${mapping.source}`;
      if (!gitObjectExists(checkout, `${revision}:${source}`)) {
        throw new Error(`Instruction assignment ${assignment.id} references a missing accepted file: ${source}`);
      }
    }
  }
}

function addIntentToAdd(root, files) {
  for (let index = 0; index < files.length; index += 200) {
    runGit(root, ["add", "-N", "--", ...files.slice(index, index + 200)]);
  }
}

function stageExistingPolicyPaths(root, policyPaths) {
  const stageable = policyPaths.filter((filePath) => {
    const absolute = path.join(root, ...String(filePath).split("/"));
    if (fs.existsSync(absolute)) return true;
    return splitNull(runGit(root, ["ls-files", "-z", "--", filePath], { encoding: null })).length > 0;
  });
  if (stageable.length) runGit(root, ["add", "-A", "--", ...stageable]);
  return stageable;
}

function auditTrailerValue(value, label) {
  const normalized = String(value || "").trim().replace(/[\r\n\0]+/g, " ").slice(0, 240);
  if (!normalized) return "";
  if (!/^[\p{L}\p{N} ._@+:/-]+$/u.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

function trustedSharedReviewState(reviewRoot) {
  const raw = readJson(path.join(reviewRoot, ".context-room", "review-state.json"), { reviews: {} });
  const state = { version: 2, reviews: raw?.reviews && typeof raw.reviews === "object" ? raw.reviews : {} };
  const authority = inspectOwnerTrustedState(reviewRoot, "review-state", state);
  if (!authority.trusted || authority.integrity === "recovered") {
    throw new Error("Human review evidence is missing, altered, or recovered from a damaged authority record; reopen the review and re-establish the exact file decisions");
  }
  return state;
}

function reviewWorkspaceResourceMode(reviewRoot, filePath) {
  const absolute = path.join(reviewRoot, ...filePath.split("/"));
  let stats;
  try {
    stats = fs.lstatSync(absolute);
  } catch (error) {
    if (error?.code === "ENOENT") return "absent";
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Shared reviews reject symlinks and special files: ${filePath}`);
  }
  return (stats.mode & 0o111) !== 0 ? "100755" : "100644";
}

function legacyReviewedResourceMode(reviewRoot, review, filePath, contentHash) {
  const modes = new Set();
  for (const revision of [review.baseRevision, review.proposalHead]) {
    let entries;
    try {
      entries = gitTreeEntries(reviewRoot, safeRevision(revision, "reviewed resource revision"), [filePath]);
    } catch {
      continue;
    }
    const entry = entries.find((item) => item.path === filePath);
    if (!entry || entry.type !== "blob" || !["100644", "100755"].includes(entry.mode)) continue;
    const content = runGit(reviewRoot, ["cat-file", "blob", entry.object], { encoding: null, maxBuffer: MAX_SHARED_TEXT_BYTES + 1 });
    const revisionContentHash = createHash("sha256").update(content).digest("hex");
    if (revisionContentHash === contentHash) modes.add(entry.mode);
  }
  return modes.size === 1 ? [...modes][0] : "";
}

function assertExactSharedFileReviews(reviewRoot, proposalFiles, reviewState, reviewMetadata) {
  const missing = [];
  for (const filePath of proposalFiles) {
    const abs = path.join(reviewRoot, ...filePath.split("/"));
    const resourceMode = reviewWorkspaceResourceMode(reviewRoot, filePath);
    const exists = resourceMode !== "absent";
    const contentHash = createHash("sha256").update(exists ? fs.readFileSync(abs) : Buffer.alloc(0)).digest("hex");
    const review = reviewState.reviews?.[filePath];
    const resourceState = exists ? "present" : "absent";
    const stateMatches = review?.resourceState
      ? review.resourceState === resourceState
      : resourceState === "present";
    const reviewedMode = typeof review?.resourceMode === "string" && review.resourceMode
      ? review.resourceMode
      : resourceState === "absent"
        ? "absent"
        : legacyReviewedResourceMode(reviewRoot, reviewMetadata, filePath, contentHash);
    if (
      review?.status !== "verified"
      || review.contentHash !== contentHash
      || !stateMatches
      || reviewedMode !== resourceMode
      || (resourceState === "absent" && !review.resourceVersion)
    ) {
      missing.push(filePath);
    }
  }
  if (missing.length) {
    throw new Error(`Human review evidence is incomplete or stale for: ${missing.join(", ")}`);
  }
}

export function acceptedProposalCommitMessage(review, message, actor = null, providedReviewState = null) {
  let dependencyProof = "";
  try {
    const reviewState = providedReviewState || trustedSharedReviewState(review.reviewRoot);
    const documents = (review.proposalFiles || []).flatMap((filePath) => {
      const item = reviewState?.reviews?.[filePath];
      if (item?.status !== "verified" || item.resourceState !== "present" || !item.contentHash || !item.resourceMode) return [];
      const blob = tryGit(review.reviewRoot, ["hash-object", "--", filePath]);
      if (!blob) return [];
      return [{
        path: filePath,
        blob,
        mode: String(item.resourceMode || ""),
        contentHash: item.contentHash,
        dependencies: item.dependencyVersions || {},
      }];
    });
    if (documents.length) dependencyProof = Buffer.from(JSON.stringify({ version: 1, documents }), "utf8").toString("base64url");
  } catch {}
  const trailers = [
    `Context-Room-Proposal: ${safeBranchName(review.proposal, "proposal branch")}`,
    `Context-Room-Proposal-Head: ${safeRevision(review.proposalHead, "proposal head")}`,
    review.sessionId ? `Context-Room-Session: ${safeSessionId(review.sessionId)}` : "",
    `Context-Room-Project: ${safeId(review.projectId, "projectId")}`,
    actor?.sub ? `Context-Room-Reviewed-By: ${auditTrailerValue(actor.sub, "reviewer identity")}` : "",
    actor?.email ? `Context-Room-Reviewer-Email: ${auditTrailerValue(actor.email, "reviewer email")}` : "",
    dependencyProof ? `Context-Room-Dependency-Proof: ${dependencyProof}` : "",
  ].filter(Boolean);
  return `${String(message || "Accept shared context proposal").trim()}\n\n${trailers.join("\n")}`;
}

function verifySharedMainDelivery(
  checkout,
  acceptedCommit,
  defaultBranch,
  repository,
  push = null,
  timeoutMs = DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
) {
  const branch = safeBranchName(defaultBranch, "shared default branch");
  const auth = authenticatedSharedGit(repository, push, timeoutMs);
  const remote = auth?.remote || "origin";
  const options = {
    stdio: ["ignore", "ignore", "pipe"],
    ...(auth ? { credential: auth.credential } : {}),
  };
  try {
    runSharedDeliveryGit(checkout, [
      "fetch",
      "--force",
      "--prune",
      "--no-tags",
      remote,
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
    ], {
      ...options,
      operation: "Git fetch delivery verification",
      timeoutMs: sharedDeliveryTimeoutBudget(push, timeoutMs),
    });
  } catch (error) {
    if (
      error?.code === "shared-delivery-timeout"
      || String(error?.code || "").startsWith("github-app-")
    ) throw error;
    throw sharedContextError(
      "shared-delivery-unverified",
      `Unable to verify the accepted commit on origin/${branch}: ${String(error.stderr || error.message || error).trim()}`,
      { acceptedCommit, defaultBranch: branch },
    );
  }
  const verifiedRemoteHead = remoteRevision(checkout, branch);
  if (!gitIsAncestor(checkout, acceptedCommit, verifiedRemoteHead)) {
    throw sharedContextError(
      "shared-delivery-unverified",
      `The accepted commit is not reachable from origin/${branch} after push`,
      { acceptedCommit, verifiedRemoteHead, defaultBranch: branch },
    );
  }
  return verifiedRemoteHead;
}

function refreshSharedDeliveryRefs(
  checkout,
  repository,
  push = null,
  timeoutMs = DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
) {
  const auth = authenticatedSharedGit(repository, push, timeoutMs);
  const remote = auth?.remote || "origin";
  try {
    runSharedDeliveryGit(checkout, auth
      ? ["fetch", "--force", "--prune", "--no-tags", remote, "+refs/heads/*:refs/remotes/origin/*"]
      : ["fetch", "--force", "--prune", "--no-tags", "origin"], {
      stdio: ["ignore", "ignore", "pipe"],
      ...(auth ? { credential: auth.credential } : {}),
      operation: "Git fetch terminal proposal state",
      timeoutMs: sharedDeliveryTimeoutBudget(push, timeoutMs),
    });
  } catch (error) {
    if (
      error?.code === "shared-delivery-timeout"
      || String(error?.code || "").startsWith("github-app-")
    ) throw error;
    throw sharedContextError(
      "shared-delivery-unverified",
      `Unable to refresh the remote terminal proposal state: ${String(error.stderr || error.message || error).trim()}`,
      { repository },
    );
  }
}

function reviewedAcceptanceState(reviewRoot, review, policy, requiredReviewFiles = review.proposalFiles || []) {
  const workspace = reviewWorkspaceChanges(reviewRoot, review.baseRevision);
  assertPathsInProposalScope(workspace.files, policy);
  const authorityFiles = new Set(review.proposalFiles || []);
  const unauthorizedFiles = workspace.files.filter((filePath) => !authorityFiles.has(filePath));
  if (unauthorizedFiles.length) {
    throw new Error(`Shared review workspace contains files outside its review authority: ${unauthorizedFiles.join(", ")}`);
  }
  assertReviewWorkspaceFiles(reviewRoot, workspace.files);
  const reviewState = trustedSharedReviewState(reviewRoot);
  assertExactSharedFileReviews(reviewRoot, requiredReviewFiles, reviewState, review);
  addIntentToAdd(reviewRoot, workspace.untracked);
  const policyPaths = [...new Set([...(policy.allowedExact || []), ...(policy.allowedPrefixes || [])])];
  if (!policyPaths.length) throw new Error("Shared review scope has no allowed paths");
  const acceptedPatch = runGit(reviewRoot, ["diff", "--binary", "--full-index", review.baseRevision, "--", ...policyPaths], { encoding: null });
  return { workspace, reviewState, policyPaths, acceptedPatch };
}

function assertSharedReviewBaseCurrent(checkout, review, currentMain, proposalChanges = []) {
  const reviewedBase = safeRevision(review.baseRevision, "review base");
  const acceptedMain = safeRevision(currentMain, "current shared main");
  if (reviewedBase === acceptedMain) return;
  if (!gitIsAncestor(checkout, reviewedBase, acceptedMain)) {
    throw sharedContextError(
      "shared-history-diverged",
      "Accepted shared main no longer descends from the base used for this review",
      { reviewedBase, currentMain: acceptedMain },
    );
  }
  const protectedPaths = new Set([
    ...(review.proposalFiles || []),
    ...(review.dependencyReviews || []).map((item) => item.path),
    ...proposalChangePaths(proposalChanges),
  ]);
  const mainChanges = gitNameStatusChanges(checkout, reviewedBase, acceptedMain);
  const changedProtectedPaths = proposalChangePaths(mainChanges)
    .filter((filePath) => protectedPaths.has(filePath))
    .sort((left, right) => left.localeCompare(right, "en"));
  if (!changedProtectedPaths.length) return;
  const error = sharedContextError(
    "shared-review-base-stale",
    "Accepted shared main changed files covered by this exact whole-file review; materialize and review the proposal again",
    {
      proposal: review.proposal,
      proposalHead: review.proposalHead,
      reviewedBase,
      currentMain: acceptedMain,
      paths: changedProtectedPaths,
    },
  );
  error.statusCode = 409;
  error.retryable = true;
  throw error;
}

function withSharedTerminalDecisionFileLock(lock, binding, callback) {
  const repository = safeRepository(binding.repository);
  const proposal = safeBranchName(binding.proposal, "proposal branch");
  const proposalHead = safeRevision(binding.proposalHead, "proposal head");
  const ownerToken = randomUUID();
  const ownerHost = os.hostname();
  const coordinationLock = `${lock}.coordination`;
  const coordinationOptions = {
    timeoutMs: 5_000,
    staleMs: 30_000,
    busyMessage: "Terminal decision lock coordination is busy in another process",
    busyCode: "shared-terminal-decision-busy",
  };
  fs.mkdirSync(path.dirname(lock), { recursive: true, mode: 0o700 });
  let ownedDirectory = null;
  withFilesystemLock(coordinationLock, () => {
    let owner = {};
    let lockStats = null;
    try {
      lockStats = fs.lstatSync(lock, { bigint: true });
      if (lockStats.isSymbolicLink() || !lockStats.isDirectory()) {
        throw unsafeSharedFilesystemPath(`Terminal decision lock must be a physical directory: ${lock}`);
      }
      let owner = {};
      try { owner = readJson(path.join(lock, "owner.json"), {}) || {}; } catch {}
      const now = Date.now();
      const createdAt = Date.parse(owner.createdAt || 0);
      const explicitExpiry = Date.parse(owner.expiresAt || 0);
      let lockMtime = Number.NaN;
      try { lockMtime = fs.statSync(lock).mtimeMs; } catch {}
      const fallbackCreatedAt = Number.isFinite(createdAt)
        ? createdAt
        : (Number.isFinite(lockMtime) ? lockMtime : now);
      const expiresAt = Number.isFinite(explicitExpiry)
        ? explicitExpiry
        : fallbackCreatedAt + SHARED_TERMINAL_DECISION_LEASE_MS;
      const age = now - fallbackCreatedAt;
      const expired = now >= expiresAt;
      const localOwner = owner.host === ownerHost;
      const localOwnerAlive = sharedTerminalLocalOwnerAlive(owner, ownerHost, expired);
      const abandonedLocalOwner = age > 5_000 && localOwner && !localOwnerAlive;
      if ((expired && !localOwnerAlive) || abandonedLocalOwner) {
        const currentStats = fs.lstatSync(lock, { bigint: true });
        let currentOwner = {};
        try { currentOwner = readJson(path.join(lock, "owner.json"), {}) || {}; } catch {}
        if (
          currentStats.dev === lockStats.dev
          && currentStats.ino === lockStats.ino
          && String(currentOwner.token || "") === String(owner.token || "")
        ) {
          fs.rmSync(lock, { recursive: true, force: true });
          lockStats = null;
        }
      }
      if (lockStats) {
        const busy = sharedContextError(
          "shared-terminal-decision-busy",
          "Another exact terminal decision is still in progress; retry after it finishes",
          {
            proposal,
            proposalHead,
            retryAfterMs: Number.isFinite(expiresAt) ? Math.max(0, expiresAt - now) : SHARED_TERMINAL_DECISION_LEASE_MS,
          },
        );
        busy.statusCode = 409;
        busy.retryable = true;
        throw busy;
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    fs.mkdirSync(lock, { mode: 0o700 });
    const created = fs.lstatSync(lock, { bigint: true });
    writePrivateJson(path.join(lock, "owner.json"), {
      pid: process.pid,
      host: ownerHost,
      token: ownerToken,
      processIdentity: filesystemProcessIdentity(process.pid),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + SHARED_TERMINAL_DECISION_LEASE_MS).toISOString(),
      repositoryIdentity: sharedRepositoryIdentity(repository),
      proposal,
      proposalHead,
    });
    ownedDirectory = { dev: created.dev, ino: created.ino };
  }, coordinationOptions);
  try {
    return callback();
  } finally {
    try {
      withFilesystemLock(coordinationLock, () => {
        const owner = readJson(path.join(lock, "owner.json"), {});
        const current = fs.lstatSync(lock, { bigint: true });
        if (
          owner.token === ownerToken
          && ownedDirectory
          && current.dev === ownedDirectory.dev
          && current.ino === ownedDirectory.ino
        ) {
          fs.rmSync(lock, { recursive: true, force: true });
        }
      }, coordinationOptions);
    } catch {}
  }
}

function withSharedTerminalDecisionLock(binding, callback) {
  const repository = safeRepository(binding.repository);
  const proposal = safeBranchName(binding.proposal, "proposal branch");
  const proposalHead = safeRevision(binding.proposalHead, "proposal head");
  const canonicalIdentity = `${sharedRepositoryIdentity(repository)}\0${proposal}\0${proposalHead}`;
  const legacyIdentity = `${repository}\0${proposal}\0${proposalHead}`;
  const canonicalLock = path.join(sharedHome(), "locks", `accept-${hashKey(canonicalIdentity, 24)}.lock`);
  const legacyLock = path.join(sharedHome(), "locks", `accept-${hashKey(legacyIdentity, 24)}.lock`);
  const normalizedBinding = { repository, proposal, proposalHead };
  return withSharedTerminalDecisionFileLock(canonicalLock, normalizedBinding, () => (
    legacyLock === canonicalLock
      ? callback()
      : withSharedTerminalDecisionFileLock(legacyLock, normalizedBinding, callback)
  ));
}

function commitMatchesExactReviewedResult(checkout, revision, acceptedPatch, policyPaths) {
  const commit = safeRevision(revision, "shared acceptance commit");
  try {
    assertSafeTreeEntries(checkout, commit, policyPaths);
  } catch {
    return false;
  }
  const ancestry = tryGit(checkout, ["rev-list", "--parents", "-n", "1", commit]).split(/\s+/).filter(Boolean);
  if (ancestry.length !== 2 || ancestry[0] !== commit) return false;
  const parent = safeRevision(ancestry[1], "shared acceptance parent");
  const comparisonRoot = path.join(
    path.dirname(checkout),
    "accept-verification",
    `${hashKey(commit)}-${Date.now()}-${randomUUID()}`,
  );
  fs.mkdirSync(path.dirname(comparisonRoot), { recursive: true });
  let worktreeCreated = false;
  try {
    runGit(checkout, ["worktree", "add", "--detach", comparisonRoot, parent], { stdio: ["ignore", "ignore", "pipe"] });
    worktreeCreated = true;
    const applied = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn", "-"], {
      cwd: comparisonRoot,
      input: acceptedPatch,
      encoding: "utf8",
    });
    if (applied.status !== 0 || tryGit(comparisonRoot, ["diff", "--name-only", "--diff-filter=U"])) return false;
    stageExistingPolicyPaths(comparisonRoot, policyPaths);
    const staged = spawnSync("git", ["diff", "--cached", "--quiet"], {
      cwd: comparisonRoot,
      stdio: ["ignore", "ignore", "ignore"],
    });
    if (staged.status !== 1) return false;
    const expectedTree = safeRevision(tryGit(comparisonRoot, ["write-tree"]), "expected shared acceptance tree");
    const commitTree = safeRevision(tryGit(checkout, ["rev-parse", `${commit}^{tree}`]), "shared acceptance tree");
    return expectedTree === commitTree;
  } finally {
    if (worktreeCreated) {
      try { runGit(checkout, ["worktree", "remove", "--force", comparisonRoot], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
    }
  }
}

function exactProposalAcceptanceOnMain(checkout, mainRevision, proposal, proposalHead, acceptedPatch, policyPaths) {
  const revisions = tryGit(checkout, ["rev-list", "--first-parent", safeRevision(mainRevision, "shared main revision")])
    .split("\n")
    .filter(Boolean);
  for (const revision of revisions) {
    const commit = safeRevision(revision, "shared acceptance commit");
    if (!commitHasExactProposalAcceptance(checkout, commit, proposal, proposalHead)) continue;
    if (!commitMatchesExactReviewedResult(checkout, commit, acceptedPatch, policyPaths)) continue;
    const previousMain = tryGit(checkout, ["rev-parse", `${commit}^1`]);
    return {
      commit,
      previousMain: previousMain ? safeRevision(previousMain, "shared acceptance parent") : "",
    };
  }
  return null;
}

function recordAcceptedSharedReview(review, {
  commit,
  previousMain,
  verifiedRemoteHead,
  actor = null,
  checkout,
  repositoryConfig,
} = {}) {
  const acceptedCommit = safeRevision(commit, "accepted commit");
  const verifiedHead = safeRevision(verifiedRemoteHead, "verified remote head");
  const normalizedActor = actor ? {
    sub: auditTrailerValue(actor.sub, "reviewer identity"),
    email: auditTrailerValue(actor.email, "reviewer email"),
  } : null;
  const result = {
    accepted: true,
    delivery: "main",
    deliveryVerified: true,
    proposal: review.proposal,
    proposalHead: review.proposalHead,
    previousMain: previousMain ? safeRevision(previousMain, "previous main") : "",
    commit: acceptedCommit,
    verifiedRemoteHead: verifiedHead,
    defaultBranch: review.defaultBranch,
    actor: normalizedActor,
  };
  const terminalEvidence = proposalTerminalEvidence({
    connection: { repository: review.repository },
    repositoryConfig,
    revision: verifiedHead,
  }, checkout, review.proposal, review.proposalHead);
  assertTerminalAcceptanceAllowed(terminalEvidence, review.proposal, review.proposalHead, acceptedCommit);
  recordOwnerProposalDecision(review.repository, {
    proposal: review.proposal,
    proposalHead: review.proposalHead,
    decision: "accepted",
    acceptedCommit,
  }, {
    ...proposalDecisionAuthorityOptions(review.repository),
    actor: normalizedActor?.sub || normalizedActor?.email || "human-ui",
  });
  writePrivateJson(path.join(sharedHome(), "review-authority", `${review.authorityId}.json`), { ...review, accepted: result, acceptedAt: new Date().toISOString() });
  appendContextRoomEvent("proposal.completed", {
    projectId: review.projectId,
    sharedRepository: review.repository,
    resource: { proposal: review.proposal, proposalHead: review.proposalHead },
    actor: normalizedActor,
    data: {
      commit: acceptedCommit,
      previousMain: result.previousMain,
      verifiedRemoteHead: verifiedHead,
      defaultBranch: review.defaultBranch,
      deliveryVerified: true,
    },
  });
  return result;
}

function reviewedSharedRepositoryConfig(checkout, review) {
  const configText = runGit(checkout, ["show", `${review.baseRevision}:${SHARED_REPOSITORY_CONFIG}`]);
  return normalizedRepositoryConfig(JSON.parse(configText));
}

function assertSharedReviewTerminalConfigCurrent(review, reviewedConfig, currentConfig) {
  const fields = ["defaultBranch", "proposalPrefix", "rejectionPrefix"];
  const changedFields = fields.filter((field) => reviewedConfig[field] !== currentConfig[field]);
  if (!changedFields.length) return;
  const error = terminalProposalError(
    "shared-review-terminal-config-stale",
    "Shared repository terminal configuration changed after review; materialize and review the proposal again",
    review.proposal,
    review.proposalHead,
    {
      changedFields,
      reviewedConfig: Object.fromEntries(fields.map((field) => [field, reviewedConfig[field]])),
      currentConfig: Object.fromEntries(fields.map((field) => [field, currentConfig[field]])),
    },
  );
  error.retryable = true;
  throw error;
}

function validatedSharedReviewProposalState(checkout, review, repositoryConfig = reviewedSharedRepositoryConfig(checkout, review)) {
  const catalog = normalizedProjectsCatalog(JSON.parse(String(runGit(checkout, ["show", `${review.baseRevision}:${repositoryConfig.projectsFile}`]))));
  const policy = proposalIdentity(repositoryConfig, review.proposal, { checkout, revision: review.proposalHead, catalog });
  if (policy.projectId !== review.projectId || policy.scope !== review.scope) throw new Error("Shared review scope metadata is invalid");
  const proposalChanges = gitNameStatusChanges(checkout, review.baseRevision, review.proposalHead);
  const proposalPaths = proposalChangePaths(proposalChanges);
  const proposalFiles = [...new Set(proposalChanges.map((change) => change.path))];
  assertPathsInProposalScope(proposalPaths, policy);
  assertProjectCreationProposalBundle(proposalFiles, policy);
  assertReviewableChangedPaths(checkout, review.baseRevision, review.proposalHead, proposalPaths);
  if (proposalFiles.some((filePath) => !(review.proposalFiles || []).includes(filePath))) {
    throw new Error("Shared review authority does not include every proposal-changed file");
  }
  return {
    catalog,
    policy,
    proposalChanges,
    proposalFiles,
    requiredReviewFiles: [...new Set([...(review.proposalFiles || []), ...proposalFiles])],
  };
}

function assertAtomicProjectCreationReview(review, proposalState, workspace, reviewRoot, repositoryConfig) {
  if (!review.createsProject) return;
  const changed = new Set(proposalState.proposalFiles || []);
  const retained = [...changed].filter((filePath) => workspace.files.includes(filePath));
  if (retained.length > 0 && retained.length !== changed.size) {
    throw terminalProposalError(
      "shared-project-creation-review-partial",
      "A new Shared project must accept all of its catalog and initial project files together, or reject them all",
      review.proposal,
      review.proposalHead,
      {
        projectId: review.projectId,
        retainedFiles: retained.sort((left, right) => left.localeCompare(right, "en")),
        rejectedFiles: [...changed].filter((filePath) => !retained.includes(filePath)).sort((left, right) => left.localeCompare(right, "en")),
      },
    );
  }
  if (!retained.length) return;
  const acceptedPolicy = proposalIdentity(repositoryConfig, review.proposal, {
    root: reviewRoot,
    catalog: proposalState.catalog,
  });
  if (
    acceptedPolicy.createsProject !== true
    || acceptedPolicy.projectId !== review.projectId
    || acceptedPolicy.projectPath !== review.projectPath
  ) {
    throw terminalProposalError(
      "shared-project-creation-review-invalid",
      "The reviewed result no longer contains the exact single-project catalog append and initial project tree",
      review.proposal,
      review.proposalHead,
      { projectId: review.projectId },
    );
  }
}

function revalidateAcceptedSharedReview(
  review,
  checkout,
  reviewRoot,
  push = null,
  timeoutMs = DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
) {
  const receipt = review.accepted;
  const invalidReceipt = (message) => sharedContextError(
    "shared-acceptance-receipt-invalid",
    message,
    { proposal: review.proposal, proposalHead: review.proposalHead },
  );
  if (
    !receipt
    || receipt.accepted !== true
    || receipt.delivery !== "main"
    || receipt.proposal !== review.proposal
    || receipt.proposalHead !== review.proposalHead
    || receipt.defaultBranch !== review.defaultBranch
  ) {
    throw invalidReceipt("The stored shared review acceptance receipt does not match this exact proposal revision");
  }
  let acceptedCommit;
  try {
    acceptedCommit = safeRevision(receipt.commit, "accepted commit");
  } catch {
    throw invalidReceipt("The stored shared review acceptance receipt has an invalid commit");
  }
  const verifiedRemoteHead = verifySharedMainDelivery(
    checkout,
    acceptedCommit,
    review.defaultBranch,
    review.repository,
    push,
    timeoutMs,
  );
  if (!commitHasExactProposalAcceptance(checkout, acceptedCommit, review.proposal, review.proposalHead)) {
    throw invalidReceipt("The stored shared review acceptance commit does not contain the exact proposal trailers");
  }
  let reviewed;
  let proposalState;
  try {
    proposalState = validatedSharedReviewProposalState(checkout, review);
    const previousMain = safeRevision(tryGit(checkout, ["rev-parse", `${acceptedCommit}^1`]), "previous main");
    assertSharedReviewBaseCurrent(checkout, review, previousMain, proposalState.proposalChanges);
    reviewed = reviewedAcceptanceState(
      reviewRoot,
      review,
      proposalState.policy,
      proposalState.requiredReviewFiles,
    );
  } catch (error) {
    throw invalidReceipt(`The stored shared review acceptance cannot be matched to its reviewed result: ${error.message}`);
  }
  if (!reviewed.acceptedPatch.length || !commitMatchesExactReviewedResult(checkout, acceptedCommit, reviewed.acceptedPatch, reviewed.policyPaths)) {
    throw invalidReceipt("The stored shared review acceptance commit does not match the exact reviewed result");
  }
  assertSharedAcceptedRevisionValid(checkout, acceptedCommit);
  const previousMain = tryGit(checkout, ["rev-parse", `${acceptedCommit}^1`]);
  const normalizedActor = receipt.actor && typeof receipt.actor === "object" ? {
    sub: auditTrailerValue(receipt.actor.sub, "reviewer identity"),
    email: auditTrailerValue(receipt.actor.email, "reviewer email"),
  } : null;
  return {
    accepted: true,
    delivery: "main",
    deliveryVerified: true,
    proposal: review.proposal,
    proposalHead: review.proposalHead,
    previousMain: previousMain ? safeRevision(previousMain, "previous main") : "",
    commit: acceptedCommit,
    verifiedRemoteHead,
    defaultBranch: review.defaultBranch,
    actor: normalizedActor,
  };
}

function acceptSharedReviewUnderLock(resolvedReviewRoot, {
  message = "Accept shared context proposal",
  actor = null,
  push = null,
  deliveryTimeoutMs = DEFAULT_SHARED_DELIVERY_TIMEOUT_MS,
} = {}, lockedBinding = null) {
  const review = readSharedReview(resolvedReviewRoot, { repositoryLockHeld: true });
  if (
    lockedBinding
    && (
      safeRepository(review.repository) !== lockedBinding.repository
      || safeBranchName(review.proposal, "proposal branch") !== lockedBinding.proposal
      || safeRevision(review.proposalHead, "proposal head") !== lockedBinding.proposalHead
    )
  ) {
    throw terminalProposalError(
      "shared-terminal-decision-binding-changed",
      "The shared review authority changed after its exact terminal decision lock was selected",
      lockedBinding.proposal,
      lockedBinding.proposalHead,
    );
  }
  const boundedDeliveryTimeoutMs = sharedDeliveryTimeoutBudget(push, deliveryTimeoutMs);
  const cloneAuth = authenticatedSharedGit(review.repository, push, boundedDeliveryTimeoutMs);
  const checkout = ensureRepositoryCloneUnderLock(review.repository, {
    timeoutMs: boundedDeliveryTimeoutMs,
    credential: cloneAuth?.credential || null,
    remote: cloneAuth?.remote || review.repository,
  });
  const fetchAuth = authenticatedSharedGit(review.repository, push, boundedDeliveryTimeoutMs);
  runSharedDeliveryGit(checkout, fetchAuth
    ? ["fetch", "--force", "--prune", "--no-tags", fetchAuth.remote, "+refs/heads/*:refs/remotes/origin/*"]
    : ["fetch", "--prune", "origin"], {
    stdio: ["ignore", "ignore", "pipe"],
    ...(fetchAuth ? { credential: fetchAuth.credential } : {}),
    operation: "Git fetch",
    timeoutMs: boundedDeliveryTimeoutMs,
  });
  const currentMain = remoteRevision(checkout, review.defaultBranch);
  const terminalRepositoryConfig = normalizedRepositoryConfig(JSON.parse(String(runGit(
    checkout,
    ["show", `${currentMain}:${SHARED_REPOSITORY_CONFIG}`],
  ))));
  const reviewedRepositoryConfig = reviewedSharedRepositoryConfig(checkout, review);
  assertSharedReviewTerminalConfigCurrent(review, reviewedRepositoryConfig, terminalRepositoryConfig);
  const currentProposalHead = remoteBranchRevision(checkout, review.proposal);
  const initialRemoteState = remoteProposalState(checkout, review.proposal, currentProposalHead);
  if (initialRemoteState.status === "invalid") {
    throw terminalProposalError(
      "shared-proposal-terminal-conflict",
      "The remote proposal state ref is invalid; no terminal mutation is allowed",
      review.proposal,
      review.proposalHead,
      { stateRef: initialRemoteState.ref, stateHead: initialRemoteState.head },
    );
  }
  if (
    initialRemoteState.status === "active"
    && initialRemoteState.head !== review.proposalHead
  ) {
    throw new Error("Proposal changed after review; materialize and review the new exact commit");
  }
  if (
    new Set(["accepted", "rejected"]).has(initialRemoteState.status)
    && initialRemoteState.proposalHead !== review.proposalHead
  ) {
    throw new Error("Proposal changed after review; materialize and review the new exact commit");
  }
  const terminalEvidence = proposalTerminalEvidence({
    connection: { repository: review.repository },
    repositoryConfig: terminalRepositoryConfig,
    revision: currentMain,
  }, checkout, review.proposal, review.proposalHead);
  assertTerminalAcceptanceAllowed(terminalEvidence, review.proposal, review.proposalHead);
  if (review.accepted) {
    const accepted = revalidateAcceptedSharedReview(review, checkout, resolvedReviewRoot, push, boundedDeliveryTimeoutMs);
    const refreshedTerminalEvidence = proposalTerminalEvidence({
      connection: { repository: review.repository },
      repositoryConfig: terminalRepositoryConfig,
      revision: accepted.verifiedRemoteHead,
    }, checkout, review.proposal, review.proposalHead);
    assertTerminalAcceptanceAllowed(refreshedTerminalEvidence, review.proposal, review.proposalHead, accepted.commit);
    return accepted;
  }
  const reviewHead = safeRevision(tryGit(resolvedReviewRoot, ["rev-parse", "HEAD"]), "review worktree head");
  if (reviewHead !== review.baseRevision) throw new Error("Review worktree history changed; materialize the proposal again");
  const proposalState = validatedSharedReviewProposalState(checkout, review, reviewedRepositoryConfig);
  const { policy, proposalChanges, requiredReviewFiles } = proposalState;
  const reviewed = reviewedAcceptanceState(resolvedReviewRoot, review, policy, requiredReviewFiles);
  const { workspace, reviewState, policyPaths, acceptedPatch } = reviewed;
  assertAtomicProjectCreationReview(
    review,
    proposalState,
    workspace,
    resolvedReviewRoot,
    reviewedRepositoryConfig,
  );
  if (!acceptedPatch.length) return { accepted: false, reason: "No accepted changes remain", proposal: review.proposal };
  const delivered = exactProposalAcceptanceOnMain(
    checkout,
    currentMain,
    review.proposal,
    review.proposalHead,
    acceptedPatch,
    policyPaths,
  );
  if (delivered) {
    assertSharedReviewBaseCurrent(checkout, review, delivered.previousMain, proposalChanges);
    assertSharedAcceptedRevisionValid(checkout, delivered.commit);
    const verifiedRemoteHead = verifySharedMainDelivery(
      checkout,
      delivered.commit,
      review.defaultBranch,
      review.repository,
      push,
      boundedDeliveryTimeoutMs,
    );
    return recordAcceptedSharedReview(review, {
      commit: delivered.commit,
      previousMain: delivered.previousMain,
      verifiedRemoteHead,
      actor,
      checkout,
      repositoryConfig: terminalRepositoryConfig,
    });
  }
  if (currentProposalHead !== review.proposalHead) throw new Error("Proposal changed after review; materialize and review the new exact commit");
  assertSharedReviewBaseCurrent(checkout, review, currentMain, proposalChanges);
  const acceptanceRoot = path.join(repositoryCacheRoot(review.repository), "accept", `${hashKey(review.proposal)}-${Date.now()}`);
  runGit(checkout, ["worktree", "add", "--detach", acceptanceRoot, currentMain], { stdio: ["ignore", "ignore", "pipe"] });
  try {
    const applied = spawnSync("git", ["apply", "--3way", "--whitespace=nowarn", "-"], { cwd: acceptanceRoot, input: acceptedPatch, encoding: "utf8" });
    if (applied.status !== 0 || tryGit(acceptanceRoot, ["diff", "--name-only", "--diff-filter=U"])) {
      throw new Error("Accepted result conflicts with the current main branch; review the resolved result again");
    }
    if (review.createsProject) {
      const currentCatalog = normalizedProjectsCatalog(JSON.parse(String(runGit(
        checkout,
        ["show", `${currentMain}:${terminalRepositoryConfig.projectsFile}`],
      ))));
      const deliveryPolicy = proposalIdentity(terminalRepositoryConfig, review.proposal, {
        root: acceptanceRoot,
        catalog: currentCatalog,
      });
      if (
        deliveryPolicy.createsProject !== true
        || deliveryPolicy.projectId !== review.projectId
        || deliveryPolicy.projectPath !== review.projectPath
      ) {
        throw terminalProposalError(
          "shared-project-creation-delivery-invalid",
          "The acceptance worktree no longer contains the exact reviewed new-project bundle",
          review.proposal,
          review.proposalHead,
          { projectId: review.projectId },
        );
      }
    }
    assertSharedAcceptedTreeValid(acceptanceRoot);
    stageExistingPolicyPaths(acceptanceRoot, policyPaths);
    try {
      runGit(acceptanceRoot, ["diff", "--cached", "--quiet"]);
      return { accepted: false, reason: "Accepted result is already present on main", proposal: review.proposal };
    } catch {}
    runGit(acceptanceRoot, ["commit", "-m", acceptedProposalCommitMessage(review, message, actor, reviewState)], {
      stdio: ["ignore", "ignore", "pipe"],
      env: {
        GIT_AUTHOR_NAME: "Context Room",
        GIT_AUTHOR_EMAIL: ["context-room", "localhost"].join("@"),
        GIT_COMMITTER_NAME: "Context Room",
        GIT_COMMITTER_EMAIL: ["context-room", "localhost"].join("@"),
      },
    });
    const acceptedCommit = safeRevision(tryGit(acceptanceRoot, ["rev-parse", "HEAD"]), "accepted commit");
    assertSafeTreeEntries(acceptanceRoot, acceptedCommit, policyPaths);
    assertReviewableChangedPaths(acceptanceRoot, currentMain, acceptedCommit, workspace.files);
    if (
      !commitHasExactProposalAcceptance(acceptanceRoot, acceptedCommit, review.proposal, review.proposalHead)
      || !commitMatchesExactReviewedResult(acceptanceRoot, acceptedCommit, acceptedPatch, policyPaths)
    ) {
      throw sharedContextError(
        "shared-acceptance-tree-mismatch",
        "The generated acceptance commit does not match the exact reviewed result",
        { proposal: review.proposal, proposalHead: review.proposalHead, acceptedCommit },
      );
    }
    const marker = proposalTerminalMarkerCommit(acceptanceRoot, {
      proposal: review.proposal,
      proposalHead: review.proposalHead,
      decision: "accepted",
      acceptedCommit,
    });
    const pushAuth = authenticatedSharedGit(review.repository, push, boundedDeliveryTimeoutMs);
    let pushError = null;
    try {
      runSharedDeliveryGit(acceptanceRoot, atomicPushArguments(pushAuth?.remote || "origin", [
        {
          source: acceptedCommit,
          ref: `refs/heads/${review.defaultBranch}`,
          expected: currentMain,
          force: false,
        },
        {
          source: marker,
          ref: proposalStateRef(review.proposal),
          expected: initialRemoteState.status === "active" ? initialRemoteState.head : "",
          force: true,
        },
      ]), {
        stdio: ["ignore", "ignore", "pipe"],
        ...(pushAuth ? { credential: pushAuth.credential } : {}),
        operation: "Git push",
        timeoutMs: boundedDeliveryTimeoutMs,
      });
    } catch (error) {
      pushError = error;
    }
    if (pushError) {
      let recoveryError = null;
      try {
        refreshSharedDeliveryRefs(checkout, review.repository, push, boundedDeliveryTimeoutMs);
        const refreshedRemoteHead = remoteRevision(checkout, review.defaultBranch);
        const refreshedProposalHead = remoteBranchRevision(checkout, review.proposal);
        const refreshedState = remoteProposalState(checkout, review.proposal, refreshedProposalHead);
        const refreshedEvidence = proposalTerminalEvidence({
          connection: { repository: review.repository },
          repositoryConfig: terminalRepositoryConfig,
          revision: refreshedRemoteHead,
        }, checkout, review.proposal, review.proposalHead);
        assertTerminalAcceptanceAllowed(refreshedEvidence, review.proposal, review.proposalHead);
        if (refreshedState.status === "active" && refreshedState.head !== review.proposalHead) {
          throw new Error("Proposal changed after review; materialize and review the new exact commit");
        }
        const competingDelivery = exactProposalAcceptanceOnMain(
          checkout,
          refreshedRemoteHead,
          review.proposal,
          review.proposalHead,
          acceptedPatch,
          policyPaths,
        );
        if (
          competingDelivery
          && refreshedEvidence.remoteAcceptedVerified
          && refreshedEvidence.remoteState.acceptedCommit === competingDelivery.commit
        ) {
          assertSharedReviewBaseCurrent(checkout, review, competingDelivery.previousMain, proposalChanges);
          return recordAcceptedSharedReview(review, {
            commit: competingDelivery.commit,
            previousMain: competingDelivery.previousMain,
            verifiedRemoteHead: refreshedRemoteHead,
            actor,
            checkout,
            repositoryConfig: terminalRepositoryConfig,
          });
        }
      } catch (error) {
        recoveryError = error;
      }
      if (
        recoveryError?.code?.startsWith?.("shared-proposal-")
        || /Proposal changed after review/.test(String(recoveryError?.message || ""))
      ) {
        throw recoveryError;
      }
      throwAtomicPushError(pushError, "Shared proposal acceptance");
    }
    refreshSharedDeliveryRefs(checkout, review.repository, push, boundedDeliveryTimeoutMs);
    const verifiedRemoteHead = remoteRevision(checkout, review.defaultBranch);
    if (!gitIsAncestor(checkout, acceptedCommit, verifiedRemoteHead)) {
      throw sharedContextError(
        "shared-delivery-unverified",
        `The accepted commit is not reachable from origin/${review.defaultBranch} after atomic push`,
        { acceptedCommit, verifiedRemoteHead, defaultBranch: review.defaultBranch },
      );
    }
    const verifiedTerminalEvidence = proposalTerminalEvidence({
      connection: { repository: review.repository },
      repositoryConfig: terminalRepositoryConfig,
      revision: verifiedRemoteHead,
    }, checkout, review.proposal, review.proposalHead);
    assertTerminalAcceptanceAllowed(verifiedTerminalEvidence, review.proposal, review.proposalHead, acceptedCommit);
    if (!verifiedTerminalEvidence.remoteAcceptedVerified) {
      throw sharedContextError(
        "shared-delivery-unverified",
        "The remote terminal proposal state does not verify the exact accepted commit",
        { proposal: review.proposal, proposalHead: review.proposalHead, acceptedCommit },
      );
    }
    return recordAcceptedSharedReview(review, {
      commit: acceptedCommit,
      previousMain: currentMain,
      verifiedRemoteHead,
      actor,
      checkout,
      repositoryConfig: terminalRepositoryConfig,
    });
  } finally {
    try { runGit(checkout, ["worktree", "remove", "--force", acceptanceRoot], { stdio: ["ignore", "ignore", "ignore"] }); } catch {}
  }
}

export function acceptSharedReview(reviewRoot, options = {}) {
  const resolvedReviewRoot = path.resolve(reviewRoot);
  const review = readSharedReview(resolvedReviewRoot);
  const lockedBinding = {
    repository: safeRepository(review.repository),
    proposal: safeBranchName(review.proposal, "proposal branch"),
    proposalHead: safeRevision(review.proposalHead, "proposal head"),
  };
  const deliveryTimeoutMs = sharedDeliveryTimeoutBudget(options.push, options.deliveryTimeoutMs);
  authenticatedSharedGit(lockedBinding.repository, options.push || null, deliveryTimeoutMs);
  return withProposalRegistryLock(lockedBinding.repository, () => withSharedTerminalDecisionLock(
    lockedBinding,
    () => withSharedRepositoryCloneLock(
      lockedBinding.repository,
      () => acceptSharedReviewUnderLock(resolvedReviewRoot, options, lockedBinding),
      deliveryTimeoutMs,
    ),
  ), TERMINAL_PROPOSAL_REGISTRY_LOCK_OPTIONS);
}
